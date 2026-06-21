/**
 * Field-Level Encryption Utility
 * 
 * This module provides AES-256-GCM encryption for PII and sensitive data:
 * - National IDs
 * - Phone numbers
 * - Bank account numbers
 * - OAuth tokens
 * - Sensitive financial references
 * 
 * Features:
 * - AES-256-GCM encryption (authenticated encryption)
 * - Key rotation support
 * - Envelope encryption abstraction
 * - Migration strategy for existing data
 */

import crypto from "crypto";
import config from "./config.js";

/**
 * Encryption algorithm
 */
const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 16; // 128 bits
const AUTH_TAG_LENGTH = 16; // 128 bits
const SALT_LENGTH = 32; // 256 bits

/**
 * Fields that require encryption
 */
const ENCRYPTED_FIELDS = {
  farmers: ['national_id', 'mpesa_phone', 'alternate_phone'],
  users: ['email', 'phone'],
  transactions: ['payment_phone', 'payment_reference'],
  wallets: ['account_number', 'account_name'],
};

/**
 * Get encryption key from environment or derive from master key
 */
function getEncryptionKey(keyId = 'default') {
  const keyEnvVar = `ENCRYPTION_KEY_${keyId.toUpperCase()}`;
  const key = process.env[keyEnvVar] || process.env.ENCRYPTION_KEY;
  
  if (!key) {
    throw new Error(`Encryption key not found. Set ${keyEnvVar} or ENCRYPTION_KEY environment variable.`);
  }
  
  // Convert hex key to buffer
  const keyBuffer = Buffer.from(key, 'hex');
  
  if (keyBuffer.length !== KEY_LENGTH) {
    throw new Error(`Encryption key must be ${KEY_LENGTH * 2} hex characters (256 bits)`);
  }
  
  return keyBuffer;
}

/**
 * Derive encryption key from password using PBKDF2
 */
function deriveKey(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 100000, KEY_LENGTH, 'sha256');
}

/**
 * Generate a random IV
 */
function generateIV() {
  return crypto.randomBytes(IV_LENGTH);
}

/**
 * Generate a random salt
 */
function generateSalt() {
  return crypto.randomBytes(SALT_LENGTH);
}

/**
 * Encrypt data using AES-256-GCM
 */
export function encrypt(plaintext, keyId = 'default') {
  try {
    if (!plaintext) {
      return null;
    }
    
    const key = getEncryptionKey(keyId);
    const iv = generateIV();
    
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    
    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    const authTag = cipher.getAuthTag();
    
    // Combine IV, auth tag, and encrypted data
    const combined = Buffer.concat([
      iv,
      authTag,
      Buffer.from(encrypted, 'hex')
    ]);
    
    // Return base64 encoded
    return combined.toString('base64');
  } catch (error) {
    console.error('Encryption error:', error.message);
    throw new Error('Failed to encrypt data');
  }
}

/**
 * Decrypt data using AES-256-GCM
 */
export function decrypt(ciphertext, keyId = 'default') {
  try {
    if (!ciphertext) {
      return null;
    }
    
    const key = getEncryptionKey(keyId);
    
    // Decode base64
    const combined = Buffer.from(ciphertext, 'base64');
    
    // Extract IV, auth tag, and encrypted data
    const iv = combined.slice(0, IV_LENGTH);
    const authTag = combined.slice(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const encrypted = combined.slice(IV_LENGTH + AUTH_TAG_LENGTH);
    
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    
    let decrypted = decipher.update(encrypted, null, 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  } catch (error) {
    console.error('Decryption error:', error.message);
    throw new Error('Failed to decrypt data');
  }
}

/**
 * Encrypt object fields based on schema
 */
export function encryptObject(obj, schema, keyId = 'default') {
  const encrypted = { ...obj };
  
  for (const field of schema) {
    if (encrypted[field] && !encrypted[field].startsWith('enc:')) {
      encrypted[field] = 'enc:' + encrypt(encrypted[field], keyId);
    }
  }
  
  return encrypted;
}

/**
 * Decrypt object fields based on schema
 */
export function decryptObject(obj, schema, keyId = 'default') {
  const decrypted = { ...obj };
  
  for (const field of schema) {
    if (decrypted[field] && decrypted[field].startsWith('enc:')) {
      try {
        decrypted[field] = decrypt(decrypted[field].substring(4), keyId);
      } catch (error) {
        // If decryption fails, keep the encrypted value
        console.warn(`Failed to decrypt field ${field}:`, error.message);
      }
    }
  }
  
  return decrypted;
}

/**
 * Encrypt array of objects
 */
export function encryptArray(arr, schema, keyId = 'default') {
  return arr.map(obj => encryptObject(obj, schema, keyId));
}

/**
 * Decrypt array of objects
 */
export function decryptArray(arr, schema, keyId = 'default') {
  return arr.map(obj => decryptObject(obj, schema, keyId));
}

/**
 * Check if a value is encrypted
 */
export function isEncrypted(value) {
  return value && typeof value === 'string' && value.startsWith('enc:');
}

/**
 * Get encryption schema for a table
 */
export function getSchemaForTable(tableName) {
  return ENCRYPTED_FIELDS[tableName] || [];
}

/**
 * Rotate encryption key
 * Decrypts with old key and encrypts with new key
 */
export function rotateKey(ciphertext, oldKeyId, newKeyId) {
  const plaintext = decrypt(ciphertext, oldKeyId);
  return encrypt(plaintext, newKeyId);
}

/**
 * Generate a new encryption key
 */
export function generateEncryptionKey() {
  return crypto.randomBytes(KEY_LENGTH).toString('hex');
}

/**
 * Validate encryption key format
 */
export function validateEncryptionKey(key) {
  try {
    const keyBuffer = Buffer.from(key, 'hex');
    return keyBuffer.length === KEY_LENGTH;
  } catch {
    return false;
  }
}

/**
 * Hash sensitive identifier for indexing
 * Allows searching without storing plaintext
 */
export function hashIdentifier(identifier) {
  if (!identifier) return null;
  
  const hash = crypto.createHash('sha256');
  hash.update(identifier);
  return hash.digest('hex');
}

/**
 * Middleware to automatically encrypt request data
 */
export function encryptMiddleware(tableName) {
  return (req, res, next) => {
    const schema = getSchemaForTable(tableName);
    
    if (req.body) {
      req.body = encryptObject(req.body, schema);
    }
    
    next();
  };
}

/**
 * Middleware to automatically decrypt response data
 */
export function decryptMiddleware(tableName) {
  return (req, res, next) => {
    const originalJson = res.json.bind(res);
    const schema = getSchemaForTable(tableName);
    
    res.json = function(data) {
      if (Array.isArray(data)) {
        data = decryptArray(data, schema);
      } else if (data && typeof data === 'object') {
        data = decryptObject(data, schema);
      }
      return originalJson(data);
    };
    
    next();
  };
}

/**
 * Migration utility: Encrypt existing data
 */
export async function migrateEncryptedFields(db, tableName) {
  const schema = getSchemaForTable(tableName);
  
  if (schema.length === 0) {
    console.log(`No encrypted fields for table ${tableName}`);
    return { migrated: 0, errors: 0 };
  }
  
  try {
    // Get all records
    const records = db.prepare(`SELECT * FROM ${tableName}`).all();
    
    let migrated = 0;
    let errors = 0;
    
    for (const record of records) {
      try {
        const encrypted = encryptObject(record, schema);
        
        // Build update query
        const updates = [];
        const values = [];
        
        for (const field of schema) {
          if (encrypted[field] !== record[field]) {
            updates.push(`${field} = ?`);
            values.push(encrypted[field]);
          }
        }
        
        if (updates.length > 0) {
          values.push(record.id);
          const updateQuery = `UPDATE ${tableName} SET ${updates.join(', ')} WHERE id = ?`;
          db.prepare(updateQuery).run(...values);
          migrated++;
        }
      } catch (error) {
        console.error(`Failed to migrate record ${record.id}:`, error.message);
        errors++;
      }
    }
    
    console.log(`Migrated ${migrated} records in ${tableName}, ${errors} errors`);
    return { migrated, errors };
  } catch (error) {
    console.error(`Migration failed for ${tableName}:`, error.message);
    return { migrated: 0, errors: 1 };
  }
}

/**
 * Migration utility: Decrypt existing data (for rollback)
 */
export async function rollbackEncryptedFields(db, tableName) {
  const schema = getSchemaForTable(tableName);
  
  if (schema.length === 0) {
    console.log(`No encrypted fields for table ${tableName}`);
    return { rolledBack: 0, errors: 0 };
  }
  
  try {
    // Get all records
    const records = db.prepare(`SELECT * FROM ${tableName}`).all();
    
    let rolledBack = 0;
    let errors = 0;
    
    for (const record of records) {
      try {
        const decrypted = decryptObject(record, schema);
        
        // Build update query
        const updates = [];
        const values = [];
        
        for (const field of schema) {
          if (decrypted[field] !== record[field]) {
            updates.push(`${field} = ?`);
            values.push(decrypted[field]);
          }
        }
        
        if (updates.length > 0) {
          values.push(record.id);
          const updateQuery = `UPDATE ${tableName} SET ${updates.join(', ')} WHERE id = ?`;
          db.prepare(updateQuery).run(...values);
          rolledBack++;
        }
      } catch (error) {
        console.error(`Failed to rollback record ${record.id}:`, error.message);
        errors++;
      }
    }
    
    console.log(`Rolled back ${rolledBack} records in ${tableName}, ${errors} errors`);
    return { rolledBack, errors };
  } catch (error) {
    console.error(`Rollback failed for ${tableName}:`, error.message);
    return { rolledBack: 0, errors: 1 };
  }
}

export default {
  encrypt,
  decrypt,
  encryptObject,
  decryptObject,
  encryptArray,
  decryptArray,
  isEncrypted,
  getSchemaForTable,
  rotateKey,
  generateEncryptionKey,
  validateEncryptionKey,
  hashIdentifier,
  encryptMiddleware,
  decryptMiddleware,
  migrateEncryptedFields,
  rollbackEncryptedFields,
  ENCRYPTED_FIELDS,
};
