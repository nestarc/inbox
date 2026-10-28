-- @nestarc/inbox schema version 2. Run explicitly with your application's migrations.
-- Existing version 1 installations must apply migrate-v1-to-v2.sql instead.
-- Runtime never creates or upgrades tables. Do not let Prisma db push remove these tables.
BEGIN;

CREATE TABLE IF NOT EXISTS public.nestarc_inbox_schema (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  version integer NOT NULL
);

CREATE TABLE IF NOT EXISTS public.nestarc_inbox (
  id uuid PRIMARY KEY,
  scope_kind text NOT NULL CHECK (scope_kind IN ('tenant', 'global')),
  scope_id text NOT NULL,
  source text NOT NULL CHECK (octet_length(source) BETWEEN 1 AND 128),
  consumer text NOT NULL CHECK (octet_length(consumer) BETWEEN 1 AND 128),
  message_id text NOT NULL CHECK (octet_length(message_id) BETWEEN 1 AND 256),
  event_type text NOT NULL CHECK (octet_length(event_type) BETWEEN 1 AND 128),
  schema_version integer NOT NULL CHECK (schema_version > 0),
  payload jsonb,
  payload_purged boolean NOT NULL DEFAULT false,
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  fingerprint_version integer NOT NULL CHECK (fingerprint_version = 1),
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'PROCESSING', 'RETRYABLE', 'COMPLETED', 'DEAD')),
  claim_token bigint NOT NULL DEFAULT 0 CHECK (claim_token >= 0),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  cycle_attempt_count integer NOT NULL DEFAULT 0 CHECK (cycle_attempt_count >= 0),
  requeue_count integer NOT NULL DEFAULT 0 CHECK (requeue_count >= 0),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_expires_at timestamptz,
  worker_id text,
  last_error_code text,
  last_error_message text,
  last_requeue_reason text,
  last_requeue_actor text,
  last_requeue_at timestamptz,
  correlation_id text,
  causation_id text,
  headers jsonb NOT NULL DEFAULT '{}'::jsonb,
  replay_of uuid,
  replay_request_id uuid,
  replay_source_version bigint,
  replay_actor text,
  replay_reason text,
  replayed_at timestamptz,
  CONSTRAINT nestarc_inbox_identity_key
    UNIQUE (scope_kind, scope_id, source, consumer, message_id),
  CONSTRAINT nestarc_inbox_replay_request_key
    UNIQUE (scope_kind, scope_id, replay_request_id),
  CONSTRAINT nestarc_inbox_replay_original_fk
    FOREIGN KEY (replay_of) REFERENCES public.nestarc_inbox(id),
  CONSTRAINT nestarc_inbox_replay_check CHECK (
    (replay_of IS NULL AND replay_request_id IS NULL AND replay_source_version IS NULL
      AND replay_actor IS NULL AND replay_reason IS NULL AND replayed_at IS NULL) OR
    (replay_of IS NOT NULL AND replay_of <> id AND replay_request_id IS NOT NULL
      AND replay_source_version IS NOT NULL AND replay_source_version > 0
      AND replay_actor IS NOT NULL AND octet_length(replay_actor) BETWEEN 1 AND 256
      AND replay_reason IS NOT NULL AND octet_length(replay_reason) BETWEEN 1 AND 1024
      AND replayed_at IS NOT NULL)
  ),
  CONSTRAINT nestarc_inbox_scope_check CHECK (
    (scope_kind = 'global' AND scope_id = '') OR
    (scope_kind = 'tenant' AND octet_length(scope_id) BETWEEN 1 AND 128)
  ),
  CONSTRAINT nestarc_inbox_payload_check CHECK (
    (payload_purged AND payload IS NULL AND status = 'COMPLETED') OR
    (NOT payload_purged AND payload IS NOT NULL)
  ),
  CONSTRAINT nestarc_inbox_lease_check CHECK (
    (status = 'PROCESSING' AND lease_expires_at IS NOT NULL AND worker_id IS NOT NULL) OR
    (status <> 'PROCESSING' AND lease_expires_at IS NULL AND worker_id IS NULL)
  ),
  CONSTRAINT nestarc_inbox_completion_check CHECK (
    (status = 'COMPLETED' AND completed_at IS NOT NULL) OR
    (status <> 'COMPLETED' AND completed_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS nestarc_inbox_due_idx
  ON public.nestarc_inbox (consumer, next_attempt_at, id)
  WHERE status IN ('PENDING', 'RETRYABLE');
CREATE INDEX IF NOT EXISTS nestarc_inbox_expired_idx
  ON public.nestarc_inbox (consumer, lease_expires_at, id)
  WHERE status = 'PROCESSING';
CREATE INDEX IF NOT EXISTS nestarc_inbox_scope_list_idx
  ON public.nestarc_inbox (scope_kind, scope_id, id);
CREATE INDEX IF NOT EXISTS nestarc_inbox_completed_payload_idx
  ON public.nestarc_inbox (completed_at, id)
  WHERE status = 'COMPLETED' AND NOT payload_purged;
CREATE INDEX IF NOT EXISTS nestarc_inbox_replay_original_idx
  ON public.nestarc_inbox (replay_of) WHERE replay_of IS NOT NULL;

INSERT INTO public.nestarc_inbox_schema (singleton, version)
VALUES (true, 2) ON CONFLICT (singleton) DO NOTHING;

COMMIT;
