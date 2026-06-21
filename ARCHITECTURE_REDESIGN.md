# AgriHub Field Command - Architecture Redesign Recommendations

**Document Version:** 1.0  
**Date:** June 14, 2026  
**Author:** Principal Software Architect  
**Status:** Draft for Review

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Current Architecture Analysis](#current-architecture-analysis)
3. [Target Architecture](#target-architecture)
4. [Security Architecture](#security-architecture)
5. [Scalability Architecture](#scalability-architecture)
6. [Data Architecture](#data-architecture)
7. [Authentication & Authorization Architecture](#authentication--authorization-architecture)
8. [Offline-First Architecture](#offline-first-architecture)
9. [Monitoring & Observability Architecture](#monitoring--observability-architecture)
10. [Infrastructure Architecture](#infrastructure-architecture)
11. [Deployment Architecture](#deployment-architecture)
12. [Migration Strategy](#migration-strategy)
13. [Technology Stack Recommendations](#technology-stack-recommendations)

---

## Executive Summary

The current AgriHub Field Command architecture requires fundamental redesign to meet enterprise-grade security, scalability, and reliability requirements. This document provides comprehensive architecture recommendations to transform the application into a production-ready platform capable of supporting 10,000+ users with high availability and strong security.

### Key Architectural Changes Required

1. **Security Transformation**
   - Implement zero-trust security model
   - Add comprehensive encryption at rest and in transit
   - Implement defense-in-depth strategy
   - Add continuous security monitoring

2. **Scalability Transformation**
   - Migrate from single-node SQLite to distributed PostgreSQL
   - Implement horizontal scaling with load balancing
   - Add distributed caching and message queuing
   - Implement microservices architecture where appropriate

3. **Reliability Transformation**
   - Implement high availability with redundancy
   - Add comprehensive monitoring and alerting
   - Implement disaster recovery and backup strategies
   - Add fault tolerance and graceful degradation

### Target Architecture Goals

- **Security:** OWASP Top 10 compliant, NIST CSF aligned, CIS Controls implemented
- **Scalability:** Support 10,000+ users, 5,000+ concurrent sessions, 1,000+ sync operations
- **Availability:** 99.9% uptime, <1 hour MTTR
- **Performance:** <500ms API response times, <1s page load times
- **Compliance:** GDPR, data protection regulations, industry standards

---

## Current Architecture Analysis

### Current State

```
┌─────────────────────────────────────────────────────────┐
│                    Client Layer                         │
├──────────────────┬──────────────────┬─────────────────┤
│   React Web App  │  Electron Desktop│  Android Mobile  │
│   (Vite)         │  (nodeIntegration)│  (Capacitor)     │
└──────────────────┴──────────────────┴─────────────────┘
                          │
                          │ HTTP/HTTPS (mixed)
                          ▼
┌─────────────────────────────────────────────────────────┐
│              Backend Layer (Single Node)                 │
├─────────────────────────────────────────────────────────┤
│  Express.js Server (Port 4000)                          │
│  - Authentication (JWT - weak secret)                   │
│  - API Routes (no rate limiting)                        │
│  - Payment Queue (limited)                              │
│  - CORS (permissive)                                    │
└─────────────────────────────────────────────────────────┘
                          │
                          │ Direct Connection
                          ▼
┌─────────────────────────────────────────────────────────┐
│              Data Layer (Single Node)                   │
├─────────────────────────────────────────────────────────┤
│  SQLite Database (agrihub.db)                           │
│  - No encryption                                        │
│  - No replication                                       │
│  - No backup strategy                                   │
│  - WAL mode enabled                                     │
└─────────────────────────────────────────────────────────┘
```

### Critical Issues

1. **Single Point of Failure** - All components are single-node
2. **No Security Layers** - Minimal security controls
3. **No Scalability** - Cannot scale horizontally
4. **No Redundancy** - No high availability
5. **No Monitoring** - Blind to issues
6. **No Backup/Recovery** - Data loss risk
7. **Weak Security** - Multiple critical vulnerabilities

---

## Target Architecture

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Client Layer                             │
├──────────────────┬──────────────────┬──────────────────────────┤
│   React Web App  │  Electron Desktop│  Android Mobile         │
│   (Secure)       │  (Hardened)      │  (Hardened)            │
│   - CSP          │  - No nodeInt    │  - Certificate Pinning │
│   - Secure Auth  │  - Context Isol  │  - Root Detection      │
│   - Encrypted    │  - Sandbox       │  - Secure Storage      │
└──────────────────┴──────────────────┴──────────────────────────┘
                          │
                          │ HTTPS (TLS 1.3)
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Edge Security Layer                         │
├─────────────────────────────────────────────────────────────────┤
│  CDN (CloudFront) → WAF (AWS WAF) → DDoS Protection           │
└─────────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│                  Load Balancer Layer                           │
├─────────────────────────────────────────────────────────────────┤
│  Application Load Balancer (AWS ALB / NGINX)                   │
│  - SSL Termination                                            │
│  - Health Checks                                               │
│  - Session Affinity                                            │
└─────────────────────────────────────────────────────────────────┘
                          │
          ┌───────────────┼───────────────┐
          ▼               ▼               ▼
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│ Web Server 1 │  │ Web Server 2 │  │ Web Server N │
│ (Auto-scaling)│  │ (Auto-scaling)│  │ (Auto-scaling)│
└──────────────┘  └──────────────┘  └──────────────┘
          │               │               │
          └───────────────┼───────────────┘
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│                  Application Layer                              │
├─────────────────────────────────────────────────────────────────┤
│  API Gateway (Kong / AWS API Gateway)                          │
│  - Rate Limiting                                               │
│  - Authentication                                             │
│  - Request Validation                                         │
│  - Request/Response Transformation                             │
└─────────────────────────────────────────────────────────────────┘
                          │
          ┌───────────────┼───────────────┐
          ▼               ▼               ▼
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│ Auth Service │  │ API Service  │  │ Sync Service │
│ (Microservice)│  │ (Microservice)│  │ (Microservice)│
└──────────────┘  └──────────────┘  └──────────────┘
          │               │               │
          └───────────────┼───────────────┘
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│                  Message Queue Layer                           │
├─────────────────────────────────────────────────────────────────┤
│  RabbitMQ / AWS SQS                                            │
│  - Payment Queue                                               │
│  - Sync Queue                                                  │
│  - Notification Queue                                           │
│  - Dead Letter Queue                                           │
└─────────────────────────────────────────────────────────────────┘
                          │
          ┌───────────────┼───────────────┐
          ▼               ▼               ▼
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│Payment Worker│  │  Sync Worker │  │Notification  │
│ (Background)  │  │ (Background) │  │ Worker       │
└──────────────┘  └──────────────┘  └──────────────┘
                          │
          ┌───────────────┼───────────────┐
          ▼               ▼               ▼
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│   Redis      │  │ PostgreSQL   │  │   S3 /      │
│   Cache      │  │   Primary    │  │   Object    │
│   (Distributed)│  │   Database  │  │   Storage   │
└──────────────┘  └──────────────┘  └──────────────┘
                          │
          ┌───────────────┼───────────────┐
          ▼               ▼               ▼
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│ PostgreSQL   │  │ PostgreSQL   │  │ Backup /    │
│ Read Replica │  │ Read Replica │  │ Archive     │
└──────────────┘  └──────────────┘  └──────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│                  External Services                              │
├─────────────────────────────────────────────────────────────────┤
│  - M-Pesa Daraja API                                           │
│  - SMS Service (Twilio / Africa's Talking)                    │
│  - Email Service (SendGrid / AWS SES)                         │
│  - Push Notification Service (FCM / APNs)                       │
└─────────────────────────────────────────────────────────────────┘
```

### Architecture Principles

1. **Defense in Depth** - Multiple security layers
2. **Zero Trust** - Verify everything, trust nothing
3. **Least Privilege** - Minimum required access
4. **Fail Secure** - Secure by default, fail closed
5. **Scalability First** - Design for scale from day one
6. **Observability** - Monitor everything
7. **Automation** - Automate everything possible
8. **Resilience** - Design for failure

---

## Security Architecture

### Security Layers

```
┌─────────────────────────────────────────────────────────────────┐
│                  Layer 1: Network Security                      │
├─────────────────────────────────────────────────────────────────┤
│  - DDoS Protection (AWS Shield / Cloudflare)                   │
│  - WAF (AWS WAF / Cloudflare WAF)                              │
│  - Network Segmentation (VPC)                                  │
│  - Firewall Rules (Security Groups)                            │
│  - VPN for Admin Access                                         │
└─────────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│                  Layer 2: Edge Security                         │
├─────────────────────────────────────────────────────────────────┤
│  - TLS 1.3 Only                                                │
│  - HSTS with max-age                                            │
│  - Certificate Pinning (Mobile)                                │
│  - OCSP Stapling                                               │
│  - Secure Headers                                              │
└─────────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│                  Layer 3: Application Security                  │
├─────────────────────────────────────────────────────────────────┤
│  - Authentication (JWT + Refresh Tokens)                        │
│  - Authorization (RBAC + ABAC)                                  │
│  - Rate Limiting (Distributed)                                 │
│  - Input Validation (Joi / Zod)                                │
│  - Output Encoding                                             │
│  - CSRF Protection                                              │
│  - Content Security Policy                                     │
└─────────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│                  Layer 4: Data Security                         │
├─────────────────────────────────────────────────────────────────┤
│  - Encryption at Rest (AES-256)                                 │
│  - Encryption in Transit (TLS 1.3)                             │
│  - Field-Level Encryption (PII)                                 │
│  - Key Management (AWS KMS / HashiCorp Vault)                   │
│  - Data Masking (Logs)                                         │
│  - Secure Key Storage (HSM)                                    │
└─────────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│                  Layer 5: Database Security                     │
├─────────────────────────────────────────────────────────────────┤
│  - Row-Level Security (RLS)                                     │
│  - Database Encryption (TDE)                                   │
│  - Connection Encryption                                        │
│  - Least Privilege DB Users                                    │
│  - Audit Logging                                                │
│  - Query Monitoring                                             │
└─────────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│                  Layer 6: Monitoring & Detection                │
├─────────────────────────────────────────────────────────────────┤
│  - SIEM (Splunk / ELK)                                          │
│  - Security Event Correlation                                  │
│  - Anomaly Detection (ML)                                      │
│  - Threat Intelligence Feeds                                   │
│  - Intrusion Detection (IDS)                                   │
│  - Security Alerting                                            │
└─────────────────────────────────────────────────────────────────┘
```

### Security Controls Implementation

#### Authentication Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                  Authentication Flow                            │
└─────────────────────────────────────────────────────────────────┘

1. User submits credentials
   │
   ▼
2. Rate limiting check (IP + Username)
   │
   ▼
3. Failed login attempt tracking
   │
   ▼
4. Account lockout check (if >5 failures)
   │
   ▼
5. Credential validation (bcrypt)
   │
   ▼
6. MFA check (if enabled)
   │
   ▼
7. Device fingerprinting
   │
   ▼
8. Session creation
   │
   ▼
9. Access token generation (JWT, 15min expiry)
   │
   ▼
10. Refresh token generation (30 days expiry)
    │
    ▼
11. Token storage (httpOnly cookie + secure storage)
    │
    ▼
12. Audit logging
```

#### Authorization Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                  Authorization Model                            │
└─────────────────────────────────────────────────────────────────┘

RBAC Matrix:
┌─────────────────────────────────────────────────────────────────┐
│ Role          │ Permissions                                      │
├───────────────┼──────────────────────────────────────────────────│
│ Admin         │ ALL permissions + user management + system config│
│ Field Officer │ Field CRUD + Survey + Harvest approval          │
│ Trader        │ Transaction CRUD + Payment initiation          │
│ Investor      │ View fields + Purchase + Wallet management      │
└─────────────────────────────────────────────────────────────────┘

Resource-Level Permissions:
┌─────────────────────────────────────────────────────────────────┐
│ Resource      │ Create │ Read │ Update │ Delete │ Admin        │
├───────────────┼────────┼──────┼────────┼────────┼───────────────│
│ Fields        │ FO, A  │ All  │ FO, A  │ A      │ A             │
│ Transactions  │ T, A   │ All  │ T, A   │ A      │ A             │
│ Users         │ A      │ A    │ A      │ A      │ A             │
│ Wallets       │ A      │ Own  │ Own, A │ A      │ A             │
└─────────────────────────────────────────────────────────────────┘

ABAC Attributes:
- User role
- User department
- Resource ownership
- Time of day
- Location
- Device trust level
```

### Encryption Architecture

#### Data at Rest Encryption

```
┌─────────────────────────────────────────────────────────────────┐
│                  Encryption at Rest                             │
└─────────────────────────────────────────────────────────────────┘

Database Encryption:
┌─────────────────────────────────────────────────────────────────┐
│ Level              │ Method                  │ Key Management   │
├────────────────────┼─────────────────────────┼──────────────────│
│ Database Files     │ Transparent Data Encryption│ AWS KMS        │
│ Tables             │ Column-level Encryption  │ Application Keys│
│ Sensitive Fields   │ Application-level AES-256│ Per-tenant Keys │
│ Backups            │ GPG Encryption          │ Master Key      │
│ Logs               │ Field-level Masking     │ N/A             │
└─────────────────────────────────────────────────────────────────┘

Key Hierarchy:
┌─────────────────────────────────────────────────────────────────┐
│ Master Key (AWS KMS)                                           │
│    │                                                            │
│    ├── Data Encryption Key (DEK) - Database                    │
│    │                                                            │
│    ├── Tenant Encryption Keys (TEK) - Per tenant               │
│    │    │                                                        │
│    │    ├── Field Encryption Key (FEK) - Fields                │
│    │    │                                                        │
│    │    └── User Encryption Key (UEK) - Users                  │
│    │                                                            │
│    └── Application Keys - Services                              │
└─────────────────────────────────────────────────────────────────┘
```

#### Data in Transit Encryption

```
┌─────────────────────────────────────────────────────────────────┐
│                  Encryption in Transit                          │
└─────────────────────────────────────────────────────────────────┘

Client → Server:
┌─────────────────────────────────────────────────────────────────┐
│ Protocol: HTTPS (TLS 1.3)                                      │
│ Cipher Suite: TLS_AES_256_GCM_SHA384                           │
│ Certificate: ECDSA P-384                                        │
│ HSTS: max-age=31536000; includeSubDomains; preload             │
│ OCSP Stapling: Enabled                                         │
└─────────────────────────────────────────────────────────────────┘

Server → Database:
┌─────────────────────────────────────────────────────────────────┐
│ Protocol: TLS 1.2+                                             │
│ Cipher Suite: TLS_AES_256_GCM_SHA384                           │
│ Certificate: ECDSA P-384                                        │
│ Connection Pooling: Encrypted                                  │
└─────────────────────────────────────────────────────────────────┘

Server → External APIs:
┌─────────────────────────────────────────────────────────────────┐
│ Protocol: HTTPS (TLS 1.2+)                                      │
│ Certificate Validation: Strict                                 │
│ Certificate Pinning: Enabled (Mobile)                          │
│ Mutual TLS: Where supported                                    │
└─────────────────────────────────────────────────────────────────┘
```

---

## Scalability Architecture

### Horizontal Scaling Strategy

```
┌─────────────────────────────────────────────────────────────────┐
│                  Auto-Scaling Configuration                     │
└─────────────────────────────────────────────────────────────────┘

Web Servers:
┌─────────────────────────────────────────────────────────────────┐
│ Min Instances: 2                                                │
│ Max Instances: 20                                               │
│ Target CPU: 70%                                                │
│ Target Memory: 80%                                              │
│ Scale-up Cooldown: 300s                                        │
│ Scale-down Cooldown: 300s                                      │
│ Health Check: /api/health                                      │
│ Graceful Shutdown: 30s                                         │
└─────────────────────────────────────────────────────────────────┘

Background Workers:
┌─────────────────────────────────────────────────────────────────┐
│ Payment Workers: Min 2, Max 10                                  │
│ Sync Workers: Min 2, Max 10                                     │
│ Notification Workers: Min 1, Max 5                              │
│ Queue Depth Scaling: >1000 items                               │
│ Worker Health: Heartbeat every 30s                              │
└─────────────────────────────────────────────────────────────────┘
```

### Database Scaling Strategy

```
┌─────────────────────────────────────────────────────────────────┐
│                  Database Scaling                               │
└─────────────────────────────────────────────────────────────────┘

Primary Database:
┌─────────────────────────────────────────────────────────────────┐
│ Instance: db.r6g.xlarge (4 vCPU, 32 GB RAM)                    │
│ Storage: 1 TB GP3 (IOPS: 12,000, Throughput: 350 MB/s)         │
│ Multi-AZ: Yes                                                   │
│ Replication: 2 read replicas                                    │
│ Connection Pooling: PgBouncer (100 connections)                 │
└─────────────────────────────────────────────────────────────────┘

Read Replicas:
┌─────────────────────────────────────────────────────────────────┐
│ Replica 1: db.r6g.large (2 vCPU, 16 GB RAM)                    │
│ Replica 2: db.r6g.large (2 vCPU, 16 GB RAM)                    │
│ Lag Target: <100ms                                              │
│ Promotion Priority: Configured                                  │
└─────────────────────────────────────────────────────────────────┘

Connection Pooling:
┌─────────────────────────────────────────────────────────────────┐
│ Pool Mode: Transaction                                         │
│ Pool Size: 100                                                  │
│ Max Client Connections: 2000                                    │
│ Idle Timeout: 600s                                             │
└─────────────────────────────────────────────────────────────────┘
```

### Caching Strategy

```
┌─────────────────────────────────────────────────────────────────┐
│                  Caching Architecture                           │
└─────────────────────────────────────────────────────────────────┘

Redis Cluster:
┌─────────────────────────────────────────────────────────────────┐
│ Mode: Cluster Mode (6 nodes, 3 shards)                         │
│ Instance: cache.r6g.large (2 vCPU, 16 GB RAM)                  │
│ Replication: Yes (1 replica per shard)                         │
│ Multi-AZ: Yes                                                   │
│ Eviction Policy: allkeys-lru                                   │
│ Max Memory: 12 GB per node                                     │
└─────────────────────────────────────────────────────────────────┘

Cache Strategy:
┌─────────────────────────────────────────────────────────────────┐
│ Data Type          │ TTL      │ Invalidation Strategy          │
├────────────────────┼──────────┼─────────────────────────────────│
│ User Sessions      │ 30 min   │ Manual on logout               │
│ User Permissions   │ 1 hour   │ Manual on role change          │
│ Field Data         │ 5 min    │ On field update                │
│ Dashboard Stats    │ 1 min    │ Time-based                     │
│ Configuration      │ 24 hours │ Manual on config change        │
│ API Responses      │ 1 min    │ Time-based                     │
└─────────────────────────────────────────────────────────────────┘
```

### Message Queue Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                  Message Queue Configuration                    │
└─────────────────────────────────────────────────────────────────┘

RabbitMQ Cluster:
┌─────────────────────────────────────────────────────────────────┐
│ Nodes: 3 (Quorum Queue)                                        │
│ Instance: mq.r5.large (2 vCPU, 16 GB RAM)                      │
│ Storage: 100 GB SSD                                            │
│ High Availability: Yes                                          │
└─────────────────────────────────────────────────────────────────┘

Queue Configuration:
┌─────────────────────────────────────────────────────────────────┐
│ Queue              │ Type      │ Durable │ TTL    │ Max Retries│
├────────────────────┼───────────┼─────────┼────────┼────────────│
│ payment.initiate   │ Quorum    │ Yes     │ 24h    │ 3          │
│ payment.process    │ Quorum    │ Yes     │ 1h     │ 5          │
│ sync.upload        │ Classic   │ Yes     │ 7d     │ 10         │
│ sync.download      │ Classic   │ Yes     │ 7d     │ 10         │
│ notification.send  │ Classic   │ Yes     │ 1h     │ 3          │
│ report.generate    │ Classic   │ Yes     │ 24h    │ 2          │
└─────────────────────────────────────────────────────────────────┘

Dead Letter Queue:
┌─────────────────────────────────────────────────────────────────┐
│ Queue: dlq.failed                                               │
│ Retention: 30 days                                              │
│ Monitoring: Enabled                                             │
│ Alerting: On threshold (>100 messages)                         │
└─────────────────────────────────────────────────────────────────┘
```

---

## Data Architecture

### Database Schema Design

#### Core Tables

```sql
-- Users Table
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE,
  phone TEXT UNIQUE,
  password_hash TEXT NOT NULL,
  pin_hash TEXT,
  role TEXT NOT NULL CHECK(role IN ('Admin','Field Officer','Weighbridge Trader','Investor')),
  status TEXT DEFAULT 'active' CHECK(status IN ('active','suspended','locked','deleted')),
  kyc_verified BOOLEAN DEFAULT FALSE,
  kyc_document_url TEXT,
  mfa_enabled BOOLEAN DEFAULT FALSE,
  mfa_secret TEXT,
  recovery_codes TEXT[],
  last_login_at TIMESTAMP,
  last_login_ip INET,
  failed_login_attempts INTEGER DEFAULT 0,
  locked_until TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  deleted_at TIMESTAMP
);

-- Indexes
CREATE INDEX idx_users_username ON users(username);
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_phone ON users(phone);
CREATE INDEX idx_users_role ON users(role);
CREATE INDEX idx_users_status ON users(status);
CREATE INDEX idx_users_deleted_at ON users(deleted_at) WHERE deleted_at IS NULL;

-- Row-Level Security
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY users_select_own ON users FOR SELECT USING (id = current_user_id());
CREATE POLICY admins_select_all ON users FOR SELECT USING (role = 'Admin');
```

#### Session Management

```sql
-- User Sessions Table
CREATE TABLE user_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  device_name TEXT,
  device_type TEXT,
  device_os TEXT,
  ip_address INET NOT NULL,
  user_agent TEXT,
  location_country TEXT,
  location_city TEXT,
  refresh_token_hash TEXT NOT NULL,
  access_token_hash TEXT NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  last_used_at TIMESTAMP DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW(),
  revoked_at TIMESTAMP,
  revoked_reason TEXT
);

-- Indexes
CREATE INDEX idx_user_sessions_user_id ON user_sessions(user_id);
CREATE INDEX idx_user_sessions_device_id ON user_sessions(device_id);
CREATE INDEX idx_user_sessions_expires_at ON user_sessions(expires_at);
CREATE INDEX idx_user_sessions_revoked_at ON user_sessions(revoked_at) WHERE revoked_at IS NULL;

-- Cleanup Job
CREATE INDEX idx_user_sessions_cleanup ON user_sessions(expires_at) WHERE expires_at < NOW();
```

#### Audit Logging

```sql
-- Audit Logs Table
CREATE TABLE audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  session_id UUID REFERENCES user_sessions(id),
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id UUID,
  amount DECIMAL(15,2),
  ip_address INET,
  user_agent TEXT,
  device_id TEXT,
  location_country TEXT,
  location_city TEXT,
  before_state JSONB,
  after_state JSONB,
  request_id TEXT,
  correlation_id TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_audit_logs_user_id ON audit_logs(user_id);
CREATE INDEX idx_audit_logs_session_id ON audit_logs(session_id);
CREATE INDEX idx_audit_logs_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at DESC);
CREATE INDEX idx_audit_logs_action ON audit_logs(action);

-- Partitioning by month
CREATE TABLE audit_logs_2026_01 PARTITION OF audit_logs
  FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');
```

#### Change Tracking

```sql
-- Change Log Table
CREATE TABLE change_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  table_name TEXT NOT NULL,
  record_id UUID NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('INSERT','UPDATE','DELETE')),
  old_data JSONB,
  new_data JSONB,
  changed_by UUID REFERENCES users(id),
  changed_at TIMESTAMP DEFAULT NOW(),
  request_id TEXT,
  correlation_id TEXT
);

-- Indexes
CREATE INDEX idx_change_log_table_record ON change_log(table_name, record_id);
CREATE INDEX idx_change_log_changed_by ON change_log(changed_by);
CREATE INDEX idx_change_log_changed_at ON change_log(changed_at DESC);

-- Triggers for automatic change tracking
CREATE OR REPLACE FUNCTION trigger_change_log()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    INSERT INTO change_log (table_name, record_id, action, old_data, changed_by)
    VALUES (TG_TABLE_NAME, OLD.id, 'DELETE', row_to_json(OLD), current_user_id());
    RETURN OLD;
  ELSIF TG_OP = 'UPDATE' THEN
    INSERT INTO change_log (table_name, record_id, action, old_data, new_data, changed_by)
    VALUES (TG_TABLE_NAME, NEW.id, 'UPDATE', row_to_json(OLD), row_to_json(NEW), current_user_id());
    RETURN NEW;
  ELSIF TG_OP = 'INSERT' THEN
    INSERT INTO change_log (table_name, record_id, action, new_data, changed_by)
    VALUES (TG_TABLE_NAME, NEW.id, 'INSERT', row_to_json(NEW), current_user_id());
    RETURN NEW;
  END IF;
END;
$$ LANGUAGE plpgsql;
```

### Data Partitioning Strategy

```
┌─────────────────────────────────────────────────────────────────┐
│                  Partitioning Strategy                          │
└─────────────────────────────────────────────────────────────────┘

High-Volume Tables:
┌─────────────────────────────────────────────────────────────────┐
│ Table              │ Partition By  │ Retention   │ Archive      │
├────────────────────┼───────────────┼─────────────┼──────────────│
│ audit_logs         │ Month         │ 1 year      │ Cold storage │
│ change_log         │ Month         │ 6 months    │ Cold storage │
│ wallet_transactions│ Month         │ 2 years     │ Cold storage │
│ mpesa_transactions │ Month         │ 2 years     │ Cold storage │
│ sync_operations    │ Month         │ 6 months    │ Cold storage │
└─────────────────────────────────────────────────────────────────┘

Partition Management:
┌─────────────────────────────────────────────────────────────────┐
│ - Automatic partition creation (monthly)                        │
│ - Partition drop after retention period                         │
│ - Partition archive to S3                                      │
│ - Query optimization with partition pruning                    │
└─────────────────────────────────────────────────────────────────┘
```

---

## Authentication & Authorization Architecture

### Authentication Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                  Authentication Architecture                    │
└─────────────────────────────────────────────────────────────────┘

┌──────────────┐
│   Client     │
└──────┬───────┘
       │
       │ 1. POST /api/auth/login
       │    { username, password, device_info }
       ▼
┌─────────────────────────────────────────────────────────────────┐
│                  API Gateway                                    │
├─────────────────────────────────────────────────────────────────┤
│  - Rate limiting check                                          │
│  - Input validation                                             │
│  - Request logging                                              │
└─────────────────────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────────────┐
│                  Auth Service                                   │
├─────────────────────────────────────────────────────────────────┤
│  1. Check rate limit (username + IP)                            │
│  2. Check failed login attempts                                 │
│  3. Check account lockout                                        │
│  4. Validate credentials (bcrypt)                               │
│  5. Check MFA (if enabled)                                      │
│  6. Generate device fingerprint                                 │
│  7. Create session record                                       │
│  8. Generate access token (JWT, 15min)                          │
│  9. Generate refresh token (30 days)                            │
│  10. Log authentication event                                    │
└─────────────────────────────────────────────────────────────────┘
       │
       │ 2. Response: { access_token, refresh_token, user }
       ▼
┌──────────────┐
│   Client     │
│              │
│  - Store access_token in memory                                │
│  - Store refresh_token in httpOnly cookie                      │
│  - Store user data in encrypted storage                         │
└──────────────┘
```

### Token Management

```
┌─────────────────────────────────────────────────────────────────┐
│                  Token Architecture                             │
└─────────────────────────────────────────────────────────────────┘

Access Token (JWT):
┌─────────────────────────────────────────────────────────────────┐
│ Algorithm: RS256                                                │
│ Expiry: 15 minutes                                              │
│ Issuer: https://api.agrihub.com                                 │
│ Audience: https://api.agrihub.com                               │
│                                                                  │
│ Payload:                                                         │
│ {                                                                │
│   sub: "user_id",                                               │
│   iss: "https://api.agrihub.com",                               │
│   aud: "https://api.agrihub.com",                               │
│   exp: 1234567890,                                              │
│   iat: 1234567890,                                              │
│   jti: "token_id",                                              │
│   role: "user_role",                                            │
│   permissions: ["permission1", "permission2"],                  │
│   session_id: "session_id"                                     │
│ }                                                                │
└─────────────────────────────────────────────────────────────────┘

Refresh Token:
┌─────────────────────────────────────────────────────────────────┐
│ Format: Random 256-bit string                                   │
│ Storage: httpOnly cookie + database (hashed)                    │
│ Expiry: 30 days                                                 │
│ Rotation: On every refresh                                      │
│ Revocation: On logout, security event, password change          │
└─────────────────────────────────────────────────────────────────┘

Token Refresh Flow:
┌─────────────────────────────────────────────────────────────────┐
│ 1. Client sends refresh token (httpOnly cookie)                  │
│ 2. Server validates refresh token                               │
│ 3. Server checks session is active                              │
│ 4. Server generates new access token                            │
│ 5. Server rotates refresh token                                 │
│ 6. Server returns new access token                              │
│ 7. Server sets new refresh token cookie                          │
└─────────────────────────────────────────────────────────────────┘
```

### Authorization Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                  Authorization Model                            │
└─────────────────────────────────────────────────────────────────┘

Permission Structure:
┌─────────────────────────────────────────────────────────────────┐
│ permissions: {                                                  │
│   "fields": {                                                   │
│     "create": ["Field Officer", "Admin"],                       │
│     "read": ["Field Officer", "Trader", "Investor", "Admin"],  │
│     "update": ["Field Officer", "Admin"],                       │
│     "delete": ["Admin"]                                         │
│   },                                                            │
│   "transactions": {                                              │
│     "create": ["Trader", "Admin"],                              │
│     "read": ["Trader", "Investor", "Admin"],                    │
│     "update": ["Trader", "Admin"],                              │
│     "delete": ["Admin"]                                         │
│   },                                                            │
│   "users": {                                                    │
│     "create": ["Admin"],                                        │
│     "read": ["Admin"],                                          │
│     "update": ["Admin"],                                        │
│     "delete": ["Admin"]                                         │
│   }                                                             │
│ }                                                                │
└─────────────────────────────────────────────────────────────────┘

Authorization Middleware:
┌─────────────────────────────────────────────────────────────────┐
│ 1. Extract user from JWT                                         │
│ 2. Load user permissions from cache/database                     │
│ 3. Check required permission                                     │
│ 4. Check resource ownership (if applicable)                      │
│ 5. Apply ABAC rules (if applicable)                              │
│ 6. Log authorization decision                                    │
└─────────────────────────────────────────────────────────────────┘
```

---

## Offline-First Architecture

### Sync Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                  Offline-First Sync Architecture                 │
└─────────────────────────────────────────────────────────────────┘

┌──────────────┐         ┌──────────────┐         ┌──────────────┐
│   Client     │         │   Client     │         │   Client     │
│  (Offline)   │         │  (Offline)   │         │  (Offline)   │
└──────┬───────┘         └──────┬───────┘         └──────┬───────┘
       │                        │                        │
       │ Local Storage         │ Local Storage         │ Local Storage
       │ (Encrypted)           │ (Encrypted)           │ (Encrypted)
       │                        │                        │
       ▼                        ▼                        ▼
┌─────────────────────────────────────────────────────────────────┐
│                  Sync Queue (Client)                             │
├─────────────────────────────────────────────────────────────────┤
│  - Pending uploads                                              │
│  - Pending downloads                                            │
│  - Conflict markers                                              │
│  - Sync status                                                  │
└─────────────────────────────────────────────────────────────────┘
       │
       │ Network Available
       ▼
┌─────────────────────────────────────────────────────────────────┐
│                  Sync Service                                   │
├─────────────────────────────────────────────────────────────────┤
│  1. Authenticate client                                          │
│  2. Get client sync state                                       │
│  3. Determine changes since last sync                          │
│  4. Push client changes to server                               │
│  5. Pull server changes to client                               │
│  6. Detect conflicts                                            │
│  7. Resolve conflicts (automatic or manual)                      │
│  8. Update sync state                                           │
│  9. Acknowledge sync completion                                  │
└─────────────────────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────────────┐
│                  Database                                       │
└─────────────────────────────────────────────────────────────────┘
```

### Conflict Resolution Strategy

```
┌─────────────────────────────────────────────────────────────────┐
│                  Conflict Resolution                            │
└─────────────────────────────────────────────────────────────────┘

Conflict Types:
┌─────────────────────────────────────────────────────────────────┐
│ Type                │ Resolution Strategy                      │
├─────────────────────┼──────────────────────────────────────────│
│ Same field updated   │ Last-write-wins (timestamp)              │
│ Different fields    │ Merge (field-level)                       │
│ Delete vs Update    │ Delete wins                               │
│ Parent-child conflict│ Cascade resolution                      │
└─────────────────────────────────────────────────────────────────┘

Resolution Flow:
┌─────────────────────────────────────────────────────────────────┐
│ 1. Detect conflict (version mismatch)                            │
│ 2. Classify conflict type                                       │
│ 3. Apply automatic resolution (if possible)                     │
│ 4. If manual resolution required:                               │
│    - Mark record as conflicted                                  │
│    - Present conflict to user                                   │
│    - Allow user to choose resolution                            │
│    - Apply user's choice                                        │
│ 5. Update version                                               │
│ 6. Log resolution                                               │
└─────────────────────────────────────────────────────────────────┘
```

### Offline Data Security

```
┌─────────────────────────────────────────────────────────────────┐
│                  Offline Data Security                          │
└─────────────────────────────────────────────────────────────────┘

Encryption Strategy:
┌─────────────────────────────────────────────────────────────────┐
│ Data Type          │ Encryption Method         │ Key Source     │
├────────────────────┼──────────────────────────┼────────────────│
│ User Data          │ AES-256-GCM              │ Device Key     │
│ Field Data         │ AES-256-GCM              │ Device Key     │
│ Transaction Data   │ AES-256-GCM              │ Device Key     │
│ Sync Tokens        │ AES-256-GCM              │ Device Key     │
│ Credentials        │ Android Keystore / Keychain│ OS Key Store │
└─────────────────────────────────────────────────────────────────┘

Key Management:
┌─────────────────────────────────────────────────────────────────┐
│ 1. Generate device-specific key on first launch                 │
│ 2. Store key in secure storage (Android Keystore)              │
│ 3. Never export key                                             │
│ 4. Key is tied to device (cannot be extracted)                  │
│ 5. On logout, wipe encrypted data                               │
│ 6. On device wipe, key is destroyed                              │
└─────────────────────────────────────────────────────────────────┘
```

---

## Monitoring & Observability Architecture

### Monitoring Stack

```
┌─────────────────────────────────────────────────────────────────┐
│                  Monitoring Architecture                          │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                  Data Collection Layer                           │
├─────────────────────────────────────────────────────────────────┤
│  - Application Metrics (Prometheus)                              │
│  - System Metrics (Node Exporter)                               │
│  - Database Metrics (PostgreSQL Exporter)                       │
│  - Cache Metrics (Redis Exporter)                                │
│  - Queue Metrics (RabbitMQ Exporter)                            │
└─────────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│                  Metrics Storage                                 │
├─────────────────────────────────────────────────────────────────┤
│  - Prometheus TSDB (15-day retention)                            │
│  - Long-term storage (Cortex / Thanos)                         │
└─────────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│                  Visualization & Alerting                         │
├─────────────────────────────────────────────────────────────────┤
│  - Grafana Dashboards                                            │
│  - Alertmanager (Alert routing)                                  │
│  - PagerDuty (On-call)                                          │
│  - Slack (Team notifications)                                    │
│  - Email (Stakeholder notifications)                             │
└─────────────────────────────────────────────────────────────────┘
```

### Logging Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                  Logging Architecture                            │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                  Log Sources                                     │
├─────────────────────────────────────────────────────────────────┤
│  - Application Logs (Structured JSON)                            │
│  - Access Logs (Nginx)                                          │
│  - System Logs (OS)                                              │
│  - Security Logs (WAF, IDS)                                      │
│  - Audit Logs (Application)                                      │
└─────────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│                  Log Aggregation                                 │
├─────────────────────────────────────────────────────────────────┤
│  - Filebeat (Log shipping)                                       │
│  - Logstash (Log processing)                                    │
│  - Elasticsearch (Log storage)                                  │
└─────────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│                  Log Analysis & Visualization                    │
├─────────────────────────────────────────────────────────────────┤
│  - Kibana (Log visualization)                                    │
│  - Log Alerts (ElastAlert)                                      │
│  - Log Retention (30 days hot, 1 year cold)                     │
└─────────────────────────────────────────────────────────────────┘
```

### Alerting Strategy

```
┌─────────────────────────────────────────────────────────────────┐
│                  Alerting Strategy                              │
└─────────────────────────────────────────────────────────────────┘

Alert Categories:
┌─────────────────────────────────────────────────────────────────┐
│ Category        │ Severity  │ Response Time  │ Escalation       │
├─────────────────┼───────────┼────────────────┼──────────────────│
│ Critical        │ P0        │ 15 minutes     │ Immediate        │
│ High            │ P1        │ 30 minutes     │ 1 hour           │
│ Medium          │ P2        │ 2 hours        │ 4 hours          │
│ Low             │ P3        │ 1 day          │ 3 days           │
└─────────────────────────────────────────────────────────────────┘

Alert Examples:
┌─────────────────────────────────────────────────────────────────┐
│ Metric                  │ Threshold    │ Severity  │ Action     │
├─────────────────────────┼──────────────┼───────────┼────────────│
│ Error Rate              │ > 5%         │ P0        │ On-call    │
│ Response Time           │ > 2s         │ P1        │ On-call    │
│ CPU Usage               │ > 90%        │ P1        │ On-call    │
│ Memory Usage            │ > 90%        │ P1        │ On-call    │
│ Database Connections    │ > 90%        │ P0        │ On-call    │
│ Queue Depth             │ > 1000       │ P1        │ On-call    │
│ Failed Logins           │ > 10/min     │ P0        │ Security   │
│ Payment Failures        │ > 5%         │ P0        │ Finance    │
└─────────────────────────────────────────────────────────────────┘
```

---

## Infrastructure Architecture

### Network Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                  Network Architecture                            │
└─────────────────────────────────────────────────────────────────┘

Internet
  │
  ▼
┌─────────────────────────────────────────────────────────────────┐
│                  Edge Layer                                     │
├─────────────────────────────────────────────────────────────────┤
│  - Route 53 (DNS)                                               │
│  - CloudFront (CDN)                                             │
│  - AWS WAF (Web Application Firewall)                           │
│  - AWS Shield (DDoS Protection)                                  │
└─────────────────────────────────────────────────────────────────┘
  │
  ▼
┌─────────────────────────────────────────────────────────────────┐
│                  VPC (Virtual Private Cloud)                     │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ Public Subnets                                            │   │
│  ├──────────────────────────────────────────────────────────┤   │
│  │ - Load Balancer (ALB)                                    │   │
│  │ - NAT Gateways                                           │   │
│  │ - Bastion Host (Admin Access)                            │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ Private Subnets (Application)                            │   │
│  ├──────────────────────────────────────────────────────────┤   │
│  │ - Web Servers (Auto-scaling)                             │   │
│  │ - API Gateway                                             │   │
│  │ - Microservices                                           │   │
│  │ - Background Workers                                      │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ Private Subnets (Data)                                   │   │
│  ├──────────────────────────────────────────────────────────┤   │
│  │ - PostgreSQL (Primary + Replicas)                        │   │
│  │ - Redis Cluster                                           │   │
│  │ - RabbitMQ Cluster                                        │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Security Groups

```
┌─────────────────────────────────────────────────────────────────┐
│                  Security Groups                                 │
└─────────────────────────────────────────────────────────────────┘

Load Balancer SG:
┌─────────────────────────────────────────────────────────────────┐
│ Inbound:                                                         │
│   - HTTP (80) from 0.0.0.0/0 (redirect to HTTPS)               │
│   - HTTPS (443) from 0.0.0.0/0                                  │
│ Outbound:                                                        │
│   - HTTPS (443) to Web Server SG                                │
└─────────────────────────────────────────────────────────────────┘

Web Server SG:
┌─────────────────────────────────────────────────────────────────┐
│ Inbound:                                                         │
│   - HTTPS (443) from Load Balancer SG                           │
│   - SSH (22) from Bastion Host SG                               │
│ Outbound:                                                        │
│   - HTTPS (443) to PostgreSQL SG                                │
│   - HTTPS (6379) to Redis SG                                    │
│   - AMQP (5671) to RabbitMQ SG                                  │
│   - HTTPS (443) to External APIs                                │
└─────────────────────────────────────────────────────────────────┘

Database SG:
┌─────────────────────────────────────────────────────────────────┐
│ Inbound:                                                         │
│   - PostgreSQL (5432) from Web Server SG                         │
│   - PostgreSQL (5432) from Background Worker SG                  │
│ Outbound:                                                        │
│   - None                                                         │
└─────────────────────────────────────────────────────────────────┘
```

---

## Deployment Architecture

### CI/CD Pipeline

```
┌─────────────────────────────────────────────────────────────────┐
│                  CI/CD Pipeline                                  │
└─────────────────────────────────────────────────────────────────┘

┌──────────────┐
│   Developer  │
│   Push Code  │
└──────┬───────┘
       │
       ▼
┌─────────────────────────────────────────────────────────────────┐
│                  Git Repository (GitHub)                         │
├─────────────────────────────────────────────────────────────────┤
│  - Main branch (protected)                                      │
│  - Develop branch                                               │
│  - Feature branches                                             │
└─────────────────────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────────────┐
│                  CI Pipeline (GitHub Actions)                     │
├─────────────────────────────────────────────────────────────────┤
│  1. Code Checkout                                                │
│  2. Install Dependencies                                         │
│  3. Linting (ESLint, Prettier)                                  │
│  4. Unit Tests (Jest)                                           │
│  5. SAST (SonarQube)                                             │
│  6. Dependency Scanning (Snyk)                                  │
│  7. Security Scanning (Snyk, Trivy)                             │
│  8. Build Docker Image                                           │
│  9. Push to ECR                                                 │
│ 10. Scan Image (Trivy)                                          │
└─────────────────────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────────────┐
│                  CD Pipeline (GitHub Actions)                     │
├─────────────────────────────────────────────────────────────────┤
│  1. Deploy to Staging                                           │
│  2. Smoke Tests                                                  │
│  3. Integration Tests (Playwright)                              │
│  4. E2E Tests                                                   │
│  5. Performance Tests                                           │
│  6. Security Tests (OWASP ZAP)                                   │
│  7. Manual Approval (for production)                              │
│  8. Deploy to Production                                         │
│  9. Health Checks                                                │
│  10. Rollback if failed                                          │
└─────────────────────────────────────────────────────────────────┘
```

### Deployment Strategy

```
┌─────────────────────────────────────────────────────────────────┐
│                  Deployment Strategy                             │
└─────────────────────────────────────────────────────────────────┘

Blue-Green Deployment:
┌─────────────────────────────────────────────────────────────────┐
│  1. Deploy new version to Green environment                     │
│  2. Run smoke tests on Green                                    │
│  3. Switch traffic from Blue to Green                            │
│  4. Monitor Green for issues                                    │
│  5. If issues: Switch back to Blue                               │
│  6. If no issues: Decommission Blue                              │
└─────────────────────────────────────────────────────────────────┘

Canary Deployment:
┌─────────────────────────────────────────────────────────────────┐
│  1. Deploy new version to canary subset (5%)                     │
│  2. Monitor canary for errors and performance                    │
│  3. Gradually increase traffic (10%, 25%, 50%, 100%)            │
│  4. If issues: Rollback immediately                              │
│  5. If no issues: Complete rollout                               │
└─────────────────────────────────────────────────────────────────┘
```

---

## Migration Strategy

### Database Migration

```
┌─────────────────────────────────────────────────────────────────┐
│                  Database Migration Strategy                     │
└─────────────────────────────────────────────────────────────────┘

Phase 1: Preparation (Week 1)
┌─────────────────────────────────────────────────────────────────┐
│  1. Set up PostgreSQL instance                                   │
│  2. Convert SQLite schema to PostgreSQL                          │
│  3. Test schema conversion                                       │
│  4. Plan data migration                                          │
│  5. Estimate migration time                                      │
└─────────────────────────────────────────────────────────────────┘

Phase 2: Dual-Write (Week 2)
┌─────────────────────────────────────────────────────────────────┐
│  1. Update application to write to both SQLite and PostgreSQL    │
│  2. Verify data consistency                                      │
│  3. Monitor performance                                          │
│  4. Fix any issues                                               │
└─────────────────────────────────────────────────────────────────┘

Phase 3: Data Migration (Week 3)
┌─────────────────────────────────────────────────────────────────┐
│  1. Migrate historical data in batches                           │
│  2. Verify data integrity                                         │
│  3. Handle any data conflicts                                    │
│  4. Update sequences and IDs                                      │
└─────────────────────────────────────────────────────────────────┘

Phase 4: Cutover (Week 4)
┌─────────────────────────────────────────────────────────────────┐
│  1. Schedule maintenance window                                 │
│  2. Stop application                                             │
│  3. Final data sync                                              │
│  4. Update application to read from PostgreSQL                   │
│  5. Start application                                            │
│  6. Verify functionality                                          │
│  7. Monitor for issues                                           │
└─────────────────────────────────────────────────────────────────┘

Phase 5: Cleanup (Week 5)
┌─────────────────────────────────────────────────────────────────┐
│  1. Archive SQLite database                                      │
│  2. Remove dual-write logic                                      │
│  3. Decommission SQLite                                           │
└─────────────────────────────────────────────────────────────────┘
```

### Feature Migration

```
┌─────────────────────────────────────────────────────────────────┐
│                  Feature Migration Strategy                       │
└─────────────────────────────────────────────────────────────────┘

Strangler Fig Pattern:
┌─────────────────────────────────────────────────────────────────┐
│  1. Identify legacy components                                   │
│  2. Create new microservice for component                        │
│  3. Route traffic to new service                                │
│  4. Monitor and verify                                            │
│  5. Decommission legacy component                                │
└─────────────────────────────────────────────────────────────────┘

Migration Order:
┌─────────────────────────────────────────────────────────────────┐
│  1. Authentication (highest priority)                            │
│  2. User management                                              │
│  3. Field management                                             │
│  4. Transaction management                                       │
│  5. Payment processing                                           │
│  6. Sync functionality                                           │
│  7. Reporting                                                    │
└─────────────────────────────────────────────────────────────────┘
```

---

## Technology Stack Recommendations

### Backend Technologies

```
┌─────────────────────────────────────────────────────────────────┐
│                  Backend Technology Stack                         │
└─────────────────────────────────────────────────────────────────┘

Runtime:
┌─────────────────────────────────────────────────────────────────┐
│ - Node.js 20 LTS                                                │
│ - TypeScript 5.x                                                │
└─────────────────────────────────────────────────────────────────┘

Framework:
┌─────────────────────────────────────────────────────────────────┐
│ - Express.js (API)                                               │
│ - NestJS (Microservices - optional)                              │
└─────────────────────────────────────────────────────────────────┘

Database:
┌─────────────────────────────────────────────────────────────────┐
│ - PostgreSQL 16+                                                │
│ - Prisma ORM (Type-safe queries)                                 │
│ - PgBouncer (Connection pooling)                                 │
└─────────────────────────────────────────────────────────────────┘

Cache:
┌─────────────────────────────────────────────────────────────────┐
│ - Redis 7.x (Cluster mode)                                       │
│ - ioredis (Redis client)                                         │
└─────────────────────────────────────────────────────────────────┘

Message Queue:
┌─────────────────────────────────────────────────────────────────┐
│ - RabbitMQ 3.12+ (Quorum queues)                                 │
│ - amqplib (RabbitMQ client)                                      │
│ - Bull (Queue management)                                        │
└─────────────────────────────────────────────────────────────────┘

Authentication:
┌─────────────────────────────────────────────────────────────────┐
│ - jsonwebtoken (JWT)                                             │
│ - bcrypt (Password hashing)                                      │
│ - speakeasy (TOTP/MFA)                                           │
└─────────────────────────────────────────────────────────────────┘

Validation:
┌─────────────────────────────────────────────────────────────────┐
│ - Zod (Schema validation)                                        │
│ - Joi (Alternative)                                              │
└─────────────────────────────────────────────────────────────────┘

Security:
┌─────────────────────────────────────────────────────────────────┐
│ - helmet (Security headers)                                      │
│ - express-rate-limit (Rate limiting)                              │
│ - csurf (CSRF protection)                                        │
│ - express-validator (Input validation)                           │
└─────────────────────────────────────────────────────────────────┘

Monitoring:
┌─────────────────────────────────────────────────────────────────┐
│ - prom-client (Prometheus metrics)                               │
│ - winston (Logging)                                              │
│ - pino (High-performance logging)                                 │
│ - Sentry (Error tracking)                                        │
└─────────────────────────────────────────────────────────────────┘
```

### Frontend Technologies

```
┌─────────────────────────────────────────────────────────────────┐
│                  Frontend Technology Stack                        │
└─────────────────────────────────────────────────────────────────┘

Framework:
┌─────────────────────────────────────────────────────────────────┐
│ - React 18+                                                      │
│ - Vite 5+ (Build tool)                                           │
│ - TypeScript 5.x                                                │
└─────────────────────────────────────────────────────────────────┘

State Management:
┌─────────────────────────────────────────────────────────────────┐
│ - Zustand (Lightweight state)                                    │
│ - React Query (Server state)                                     │
└─────────────────────────────────────────────────────────────────┘

UI Components:
┌─────────────────────────────────────────────────────────────────┐
│ - TailwindCSS (Styling)                                          │
│ - shadcn/ui (Component library)                                 │
│ - Lucide React (Icons)                                           │
└─────────────────────────────────────────────────────────────────┘

Forms:
┌─────────────────────────────────────────────────────────────────┐
│ - React Hook Form (Form management)                              │
│ - Zod (Validation)                                               │
└─────────────────────────────────────────────────────────────────┘

Data Fetching:
┌─────────────────────────────────────────────────────────────────┐
│ - Axios (HTTP client)                                            │
│ - React Query (Data fetching)                                    │
└─────────────────────────────────────────────────────────────────┘

Authentication:
┌─────────────────────────────────────────────────────────────────┐
│ - Auth0 (Authentication service - optional)                       │
│ - Custom JWT implementation                                       │
└─────────────────────────────────────────────────────────────────┘

Offline Support:
┌─────────────────────────────────────────────────────────────────┐
│ - Dexie.js (IndexedDB wrapper)                                  │
│ - React Query (Cache management)                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Mobile Technologies

```
┌─────────────────────────────────────────────────────────────────┐
│                  Mobile Technology Stack                          │
└─────────────────────────────────────────────────────────────────┘

Framework:
┌─────────────────────────────────────────────────────────────────┐
│ - React Native (Alternative to Capacitor)                        │
│ - Expo (Development tooling)                                    │
└─────────────────────────────────────────────────────────────────┘

Navigation:
┌─────────────────────────────────────────────────────────────────┐
│ - React Navigation                                               │
└─────────────────────────────────────────────────────────────────┘

State Management:
┌─────────────────────────────────────────────────────────────────┐
│ - Redux Toolkit (State management)                              │
│ - React Query (Server state)                                     │
└─────────────────────────────────────────────────────────────────┘

Storage:
┌─────────────────────────────────────────────────────────────────┐
│ - AsyncStorage (Encrypted)                                       │
│ - SecureStore (Sensitive data)                                   │
│ - MMKV (High-performance storage)                                 │
└─────────────────────────────────────────────────────────────────┘

Security:
┌─────────────────────────────────────────────────────────────────┐
│ - react-native-network-info (Network detection)                 │
│ - react-native-keychain (Secure storage)                         │
│ - Custom certificate pinning                                     │
│ - Root detection libraries                                       │
└─────────────────────────────────────────────────────────────────┘
```

### Infrastructure Technologies

```
┌─────────────────────────────────────────────────────────────────┐
│                  Infrastructure Technology Stack                   │
└─────────────────────────────────────────────────────────────────┘

Cloud Provider:
┌─────────────────────────────────────────────────────────────────┐
│ - AWS (Primary)                                                  │
│ - Alternative: Google Cloud Platform, Azure                      │
└─────────────────────────────────────────────────────────────────┘

Compute:
┌─────────────────────────────────────────────────────────────────┐
│ - AWS ECS (Container orchestration)                              │
│ - AWS Fargate (Serverless containers)                             │
│ - AWS Lambda (Serverless functions - optional)                    │
└─────────────────────────────────────────────────────────────────┘

Database:
┌─────────────────────────────────────────────────────────────────┐
│ - AWS RDS PostgreSQL (Managed database)                          │
│ - AWS ElastiCache Redis (Managed cache)                          │
│ - Amazon MQ RabbitMQ (Managed message queue)                      │
└─────────────────────────────────────────────────────────────────┘

Storage:
┌─────────────────────────────────────────────────────────────────┐
│ - AWS S3 (Object storage)                                        │
│ - AWS EFS (File storage - optional)                              │
└─────────────────────────────────────────────────────────────────┘

CDN:
┌─────────────────────────────────────────────────────────────────┐
│ - AWS CloudFront (CDN)                                           │
└─────────────────────────────────────────────────────────────────┘

Security:
┌─────────────────────────────────────────────────────────────────┐
│ - AWS WAF (Web Application Firewall)                              │
│ - AWS Shield (DDoS protection)                                   │
│ - AWS KMS (Key management)                                       │
│ - AWS Secrets Manager (Secret management)                        │
│ - AWS Certificate Manager (SSL certificates)                      │
└─────────────────────────────────────────────────────────────────┘

Monitoring:
┌─────────────────────────────────────────────────────────────────┐
│ - AWS CloudWatch (Monitoring)                                    │
│ - AWS X-Ray (Distributed tracing)                                │
│ - Prometheus + Grafana (Alternative)                              │
│ - ELK Stack (Logging)                                            │
└─────────────────────────────────────────────────────────────────┘
```

---

## Conclusion

This architecture redesign provides a comprehensive blueprint for transforming the AgriHub Field Command application into an enterprise-grade platform. The recommended architecture addresses all critical security vulnerabilities, provides scalability for 10,000+ users, and establishes a foundation for continuous improvement.

### Key Benefits

1. **Security:** Defense-in-depth approach with multiple security layers
2. **Scalability:** Horizontal scaling with auto-scaling capabilities
3. **Reliability:** High availability with redundancy and fault tolerance
4. **Observability:** Comprehensive monitoring and alerting
5. **Compliance:** Alignment with OWASP, NIST, and CIS standards

### Next Steps

1. Review and approve this architecture document
2. Create detailed implementation plans for each component
3. Establish budget and resource allocation
4. Begin Phase 1 implementation (Critical security fixes)
5. Establish regular architecture review cadence

### Success Metrics

The architecture will be considered successful when:

- **Security:** No critical vulnerabilities, OWASP Top 10 compliant
- **Scalability:** Supports 10,000+ users with 99.9% uptime
- **Performance:** <500ms API response times
- **Reliability:** <1 hour MTTR, automated failover
- **Compliance:** NIST CSF aligned, CIS Controls implemented

---

**Document Status:** Draft for Review  
**Next Review Date:** TBD  
**Approval Required:** CTO, VP Engineering, Security Team
