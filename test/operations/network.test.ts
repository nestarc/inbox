import { createServer, connect, type Socket } from "node:net";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { InboxService } from "../../src/inbox.service";
import { PrismaClient } from "../prisma/generated";
import { requireTestDatabase } from "../prisma/fixture-guard";
import {
  consumer,
  createFixture,
  deferred,
  envelope,
  workerOptions,
  writeEffects,
} from "../integration/fixture";

/** A real TCP transport: cut destroys sockets; blackhole drops bytes in both directions. */
async function proxy() {
  const target = new URL(requireTestDatabase());
  const targetPort = Number(target.port);
  const sockets = new Set<Socket>();
  let blackhole = false;
  let droppedBytes = 0;
  const server = createServer((downstream) => {
    const upstream = connect(targetPort, target.hostname);
    for (const socket of [downstream, upstream]) {
      sockets.add(socket);
      socket.on("error", () => {});
      socket.on("close", () => sockets.delete(socket));
    }
    downstream.on("data", (data: Buffer) => {
      if (blackhole) droppedBytes += data.length;
      else upstream.write(data);
    });
    upstream.on("data", (data: Buffer) => {
      if (blackhole) droppedBytes += data.length;
      else downstream.write(data);
    });
    downstream.on("close", () => upstream.destroy());
    upstream.on("close", () => downstream.destroy());
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing proxy port");
  target.port = String(address.port);
  return {
    url: target.toString(),
    cut() {
      for (const socket of sockets) socket.destroy();
    },
    blackhole() {
      blackhole = true;
    },
    restore() {
      blackhole = false;
      this.cut();
    },
    get droppedBytes() {
      return droppedBytes;
    },
    async close() {
      this.cut();
      server.close();
      await once(server, "close");
    },
  };
}

describe("real PostgreSQL transport interruption", () => {
  let fixture: Awaited<ReturnType<typeof createFixture>>;
  beforeAll(async () => {
    fixture = await createFixture();
  });
  beforeEach(async () => {
    await fixture.reset();
  });
  afterAll(async () => {
    await fixture?.close();
  });

  it.each(["cut", "blackhole"] as const)(
    "rolls back in-flight effects during a TCP %s and recovers the same client",
    async (mode) => {
      const transport = await proxy();
      const prisma = new PrismaClient({
        adapter: new PrismaPg({
          connectionString: transport.url,
          max: 4,
          connectionTimeoutMillis: 300,
          // Real deployments must also bound driver/network waits, independently of worker leases.
          query_timeout: 500,
        }),
      });
      const entered = deferred();
      const resume = deferred();
      let executions = 0;
      const inbox = new InboxService({
        prisma,
        worker: workerOptions({
          enabled: false,
          concurrency: 1,
          leaseMs: 1_200,
          heartbeatIntervalMs: 200,
          transactionTimeoutMs: 1_000,
          transactionMaxWaitMs: 300,
        }),
        handlers: [
          {
            consumer,
            eventType: "order.created",
            schemaVersion: 1,
            async handle(_payload, context) {
              executions++;
              await writeEffects(context.tx, context.inboxId);
              if (executions === 1) {
                entered.resolve();
                await resume.promise;
                await context.tx.$queryRawUnsafe("SELECT 1");
              }
            },
          },
        ],
      });
      try {
        const { payloadJson, fingerprint, fingerprintVersion, ...message } =
          envelope();
        const receipt = await inbox.accept(message);
        const pending = inbox.runOnce();
        await entered.promise;
        expect(await fixture.effects(receipt.id)).toEqual({});
        const started = Date.now();
        transport[mode]();
        resume.resolve();
        await pending;
        const interruptedBatchMs = Date.now() - started;
        expect(interruptedBatchMs).toBeLessThan(5_000);
        if (mode === "blackhole")
          expect(transport.droppedBytes).toBeGreaterThan(0);
        transport.restore();
        const deadline = Date.now() + 5_000;
        while (
          Date.now() < deadline &&
          (await fixture.storage.get(receipt.id))?.status !== "COMPLETED"
        ) {
          await inbox.runOnce();
          await delay(40);
        }
        expect((await fixture.storage.get(receipt.id))?.status).toBe(
          "COMPLETED",
        );
        expect(executions).toBe(2);
        expect(await fixture.effects(receipt.id)).toEqual({
          business: 1,
          outbox: 1,
        });
        expect(await inbox.accept(message)).toMatchObject({
          kind: "duplicate",
          id: receipt.id,
        });
        console.log(
          JSON.stringify({
            operation: `tcp-${mode}`,
            interruptedBatchMs,
            recoveryMs: Date.now() - started - interruptedBatchMs,
            droppedBytes: transport.droppedBytes,
            executions,
            committedBusinessEffects: 1,
          }),
        );
      } finally {
        resume.resolve();
        transport.restore();
        await inbox.close();
        await prisma.$disconnect();
        await transport.close();
      }
    },
  );
});
