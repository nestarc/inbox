-- Apply only to the dedicated local example database. The runtime role below
-- is provisioned separately by the runnable example and never owns these tables.
CREATE TABLE IF NOT EXISTS public.example_tenancy_records (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  inbox_id uuid NOT NULL,
  note text NOT NULL
);
CREATE INDEX IF NOT EXISTS example_tenancy_records_tenant_idx
  ON public.example_tenancy_records (tenant_id);
ALTER TABLE public.example_tenancy_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.example_tenancy_records FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.example_tenancy_records;
CREATE POLICY tenant_isolation ON public.example_tenancy_records
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), ''));
DROP POLICY IF EXISTS tenant_required ON public.example_tenancy_records;
CREATE POLICY tenant_required ON public.example_tenancy_records AS RESTRICTIVE
  USING (NULLIF(current_setting('app.current_tenant', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('app.current_tenant', true), '') IS NOT NULL);

-- Intentionally shared records have their own table and permissions.
CREATE TABLE IF NOT EXISTS public.example_tenancy_shared (
  id uuid PRIMARY KEY,
  inbox_id uuid NOT NULL
);
