import { fork, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { InboxService } from "../../src/inbox.service";
import {
  consumer,
  createFixture,
  envelope,
  workerOptions,
  writeEffects,
} from "../integration/fixture";

describe("real SIGTERM worker drain", () => {
  let fixture: Awaited<ReturnType<typeof createFixture>>;
  const children = new Set<ChildProcess>();
  beforeAll(async () => {
    fixture = await createFixture();
  });
  beforeEach(async () => {
    await fixture.reset();
  });
  afterEach(async () => {
    await Promise.all(
      [...children].map(async (child) => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const exited = new Promise<void>((yes) =>
          child.once("exit", () => yes()),
        );
        child.kill("SIGKILL");
        await exited;
      }),
    );
    children.clear();
  });
  afterAll(async () => {
    await fixture?.close();
  });

  it.each(["finish", "hung"])(
    "stops claiming, drains a %s handler and preserves recovery",
    async (mode) => {
      const receipt = await fixture.storage.accept(envelope());
      const child = fork(resolve("test/operations/drain-child.ts"), [mode], {
        execArgv: ["--import", "tsx"],
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      children.add(child);
      let output = "";
      child.stdout?.on("data", (data) => {
        output += data.toString();
      });
      child.stderr?.on("data", (data) => {
        output += data.toString();
      });
      let drainMs: number | undefined;
      child.on("message", (message: { type?: string; drainMs?: number }) => {
        if (message.type === "closed") drainMs = message.drainMs;
      });
      const exit = new Promise<number | null>((yes) => child.once("exit", yes));
      await new Promise<void>((yes, no) => {
        const timeout = setTimeout(
          () => no(new Error(`Child failed to start: ${output}`)),
          10_000,
        );
        child.once("error", no);
        child.once("exit", () => {
          clearTimeout(timeout);
          no(new Error(`Child exited before handler: ${output}`));
        });
        child.on("message", (message: { type?: string; id?: string }) => {
          if (message.type === "ready" && message.id === receipt.id) {
            clearTimeout(timeout);
            yes();
          }
        });
      });
      const queued = await fixture.storage.accept(envelope());
      const started = Date.now();
      child.kill("SIGTERM");
      expect(await exit, output).toBe(0);
      expect(Date.now() - started).toBeLessThan(6_000);
      expect(drainMs).toBeDefined();
      expect((await fixture.storage.get(queued.id))?.status).toBe("PENDING");
      expect(await fixture.effects(queued.id)).toEqual({});
      if (mode === "finish") {
        expect(drainMs).toBeGreaterThan(1_500);
        expect((await fixture.storage.get(receipt.id))?.status).toBe(
          "COMPLETED",
        );
        expect(await fixture.effects(receipt.id)).toEqual({
          business: 1,
          outbox: 1,
        });
      } else {
        expect(drainMs).toBeGreaterThanOrEqual(650);
        expect(drainMs).toBeLessThan(2_000);
        expect(await fixture.effects(receipt.id)).toEqual({});
      }
      const replacement = new InboxService({
        prisma: fixture.prisma,
        worker: workerOptions({ enabled: false, concurrency: 2 }),
        handlers: [
          {
            consumer,
            eventType: "order.created",
            schemaVersion: 1,
            handle: (_payload, context) =>
              writeEffects(context.tx, context.inboxId),
          },
        ],
      });
      try {
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
          await replacement.runOnce();
          if (
            (await fixture.storage.get(receipt.id))?.status === "COMPLETED" &&
            (await fixture.storage.get(queued.id))?.status === "COMPLETED"
          )
            break;
          await delay(40);
        }
        for (const id of [receipt.id, queued.id]) {
          expect((await fixture.storage.get(id))?.status).toBe("COMPLETED");
          expect(await fixture.effects(id)).toEqual({ business: 1, outbox: 1 });
        }
        console.log(
          JSON.stringify({
            operation: `sigterm-${mode}`,
            drainMs,
            recoveredReceipts: 2,
          }),
        );
      } finally {
        await replacement.close();
      }
    },
  );
});
