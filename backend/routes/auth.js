import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { v4 as uuid } from "uuid";
import pool, { queryOne, queryMany, transaction } from "../db-postgres.js";
import config from "../utils/config.js";
import { validatePassword, hashPassword, getPasswordStrength } from "../utils/password-validator.js";
import { generateTOTPSecret, generateTOTPURI, enableMFA, disableMFA, verifyMFA, isMFARequired, getMFAStatus, regenerateBackupCodes } from "../utils/mfa.js";
import { authenticate } from "../middleware/auth.js";
import { supabase, supabaseAdmin } from "../utils/supabase-client.js";

const router = Router();
const JWT_SECRET = config.JWT_SECRET;

// Create failed_logins table if not exists
async function initializeAuthTables() {
  try {
    // Ensure schema exists first
    await pool.query('CREATE SCHEMA IF NOT EXISTS agrihub');
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS agrihub.failed_logins (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        ip_address TEXT,
        attempted_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_failed_logins_username ON agrihub.failed_logins(username)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_failed_logins_attempted_at ON agrihub.failed_logins(attempted_at)`);
  } catch (error) {
    console.error('Failed to initialize auth tables:', error);
  }
}

// Check if account is locked
async function isAccountLocked(username) {
  const lockoutDuration = config.ACCOUNT_LOCKOUT_DURATION_MS;
  const lockoutAttempts = config.ACCOUNT_LOCKOUT_ATTEMPTS;
  const lockoutTime = new Date(Date.now() - lockoutDuration).toISOString();
  
  const recentFailures = await queryOne(
    `SELECT COUNT(*) as count FROM agrihub.failed_logins 
    WHERE username = $1 AND attempted_at > $2`,
    [username.toLowerCase().trim(), lockoutTime]
  );
  
  return recentFailures.count >= lockoutAttempts;
}

// Record failed login attempt
async function recordFailedLogin(username, ip) {
  const id = uuid();
  await pool.query(
    `INSERT INTO agrihub.failed_logins (id, username, ip_address, attempted_at)
    VALUES ($1, $2, $3, NOW())`,
    [id, username.toLowerCase().trim(), ip]
  );
}

// Clean up old failed login records (older than 24 hours)
async function cleanupFailedLogins() {
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  await pool.query(`DELETE FROM agrihub.failed_logins WHERE attempted_at < $1`, [oneDayAgo]);
}

// Generate secure random token
function generateSecureToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Hash token for storage
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Extract device info from user agent
function extractDeviceInfo(userAgent) {
  const deviceInfo = {
    device_type: 'unknown',
    device_os: 'unknown',
    device_name: 'Unknown Device'
  };

  if (!userAgent) return deviceInfo;

  const ua = userAgent.toLowerCase();
  
  if (ua.includes('mobile') || ua.includes('android') || ua.includes('iphone')) {
    deviceInfo.device_type = 'mobile';
  } else if (ua.includes('tablet') || ua.includes('ipad')) {
    deviceInfo.device_type = 'tablet';
  } else {
    deviceInfo.device_type = 'desktop';
  }

  if (ua.includes('windows')) {
    deviceInfo.device_os = 'Windows';
  } else if (ua.includes('mac') || ua.includes('os x')) {
    deviceInfo.device_os = 'macOS';
  } else if (ua.includes('linux')) {
    deviceInfo.device_os = 'Linux';
  } else if (ua.includes('android')) {
    deviceInfo.device_os = 'Android';
  } else if (ua.includes('ios') || ua.includes('iphone') || ua.includes('ipad')) {
    deviceInfo.device_os = 'iOS';
  }

  return deviceInfo;
}

// Create session record
async function createSession(userId, ipAddress, userAgent) {
  const sessionId = uuid();
  const deviceId = crypto.createHash('sha256').update(`${userId}-${ipAddress}-${userAgent}`).digest('hex').substring(0, 32);
  const deviceInfo = extractDeviceInfo(userAgent);
  
  const refreshToken = generateSecureToken();
  const accessToken = generateSecureToken();
  
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 days
  
  await pool.query(
    `INSERT INTO agrihub.sessions (id, user_id, device_id, device_name, device_type, device_os, ip_address, user_agent, refresh_token_hash, access_token_hash, expires_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      sessionId,
      userId,
      deviceId,
      deviceInfo.device_name,
      deviceInfo.device_type,
      deviceInfo.device_os,
      ipAddress,
      userAgent,
      hashToken(refreshToken),
      hashToken(accessToken),
      expiresAt
    ]
  );
  
  return { sessionId, refreshToken, accessToken, deviceId, deviceInfo };
}

// Refresh access token
router.post("/refresh", async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      return res.status(401).json({ error: "Refresh token required" });
    }

    const refreshTokenHash = hashToken(refreshToken);
    
    // Find session by refresh token hash
    const session = await queryOne(
      `SELECT * FROM agrihub.sessions 
      WHERE refresh_token_hash = $1 AND revoked_at IS NULL AND expires_at > NOW()`,
      [refreshTokenHash]
    );
    
    if (!session) {
      return res.status(401).json({ error: "Invalid or expired refresh token" });
    }
    
    // Get user
    const user = await queryOne("SELECT * FROM agrihub.users WHERE id = $1", [session.user_id]);
    if (!user) {
      return res.status(401).json({ error: "User not found" });
    }
    
    // Generate new tokens
    const newAccessToken = generateSecureToken();
    const newRefreshToken = generateSecureToken();
    const newExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    
    // Update session with new tokens (token rotation)
    await pool.query(
      `UPDATE agrihub.sessions 
      SET refresh_token_hash = $1, access_token_hash = $2, expires_at = $3, last_used_at = NOW()
      WHERE id = $4`,
      [hashToken(newRefreshToken), hashToken(newAccessToken), newExpiresAt, session.id]
    );
    
    // Generate new JWT
    const payload = { id: user.id, username: user.username, role: user.role, name: user.name, color: user.color };
    const jwtToken = jwt.sign(payload, JWT_SECRET, { expiresIn: config.JWT_ACCESS_EXPIRY });
    
    res.json({ 
      token: jwtToken, 
      refreshToken: newRefreshToken, 
      accessToken: newAccessToken,
      user: payload 
    });
  } catch (error) {
    console.error("Refresh token error:", error);
    res.status(500).json({ error: "Failed to refresh token" });
  }
});

// Revoke session
router.post("/logout", async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      return res.status(400).json({ error: "Refresh token required" });
    }

    const refreshTokenHash = hashToken(refreshToken);
    
    // Revoke session
    const result = await pool.query(
      `UPDATE agrihub.sessions 
      SET revoked_at = NOW(), revoked_reason = 'user_logout'
      WHERE refresh_token_hash = $1 AND revoked_at IS NULL`,
      [refreshTokenHash]
    );
    
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Session not found" });
    }
    
    res.json({ success: true });
  } catch (error) {
    console.error("Logout error:", error);
    res.status(500).json({ error: "Failed to logout" });
  }
});

// Get user sessions
router.get("/sessions", async (req, res) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "No token provided" });
  }
  
  try {
    const token = header.split(" ")[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    
    const sessions = await queryMany(
      `SELECT id, device_id, device_name, device_type, device_os, ip_address, created_at, last_used_at, expires_at
      FROM agrihub.sessions
      WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > NOW()
      ORDER BY last_used_at DESC`,
      [decoded.id]
    );
    
    res.json({ sessions });
  } catch (error) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
});

// Revoke all sessions (global logout)
router.post("/sessions/revoke-all", async (req, res) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "No token provided" });
  }
  
  try {
    const token = header.split(" ")[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    
    await pool.query(
      `UPDATE agrihub.sessions 
      SET revoked_at = NOW(), revoked_reason = 'global_logout'
      WHERE user_id = $1 AND revoked_at IS NULL`,
      [decoded.id]
    );
    
    res.json({ success: true });
  } catch (error) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
});

// Supabase login for field officers and traders
router.post("/supabase-login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const ip = req.ip || req.connection.remoteAddress;

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }

    if (!supabase) {
      return res.status(500).json({ error: "Supabase not configured" });
    }

    // Authenticate with Supabase
    const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
      email,
      password
    });

    if (authError) {
      console.error("Supabase auth error:", authError);
      return res.status(401).json({ error: "Invalid credentials" });
    }

    // Get user from local database using email
    const user = await queryOne(
      `SELECT id, email, name, role, phone, location, company_name, status 
       FROM agrihub.users 
       WHERE email = $1 AND deleted_at IS NULL`,
      [email]
    );

    if (!user) {
      return res.status(404).json({ error: "User not found in local database" });
    }

    if (user.status !== 'active') {
      return res.status(403).json({ error: "Account is inactive" });
    }

    if (!['Field Officer', 'Trader', 'Weighbridge Trader'].includes(user.role)) {
      return res.status(403).json({ error: "Supabase login only for field officers and traders" });
    }

    // Generate JWT tokens
    const payload = {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role
    };

    const accessToken = jwt.sign(payload, JWT_SECRET, { expiresIn: config.JWT_ACCESS_EXPIRY });
    const refreshToken = generateSecureToken();
    const refreshTokenHash = hashToken(refreshToken);

    // Create session
    const sessionId = uuid();
    const deviceInfo = extractDeviceInfo(req.get('user-agent'));
    
    await pool.query(
      `INSERT INTO agrihub.sessions (id, user_id, device_id, device_name, device_type, device_os, ip_address, user_agent, refresh_token_hash, access_token_hash, expires_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW() + INTERVAL '7 days')`,
      [sessionId, user.id, sessionId, deviceInfo.device_name, deviceInfo.device_type, deviceInfo.device_os, ip, req.get('user-agent'), refreshTokenHash, hashToken(accessToken)]
    );

    res.json({
      token: accessToken,
      refreshToken: refreshToken,
      accessToken: accessToken,
      user: payload
    });
  } catch (error) {
    console.error("Supabase login error:", error);
    res.status(500).json({ error: "Failed to login with Supabase" });
  }
});

// Change password
router.post("/change-password", async (req, res) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "No token provided" });
  }
  
  try {
    const token = header.split(" ")[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    
    const { currentPassword, newPassword } = req.body;
    
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: "Current password and new password are required" });
    }
    
    // Get user
    const user = await queryOne("SELECT * FROM agrihub.users WHERE id = $1", [decoded.id]);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    
    // Verify current password
    if (!bcrypt.compareSync(currentPassword, user.password)) {
      return res.status(401).json({ error: "Current password is incorrect" });
    }
    
    // Validate new password
    const passwordValidation = validatePassword(newPassword);
    if (!passwordValidation.valid) {
      return res.status(400).json({ 
        error: "Password does not meet security requirements",
        details: passwordValidation.errors,
        warnings: passwordValidation.warnings
      });
    }
    
    // Hash new password
    const hashedPassword = bcrypt.hashSync(newPassword, 12);
    
    // Update password
    await pool.query(
      `UPDATE agrihub.users 
      SET password = $1, updated_at = NOW()
      WHERE id = $2`,
      [hashedPassword, decoded.id]
    );
    
    // Revoke all sessions (force re-login)
    await pool.query(
      `UPDATE agrihub.sessions 
      SET revoked_at = NOW(), revoked_reason = 'password_change'
      WHERE user_id = $1 AND revoked_at IS NULL`,
      [decoded.id]
    );
    
    res.json({ 
      success: true,
      message: "Password changed successfully. Please log in again.",
      strength: getPasswordStrength(passwordValidation.entropy)
    });
  } catch (error) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
});

// Validate password (for frontend validation)
router.post("/validate-password", (req, res) => {
  const { password } = req.body;
  
  if (!password) {
    return res.status(400).json({ error: "Password is required" });
  }
  
  const validation = validatePassword(password);
  
  res.json({
    valid: validation.valid,
    errors: validation.errors,
    warnings: validation.warnings,
    entropy: validation.entropy,
    strength: getPasswordStrength(validation.entropy),
    length: validation.length
  });
});

router.post("/login", async (req, res) => {
  try {
    const { username, password, email } = req.body;
    if (!password) return res.status(400).json({ error: "Password required" });
    if (!username && !email) return res.status(400).json({ error: "Username or email required" });

    const identifier = username || email;
    const ipAddress = req.ip || req.connection.remoteAddress;
    const userAgent = req.headers['user-agent'] || 'Unknown';

    // Check if account is locked
    if (await isAccountLocked(identifier)) {
      return res.status(429).json({ error: "Account temporarily locked due to too many failed attempts. Please try again later." });
    }

    // Try Supabase authentication first (for admin, field officers, traders)
    if (supabase && email) {
      const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
        email,
        password
      });

      if (!authError) {
        // Supabase auth successful, get user from local database
        let user = await queryOne(
          `SELECT id, email, name, role, phone, location, company_name, status 
           FROM agrihub.users 
           WHERE email = $1 AND deleted_at IS NULL`,
          [email]
        );

        if (!user) {
          // User exists in Supabase but not in local database, create local record
          const userId = uuid();
          const supabaseUser = authData.user;
          const userMetadata = supabaseUser.user_metadata || {};
          
          await pool.query(
            `INSERT INTO agrihub.users (id, email, name, role, phone, location, company_name, supabase_id, status, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', NOW())`,
            [userId, email, userMetadata.name || 'Admin', userMetadata.role || 'Admin', 
             userMetadata.phone || null, userMetadata.location || null, 
             userMetadata.company_name || null, supabaseUser.id]
          );

          user = await queryOne(
            `SELECT id, email, name, role, phone, location, company_name, status 
             FROM agrihub.users 
             WHERE id = $1`,
            [userId]
          );
        }

        if (user.status !== 'active') {
          return res.status(403).json({ error: "Account is inactive" });
        }

        // Clear failed login attempts on successful login
        await pool.query(`DELETE FROM agrihub.failed_logins WHERE username = $1`, [identifier]);

        // Create session with refresh token
        const session = await createSession(user.id, ipAddress, userAgent);
        
        // Generate JWT access token
        const payload = { id: user.id, email: user.email, name: user.name, role: user.role };
        const jwtToken = jwt.sign(payload, JWT_SECRET, { expiresIn: config.JWT_ACCESS_EXPIRY });

        return res.json({ 
          token: jwtToken, 
          refreshToken: session.refreshToken,
          accessToken: session.accessToken,
          user: payload 
        });
      }
    }

    // Fallback to local database authentication (for backward compatibility)
    const user = await queryOne("SELECT * FROM agrihub.users WHERE username = $1", [identifier]);
    if (!user) {
      await recordFailedLogin(identifier, ipAddress);
      await cleanupFailedLogins();
      return res.status(401).json({ error: "Invalid username or password" });
    }

    if (!bcrypt.compareSync(password, user.password)) {
      await recordFailedLogin(identifier, ipAddress);
      await cleanupFailedLogins();
      return res.status(401).json({ error: "Invalid username or password" });
    }

    // Clear failed login attempts on successful login
    await pool.query(`DELETE FROM agrihub.failed_logins WHERE username = $1`, [identifier]);

    // Create session with refresh token
    const session = await createSession(user.id, ipAddress, userAgent);
    
    // Generate JWT access token
    const payload = { id: user.id, username: user.username, role: user.role, name: user.name, color: user.color };
    const jwtToken = jwt.sign(payload, JWT_SECRET, { expiresIn: config.JWT_ACCESS_EXPIRY });

    res.json({ 
      token: jwtToken, 
      refreshToken: session.refreshToken,
      accessToken: session.accessToken,
      user: payload 
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ error: "Login failed" });
  }
});

// ─── MFA Endpoints ──────────────────────────────────────────────────────────────

// Generate MFA secret
router.post("/mfa/setup", authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const secret = generateTOTPSecret();
    const user = await queryOne("SELECT username FROM agrihub.users WHERE id = $1", [userId]);
    
    const uri = generateTOTPURI(secret, user.username, 'AgriHub');
    
    res.json({ 
      secret, 
      uri,
      qrCode: `otpauth://totp/AgriHub:${user.username}?secret=${secret}&issuer=AgriHub`
    });
  } catch (error) {
    console.error("MFA setup error:", error);
    res.status(500).json({ error: "Failed to generate MFA secret" });
  }
});

// Enable MFA
router.post("/mfa/enable", authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const { secret, token } = req.body;
    
    if (!secret || !token) {
      return res.status(400).json({ error: "Secret and token required" });
    }
    
    // Verify token before enabling
    if (!verifyMFA(userId, token).success) {
      return res.status(400).json({ error: "Invalid MFA token" });
    }
    
    const backupCodes = regenerateBackupCodes(userId);
    
    const result = enableMFA(userId, secret, backupCodes.backupCodes);
    
    if (result.success) {
      res.json({ 
        success: true, 
        backupCodes: backupCodes.backupCodes 
      });
    } else {
      res.status(500).json({ error: result.error });
    }
  } catch (error) {
    console.error("MFA enable error:", error);
    res.status(500).json({ error: "Failed to enable MFA" });
  }
});

// Disable MFA
router.post("/mfa/disable", authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const { token } = req.body;
    
    if (!token) {
      return res.status(400).json({ error: "Token required" });
    }
    
    // Verify token before disabling
    if (!verifyMFA(userId, token).success) {
      return res.status(400).json({ error: "Invalid MFA token" });
    }
    
    const result = disableMFA(userId);
    
    if (result.success) {
      res.json({ success: true });
    } else {
      res.status(500).json({ error: result.error });
    }
  } catch (error) {
    console.error("MFA disable error:", error);
    res.status(500).json({ error: "Failed to disable MFA" });
  }
});

// Get MFA status
router.get("/mfa/status", authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const status = getMFAStatus(userId);
    res.json(status);
  } catch (error) {
    console.error("MFA status error:", error);
    res.status(500).json({ error: "Failed to get MFA status" });
  }
});

// Regenerate backup codes
router.post("/mfa/backup-codes", authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const { token } = req.body;
    
    if (!token) {
      return res.status(400).json({ error: "Token required" });
    }
    
    // Verify token before regenerating
    if (!verifyMFA(userId, token).success) {
      return res.status(400).json({ error: "Invalid MFA token" });
    }
    
    const result = regenerateBackupCodes(userId);
    
    if (result.success) {
      res.json({ 
        success: true, 
        backupCodes: result.backupCodes 
      });
    } else {
      res.status(500).json({ error: result.error });
    }
  } catch (error) {
    console.error("Backup codes error:", error);
    res.status(500).json({ error: "Failed to regenerate backup codes" });
  }
});

export default router;
