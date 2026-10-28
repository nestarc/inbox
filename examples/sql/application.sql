CREATE TABLE IF NOT EXISTS inbox_example_orders (
  id text PRIMARY KEY,
  tenant_id text NOT NULL
);
CREATE TABLE IF NOT EXISTS inbox_example_projections (
  tenant_id text NOT NULL,
  order_id text NOT NULL,
  PRIMARY KEY (tenant_id, order_id)
);
CREATE TABLE IF NOT EXISTS inbox_example_receipts (
  tenant_id text NOT NULL,
  order_id text NOT NULL,
  PRIMARY KEY (tenant_id, order_id)
);
