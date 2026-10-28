import type { InboxRecord, InboxStatus } from "../contracts/types";
import type { InboxAdminView } from "../inbox-admin.service";
import type { InboxService } from "../inbox.service";
import { withAbort } from "../internal/reliability-core/abort";

export interface InboxTestOptions {
  /** Overall wait budget, including database reads and worker execution. Default: 5,000. */
  timeoutMs?: number;
  /** Delay between state checks. Default: 10. */
  pollIntervalMs?: number;
  /** Maximum state-check passes. Default: 1,000. */
  maxPasses?: number;
  signal?: AbortSignal;
}

export interface InboxWaitOptions extends InboxTestOptions {
  /** The terminal state to wait for. Default: COMPLETED. */
  status?: "COMPLETED" | "DEAD";
}

/** Safe diagnostics; deliberately excludes payloads, scope and handler error text. */
export interface InboxTestSnapshot {
  id: string;
  status: InboxStatus | null;
  attemptCount: number | null;
  cycleAttemptCount: number | null;
}

export type InboxTestErrorCode =
  | "INVALID_OPTIONS"
  | "TIMEOUT"
  | "ABORTED"
  | "PASS_LIMIT"
  | "UNEXPECTED_TERMINAL_STATE";

export class InboxTestError extends Error {
  readonly records: readonly InboxTestSnapshot[];

  constructor(
    readonly code: InboxTestErrorCode,
    message: string,
    records: readonly InboxTestSnapshot[] = [],
  ) {
    super(message);
    this.name = "InboxTestError";
    this.records = records.map((record) => ({ ...record }));
  }
}

type Reader = Pick<InboxAdminView, "get">;
type Runner = Pick<InboxService, "runOnce">;

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647)
    throw new InboxTestError(
      "INVALID_OPTIONS",
      `${name} must be a positive 32-bit integer.`,
    );
  return value;
}

function receiptIds(ids: readonly string[]): string[] {
  if (
    !Array.isArray(ids) ||
    ids.length > 1000 ||
    Array.from(ids).some(
      (id) =>
        typeof id !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          id,
        ),
    )
  )
    throw new InboxTestError(
      "INVALID_OPTIONS",
      "Provide at most 1,000 receipt UUIDs.",
    );
  return [...new Set(ids.map((id) => id.toLowerCase()))];
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const aborted = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", aborted);
      resolve();
    }, ms);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
  });
}

async function awaitRecords(
  reader: Reader,
  ids: readonly string[],
  options: InboxWaitOptions,
  runner?: Runner,
): Promise<InboxRecord[]> {
  const timeoutMs = positiveInteger(options.timeoutMs ?? 5000, "timeoutMs");
  const pollIntervalMs = positiveInteger(
    options.pollIntervalMs ?? 10,
    "pollIntervalMs",
  );
  const maxPasses = positiveInteger(options.maxPasses ?? 1000, "maxPasses");
  const status = options.status ?? "COMPLETED";
  if (status !== "COMPLETED" && status !== "DEAD")
    throw new InboxTestError(
      "INVALID_OPTIONS",
      "status must be COMPLETED or DEAD.",
    );
  const snapshots: InboxTestSnapshot[] = ids.map((id) => ({
    id,
    status: null,
    attemptCount: null,
    cycleAttemptCount: null,
  }));
  const controller = new AbortController();
  const fail = (code: InboxTestErrorCode, message: string) =>
    new InboxTestError(code, message, snapshots);
  const aborted = () =>
    controller.abort(fail("ABORTED", "Inbox test wait was aborted."));
  options.signal?.addEventListener("abort", aborted, { once: true });
  if (options.signal?.aborted) aborted();
  const timer = setTimeout(
    () =>
      controller.abort(
        fail(
          "TIMEOUT",
          `Inbox test did not reach ${status} within ${timeoutMs}ms.`,
        ),
      ),
    timeoutMs,
  );
  const run = <T>(fn: () => Promise<T>) => withAbort(controller.signal, fn);
  try {
    return await run(async () => {
      if (ids.length === 0) return [];
      for (let pass = 0; pass < maxPasses; pass++) {
        const records: InboxRecord[] = [];
        for (let index = 0; index < ids.length; index++) {
          const record = await run(() => reader.get(ids[index]!));
          snapshots[index] = {
            id: ids[index]!,
            status: record?.status ?? null,
            attemptCount: record?.attemptCount ?? null,
            cycleAttemptCount: record?.cycleAttemptCount ?? null,
          };
          if (record) records.push(record);
          if (
            record &&
            record.status !== status &&
            (record.status === "DEAD" || record.status === "COMPLETED")
          )
            throw fail(
              "UNEXPECTED_TERMINAL_STATE",
              `Inbox receipt ${record.id} reached ${record.status}; expected ${status}.`,
            );
        }
        if (
          records.length === ids.length &&
          records.every((record) => record.status === status)
        )
          return records;
        if (pass + 1 === maxPasses) break;
        if (runner) await run(() => runner.runOnce());
        // A zero-claim poll may mean a scheduled retry or a live lease, not completion.
        await pause(pollIntervalMs, controller.signal);
      }
      throw fail(
        "PASS_LIMIT",
        `Inbox test did not reach ${status} after ${maxPasses} state checks.`,
      );
    });
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", aborted);
  }
}

/**
 * Run the real worker until the requested receipts are COMPLETED.
 * IDs select assertions, not claims: runOnce may process other owned receipts.
 * Timeout/cancellation stops waiting and new polls; it cannot cancel an in-flight transaction.
 */
export async function drainInbox(
  inbox: Runner,
  admin: Reader,
  ids: readonly string[],
  options: InboxTestOptions = {},
): Promise<InboxRecord[]> {
  return awaitRecords(
    admin,
    receiptIds(ids),
    { ...options, status: "COMPLETED" },
    inbox,
  );
}

/** Observe an existing worker without starting processing or changing the receipt. */
export async function waitForInboxRecord(
  admin: Reader,
  id: string,
  options: InboxWaitOptions = {},
): Promise<InboxRecord> {
  const records = await awaitRecords(admin, receiptIds([id]), options);
  return records[0]!;
}
