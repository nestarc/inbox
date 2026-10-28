import "reflect-metadata";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { InboxModule, InboxValidationError } from "@nestarc/inbox";
import { createPrisma, projectionHandler } from "./common";

export type BrokerEvent = { eventId: string; orderId: string };

/** The producer's event ID survives transport redelivery and republishing. */
export function parseBrokerEvent(value: unknown): BrokerEvent {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof (value as BrokerEvent).eventId !== "string" ||
    !(value as BrokerEvent).eventId.trim() ||
    Buffer.byteLength((value as BrokerEvent).eventId) > 256 ||
    typeof (value as BrokerEvent).orderId !== "string" ||
    !(value as BrokerEvent).orderId.trim() ||
    Buffer.byteLength((value as BrokerEvent).orderId) > 256
  )
    throw new InboxValidationError("Expected an eventId and orderId.");
  return value as BrokerEvent;
}

/** Local smoke fixture: fail the first handler attempt, then let Inbox retry it. */
export async function startBrokerInbox(consumer: string, eventType: string) {
  const prisma = createPrisma();
  const projection = projectionHandler(consumer, eventType);
  let retries = 0;
  @Module({
    imports: [
      InboxModule.forRoot({
        prisma,
        handlers: [
          {
            ...projection,
            async handle(payload, context) {
              if (context.attempt === 1)
                throw new Error("Injected first handler failure");
              await projection.handle(payload, context);
            },
          },
        ],
        worker: {
          enabled: true,
          pollIntervalMs: 25,
          concurrency: 2,
          retryBaseMs: 10,
          retryMaxMs: 20,
        },
        observer: (event) => {
          if (event.type === "retry") retries++;
        },
      }),
    ],
  })
  class AppModule {}
  try {
    const app = await NestFactory.createApplicationContext(AppModule, {
      logger: ["error", "warn"],
    });
    return {
      app,
      prisma,
      retries: () => retries,
      async close() {
        try {
          await app.close();
        } finally {
          await prisma.$disconnect();
        }
      },
    };
  } catch (error) {
    await prisma.$disconnect();
    throw error;
  }
}
