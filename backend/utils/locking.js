import pool, { queryOne } from "../db-postgres.js";
import { v4 as uuid } from "uuid";

// ─── Distributed Locking System ──────────────────────────────────────────────────
class DistributedLock {
  constructor() {
    this.locks = new Map();
    this.lockTimeout = 30000; // 30 seconds default
  }

  /**
   * Acquire a distributed lock for a resource
   * @param {string} resource - Unique identifier for the resource to lock
   * @param {string} ownerId - Unique identifier for the lock owner
   * @param {number} ttl - Time to live in milliseconds (default: 30000)
   * @returns {Promise<boolean>} - True if lock acquired, false otherwise
   */
  async acquire(resource, ownerId, ttl = this.lockTimeout) {
    try {
      const now = new Date().toISOString();
      const expiresAt = new Date(Date.now() + ttl).toISOString();

      // Check if lock already exists and is not expired
      const existingLock = await queryOne(
        `SELECT * FROM agrihub.distributed_locks 
        WHERE resource = $1 AND expires_at > NOW()`,
        [resource]
      );

      if (existingLock) {
        // Lock exists and is still valid
        if (existingLock.owner_id === ownerId) {
          // Same owner, extend the lock
          await pool.query(
            `UPDATE agrihub.distributed_locks 
            SET expires_at = $1, updated_at = NOW()
            WHERE resource = $2 AND owner_id = $3`,
            [expiresAt, resource, ownerId]
          );
          return true;
        }
        return false;
      }

      // Acquire new lock
      await pool.query(
        `INSERT INTO agrihub.distributed_locks (id, resource, owner_id, expires_at, created_at, updated_at)
        VALUES ($1, $2, $3, $4, NOW(), NOW())`,
        [uuid(), resource, ownerId, expiresAt]
      );

      // Also keep in memory for fast access
      this.locks.set(resource, { ownerId, expiresAt });

      return true;
    } catch (err) {
      console.error("Error acquiring lock:", err);
      return false;
    }
  }

  /**
   * Release a distributed lock
   * @param {string} resource - Resource identifier
   * @param {string} ownerId - Lock owner identifier
   * @returns {Promise<boolean>} - True if lock released, false otherwise
   */
  async release(resource, ownerId) {
    try {
      const result = await pool.query(
        `DELETE FROM agrihub.distributed_locks 
        WHERE resource = $1 AND owner_id = $2`,
        [resource, ownerId]
      );

      // Remove from memory
      this.locks.delete(resource);

      return result.rowCount > 0;
    } catch (err) {
      console.error("Error releasing lock:", err);
      return false;
    }
  }

  /**
   * Check if a resource is locked
   * @param {string} resource - Resource identifier
   * @returns {Promise<boolean>} - True if locked, false otherwise
   */
  async isLocked(resource) {
    try {
      const lock = await queryOne(
        `SELECT * FROM agrihub.distributed_locks 
        WHERE resource = $1 AND expires_at > NOW()`,
        [resource]
      );

      return !!lock;
    } catch (err) {
      console.error("Error checking lock:", err);
      return false;
    }
  }

  /**
   * Clean up expired locks
   * @returns {Promise<number>} - Number of locks cleaned up
   */
  async cleanupExpiredLocks() {
    try {
      const result = await pool.query(
        `DELETE FROM agrihub.distributed_locks 
        WHERE expires_at <= NOW()`
      );

      // Clean up memory locks
      const now = new Date();
      for (const [resource, lock] of this.locks.entries()) {
        if (new Date(lock.expiresAt) < now) {
          this.locks.delete(resource);
        }
      }

      return result.rowCount;
    } catch (err) {
      console.error("Error cleaning up locks:", err);
      return 0;
    }
  }

  /**
   * Execute a function with a lock (with automatic release)
   * @param {string} resource - Resource identifier
   * @param {string} ownerId - Lock owner identifier
   * @param {Function} fn - Function to execute while holding lock
   * @param {number} ttl - Lock time to live
   * @returns {Promise<any>} - Result of the function
   */
  async withLock(resource, ownerId, fn, ttl = this.lockTimeout) {
    const acquired = await this.acquire(resource, ownerId, ttl);
    
    if (!acquired) {
      throw new Error(`Could not acquire lock for resource: ${resource}`);
    }

    try {
      return await fn();
    } finally {
      await this.release(resource, ownerId);
    }
  }
}

// Initialize distributed locks table
async function initializeLockTable() {
  await pool.exec(`
    CREATE TABLE IF NOT EXISTS agrihub.distributed_locks (
      id TEXT PRIMARY KEY,
      resource TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_distributed_locks_resource ON agrihub.distributed_locks(resource);
    CREATE INDEX IF NOT EXISTS idx_distributed_locks_expires ON agrihub.distributed_locks(expires_at);
  `);
}

initializeLockTable();

// Export singleton instance
const distributedLock = new DistributedLock();

// Start periodic cleanup of expired locks (every 5 minutes)
setInterval(() => {
  distributedLock.cleanupExpiredLocks();
}, 5 * 60 * 1000);

export default distributedLock;
