import { InboxConfigurationError } from "../contracts/errors";
import type { InboxOptions, ResolvedWorkerOptions } from "../contracts/types";
import { boundedString } from "./validation";

export function resolveOptions(options: InboxOptions): {
  consumers: string[];
  worker: ResolvedWorkerOptions;
} {
  if (
    !options ||
    !options.prisma ||
    typeof options.prisma.$transaction !== "function"
  ) {
    throw new InboxConfigurationError(
      "An application-owned Prisma client with interactive transactions is required.",
    );
  }
  const handlers = options.handlers ?? [];
  if (
    options.handlerContext !== undefined &&
    typeof options.handlerContext !== "function"
  ) {
    throw new InboxConfigurationError("handlerContext must be a function.");
  }
  const registered = handlers.map((handler) => {
    boundedString(handler.consumer, "handler.consumer", 128);
    boundedString(handler.eventType, "handler.eventType", 128);
    if (
      !Number.isInteger(handler.schemaVersion) ||
      handler.schemaVersion < 1 ||
      handler.schemaVersion > 2147483647 ||
      typeof handler.handle !== "function"
    ) {
      throw new InboxConfigurationError(
        "Each handler needs an eventType, positive schemaVersion, and handle method.",
      );
    }
    return handler.consumer;
  });
  if (new Set(registered).size !== registered.length)
    throw new InboxConfigurationError("Consumer handlers must be unique.");
  const consumers = [...(options.consumers ?? registered)];
  if (!consumers.length || new Set(consumers).size !== consumers.length)
    throw new InboxConfigurationError(
      "Provide a non-empty unique consumer allowlist.",
    );
  consumers.forEach((name) => boundedString(name, "consumer", 128));
  const w = options.worker ?? {};
  const worker: ResolvedWorkerOptions = {
    enabled: w.enabled ?? false,
    consumers: [...(w.consumers ?? registered)],
    concurrency: w.concurrency ?? 4,
    pollIntervalMs: w.pollIntervalMs ?? 1000,
    leaseMs: w.leaseMs ?? 30000,
    heartbeatIntervalMs: w.heartbeatIntervalMs ?? 5000,
    transactionTimeoutMs: w.transactionTimeoutMs ?? 10000,
    transactionMaxWaitMs: w.transactionMaxWaitMs ?? 5000,
    lockTimeoutMs: w.lockTimeoutMs ?? 1000,
    shutdownTimeoutMs: w.shutdownTimeoutMs ?? 15000,
    maxAttempts: w.maxAttempts ?? 8,
    retryBaseMs: w.retryBaseMs ?? 1000,
    retryMaxMs: w.retryMaxMs ?? 300000,
  };
  for (const [key, value] of Object.entries(worker)) {
    if (key === "enabled" || key === "consumers") continue;
    if (
      !Number.isSafeInteger(value) ||
      (value as number) < 1 ||
      (value as number) > 2147483647
    ) {
      throw new InboxConfigurationError(
        `${key} must be a positive 32-bit integer.`,
      );
    }
  }
  if (
    typeof worker.enabled !== "boolean" ||
    worker.concurrency > 100 ||
    worker.maxAttempts > 10000 ||
    worker.heartbeatIntervalMs * 2 >= worker.leaseMs ||
    worker.retryBaseMs > worker.retryMaxMs ||
    worker.transactionTimeoutMs + worker.transactionMaxWaitMs > 2147483647
  ) {
    throw new InboxConfigurationError(
      "Invalid concurrency, heartbeat, retry, or attempt bounds.",
    );
  }
  if (
    new Set(worker.consumers).size !== worker.consumers.length ||
    worker.consumers.some((name) => !registered.includes(name)) ||
    (worker.enabled && !worker.consumers.length)
  ) {
    throw new InboxConfigurationError(
      "Every owned consumer must have exactly one registered handler.",
    );
  }
  if (
    options.maxPayloadBytes !== undefined &&
    (!Number.isSafeInteger(options.maxPayloadBytes) ||
      options.maxPayloadBytes < 1 ||
      options.maxPayloadBytes > 16777216)
  ) {
    throw new InboxConfigurationError(
      "maxPayloadBytes must be between 1 and 16777216.",
    );
  }
  if (
    options.maxPendingMessages !== undefined &&
    (!Number.isSafeInteger(options.maxPendingMessages) ||
      options.maxPendingMessages < 1 ||
      options.maxPendingMessages > 2147483647)
  ) {
    throw new InboxConfigurationError(
      "maxPendingMessages must be a positive 32-bit integer.",
    );
  }
  return { consumers, worker };
}
