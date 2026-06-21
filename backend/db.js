import Database from "better-sqlite3";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import config from "./utils/config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Get database encryption key from environment
const dbEncryptionKey = process.env.DB_ENCRYPTION_KEY || process.env.ENCRYPTION_KEY;

// Initialize database with encryption if key is provided
let db;
if (dbEncryptionKey) {
  // Use SQLCipher for encrypted database
  db = new Database(join(__dirname, "agrihub.db"));
  db.pragma(`key = '${dbEncryptionKey}'`);
  console.log('✓ Database encryption enabled');
} else {
  // Use regular SQLite (development only)
  db = new Database(join(__dirname, "agrihub.db"));
  console.warn('⚠ Database encryption disabled - set DB_ENCRYPTION_KEY for production');
}

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('Admin','Field Officer','Weighbridge Trader','Investor')),
    name TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#3ddc84',
    phone TEXT,
    email TEXT,
    kyc_verified INTEGER DEFAULT 0,
    pin_hash TEXT,
    mfa_enabled INTEGER DEFAULT 0,
    mfa_secret TEXT,
    mfa_backup_codes TEXT,
    mfa_enabled_at TEXT,
    mfa_disabled_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    deleted_at TEXT
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
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
    expires_at TEXT NOT NULL,
    last_used_at TEXT DEFAULT (datetime('now')),
    created_at TEXT DEFAULT (datetime('now')),
    revoked_at TEXT,
    revoked_reason TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS fields (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    area_acres REAL NOT NULL DEFAULT 0,
    estimated_total_tons REAL NOT NULL DEFAULT 0,
    buying_price_per_acre REAL,
    polygon TEXT,
    avg_nodes INTEGER DEFAULT 12,
    avg_stalks INTEGER DEFAULT 8,
    survey_date TEXT,
    farmer_signature TEXT,
    sites TEXT DEFAULT '[]',
    harvest TEXT,
    status TEXT DEFAULT 'surveyed' CHECK(status IN ('surveyed','valued','reserved','paid','harvest_approved','harvested')),
    farmer_id TEXT,
    investor_id TEXT,
    valuation REAL,
    harvest_cost REAL DEFAULT 0,
    transport_cost REAL DEFAULT 0,
    pulling_cost REAL DEFAULT 0,
    platform_fee REAL DEFAULT 0,
    tax_amount REAL DEFAULT 0,
    created_by TEXT REFERENCES users(id),
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    deleted_at TEXT
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY,
    farmer_name TEXT NOT NULL,
    tons REAL NOT NULL DEFAULT 0,
    buy_price REAL NOT NULL DEFAULT 0,
    total_cost REAL NOT NULL DEFAULT 0,
    expected_payout REAL NOT NULL DEFAULT 0,
    gross_profit REAL NOT NULL DEFAULT 0,
    date TEXT NOT NULL,
    note TEXT DEFAULT '',
    ticket_number TEXT NOT NULL,
    ticket_image TEXT,
    payment_status TEXT DEFAULT 'unpaid' CHECK(payment_status IN ('unpaid','pending','completed','failed','reversed')),
    payment_method TEXT,
    payment_phone TEXT,
    payment_amount REAL,
    payment_reference TEXT,
    payment_date TEXT,
    field_id TEXT REFERENCES fields(id),
    farmer_id TEXT,
    investor_id TEXT REFERENCES users(id),
    wallet_transaction_id TEXT,
    escrow_transaction_id TEXT,
    created_by TEXT REFERENCES users(id),
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    deleted_at TEXT
  );

  CREATE TABLE IF NOT EXISTS farmers (
    id TEXT PRIMARY KEY,
    full_name TEXT NOT NULL,
    national_id TEXT UNIQUE NOT NULL,
    mpesa_phone TEXT UNIQUE NOT NULL,
    alternate_phone TEXT,
    county TEXT NOT NULL,
    subcounty TEXT NOT NULL,
    ward TEXT NOT NULL,
    verification_status TEXT DEFAULT 'pending' CHECK(verification_status IN ('pending','verified','rejected')),
    otp_code TEXT,
    otp_expires_at TEXT,
    mpesa_registered INTEGER DEFAULT 0,
    kyc_document_url TEXT,
    national_id_hash TEXT,
    mpesa_phone_hash TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    deleted_at TEXT
  );

  CREATE TABLE IF NOT EXISTS wallets (
    id TEXT PRIMARY KEY,
    user_id TEXT UNIQUE NOT NULL REFERENCES users(id),
    balance REAL NOT NULL DEFAULT 0,
    available_balance REAL NOT NULL DEFAULT 0,
    frozen_balance REAL NOT NULL DEFAULT 0,
    currency TEXT DEFAULT 'KES',
    status TEXT DEFAULT 'active' CHECK(status IN ('active','frozen','closed')),
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    deleted_at TEXT
  );

  CREATE TABLE IF NOT EXISTS wallet_transactions (
    id TEXT PRIMARY KEY,
    wallet_id TEXT NOT NULL REFERENCES wallets(id),
    transaction_type TEXT NOT NULL CHECK(transaction_type IN ('deposit','withdrawal','payment','refund','escrow_deposit','escrow_release','fee','adjustment')),
    amount REAL NOT NULL,
    balance_before REAL NOT NULL,
    balance_after REAL NOT NULL,
    reference TEXT,
    description TEXT,
    related_transaction_id TEXT REFERENCES transactions(id),
    related_escrow_id TEXT REFERENCES escrow_accounts(id),
    related_payment_request_id TEXT REFERENCES payment_requests(id),
    status TEXT DEFAULT 'completed' CHECK(status IN ('pending','completed','failed','reversed')),
    metadata TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS payment_requests (
    id TEXT PRIMARY KEY,
    investor_id TEXT NOT NULL REFERENCES users(id),
    farmer_id TEXT NOT NULL REFERENCES farmers(id),
    field_id TEXT NOT NULL REFERENCES fields(id),
    transaction_id TEXT REFERENCES transactions(id),
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
    auth_verified INTEGER DEFAULT 0,
    expires_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS mpesa_transactions (
    id TEXT PRIMARY KEY,
    transaction_id TEXT REFERENCES transactions(id),
    payment_request_id TEXT REFERENCES payment_requests(id),
    transaction_type TEXT NOT NULL CHECK(transaction_type IN ('stk_push','b2c','c2b','account_balance','reversal','status_query')),
    phone TEXT NOT NULL,
    amount REAL NOT NULL,
    merchant_request_id TEXT,
    checkout_request_id TEXT,
    originator_conversation_id TEXT,
    conversation_id TEXT,
    mpesa_receipt_number TEXT,
    transaction_date TEXT,
    result_code TEXT,
    result_description TEXT,
    response_code TEXT,
    response_description TEXT,
    callback_received INTEGER DEFAULT 0,
    callback_data TEXT,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending','processing','completed','failed','reversed')),
    retry_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS escrow_accounts (
    id TEXT PRIMARY KEY,
    investor_id TEXT NOT NULL REFERENCES users(id),
    farmer_id TEXT NOT NULL REFERENCES farmers(id),
    field_id TEXT NOT NULL REFERENCES fields(id),
    transaction_id TEXT REFERENCES transactions(id),
    amount REAL NOT NULL,
    release_conditions TEXT,
    status TEXT DEFAULT 'locked' CHECK(status IN ('locked','released','refunded','partial_release')),
    released_amount REAL DEFAULT 0,
    released_at TEXT,
    refund_amount REAL DEFAULT 0,
    refunded_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS reconciliation_records (
    id TEXT PRIMARY KEY,
    reconciliation_date TEXT NOT NULL,
    period_type TEXT NOT NULL CHECK(period_type IN ('daily','monthly')),
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    total_transactions INTEGER DEFAULT 0,
    total_amount REAL DEFAULT 0,
    mpesa_total_amount REAL DEFAULT 0,
    matched_transactions INTEGER DEFAULT 0,
    unmatched_transactions INTEGER DEFAULT 0,
    failed_transactions INTEGER DEFAULT 0,
    reversal_count INTEGER DEFAULT 0,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending','in_progress','completed','failed')),
    discrepancies TEXT,
    performed_by TEXT REFERENCES users(id),
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    user_id TEXT REFERENCES users(id),
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT,
    amount REAL,
    ip_address TEXT,
    user_agent TEXT,
    device_id TEXT,
    location TEXT,
    before_state TEXT,
    after_state TEXT,
    transaction_id TEXT REFERENCES transactions(id),
    payment_request_id TEXT REFERENCES payment_requests(id),
    mpesa_transaction_id TEXT REFERENCES mpesa_transactions(id),
    wallet_transaction_id TEXT REFERENCES wallet_transactions(id),
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS mpesa_requests (
    id TEXT PRIMARY KEY,
    transaction_id TEXT REFERENCES transactions(id),
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
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS system_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    description TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS payment_queue (
    id TEXT PRIMARY KEY,
    payment_request_id TEXT REFERENCES payment_requests(id),
    mpesa_transaction_id TEXT REFERENCES mpesa_transactions(id),
    priority INTEGER DEFAULT 0,
    status TEXT DEFAULT 'queued' CHECK(status IN ('queued','processing','completed','failed','retry')),
    retry_count INTEGER DEFAULT 0,
    max_retries INTEGER DEFAULT 3,
    error_message TEXT,
    scheduled_at TEXT,
    started_at TEXT,
    completed_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  -- Indexes for performance
  CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_device_id ON sessions(device_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
  CREATE INDEX IF NOT EXISTS idx_sessions_revoked_at ON sessions(revoked_at) WHERE revoked_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_sessions_cleanup ON sessions(expires_at) WHERE expires_at < datetime('now');
  CREATE INDEX IF NOT EXISTS idx_fields_created_by ON fields(created_by);
  CREATE INDEX IF NOT EXISTS idx_fields_status ON fields(status);
  CREATE INDEX IF NOT EXISTS idx_fields_farmer_id ON fields(farmer_id);
  CREATE INDEX IF NOT EXISTS idx_fields_investor_id ON fields(investor_id);
  CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(date);
  CREATE INDEX IF NOT EXISTS idx_transactions_payment_status ON transactions(payment_status);
  CREATE INDEX IF NOT EXISTS idx_transactions_field_id ON transactions(field_id);
  CREATE INDEX IF NOT EXISTS idx_transactions_investor_id ON transactions(investor_id);
  CREATE INDEX IF NOT EXISTS idx_mpesa_transaction ON mpesa_requests(transaction_id);
  CREATE INDEX IF NOT EXISTS idx_mpesa_transactions_transaction_id ON mpesa_transactions(transaction_id);
  CREATE INDEX IF NOT EXISTS idx_mpesa_transactions_status ON mpesa_transactions(status);
  CREATE INDEX IF NOT EXISTS idx_mpesa_transactions_merchant_request_id ON mpesa_transactions(merchant_request_id);
  CREATE INDEX IF NOT EXISTS idx_farmers_national_id ON farmers(national_id);
  CREATE INDEX IF NOT EXISTS idx_farmers_mpesa_phone ON farmers(mpesa_phone);
  CREATE INDEX IF NOT EXISTS idx_farmers_verification_status ON farmers(verification_status);
  CREATE INDEX IF NOT EXISTS idx_farmers_national_id_hash ON farmers(national_id_hash);
  CREATE INDEX IF NOT EXISTS idx_farmers_mpesa_phone_hash ON farmers(mpesa_phone_hash);
  CREATE INDEX IF NOT EXISTS idx_wallets_user_id ON wallets(user_id);
  CREATE INDEX IF NOT EXISTS idx_wallet_transactions_wallet_id ON wallet_transactions(wallet_id);
  CREATE INDEX IF NOT EXISTS idx_wallet_transactions_created_at ON wallet_transactions(created_at);
  CREATE INDEX IF NOT EXISTS idx_payment_requests_investor_id ON payment_requests(investor_id);
  CREATE INDEX IF NOT EXISTS idx_payment_requests_field_id ON payment_requests(field_id);
  CREATE INDEX IF NOT EXISTS idx_payment_requests_status ON payment_requests(status);
  CREATE INDEX IF NOT EXISTS idx_escrow_accounts_field_id ON escrow_accounts(field_id);
  CREATE INDEX IF NOT EXISTS idx_escrow_accounts_status ON escrow_accounts(status);
  CREATE INDEX IF NOT EXISTS idx_reconciliation_records_date ON reconciliation_records(reconciliation_date);
  CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id);
  CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at);
  CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs(entity_type, entity_id);
  CREATE INDEX IF NOT EXISTS idx_payment_queue_status ON payment_queue(status);
  CREATE INDEX IF NOT EXISTS idx_payment_queue_scheduled_at ON payment_queue(scheduled_at);

  -- Insert default system configuration
  INSERT OR IGNORE INTO system_config (key, value, description) VALUES 
    ('escrow_mode', 'disabled', 'Enable or disable escrow payment mode'),
    ('platform_fee_percentage', '5', 'Platform fee percentage'),
    ('tax_percentage', '0', 'Tax percentage'),
    ('max_payment_amount', '1000000', 'Maximum payment amount without additional verification'),
    ('payment_timeout_seconds', '300', 'Payment request timeout in seconds'),
    ('mpesa_retry_count', '3', 'Number of M-Pesa transaction retries'),
    ('auto_reconciliation', 'enabled', 'Enable automatic daily reconciliation');
`);

export default db;
