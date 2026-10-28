import { randomUUID } from "node:crypto";
import {
  InboxBackpressureError,
  InboxConflictError,
  InboxLeaseLostError,
  InboxReplayConflictError,
  InboxSchemaError,
  InboxStateConflictError,
  InboxTimeoutError,
  InboxValidationError,
} from "../../contracts/errors";
import type {
  InboxReplayOptions,
  InboxReplayResult,
} from "../../inbox-admin.service";
import type {
  InboxEnvelope,
  InboxListOptions,
  InboxPage,
  InboxPrismaClient,
  InboxReceipt,
  InboxRecord,
  InboxScope,
  InboxStats,
  InboxStatus,
  InboxTransaction,
  JsonValue,
  NormalizedEnvelope,
} from "../../contracts/types";

type Row = {
  id: string;
  scope_kind: "tenant" | "global";
  scope_id: string;
  source: string;
  consumer: string;
  message_id: string;
  event_type: string;
  schema_version: number;
  payload: JsonValue;
  payload_purged: boolean;
  fingerprint: string;
  fingerprint_version: number;
  status: InboxStatus;
  claim_token: bigint | string;
  row_version: bigint | string;
  attempt_count: number;
  cycle_attempt_count: number;
  requeue_count: number;
  received_at: Date;
  completed_at: Date | null;
  next_attempt_at: Date;
  lease_expires_at: Date | null;
  worker_id: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  last_requeue_reason: string | null;
  last_requeue_actor: string | null;
  last_requeue_at: Date | null;
  correlation_id: string | null;
  causation_id: string | null;
  headers: InboxEnvelope["headers"];
  replay_of: string | null;
  replay_request_id: string | null;
  replay_source_version: bigint | string | null;
  replay_actor: string | null;
  replay_reason: string | null;
  replayed_at: Date | null;
};

const STATUSES: InboxStatus[] = [
  "PENDING",
  "PROCESSING",
  "RETRYABLE",
  "COMPLETED",
  "DEAD",
];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function record(row: Row): InboxRecord {
  return {
    id: row.id,
    scope:
      row.scope_kind === "global"
        ? { kind: "global" }
        : { kind: "tenant", id: row.scope_id },
    source: row.source,
    consumer: row.consumer,
    messageId: row.message_id,
    eventType: row.event_type,
    schemaVersion: row.schema_version,
    payload: row.payload,
    payloadPurged: row.payload_purged,
    fingerprint: row.fingerprint,
    fingerprintVersion: row.fingerprint_version,
    status: row.status,
    claimToken: String(row.claim_token),
    rowVersion: String(row.row_version),
    attemptCount: row.attempt_count,
    cycleAttemptCount: row.cycle_attempt_count,
    requeueCount: row.requeue_count,
    receivedAt: row.received_at,
    completedAt: row.completed_at,
    nextAttemptAt: row.next_attempt_at,
    leaseExpiresAt: row.lease_expires_at,
    workerId: row.worker_id,
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
    lastRequeueReason: row.last_requeue_reason,
    lastRequeueActor: row.last_requeue_actor,
    lastRequeueAt: row.last_requeue_at,
    ...(row.correlation_id === null
      ? {}
      : { correlationId: row.correlation_id }),
    ...(row.causation_id === null ? {} : { causationId: row.causation_id }),
    headers: row.headers,
    ...(row.replay_of === null || row.replay_of === undefined
      ? {}
      : {
          replay: {
            originalInboxId: row.replay_of,
            requestId: row.replay_request_id!,
            sourceVersion: String(row.replay_source_version),
            actor: row.replay_actor!,
            reason: row.replay_reason!,
            requestedAt: row.replayed_at!,
          },
        }),
  };
}

function scopeValues(scope?: InboxScope): [string | null, string | null] {
  return scope
    ? [scope.kind, scope.kind === "tenant" ? scope.id : ""]
    : [null, null];
}

/** Internal PostgreSQL implementation. Undefined scope is reserved for privileged administration. */
export class PrismaInboxStorage {
  constructor(
    private readonly prisma: InboxPrismaClient,
    private readonly options: { maxPendingMessages?: number } = {},
  ) {}

  async assertSchema(): Promise<void> {
    try {
      const versions = await this.prisma.$queryRawUnsafe<{ version: number }[]>(
        "SELECT version FROM public.nestarc_inbox_schema WHERE singleton = true",
      );
      if (versions.length !== 1 || versions[0]?.version !== 2)
        throw new InboxSchemaError();
      // Reading the complete projection detects incomplete/old migrations without modifying schema.
      await this.prisma
        .$queryRawUnsafe(`SELECT id, scope_kind, scope_id, source, consumer,
        message_id, event_type, schema_version, payload, payload_purged, fingerprint,
        fingerprint_version, status, claim_token, row_version, attempt_count,
        cycle_attempt_count, requeue_count, received_at, completed_at, next_attempt_at,
        lease_expires_at, worker_id, last_error_code, last_error_message, last_requeue_reason,
        last_requeue_actor, last_requeue_at, correlation_id, causation_id, headers,
        replay_of, replay_request_id, replay_source_version, replay_actor, replay_reason, replayed_at
        FROM public.nestarc_inbox LIMIT 0`);
      const constraints = await this.prisma.$queryRawUnsafe<
        { valid: boolean }[]
      >(`
        SELECT EXISTS (
          SELECT 1 FROM pg_constraint c
          WHERE c.conrelid = 'public.nestarc_inbox'::regclass
            AND c.contype = 'u' AND NOT c.condeferrable
            AND ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(attnum, n)
              JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum ORDER BY k.n)
              = ARRAY['scope_kind','scope_id','source','consumer','message_id']::text[]
        ) AS valid`);
      if (!constraints[0]?.valid) throw new InboxSchemaError();
      const replayConstraints = await this.prisma.$queryRawUnsafe<
        { valid: boolean }[]
      >(`
        SELECT EXISTS (
          SELECT 1 FROM pg_constraint c
          WHERE c.conrelid = 'public.nestarc_inbox'::regclass
            AND c.contype = 'u' AND NOT c.condeferrable
            AND ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(attnum, n)
              JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum ORDER BY k.n)
              = ARRAY['scope_kind','scope_id','replay_request_id']::text[]
        ) AND EXISTS (
          SELECT 1 FROM pg_constraint WHERE conrelid='public.nestarc_inbox'::regclass
            AND conname='nestarc_inbox_replay_check' AND contype='c' AND convalidated
        ) AND EXISTS (
          SELECT 1 FROM pg_constraint WHERE conrelid='public.nestarc_inbox'::regclass
            AND conname='nestarc_inbox_replay_original_fk' AND contype='f' AND convalidated
            AND confrelid='public.nestarc_inbox'::regclass
        ) AS valid`);
      if (!replayConstraints[0]?.valid) throw new InboxSchemaError();
    } catch {
      throw new InboxSchemaError();
    }
  }

  async accept(envelope: NormalizedEnvelope): Promise<InboxReceipt> {
    const identity = [
      envelope.scope.kind,
      envelope.scope.kind === "tenant" ? envelope.scope.id : "",
      envelope.source,
      envelope.consumer,
      envelope.messageId,
    ];
    return this.prisma.$transaction(
      async (tx) => {
        const inserted = await tx.$queryRawUnsafe<Row[]>(
          `INSERT INTO public.nestarc_inbox
        (id,scope_kind,scope_id,source,consumer,message_id,event_type,schema_version,payload,
         fingerprint,fingerprint_version,correlation_id,causation_id,headers)
        VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8::integer,$9::jsonb,$10,$11::integer,$12,$13,$14::jsonb)
        ON CONFLICT (scope_kind,scope_id,source,consumer,message_id) DO NOTHING RETURNING *`,
          randomUUID(),
          ...identity,
          envelope.eventType,
          envelope.schemaVersion,
          envelope.payloadJson,
          envelope.fingerprint,
          envelope.fingerprintVersion,
          envelope.correlationId ?? null,
          envelope.causationId ?? null,
          JSON.stringify(envelope.headers ?? {}),
        );
        if (inserted[0]) {
          // Admission applies only to new records. A duplicate must still succeed at capacity.
          // Counting our uncommitted row makes rejection roll back this insertion, never an ACK.
          if (this.options.maxPendingMessages !== undefined) {
            const count = await tx.$queryRawUnsafe<{ full: boolean }[]>(
              `SELECT count(*) > $1::integer AS full
            FROM (SELECT 1 FROM public.nestarc_inbox
              WHERE status IN ('PENDING','PROCESSING','RETRYABLE') LIMIT ($1::bigint + 1)) pending`,
              this.options.maxPendingMessages,
            );
            if (count[0]?.full) throw new InboxBackpressureError();
          }
          return {
            kind: "accepted" as const,
            id: inserted[0].id,
            status: inserted[0].status,
          };
        }
        // Separate READ COMMITTED statement sees a concurrent winner after ON CONFLICT waits for it.
        const winner = await tx.$queryRawUnsafe<Row[]>(
          `SELECT * FROM public.nestarc_inbox
        WHERE scope_kind=$1 AND scope_id=$2 AND source=$3 AND consumer=$4 AND message_id=$5`,
          ...identity,
        );
        if (!winner[0]) throw new InboxStateConflictError();
        return this.duplicate(winner[0], envelope);
      },
      { isolationLevel: "ReadCommitted", timeout: 10_000, maxWait: 5_000 },
    );
  }

  private duplicate(row: Row, envelope: NormalizedEnvelope): InboxReceipt {
    if (
      row.fingerprint !== envelope.fingerprint ||
      row.fingerprint_version !== envelope.fingerprintVersion
    ) {
      throw new InboxConflictError();
    }
    return { kind: "duplicate", id: row.id, status: row.status };
  }

  async claim(
    consumers: string[],
    limit: number,
    workerId: string,
    leaseMs: number,
    maxAttempts: number,
  ): Promise<InboxRecord[]> {
    if (consumers.length === 0 || limit < 1) return [];
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(
          `WITH exhausted AS (
        SELECT id FROM public.nestarc_inbox WHERE consumer = ANY($1::text[])
          AND cycle_attempt_count >= $2::integer
          AND ((status = 'PROCESSING' AND lease_expires_at <= clock_timestamp())
            OR (status IN ('PENDING','RETRYABLE') AND next_attempt_at <= clock_timestamp()))
        ORDER BY next_attempt_at,id LIMIT $3::integer FOR UPDATE SKIP LOCKED
      ) UPDATE public.nestarc_inbox i SET status='DEAD',lease_expires_at=NULL,worker_id=NULL,
        last_error_code='ATTEMPTS_EXHAUSTED',last_error_message='The processing attempt limit was reached.',
        row_version=i.row_version+1 FROM exhausted e WHERE i.id=e.id`,
          consumers,
          maxAttempts,
          Math.min(1000, Math.max(limit, 100)),
        );
        const rows = await tx.$queryRawUnsafe<Row[]>(
          `WITH candidates AS (
        SELECT id FROM public.nestarc_inbox WHERE consumer = ANY($1::text[])
          AND cycle_attempt_count < $2::integer
          AND ((status IN ('PENDING','RETRYABLE') AND next_attempt_at <= clock_timestamp())
            OR (status='PROCESSING' AND lease_expires_at <= clock_timestamp()))
        ORDER BY next_attempt_at,id LIMIT $3::integer FOR UPDATE SKIP LOCKED
      ) UPDATE public.nestarc_inbox i SET status='PROCESSING',claim_token=i.claim_token+1,
        row_version=i.row_version+1,attempt_count=i.attempt_count+1,
        cycle_attempt_count=i.cycle_attempt_count+1,worker_id=$4,
        lease_expires_at=clock_timestamp()+($5::double precision * interval '1 millisecond')
        FROM candidates c WHERE i.id=c.id RETURNING i.*`,
          consumers,
          maxAttempts,
          limit,
          workerId,
          leaseMs,
        );
        return rows.map(record);
      },
      { isolationLevel: "ReadCommitted", timeout: 10_000, maxWait: 5_000 },
    );
  }

  async run(
    claimed: InboxRecord,
    fn: (tx: InboxTransaction) => Promise<void>,
    options: { timeoutMs: number; maxWaitMs: number; lockTimeoutMs: number },
  ): Promise<void> {
    await this.prisma.$transaction(
      async (tx) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new InboxTimeoutError()),
            options.timeoutMs,
          );
        });
        const work = async () => {
          await tx.$queryRawUnsafe(
            `SELECT
          set_config('statement_timeout',$1,true),
          set_config('idle_in_transaction_session_timeout',$1,true),
          set_config('lock_timeout',$2,true)`,
            `${options.timeoutMs}ms`,
            `${options.lockTimeoutMs}ms`,
          );
          await fn(tx);
          const changed = await tx.$executeRawUnsafe(
            `UPDATE public.nestarc_inbox
          SET status='COMPLETED',completed_at=clock_timestamp(),lease_expires_at=NULL,worker_id=NULL,
            row_version=row_version+1,last_error_code=NULL,last_error_message=NULL
          WHERE id=$1::uuid AND status='PROCESSING' AND claim_token=$2::bigint
            AND lease_expires_at > clock_timestamp()`,
            claimed.id,
            claimed.claimToken,
          );
          if (changed !== 1) throw new InboxLeaseLostError();
        };
        try {
          // Rejection returns from the interactive transaction, closing it before late callback writes.
          await Promise.race([work(), deadline]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      },
      {
        isolationLevel: "ReadCommitted",
        timeout: options.timeoutMs,
        maxWait: options.maxWaitMs,
      },
    );
  }

  async heartbeat(
    id: string,
    token: string,
    leaseMs: number,
  ): Promise<boolean> {
    return (
      (await this.prisma.$executeRawUnsafe(
        `UPDATE public.nestarc_inbox
      SET lease_expires_at=clock_timestamp()+($3::double precision * interval '1 millisecond')
      WHERE id=$1::uuid AND claim_token=$2::bigint AND status='PROCESSING'
        AND lease_expires_at > clock_timestamp()`,
        id,
        token,
        leaseMs,
      )) === 1
    );
  }

  async fail(
    id: string,
    token: string,
    error: { code: string; message: string },
    permanent: boolean,
    delayMs: number,
    maxAttempts: number,
  ): Promise<boolean> {
    return (
      (await this.prisma.$executeRawUnsafe(
        `UPDATE public.nestarc_inbox
      SET status=CASE WHEN $3::boolean OR cycle_attempt_count >= $4::integer THEN 'DEAD' ELSE 'RETRYABLE' END,
        next_attempt_at=clock_timestamp()+($5::double precision * interval '1 millisecond'),
        lease_expires_at=NULL,worker_id=NULL,row_version=row_version+1,
        last_error_code=$6,last_error_message=$7
      WHERE id=$1::uuid AND claim_token=$2::bigint AND status='PROCESSING'
        AND lease_expires_at > clock_timestamp()`,
        id,
        token,
        permanent,
        maxAttempts,
        delayMs,
        error.code,
        error.message,
      )) === 1
    );
  }

  async get(id: string, scope?: InboxScope): Promise<InboxRecord | null> {
    const rows = await this.prisma.$queryRawUnsafe<Row[]>(
      `SELECT * FROM public.nestarc_inbox
      WHERE id=$1::uuid AND ($2::text IS NULL OR (scope_kind=$2 AND scope_id=$3))`,
      id,
      ...scopeValues(scope),
    );
    return rows[0] ? record(rows[0]) : null;
  }

  async list(
    options: InboxListOptions = {},
    scope?: InboxScope,
  ): Promise<InboxPage> {
    const limit = options.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
      throw new InboxValidationError("List limit must be between 1 and 1000.");
    if (options.cursor !== undefined && !UUID.test(options.cursor))
      throw new InboxValidationError("Invalid inbox cursor.");
    if (options.status !== undefined && !STATUSES.includes(options.status))
      throw new InboxValidationError("Invalid inbox status.");
    const rows = await this.prisma.$queryRawUnsafe<Row[]>(
      `SELECT * FROM public.nestarc_inbox
      WHERE ($1::text IS NULL OR (scope_kind=$1 AND scope_id=$2))
        AND ($3::text IS NULL OR status=$3) AND ($4::text IS NULL OR consumer=$4)
        AND ($5::uuid IS NULL OR id > $5::uuid)
      ORDER BY id LIMIT $6::integer`,
      ...scopeValues(scope),
      options.status ?? null,
      options.consumer ?? null,
      options.cursor ?? null,
      limit + 1,
    );
    const page = rows.slice(0, limit);
    return {
      records: page.map(record),
      nextCursor: rows.length > limit ? page[page.length - 1]!.id : null,
    };
  }

  async requeue(
    id: string,
    scope: InboxScope | undefined,
    expectedVersion: string,
    reason: string,
    actor: string,
  ): Promise<InboxRecord> {
    const rows = await this.prisma.$queryRawUnsafe<Row[]>(
      `UPDATE public.nestarc_inbox
      SET status='PENDING',cycle_attempt_count=0,requeue_count=requeue_count+1,
        next_attempt_at=clock_timestamp(),row_version=row_version+1,
        last_requeue_reason=$5,last_requeue_actor=$6,last_requeue_at=clock_timestamp()
      WHERE id=$1::uuid AND ($2::text IS NULL OR (scope_kind=$2 AND scope_id=$3))
        AND status='DEAD' AND row_version=$4::bigint RETURNING *`,
      id,
      ...scopeValues(scope),
      expectedVersion,
      reason,
      actor,
    );
    if (!rows[0]) throw new InboxStateConflictError();
    return record(rows[0]);
  }

  async replay(
    options: InboxReplayOptions,
    scope?: InboxScope,
  ): Promise<InboxReplayResult> {
    return this.prisma.$transaction(
      async (tx) => {
        // Serialize replay admission against cleanup and other requests for this original.
        const originals = await tx.$queryRawUnsafe<Row[]>(
          `SELECT * FROM public.nestarc_inbox
        WHERE id=$1::uuid AND ($2::text IS NULL OR (scope_kind=$2 AND scope_id=$3)) FOR UPDATE`,
          options.id,
          ...scopeValues(scope),
        );
        const original = originals[0];
        if (!original) throw new InboxStateConflictError();
        const existing = async () =>
          (
            await tx.$queryRawUnsafe<Row[]>(
              `SELECT * FROM public.nestarc_inbox
        WHERE scope_kind=$1 AND scope_id=$2 AND replay_request_id=$3::uuid`,
              original.scope_kind,
              original.scope_id,
              options.requestId,
            )
          )[0];
        const duplicate = (row: Row): InboxReplayResult => {
          if (
            row.replay_of !== original.id ||
            row.consumer !== options.targetConsumer ||
            String(row.replay_source_version) !== options.expectedVersion ||
            row.replay_actor !== options.actor ||
            row.replay_reason !== options.reason
          )
            throw new InboxReplayConflictError();
          return { kind: "duplicate", record: record(row) };
        };
        // Return an already committed request even if cleanup advanced the source version.
        const prior = await existing();
        if (prior) return duplicate(prior);
        if (
          original.status !== "COMPLETED" ||
          original.payload_purged ||
          String(original.row_version) !== options.expectedVersion
        )
          throw new InboxStateConflictError();
        const rows = await tx.$queryRawUnsafe<Row[]>(
          `INSERT INTO public.nestarc_inbox
        (id,scope_kind,scope_id,source,consumer,message_id,event_type,schema_version,payload,
          fingerprint,fingerprint_version,correlation_id,causation_id,headers,
          replay_of,replay_request_id,replay_source_version,replay_actor,replay_reason,replayed_at)
        VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8::integer,$9::jsonb,$10,$11::integer,$12,$13,$14::jsonb,
          $15::uuid,$16::uuid,$17::bigint,$18,$19,clock_timestamp())
        ON CONFLICT DO NOTHING RETURNING *`,
          randomUUID(),
          original.scope_kind,
          original.scope_id,
          original.source,
          options.targetConsumer,
          `replay:${original.id}:${options.requestId}`,
          original.event_type,
          original.schema_version,
          JSON.stringify(original.payload),
          original.fingerprint,
          original.fingerprint_version,
          original.correlation_id,
          original.causation_id,
          JSON.stringify(original.headers ?? {}),
          original.id,
          options.requestId,
          options.expectedVersion,
          options.actor,
          options.reason,
        );
        if (!rows[0]) {
          const winner = await existing();
          if (winner) return duplicate(winner);
          // An externally accepted message occupied the synthetic delivery identity.
          throw new InboxReplayConflictError();
        }
        if (this.options.maxPendingMessages !== undefined) {
          const count = await tx.$queryRawUnsafe<{ full: boolean }[]>(
            `SELECT count(*) > $1::integer AS full FROM (SELECT 1 FROM public.nestarc_inbox
            WHERE status IN ('PENDING','PROCESSING','RETRYABLE') LIMIT ($1::bigint + 1)) pending`,
            this.options.maxPendingMessages,
          );
          if (count[0]?.full) throw new InboxBackpressureError();
        }
        return { kind: "accepted", record: record(rows[0]) };
      },
      { isolationLevel: "ReadCommitted", timeout: 10_000, maxWait: 5_000 },
    );
  }

  async stats(scope?: InboxScope): Promise<InboxStats> {
    const rows = await this.prisma.$queryRawUnsafe<
      { status: InboxStatus; count: bigint | string; oldest: Date | null }[]
    >(
      `
      SELECT status,count(*) AS count,min(received_at) AS oldest FROM public.nestarc_inbox
      WHERE ($1::text IS NULL OR (scope_kind=$1 AND scope_id=$2)) GROUP BY status`,
      ...scopeValues(scope),
    );
    const counts: InboxStats["counts"] = {
      PENDING: 0,
      PROCESSING: 0,
      RETRYABLE: 0,
      COMPLETED: 0,
      DEAD: 0,
    };
    let oldestPendingAt: Date | null = null;
    for (const row of rows) {
      counts[row.status] = Number(row.count);
      if (
        ["PENDING", "PROCESSING", "RETRYABLE"].includes(row.status) &&
        row.oldest &&
        (!oldestPendingAt || row.oldest < oldestPendingAt)
      )
        oldestPendingAt = row.oldest;
    }
    return { counts, oldestPendingAt };
  }

  async purgeCompletedPayload(
    before: Date,
    limit: number,
    scope?: InboxScope,
  ): Promise<number> {
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 1000 ||
      !Number.isFinite(before.getTime())
    ) {
      throw new InboxValidationError(
        "Payload cleanup requires a valid date and a limit between 1 and 1000.",
      );
    }
    return this.prisma.$executeRawUnsafe(
      `WITH candidates AS (
      SELECT id FROM public.nestarc_inbox WHERE status='COMPLETED' AND NOT payload_purged
        AND completed_at < $1::timestamptz AND ($2::text IS NULL OR (scope_kind=$2 AND scope_id=$3))
      ORDER BY completed_at,id LIMIT $4::integer FOR UPDATE SKIP LOCKED
    ) UPDATE public.nestarc_inbox i SET payload=NULL,payload_purged=true,row_version=i.row_version+1
      FROM candidates c WHERE i.id=c.id`,
      before,
      ...scopeValues(scope),
      limit,
    );
  }
}
