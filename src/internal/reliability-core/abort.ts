/** Cancellation rejects the owning operation; it cannot undo external side effects. */
export function withAbort<T>(
  signal: AbortSignal,
  run: () => Promise<T>,
): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    void Promise.resolve()
      .then(() => {
        if (signal.aborted) throw signal.reason;
        return run();
      })
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", aborted));
  });
}
