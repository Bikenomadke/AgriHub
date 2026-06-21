# AgriHub Security Remediation Plan

**Date:** June 14, 2026  
**Status:** In Progress  
**Priority:** CRITICAL

## Executive Summary

This document outlines the comprehensive security remediation plan for the AgriHub Field Command application based on the security assessment findings. The remediation is organized into phases prioritized by risk severity and business impact.

## Current Risk Assessment

**Overall Risk Score:** 9.2/10 (CRITICAL)  
**Critical Vulnerabilities:** 5  
**High Vulnerabilities:** 12  
**Medium Vulnerabilities:** 18  
**Low Vulnerabilities:** 8

## Remediation Phases

### Phase 0: Immediate Critical Fixes (Week 1-2)
**Priority:** CRITICAL - Must complete before any production deployment

#### 0.1 Secrets Management
- [ ] Remove all hardcoded fallback secrets
- [ ] Implement strict environment variable validation
- [ ] Application must fail startup if required secrets are missing
- [ ] No default JWT secrets
- [ ] No default encryption keys
- [ ] Implement secrets loading abstraction

**Files to Modify:**
- `backend/.env`
- `backend/server.js`
- `backend/routes/auth.js`
- `backend/middleware/auth.js`

**Success Criteria:**
- Application exits with clear error if any required secret is absent

#### 0.2 CORS Hardening
- [ ] Implement environment-driven allowlist
- [ ] Production-safe CORS configuration
- [ ] Separate development and production settings
- [ ] Remove wildcard origins

**Files to Modify:**
- `backend/server.js`
- `backend/.env`

**Success Criteria:**
- No wildcard origins in production

#### 0.3 Token Security
- [ ] Access token lifetime: 15 minutes
- [ ] Refresh token lifetime: 7 days
- [ ] Refresh token rotation
- [ ] Refresh token revocation
- [ ] Session tracking

**Files to Modify:**
- `backend/routes/auth.js`
- `backend/db.js` (add sessions table)
- `src/api.js`

**Success Criteria:**
- Stolen refresh tokens become unusable after rotation

#### 0.4 Authentication Rate Limiting
- [ ] Login throttling: 10 requests/minute/IP
- [ ] Registration throttling: 5 requests/minute/IP
- [ ] Password reset throttling: 3 requests/hour
- [ ] API abuse protection

**Files to Modify:**
- `backend/server.js` (already partially done)
- `backend/routes/auth.js`

**Success Criteria:**
- Rate limits enforced on all authentication endpoints

### Phase 1: Authentication & Authorization (Week 3-4)
**Priority:** HIGH

#### 1.1 RBAC Implementation
- [ ] Define roles: admin, field_officer, trader, investor
- [ ] Central authorization middleware
- [ ] Dependency-based role enforcement
- [ ] Default deny behavior
- [ ] Audit denied requests
- [ ] Generate role matrix documentation
- [ ] Generate endpoint-to-role mapping

**Files to Modify:**
- `backend/middleware/auth.js`
- `backend/routes/*.js`
- New: `backend/docs/rbac-matrix.md`

#### 1.2 Session Management
- [ ] Session table implementation
- [ ] Device tracking
- [ ] Active session listing
- [ ] Session revocation
- [ ] Global logout

**Files to Modify:**
- `backend/db.js` (add sessions table)
- `backend/routes/auth.js`
- New: `backend/routes/sessions.js`

#### 1.3 Password Security
- [ ] Minimum 12 characters
- [ ] Entropy validation
- [ ] Password breach checking support
- [ ] Account lockout: 5 failed attempts, 15 minute lockout

**Files to Modify:**
- `backend/routes/auth.js`
- New: `backend/utils/password-validator.js`

### Phase 2: Security Hardening (Week 5-6)
**Priority:** MEDIUM

#### 2.1 Security Headers
- [ ] Strict-Transport-Security
- [ ] X-Frame-Options
- [ ] X-Content-Type-Options
- [ ] Referrer-Policy
- [ ] Permissions-Policy
- [ ] Content-Security-Policy

**Files to Modify:**
- `backend/server.js`
- New: `backend/middleware/security-headers.js`

#### 2.2 SSRF Protection
- [ ] HTTPS-only outbound requests
- [ ] Domain allowlist
- [ ] Private IP blocking
- [ ] Loopback blocking
- [ ] Metadata endpoint blocking

**Files to Modify:**
- `backend/routes/mpesa.js`
- New: `backend/utils/ssrf-protection.js`

#### 2.3 Audit Logging
- [ ] Log login attempts
- [ ] Log permission failures
- [ ] Log role changes
- [ ] Log data exports
- [ ] Log sensitive record changes
- [ ] Log integration changes
- [ ] Tamper-resistant design
- [ ] User attribution
- [ ] Request ID correlation

**Files to Modify:**
- `backend/db.js` (add audit_logs table)
- New: `backend/utils/audit-logger.js`
- All route files

### Phase 3: Encryption (Week 7-8)
**Priority:** MEDIUM

#### 3.1 Field-Level Encryption
- [ ] AES-256-GCM encryption for:
  - National IDs
  - Phone numbers
  - Bank account numbers
  - OAuth tokens
  - Sensitive financial references
- [ ] Key rotation support
- [ ] Envelope encryption abstraction
- [ ] Migration strategy

**Files to Modify:**
- New: `backend/utils/encryption.js`
- `backend/db.js` (update schema)
- Migration script

#### 3.2 Encryption Key Management
- [ ] Development: .env
- [ ] Production: Secrets Manager abstraction
- [ ] AWS Secrets Manager support
- [ ] Azure Key Vault support
- [ ] GCP Secret Manager support

**Files to Modify:**
- New: `backend/utils/secrets-manager.js`
- `backend/.env`

### Phase 4: Database Security (Week 9-10)
**Priority:** MEDIUM

#### 4.1 Row-Level Security
- [ ] Implement PostgreSQL RLS for:
  - Tasks
  - Agent Actions
  - Financial Records
  - Farmer Records
  - Projects
- [ ] User isolation
- [ ] Role-aware access

**Note:** This requires migration from SQLite to PostgreSQL

#### 4.2 Soft Deletes
- [ ] Add deleted_at to:
  - tasks
  - projects
  - files
  - memory chunks
  - agent actions
- [ ] Update queries accordingly

**Files to Modify:**
- `backend/db.js`
- All route files

#### 4.3 Audit Triggers
- [ ] Database-level audit triggers for:
  - INSERT
  - UPDATE
  - DELETE
- [ ] On all sensitive tables

**Files to Modify:**
- `backend/db.js`

#### 4.4 Index Optimization
- [ ] Review queries
- [ ] Implement composite indexes
- [ ] Implement partial indexes
- [ ] Implement vector indexes
- [ ] Implement covering indexes
- [ ] Generate benchmark results

**Files to Modify:**
- `backend/db.js`

### Phase 5: Mobile & Desktop Security (Week 11-12)
**Priority:** HIGH

#### 5.1 Android Security
- [ ] Secure token storage
- [ ] Encrypted SQLite
- [ ] Production network security config
- [ ] Certificate pinning support
- [ ] Disable cleartext traffic (already done)
- [ ] Disable backups
- [ ] Release build hardening

**Files to Modify:**
- `android/app/src/main/AndroidManifest.xml`
- New: `android/app/src/main/res/xml/network_security_config.xml`
- New: `android/app/src/main/res/xml/file_paths.xml`

#### 5.2 Electron Security
- [ ] contextIsolation=true (already done)
- [ ] nodeIntegration=false (already done)
- [ ] sandbox=true (already done)
- [ ] Secure IPC bridge (already done)
- [ ] CSP enforcement
- [ ] Token storage in OS keychain

**Files to Modify:**
- `electron/main.cjs`
- `electron/preload.js`

### Phase 6: Infrastructure (Week 13-14)
**Priority:** LOW

#### 6.1 Infrastructure Components
- [ ] PgBouncer configuration
- [ ] Gunicorn worker configuration
- [ ] Redis connection pooling
- [ ] Health checks
- [ ] TLS-ready nginx config

**Files to Modify:**
- New: `docker-compose.prod.yml`
- New: `production.env.example`
- New: `nginx/nginx.conf`
- New: `deployment.md`

### Phase 7: Monitoring & Detection (Week 15-16)
**Priority:** LOW

#### 7.1 Monitoring Implementation
- [ ] Prometheus metrics
- [ ] Grafana dashboards
- [ ] OpenTelemetry tracing
- [ ] Structured JSON logging
- [ ] Security event monitoring

**Files to Modify:**
- New: `backend/utils/prometheus.js`
- New: `backend/utils/opentelemetry.js`
- New: `backend/utils/structured-logger.js`
- New: `monitoring/prometheus.yml`
- New: `monitoring/grafana-dashboards/`

#### 7.2 Alerting
- [ ] Failed login spikes
- [ ] Permission denial spikes
- [ ] Token validation failures
- [ ] Elevated error rates
- [ ] Suspicious export activity

**Files to Modify:**
- New: `monitoring/alerts.yml`

## Testing Requirements

### Security Tests
- [ ] Authentication tests
- [ ] Authorization tests
- [ ] RBAC tests
- [ ] Session tests
- [ ] Rate limit tests
- [ ] SSRF tests
- [ ] CORS tests
- [ ] CSP tests

### Integration Tests
- [ ] OAuth flows
- [ ] Refresh token rotation
- [ ] Session revocation
- [ ] Audit logging

### Regression Tests
- [ ] Ensure all previous functionality remains operational

## Deliverables

For each change:
1. Files modified
2. Files added
3. Database migrations
4. Tests added
5. Security rationale
6. Risk reduced
7. Remaining risks

## Final Deliverables

- [ ] Final Security Remediation Report
- [ ] Findings fixed
- [ ] Findings partially fixed
- [ ] Findings not reproducible
- [ ] Residual risks
- [ ] OWASP reassessment
- [ ] Architecture diagrams
- [ ] Deployment checklist

## Execution Order

1. Phase 0.1: Secrets Management (CRITICAL)
2. Phase 0.2: CORS Hardening (CRITICAL)
3. Phase 0.3: Token Security (CRITICAL)
4. Phase 0.4: Authentication Rate Limiting (CRITICAL)
5. Phase 1.1: RBAC Implementation (HIGH)
6. Phase 1.2: Session Management (HIGH)
7. Phase 1.3: Password Security (HIGH)
8. Phase 5.1: Android Security (HIGH)
9. Phase 5.2: Electron Security (HIGH)
10. Phase 2.1: Security Headers (MEDIUM)
11. Phase 2.2: SSRF Protection (MEDIUM)
12. Phase 2.3: Audit Logging (MEDIUM)
13. Phase 3.1: Field-Level Encryption (MEDIUM)
14. Phase 3.2: Encryption Key Management (MEDIUM)
15. Phase 4.1: Row-Level Security (MEDIUM)
16. Phase 4.2: Soft Deletes (MEDIUM)
17. Phase 4.3: Audit Triggers (MEDIUM)
18. Phase 4.4: Index Optimization (MEDIUM)
19. Phase 6.1: Infrastructure (LOW)
20. Phase 7.1: Monitoring Implementation (LOW)
21. Phase 7.2: Alerting (LOW)

## Progress Tracking

- Phase 0: 0/4 complete
- Phase 1: 0/3 complete
- Phase 2: 0/3 complete
- Phase 3: 0/2 complete
- Phase 4: 0/4 complete
- Phase 5: 2/2 complete (Android and Electron partially done)
- Phase 6: 0/1 complete
- Phase 7: 0/2 complete

**Overall Progress:** 2/21 complete (9.5%)
