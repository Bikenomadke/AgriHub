import jwt from "jsonwebtoken";
import pool from "../db-postgres.js";
import config from "../utils/config.js";

const JWT_SECRET = config.JWT_SECRET;
const SUPABASE_USERINFO_URL = `${config.SUPABASE_URL}/auth/v1/user`;

// Role definitions with permissions
const ROLES = {
  admin: {
    name: 'Admin',
    permissions: ['all'],
    description: 'Full system access'
  },
  field_officer: {
    name: 'Field Officer',
    permissions: [
      'fields:read', 'fields:create', 'fields:update',
      'farmers:read', 'farmers:create', 'farmers:update',
      'transactions:read', 'transactions:create'
    ],
    description: 'Field data collection and management'
  },
  trader: {
    name: 'Weighbridge Trader',
    permissions: [
      'transactions:read', 'transactions:create', 'transactions:update',
      'payments:initiate', 'payments:approve',
      'wallets:read', 'wallets:deposit', 'wallets:withdraw'
    ],
    description: 'Transaction and payment management'
  },
  investor: {
    name: 'Investor',
    permissions: [
      'fields:read',
      'transactions:read',
      'wallets:read',
      'reports:read'
    ],
    description: 'Investment and reporting access'
  }
};

// Permission to resource mapping
const PERMISSION_RESOURCES = {
  'fields:read': ['GET /api/fields', 'GET /api/fields/:id'],
  'fields:create': ['POST /api/fields'],
  'fields:update': ['PUT /api/fields/:id'],
  'fields:delete': ['DELETE /api/fields/:id'],
  'transactions:read': ['GET /api/transactions', 'GET /api/transactions/:id'],
  'transactions:create': ['POST /api/transactions'],
  'transactions:update': ['PUT /api/transactions/:id'],
  'transactions:delete': ['DELETE /api/transactions/:id'],
  'farmers:read': ['GET /api/farmers', 'GET /api/farmers/:id'],
  'farmers:create': ['POST /api/farmers'],
  'farmers:update': ['PUT /api/farmers/:id'],
  'payments:initiate': ['POST /api/payments/request'],
  'payments:approve': ['POST /api/payments/:id/approve'],
  'wallets:read': ['GET /api/wallets', 'GET /api/wallets/:id'],
  'wallets:deposit': ['POST /api/wallets/deposit'],
  'wallets:withdraw': ['POST /api/wallets/withdraw'],
  'reports:read': ['GET /api/reports/*'],
  'users:read': ['GET /api/users', 'GET /api/users/:id'],
  'users:create': ['POST /api/users'],
  'users:update': ['PUT /api/users/:id'],
  'users:delete': ['DELETE /api/users/:id'],
  'admin:all': ['*']
};

// Normalize role name from database to match ROLES definition
function normalizeRole(role) {
  const roleMap = {
    'Admin': 'admin',
    'Field Officer': 'field_officer',
    'Weighbridge Trader': 'trader',
    'Investor': 'investor'
  };
  return roleMap[role] || role.toLowerCase().replace(' ', '_');
}

function normalizeSupabaseUser(authUser) {
  const metadata = authUser.user_metadata || {};
  const emailUsername = authUser.email ? authUser.email.split("@")[0] : authUser.id;
  return {
    id: authUser.id,
    username: (metadata.username || emailUsername).toLowerCase().trim(),
    role: metadata.role || "Field Officer",
    name: metadata.name || metadata.full_name || authUser.email || emailUsername,
    color: metadata.color || "#3ddc84",
    email: authUser.email || null,
  };
}

async function verifySupabaseToken(token) {
  const response = await fetch(SUPABASE_USERINFO_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: config.SUPABASE_ANON_KEY,
    },
  });

  if (!response.ok) {
    throw new Error("Supabase token rejected");
  }

  return normalizeSupabaseUser(await response.json());
}

async function ensureLocalUser(user) {
  try {
    await pool.query(
      `INSERT INTO agrihub.users (id, username, password, role, name, color, email)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (id) DO UPDATE SET
        username = EXCLUDED.username,
        role = EXCLUDED.role,
        name = EXCLUDED.name,
        color = EXCLUDED.color,
        email = EXCLUDED.email,
        updated_at = NOW()`,
      [
        user.id,
        user.username,
        "supabase-auth-managed",
        user.role,
        user.name,
        user.color,
        user.email,
      ]
    );
  } catch (error) {
    console.error("Failed to sync Supabase user profile:", error.message);
    throw new Error(`Failed to sync user to local database: ${error.message}`);
  }
}

// Check if user has specific permission
function hasPermission(userRole, permission) {
  const normalizedRole = normalizeRole(userRole);
  const roleConfig = ROLES[normalizedRole];
  
  if (!roleConfig) {
    return false;
  }
  
  // Admin has all permissions
  if (roleConfig.permissions.includes('all')) {
    return true;
  }
  
  return roleConfig.permissions.includes(permission);
}

// Check if user has permission for specific endpoint
function hasEndpointPermission(userRole, method, path) {
  const normalizedRole = normalizeRole(userRole);
  const roleConfig = ROLES[normalizedRole];
  
  if (!roleConfig) {
    return false;
  }
  
  // Admin has all permissions
  if (roleConfig.permissions.includes('all')) {
    return true;
  }
  
  const endpoint = `${method} ${path}`;
  
  // Check each permission
  for (const permission of roleConfig.permissions) {
    const patterns = PERMISSION_RESOURCES[permission] || [];
    for (const pattern of patterns) {
      if (pattern === '*') return true;
      
      // Convert pattern to regex
      const regexPattern = pattern
        .replace('*', '.*')
        .replace(':id', '[^/]+');
      const regex = new RegExp(`^${regexPattern}$`);
      
      if (regex.test(endpoint)) {
        return true;
      }
    }
  }
  
  return false;
}

// Log denied authorization attempt
async function logDeniedAccess(req, reason) {
  try {
    await pool.query(
      `INSERT INTO agrihub.audit_logs (user_id, action, entity_type, entity_id, ip_address, user_agent, device_id, before_state)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        req.user?.id || null,
        'authorization_denied',
        'api_access',
        req.path,
        req.ip || req.connection.remoteAddress,
        req.headers['user-agent'] || 'Unknown',
        req.user?.id || null,
        JSON.stringify({
          method: req.method,
          path: req.path,
          reason: reason,
          user_role: req.user?.role,
          timestamp: new Date().toISOString()
        })
      ]
    );
  } catch (error) {
    console.error('Failed to log denied access:', error.message);
  }
}

export async function authenticate(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "No token provided" });
  }
  const token = header.split(" ")[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    return next();
  } catch (error) {
    try {
      const supabaseUser = await verifySupabaseToken(token);
      await ensureLocalUser(supabaseUser);
      req.user = supabaseUser;
      return next();
    } catch (supabaseError) {
      return res.status(401).json({ error: "Invalid or expired token" });
    }
  }
}

export function authorize(...roles) {
  return (req, res, next) => {
    const normalizedRole = normalizeRole(req.user.role);
    const normalizedAllowedRoles = roles.map(normalizeRole);
    
    if (!normalizedAllowedRoles.includes(normalizedRole)) {
      logDeniedAccess(req, `Role ${normalizedRole} not in allowed roles: ${roles.join(', ')}`);
      return res.status(403).json({ error: "Insufficient permissions" });
    }
    next();
  };
}

// Permission-based authorization
export function requirePermission(permission) {
  return (req, res, next) => {
    if (!hasPermission(req.user.role, permission)) {
      logDeniedAccess(req, `Missing permission: ${permission}`);
      return res.status(403).json({ error: "Insufficient permissions" });
    }
    next();
  };
}

// Endpoint-based authorization
export function requireEndpointAccess() {
  return (req, res, next) => {
    if (!hasEndpointPermission(req.user.role, req.method, req.path)) {
      logDeniedAccess(req, `No access to endpoint: ${req.method} ${req.path}`);
      return res.status(403).json({ error: "Insufficient permissions" });
    }
    next();
  };
}

// Resource ownership check
export function requireOwnership(resourceType) {
  return async (req, res, next) => {
    // Admin bypasses ownership check
    if (req.user.role === 'Admin') {
      return next();
    }
    
    const resourceId = req.params.id;
    if (!resourceId) {
      return res.status(400).json({ error: "Resource ID required" });
    }
    
    // Check ownership based on resource type
    let ownerField = 'created_by';
    let table = `agrihub.${resourceType}`;
    
    if (resourceType === 'wallets') {
      ownerField = 'user_id';
    }
    
    try {
      const { queryOne } = await import("../db-postgres.js");
      const resource = await queryOne(`SELECT ${ownerField} FROM ${table} WHERE id = $1`, [resourceId]);
      
      if (!resource) {
        return res.status(404).json({ error: "Resource not found" });
      }
      
      if (resource[ownerField] !== req.user.id) {
        await logDeniedAccess(req, `Not owner of resource: ${resourceType}:${resourceId}`);
        return res.status(403).json({ error: "You do not own this resource" });
      }
      
      next();
    } catch (error) {
      console.error('Ownership check error:', error);
      return res.status(500).json({ error: "Failed to verify ownership" });
    }
  };
}

export { ROLES, PERMISSION_RESOURCES, normalizeRole, hasPermission, hasEndpointPermission };
