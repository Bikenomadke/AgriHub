/**
 * Multi-Factor Authentication (MFA) Utility
 * 
 * This module provides TOTP-based MFA for admin accounts:
 * - TOTP generation and verification
 * - Backup codes
 * - MFA enrollment
 * - Recovery mechanisms
 */

import crypto from "crypto";
import { authenticator } from 'otplib';
import pool, { queryOne } from "../db-postgres.js";

/**
 * Generate TOTP secret
 */
export function generateTOTPSecret() {
  return authenticator.generateSecret(32);
}

/**
 * Generate TOTP QR code URI
 */
export function generateTOTPURI(secret, username, issuer = 'AgriHub') {
  return authenticator.keyuri(username, issuer, secret);
}

/**
 * Verify TOTP token
 */
export function verifyTOTPToken(token, secret) {
  return authenticator.verify({
    token,
    secret,
    window: 2, // Allow 2 time steps (30s each) for clock drift
    encoding: 'base32'
  });
}

/**
 * Generate backup codes
 */
export function generateBackupCodes(count = 10) {
  const codes = [];
  for (let i = 0; i < count; i++) {
    const code = crypto.randomBytes(4).toString('hex').toUpperCase();
    codes.push(code);
  }
  return codes;
}

/**
 * Hash backup code
 */
export function hashBackupCode(code) {
  return crypto.createHash('sha256').update(code).digest('hex');
}

/**
 * Enable MFA for user
 */
export async function enableMFA(userId, secret, backupCodes) {
  try {
    const hashedBackupCodes = backupCodes.map(hashBackupCode);
    
    await pool.query(
      `UPDATE agrihub.users
      SET mfa_enabled = true,
          mfa_secret = $1,
          mfa_backup_codes = $2,
          mfa_enabled_at = NOW()
      WHERE id = $3`,
      [secret, JSON.stringify(hashedBackupCodes), userId]
    );
    
    return { success: true };
  } catch (error) {
    console.error('Failed to enable MFA:', error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Disable MFA for user
 */
export async function disableMFA(userId) {
  try {
    await pool.query(
      `UPDATE agrihub.users
      SET mfa_enabled = false,
          mfa_secret = NULL,
          mfa_backup_codes = NULL,
          mfa_disabled_at = NOW()
      WHERE id = $1`,
      [userId]
    );
    
    return { success: true };
  } catch (error) {
    console.error('Failed to disable MFA:', error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Verify MFA during login
 */
export async function verifyMFA(userId, token) {
  try {
    const user = await queryOne("SELECT mfa_enabled, mfa_secret, mfa_backup_codes FROM agrihub.users WHERE id = $1", [userId]);
    
    if (!user || !user.mfa_enabled) {
      return { success: false, error: 'MFA not enabled' };
    }
    
    // Try TOTP first
    if (verifyTOTPToken(token, user.mfa_secret)) {
      return { success: true, method: 'totp' };
    }
    
    // Try backup codes
    if (user.mfa_backup_codes) {
      const backupCodes = JSON.parse(user.mfa_backup_codes);
      const hashedToken = hashBackupCode(token.toUpperCase());
      
      const codeIndex = backupCodes.indexOf(hashedToken);
      if (codeIndex !== -1) {
        // Remove used backup code
        backupCodes.splice(codeIndex, 1);
        
        await pool.query(
          `UPDATE agrihub.users
          SET mfa_backup_codes = $1
          WHERE id = $2`,
          [JSON.stringify(backupCodes), userId]
        );
        
        return { success: true, method: 'backup_code', remaining: backupCodes.length };
      }
    }
    
    return { success: false, error: 'Invalid MFA token' };
  } catch (error) {
    console.error('Failed to verify MFA:', error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Check if MFA is required for user
 */
export async function isMFARequired(userId) {
  try {
    const user = await queryOne("SELECT mfa_enabled, role FROM agrihub.users WHERE id = $1", [userId]);
    
    // MFA required for admin role
    if (user && user.role === 'Admin') {
      return true;
    }
    
    // MFA required if enabled
    if (user && user.mfa_enabled) {
      return true;
    }
    
    return false;
  } catch (error) {
    return false;
  }
}

/**
 * Get MFA status for user
 */
export async function getMFAStatus(userId) {
  try {
    const user = await queryOne("SELECT mfa_enabled, mfa_enabled_at, mfa_backup_codes FROM agrihub.users WHERE id = $1", [userId]);
    
    if (!user) {
      return { enabled: false };
    }
    
    const backupCodes = user.mfa_backup_codes ? JSON.parse(user.mfa_backup_codes) : [];
    
    return {
      enabled: user.mfa_enabled,
      enabledAt: user.mfa_enabled_at,
      backupCodesRemaining: backupCodes.length
    };
  } catch (error) {
    console.error('Failed to get MFA status:', error.message);
    return { enabled: false };
  }
}

/**
 * Regenerate backup codes
 */
export async function regenerateBackupCodes(userId) {
  try {
    const newCodes = generateBackupCodes();
    const hashedCodes = newCodes.map(hashBackupCode);
    
    await pool.query(
      `UPDATE agrihub.users
      SET mfa_backup_codes = $1
      WHERE id = $2`,
      [JSON.stringify(hashedCodes), userId]
    );
    
    return { success: true, backupCodes: newCodes };
  } catch (error) {
    console.error('Failed to regenerate backup codes:', error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Middleware to require MFA verification
 */
export function requireMFA(req, res, next) {
  const userId = req.user?.id;
  
  if (!userId) {
    return res.status(401).json({ error: "Authentication required" });
  }
  
  if (!isMFARequired(userId)) {
    return next();
  }
  
  // Check if MFA has been verified in this session
  if (req.session?.mfaVerified) {
    return next();
  }
  
  // Check for MFA token in request
  const { mfaToken } = req.body;
  
  if (!mfaToken) {
    return res.status(403).json({ 
      error: "MFA verification required",
      requiresMFA: true
    });
  }
  
  const verification = verifyMFA(userId, mfaToken);
  
  if (!verification.success) {
    return res.status(403).json({ 
      error: "Invalid MFA token",
      requiresMFA: true
    });
  }
  
  // Mark session as MFA verified
  if (req.session) {
    req.session.mfaVerified = true;
  }
  
  next();
}

export default {
  generateTOTPSecret,
  generateTOTPURI,
  verifyTOTPToken,
  generateBackupCodes,
  enableMFA,
  disableMFA,
  verifyMFA,
  isMFARequired,
  getMFAStatus,
  regenerateBackupCodes,
  requireMFA,
};
