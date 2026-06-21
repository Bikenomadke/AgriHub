-- PostgreSQL + PostGIS Schema for AgriHub
-- This script creates the complete database schema with PostGIS extension

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Create schema
CREATE SCHEMA IF NOT EXISTS agrihub;
SET search_path TO agrihub, public;

-- ============================================
-- TABLES
-- ============================================

CREATE TABLE agrihub.users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('Admin','Field Officer','Weighbridge Trader','Investor','Trader')),
    name TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#3ddc84',
    phone TEXT,
    email TEXT UNIQUE,
    kyc_verified BOOLEAN DEFAULT FALSE,
    pin_hash TEXT,
    mfa_enabled BOOLEAN DEFAULT FALSE,
    mfa_secret TEXT,
    mfa_backup_codes TEXT,
    mfa_enabled_at TIMESTAMPTZ,
    mfa_disabled_at TIMESTAMPTZ,
    supabase_id TEXT UNIQUE,
    status TEXT DEFAULT 'active' CHECK(status IN ('active','inactive')),
    location TEXT,
    company_name TEXT,
    created_by UUID REFERENCES agrihub.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

CREATE TABLE agrihub.sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES agrihub.users(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL,
    device_name TEXT,
    device_type TEXT,
    device_os TEXT,
    ip_address TEXT NOT NULL,
    user_agent TEXT,
    location_country TEXT,
    location_city TEXT,
    refresh_token_hash TEXT NOT NULL,
    access_token_hash TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    last_used_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    revoked_at TIMESTAMPTZ,
    revoked_reason TEXT
);

CREATE TABLE agrihub.fields (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL,
    area_acres REAL NOT NULL DEFAULT 0,
    estimated_total_tons REAL NOT NULL DEFAULT 0,
    buying_price_per_acre REAL,
    polygon GEOMETRY(Polygon, 4326),
    avg_nodes INTEGER DEFAULT 12,
    avg_stalks INTEGER DEFAULT 8,
    survey_date DATE,
    farmer_signature TEXT,
    sites JSONB DEFAULT '[]'::jsonb,
    harvest TEXT,
    status TEXT DEFAULT 'surveyed' CHECK(status IN ('surveyed','valued','reserved','paid','harvest_approved','harvested')),
    farmer_id UUID,
    investor_id UUID,
    valuation REAL,
    harvest_cost REAL DEFAULT 0,
    transport_cost REAL DEFAULT 0,
    pulling_cost REAL DEFAULT 0,
    platform_fee REAL DEFAULT 0,
    tax_amount REAL DEFAULT 0,
    created_by UUID REFERENCES agrihub.users(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

CREATE TABLE agrihub.transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    farmer_name TEXT NOT NULL,
    tons REAL NOT NULL DEFAULT 0,
    buy_price REAL NOT NULL DEFAULT 0,
    total_cost REAL NOT NULL DEFAULT 0,
    expected_payout REAL NOT NULL DEFAULT 0,
    gross_profit REAL NOT NULL DEFAULT 0,
    date DATE NOT NULL,
    note TEXT DEFAULT '',
    ticket_number TEXT NOT NULL,
    ticket_image TEXT,
    payment_status TEXT DEFAULT 'unpaid' CHECK(payment_status IN ('unpaid','pending','completed','failed','reversed')),
    payment_method TEXT,
    payment_phone TEXT,
    payment_amount REAL,
    payment_reference TEXT,
    payment_date DATE,
    field_id UUID REFERENCES agrihub.fields(id),
    farmer_id UUID,
    investor_id UUID REFERENCES agrihub.users(id),
    wallet_transaction_id UUID,
    escrow_transaction_id UUID,
    created_by UUID REFERENCES agrihub.users(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

CREATE TABLE agrihub.farmers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    full_name TEXT NOT NULL,
    national_id TEXT UNIQUE NOT NULL,
    mpesa_phone TEXT UNIQUE NOT NULL,
    alternate_phone TEXT,
    county TEXT NOT NULL,
    subcounty TEXT NOT NULL,
    ward TEXT NOT NULL,
    verification_status TEXT DEFAULT 'pending' CHECK(verification_status IN ('pending','verified','rejected')),
    otp_code TEXT,
    otp_expires_at TIMESTAMPTZ,
    mpesa_registered BOOLEAN DEFAULT FALSE,
    kyc_document_url TEXT,
    national_id_hash TEXT,
    mpesa_phone_hash TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);
CREATE TABLE agrihub.escrow_accounts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    investor_id UUID NOT NULL REFERENCES agrihub.users(id),
    farmer_id UUID NOT NULL REFERENCES agrihub.farmers(id),
    field_id UUID NOT NULL REFERENCES agrihub.fields(id),
    transaction_id UUID REFERENCES agrihub.transactions(id),
    amount REAL NOT NULL,
    release_conditions TEXT,
    status TEXT DEFAULT 'locked' CHECK(status IN ('locked','released','refunded','partial_release')),
    released_amount REAL DEFAULT 0,
    released_at TIMESTAMPTZ,
    refund_amount REAL DEFAULT 0,
    refunded_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE agrihub.wallets (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID UNIQUE NOT NULL REFERENCES agrihub.users(id),
    balance REAL NOT NULL DEFAULT 0,
    available_balance REAL NOT NULL DEFAULT 0,
    frozen_balance REAL NOT NULL DEFAULT 0,
    currency TEXT DEFAULT 'KES',
    status TEXT DEFAULT 'active' CHECK(status IN ('active','frozen','closed')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

CREATE TABLE agrihub.payment_requests (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    investor_id UUID NOT NULL REFERENCES agrihub.users(id),
    farmer_id UUID NOT NULL REFERENCES agrihub.farmers(id),
    field_id UUID NOT NULL REFERENCES agrihub.fields(id),
    transaction_id UUID REFERENCES agrihub.transactions(id),
    amount REAL NOT NULL,
    farmer_payment REAL NOT NULL,
    harvest_cost REAL DEFAULT 0,
    transport_cost REAL DEFAULT 0,
    pulling_cost REAL DEFAULT 0,
    platform_fee REAL DEFAULT 0,
    tax_amount REAL DEFAULT 0,
    gross_amount REAL NOT NULL,
    net_amount REAL NOT NULL,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','processing','completed','failed','cancelled')),
    payment_method TEXT DEFAULT 'mpesa',
    auth_method TEXT,
    auth_verified BOOLEAN DEFAULT FALSE,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE agrihub.mpesa_transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    transaction_id UUID REFERENCES agrihub.transactions(id),
    payment_request_id UUID REFERENCES agrihub.payment_requests(id),
    transaction_type TEXT NOT NULL CHECK(transaction_type IN ('stk_push','b2c','c2b','account_balance','reversal','status_query')),
    phone TEXT NOT NULL,
    amount REAL NOT NULL,
    merchant_request_id TEXT,
    checkout_request_id TEXT,
    originator_conversation_id TEXT,
    conversation_id TEXT,
    mpesa_receipt_number TEXT,
    transaction_date DATE,
    result_code TEXT,
    result_description TEXT,
    response_code TEXT,
    response_description TEXT,
    callback_received BOOLEAN DEFAULT FALSE,
    callback_data JSONB,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending','processing','completed','failed','reversed')),
    retry_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE agrihub.wallet_transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    wallet_id UUID NOT NULL REFERENCES agrihub.wallets(id),
    transaction_type TEXT NOT NULL CHECK(transaction_type IN ('deposit','withdrawal','payment','refund','escrow_deposit','escrow_release','fee','adjustment')),
    amount REAL NOT NULL,
    balance_before REAL NOT NULL,
    balance_after REAL NOT NULL,
    reference TEXT,
    description TEXT,
    related_transaction_id UUID REFERENCES agrihub.transactions(id),
    related_escrow_id UUID REFERENCES agrihub.escrow_accounts(id),
    related_payment_request_id UUID REFERENCES agrihub.payment_requests(id),
    status TEXT DEFAULT 'completed' CHECK(status IN ('pending','completed','failed','reversed')),
    metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE agrihub.reconciliation_records (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    reconciliation_date DATE NOT NULL,
    period_type TEXT NOT NULL CHECK(period_type IN ('daily','monthly')),
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    total_transactions INTEGER DEFAULT 0,
    total_amount REAL DEFAULT 0,
    mpesa_total_amount REAL DEFAULT 0,
    matched_transactions INTEGER DEFAULT 0,
    unmatched_transactions INTEGER DEFAULT 0,
    failed_transactions INTEGER DEFAULT 0,
    reversal_count INTEGER DEFAULT 0,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending','in_progress','completed','failed')),
    discrepancies TEXT,
    performed_by UUID REFERENCES agrihub.users(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE agrihub.audit_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES agrihub.users(id),
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id UUID,
    amount REAL,
    ip_address TEXT,
    user_agent TEXT,
    device_id TEXT,
    location TEXT,
    before_state JSONB,
    after_state JSONB,
    transaction_id UUID REFERENCES agrihub.transactions(id),
    payment_request_id UUID REFERENCES agrihub.payment_requests(id),
    mpesa_transaction_id UUID REFERENCES agrihub.mpesa_transactions(id),
    wallet_transaction_id UUID REFERENCES agrihub.wallet_transactions(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE agrihub.mpesa_requests (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    transaction_id UUID REFERENCES agrihub.transactions(id),
    phone TEXT NOT NULL,
    amount REAL NOT NULL,
    reference TEXT,
    merchant_request_id TEXT,
    checkout_request_id TEXT,
    response_code TEXT,
    response_description TEXT,
    result_code TEXT,
    result_description TEXT,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending','completed','failed')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_mpesa_requests_transaction_id ON agrihub.mpesa_requests(transaction_id);
CREATE INDEX idx_mpesa_requests_merchant_request_id ON agrihub.mpesa_requests(merchant_request_id);
CREATE INDEX idx_mpesa_requests_checkout_request_id ON agrihub.mpesa_requests(checkout_request_id);

CREATE TABLE agrihub.system_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    description TEXT,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE agrihub.payment_queue (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    payment_request_id UUID REFERENCES agrihub.payment_requests(id),
    mpesa_transaction_id UUID REFERENCES agrihub.mpesa_transactions(id),
    priority INTEGER DEFAULT 0,
    status TEXT DEFAULT 'queued' CHECK(status IN ('queued','processing','completed','failed','retry')),
    retry_count INTEGER DEFAULT 0,
    max_retries INTEGER DEFAULT 3,
    error_message TEXT,
    scheduled_at TIMESTAMPTZ,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- INDEXES
-- ============================================

-- Users indexes
CREATE INDEX idx_users_username ON agrihub.users(username);
CREATE INDEX idx_users_role ON agrihub.users(role);
CREATE INDEX idx_users_deleted_at ON agrihub.users(deleted_at) WHERE deleted_at IS NULL;

-- Sessions indexes
CREATE INDEX idx_sessions_user_id ON agrihub.sessions(user_id);
CREATE INDEX idx_sessions_device_id ON agrihub.sessions(device_id);
CREATE INDEX idx_sessions_expires_at ON agrihub.sessions(expires_at);
CREATE INDEX idx_sessions_revoked_at ON agrihub.sessions(revoked_at) WHERE revoked_at IS NULL;
CREATE INDEX idx_sessions_cleanup ON agrihub.sessions(expires_at) WHERE expires_at < NOW();

-- Fields indexes
CREATE INDEX idx_fields_polygon ON agrihub.fields USING GIST(polygon);
CREATE INDEX idx_fields_created_by ON agrihub.fields(created_by);
CREATE INDEX idx_fields_status ON agrihub.fields(status);
CREATE INDEX idx_fields_farmer_id ON agrihub.fields(farmer_id);
CREATE INDEX idx_fields_investor_id ON agrihub.fields(investor_id);
CREATE INDEX idx_fields_created_at ON agrihub.fields(created_at);

-- Transactions indexes
CREATE INDEX idx_transactions_date ON agrihub.transactions(date);
CREATE INDEX idx_transactions_payment_status ON agrihub.transactions(payment_status);
CREATE INDEX idx_transactions_field_id ON agrihub.transactions(field_id);
CREATE INDEX idx_transactions_investor_id ON agrihub.transactions(investor_id);
CREATE INDEX idx_transactions_created_by ON agrihub.transactions(created_by);
CREATE INDEX idx_transactions_ticket_number ON agrihub.transactions(ticket_number);

-- Farmers indexes
CREATE INDEX idx_farmers_national_id ON agrihub.farmers(national_id);
CREATE INDEX idx_farmers_mpesa_phone ON agrihub.farmers(mpesa_phone);
CREATE INDEX idx_farmers_verification_status ON agrihub.farmers(verification_status);
CREATE INDEX idx_farmers_national_id_hash ON agrihub.farmers(national_id_hash);
CREATE INDEX idx_farmers_mpesa_phone_hash ON agrihub.farmers(mpesa_phone_hash);

-- Wallets indexes
CREATE INDEX idx_wallets_user_id ON agrihub.wallets(user_id);

-- Wallet transactions indexes
CREATE INDEX idx_wallet_transactions_wallet_id ON agrihub.wallet_transactions(wallet_id);
CREATE INDEX idx_wallet_transactions_created_at ON agrihub.wallet_transactions(created_at);

-- Payment requests indexes
CREATE INDEX idx_payment_requests_investor_id ON agrihub.payment_requests(investor_id);
CREATE INDEX idx_payment_requests_field_id ON agrihub.payment_requests(field_id);
CREATE INDEX idx_payment_requests_status ON agrihub.payment_requests(status);

-- M-Pesa transactions indexes
CREATE INDEX idx_mpesa_transactions_transaction_id ON agrihub.mpesa_transactions(transaction_id);
CREATE INDEX idx_mpesa_transactions_status ON agrihub.mpesa_transactions(status);
CREATE INDEX idx_mpesa_transactions_merchant_request_id ON agrihub.mpesa_transactions(merchant_request_id);

-- Escrow accounts indexes
CREATE INDEX idx_escrow_accounts_field_id ON agrihub.escrow_accounts(field_id);
CREATE INDEX idx_escrow_accounts_status ON agrihub.escrow_accounts(status);

-- Reconciliation records indexes
CREATE INDEX idx_reconciliation_records_date ON agrihub.reconciliation_records(reconciliation_date);

-- Audit logs indexes
CREATE INDEX idx_audit_logs_user_id ON agrihub.audit_logs(user_id);
CREATE INDEX idx_audit_logs_created_at ON agrihub.audit_logs(created_at);
CREATE INDEX idx_audit_logs_entity ON agrihub.audit_logs(entity_type, entity_id);

-- Payment queue indexes
CREATE INDEX idx_payment_queue_status ON agrihub.payment_queue(status);
CREATE INDEX idx_payment_queue_scheduled_at ON agrihub.payment_queue(scheduled_at);

-- ============================================
-- DEFAULT DATA
-- ============================================

INSERT INTO agrihub.system_config (key, value, description) VALUES 
    ('escrow_mode', 'disabled', 'Enable or disable escrow payment mode'),
    ('platform_fee_percentage', '5', 'Platform fee percentage'),
    ('tax_percentage', '0', 'Tax percentage'),
    ('max_payment_amount', '1000000', 'Maximum payment amount without additional verification'),
    ('payment_timeout_seconds', '300', 'Payment request timeout in seconds'),
    ('mpesa_retry_count', '3', 'Number of M-Pesa transaction retries'),
    ('auto_reconciliation', 'enabled', 'Enable automatic daily reconciliation');

-- ============================================
-- FUNCTIONS
-- ============================================

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION agrihub.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers for updated_at
CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON agrihub.users
    FOR EACH ROW EXECUTE FUNCTION agrihub.update_updated_at_column();

CREATE TRIGGER update_fields_updated_at BEFORE UPDATE ON agrihub.fields
    FOR EACH ROW EXECUTE FUNCTION agrihub.update_updated_at_column();

CREATE TRIGGER update_transactions_updated_at BEFORE UPDATE ON agrihub.transactions
    FOR EACH ROW EXECUTE FUNCTION agrihub.update_updated_at_column();

CREATE TRIGGER update_farmers_updated_at BEFORE UPDATE ON agrihub.farmers
    FOR EACH ROW EXECUTE FUNCTION agrihub.update_updated_at_column();

CREATE TRIGGER update_wallets_updated_at BEFORE UPDATE ON agrihub.wallets
    FOR EACH ROW EXECUTE FUNCTION agrihub.update_updated_at_column();

CREATE TRIGGER update_payment_requests_updated_at BEFORE UPDATE ON agrihub.payment_requests
    FOR EACH ROW EXECUTE FUNCTION agrihub.update_updated_at_column();

CREATE TRIGGER update_mpesa_transactions_updated_at BEFORE UPDATE ON agrihub.mpesa_transactions
    FOR EACH ROW EXECUTE FUNCTION agrihub.update_updated_at_column();

CREATE TRIGGER update_escrow_accounts_updated_at BEFORE UPDATE ON agrihub.escrow_accounts
    FOR EACH ROW EXECUTE FUNCTION agrihub.update_updated_at_column();

CREATE TRIGGER update_reconciliation_records_updated_at BEFORE UPDATE ON agrihub.reconciliation_records
    FOR EACH ROW EXECUTE FUNCTION agrihub.update_updated_at_column();

CREATE TRIGGER update_mpesa_requests_updated_at BEFORE UPDATE ON agrihub.mpesa_requests
    FOR EACH ROW EXECUTE FUNCTION agrihub.update_updated_at_column();

CREATE TRIGGER update_payment_queue_updated_at BEFORE UPDATE ON agrihub.payment_queue
    FOR EACH ROW EXECUTE FUNCTION agrihub.update_updated_at_column();

CREATE TRIGGER update_system_config_updated_at BEFORE UPDATE ON agrihub.system_config
    FOR EACH ROW EXECUTE FUNCTION agrihub.update_updated_at_column();

-- Failed Logins Table (for authentication security)
CREATE TABLE IF NOT EXISTS agrihub.failed_logins (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  ip_address TEXT,
  attempted_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_failed_logins_username ON agrihub.failed_logins(username);
CREATE INDEX IF NOT EXISTS idx_failed_logins_attempted_at ON agrihub.failed_logins(attempted_at);

-- Analysis Unlocks Table
CREATE TABLE IF NOT EXISTS agrihub.analysis_unlocks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  field_id TEXT NOT NULL,
  amount_paid NUMERIC(10, 2) NOT NULL,
  mpesa_receipt TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'completed', 'failed')),
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  FOREIGN KEY (user_id) REFERENCES agrihub.users(id) ON DELETE CASCADE,
  FOREIGN KEY (field_id) REFERENCES agrihub.fields(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_analysis_unlocks_user_id ON agrihub.analysis_unlocks(user_id);
CREATE INDEX IF NOT EXISTS idx_analysis_unlocks_field_id ON agrihub.analysis_unlocks(field_id);
CREATE INDEX IF NOT EXISTS idx_analysis_unlocks_status ON agrihub.analysis_unlocks(status);
CREATE INDEX IF NOT EXISTS idx_analysis_unlocks_expires_at ON agrihub.analysis_unlocks(expires_at);

-- Unique constraint: one unlock per user per field
CREATE UNIQUE INDEX IF NOT EXISTS idx_analysis_unlocks_user_field ON agrihub.analysis_unlocks(user_id, field_id) WHERE status = 'completed';

-- Trigger for updated_at on analysis_unlocks
CREATE TRIGGER update_analysis_unlocks_updated_at BEFORE UPDATE ON agrihub.analysis_unlocks
    FOR EACH ROW EXECUTE FUNCTION agrihub.update_updated_at_column();

-- ============================================
-- COMMERCIAL MANAGEMENT MODULE
-- ============================================

-- System Settings Table
CREATE TABLE IF NOT EXISTS agrihub.system_settings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  setting_key TEXT UNIQUE NOT NULL,
  setting_value TEXT NOT NULL,
  description TEXT,
  updated_by UUID REFERENCES agrihub.users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_system_settings_key ON agrihub.system_settings(setting_key);

-- Pricing Audit Logs Table
CREATE TABLE IF NOT EXISTS agrihub.pricing_audit_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  setting_key TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  changed_by UUID REFERENCES agrihub.users(id) ON DELETE SET NULL,
  changed_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pricing_audit_logs_key ON agrihub.pricing_audit_logs(setting_key);
CREATE INDEX IF NOT EXISTS idx_pricing_audit_logs_changed_by ON agrihub.pricing_audit_logs(changed_by);
CREATE INDEX IF NOT EXISTS idx_pricing_audit_logs_changed_at ON agrihub.pricing_audit_logs(changed_at);

-- User Subscriptions Table
CREATE TABLE IF NOT EXISTS agrihub.user_subscriptions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES agrihub.users(id) ON DELETE CASCADE,
  plan_type TEXT NOT NULL CHECK(plan_type IN ('daily', 'weekly', 'monthly')),
  amount_paid NUMERIC(10, 2) NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  mpesa_receipt TEXT,
  status TEXT DEFAULT 'active' CHECK(status IN ('active', 'expired', 'cancelled')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_subscriptions_user_id ON agrihub.user_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_subscriptions_status ON agrihub.user_subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_user_subscriptions_expires_at ON agrihub.user_subscriptions(expires_at);

-- Trigger for updated_at on user_subscriptions
CREATE TRIGGER update_user_subscriptions_updated_at BEFORE UPDATE ON agrihub.user_subscriptions
    FOR EACH ROW EXECUTE FUNCTION agrihub.update_updated_at_column();

-- Trader Usage Table
CREATE TABLE IF NOT EXISTS agrihub.trader_usage (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES agrihub.users(id) ON DELETE CASCADE,
  ticket_id UUID NOT NULL REFERENCES agrihub.transactions(id) ON DELETE CASCADE,
  tonnes NUMERIC(10, 2) NOT NULL,
  processed_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trader_usage_user_id ON agrihub.trader_usage(user_id);
CREATE INDEX IF NOT EXISTS idx_trader_usage_ticket_id ON agrihub.trader_usage(ticket_id);
CREATE INDEX IF NOT EXISTS idx_trader_usage_processed_at ON agrihub.trader_usage(processed_at);

-- Trader Invoices Table
CREATE TABLE IF NOT EXISTS agrihub.trader_invoices (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES agrihub.users(id) ON DELETE CASCADE,
  billing_month TEXT NOT NULL,
  total_tonnage NUMERIC(10, 2),
  free_tonnage NUMERIC(10, 2),
  chargeable_tonnage NUMERIC(10, 2),
  levy_rate NUMERIC(10, 2),
  levy_amount NUMERIC(10, 2),
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'paid', 'overdue')),
  mpesa_receipt TEXT,
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trader_invoices_user_id ON agrihub.trader_invoices(user_id);
CREATE INDEX IF NOT EXISTS idx_trader_invoices_billing_month ON agrihub.trader_invoices(billing_month);
CREATE INDEX IF NOT EXISTS idx_trader_invoices_status ON agrihub.trader_invoices(status);

-- Trigger for updated_at on trader_invoices
CREATE TRIGGER update_trader_invoices_updated_at BEFORE UPDATE ON agrihub.trader_invoices
    FOR EACH ROW EXECUTE FUNCTION agrihub.update_updated_at_column();

-- Seed initial system settings for trader billing
INSERT INTO agrihub.system_settings (setting_key, setting_value, description) VALUES
  ('trader_daily_price', '50', 'Daily subscription price for traders'),
  ('trader_weekly_price', '250', 'Weekly subscription price for traders'),
  ('trader_monthly_price', '1000', 'Monthly subscription price for traders'),
  ('trader_levy_per_ton', '10', 'Levy charged per ton for traders'),
  ('trader_free_tonnage', '100', 'Free monthly tonnage allowance for traders')
ON CONFLICT (setting_key) DO NOTHING;
