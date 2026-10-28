import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  consumer,
  createFixture,
  envelope,
  runOptions,
  waitForLeaseExpiry,
  writeEffects,
} from "../integration/fixture";

type Ready = { type: "ready"; id: string; boundary: string };

describe("real process termination at durable inbox boundaries", () => {
  let fixture: Awaited<ReturnType<typeof createFixture>>;
  const children = new Set<ChildProcess>();
  beforeAll(async () => {
    fixture = await createFixture();
  }, 30_000);
  beforeEach(async () => {
    await fixture.reset();
  });
  afterEach(async () => {
    await Promise.all(
      [...children].map(async (child) => {
        if (child.exitCode === null && child.signalCode === null)
          await kill(child);
      }),
    );
    children.clear();
  });
  afterAll(async () => {
    await fixture?.close();
  });

  async function scenario(mode: string, ...args: string[]) {
    const child = fork(
      resolve("test/failure/crash-child.ts"),
      [mode, ...args],
      {
        execArgv: ["--import", "tsx"],
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    children.add(child);
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    const ready = await new Promise<Ready>((yes, no) => {
      const timeout = setTimeout(
        () => no(new Error(`Crash child did not reach ${mode}: ${output}`)),
        10_000,
      );
      child.once("error", (error) => {
        clearTimeout(timeout);
        no(error);
      });
      child.once("exit", (code, signal) => {
        clearTimeout(timeout);
        no(
          new Error(
            `Crash child exited before ${mode} (${code ?? signal}): ${output}`,
          ),
        );
      });
      child.on("message", (message: unknown) => {
        if (!message || typeof message !== "object") return;
        const value = message as { type?: string; message?: string };
        if (value.type === "ready") {
          clearTimeout(timeout);
          yes(message as Ready);
        }
        if (value.type === "failure") {
          clearTimeout(timeout);
          no(new Error(value.message));
        }
      });
    });
    return { child, ready };
  }

  async function kill(child: ChildProcess) {
    return new Promise<void>((yes, no) => {
      const timeout = setTimeout(
        () => no(new Error("SIGKILL did not terminate the fixture child.")),
        5_000,
      );
      child.once("exit", (_code, signal) => {
        clearTimeout(timeout);
        if (signal === "SIGKILL") yes();
        else no(new Error(`Expected SIGKILL, received ${signal}`));
      });
      child.kill("SIGKILL");
    });
  }

  it("AC05 survives SIGKILL after acceptance commit and before the transport ACK", async () => {
    const messageId = randomUUID();
    const { child, ready } = await scenario("accepted", messageId);
    expect(ready.boundary).toBe("accept-committed-before-ack");
    await kill(child);
    const duplicate = await fixture.storage.accept(envelope({ messageId }));
    expect(duplicate).toMatchObject({
      kind: "duplicate",
      id: ready.id,
      status: "PENDING",
    });
    const [claimed] = await fixture.storage.claim(
      [consumer],
      1,
      "replacement-worker",
      5_000,
      3,
    );
    await fixture.storage.run(
      claimed!,
      (tx) => writeEffects(tx, ready.id),
      runOptions,
    );
    expect(await fixture.effects(ready.id)).toEqual({ business: 1, outbox: 1 });
  });

  it("AC06 recovers a committed claim after SIGKILL and real lease expiry", async () => {
    const receipt = await fixture.storage.accept(envelope());
    const { child, ready } = await scenario("claimed");
    expect(ready.id).toBe(receipt.id);
    await kill(child);
    await waitForLeaseExpiry(fixture.storage, receipt.id);
    const [claimed] = await fixture.storage.claim(
      [consumer],
      1,
      "replacement-worker",
      5_000,
      3,
    );
    expect(claimed).toMatchObject({
      id: receipt.id,
      attemptCount: 2,
      cycleAttemptCount: 2,
      claimToken: "2",
    });
    await fixture.storage.run(
      claimed!,
      (tx) => writeEffects(tx, receipt.id),
      runOptions,
    );
    expect(await fixture.effects(receipt.id)).toEqual({
      business: 1,
      outbox: 1,
    });
  });

  it("AC24 rolls back business, outbox, and completion when killed after completion CAS but before COMMIT", async () => {
    const receipt = await fixture.storage.accept(envelope());
    const { child, ready } = await scenario("before-commit");
    expect(ready.boundary).toBe("completion-cas-before-commit");
    // The completed row and effects are uncommitted and invisible to this connection.
    expect((await fixture.storage.get(receipt.id))?.status).toBe("PROCESSING");
    expect(await fixture.effects(receipt.id)).toEqual({});
    await kill(child);
    await waitForLeaseExpiry(fixture.storage, receipt.id);
    const [claimed] = await fixture.storage.claim(
      [consumer],
      1,
      "replacement-worker",
      5_000,
      3,
    );
    expect(claimed?.attemptCount).toBe(2);
    expect(await fixture.effects(receipt.id)).toEqual({});
    await fixture.storage.run(
      claimed!,
      (tx) => writeEffects(tx, receipt.id),
      runOptions,
    );
    expect((await fixture.storage.get(receipt.id))?.status).toBe("COMPLETED");
    expect(await fixture.effects(receipt.id)).toEqual({
      business: 1,
      outbox: 1,
    });
  });
});
