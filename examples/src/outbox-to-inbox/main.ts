import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Injectable, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  OutboxModule,
  OutboxEvent,
  OutboxEmitter,
  OnOutboxEvent,
  type OutboxHandlerContext,
} from "@nestarc/outbox";
import {
  InboxModule,
  InboxService,
  InboxPermanentError,
  type InboxHandler,
} from "@nestarc/inbox";
import {
  createPrisma,
  tenantId,
  waitUntil,
  type OrderPayload,
} from "../common";
import type { Prisma } from "../generated/prisma/client";

class OrderCreated extends OutboxEvent {
  static readonly eventType = "inbox-example.order.created";
  constructor(public readonly orderId: string) {
    super();
  }
}
class OrderProjected extends OutboxEvent {
  static readonly eventType = "inbox-example.order.projected";
  constructor(public readonly orderId: string) {
    super();
  }
}

@Injectable()
class Bridge {
  constructor(private readonly inbox: InboxService) {}

  @OnOutboxEvent(OrderCreated)
  async created(payload: OrderPayload, context: OutboxHandlerContext) {
    if (context.tenantId !== tenantId)
      throw new Error("Unexpected fixture tenant");
    await this.inbox.accept({
      scope: { kind: "tenant", id: tenantId },
      source: "example-order-service",
      consumer: "example.projection.v1",
      messageId: context.eventId,
      eventType: OrderCreated.eventType,
      schemaVersion: 1,
      payload,
    });
  }

  @OnOutboxEvent(OrderProjected)
  async projected(payload: OrderPayload, context: OutboxHandlerContext) {
    if (context.tenantId !== tenantId)
      throw new Error("Unexpected fixture tenant");
    await this.inbox.accept({
      scope: { kind: "tenant", id: tenantId },
      source: "example-projection-service",
      consumer: "example.receipt.v1",
      messageId: context.eventId,
      eventType: OrderProjected.eventType,
      schemaVersion: 1,
      payload,
    });
  }
}

async function main() {
  const prisma = createPrisma();
  const outboxModule = OutboxModule.forRoot({
    prisma,
    polling: { interval: 25 },
  });
  @Module({
    imports: [
      outboxModule,
      InboxModule.forRootAsync({
        imports: [outboxModule],
        inject: [OutboxEmitter],
        useFactory: (outbox: OutboxEmitter) => {
          const handlers: InboxHandler<
            OrderPayload,
            Prisma.TransactionClient
          >[] = [
            {
              consumer: "example.projection.v1",
              eventType: OrderCreated.eventType,
              schemaVersion: 1,
              async handle(payload, ctx) {
                if (ctx.scope.kind !== "tenant")
                  throw new InboxPermanentError();
                await ctx.tx.exampleProjection.create({
                  data: { tenantId: ctx.scope.id, orderId: payload.orderId },
                });
                // This insert, the projection, and Inbox COMPLETED share ctx.tx.
                await outbox.emit(ctx.tx, new OrderProjected(payload.orderId), {
                  tenantId: ctx.scope.id,
                  aggregateId: payload.orderId,
                  causationId: ctx.messageId,
                });
              },
            },
            {
              consumer: "example.receipt.v1",
              eventType: OrderProjected.eventType,
              schemaVersion: 1,
              async handle(payload, ctx) {
                if (ctx.scope.kind !== "tenant")
                  throw new InboxPermanentError();
                await ctx.tx.exampleReceipt.create({
                  data: { tenantId: ctx.scope.id, orderId: payload.orderId },
                });
              },
            },
          ];
          return {
            prisma,
            handlers,
            worker: { enabled: true, pollIntervalMs: 25, concurrency: 2 },
          };
        },
      }),
    ],
    providers: [Bridge],
  })
  class AppModule {}

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ["error", "warn"],
  });
  app.enableShutdownHooks();
  try {
    const orderId = randomUUID();
    await prisma.$transaction(async (tx) => {
      await tx.exampleOrder.create({ data: { id: orderId, tenantId } });
      await app.get(OutboxEmitter).emit(tx, new OrderCreated(orderId), {
        tenantId,
        aggregateId: orderId,
      });
    });
    await waitUntil(
      async () =>
        (await prisma.exampleReceipt.count({
          where: { orderId, tenantId },
        })) === 1,
      "outbox → inbox → business write → outbox → downstream inbox",
    );
    const [event] = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
      "SELECT id FROM outbox_events WHERE aggregate_id = $1 AND event_type = $2",
      orderId,
      OrderCreated.eventType,
    );
    assert.ok(event);
    const repeated = await app.get(InboxService).accept({
      scope: { kind: "tenant", id: tenantId },
      source: "example-order-service",
      consumer: "example.projection.v1",
      messageId: event.id,
      eventType: OrderCreated.eventType,
      schemaVersion: 1,
      payload: { orderId },
    });
    assert.equal(repeated.kind, "duplicate");
    assert.equal(
      await prisma.exampleProjection.count({ where: { orderId, tenantId } }),
      1,
    );
    assert.equal(
      await prisma.exampleReceipt.count({ where: { orderId, tenantId } }),
      1,
    );
    console.log(
      JSON.stringify({
        projections: 1,
        downstreamReceipts: 1,
        duplicateReplay: repeated.kind,
      }),
    );
  } finally {
    try {
      await app.close();
    } finally {
      await prisma.$disconnect();
    }
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
