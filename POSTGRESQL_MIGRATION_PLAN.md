# PostgreSQL + PostGIS Migration Plan

## Executive Summary

Migrating from SQLite (SQLCipher) to PostgreSQL with PostGIS extension to address scalability concerns, improve GIS operations, and prepare for enterprise deployment.

## Current SQLite Schema Analysis

### Tables (15 total)

1. **users** - User accounts with roles (Admin, Field Officer, Weighbridge Trader, Investor)
2. **sessions** - User session management with device tracking
3. **fields** - Agricultural field surveys with polygon data (stored as TEXT)
4. **transactions** - Weighbridge transactions and payments
5. **farmers** - Farmer profiles with encrypted PII
6. **wallets** - Digital wallet accounts
7. **wallet_transactions** - Wallet transaction history
8. **payment_requests** - Payment approval workflow
9. **mpesa_transactions** - M-Pesa integration records
10. **escrow_accounts** - Escrow payment management
11. **reconciliation_records** - Financial reconciliation
12. **audit_logs** - System audit trail
13. **mpesa_requests** - M-Pesa request tracking
14. **system_config** - Application configuration
15. **payment_queue** - Background payment processing

### Key Schema Characteristics

- **GIS Data**: Polygon coordinates stored as TEXT in `fields.polygon` (JSON array)
- **Encryption**: SQLCipher for database-level encryption
- **Indexes**: 30+ indexes for performance
- **Foreign Keys**: Enforced with CASCADE deletes
- **Constraints**: CHECK constraints for status fields
- **WAL Mode**: Write-Ahead Logging enabled

### Current Limitations

1. **No Spatial Indexing**: Polygon data as TEXT prevents spatial queries
2. **Single-File Database**: Limited concurrent write capacity
3. **No Connection Pooling**: SQLite doesn't support pooling
4. **Limited GIS Operations**: No native spatial functions
5. **Scalability**: Not designed for hundreds of concurrent users

## PostgreSQL + PostGIS Schema Design

### Database Configuration

```sql
-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Create schema
CREATE SCHEMA IF NOT EXISTS agrihub;
SET search_path TO agrihub, public;
```

### Table Mappings

#### 1. users
```sql
CREATE TABLE agrihub.users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('Admin','Field Officer','Weighbridge Trader','Investor')),
    name TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#3ddc84',
    phone TEXT,
    email TEXT,
    kyc_verified BOOLEAN DEFAULT FALSE,
    pin_hash TEXT,
    mfa_enabled BOOLEAN DEFAULT FALSE,
    mfa_secret TEXT,
    mfa_backup_codes TEXT,
    mfa_enabled_at TIMESTAMPTZ,
    mfa_disabled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

CREATE INDEX idx_users_username ON agrihub.users(username);
CREATE INDEX idx_users_role ON agrihub.users(role);
CREATE INDEX idx_users_deleted_at ON agrihub.users(deleted_at) WHERE deleted_at IS NULL;
```

#### 2. sessions
```sql
CREATE TABLE agrihub.sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES agrihub.users(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL,
    device_name TEXT,
    device_type TEXT,
    device_os TEXT,
    ip_address TEXT NOT NULL,
    user_agent TEXT,
    location_country TEXT,
    location_city TEXT,
    refresh_token_hash TEXT NOT NULL,
    access_token_hash TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    last_used_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    revoked_at TIMESTAMPTZ,
    revoked_reason TEXT
);

CREATE INDEX idx_sessions_user_id ON agrihub.sessions(user_id);
CREATE INDEX idx_sessions_device_id ON agrihub.sessions(device_id);
CREATE INDEX idx_sessions_expires_at ON agrihub.sessions(expires_at);
CREATE INDEX idx_sessions_revoked_at ON agrihub.sessions(revoked_at) WHERE revoked_at IS NULL;
CREATE INDEX idx_sessions_cleanup ON agrihub.sessions(expires_at) WHERE expires_at < NOW();
```

#### 3. fields (with PostGIS)
```sql
CREATE TABLE agrihub.fields (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL,
    area_acres REAL NOT NULL DEFAULT 0,
    estimated_total_tons REAL NOT NULL DEFAULT 0,
    buying_price_per_acre REAL,
    polygon GEOMETRY(Polygon, 4326), -- PostGIS geometry for spatial operations
    avg_nodes INTEGER DEFAULT 12,
    avg_stalks INTEGER DEFAULT 8,
    survey_date DATE,
    farmer_signature TEXT,
    sites JSONB DEFAULT '[]'::jsonb,
    harvest TEXT,
    status TEXT DEFAULT 'surveyed' CHECK(status IN ('surveyed','valued','reserved','paid','harvest_approved','harvested')),
    farmer_id UUID,
    investor_id UUID,
    valuation REAL,
    harvest_cost REAL DEFAULT 0,
    transport_cost REAL DEFAULT 0,
    pulling_cost REAL DEFAULT 0,
    platform_fee REAL DEFAULT 0,
    tax_amount REAL DEFAULT 0,
    created_by UUID REFERENCES agrihub.users(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

-- PostGIS spatial index for polygon queries
CREATE INDEX idx_fields_polygon ON agrihub.fields USING GIST(polygon);
CREATE INDEX idx_fields_created_by ON agrihub.fields(created_by);
CREATE INDEX idx_fields_status ON agrihub.fields(status);
CREATE INDEX idx_fields_farmer_id ON agrihub.fields(farmer_id);
CREATE INDEX idx_fields_investor_id ON agrihub.fields(investor_id);
```

#### 4. transactions
```sql
CREATE TABLE agrihub.transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    farmer_name TEXT NOT NULL,
    tons REAL NOT NULL DEFAULT 0,
    buy_price REAL NOT NULL DEFAULT 0,
    total_cost REAL NOT NULL DEFAULT 0,
    expected_payout REAL NOT NULL DEFAULT 0,
    gross_profit REAL NOT NULL DEFAULT 0,
    date DATE NOT NULL,
    note TEXT DEFAULT '',
    ticket_number TEXT NOT NULL,
    ticket_image TEXT,
    payment_status TEXT DEFAULT 'unpaid' CHECK(payment_status IN ('unpaid','pending','completed','failed','reversed')),
    payment_method TEXT,
    payment_phone TEXT,
    payment_amount REAL,
    payment_reference TEXT,
    payment_date DATE,
    field_id UUID REFERENCES agrihub.fields(id),
    farmer_id UUID,
    investor_id UUID REFERENCES agrihub.users(id),
    wallet_transaction_id UUID,
    escrow_transaction_id UUID,
    created_by UUID REFERENCES agrihub.users(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

CREATE INDEX idx_transactions_date ON agrihub.transactions(date);
CREATE INDEX idx_transactions_payment_status ON agrihub.transactions(payment_status);
CREATE INDEX idx_transactions_field_id ON agrihub.transactions(field_id);
CREATE INDEX idx_transactions_investor_id ON agrihub.transactions(investor_id);
```

#### 5. farmers
```sql
CREATE TABLE agrihub.farmers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    full_name TEXT NOT NULL,
    national_id TEXT UNIQUE NOT NULL,
    mpesa_phone TEXT UNIQUE NOT NULL,
    alternate_phone TEXT,
    county TEXT NOT NULL,
    subcounty TEXT NOT NULL,
    ward TEXT NOT NULL,
    verification_status TEXT DEFAULT 'pending' CHECK(verification_status IN ('pending','verified','rejected')),
    otp_code TEXT,
    otp_expires_at TIMESTAMPTZ,
    mpesa_registered BOOLEAN DEFAULT FALSE,
    kyc_document_url TEXT,
    national_id_hash TEXT,
    mpesa_phone_hash TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

CREATE INDEX idx_farmers_national_id ON agrihub.farmers(national_id);
CREATE INDEX idx_farmers_mpesa_phone ON agrihub.farmers(mpesa_phone);
CREATE INDEX idx_farmers_verification_status ON agrihub.farmers(verification_status);
CREATE INDEX idx_farmers_national_id_hash ON agrihub.farmers(national_id_hash);
CREATE INDEX idx_farmers_mpesa_phone_hash ON agrihub.farmers(mpesa_phone_hash);
```

#### 6-15. Remaining Tables
(Similar pattern for wallets, wallet_transactions, payment_requests, mpesa_transactions, escrow_accounts, reconciliation_records, audit_logs, mpesa_requests, system_config, payment_queue)

### Key Schema Changes

1. **UUID Primary Keys**: Replace TEXT IDs with UUID for better performance
2. **PostGIS Geometry**: Convert `polygon` from TEXT to GEOMETRY(Polygon, 4326)
3. **TIMESTAMPTZ**: Use timezone-aware timestamps
4. **JSONB**: Convert JSON TEXT to JSONB for better query performance
5. **BOOLEAN**: Replace INTEGER with BOOLEAN for boolean fields
6. **Spatial Indexes**: Add GIST indexes for geometry columns
7. **Schema Organization**: Use dedicated schema for better organization

## Migration Strategy

### Phase 1: Preparation (Week 1)

1. **Environment Setup**
   - Install PostgreSQL 15+
   - Install PostGIS extension
   - Set up development database
   - Configure connection pooling

2. **Dependency Updates**
   - Replace `better-sqlite3` with `pg` and `pg-pool`
   - Add PostGIS client libraries if needed
   - Update environment variables

3. **Schema Design**
   - Finalize PostgreSQL schema
   - Create migration scripts
   - Design data transformation logic

### Phase 2: Schema Migration (Week 2)

1. **Create PostgreSQL Schema**
   - Run schema creation script
   - Create indexes
   - Set up constraints

2. **Data Migration**
   - Export SQLite data
   - Transform data (TEXT IDs → UUID, TEXT polygon → GEOMETRY)
   - Import to PostgreSQL
   - Validate data integrity

3. **Application Refactoring**
   - Update db.js for PostgreSQL connection pool
   - Convert SQL queries to PostgreSQL syntax
   - Update GIS operations to use PostGIS functions
   - Test all endpoints

### Phase 3: Testing & Validation (Week 3)

1. **Functional Testing**
   - Test all CRUD operations
   - Test GIS operations (polygon queries, spatial joins)
   - Test payment workflows
   - Test authentication

2. **Performance Testing**
   - Load testing with concurrent users
   - Benchmark spatial queries
   - Compare performance with SQLite

3. **Data Validation**
   - Verify record counts match
   - Validate relationships
   - Check data integrity

### Phase 4: Deployment (Week 4)

1. **Staging Deployment**
   - Deploy to staging environment
   - Run full test suite
   - Performance testing

2. **Production Deployment**
   - Schedule maintenance window
   - Backup SQLite database
   - Run migration
   - Switch traffic to PostgreSQL
   - Monitor for issues

3. **Rollback Plan**
   - Keep SQLite backup for 30 days
   - Document rollback procedure
   - Test rollback process

## Implementation Details

### Docker Compose Configuration

```yaml
services:
  postgres:
    image: postgis/postgis:15-3.3
    environment:
      POSTGRES_DB: agrihub
      POSTGRES_USER: agrihub
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U agrihub"]
      interval: 10s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    volumes:
      - redis_data:/data

volumes:
  postgres_data:
  redis_data:
```

### Environment Variables

```env
# Database
DB_HOST=localhost
DB_PORT=5432
DB_NAME=agrihub
DB_USER=agrihub
DB_PASSWORD=<secure_password>
DB_SSL_MODE=disable
DB_POOL_MIN=2
DB_POOL_MAX=20

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379
```

### Connection Pool Configuration

```javascript
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  min: parseInt(process.env.DB_POOL_MIN) || 2,
  max: parseInt(process.env.DB_POOL_MAX) || 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});
```

### PostGIS Operations Examples

```sql
-- Convert polygon coordinates to PostGIS geometry
UPDATE agrihub.fields
SET polygon = ST_SetSRID(ST_MakePolygon(ST_GeomFromText(geojson)), 4326)
FROM (
  SELECT id, 
    ST_SetSRID(ST_MakePolygon(
      ST_GeomFromGeoJSON(polygon::json)
    ), 4326) as geojson
  FROM agrihub.fields
  WHERE polygon IS NOT NULL
) as geo
WHERE agrihub.fields.id = geo.id;

-- Spatial query: Find fields within a region
SELECT id, name, area_acres
FROM agrihub.fields
WHERE ST_Within(polygon, ST_MakeEnvelope(..., 4326));

-- Calculate field area in hectares
SELECT 
  id, 
  name,
  ST_Area(polygon::geography) / 10000 as area_hectares
FROM agrihub.fields;

-- Find nearby fields within 1km
SELECT f1.id, f1.name, f2.id as nearby_id, f2.name as nearby_name
FROM agrihub.fields f1, agrihub.fields f2
WHERE ST_DWithin(f1.polygon, f2.polygon, 1000)
AND f1.id != f2.id;
```

## Benefits of Migration

1. **Scalability**: Handle hundreds of concurrent users
2. **GIS Capabilities**: Native spatial operations and indexing
3. **Performance**: Connection pooling, better query optimization
4. **Reliability**: ACID compliance, better crash recovery
5. **Features**: Full-text search, JSONB queries, advanced analytics
6. **Enterprise Ready**: Proven for production workloads

## Risks & Mitigations

### Risk 1: Data Loss During Migration
- **Mitigation**: Full backup before migration, validation scripts, rollback plan

### Risk 2: Application Downtime
- **Mitigation**: Staged migration, maintenance window, parallel run

### Risk 3: Performance Regression
- **Mitigation**: Performance testing, query optimization, proper indexing

### Risk 4: GIS Functionality Breaks
- **Mitigation**: Thorough testing of spatial queries, PostGIS training

## Success Criteria

- [ ] All data migrated without loss
- [ ] All application tests pass
- [ ] Performance meets or exceeds SQLite
- [ ] GIS operations work correctly
- [ ] Zero data integrity issues
- [ ] Successful production deployment
- [ ] Team trained on PostgreSQL/PostGIS

## Timeline

- **Week 1**: Preparation and setup
- **Week 2**: Schema migration and refactoring
- **Week 3**: Testing and validation
- **Week 4**: Deployment

## Next Steps

1. Review and approve this migration plan
2. Set up PostgreSQL development environment
3. Create detailed migration scripts
4. Begin Phase 1 implementation
