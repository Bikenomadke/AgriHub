# AgriHub RBAC Matrix

**Version:** 1.0  
**Date:** June 14, 2026  
**Status:** Implemented

## Role Definitions

| Role ID | Display Name | Description |
|---------|-------------|-------------|
| admin | Admin | Full system access with all permissions |
| field_officer | Field Officer | Field data collection and management |
| trader | Weighbridge Trader | Transaction and payment management |
| investor | Investor | Investment and reporting access |

## Permission Matrix

| Permission | Admin | Field Officer | Trader | Investor |
|------------|-------|---------------|--------|----------|
| **Fields** |
| fields:read | ✅ | ✅ | ❌ | ✅ |
| fields:create | ✅ | ✅ | ❌ | ❌ |
| fields:update | ✅ | ✅ | ❌ | ❌ |
| fields:delete | ✅ | ❌ | ❌ | ❌ |
| **Transactions** |
| transactions:read | ✅ | ✅ | ✅ | ✅ |
| transactions:create | ✅ | ✅ | ✅ | ❌ |
| transactions:update | ✅ | ❌ | ✅ | ❌ |
| transactions:delete | ✅ | ❌ | ❌ | ❌ |
| **Farmers** |
| farmers:read | ✅ | ✅ | ❌ | ❌ |
| farmers:create | ✅ | ✅ | ❌ | ❌ |
| farmers:update | ✅ | ✅ | ❌ | ❌ |
| farmers:delete | ✅ | ❌ | ❌ | ❌ |
| **Payments** |
| payments:initiate | ✅ | ❌ | ✅ | ❌ |
| payments:approve | ✅ | ❌ | ✅ | ❌ |
| payments:cancel | ✅ | ❌ | ✅ | ❌ |
| **Wallets** |
| wallets:read | ✅ | ❌ | ✅ | ✅ |
| wallets:deposit | ✅ | ❌ | ✅ | ❌ |
| wallets:withdraw | ✅ | ❌ | ✅ | ❌ |
| wallets:freeze | ✅ | ❌ | ❌ | ❌ |
| **Reports** |
| reports:read | ✅ | ❌ | ❌ | ✅ |
| reports:export | ✅ | ❌ | ❌ | ✅ |
| **Users** |
| users:read | ✅ | ❌ | ❌ | ❌ |
| users:create | ✅ | ❌ | ❌ | ❌ |
| users:update | ✅ | ❌ | ❌ | ❌ |
| users:delete | ✅ | ❌ | ❌ | ❌ |
| **Admin** |
| admin:all | ✅ | ❌ | ❌ | ❌ |

## Endpoint-to-Role Mapping

### Fields Endpoints
| Method | Endpoint | Admin | Field Officer | Trader | Investor |
|--------|----------|-------|---------------|--------|----------|
| GET | /api/fields | ✅ | ✅ | ❌ | ✅ |
| GET | /api/fields/:id | ✅ | ✅ | ❌ | ✅ |
| POST | /api/fields | ✅ | ✅ | ❌ | ❌ |
| PUT | /api/fields/:id | ✅ | ✅ | ❌ | ❌ |
| DELETE | /api/fields/:id | ✅ | ❌ | ❌ | ❌ |

### Transactions Endpoints
| Method | Endpoint | Admin | Field Officer | Trader | Investor |
|--------|----------|-------|---------------|--------|----------|
| GET | /api/transactions | ✅ | ✅ | ✅ | ✅ |
| GET | /api/transactions/:id | ✅ | ✅ | ✅ | ✅ |
| POST | /api/transactions | ✅ | ✅ | ✅ | ❌ |
| PUT | /api/transactions/:id | ✅ | ❌ | ✅ | ❌ |
| DELETE | /api/transactions/:id | ✅ | ❌ | ❌ | ❌ |

### Farmers Endpoints
| Method | Endpoint | Admin | Field Officer | Trader | Investor |
|--------|----------|-------|---------------|--------|----------|
| GET | /api/farmers | ✅ | ✅ | ❌ | ❌ |
| GET | /api/farmers/:id | ✅ | ✅ | ❌ | ❌ |
| POST | /api/farmers | ✅ | ✅ | ❌ | ❌ |
| PUT | /api/farmers/:id | ✅ | ✅ | ❌ | ❌ |

### Payments Endpoints
| Method | Endpoint | Admin | Field Officer | Trader | Investor |
|--------|----------|-------|---------------|--------|----------|
| POST | /api/payments/request | ✅ | ❌ | ✅ | ❌ |
| POST | /api/payments/:id/approve | ✅ | ❌ | ✅ | ❌ |
| POST | /api/payments/:id/cancel | ✅ | ❌ | ✅ | ❌ |

### Wallets Endpoints
| Method | Endpoint | Admin | Field Officer | Trader | Investor |
|--------|----------|-------|---------------|--------|----------|
| GET | /api/wallets | ✅ | ❌ | ✅ | ✅ |
| GET | /api/wallets/:id | ✅ | ❌ | ✅ | ✅ |
| POST | /api/wallets/deposit | ✅ | ❌ | ✅ | ❌ |
| POST | /api/wallets/withdraw | ✅ | ❌ | ✅ | ❌ |
| POST | /api/wallets/:id/freeze | ✅ | ❌ | ❌ | ❌ |

### Reports Endpoints
| Method | Endpoint | Admin | Field Officer | Trader | Investor |
|--------|----------|-------|---------------|--------|----------|
| GET | /api/reports/* | ✅ | ❌ | ❌ | ✅ |

### Users Endpoints
| Method | Endpoint | Admin | Field Officer | Trader | Investor |
|--------|----------|-------|---------------|--------|----------|
| GET | /api/users | ✅ | ❌ | ❌ | ❌ |
| GET | /api/users/:id | ✅ | ❌ | ❌ | ❌ |
| POST | /api/users | ✅ | ❌ | ❌ | ❌ |
| PUT | /api/users/:id | ✅ | ❌ | ❌ | ❌ |
| DELETE | /api/users/:id | ✅ | ❌ | ❌ | ❌ |

### Authentication Endpoints
| Method | Endpoint | Admin | Field Officer | Trader | Investor |
|--------|----------|-------|---------------|--------|----------|
| POST | /api/auth/login | ✅ | ✅ | ✅ | ✅ |
| POST | /api/auth/refresh | ✅ | ✅ | ✅ | ✅ |
| POST | /api/auth/logout | ✅ | ✅ | ✅ | ✅ |
| GET | /api/auth/sessions | ✅ | ✅ | ✅ | ✅ |
| POST | /api/auth/sessions/revoke-all | ✅ | ✅ | ✅ | ✅ |

## Authorization Middleware Usage

### Role-Based Authorization
```javascript
import { authenticate, authorize } from '../middleware/auth.js';

// Only admin can access
router.delete('/api/users/:id', authenticate, authorize('admin'), deleteUser);

// Admin or field officer can access
router.post('/api/fields', authenticate, authorize('admin', 'field_officer'), createField);
```

### Permission-Based Authorization
```javascript
import { requirePermission } from '../middleware/auth.js';

// Require specific permission
router.post('/api/fields', authenticate, requirePermission('fields:create'), createField);
```

### Endpoint-Based Authorization
```javascript
import { requireEndpointAccess } from '../middleware/auth.js';

// Automatic endpoint-based authorization
router.get('/api/fields', authenticate, requireEndpointAccess(), getFields);
```

### Resource Ownership Authorization
```javascript
import { requireOwnership } from '../middleware/auth.js';

// User must own the resource (admin bypasses)
router.put('/api/fields/:id', authenticate, requireOwnership('fields'), updateField);
```

## Default Deny Behavior

The authorization system follows a **default deny** approach:
- All endpoints require authentication
- All endpoints require explicit authorization
- Unauthorized access attempts are logged to audit_logs table
- 403 Forbidden response for denied access
- 401 Unauthorized response for missing/invalid tokens

## Audit Logging

All denied authorization attempts are logged with:
- User ID
- Action (authorization_denied)
- Entity type (api_access)
- Entity ID (endpoint path)
- IP address
- User agent
- Device ID
- Request details (method, path, reason, user role, timestamp)

## Security Considerations

1. **Admin Role**: Has full system access (all permissions)
2. **Role Normalization**: Database roles are normalized to match RBAC definitions
3. **Permission Inheritance**: Permissions are not inherited between roles
4. **Endpoint Mapping**: Permissions are mapped to specific HTTP methods and paths
5. **Ownership Checks**: Resource ownership is enforced for non-admin users
6. **Audit Trail**: All authorization denials are logged for security monitoring

## Implementation Notes

- Role definitions are stored in `backend/middleware/auth.js`
- Permission mappings are defined in `PERMISSION_RESOURCES` object
- Role normalization handles database role name to RBAC role name conversion
- Authorization checks are performed before business logic
- Admin role bypasses ownership checks for operational efficiency
