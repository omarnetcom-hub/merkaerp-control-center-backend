CREATE TABLE tenants (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE companies (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  tax_id TEXT,
  country TEXT NOT NULL DEFAULT 'Colombia',
  currency TEXT NOT NULL DEFAULT 'COP',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE branches (
  id UUID PRIMARY KEY,
  company_id UUID NOT NULL REFERENCES companies(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  UNIQUE(company_id, code)
);

CREATE TABLE sync_events (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  company_id UUID NOT NULL REFERENCES companies(id),
  branch_id UUID REFERENCES branches(id),
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  vector_clock_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sync_conflicts (
  id UUID PRIMARY KEY,
  company_id UUID NOT NULL REFERENCES companies(id),
  branch_id UUID REFERENCES branches(id),
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  local_payload_json JSONB NOT NULL,
  remote_payload_json JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

CREATE TABLE event_store (
  id BIGSERIAL PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  company_id UUID NOT NULL REFERENCES companies(id),
  branch_id UUID REFERENCES branches(id),
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  name TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  payload_json JSONB NOT NULL,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key TEXT NOT NULL UNIQUE,
  correlation_id TEXT,
  causation_id TEXT,
  trace_id TEXT,
  occurred_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE event_dispatch_queue (
  id BIGSERIAL PRIMARY KEY,
  event_sequence BIGINT NOT NULL REFERENCES event_store(id),
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  dispatched_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE event_dead_letters (
  id BIGSERIAL PRIMARY KEY,
  event_sequence BIGINT REFERENCES event_store(id),
  error TEXT NOT NULL,
  payload_json JSONB,
  failed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE cqrs_projection_offsets (
  projection_name TEXT NOT NULL,
  company_id UUID NOT NULL REFERENCES companies(id),
  branch_id UUID REFERENCES branches(id),
  last_sequence BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(projection_name, company_id, branch_id)
);

CREATE TABLE executive_kpi_read_model (
  company_id UUID NOT NULL REFERENCES companies(id),
  branch_id UUID REFERENCES branches(id),
  metric_key TEXT NOT NULL,
  metric_value NUMERIC(18, 4) NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id, branch_id, metric_key)
);

CREATE TABLE accounting_journal_entries (
  id TEXT PRIMARY KEY,
  company_id UUID NOT NULL REFERENCES companies(id),
  branch_id UUID REFERENCES branches(id),
  consecutive TEXT NOT NULL,
  entry_date TIMESTAMPTZ NOT NULL,
  concept TEXT NOT NULL,
  reference TEXT,
  origin TEXT NOT NULL,
  status TEXT NOT NULL,
  reversed_entry_id TEXT,
  correlation_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(company_id, consecutive)
);

CREATE TABLE accounting_journal_lines (
  id BIGSERIAL PRIMARY KEY,
  entry_id TEXT NOT NULL REFERENCES accounting_journal_entries(id),
  company_id UUID NOT NULL REFERENCES companies(id),
  branch_id UUID REFERENCES branches(id),
  warehouse_id UUID,
  cost_center_id UUID,
  account_code TEXT NOT NULL,
  description TEXT,
  debit NUMERIC(18, 4) NOT NULL DEFAULT 0,
  credit NUMERIC(18, 4) NOT NULL DEFAULT 0,
  local_debit NUMERIC(18, 4) NOT NULL DEFAULT 0,
  local_credit NUMERIC(18, 4) NOT NULL DEFAULT 0,
  third_party TEXT,
  currency TEXT NOT NULL DEFAULT 'COP',
  exchange_rate NUMERIC(18, 8) NOT NULL DEFAULT 1
);

CREATE TABLE inventory_lots (
  id TEXT PRIMARY KEY,
  company_id UUID NOT NULL REFERENCES companies(id),
  branch_id UUID REFERENCES branches(id),
  warehouse_id UUID,
  product_id TEXT NOT NULL,
  quantity NUMERIC(18, 4) NOT NULL,
  unit_cost NUMERIC(18, 4) NOT NULL DEFAULT 0,
  batch_number TEXT,
  serial_number TEXT,
  received_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ
);

CREATE TABLE inventory_reservations (
  id TEXT PRIMARY KEY,
  company_id UUID NOT NULL REFERENCES companies(id),
  branch_id UUID REFERENCES branches(id),
  warehouse_id UUID,
  product_id TEXT NOT NULL,
  quantity NUMERIC(18, 4) NOT NULL,
  document_type TEXT NOT NULL,
  document_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_at TIMESTAMPTZ
);

CREATE TABLE sales_documents (
  id BIGSERIAL PRIMARY KEY,
  company_id UUID NOT NULL REFERENCES companies(id),
  branch_id UUID NOT NULL REFERENCES branches(id),
  warehouse_id UUID,
  cost_center_id UUID,
  type TEXT NOT NULL,
  state TEXT NOT NULL,
  customer_id TEXT,
  customer TEXT NOT NULL,
  issue_date TIMESTAMPTZ NOT NULL,
  due_date TIMESTAMPTZ NOT NULL,
  payment_method TEXT NOT NULL,
  credit_days INTEGER NOT NULL DEFAULT 0,
  subtotal NUMERIC(18, 4) NOT NULL DEFAULT 0,
  discount_total NUMERIC(18, 4) NOT NULL DEFAULT 0,
  tax_total NUMERIC(18, 4) NOT NULL DEFAULT 0,
  total NUMERIC(18, 4) NOT NULL DEFAULT 0,
  approved_by TEXT,
  posted_at TIMESTAMPTZ,
  reversed_document_id BIGINT REFERENCES sales_documents(id),
  correlation_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sales_document_lines (
  id BIGSERIAL PRIMARY KEY,
  document_id BIGINT NOT NULL REFERENCES sales_documents(id),
  company_id UUID NOT NULL REFERENCES companies(id),
  branch_id UUID NOT NULL REFERENCES branches(id),
  warehouse_id UUID,
  cost_center_id UUID,
  product_id TEXT NOT NULL,
  product TEXT NOT NULL,
  quantity NUMERIC(18, 4) NOT NULL,
  unit_price NUMERIC(18, 4) NOT NULL,
  discount NUMERIC(18, 4) NOT NULL DEFAULT 0,
  tax_rate NUMERIC(9, 4) NOT NULL DEFAULT 0,
  tax_total NUMERIC(18, 4) NOT NULL DEFAULT 0,
  subtotal NUMERIC(18, 4) NOT NULL DEFAULT 0,
  total NUMERIC(18, 4) NOT NULL DEFAULT 0
);

CREATE TABLE sales_document_audit (
  id BIGSERIAL PRIMARY KEY,
  company_id UUID NOT NULL REFERENCES companies(id),
  branch_id UUID REFERENCES branches(id),
  document_id BIGINT NOT NULL REFERENCES sales_documents(id),
  action TEXT NOT NULL,
  user_id TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sales_analytics_read_model (
  id BIGSERIAL PRIMARY KEY,
  company_id UUID NOT NULL REFERENCES companies(id),
  branch_id UUID REFERENCES branches(id),
  document_id TEXT NOT NULL,
  event_name TEXT NOT NULL,
  revenue NUMERIC(18, 4) NOT NULL DEFAULT 0,
  tax NUMERIC(18, 4) NOT NULL DEFAULT 0,
  occurred_at TIMESTAMPTZ NOT NULL,
  correlation_id TEXT
);

CREATE TABLE purchase_documents (
  id BIGSERIAL PRIMARY KEY,
  company_id UUID NOT NULL REFERENCES companies(id),
  branch_id UUID NOT NULL REFERENCES branches(id),
  warehouse_id UUID,
  cost_center_id UUID,
  type TEXT NOT NULL,
  state TEXT NOT NULL,
  supplier_id TEXT NOT NULL,
  supplier TEXT NOT NULL,
  issue_date TIMESTAMPTZ NOT NULL,
  due_date TIMESTAMPTZ NOT NULL,
  country TEXT NOT NULL DEFAULT 'Colombia',
  budget_code TEXT,
  budget_available NUMERIC(18, 4) NOT NULL DEFAULT 0,
  subtotal NUMERIC(18, 4) NOT NULL DEFAULT 0,
  tax_total NUMERIC(18, 4) NOT NULL DEFAULT 0,
  retention_total NUMERIC(18, 4) NOT NULL DEFAULT 0,
  total NUMERIC(18, 4) NOT NULL DEFAULT 0,
  approved_by TEXT,
  posted_at TIMESTAMPTZ,
  reversed_document_id BIGINT REFERENCES purchase_documents(id),
  correlation_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE purchase_document_lines (
  id BIGSERIAL PRIMARY KEY,
  document_id BIGINT NOT NULL REFERENCES purchase_documents(id),
  company_id UUID NOT NULL REFERENCES companies(id),
  branch_id UUID NOT NULL REFERENCES branches(id),
  warehouse_id UUID,
  cost_center_id UUID,
  product_id TEXT NOT NULL,
  product TEXT NOT NULL,
  quantity NUMERIC(18, 4) NOT NULL,
  received_quantity NUMERIC(18, 4) NOT NULL DEFAULT 0,
  unit_cost NUMERIC(18, 4) NOT NULL,
  tax_code TEXT NOT NULL DEFAULT 'EXEMPT',
  tax_rate NUMERIC(9, 4) NOT NULL DEFAULT 0,
  retention_rate NUMERIC(9, 4) NOT NULL DEFAULT 0,
  tax_total NUMERIC(18, 4) NOT NULL DEFAULT 0,
  retention_total NUMERIC(18, 4) NOT NULL DEFAULT 0,
  subtotal NUMERIC(18, 4) NOT NULL DEFAULT 0,
  total NUMERIC(18, 4) NOT NULL DEFAULT 0
);

CREATE TABLE purchase_approval_steps (
  id BIGSERIAL PRIMARY KEY,
  document_id BIGINT NOT NULL REFERENCES purchase_documents(id),
  company_id UUID NOT NULL REFERENCES companies(id),
  branch_id UUID REFERENCES branches(id),
  level INTEGER NOT NULL,
  approver_role TEXT NOT NULL,
  sla_hours INTEGER NOT NULL DEFAULT 24,
  approved_by TEXT,
  approved_at TIMESTAMPTZ,
  escalated_to TEXT
);

CREATE TABLE purchase_document_audit (
  id BIGSERIAL PRIMARY KEY,
  company_id UUID NOT NULL REFERENCES companies(id),
  branch_id UUID REFERENCES branches(id),
  document_id BIGINT NOT NULL REFERENCES purchase_documents(id),
  action TEXT NOT NULL,
  user_id TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE supplier_balances (
  company_id UUID NOT NULL REFERENCES companies(id),
  branch_id UUID NOT NULL REFERENCES branches(id),
  supplier_id TEXT NOT NULL,
  supplier TEXT NOT NULL,
  balance NUMERIC(18, 4) NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id, branch_id, supplier_id)
);

CREATE TABLE purchase_analytics_read_model (
  id BIGSERIAL PRIMARY KEY,
  company_id UUID NOT NULL REFERENCES companies(id),
  branch_id UUID REFERENCES branches(id),
  document_id TEXT NOT NULL,
  event_name TEXT NOT NULL,
  spend NUMERIC(18, 4) NOT NULL DEFAULT 0,
  tax NUMERIC(18, 4) NOT NULL DEFAULT 0,
  retention NUMERIC(18, 4) NOT NULL DEFAULT 0,
  occurred_at TIMESTAMPTZ NOT NULL,
  correlation_id TEXT
);

CREATE TABLE enterprise_audit_log (
  id BIGSERIAL PRIMARY KEY,
  company_id UUID NOT NULL REFERENCES companies(id),
  branch_id UUID REFERENCES branches(id),
  warehouse_id UUID,
  cost_center_id UUID,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id BIGINT,
  user_id TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE customer_credit_profiles (
  id BIGSERIAL PRIMARY KEY,
  company_id UUID NOT NULL REFERENCES companies(id),
  branch_id UUID REFERENCES branches(id),
  warehouse_id UUID,
  cost_center_id UUID,
  customer_id TEXT NOT NULL,
  credit_limit NUMERIC(18, 4) NOT NULL DEFAULT 0,
  balance NUMERIC(18, 4) NOT NULL DEFAULT 0,
  risk_score NUMERIC(9, 4) NOT NULL DEFAULT 0,
  blocked BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(company_id, branch_id, customer_id)
);

CREATE TABLE ar_ledger_entries (
  id BIGSERIAL PRIMARY KEY,
  company_id UUID NOT NULL REFERENCES companies(id),
  branch_id UUID REFERENCES branches(id),
  warehouse_id UUID,
  cost_center_id UUID,
  customer_id TEXT NOT NULL,
  customer TEXT NOT NULL,
  document_id TEXT NOT NULL,
  document_type TEXT NOT NULL,
  side TEXT NOT NULL,
  amount NUMERIC(18, 4) NOT NULL,
  open_amount NUMERIC(18, 4) NOT NULL DEFAULT 0,
  due_date TIMESTAMPTZ NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  description TEXT
);

CREATE TABLE ar_payment_promises (
  id BIGSERIAL PRIMARY KEY,
  company_id UUID NOT NULL REFERENCES companies(id),
  branch_id UUID REFERENCES branches(id),
  warehouse_id UUID,
  cost_center_id UUID,
  customer_id TEXT NOT NULL,
  customer TEXT NOT NULL,
  amount NUMERIC(18, 4) NOT NULL,
  promise_date TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ap_supplier_ledger (
  id BIGSERIAL PRIMARY KEY,
  company_id UUID NOT NULL REFERENCES companies(id),
  branch_id UUID REFERENCES branches(id),
  warehouse_id UUID,
  cost_center_id UUID,
  supplier_id TEXT NOT NULL,
  supplier TEXT NOT NULL,
  document_id TEXT NOT NULL,
  document_type TEXT NOT NULL,
  side TEXT NOT NULL,
  amount NUMERIC(18, 4) NOT NULL,
  open_amount NUMERIC(18, 4) NOT NULL DEFAULT 0,
  due_date TIMESTAMPTZ NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  description TEXT
);

CREATE TABLE ap_payment_schedules (
  id TEXT PRIMARY KEY,
  company_id UUID NOT NULL REFERENCES companies(id),
  branch_id UUID REFERENCES branches(id),
  warehouse_id UUID,
  cost_center_id UUID,
  party_id TEXT NOT NULL,
  party TEXT NOT NULL,
  amount NUMERIC(18, 4) NOT NULL,
  due_date TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL,
  source_document_id TEXT,
  payload_json JSONB
);

CREATE TABLE treasury_bank_accounts (
  id BIGSERIAL PRIMARY KEY,
  company_id UUID NOT NULL REFERENCES companies(id),
  branch_id UUID REFERENCES branches(id),
  warehouse_id UUID,
  cost_center_id UUID,
  name TEXT NOT NULL,
  bank_name TEXT NOT NULL,
  account_number TEXT,
  currency TEXT NOT NULL DEFAULT 'COP',
  balance NUMERIC(18, 4) NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE treasury_transfers (
  id TEXT PRIMARY KEY,
  company_id UUID NOT NULL REFERENCES companies(id),
  branch_id UUID REFERENCES branches(id),
  warehouse_id UUID,
  cost_center_id UUID,
  from_account_id BIGINT NOT NULL REFERENCES treasury_bank_accounts(id),
  to_account_id BIGINT NOT NULL REFERENCES treasury_bank_accounts(id),
  amount NUMERIC(18, 4) NOT NULL,
  requested_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  approved BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE treasury_bank_movements (
  id BIGSERIAL PRIMARY KEY,
  company_id UUID NOT NULL REFERENCES companies(id),
  branch_id UUID REFERENCES branches(id),
  warehouse_id UUID,
  cost_center_id UUID,
  bank_account_id BIGINT NOT NULL REFERENCES treasury_bank_accounts(id),
  direction TEXT NOT NULL,
  amount NUMERIC(18, 4) NOT NULL,
  reference TEXT NOT NULL,
  movement_date TIMESTAMPTZ NOT NULL,
  reconciled BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE bank_statements (
  id BIGSERIAL PRIMARY KEY,
  company_id UUID NOT NULL REFERENCES companies(id),
  branch_id UUID REFERENCES branches(id),
  warehouse_id UUID,
  cost_center_id UUID,
  statement_id TEXT NOT NULL,
  bank_account_id BIGINT NOT NULL REFERENCES treasury_bank_accounts(id),
  statement_date TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE bank_statement_lines (
  id BIGSERIAL PRIMARY KEY,
  company_id UUID NOT NULL REFERENCES companies(id),
  branch_id UUID REFERENCES branches(id),
  warehouse_id UUID,
  cost_center_id UUID,
  statement_id TEXT NOT NULL,
  bank_account_id BIGINT NOT NULL REFERENCES treasury_bank_accounts(id),
  reference TEXT,
  description TEXT,
  amount NUMERIC(18, 4) NOT NULL,
  movement_date TIMESTAMPTZ NOT NULL,
  matched_movement_id BIGINT REFERENCES treasury_bank_movements(id),
  status TEXT NOT NULL
);

CREATE TABLE bank_reconciliations (
  id BIGSERIAL PRIMARY KEY,
  company_id UUID NOT NULL REFERENCES companies(id),
  branch_id UUID REFERENCES branches(id),
  warehouse_id UUID,
  cost_center_id UUID,
  reconciliation_id TEXT NOT NULL,
  statement_id TEXT NOT NULL,
  matched_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE enterprise_tax_rules (
  id BIGSERIAL PRIMARY KEY,
  company_id UUID NOT NULL REFERENCES companies(id),
  branch_id UUID REFERENCES branches(id),
  warehouse_id UUID,
  cost_center_id UUID,
  code TEXT NOT NULL,
  country TEXT NOT NULL,
  document_type TEXT NOT NULL,
  rate NUMERIC(9, 4) NOT NULL DEFAULT 0,
  retention_rate NUMERIC(9, 4) NOT NULL DEFAULT 0,
  exempt BOOLEAN NOT NULL DEFAULT false,
  group_name TEXT NOT NULL DEFAULT 'default',
  active BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE enterprise_tax_calculations (
  id BIGSERIAL PRIMARY KEY,
  company_id UUID NOT NULL REFERENCES companies(id),
  branch_id UUID REFERENCES branches(id),
  warehouse_id UUID,
  cost_center_id UUID,
  document_type TEXT NOT NULL,
  document_id TEXT NOT NULL,
  taxable_base NUMERIC(18, 4) NOT NULL,
  tax NUMERIC(18, 4) NOT NULL,
  retention NUMERIC(18, 4) NOT NULL,
  total NUMERIC(18, 4) NOT NULL,
  rule_code TEXT NOT NULL,
  correlation_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE enterprise_fixed_assets (
  id TEXT PRIMARY KEY,
  company_id UUID NOT NULL REFERENCES companies(id),
  branch_id UUID REFERENCES branches(id),
  warehouse_id UUID,
  cost_center_id UUID,
  name TEXT NOT NULL,
  cost NUMERIC(18, 4) NOT NULL,
  useful_life_months INTEGER NOT NULL,
  acquired_at TIMESTAMPTZ NOT NULL,
  monthly_depreciation NUMERIC(18, 4) NOT NULL DEFAULT 0,
  accumulated_depreciation NUMERIC(18, 4) NOT NULL DEFAULT 0,
  fiscal_depreciation NUMERIC(18, 4) NOT NULL DEFAULT 0,
  book_value NUMERIC(18, 4) NOT NULL DEFAULT 0,
  status TEXT NOT NULL
);

CREATE TABLE fixed_asset_events (
  id BIGSERIAL PRIMARY KEY,
  company_id UUID NOT NULL REFERENCES companies(id),
  branch_id UUID REFERENCES branches(id),
  warehouse_id UUID,
  cost_center_id UUID,
  asset_id TEXT NOT NULL REFERENCES enterprise_fixed_assets(id),
  event_type TEXT NOT NULL,
  amount NUMERIC(18, 4) NOT NULL DEFAULT 0,
  payload_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE crm_opportunities (
  id TEXT PRIMARY KEY,
  company_id UUID NOT NULL REFERENCES companies(id),
  branch_id UUID REFERENCES branches(id),
  warehouse_id UUID,
  cost_center_id UUID,
  customer_id TEXT NOT NULL,
  customer TEXT NOT NULL,
  value NUMERIC(18, 4) NOT NULL DEFAULT 0,
  stage TEXT NOT NULL,
  next_follow_up_at TIMESTAMPTZ NOT NULL,
  owner TEXT NOT NULL
);

CREATE TABLE crm_timeline (
  id BIGSERIAL PRIMARY KEY,
  company_id UUID NOT NULL REFERENCES companies(id),
  branch_id UUID REFERENCES branches(id),
  warehouse_id UUID,
  cost_center_id UUID,
  customer_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE crm_notifications (
  id BIGSERIAL PRIMARY KEY,
  company_id UUID NOT NULL REFERENCES companies(id),
  branch_id UUID REFERENCES branches(id),
  warehouse_id UUID,
  cost_center_id UUID,
  recipient TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  scheduled_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL
);

CREATE TABLE report_definitions (
  id TEXT PRIMARY KEY,
  company_id UUID NOT NULL REFERENCES companies(id),
  branch_id UUID REFERENCES branches(id),
  warehouse_id UUID,
  cost_center_id UUID,
  name TEXT NOT NULL,
  dataset TEXT NOT NULL,
  filters_json JSONB NOT NULL,
  formats_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE report_runs (
  id BIGSERIAL PRIMARY KEY,
  company_id UUID NOT NULL REFERENCES companies(id),
  branch_id UUID REFERENCES branches(id),
  warehouse_id UUID,
  cost_center_id UUID,
  run_id TEXT NOT NULL,
  definition_id TEXT NOT NULL REFERENCES report_definitions(id),
  dataset TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  exports_json JSONB NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE materialized_reports (
  id BIGSERIAL PRIMARY KEY,
  company_id UUID NOT NULL REFERENCES companies(id),
  branch_id UUID REFERENCES branches(id),
  warehouse_id UUID,
  cost_center_id UUID,
  report_key TEXT NOT NULL,
  dataset TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE enterprise_event_metrics (
  id BIGSERIAL PRIMARY KEY,
  company_id UUID NOT NULL REFERENCES companies(id),
  branch_id UUID REFERENCES branches(id),
  metric_key TEXT NOT NULL,
  metric_value NUMERIC(18, 4) NOT NULL DEFAULT 0,
  event_name TEXT NOT NULL,
  correlation_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_event_store_scope_sequence
  ON event_store(company_id, branch_id, id);
CREATE INDEX idx_event_store_aggregate
  ON event_store(aggregate_type, aggregate_id, id);
CREATE INDEX idx_event_dispatch_queue_status
  ON event_dispatch_queue(status, available_at, id);
CREATE INDEX idx_accounting_journal_scope
  ON accounting_journal_entries(company_id, branch_id, entry_date);
CREATE INDEX idx_accounting_journal_lines_account
  ON accounting_journal_lines(company_id, branch_id, account_code);
CREATE INDEX idx_inventory_lots_product
  ON inventory_lots(company_id, branch_id, warehouse_id, product_id);
CREATE INDEX idx_inventory_reservations_product
  ON inventory_reservations(company_id, branch_id, warehouse_id, product_id, status);
CREATE INDEX idx_sales_documents_scope
  ON sales_documents(company_id, branch_id, warehouse_id, state, issue_date);
CREATE INDEX idx_sales_documents_customer
  ON sales_documents(company_id, customer_id, state);
CREATE INDEX idx_sales_document_lines_document
  ON sales_document_lines(company_id, document_id);
CREATE INDEX idx_sales_audit_document
  ON sales_document_audit(company_id, document_id, created_at);
CREATE INDEX idx_purchase_documents_scope
  ON purchase_documents(company_id, branch_id, warehouse_id, state, issue_date);
CREATE INDEX idx_purchase_documents_supplier
  ON purchase_documents(company_id, supplier_id, state);
CREATE INDEX idx_purchase_lines_document
  ON purchase_document_lines(company_id, document_id);
CREATE INDEX idx_purchase_approval_document
  ON purchase_approval_steps(company_id, document_id, level);
CREATE INDEX idx_purchase_audit_document
  ON purchase_document_audit(company_id, document_id, created_at);
CREATE INDEX idx_ar_ledger_scope
  ON ar_ledger_entries(company_id, branch_id, customer_id, due_date);
CREATE INDEX idx_ap_ledger_scope
  ON ap_supplier_ledger(company_id, branch_id, supplier_id, due_date);
CREATE INDEX idx_treasury_movements
  ON treasury_bank_movements(company_id, branch_id, bank_account_id, reconciled);
CREATE INDEX idx_bank_lines_match
  ON bank_statement_lines(company_id, branch_id, bank_account_id, reference, amount, status);
CREATE INDEX idx_tax_rules_scope
  ON enterprise_tax_rules(company_id, branch_id, country, document_type, active);
CREATE INDEX idx_assets_scope
  ON enterprise_fixed_assets(company_id, branch_id, status);
CREATE INDEX idx_crm_pipeline
  ON crm_opportunities(company_id, branch_id, stage, next_follow_up_at);
CREATE INDEX idx_reports_scope
  ON materialized_reports(company_id, branch_id, dataset, created_at);
CREATE INDEX idx_enterprise_metrics
  ON enterprise_event_metrics(company_id, branch_id, metric_key, created_at);
