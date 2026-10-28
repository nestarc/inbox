export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
export type InboxScope = { kind: "tenant"; id: string } | { kind: "global" };
export type InboxStatus =
  | "PENDING"
  | "PROCESSING"
  | "RETRYABLE"
  | "COMPLETED"
  | "DEAD";

/** The subset of a Prisma interactive transaction used by the inbox. */
export interface InboxTransaction {
  $queryRawUnsafe<T = unknown>(query: string, ...values: any[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: any[]): Promise<number>;
}
export interface InboxPrismaClient extends InboxTransaction {
  $transaction<T>(
    fn: (tx: InboxTransaction) => Promise<T>,
    options?: {
      maxWait?: number;
      timeout?: number;
      isolationLevel?: "ReadCommitted";
    },
  ): Promise<T>;
}
export interface InboxEnvelope<T extends JsonValue = JsonValue> {
  scope: InboxScope;
  source: string;
  consumer: string;
  messageId: string;
  eventType: string;
  schemaVersion: number;
  payload: T;
  correlationId?: string;
  causationId?: string;
  headers?: { traceparent?: string; tracestate?: string };
}
export interface InboxRecord {
  id: string;
  scope: InboxScope;
  source: string;
  consumer: string;
  messageId: string;
  eventType: string;
  schemaVersion: number;
  payload: JsonValue;
  payloadPurged: boolean;
  fingerprint: string;
  fingerprintVersion: number;
  status: InboxStatus;
  claimToken: string;
  rowVersion: string;
  attemptCount: number;
  cycleAttemptCount: number;
  requeueCount: number;
  receivedAt: Date;
  completedAt: Date | null;
  nextAttemptAt: Date;
  leaseExpiresAt: Date | null;
  workerId: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  lastRequeueReason: string | null;
  lastRequeueActor: string | null;
  lastRequeueAt: Date | null;
  correlationId?: string;
  causationId?: string;
  headers?: InboxEnvelope["headers"];
  /** Present only for an explicitly requested replay; the original receipt is retained. */
  replay?: {
    originalInboxId: string;
    requestId: string;
    sourceVersion: string;
    actor: string;
    reason: string;
    requestedAt: Date;
  };
}
export interface InboxReceipt {
  kind: "accepted" | "duplicate";
  id: string;
  status: InboxStatus;
}
export interface InboxContext<TTx extends InboxTransaction = InboxTransaction> {
  tx: TTx;
  scope: InboxScope;
  messageId: string;
  source: string;
  consumer: string;
  inboxId: string;
  attempt: number;
  signal: AbortSignal;
  replay?: InboxRecord["replay"];
  correlationId?: string;
  causationId?: string;
}
export interface InboxHandler<
  TPayload = JsonValue,
  TTx extends InboxTransaction = InboxTransaction,
> {
  consumer: string;
  eventType: string;
  schemaVersion: number;
  /** Return false or throw to quarantine invalid payloads. Must be synchronous and side-effect free. */
  validate?: (payload: JsonValue) => boolean | void;
  handle(payload: TPayload, context: InboxContext<TTx>): Promise<void>;
}
/** Wrap handler execution inside its existing transaction, e.g. with tenant context. */
export type InboxHandlerContextRunner = (
  context: InboxContext,
  next: () => Promise<void>,
) => Promise<void>;
export interface InboxListOptions {
  status?: InboxStatus;
  consumer?: string;
  cursor?: string;
  limit?: number;
}
export interface InboxPage {
  records: InboxRecord[];
  nextCursor: string | null;
}
export interface InboxStats {
  counts: Record<InboxStatus, number>;
  oldestPendingAt: Date | null;
}
/** No payloads, tenant IDs, or raw exceptions are passed to observation hooks. */
export interface InboxObservation {
  type:
    | "accepted"
    | "duplicate"
    | "completed"
    | "retry"
    | "dead"
    | "lease_lost"
    | "error";
  consumer?: string;
  code?: string;
}
export interface InboxWorkerOptions {
  enabled?: boolean;
  consumers?: string[];
  concurrency?: number;
  pollIntervalMs?: number;
  leaseMs?: number;
  heartbeatIntervalMs?: number;
  transactionTimeoutMs?: number;
  transactionMaxWaitMs?: number;
  lockTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  maxAttempts?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
}
export interface InboxOptions {
  prisma: InboxPrismaClient;
  handlers?: InboxHandler<any, any>[];
  /** Accepted consumer names; defaults to registered handler names. Required for ingress-only apps. */
  consumers?: string[];
  worker?: InboxWorkerOptions;
  maxPayloadBytes?: number;
  /** Optional approximate admission limit; concurrently accepted messages may exceed it. */
  maxPendingMessages?: number;
  observer?: (event: InboxObservation) => void | Promise<void>;
  handlerContext?: InboxHandlerContextRunner;
  privilegedAdmin?: boolean;
}

export interface NormalizedEnvelope extends InboxEnvelope {
  payloadJson: string;
  fingerprint: string;
  fingerprintVersion: 1;
}
export interface ResolvedWorkerOptions {
  enabled: boolean;
  consumers: string[];
  concurrency: number;
  pollIntervalMs: number;
  leaseMs: number;
  heartbeatIntervalMs: number;
  transactionTimeoutMs: number;
  transactionMaxWaitMs: number;
  lockTimeoutMs: number;
  shutdownTimeoutMs: number;
  maxAttempts: number;
  retryBaseMs: number;
  retryMaxMs: number;
}
