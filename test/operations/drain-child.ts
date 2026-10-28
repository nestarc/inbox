import { setTimeout as delay } from "node:timers/promises";
import { PrismaPg } from "@prisma/adapter-pg";
import { InboxService } from "../../src/inbox.service";
import { PrismaClient } from "../prisma/generated";
import { requireTestDatabase } from "../prisma/fixture-guard";
import { consumer, workerOptions, writeEffects } from "../integration/fixture";

const mode = process.argv[2];
if (mode !== "finish" && mode !== "hung")
  throw new Error("Unknown drain scenario");
const prisma = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: requireTestDatabase(),
    max: 4,
    connectionTimeoutMillis: 500,
  }),
});
const inbox = new InboxService({
  prisma,
  worker: workerOptions({
    enabled: true,
    concurrency: 1,
    leaseMs: 1_500,
    heartbeatIntervalMs: 200,
    transactionTimeoutMs: 8_000,
    shutdownTimeoutMs: mode === "finish" ? 5_000 : 700,
  }),
  handlers: [
    {
      consumer,
      eventType: "order.created",
      schemaVersion: 1,
      async handle(_payload, context) {
        await writeEffects(context.tx, context.inboxId);
        process.send?.({ type: "ready", id: context.inboxId });
        if (mode === "finish") await delay(2_500);
        else await new Promise(() => {});
      },
    },
  ],
});

let closing = false;
process.on("SIGTERM", () => {
  if (closing) return;
  closing = true;
  void (async () => {
    const start = Date.now();
    await inbox.close();
    const drainMs = Date.now() - start;
    await prisma.$disconnect();
    process.send?.({ type: "closed", drainMs });
    process.disconnect?.();
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
    process.disconnect?.();
  });
});
void inbox.initialize().catch((error) => {
  console.error(error);
  process.exitCode = 1;
  process.disconnect?.();
});
