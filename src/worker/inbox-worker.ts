import { randomUUID } from "node:crypto";
import { retryDelayMs, withAbort } from "../internal/reliability-core";
import { runInHandlerContext } from "../internal/handler-context";
import {
  InboxConfigurationError,
  InboxLeaseLostError,
  InboxPermanentError,
  InboxTimeoutError,
} from "../contracts/errors";
import type {
  InboxHandler,
  InboxObservation,
  InboxOptions,
  InboxRecord,
  ResolvedWorkerOptions,
} from "../contracts/types";
import type { PrismaInboxStorage } from "../storage/prisma/prisma-inbox.storage";

type Failure = { code: string; message: string; permanent: boolean };

/** Internal polling worker. Business effects and completion are committed by storage.run(). */
export class InboxWorker {
  private readonly workerId = randomUUID();
  private readonly handlers = new Map<string, InboxHandler<any, any>>();
  private readonly active = new Set<Promise<void>>();
  private readonly controllers = new Set<AbortController>();
  private claimPromise: Promise<InboxRecord[]> | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private stopped = false;
  private stopPromise: Promise<void> | undefined;

  constructor(
    private readonly storage: PrismaInboxStorage,
    handlers: InboxHandler<any, any>[],
    private readonly options: ResolvedWorkerOptions,
    private readonly observer?: InboxOptions["observer"],
    private readonly handlerContext?: InboxOptions["handlerContext"],
  ) {
    for (const handler of handlers) {
      if (this.handlers.has(handler.consumer)) {
        throw new InboxConfigurationError(
          "Each consumer must have exactly one registered handler.",
        );
      }
      this.handlers.set(handler.consumer, handler);
    }
    for (const consumer of options.consumers) {
      if (!this.handlers.has(consumer)) {
        throw new InboxConfigurationError(
          "Every worker-owned consumer must have a registered handler.",
        );
      }
    }
  }

  /** Start background polling. Schema validation must have succeeded first. */
  start(): void {
    if (this.running || this.stopped || !this.options.enabled) return;
    this.running = true;
    this.schedule(0);
  }

  /** Claim only free slots and wait for this batch. Concurrent calls cannot oversubscribe. */
  async tick(): Promise<number> {
    if (
      this.stopped ||
      this.claimPromise ||
      this.options.consumers.length === 0
    )
      return 0;
    const capacity = this.options.concurrency - this.active.size;
    if (capacity <= 0) return 0;

    const claiming = Promise.resolve().then(() =>
      this.stopped
        ? []
        : this.storage.claim(
            this.options.consumers,
            capacity,
            this.workerId,
            this.options.leaseMs,
            this.options.maxAttempts,
          ),
    );
    this.claimPromise = claiming;
    let records: InboxRecord[];
    try {
      records = await claiming;
      // Shutdown can race the DB claim. Do not execute or renew newly returned claims;
      // their durable leases will expire and another worker can recover them.
      if (this.stopped) return records.length;
      const batch = records.map((record) => {
        // Defer execution until the promise is tracked and capacity is reserved.
        const task = Promise.resolve().then(() => this.process(record));
        this.active.add(task);
        void task.then(
          () => this.active.delete(task),
          () => this.active.delete(task),
        );
        return task;
      });
      this.claimPromise = null;
      await Promise.all(batch);
      return records.length;
    } finally {
      if (this.claimPromise === claiming) this.claimPromise = null;
    }
  }

  /** Stop is terminal and idempotent. Expired in-flight work is recovered via its lease. */
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopped = true;
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.stopPromise = this.drain();
    return this.stopPromise;
  }

  private schedule(delayMs: number): void {
    if (!this.running || this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.running || this.stopped) return;
      void this.tick().catch(() =>
        this.observe({ type: "error", code: "CLAIM_FAILED" }),
      );
      this.schedule(this.options.pollIntervalMs);
    }, delayMs);
    this.timer.unref?.();
  }

  private async drain(): Promise<void> {
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<void>((resolve) => {
      deadline = setTimeout(() => {
        for (const controller of this.controllers) {
          controller.abort(new InboxLeaseLostError());
        }
        resolve();
      }, this.options.shutdownTimeoutMs);
    });
    const settled = (async () => {
      await this.claimPromise?.catch(() => undefined);
      await Promise.allSettled([...this.active]);
    })();
    try {
      await Promise.race([settled, expired]);
    } finally {
      if (deadline) clearTimeout(deadline);
    }
  }

  private async process(record: InboxRecord): Promise<void> {
    const controller = new AbortController();
    this.controllers.add(controller);
    let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
    let finished = false;
    // Include connection-pool waiting. Lease renewals cannot keep a hung handler alive forever.
    const deadline = setTimeout(
      () => controller.abort(new InboxTimeoutError()),
      this.options.transactionMaxWaitMs + this.options.transactionTimeoutMs,
    );
    deadline.unref?.();

    const scheduleHeartbeat = () => {
      if (finished || controller.signal.aborted) return;
      heartbeatTimer = setTimeout(() => {
        heartbeatTimer = undefined;
        if (finished || controller.signal.aborted) return;
        void (async () => {
          try {
            const owned = await this.storage.heartbeat(
              record.id,
              record.claimToken,
              this.options.leaseMs,
            );
            if (!owned) controller.abort(new InboxLeaseLostError());
          } catch {
            // A failed renewal cannot prove continued ownership. Stop business work;
            // never extend the same token after its lease has expired.
            controller.abort(new InboxLeaseLostError());
          } finally {
            scheduleHeartbeat();
          }
        })();
      }, this.options.heartbeatIntervalMs);
      heartbeatTimer.unref?.();
    };
    scheduleHeartbeat();

    let classified: Failure | undefined;
    try {
      if (this.stopped) throw new InboxLeaseLostError();
      const handler = this.handlers.get(record.consumer);
      if (
        !handler ||
        handler.eventType !== record.eventType ||
        handler.schemaVersion !== record.schemaVersion
      ) {
        classified = {
          code: "UNSUPPORTED_MESSAGE",
          message:
            "The owned consumer does not support this event type or schema version.",
          permanent: true,
        };
        throw new InboxPermanentError();
      }
      try {
        const valid: unknown = handler.validate?.(record.payload);
        // Runtime callers can bypass TypeScript. Async validators are not supported.
        if (valid !== undefined && valid !== true) {
          if (
            valid &&
            typeof (valid as unknown as { then?: unknown }).then === "function"
          ) {
            void Promise.resolve(valid).catch(() => undefined);
          }
          throw new InboxPermanentError();
        }
      } catch {
        classified = {
          code: "INVALID_PAYLOAD",
          message: "The payload failed consumer validation.",
          permanent: true,
        };
        throw new InboxPermanentError();
      }

      await this.storage.run(
        record,
        async (tx) => {
          const context = {
            tx,
            scope: record.scope,
            messageId: record.messageId,
            source: record.source,
            consumer: record.consumer,
            inboxId: record.id,
            attempt: record.attemptCount,
            signal: controller.signal,
            replay: record.replay,
            correlationId: record.correlationId,
            causationId: record.causationId,
          };
          await withAbort(controller.signal, () =>
            runInHandlerContext(
              context,
              () => handler.handle(record.payload, context),
              this.handlerContext,
            ),
          );
          // An ignored signal must still cause rollback before the completion CAS.
          if (controller.signal.aborted) throw controller.signal.reason;
        },
        {
          timeoutMs: this.options.transactionTimeoutMs,
          maxWaitMs: this.options.transactionMaxWaitMs,
          lockTimeoutMs: this.options.lockTimeoutMs,
        },
      );
      this.observe({ type: "completed", consumer: record.consumer });
    } catch (error) {
      // Stop renewing as soon as a transaction fails, including while reconciling an
      // unknown commit outcome on a new connection.
      finished = true;
      if (heartbeatTimer) clearTimeout(heartbeatTimer);
      if (
        error instanceof InboxLeaseLostError ||
        controller.signal.reason instanceof InboxLeaseLostError
      ) {
        this.observe({
          type: "lease_lost",
          consumer: record.consumer,
          code: "LEASE_LOST",
        });
        return;
      }
      const failure = classified ?? classifyFailure(error);
      await this.recordFailure(record, failure);
    } finally {
      finished = true;
      clearTimeout(deadline);
      if (heartbeatTimer) clearTimeout(heartbeatTimer);
      this.controllers.delete(controller);
    }
  }

  private async recordFailure(
    record: InboxRecord,
    failure: Failure,
  ): Promise<void> {
    const controller = new AbortController();
    this.controllers.add(controller);
    // Driver/network promises can remain pending beyond a transaction failure.
    // Reconciliation must not retain a concurrency slot or start a late failure write.
    const deadline = setTimeout(
      () => controller.abort(new InboxTimeoutError()),
      Math.min(
        this.options.transactionMaxWaitMs + this.options.transactionTimeoutMs,
        5000,
      ),
    );
    deadline.unref?.();
    try {
      // A commit can succeed even when the caller receives a transport error.
      const current = await withAbort(controller.signal, () =>
        this.storage.get(record.id),
      );
      if (current?.status === "COMPLETED") {
        this.observe({
          type:
            current.claimToken === record.claimToken
              ? "completed"
              : "lease_lost",
          consumer: record.consumer,
        });
        return;
      }
      if (
        !current ||
        current.status !== "PROCESSING" ||
        current.claimToken !== record.claimToken
      ) {
        this.observe({
          type: "lease_lost",
          consumer: record.consumer,
          code: "LEASE_LOST",
        });
        return;
      }
      const delayMs = this.retryDelay(record.cycleAttemptCount);
      const changed = await withAbort(controller.signal, () =>
        this.storage.fail(
          record.id,
          record.claimToken,
          { code: failure.code, message: failure.message },
          failure.permanent,
          delayMs,
          this.options.maxAttempts,
        ),
      );
      this.observe({
        type: changed
          ? failure.permanent ||
            record.cycleAttemptCount >= this.options.maxAttempts
            ? "dead"
            : "retry"
          : "lease_lost",
        consumer: record.consumer,
        code: changed ? failure.code : "LEASE_LOST",
      });
    } catch {
      // Unavailable state is not evidence of failure. Leave the durable claim alone
      // so another worker can reconcile it after its lease expires.
      this.observe({
        type: "error",
        consumer: record.consumer,
        code: "RECONCILIATION_FAILED",
      });
    } finally {
      clearTimeout(deadline);
      this.controllers.delete(controller);
    }
  }

  private retryDelay(attempt: number): number {
    return retryDelayMs(attempt, {
      baseMs: this.options.retryBaseMs,
      maxMs: this.options.retryMaxMs,
      jitter: "full",
    });
  }

  private observe(event: InboxObservation): void {
    if (!this.observer) return;
    try {
      void Promise.resolve(this.observer(event)).catch(() => undefined);
    } catch {
      // Observation is best effort and cannot affect persisted processing state.
    }
  }
}

function classifyFailure(error: unknown): Failure {
  if (error instanceof InboxPermanentError) {
    return {
      code: "PERMANENT_ERROR",
      message: "The handler rejected the message permanently.",
      permanent: true,
    };
  }
  if (error instanceof InboxTimeoutError) {
    return {
      code: "PROCESSING_TIMEOUT",
      message: "The handler exceeded its transaction deadline.",
      permanent: false,
    };
  }
  return {
    code: "HANDLER_ERROR",
    message: "Message processing failed.",
    permanent: false,
  };
}
