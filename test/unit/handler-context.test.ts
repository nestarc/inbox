import { describe, expect, it, vi } from "vitest";
import { runInHandlerContext } from "../../src/internal/handler-context";
import { InboxConfigurationError } from "../../src/contracts/errors";
import type { InboxContext } from "../../src/contracts/types";

const context: InboxContext = {
  tx: { $queryRawUnsafe: vi.fn(), $executeRawUnsafe: vi.fn() },
  scope: { kind: "tenant", id: "a" },
  messageId: "message",
  source: "source",
  consumer: "consumer",
  inboxId: "id",
  attempt: 1,
  signal: new AbortController().signal,
};

describe("handler transaction context", () => {
  it("does not start the handler after cancellation during delayed tenant setup", async () => {
    const controller = new AbortController();
    const failure = new Error("lease lost");
    const handle = vi.fn();
    let release!: () => void;
    const delayed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const processing = runInHandlerContext(
      { ...context, signal: controller.signal },
      handle,
      async (_ctx, next) => {
        await delayed;
        await next();
      },
    );
    controller.abort(failure);
    release();
    await expect(processing).rejects.toBe(failure);
    expect(handle).not.toHaveBeenCalled();
  });

  it("checks cancellation again before the scheduled handler starts", async () => {
    const controller = new AbortController();
    const handle = vi.fn();
    const failure = new Error("deadline");
    await expect(
      runInHandlerContext(
        { ...context, signal: controller.signal },
        handle,
        async (_ctx, next) => {
          const processing = next();
          controller.abort(failure);
          await processing;
        },
      ),
    ).rejects.toBe(failure);
    expect(handle).not.toHaveBeenCalled();
  });
  it("passes the existing transaction and waits for unawaited business work", async () => {
    let release!: () => void;
    let done = false;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const work = runInHandlerContext(
      context,
      () => pending,
      async (received, next) => {
        expect(received.tx).toBe(context.tx);
        void next();
      },
    ).then(() => {
      done = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(done).toBe(false);
    release();
    await work;
  });

  it("rejects skipped processing and prevents late work after the wrapper returns", async () => {
    const handle = vi.fn();
    let late!: () => Promise<void>;
    await expect(
      runInHandlerContext(context, handle, async (_ctx, next) => {
        late = next;
      }),
    ).rejects.toBeInstanceOf(InboxConfigurationError);
    expect(() => late()).toThrow(InboxConfigurationError);
    expect(handle).not.toHaveBeenCalled();
  });

  it("cannot turn a swallowed handler failure into a completion", async () => {
    const failure = new Error("business write failed");
    await expect(
      runInHandlerContext(
        context,
        async () => {
          throw failure;
        },
        async (_ctx, next) => {
          await next().catch(() => undefined);
        },
      ),
    ).rejects.toBe(failure);
  });

  it("cannot swallow a second invocation and commit the first effect", async () => {
    const handle = vi.fn().mockResolvedValue(undefined);
    await expect(
      runInHandlerContext(context, handle, async (_ctx, next) => {
        await next();
        try {
          await next();
        } catch {
          /* deliberately invalid wrapper */
        }
      }),
    ).rejects.toBeInstanceOf(InboxConfigurationError);
    expect(handle).toHaveBeenCalledTimes(1);
  });
});
