-- Add completed-message replay lineage to an existing @nestarc/inbox v1 installation.
-- Run explicitly during deployment before starting the v2 application. Transactional
-- DDL preserves all receipts, fingerprints, processing state, and business writes.
BEGIN;

LOCK TABLE public.nestarc_inbox IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.nestarc_inbox_schema WHERE singleton = true AND version IN (1, 2)
  ) THEN
    RAISE EXCEPTION 'Expected inbox schema version 1 or 2';
  END IF;
END $$;

ALTER TABLE public.nestarc_inbox
  ADD COLUMN IF NOT EXISTS replay_of uuid,
  ADD COLUMN IF NOT EXISTS replay_request_id uuid,
  ADD COLUMN IF NOT EXISTS replay_source_version bigint,
  ADD COLUMN IF NOT EXISTS replay_actor text,
  ADD COLUMN IF NOT EXISTS replay_reason text,
  ADD COLUMN IF NOT EXISTS replayed_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid='public.nestarc_inbox'::regclass AND conname='nestarc_inbox_replay_request_key') THEN
    ALTER TABLE public.nestarc_inbox ADD CONSTRAINT nestarc_inbox_replay_request_key
      UNIQUE (scope_kind, scope_id, replay_request_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid='public.nestarc_inbox'::regclass AND conname='nestarc_inbox_replay_original_fk') THEN
    ALTER TABLE public.nestarc_inbox ADD CONSTRAINT nestarc_inbox_replay_original_fk
      FOREIGN KEY (replay_of) REFERENCES public.nestarc_inbox(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid='public.nestarc_inbox'::regclass AND conname='nestarc_inbox_replay_check') THEN
    ALTER TABLE public.nestarc_inbox ADD CONSTRAINT nestarc_inbox_replay_check CHECK (
      (replay_of IS NULL AND replay_request_id IS NULL AND replay_source_version IS NULL
        AND replay_actor IS NULL AND replay_reason IS NULL AND replayed_at IS NULL) OR
      (replay_of IS NOT NULL AND replay_of <> id AND replay_request_id IS NOT NULL
        AND replay_source_version IS NOT NULL AND replay_source_version > 0
        AND replay_actor IS NOT NULL AND octet_length(replay_actor) BETWEEN 1 AND 256
        AND replay_reason IS NOT NULL AND octet_length(replay_reason) BETWEEN 1 AND 1024
        AND replayed_at IS NOT NULL)
    );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS nestarc_inbox_replay_original_idx
  ON public.nestarc_inbox (replay_of) WHERE replay_of IS NOT NULL;
UPDATE public.nestarc_inbox_schema SET version=2 WHERE singleton=true;
COMMIT;
