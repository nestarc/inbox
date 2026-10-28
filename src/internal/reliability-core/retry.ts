export interface RetryPolicy {
  baseMs: number;
  maxMs: number;
  /** Inbox uses full jitter; existing outbox consumers can keep deterministic delays. */
  jitter?: "none" | "full";
}

/** attempt is one-based and includes the initial claim. A crash still consumes an attempt. */
export function retryDelayMs(
  attempt: number,
  policy: RetryPolicy,
  random: () => number = Math.random,
): number {
  if (
    !Number.isSafeInteger(attempt) ||
    attempt < 1 ||
    !Number.isSafeInteger(policy.baseMs) ||
    !Number.isSafeInteger(policy.maxMs) ||
    policy.baseMs < 0 ||
    policy.maxMs < policy.baseMs ||
    policy.maxMs > 2147483647 ||
    (policy.jitter !== undefined && !["none", "full"].includes(policy.jitter))
  ) {
    throw new RangeError("Invalid retry attempt or bounded delay policy.");
  }
  const cap =
    policy.baseMs === 0
      ? 0
      : Math.min(policy.maxMs, policy.baseMs * 2 ** Math.min(attempt - 1, 31));
  if (policy.jitter !== "full" || cap === 0) return cap;
  const sample = random();
  if (!Number.isFinite(sample) || sample < 0 || sample >= 1)
    throw new RangeError("Retry random source must return a value in [0, 1).");
  return Math.floor(sample * (cap + 1));
}
