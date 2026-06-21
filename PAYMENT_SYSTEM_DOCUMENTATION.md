# AgriHub M-Pesa Payment Integration - Complete Documentation

## Overview

This document provides comprehensive documentation for the AgriHub M-Pesa payment integration system, which enables secure, auditable, real-time payments directly from investors to farmers through the platform.

## Table of Contents

1. [System Architecture](#system-architecture)
2. [API Documentation](#api-documentation)
3. [Payment Workflows](#payment-workflows)
4. [Security Design](#security-design)
5. [Database Schema](#database-schema)
6. [Production Deployment](#production-deployment)
7. [Configuration](#configuration)
8. [Monitoring & Maintenance](#monitoring--maintenance)

---

## System Architecture

### Architecture Overview

The payment system follows a microservices-inspired architecture with the following components:

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   React/Electron│    │   Android App   │    │   Admin Portal  │
│      Frontend   │    │    (Capacitor)  │    │                 │
└────────┬────────┘    └────────┬────────┘    └────────┬────────┘
         │                      │                      │
         └──────────────────────┼──────────────────────┘
                                │
                    ┌───────────▼───────────┐
                    │   Express.js Backend  │
                    │   (Node.js)          │
                    └───────────┬───────────┘
                                │
         ┌──────────────────────┼──────────────────────┐
         │                      │                      │
┌────────▼────────┐    ┌────────▼────────┐    ┌────────▼────────┐
│  SQLite Database│    │ Payment Queue   │    │  M-Pesa Daraja │
│                 │    │   Worker        │    │     API        │
└─────────────────┘    └─────────────────┘    └─────────────────┘
```

### Core Components

1. **Backend API Server** (Express.js)
   - RESTful API endpoints
   - Authentication & Authorization
   - Business logic implementation
   - Request validation

2. **Database Layer** (SQLite with WAL mode)
   - Transactional data storage
   - Foreign key constraints
   - Indexed queries for performance

3. **Payment Queue Worker**
   - Asynchronous payment processing
   - Retry logic with exponential backoff
   - Priority-based queue management

4. **M-Pesa Integration**
   - STK Push for customer payments
   - B2C for disbursements
   - Transaction status queries
   - Account balance queries
   - Reversal API

5. **Security Layer**
   - JWT authentication
   - Role-based access control
   - Request signing
   - Callback signature verification
   - Rate limiting
   - Fraud detection

---

## API Documentation

### Base URL
```
http://localhost:4000/api
```

### Authentication
All endpoints require JWT authentication except `/api/auth/login`.

### API Endpoints

#### Authentication

##### POST `/api/auth/login`
Login to the system.

**Request Body:**
```json
{
  "username": "admin",
  "password": "agrihub2026"
}
```

**Response:**
```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": "user-id",
    "username": "admin",
    "role": "Admin",
    "name": "System Administrator",
    "color": "#3ddc84"
  }
}
```

#### Farmers

##### POST `/api/farmers/register`
Register a new farmer with M-Pesa verification.

**Roles:** Admin, Field Officer

**Request Body:**
```json
{
  "full_name": "John Doe",
  "national_id": "12345678",
  "mpesa_phone": "0712345678",
  "alternate_phone": "0723456789",
  "county": "Nairobi",
  "subcounty": "Westlands",
  "ward": "Kilimani"
}
```

**Response:**
```json
{
  "farmer": {
    "id": "farmer-id",
    "full_name": "John Doe",
    "national_id": "12345678",
    "mpesa_phone": "254712345678",
    "verification_status": "pending"
  },
  "otp": "123456",
  "message": "OTP sent to phone number for verification"
}
```

##### POST `/api/farmers/verify-otp`
Verify farmer's phone number with OTP.

**Roles:** Admin, Field Officer

**Request Body:**
```json
{
  "farmer_id": "farmer-id",
  "otp": "123456"
}
```

##### GET `/api/farmers`
List all farmers with optional filters.

**Query Parameters:**
- `status`: Filter by verification status
- `county`: Filter by county
- `search`: Search by name, ID, or phone

#### Wallets

##### GET `/api/wallets/my-wallet`
Get current user's wallet information and recent transactions.

##### POST `/api/wallets/deposit`
Deposit funds into wallet.

**Roles:** Admin, Investor

**Request Body:**
```json
{
  "amount": 100000,
  "reference": "DEP-001",
  "description": "Wallet deposit"
}
```

##### POST `/api/wallets/withdraw`
Withdraw funds from wallet.

**Roles:** Admin, Investor

**Request Body:**
```json
{
  "amount": 50000,
  "reference": "WTH-001",
  "description": "Wallet withdrawal"
}
```

##### GET `/api/wallets/statement`
Generate wallet statement for a period.

**Query Parameters:**
- `start_date`: Start date (YYYY-MM-DD)
- `end_date`: End date (YYYY-MM-DD)

#### Payments

##### POST `/api/payments/calculate`
Calculate payment details for a field purchase.

**Roles:** Investor

**Request Body:**
```json
{
  "field_id": "field-id",
  "harvest_cost": 5000,
  "transport_cost": 3000,
  "pulling_cost": 2000
}
```

**Response:**
```json
{
  "field_id": "field-id",
  "farmer_payment": 100000,
  "harvest_cost": 5000,
  "transport_cost": 3000,
  "pulling_cost": 2000,
  "platform_fee": 5000,
  "tax_amount": 0,
  "gross_amount": 110000,
  "net_amount": 95000
}
```

##### POST `/api/payments/create-request`
Create a payment request for field purchase.

**Roles:** Investor

**Request Body:**
```json
{
  "field_id": "field-id",
  "harvest_cost": 5000,
  "transport_cost": 3000,
  "pulling_cost": 2000,
  "auth_method": "pin"
}
```

##### POST `/api/payments/authorize`
Authorize a payment request with PIN/OTP/Biometric.

**Roles:** Investor

**Request Body:**
```json
{
  "payment_request_id": "request-id",
  "pin": "1234",
  "otp": "123456",
  "biometric_token": "token"
}
```

##### POST `/api/payments/execute`
Execute an authorized payment request.

**Roles:** Investor

**Request Body:**
```json
{
  "payment_request_id": "request-id"
}
```

##### POST `/api/payments/set-pin`
Set or update PIN for payment authentication.

**Request Body:**
```json
{
  "pin": "1234"
}
```

#### M-Pesa

##### POST `/api/mpesa/stkpush`
Initiate STK Push payment.

**Roles:** Admin, Weighbridge Trader, Investor

**Request Body:**
```json
{
  "transaction_id": "txn-id",
  "phone": "0712345678",
  "amount": 10000,
  "payment_request_id": "request-id"
}
```

##### POST `/api/mpesa/callback`
M-Pesa callback endpoint (no authentication required).

##### POST `/api/mpesa/b2c`
Initiate B2C payment.

**Roles:** Admin

**Request Body:**
```json
{
  "phone": "0712345678",
  "amount": 10000,
  "command_id": "BusinessPayment",
  "remarks": "Payment"
}
```

##### POST `/api/mpesa/transaction-status`
Query M-Pesa transaction status.

**Roles:** Admin

**Request Body:**
```json
{
  "transaction_id": "MPESA123",
  "party_a": "174379",
  "identifier_type": "4",
  "remarks": "Status check"
}
```

##### POST `/api/mpesa/account-balance`
Query M-Pesa account balance.

**Roles:** Admin

##### POST `/api/mpesa/reversal`
Reverse an M-Pesa transaction.

**Roles:** Admin

**Request Body:**
```json
{
  "transaction_id": "MPESA123",
  "amount": 10000,
  "remarks": "Reversal reason"
}
```

#### Escrow

##### GET `/api/escrow/config`
Get escrow mode configuration.

**Roles:** Admin

##### PUT `/api/escrow/config`
Update escrow mode configuration.

**Roles:** Admin

**Request Body:**
```json
{
  "escrow_mode": "enabled"
}
```

##### GET `/api/escrow/accounts`
List all escrow accounts.

**Roles:** Admin

##### POST `/api/escrow/release`
Release funds from escrow to farmer.

**Roles:** Admin, Field Officer

**Request Body:**
```json
{
  "escrow_account_id": "escrow-id",
  "release_amount": 100000,
  "release_notes": "Harvest confirmed"
}
```

##### POST `/api/escrow/refund`
Refund escrow funds to investor.

**Roles:** Admin

**Request Body:**
```json
{
  "escrow_account_id": "escrow-id",
  "refund_amount": 100000,
  "refund_reason": "Field purchase cancelled"
}
```

#### Accounting

##### POST `/api/accounting/entry`
Create a journal entry (double-entry accounting).

**Roles:** Admin

**Request Body:**
```json
{
  "description": "Transaction entry",
  "reference": "TXN-001",
  "entries": [
    {
      "account_code": "5200",
      "debit": 100000,
      "credit": 0,
      "description": "Farmer payment"
    },
    {
      "account_code": "1100",
      "debit": 0,
      "credit": 100000,
      "description": "Wallet payment"
    }
  ]
}
```

##### GET `/api/accounting/chart-of-accounts`
Get chart of accounts.

**Roles:** Admin

##### GET `/api/accounting/trial-balance`
Get trial balance report.

**Roles:** Admin

##### GET `/api/accounting/balance-sheet`
Get balance sheet report.

**Roles:** Admin

##### GET `/api/accounting/income-statement`
Get income statement report.

**Roles:** Admin

#### Reconciliation

##### POST `/api/reconciliation/start`
Start a reconciliation process.

**Roles:** Admin

**Request Body:**
```json
{
  "period_type": "daily",
  "start_date": "2024-01-01",
  "end_date": "2024-01-31"
}
```

##### GET `/api/reconciliation/records`
List reconciliation records.

**Roles:** Admin

##### POST `/api/reconciliation/auto`
Perform automatic reconciliation.

**Roles:** Admin

#### Admin

##### GET `/api/admin/dashboard`
Get admin dashboard metrics.

**Roles:** Admin

##### GET `/api/admin/payments`
List all payments with filters.

**Roles:** Admin

##### POST `/api/admin/reverse-transaction`
Reverse a transaction.

**Roles:** Admin

**Request Body:**
```json
{
  "transaction_id": "txn-id",
  "reason": "Reversal reason"
}
```

##### GET `/api/admin/wallets`
List all wallets.

**Roles:** Admin

##### GET `/api/admin/audit-logs`
List audit logs.

**Roles:** Admin

##### GET `/api/admin/system-config`
Get system configuration.

**Roles:** Admin

##### PUT `/api/admin/system-config/:key`
Update system configuration.

**Roles:** Admin

---

## Payment Workflows

### Standard Payment Flow (Immediate Mode)

```
1. Investor reviews field valuation
   ↓
2. Investor clicks "Calculate Payment"
   ↓
3. System calculates payment details (farmer payment, costs, fees, taxes)
   ↓
4. Investor reviews breakdown
   ↓
5. Investor clicks "Create Payment Request"
   ↓
6. System creates payment request (status: pending)
   ↓
7. Investor authorizes with PIN/OTP/Biometric
   ↓
8. System validates wallet balance
   ↓
9. System deducts amount from wallet
   ↓
10. System adds payment to queue
   ↓
11. Queue worker initiates M-Pesa STK Push
   ↓
12. Investor receives M-Pesa prompt
   ↓
13. Investor authorizes M-Pesa payment
   ↓
14. M-Pesa callback received
   ↓
15. System updates transaction status to "completed"
   ↓
16. Field status updated to "paid"
   ↓
17. Digital receipt generated
```

### Escrow Payment Flow

```
1. Investor reviews field valuation
   ↓
2. Investor clicks "Calculate Payment"
   ↓
3. System calculates payment details
   ↓
4. Investor creates payment request
   ↓
5. Investor authorizes payment
   ↓
6. System validates wallet balance
   ↓
7. System deducts amount from wallet
   ↓
8. System creates escrow account (status: locked)
   ↓
9. System records escrow deposit in wallet ledger
   ↓
10. Field status updated to "reserved"
   ↓
11. Harvest completed
   ↓
12. Field Officer confirms harvest
   ↓
13. Admin/Field Officer releases escrow funds
   ↓
14. System initiates M-Pesa payment to farmer
   ↓
15. Farmer receives payment
   ↓
16. Escrow status updated to "released"
   ↓
17. Field status updated to "harvest_approved"
```

### Payment Reconciliation Flow

```
1. System schedules daily reconciliation (midnight)
   ↓
2. Reconciliation process starts
   ↓
3. System fetches all completed transactions for period
   ↓
4. System fetches all M-Pesa transactions for period
   ↓
5. System matches transactions by reference/ID
   ↓
6. System identifies discrepancies:
   - Amount mismatches
   - Missing M-Pesa matches
   - Failed transactions
   ↓
7. System generates reconciliation report
   ↓
8. Admin reviews discrepancies
   ↓
9. Admin resolves discrepancies
   ↓
10. System updates reconciliation status
```

---

## Security Design

### Authentication & Authorization

1. **JWT Authentication**
   - Token-based authentication
   - 24-hour token expiration
   - Secure token storage

2. **Role-Based Access Control (RBAC)**
   - Admin: Full system access
   - Field Officer: Field surveys, farmer registration
   - Weighbridge Trader: Transaction management
   - Investor: Wallet management, payments

3. **Payment Authentication**
   - PIN for standard transactions
   - OTP for large transactions (> KES 1,000,000)
   - Biometric authentication (mobile app)

### Transaction Security

1. **End-to-End Encryption**
   - HTTPS/TLS for all API calls
   - Encrypted sensitive data in database

2. **Request Signing**
   - HMAC-SHA256 for callback verification
   - Timestamp validation
   - Nonce for replay attack prevention

3. **Callback Security**
   - Signature verification
   - IP whitelisting (optional)
   - Duplicate callback detection

4. **Fraud Detection**
   - Multiple failed transaction detection
   - Unusual amount detection
   - Rate limiting per user
   - Suspicious pattern recognition

### Rate Limiting

- STK Push: 10 requests/hour per user
- B2C Payments: 20 requests/hour per user
- Reversals: 5 requests/hour per user

### Audit Trail

All payment events are logged with:
- User ID
- Action performed
- Entity type and ID
- Amount
- IP address
- User agent
- Device ID
- Timestamp
- Before/after state
- Related transaction IDs

### Data Protection

- Kenya Data Protection Act compliance
- PCI-DSS principles adherence
- KYC verification for farmers
- Data encryption at rest and in transit

---

## Database Schema

### Core Tables

#### users
User accounts with authentication and role information.

#### farmers
Farmer registration with M-Pesa verification.

#### wallets
Investor wallet accounts with balance tracking.

#### wallet_transactions
All wallet transactions (deposits, withdrawals, payments, refunds).

#### payment_requests
Payment requests with authorization and status tracking.

#### mpesa_transactions
M-Pesa transaction records with full API integration data.

#### escrow_accounts
Escrow account management for delayed payments.

#### reconciliation_records
Reconciliation process records and discrepancy tracking.

#### audit_logs
Immutable audit trail for all system events.

#### chart_of_accounts
Double-entry accounting chart of accounts.

#### journal_entries
Accounting journal entries.

#### ledger_entries
Individual ledger entries for double-entry accounting.

#### payment_queue
Queue-based payment processing with retry logic.

#### distributed_locks
Distributed locking for concurrent operations.

#### system_config
System configuration and settings.

### Indexes

All tables have appropriate indexes for:
- Foreign key relationships
- Frequently queried columns
- Date-based queries
- Status-based filtering

---

## Production Deployment

### Architecture

```
                    ┌─────────────────┐
                    │   Load Balancer │
                    │   (Nginx/HAProxy)│
                    └────────┬────────┘
                             │
        ┌────────────────────┼────────────────────┐
        │                    │                    │
┌───────▼────────┐  ┌────────▼────────┐  ┌──────▼────────┐
│  Backend Node 1 │  │  Backend Node 2 │  │  Backend Node 3│
│   (Express.js)  │  │   (Express.js)  │  │   (Express.js)  │
└───────┬────────┘  └────────┬────────┘  └──────┬────────┘
        │                    │                    │
        └────────────────────┼────────────────────┘
                             │
                    ┌────────▼────────┐
                    │  Primary DB     │
                    │  (SQLite/PostgreSQL)│
                    └─────────────────┘
```

### Deployment Steps

1. **Environment Setup**
   ```bash
   # Install dependencies
   npm install

   # Configure environment variables
   cp .env.example .env
   ```

2. **Database Migration**
   ```bash
   # Database schema is auto-created on first run
   # For production, consider using PostgreSQL
   ```

3. **Environment Variables**
   ```env
   PORT=4000
   NODE_ENV=production
   JWT_SECRET=your-secret-key
   BASE_URL=https://your-domain.com
   
   # M-Pesa Configuration
   MPESA_ENV=production
   MPESA_CONSUMER_KEY=your-consumer-key
   MPESA_CONSUMER_SECRET=your-consumer-secret
   MPESA_PASSKEY=your-passkey
   MPESA_SHORTCODE=your-shortcode
   MPESA_INITIATOR_NAME=your-initiator-name
   MPESA_INITIATOR_PASSWORD=your-initiator-password
   MPESA_CALLBACK_SECRET=your-callback-secret
   
   # Payment Queue
   ENABLE_PAYMENT_QUEUE=true
   ```

4. **Process Management**
   ```bash
   # Using PM2
   npm install -g pm2
   pm2 start backend/server.js --name "agrihub-backend"
   pm2 save
   pm2 startup
   ```

5. **SSL/TLS Configuration**
   - Use Let's Encrypt for free SSL certificates
   - Configure Nginx as reverse proxy
   - Enable HTTPS only

6. **Monitoring**
   - Set up application monitoring (PM2 Plus, New Relic)
   - Configure log aggregation
   - Set up alerting for failures

### Scaling Considerations

1. **Horizontal Scaling**
   - Multiple backend instances
   - Load balancer distribution
   - Shared database (PostgreSQL recommended for production)

2. **Database Scaling**
   - Read replicas for reporting
   - Connection pooling
   - Query optimization

3. **Queue Scaling**
   - Separate queue worker instances
   - Redis for distributed queue (optional)
   - Priority-based processing

4. **Caching**
   - Redis for session storage
   - Cache frequently accessed data
   - CDN for static assets

---

## Configuration

### System Configuration Keys

| Key | Default Value | Description |
|-----|---------------|-------------|
| escrow_mode | disabled | Enable or disable escrow payment mode |
| platform_fee_percentage | 5 | Platform fee percentage |
| tax_percentage | 0 | Tax percentage |
| max_payment_amount | 1000000 | Maximum payment amount without additional verification |
| payment_timeout_seconds | 300 | Payment request timeout in seconds |
| mpesa_retry_count | 3 | Number of M-Pesa transaction retries |
| auto_reconciliation | enabled | Enable automatic daily reconciliation |

### M-Pesa Configuration

Configure M-Pesa credentials in `.env`:

```env
MPESA_ENV=sandbox  # or production
MPESA_CONSUMER_KEY=your_key
MPESA_CONSUMER_SECRET=your_secret
MPESA_PASSKEY=your_passkey
MPESA_SHORTCODE=174379
MPESA_INITIATOR_NAME=testapi
MPESA_INITIATOR_PASSWORD=your_password
MPESA_CALLBACK_SECRET=your_secret
```

---

## Monitoring & Maintenance

### Health Checks

```bash
curl http://localhost:4000/api/health
```

Response:
```json
{
  "ok": true,
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

### Queue Status

Monitor payment queue status via admin dashboard or API:

```bash
curl -H "Authorization: Bearer <token>" \
  http://localhost:4000/api/admin/queue-status
```

### Log Monitoring

- Application logs: `backend/logs/`
- Error logs: `backend/logs/error.log`
- Access logs: Nginx access logs

### Backup Strategy

1. **Database Backups**
   - Daily automated backups
   - Retention policy: 30 days
   - Offsite backup storage

2. **Configuration Backups**
   - Version control for config files
   - Environment variable documentation

### Maintenance Tasks

1. **Daily**
   - Automatic reconciliation
   - Log rotation
   - Queue cleanup

2. **Weekly**
   - Database optimization
   - Security updates
   - Performance review

3. **Monthly**
   - Financial reconciliation
   - Audit log review
   - Capacity planning

---

## Troubleshooting

### Common Issues

1. **M-Pesa Callback Not Received**
   - Check callback URL is publicly accessible
   - Verify callback signature
   - Check M-Pesa sandbox/production environment

2. **Payment Queue Stuck**
   - Check queue worker status
   - Review error logs
   - Manually retry failed items

3. **Database Lock Issues**
   - Check for long-running transactions
   - Review distributed locks
   - Restart queue worker if needed

4. **Wallet Balance Mismatch**
   - Run reconciliation
   - Review wallet transactions
   - Check for failed transactions

---

## Support & Contact

For technical support or issues:
- Review this documentation
- Check application logs
- Contact system administrator

---

## Version History

- v1.0.0 - Initial implementation with full M-Pesa integration
- Includes: Wallet system, Escrow, Accounting, Reconciliation, Admin Portal
