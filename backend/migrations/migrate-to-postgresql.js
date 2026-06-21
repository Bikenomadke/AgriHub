/**
 * Migration Script: SQLite to PostgreSQL
 * 
 * This script migrates data from SQLite to PostgreSQL with PostGIS.
 * It handles:
 * - TEXT IDs → UUID conversion
 * - TEXT polygon → PostGIS GEOMETRY
 * - JSON TEXT → JSONB
 * - INTEGER boolean → BOOLEAN
 * - datetime('now') → NOW()
 * 
 * Prerequisites:
 * - PostgreSQL with PostGIS extension installed and running
 * - SQLite database (agrihub.db) must exist
 * - Environment variables for PostgreSQL connection
 * 
 * Usage:
 *   node migrations/migrate-to-postgresql.js
 */

import Database from "better-sqlite3";
import { Pool } from "pg";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { v4 as uuidv4 } from "uuid";
import dotenv from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, "../.env") });

// SQLite connection
const sqlite = new Database(join(__dirname, "../agrihub.db"));

// PostgreSQL connection pool
const pgPool = new Pool({
  host: process.env.DB_HOST || "localhost",
  port: parseInt(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME || "agrihub",
  user: process.env.DB_USER || "agrihub",
  password: process.env.DB_PASSWORD,
  max: 10,
});

console.log("Starting migration from SQLite to PostgreSQL...");

// ID mapping cache (SQLite TEXT ID → PostgreSQL UUID)
const idMap = new Map();

/**
 * Generate or retrieve UUID for a given SQLite ID
 */
function getUuid(sqliteId) {
  if (!sqliteId) return null;
  
  if (idMap.has(sqliteId)) {
    return idMap.get(sqliteId);
  }
  
  const uuid = uuidv4();
  idMap.set(sqliteId, uuid);
  return uuid;
}

/**
 * Convert SQLite datetime to PostgreSQL timestamp
 */
function convertDateTime(sqliteDateTime) {
  if (!sqliteDateTime) return null;
  return new Date(sqliteDateTime).toISOString();
}

/**
 * Convert SQLite INTEGER to PostgreSQL BOOLEAN
 */
function convertBoolean(intValue) {
  if (intValue === null || intValue === undefined) return null;
  return intValue === 1 || intValue === true;
}

/**
 * Convert TEXT polygon to PostGIS GEOMETRY
 * Expects polygon as JSON array of coordinates: [[lat, lng], ...]
 */
function convertPolygon(polygonText) {
  if (!polygonText) return null;
  
  try {
    const coordinates = JSON.parse(polygonText);
    if (!Array.isArray(coordinates) || coordinates.length < 3) {
      console.warn(`Invalid polygon format: ${polygonText}`);
      return null;
    }
    
    // Convert to GeoJSON format for PostGIS
    const geojson = {
      type: "Polygon",
      coordinates: [coordinates.map(coord => [coord[1], coord[0]])] // Swap lat/lng to lng/lat
    };
    
    return JSON.stringify(geojson);
  } catch (error) {
    console.error(`Failed to parse polygon: ${polygonText}`, error.message);
    return null;
  }
}

/**
 * Convert TEXT JSON to JSONB
 */
function convertJson(jsonText) {
  if (!jsonText) return null;
  try {
    const parsed = JSON.parse(jsonText);
    return JSON.stringify(parsed);
  } catch (error) {
    console.error(`Failed to parse JSON: ${jsonText}`, error.message);
    return null;
  }
}

/**
 * Migrate users table
 */
async function migrateUsers() {
  console.log("\nMigrating users...");
  
  const users = sqlite.prepare("SELECT * FROM users").all();
  console.log(`Found ${users.length} users`);
  
  for (const user of users) {
    const uuid = getUuid(user.id);
    
    await pgPool.query(
      `INSERT INTO agrihub.users (
        id, username, password, role, name, color, phone, email,
        kyc_verified, pin_hash, mfa_enabled, mfa_secret, mfa_backup_codes,
        mfa_enabled_at, mfa_disabled_at, created_at, updated_at, deleted_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
      ON CONFLICT (username) DO NOTHING`,
      [
        uuid,
        user.username,
        user.password,
        user.role,
        user.name,
        user.color,
        user.phone,
        user.email,
        convertBoolean(user.kyc_verified),
        user.pin_hash,
        convertBoolean(user.mfa_enabled),
        user.mfa_secret,
        user.mfa_backup_codes,
        convertDateTime(user.mfa_enabled_at),
        convertDateTime(user.mfa_disabled_at),
        convertDateTime(user.created_at),
        convertDateTime(user.updated_at),
        convertDateTime(user.deleted_at),
      ]
    );
  }
  
  console.log(`✓ Migrated ${users.length} users`);
}

/**
 * Migrate sessions table
 */
async function migrateSessions() {
  console.log("\nMigrating sessions...");
  
  const sessions = sqlite.prepare("SELECT * FROM sessions").all();
  console.log(`Found ${sessions.length} sessions`);
  
  for (const session of sessions) {
    const uuid = getUuid(session.id);
    const userId = getUuid(session.user_id);
    
    await pgPool.query(
      `INSERT INTO agrihub.sessions (
        id, user_id, device_id, device_name, device_type, device_os,
        ip_address, user_agent, location_country, location_city,
        refresh_token_hash, access_token_hash, expires_at,
        last_used_at, created_at, revoked_at, revoked_reason
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
      ON CONFLICT DO NOTHING`,
      [
        uuid,
        userId,
        session.device_id,
        session.device_name,
        session.device_type,
        session.device_os,
        session.ip_address,
        session.user_agent,
        session.location_country,
        session.location_city,
        session.refresh_token_hash,
        session.access_token_hash,
        convertDateTime(session.expires_at),
        convertDateTime(session.last_used_at),
        convertDateTime(session.created_at),
        convertDateTime(session.revoked_at),
        session.revoked_reason,
      ]
    );
  }
  
  console.log(`✓ Migrated ${sessions.length} sessions`);
}

/**
 * Migrate farmers table
 */
async function migrateFarmers() {
  console.log("\nMigrating farmers...");
  
  const farmers = sqlite.prepare("SELECT * FROM farmers").all();
  console.log(`Found ${farmers.length} farmers`);
  
  for (const farmer of farmers) {
    const uuid = getUuid(farmer.id);
    
    await pgPool.query(
      `INSERT INTO agrihub.farmers (
        id, full_name, national_id, mpesa_phone, alternate_phone,
        county, subcounty, ward, verification_status, otp_code,
        otp_expires_at, mpesa_registered, kyc_document_url,
        national_id_hash, mpesa_phone_hash, created_at, updated_at, deleted_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
      ON CONFLICT (national_id) DO NOTHING`,
      [
        uuid,
        farmer.full_name,
        farmer.national_id,
        farmer.mpesa_phone,
        farmer.alternate_phone,
        farmer.county,
        farmer.subcounty,
        farmer.ward,
        farmer.verification_status,
        farmer.otp_code,
        convertDateTime(farmer.otp_expires_at),
        convertBoolean(farmer.mpesa_registered),
        farmer.kyc_document_url,
        farmer.national_id_hash,
        farmer.mpesa_phone_hash,
        convertDateTime(farmer.created_at),
        convertDateTime(farmer.updated_at),
        convertDateTime(farmer.deleted_at),
      ]
    );
  }
  
  console.log(`✓ Migrated ${farmers.length} farmers`);
}

/**
 * Migrate fields table with PostGIS polygon conversion
 */
async function migrateFields() {
  console.log("\nMigrating fields...");
  
  const fields = sqlite.prepare("SELECT * FROM fields").all();
  console.log(`Found ${fields.length} fields`);
  
  for (const field of fields) {
    const uuid = getUuid(field.id);
    const createdBy = getUuid(field.created_by);
    const farmerId = getUuid(field.farmer_id);
    const investorId = getUuid(field.investor_id);
    const polygonGeojson = convertPolygon(field.polygon);
    const sitesJsonb = convertJson(field.sites);
    
    // Convert polygon to PostGIS geometry
    let polygonGeometry = null;
    if (polygonGeojson) {
      try {
        const result = await pgPool.query(
          `SELECT ST_SetSRID(ST_GeomFromGeoJSON($1), 4326) as geom`,
          [polygonGeojson]
        );
        polygonGeometry = result.rows[0].geom;
      } catch (error) {
        console.error(`Failed to convert polygon for field ${field.id}:`, error.message);
      }
    }
    
    await pgPool.query(
      `INSERT INTO agrihub.fields (
        id, name, area_acres, estimated_total_tons, buying_price_per_acre,
        polygon, avg_nodes, avg_stalks, survey_date, farmer_signature,
        sites, harvest, status, farmer_id, investor_id, valuation,
        harvest_cost, transport_cost, pulling_cost, platform_fee, tax_amount,
        created_by, created_at, updated_at, deleted_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24)
      ON CONFLICT DO NOTHING`,
      [
        uuid,
        field.name,
        field.area_acres,
        field.estimated_total_tons,
        field.buying_price_per_acre,
        polygonGeometry,
        field.avg_nodes,
        field.avg_stalks,
        field.survey_date ? new Date(field.survey_date).toISOString().split('T')[0] : null,
        field.farmer_signature,
        sitesJsonb,
        field.harvest,
        field.status,
        farmerId,
        investorId,
        field.valuation,
        field.harvest_cost,
        field.transport_cost,
        field.pulling_cost,
        field.platform_fee,
        field.tax_amount,
        createdBy,
        convertDateTime(field.created_at),
        convertDateTime(field.updated_at),
        convertDateTime(field.deleted_at),
      ]
    );
  }
  
  console.log(`✓ Migrated ${fields.length} fields`);
}

/**
 * Migrate wallets table
 */
async function migrateWallets() {
  console.log("\nMigrating wallets...");
  
  const wallets = sqlite.prepare("SELECT * FROM wallets").all();
  console.log(`Found ${wallets.length} wallets`);
  
  for (const wallet of wallets) {
    const uuid = getUuid(wallet.id);
    const userId = getUuid(wallet.user_id);
    
    await pgPool.query(
      `INSERT INTO agrihub.wallets (
        id, user_id, balance, available_balance, frozen_balance,
        currency, status, created_at, updated_at, deleted_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (user_id) DO NOTHING`,
      [
        uuid,
        userId,
        wallet.balance,
        wallet.available_balance,
        wallet.frozen_balance,
        wallet.currency,
        wallet.status,
        convertDateTime(wallet.created_at),
        convertDateTime(wallet.updated_at),
        convertDateTime(wallet.deleted_at),
      ]
    );
  }
  
  console.log(`✓ Migrated ${wallets.length} wallets`);
}

/**
 * Migrate transactions table
 */
async function migrateTransactions() {
  console.log("\nMigrating transactions...");
  
  const transactions = sqlite.prepare("SELECT * FROM transactions").all();
  console.log(`Found ${transactions.length} transactions`);
  
  for (const txn of transactions) {
    const uuid = getUuid(txn.id);
    const fieldId = getUuid(txn.field_id);
    const farmerId = getUuid(txn.farmer_id);
    const investorId = getUuid(txn.investor_id);
    const createdBy = getUuid(txn.created_by);
    const walletTxnId = getUuid(txn.wallet_transaction_id);
    const escrowTxnId = getUuid(txn.escrow_transaction_id);
    
    await pgPool.query(
      `INSERT INTO agrihub.transactions (
        id, farmer_name, tons, buy_price, total_cost, expected_payout,
        gross_profit, date, note, ticket_number, ticket_image,
        payment_status, payment_method, payment_phone, payment_amount,
        payment_reference, payment_date, field_id, farmer_id, investor_id,
        wallet_transaction_id, escrow_transaction_id, created_by,
        created_at, updated_at, deleted_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26)
      ON CONFLICT DO NOTHING`,
      [
        uuid,
        txn.farmer_name,
        txn.tons,
        txn.buy_price,
        txn.total_cost,
        txn.expected_payout,
        txn.gross_profit,
        txn.date ? new Date(txn.date).toISOString().split('T')[0] : null,
        txn.note,
        txn.ticket_number,
        txn.ticket_image,
        txn.payment_status,
        txn.payment_method,
        txn.payment_phone,
        txn.payment_amount,
        txn.payment_reference,
        txn.payment_date ? new Date(txn.payment_date).toISOString().split('T')[0] : null,
        fieldId,
        farmerId,
        investorId,
        walletTxnId,
        escrowTxnId,
        createdBy,
        convertDateTime(txn.created_at),
        convertDateTime(txn.updated_at),
        convertDateTime(txn.deleted_at),
      ]
    );
  }
  
  console.log(`✓ Migrated ${transactions.length} transactions`);
}

/**
 * Migrate remaining tables
 */
async function migrateRemainingTables() {
  console.log("\nMigrating remaining tables...");
  
  // Wallet transactions
  const walletTxns = sqlite.prepare("SELECT * FROM wallet_transactions").all();
  console.log(`Found ${walletTxns.length} wallet transactions`);
  
  for (const txn of walletTxns) {
    const uuid = getUuid(txn.id);
    const walletId = getUuid(txn.wallet_id);
    const relatedTxnId = getUuid(txn.related_transaction_id);
    const relatedEscrowId = getUuid(txn.related_escrow_id);
    const metadataJsonb = convertJson(txn.metadata);
    
    await pgPool.query(
      `INSERT INTO agrihub.wallet_transactions (
        id, wallet_id, transaction_type, amount, balance_before, balance_after,
        reference, description, related_transaction_id, related_escrow_id,
        status, metadata, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      ON CONFLICT DO NOTHING`,
      [
        uuid,
        walletId,
        txn.transaction_type,
        txn.amount,
        txn.balance_before,
        txn.balance_after,
        txn.reference,
        txn.description,
        relatedTxnId,
        relatedEscrowId,
        txn.status,
        metadataJsonb,
        convertDateTime(txn.created_at),
      ]
    );
  }
  
  console.log(`✓ Migrated ${walletTxns.length} wallet transactions`);
  
  // Payment requests
  const paymentRequests = sqlite.prepare("SELECT * FROM payment_requests").all();
  console.log(`Found ${paymentRequests.length} payment requests`);
  
  for (const req of paymentRequests) {
    const uuid = getUuid(req.id);
    const investorId = getUuid(req.investor_id);
    const farmerId = getUuid(req.farmer_id);
    const fieldId = getUuid(req.field_id);
    
    await pgPool.query(
      `INSERT INTO agrihub.payment_requests (
        id, investor_id, farmer_id, field_id, amount, farmer_payment,
        harvest_cost, transport_cost, pulling_cost, platform_fee, tax_amount,
        gross_amount, net_amount, status, payment_method, auth_method,
        auth_verified, expires_at, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
      ON CONFLICT DO NOTHING`,
      [
        uuid,
        investorId,
        farmerId,
        fieldId,
        req.amount,
        req.farmer_payment,
        req.harvest_cost,
        req.transport_cost,
        req.pulling_cost,
        req.platform_fee,
        req.tax_amount,
        req.gross_amount,
        req.net_amount,
        req.status,
        req.payment_method,
        req.auth_method,
        convertBoolean(req.auth_verified),
        convertDateTime(req.expires_at),
        convertDateTime(req.created_at),
        convertDateTime(req.updated_at),
      ]
    );
  }
  
  console.log(`✓ Migrated ${paymentRequests.length} payment requests`);
  
  // M-Pesa transactions
  const mpesaTxns = sqlite.prepare("SELECT * FROM mpesa_transactions").all();
  console.log(`Found ${mpesaTxns.length} M-Pesa transactions`);
  
  for (const txn of mpesaTxns) {
    const uuid = getUuid(txn.id);
    const transactionId = getUuid(txn.transaction_id);
    const paymentRequestId = getUuid(txn.payment_request_id);
    const callbackDataJsonb = convertJson(txn.callback_data);
    
    await pgPool.query(
      `INSERT INTO agrihub.mpesa_transactions (
        id, transaction_id, payment_request_id, transaction_type, phone, amount,
        merchant_request_id, checkout_request_id, originator_conversation_id,
        conversation_id, mpesa_receipt_number, transaction_date, result_code,
        result_description, response_code, response_description, callback_received,
        callback_data, status, retry_count, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)
      ON CONFLICT DO NOTHING`,
      [
        uuid,
        transactionId,
        paymentRequestId,
        txn.transaction_type,
        txn.phone,
        txn.amount,
        txn.merchant_request_id,
        txn.checkout_request_id,
        txn.originator_conversation_id,
        txn.conversation_id,
        txn.mpesa_receipt_number,
        txn.transaction_date ? new Date(txn.transaction_date).toISOString().split('T')[0] : null,
        txn.result_code,
        txn.result_description,
        txn.response_code,
        txn.response_description,
        convertBoolean(txn.callback_received),
        callbackDataJsonb,
        txn.status,
        txn.retry_count,
        convertDateTime(txn.created_at),
        convertDateTime(txn.updated_at),
      ]
    );
  }
  
  console.log(`✓ Migrated ${mpesaTxns.length} M-Pesa transactions`);
  
  // Escrow accounts
  const escrowAccounts = sqlite.prepare("SELECT * FROM escrow_accounts").all();
  console.log(`Found ${escrowAccounts.length} escrow accounts`);
  
  for (const escrow of escrowAccounts) {
    const uuid = getUuid(escrow.id);
    const investorId = getUuid(escrow.investor_id);
    const farmerId = getUuid(escrow.farmer_id);
    const fieldId = getUuid(escrow.field_id);
    const transactionId = getUuid(escrow.transaction_id);
    
    await pgPool.query(
      `INSERT INTO agrihub.escrow_accounts (
        id, investor_id, farmer_id, field_id, transaction_id, amount,
        release_conditions, status, released_amount, released_at,
        refund_amount, refunded_at, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      ON CONFLICT DO NOTHING`,
      [
        uuid,
        investorId,
        farmerId,
        fieldId,
        transactionId,
        escrow.amount,
        escrow.release_conditions,
        escrow.status,
        escrow.released_amount,
        convertDateTime(escrow.released_at),
        escrow.refund_amount,
        convertDateTime(escrow.refunded_at),
        convertDateTime(escrow.created_at),
        convertDateTime(escrow.updated_at),
      ]
    );
  }
  
  console.log(`✓ Migrated ${escrowAccounts.length} escrow accounts`);
  
  // Reconciliation records
  const reconciliationRecords = sqlite.prepare("SELECT * FROM reconciliation_records").all();
  console.log(`Found ${reconciliationRecords.length} reconciliation records`);
  
  for (const record of reconciliationRecords) {
    const uuid = getUuid(record.id);
    const performedBy = getUuid(record.performed_by);
    
    await pgPool.query(
      `INSERT INTO agrihub.reconciliation_records (
        id, reconciliation_date, period_type, start_date, end_date,
        total_transactions, total_amount, mpesa_total_amount, matched_transactions,
        unmatched_transactions, failed_transactions, reversal_count, status,
        discrepancies, performed_by, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
      ON CONFLICT DO NOTHING`,
      [
        uuid,
        record.reconciliation_date ? new Date(record.reconciliation_date).toISOString().split('T')[0] : null,
        record.period_type,
        record.start_date ? new Date(record.start_date).toISOString().split('T')[0] : null,
        record.end_date ? new Date(record.end_date).toISOString().split('T')[0] : null,
        record.total_transactions,
        record.total_amount,
        record.mpesa_total_amount,
        record.matched_transactions,
        record.unmatched_transactions,
        record.failed_transactions,
        record.reversal_count,
        record.status,
        record.discrepancies,
        performedBy,
        convertDateTime(record.created_at),
        convertDateTime(record.updated_at),
      ]
    );
  }
  
  console.log(`✓ Migrated ${reconciliationRecords.length} reconciliation records`);
  
  // Audit logs
  const auditLogs = sqlite.prepare("SELECT * FROM audit_logs").all();
  console.log(`Found ${auditLogs.length} audit logs`);
  
  for (const log of auditLogs) {
    const uuid = getUuid(log.id);
    const userId = getUuid(log.user_id);
    const entityId = getUuid(log.entity_id);
    const transactionId = getUuid(log.transaction_id);
    const paymentRequestId = getUuid(log.payment_request_id);
    const mpesaTransactionId = getUuid(log.mpesa_transaction_id);
    const walletTransactionId = getUuid(log.wallet_transaction_id);
    const beforeStateJsonb = convertJson(log.before_state);
    const afterStateJsonb = convertJson(log.after_state);
    
    await pgPool.query(
      `INSERT INTO agrihub.audit_logs (
        id, user_id, action, entity_type, entity_id, amount, ip_address,
        user_agent, device_id, location, before_state, after_state,
        transaction_id, payment_request_id, mpesa_transaction_id,
        wallet_transaction_id, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
      ON CONFLICT DO NOTHING`,
      [
        uuid,
        userId,
        log.action,
        log.entity_type,
        entityId,
        log.amount,
        log.ip_address,
        log.user_agent,
        log.device_id,
        log.location,
        beforeStateJsonb,
        afterStateJsonb,
        transactionId,
        paymentRequestId,
        mpesaTransactionId,
        walletTransactionId,
        convertDateTime(log.created_at),
      ]
    );
  }
  
  console.log(`✓ Migrated ${auditLogs.length} audit logs`);
  
  // M-Pesa requests
  const mpesaRequests = sqlite.prepare("SELECT * FROM mpesa_requests").all();
  console.log(`Found ${mpesaRequests.length} M-Pesa requests`);
  
  for (const req of mpesaRequests) {
    const uuid = getUuid(req.id);
    const transactionId = getUuid(req.transaction_id);
    
    await pgPool.query(
      `INSERT INTO agrihub.mpesa_requests (
        id, transaction_id, phone, amount, reference, merchant_request_id,
        checkout_request_id, response_code, response_description, result_code,
        result_description, status, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      ON CONFLICT DO NOTHING`,
      [
        uuid,
        transactionId,
        req.phone,
        req.amount,
        req.reference,
        req.merchant_request_id,
        req.checkout_request_id,
        req.response_code,
        req.response_description,
        req.result_code,
        req.result_description,
        req.status,
        convertDateTime(req.created_at),
        convertDateTime(req.updated_at),
      ]
    );
  }
  
  console.log(`✓ Migrated ${mpesaRequests.length} M-Pesa requests`);
  
  // Payment queue
  const paymentQueue = sqlite.prepare("SELECT * FROM payment_queue").all();
  console.log(`Found ${paymentQueue.length} payment queue items`);
  
  for (const item of paymentQueue) {
    const uuid = getUuid(item.id);
    const paymentRequestId = getUuid(item.payment_request_id);
    const mpesaTransactionId = getUuid(item.mpesa_transaction_id);
    
    await pgPool.query(
      `INSERT INTO agrihub.payment_queue (
        id, payment_request_id, mpesa_transaction_id, priority, status,
        retry_count, max_retries, error_message, scheduled_at, started_at,
        completed_at, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      ON CONFLICT DO NOTHING`,
      [
        uuid,
        paymentRequestId,
        mpesaTransactionId,
        item.priority,
        item.status,
        item.retry_count,
        item.max_retries,
        item.error_message,
        convertDateTime(item.scheduled_at),
        convertDateTime(item.started_at),
        convertDateTime(item.completed_at),
        convertDateTime(item.created_at),
        convertDateTime(item.updated_at),
      ]
    );
  }
  
  console.log(`✓ Migrated ${paymentQueue.length} payment queue items`);
  
  // System config
  const systemConfig = sqlite.prepare("SELECT * FROM system_config").all();
  console.log(`Found ${systemConfig.length} system config items`);
  
  for (const config of systemConfig) {
    await pgPool.query(
      `INSERT INTO agrihub.system_config (key, value, description, updated_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (key) DO UPDATE SET value = $2, description = $3, updated_at = $4`,
      [
        config.key,
        config.value,
        config.description,
        convertDateTime(config.updated_at),
      ]
    );
  }
  
  console.log(`✓ Migrated ${systemConfig.length} system config items`);
}

/**
 * Validate migration
 */
async function validateMigration() {
  console.log("\nValidating migration...");
  
  const tables = [
    'users', 'sessions', 'fields', 'transactions', 'farmers',
    'wallets', 'wallet_transactions', 'payment_requests', 'mpesa_transactions',
    'escrow_accounts', 'reconciliation_records', 'audit_logs', 'mpesa_requests',
    'system_config', 'payment_queue'
  ];
  
  let totalErrors = 0;
  
  for (const table of tables) {
    const sqliteCount = sqlite.prepare(`SELECT COUNT(*) as count FROM ${table}`).get().count;
    const pgResult = await pgPool.query(`SELECT COUNT(*) as count FROM agrihub.${table}`);
    const pgCount = parseInt(pgResult.rows[0].count);
    
    if (sqliteCount !== pgCount) {
      console.error(`✗ ${table}: SQLite=${sqliteCount}, PostgreSQL=${pgCount} (MISMATCH)`);
      totalErrors++;
    } else {
      console.log(`✓ ${table}: ${sqliteCount} records`);
    }
  }
  
  if (totalErrors > 0) {
    console.error(`\n❌ Validation failed: ${totalErrors} table(s) have record count mismatches`);
    process.exit(1);
  } else {
    console.log(`\n✅ Validation successful: All tables migrated correctly`);
  }
}

/**
 * Main migration function
 */
async function main() {
  try {
    // Test PostgreSQL connection
    await pgPool.query('SELECT NOW()');
    console.log('✓ PostgreSQL connection successful');
    
    // Run migrations in dependency order
    await migrateUsers();
    await migrateFarmers();
    await migrateSessions();
    await migrateWallets();
    await migrateFields();
    await migrateTransactions();
    await migrateRemainingTables();
    
    // Validate
    await validateMigration();
    
    console.log('\n✅ Migration completed successfully!');
    
  } catch (error) {
    console.error('\n❌ Migration failed:', error);
    process.exit(1);
  } finally {
    sqlite.close();
    await pgPool.end();
  }
}

main();
