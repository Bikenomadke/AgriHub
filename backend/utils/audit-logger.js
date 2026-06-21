/**
 * Audit Logging Utility
 * 
 * This module provides tamper-resistant audit logging for security events:
 * - Login attempts
 * - Permission failures
 * - Role changes
 * - Data exports
 * - Sensitive record changes
 * - Integration changes
 * 
 * Features:
 * - Tamper-resistant design with cryptographic hashing
 * - User attribution
 * - Request ID correlation
 * - Structured logging
 */

import crypto from "crypto";
import { v4 as uuid } from "uuid";
import pool, { queryOne, queryMany } from "../db-postgres.js";

/**
 * Generate a unique request ID for correlation
 */
export function generateRequestId() {
  return uuid();
}

/**
 * Generate a tamper-resistant hash for audit log entry
 */
function generateAuditHash(logEntry) {
  const hashString = JSON.stringify({
    user_id: logEntry.user_id,
    action: logEntry.action,
    entity_type: logEntry.entity_type,
    entity_id: logEntry.entity_id,
    timestamp: logEntry.created_at,
    before_state: logEntry.before_state,
    after_state: logEntry.after_state,
  });
  
  return crypto.createHash('sha256').update(hashString).digest('hex');
}

/**
 * Log audit event
 */
export async function logAuditEvent({
  userId,
  action,
  entityType,
  entityId = null,
  amount = null,
  ipAddress = null,
  userAgent = null,
  deviceId = null,
  location = null,
  beforeState = null,
  afterState = null,
  transactionId = null,
  paymentRequestId = null,
  mpesaTransactionId = null,
  walletTransactionId = null,
  requestId = null,
  metadata = null,
}) {
  try {
    const id = uuid();
    const created_at = new Date().toISOString();
    
    const logEntry = {
      id,
      user_id: userId,
      action,
      entity_type: entityType,
      entity_id: entityId,
      amount,
      ip_address: ipAddress,
      user_agent: userAgent,
      device_id: deviceId,
      location,
      before_state: beforeState ? JSON.stringify(beforeState) : null,
      after_state: afterState ? JSON.stringify(afterState) : null,
      transaction_id: transactionId,
      payment_request_id: paymentRequestId,
      mpesa_transaction_id: mpesaTransactionId,
      wallet_transaction_id: walletTransactionId,
      created_at,
      request_id: requestId,
      metadata: metadata ? JSON.stringify(metadata) : null,
    };
    
    // Generate tamper-resistant hash
    const auditHash = generateAuditHash(logEntry);
    
    await pool.query(
      `INSERT INTO agrihub.audit_logs (
        id, user_id, action, entity_type, entity_id, amount,
        ip_address, user_agent, device_id, location,
        before_state, after_state, transaction_id, payment_request_id,
        mpesa_transaction_id, wallet_transaction_id, created_at, request_id, metadata, audit_hash
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
      [
        id, userId, action, entityType, entityId, amount,
        ipAddress, userAgent, deviceId, location,
        logEntry.before_state, logEntry.after_state, transactionId, paymentRequestId,
        mpesaTransactionId, walletTransactionId, created_at, requestId, logEntry.metadata, auditHash
      ]
    );
    
    return id;
  } catch (error) {
    console.error('Failed to log audit event:', error.message);
    // Don't throw error to avoid breaking application flow
    return null;
  }
}

/**
 * Verify audit log integrity
 */
export async function verifyAuditIntegrity(auditLogId) {
  try {
    const log = await queryOne("SELECT * FROM agrihub.audit_logs WHERE id = $1", [auditLogId]);
    if (!log) {
      return { valid: false, error: 'Audit log not found' };
    }
    
    const computedHash = generateAuditHash(log);
    const isValid = computedHash === log.audit_hash;
    
    return { valid: isValid, computedHash, storedHash: log.audit_hash };
  } catch (error) {
    return { valid: false, error: error.message };
  }
}

/**
 * Query audit logs with filters
 */
export async function queryAuditLogs({
  userId = null,
  action = null,
  entityType = null,
  entityId = null,
  startDate = null,
  endDate = null,
  limit = 100,
  offset = 0,
}) {
  try {
    let query = "SELECT * FROM agrihub.audit_logs WHERE 1=1";
    const params = [];
    let paramIndex = 1;
    
    if (userId) {
      query += ` AND user_id = $${paramIndex++}`;
      params.push(userId);
    }
    
    if (action) {
      query += ` AND action = $${paramIndex++}`;
      params.push(action);
    }
    
    if (entityType) {
      query += ` AND entity_type = $${paramIndex++}`;
      params.push(entityType);
    }
    
    if (entityId) {
      query += ` AND entity_id = $${paramIndex++}`;
      params.push(entityId);
    }
    
    if (startDate) {
      query += ` AND created_at >= $${paramIndex++}`;
      params.push(startDate);
    }
    
    if (endDate) {
      query += ` AND created_at <= $${paramIndex++}`;
      params.push(endDate);
    }
    
    query += ` ORDER BY created_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
    params.push(limit, offset);
    
    const logs = await queryMany(query, params);
    
    // Parse JSON fields
    return logs.map(log => ({
      ...log,
      before_state: log.before_state ? JSON.parse(log.before_state) : null,
      after_state: log.after_state ? JSON.parse(log.after_state) : null,
      metadata: log.metadata ? JSON.parse(log.metadata) : null,
    }));
  } catch (error) {
    console.error('Failed to query audit logs:', error.message);
    return [];
  }
}

/**
 * Get audit log statistics
 */
export async function getAuditStatistics({
  userId = null,
  startDate = null,
  endDate = null,
}) {
  try {
    let query = `
      SELECT 
        action,
        entity_type,
        COUNT(*) as count,
        SUM(amount) as total_amount
      FROM agrihub.audit_logs 
      WHERE 1=1
    `;
    const params = [];
    let paramIndex = 1;
    
    if (userId) {
      query += ` AND user_id = $${paramIndex++}`;
      params.push(userId);
    }
    
    if (startDate) {
      query += ` AND created_at >= $${paramIndex++}`;
      params.push(startDate);
    }
    
    if (endDate) {
      query += ` AND created_at <= $${paramIndex++}`;
      params.push(endDate);
    }
    
    query += " GROUP BY action, entity_type ORDER BY count DESC";
    
    return await queryMany(query, params);
  } catch (error) {
    console.error('Failed to get audit statistics:', error.message);
    return [];
  }
}

/**
 * Middleware to add request ID to request object
 */
export function auditMiddleware(req, res, next) {
  req.requestId = generateRequestId();
  req.auditLog = (eventData) => {
    return logAuditEvent({
      ...eventData,
      requestId: req.requestId,
      ipAddress: req.ip || req.connection.remoteAddress,
      userAgent: req.headers['user-agent'],
    });
  };
  next();
}

/**
 * Cleanup old audit logs (retention policy)
 */
export async function cleanupOldAuditLogs(retentionDays = 90) {
  try {
    const cutoffDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    
    const result = await pool.query(
      `DELETE FROM agrihub.audit_logs WHERE created_at < $1`,
      [cutoffDate]
    );
    
    console.log(`Cleaned up ${result.rowCount} old audit logs (older than ${retentionDays} days)`);
    
    return result.rowCount;
  } catch (error) {
    console.error('Failed to cleanup old audit logs:', error.message);
    return 0;
  }
}

/**
 * Export audit logs for compliance
 */
export async function exportAuditLogs({
  startDate,
  endDate,
  format = 'json',
}) {
  try {
    const logs = await queryAuditLogs({
      startDate,
      endDate,
      limit: 10000, // Maximum export limit
    });
    
    if (format === 'json') {
      return JSON.stringify(logs, null, 2);
    } else if (format === 'csv') {
      const headers = Object.keys(logs[0] || {}).join(',');
      const rows = logs.map(log => Object.values(log).join(','));
      return [headers, ...rows].join('\n');
    }
    
    return logs;
  } catch (error) {
    console.error('Failed to export audit logs:', error.message);
    return null;
  }
}

export default {
  logAuditEvent,
  verifyAuditIntegrity,
  queryAuditLogs,
  getAuditStatistics,
  auditMiddleware,
  cleanupOldAuditLogs,
  exportAuditLogs,
  generateRequestId,
};
