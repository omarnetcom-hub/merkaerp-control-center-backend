-- Odoo 19.0 Migration Script for Caja Simple
-- PHASE 1: Core Tables

-- Base Module
CREATE TABLE IF NOT EXISTS res_users (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    login VARCHAR(255) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    company_id INTEGER,
    active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS res_companies (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255),
    phone VARCHAR(20),
    website VARCHAR(255),
    currency_id INTEGER DEFAULT 1,
    country_id INTEGER,
    state VARCHAR(100),
    city VARCHAR(100),
    street VARCHAR(255),
    zip_code VARCHAR(20),
    active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Add DIAN EDI flag to companies (idempotent)
ALTER TABLE IF EXISTS res_companies ADD COLUMN IF NOT EXISTS edi_dian_enabled BOOLEAN DEFAULT FALSE;

-- Access Control
CREATE TABLE IF NOT EXISTS res_roles (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS res_user_roles (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES res_users(id),
    role_id INTEGER NOT NULL REFERENCES res_roles(id),
    UNIQUE(user_id, role_id)
);

-- Contacts Module
CREATE TABLE IF NOT EXISTS res_partners (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255),
    phone VARCHAR(20),
    mobile VARCHAR(20),
    website VARCHAR(255),
    street VARCHAR(255),
    city VARCHAR(100),
    state VARCHAR(100),
    zip_code VARCHAR(20),
    country_id INTEGER,
    partner_type VARCHAR(50), -- 'customer', 'supplier', 'contact'
    is_company BOOLEAN DEFAULT FALSE,
    active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Product Module
CREATE TABLE IF NOT EXISTS product_categories (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    parent_id INTEGER REFERENCES product_categories(id),
    active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS uom (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    category VARCHAR(50),
    ratio DECIMAL(10, 4),
    active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO uom (name, category, ratio) VALUES ('Unit', 'Unit', 1.0) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS product_products (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    code VARCHAR(100) UNIQUE,
    category_id INTEGER REFERENCES product_categories(id),
    type VARCHAR(50) DEFAULT 'product', -- 'product', 'service', 'consumable'
    price DECIMAL(12, 2),
    cost DECIMAL(12, 2),
    description TEXT,
    uom_id INTEGER DEFAULT 1 REFERENCES uom(id),
    active BOOLEAN DEFAULT TRUE,
    tracking VARCHAR(50) DEFAULT 'none', -- 'none', 'serial', 'batch'
    parent_id INTEGER REFERENCES product_products(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Stock/Inventory Module
CREATE TABLE IF NOT EXISTS stock_locations (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    location_type VARCHAR(50) DEFAULT 'internal', -- 'internal', 'vendor', 'customer', 'transit'
    active BOOLEAN DEFAULT TRUE,
    warehouse_id INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS stock_moves (
    id SERIAL PRIMARY KEY,
    product_id INTEGER NOT NULL REFERENCES product_products(id),
    quantity DECIMAL(12, 4) NOT NULL,
    source_location_id INTEGER REFERENCES stock_locations(id),
    destination_location_id INTEGER REFERENCES stock_locations(id),
    move_type VARCHAR(50), -- 'incoming', 'outgoing', 'internal'
    origin VARCHAR(255),
    state VARCHAR(50) DEFAULT 'draft', -- 'draft', 'waiting', 'confirmed', 'done', 'cancelled'
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Stock Picking (agrupa movimientos)
CREATE TABLE IF NOT EXISTS stock_pickings (
    id SERIAL PRIMARY KEY,
    company_id INTEGER REFERENCES res_companies(id),
    warehouse_id INTEGER,
    picking_type VARCHAR(50), -- 'incoming','outgoing','internal'
    origin VARCHAR(255),
    state VARCHAR(50) DEFAULT 'draft', -- 'draft','assigned','done','cancelled'
    scheduled_date TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS stock_picking_moves (
    id SERIAL PRIMARY KEY,
    picking_id INTEGER NOT NULL REFERENCES stock_pickings(id),
    move_id INTEGER NOT NULL REFERENCES stock_moves(id),
    sequence INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Stock Quants: ledger de cantidades por ubicación y lote
CREATE TABLE IF NOT EXISTS stock_quants (
    id SERIAL PRIMARY KEY,
    company_id INTEGER REFERENCES res_companies(id),
    product_id INTEGER NOT NULL REFERENCES product_products(id),
    location_id INTEGER NOT NULL REFERENCES stock_locations(id),
    lot_id TEXT,
    quantity DECIMAL(18,4) NOT NULL DEFAULT 0,
    unit_cost DECIMAL(18,4) DEFAULT 0,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Stock Lots / Batches
CREATE TABLE IF NOT EXISTS stock_lots (
    id SERIAL PRIMARY KEY,
    company_id INTEGER REFERENCES res_companies(id),
    product_id INTEGER NOT NULL REFERENCES product_products(id),
    batch_number TEXT,
    serial_number TEXT,
    received_at TIMESTAMP,
    expires_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Warehouses
CREATE TABLE IF NOT EXISTS warehouses (
    id SERIAL PRIMARY KEY,
    company_id INTEGER REFERENCES res_companies(id),
    name VARCHAR(255) NOT NULL,
    address TEXT,
    default_location_id INTEGER REFERENCES stock_locations(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Reorder rules
CREATE TABLE IF NOT EXISTS reorder_rules (
    id SERIAL PRIMARY KEY,
    company_id INTEGER REFERENCES res_companies(id),
    product_id INTEGER NOT NULL REFERENCES product_products(id),
    warehouse_id INTEGER,
    min_qty DECIMAL(18,4) DEFAULT 0,
    max_qty DECIMAL(18,4) DEFAULT 0,
    multiple DECIMAL(18,4) DEFAULT 1,
    active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Audit log for stock operations
CREATE TABLE IF NOT EXISTS stock_audit (
    id SERIAL PRIMARY KEY,
    company_id INTEGER REFERENCES res_companies(id),
    branch_id INTEGER,
    user_id TEXT,
    action TEXT NOT NULL,
    entity_type TEXT,
    entity_id TEXT,
    payload JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Account Module (Chart of Accounts, Journals)
CREATE TABLE IF NOT EXISTS account_accounts (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    code VARCHAR(64) UNIQUE NOT NULL,
    account_type VARCHAR(50), -- 'asset', 'liability', 'equity', 'income', 'expense'
    active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS account_journals (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    code VARCHAR(10) UNIQUE NOT NULL,
    type VARCHAR(50), -- 'sale', 'purchase', 'general', 'bank', 'cash'
    company_id INTEGER REFERENCES res_companies(id),
    active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Sale Module
CREATE TABLE IF NOT EXISTS sale_orders (
    id SERIAL PRIMARY KEY,
    partner_id INTEGER NOT NULL REFERENCES res_partners(id),
    company_id INTEGER REFERENCES res_companies(id),
    order_date DATE NOT NULL,
    state VARCHAR(50) DEFAULT 'draft', -- 'draft', 'confirmed', 'shipped', 'done', 'cancelled'
    currency_id INTEGER DEFAULT 1,
    user_id INTEGER REFERENCES res_users(id),
    total_amount DECIMAL(12, 2) DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sale_order_lines (
    id SERIAL PRIMARY KEY,
    order_id INTEGER NOT NULL REFERENCES sale_orders(id),
    product_id INTEGER REFERENCES product_products(id),
    quantity DECIMAL(12, 4) NOT NULL,
    price_unit DECIMAL(12, 2) NOT NULL,
    subtotal DECIMAL(12, 2) DEFAULT 0,
    sequence INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Purchase Module
CREATE TABLE IF NOT EXISTS purchase_orders (
    id SERIAL PRIMARY KEY,
    partner_id INTEGER NOT NULL REFERENCES res_partners(id),
    company_id INTEGER REFERENCES res_companies(id),
    order_date DATE NOT NULL,
    state VARCHAR(50) DEFAULT 'draft', -- 'draft', 'confirmed', 'received', 'done', 'cancelled'
    currency_id INTEGER DEFAULT 1,
    user_id INTEGER REFERENCES res_users(id),
    total_amount DECIMAL(12, 2) DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS purchase_order_lines (
    id SERIAL PRIMARY KEY,
    order_id INTEGER NOT NULL REFERENCES purchase_orders(id),
    product_id INTEGER REFERENCES product_products(id),
    quantity DECIMAL(12, 4) NOT NULL,
    price_unit DECIMAL(12, 2) NOT NULL,
    subtotal DECIMAL(12, 2) DEFAULT 0,
    sequence INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Account Invoices
CREATE TABLE IF NOT EXISTS account_invoices (
    id SERIAL PRIMARY KEY,
    partner_id INTEGER NOT NULL REFERENCES res_partners(id),
    company_id INTEGER REFERENCES res_companies(id),
    invoice_date DATE NOT NULL,
    due_date DATE,
    state VARCHAR(50) DEFAULT 'draft', -- 'draft', 'posted', 'paid', 'cancelled'
    currency_id INTEGER DEFAULT 1,
    invoice_type VARCHAR(50) DEFAULT 'out_invoice', -- 'out_invoice', 'in_invoice', 'out_refund', 'in_refund'
    reference VARCHAR(255),
    total_amount DECIMAL(12, 2) DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS account_invoice_lines (
    id SERIAL PRIMARY KEY,
    invoice_id INTEGER NOT NULL REFERENCES account_invoices(id),
    product_id INTEGER REFERENCES product_products(id),
    account_id INTEGER REFERENCES account_accounts(id),
    quantity DECIMAL(12, 4) NOT NULL,
    price_unit DECIMAL(12, 2) NOT NULL,
    subtotal DECIMAL(12, 2) DEFAULT 0,
    tax_ids TEXT,
    service_rip_code VARCHAR(100),
    glosa_reference VARCHAR(255),
    sequence INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS account_edi_documents (
    id SERIAL PRIMARY KEY,
    invoice_id INTEGER NOT NULL REFERENCES account_invoices(id),
    dian_uuid VARCHAR(255),
    cufe VARCHAR(255),
    resolution_number VARCHAR(100),
    environment VARCHAR(50) DEFAULT 'production',
    document_type VARCHAR(50) DEFAULT 'invoice',
    status VARCHAR(50) DEFAULT 'draft',
    xml_payload TEXT,
    json_payload TEXT,
    response_message TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE account_invoices ADD COLUMN IF NOT EXISTS edi_status VARCHAR(50) DEFAULT 'not_requested';
ALTER TABLE account_invoices ADD COLUMN IF NOT EXISTS edi_document_id INTEGER REFERENCES account_edi_documents(id);
ALTER TABLE account_invoices ADD COLUMN IF NOT EXISTS dian_resolution VARCHAR(100);
ALTER TABLE account_invoices ADD COLUMN IF NOT EXISTS environment VARCHAR(50);
ALTER TABLE account_invoices ADD COLUMN IF NOT EXISTS public_sector_document_type VARCHAR(100);
ALTER TABLE account_invoices ADD COLUMN IF NOT EXISTS contract_reference VARCHAR(255);
ALTER TABLE account_invoices ADD COLUMN IF NOT EXISTS budget_item_code VARCHAR(100);
ALTER TABLE account_invoices ADD COLUMN IF NOT EXISTS sector_entity_type VARCHAR(50);

ALTER TABLE account_invoice_lines ADD COLUMN IF NOT EXISTS service_rip_code VARCHAR(100);
ALTER TABLE account_invoice_lines ADD COLUMN IF NOT EXISTS glosa_reference VARCHAR(255);

-- Budget Module (Presupuesto público)
CREATE TABLE IF NOT EXISTS account_budgets (
    id SERIAL PRIMARY KEY,
    company_id INTEGER REFERENCES res_companies(id),
    fiscal_year INTEGER NOT NULL,
    name VARCHAR(255),
    state VARCHAR(50) DEFAULT 'draft', -- 'draft','approved','closed'
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS account_budget_lines (
    id SERIAL PRIMARY KEY,
    budget_id INTEGER NOT NULL REFERENCES account_budgets(id),
    code VARCHAR(64) NOT NULL,
    name VARCHAR(255) NOT NULL,
    account_id INTEGER REFERENCES account_accounts(id),
    initial_amount DECIMAL(18, 2) DEFAULT 0,
    appropriated_amount DECIMAL(18, 2) DEFAULT 0,
    committed_amount DECIMAL(18, 2) DEFAULT 0,
    executed_amount DECIMAL(18, 2) DEFAULT 0,
    available_amount DECIMAL(18, 2) DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS account_budget_commitments (
    id SERIAL PRIMARY KEY,
    budget_line_id INTEGER NOT NULL REFERENCES account_budget_lines(id),
    origin_type VARCHAR(50), -- 'purchase_order', 'contract', 'manual'
    origin_id INTEGER,
    amount DECIMAL(18, 2) NOT NULL,
    state VARCHAR(50) DEFAULT 'pending', -- 'pending','confirmed','cancelled'
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS account_budget_allocations (
    id SERIAL PRIMARY KEY,
    budget_line_id INTEGER NOT NULL REFERENCES account_budget_lines(id),
    date DATE NOT NULL,
    amount DECIMAL(18, 2) NOT NULL,
    source VARCHAR(255),
    reference VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_budget_fiscal_year ON account_budgets(fiscal_year);
CREATE INDEX idx_budget_line_code ON account_budget_lines(code);
-- Indexes for performance
CREATE INDEX idx_users_email ON res_users(email);
CREATE INDEX idx_users_login ON res_users(login);
CREATE INDEX idx_partners_email ON res_partners(email);
CREATE INDEX idx_products_code ON product_products(code);
CREATE INDEX idx_sale_orders_partner ON sale_orders(partner_id);
CREATE INDEX idx_purchase_orders_partner ON purchase_orders(partner_id);
CREATE INDEX idx_invoices_partner ON account_invoices(partner_id);
CREATE INDEX idx_stock_moves_product ON stock_moves(product_id);
