/**
 * Soft Delete Utility
 * 
 * This module provides soft delete functionality for database records:
 * - Soft delete (mark as deleted with timestamp)
 * - Restore (undelete)
 * - Hard delete (permanent removal)
 * - Query non-deleted records
 * - Query deleted records
 */

import pool, { queryOne, queryMany } from "../db-postgres.js";

/**
 * Soft delete a record
 */
export async function softDelete(tableName, id, userId = null) {
  try {
    const fullTableName = `agrihub.${tableName}`;
    const result = await pool.query(
      `UPDATE ${fullTableName}
      SET deleted_at = NOW(),
          updated_at = NOW()
      WHERE id = $1 AND deleted_at IS NULL`,
      [id]
    );
    
    if (result.rowCount === 0) {
      return { success: false, error: 'Record not found or already deleted' };
    }
    
    return { success: true, deletedAt: new Date().toISOString() };
  } catch (error) {
    console.error(`Soft delete error for ${tableName}:`, error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Restore a soft-deleted record
 */
export async function restore(tableName, id, userId = null) {
  try {
    const fullTableName = `agrihub.${tableName}`;
    const result = await pool.query(
      `UPDATE ${fullTableName}
      SET deleted_at = NULL,
          updated_at = NOW()
      WHERE id = $1 AND deleted_at IS NOT NULL`,
      [id]
    );
    
    if (result.rowCount === 0) {
      return { success: false, error: 'Record not found or not deleted' };
    }
    
    return { success: true };
  } catch (error) {
    console.error(`Restore error for ${tableName}:`, error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Hard delete a record (permanent removal)
 */
export async function hardDelete(tableName, id, userId = null) {
  try {
    const fullTableName = `agrihub.${tableName}`;
    const result = await pool.query(`DELETE FROM ${fullTableName} WHERE id = $1`, [id]);
    
    if (result.rowCount === 0) {
      return { success: false, error: 'Record not found' };
    }
    
    return { success: true };
  } catch (error) {
    console.error(`Hard delete error for ${tableName}:`, error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Get non-deleted records
 */
export async function getActiveRecords(tableName, whereClause = '', params = []) {
  try {
    const fullTableName = `agrihub.${tableName}`;
    let query = `SELECT * FROM ${fullTableName} WHERE deleted_at IS NULL`;
    
    if (whereClause) {
      query += ` AND ${whereClause}`;
    }
    
    return await queryMany(query, params);
  } catch (error) {
    console.error(`Query error for ${tableName}:`, error.message);
    return [];
  }
}

/**
 * Get deleted records
 */
export async function getDeletedRecords(tableName, whereClause = '', params = []) {
  try {
    const fullTableName = `agrihub.${tableName}`;
    let query = `SELECT * FROM ${fullTableName} WHERE deleted_at IS NOT NULL`;
    
    if (whereClause) {
      query += ` AND ${whereClause}`;
    }
    
    return await queryMany(query, params);
  } catch (error) {
    console.error(`Query error for ${tableName}:`, error.message);
    return [];
  }
}

/**
 * Get all records (including deleted)
 */
export async function getAllRecords(tableName, whereClause = '', params = []) {
  try {
    const fullTableName = `agrihub.${tableName}`;
    let query = `SELECT * FROM ${fullTableName} WHERE 1=1`;
    
    if (whereClause) {
      query += ` AND ${whereClause}`;
    }
    
    return await queryMany(query, params);
  } catch (error) {
    console.error(`Query error for ${tableName}:`, error.message);
    return [];
  }
}

/**
 * Middleware to automatically filter deleted records
 */
export function filterDeleted(tableName) {
  return (req, res, next) => {
    const originalQuery = db.prepare;
    
    // Override the prepare method for this request
    db.prepare = function(sql) {
      // Check if this is a SELECT query on the specified table
      if (sql.trim().toUpperCase().startsWith('SELECT') && sql.includes(tableName)) {
        // Add WHERE deleted_at IS NULL if not already present
        if (!sql.toLowerCase().includes('deleted_at')) {
          // Simple injection - add WHERE clause
          if (sql.toLowerCase().includes('where')) {
            sql = sql.replace(/where/i, 'WHERE deleted_at IS NULL AND');
          } else {
            sql = sql.replace(/from/i, `FROM ${tableName} WHERE deleted_at IS NULL`);
          }
        }
      }
      
      return originalQuery.call(db, sql);
    };
    
    next();
  };
}

/**
 * Cleanup old deleted records
 * Permanently delete records that have been soft-deleted for longer than retention period
 */
export async function cleanupOldDeletedRecords(tableName, retentionDays = 90) {
  try {
    const fullTableName = `agrihub.${tableName}`;
    const cutoffDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    
    const result = await pool.query(
      `DELETE FROM ${fullTableName}
      WHERE deleted_at < $1`,
      [cutoffDate]
    );
    
    console.log(`Cleaned up ${result.rowCount} old deleted records from ${tableName} (older than ${retentionDays} days)`);
    
    return result.rowCount;
  } catch (error) {
    console.error(`Cleanup error for ${tableName}:`, error.message);
    return 0;
  }
}

/**
 * Get deleted record count
 */
export async function getDeletedCount(tableName) {
  try {
    const fullTableName = `agrihub.${tableName}`;
    const result = await queryOne(`SELECT COUNT(*) as count FROM ${fullTableName} WHERE deleted_at IS NOT NULL`);
    return result.count;
  } catch (error) {
    console.error(`Count error for ${tableName}:`, error.message);
    return 0;
  }
}

/**
 * Get active record count
 */
export async function getActiveCount(tableName) {
  try {
    const fullTableName = `agrihub.${tableName}`;
    const result = await queryOne(`SELECT COUNT(*) as count FROM ${fullTableName} WHERE deleted_at IS NULL`);
    return result.count;
  } catch (error) {
    console.error(`Count error for ${tableName}:`, error.message);
    return 0;
  }
}

export default {
  softDelete,
  restore,
  hardDelete,
  getActiveRecords,
  getDeletedRecords,
  getAllRecords,
  filterDeleted,
  cleanupOldDeletedRecords,
  getDeletedCount,
  getActiveCount,
};
