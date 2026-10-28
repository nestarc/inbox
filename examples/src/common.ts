import "reflect-metadata";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  InboxModule,
  InboxPermanentError,
  type InboxHandler,
} from "@nestarc/inbox";
import { PrismaClient, type Prisma } from "./generated/prisma/client";
import { setTimeout } from "node:timers/promises";

export const tenantId = "example-tenant";
export type OrderPayload = { orderId: string };

export function exampleDatabaseUrl(): string {
  const value = process.env.INBOX_EXAMPLE_DATABASE_URL;
  if (!value)
    throw new Error(
      "Set INBOX_EXAMPLE_DATABASE_URL to the dedicated local fixture.",
    );
  const url = new URL(value);
  const isolatedTest =
    process.env.INBOX_TEST_DATABASE === "1" &&
    process.env.INBOX_TEST_DATABASE_URL === value &&
    process.env.INBOX_TEST_DATABASE_NAME === url.pathname.slice(1) &&
    /^\/nestarc_inbox_test_[a-f0-9]{16}$/.test(url.pathname) &&
    url.username === "inbox_test";
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    (!/^\/inbox_examples(?:_[a-zA-Z0-9_]+)?$/.test(url.pathname) &&
      !isolatedTest)
  ) {
    throw new Error("Examples require a local inbox_examples database.");
  }
  return value;
}

export function createPrisma(): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString: exampleDatabaseUrl(), max: 12 }),
  });
}

export function projectionHandler(
  consumer: string,
  eventType: string,
): InboxHandler<OrderPayload, Prisma.TransactionClient> {
  return {
    consumer,
    eventType,
    schemaVersion: 1,
    validate: (payload) =>
      !!payload &&
      typeof payload === "object" &&
      !Array.isArray(payload) &&
      typeof payload.orderId === "string" &&
      payload.orderId.length > 0,
    async handle(payload, ctx) {
      if (ctx.scope.kind !== "tenant") throw new InboxPermanentError();
      await ctx.tx.exampleProjection.create({
        data: { tenantId: ctx.scope.id, orderId: payload.orderId },
      });
    },
  };
}

export async function startInbox(consumer: string, eventType: string) {
  const prisma = createPrisma();
  @Module({
    imports: [
      InboxModule.forRoot({
        prisma,
        handlers: [projectionHandler(consumer, eventType)],
        worker: { enabled: true, pollIntervalMs: 25, concurrency: 2 },
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

export async function waitUntil(
  check: () => Promise<boolean>,
  label: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await setTimeout(25);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
