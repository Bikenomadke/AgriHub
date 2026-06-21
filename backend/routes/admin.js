import { Router } from "express";
import { v4 as uuid } from "uuid";
import pool, { queryOne, queryMany, transaction } from "../db-postgres.js";
import bcrypt from "bcryptjs";
import { authenticate, authorize } from "../middleware/auth.js";

const router = Router();
router.use(authenticate);

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function logAudit(userId, action, entityType, entityId, amount, req, beforeState, afterState, transactionId, paymentRequestId, mpesaTransactionId, walletTransactionId) {
  const id = uuid();
  await pool.query(
    `INSERT INTO agrihub.audit_logs (user_id, action, entity_type, entity_id, amount, ip_address, user_agent, device_id, before_state, after_state, transaction_id, payment_request_id, mpesa_transaction_id, wallet_transaction_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      userId, action, entityType, entityId, amount,
      req.ip || req.connection.remoteAddress,
      req.get('user-agent'),
      req.get('device-id'),
      beforeState ? JSON.stringify(beforeState) : null,
      afterState ? JSON.stringify(afterState) : null,
      transactionId, paymentRequestId, mpesaTransactionId, walletTransactionId
    ]
  );
  return id;
}

// ─── GET /api/admin/dashboard ────────────────────────────────────────────────
router.get("/dashboard", authorize("Admin"), async (req, res) => {
  try {
    // Get key metrics
    const totalFarmers = await queryOne("SELECT COUNT(*) as c FROM agrihub.farmers");
    const verifiedFarmers = await queryOne("SELECT COUNT(*) as c FROM agrihub.farmers WHERE verification_status = 'verified'");
    const totalFields = await queryOne("SELECT COUNT(*) as c FROM agrihub.fields");
    const valuedFields = await queryOne("SELECT COUNT(*) as c FROM agrihub.fields WHERE status = 'valued'");
    const paidFields = await queryOne("SELECT COUNT(*) as c FROM agrihub.fields WHERE status = 'paid'");
    
    const totalWallets = await queryOne("SELECT COUNT(*) as c FROM agrihub.wallets");
    const totalWalletBalance = await queryOne("SELECT SUM(balance) as total FROM agrihub.wallets");
    const activeWallets = await queryOne("SELECT COUNT(*) as c FROM agrihub.wallets WHERE status = 'active'");
    
    const totalTransactions = await queryOne("SELECT COUNT(*) as c FROM agrihub.transactions");
    const completedTransactions = await queryOne("SELECT COUNT(*) as c FROM agrihub.transactions WHERE payment_status = 'completed'");
    const pendingTransactions = await queryOne("SELECT COUNT(*) as c FROM agrihub.transactions WHERE payment_status = 'pending'");
    const failedTransactions = await queryOne("SELECT COUNT(*) as c FROM agrihub.transactions WHERE payment_status = 'failed'");
    const totalTransactionAmount = await queryOne("SELECT SUM(payment_amount) as total FROM agrihub.transactions WHERE payment_status = 'completed'");
    
    const totalMpesaTransactions = await queryOne("SELECT COUNT(*) as c FROM agrihub.mpesa_transactions");
    const completedMpesaTransactions = await queryOne("SELECT COUNT(*) as c FROM agrihub.mpesa_transactions WHERE status = 'completed'");
    const totalMpesaAmount = await queryOne("SELECT SUM(amount) as total FROM agrihub.mpesa_transactions WHERE status = 'completed'");
    
    const escrowSummary = await queryOne(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status = 'locked' THEN 1 ELSE 0 END) as locked,
        SUM(CASE WHEN status = 'released' THEN 1 ELSE 0 END) as released,
        SUM(CASE WHEN status = 'refunded' THEN 1 ELSE 0 END) as refunded,
        SUM(amount) as total_amount,
        SUM(released_amount) as total_released,
        SUM(refund_amount) as total_refunded
      FROM agrihub.escrow_accounts
    `);

    const recentTransactions = await queryMany(`
      SELECT t.*, f.name as field_name, u.name as investor_name 
      FROM agrihub.transactions t 
      LEFT JOIN agrihub.fields f ON t.field_id = f.id 
      LEFT JOIN agrihub.users u ON t.investor_id = u.id 
      ORDER BY t.created_at DESC LIMIT 10
    `);

    const recentMpesaTransactions = await queryMany(`
      SELECT * FROM agrihub.mpesa_transactions 
      ORDER BY created_at DESC LIMIT 10
    `);

    const pendingPaymentRequests = await queryMany(`
      SELECT pr.*, f.name as field_name, fr.full_name as farmer_name, u.name as investor_name
      FROM agrihub.payment_requests pr
      LEFT JOIN agrihub.fields f ON pr.field_id = f.id
      LEFT JOIN agrihub.farmers fr ON pr.farmer_id = fr.id
      LEFT JOIN agrihub.users u ON pr.investor_id = u.id
      WHERE pr.status IN ('pending', 'approved')
      ORDER BY pr.created_at DESC LIMIT 10
    `);

    const recentAuditLogs = await queryMany(`
      SELECT al.*, u.name as user_name
      FROM agrihub.audit_logs al
      LEFT JOIN agrihub.users u ON al.user_id = u.id
      ORDER BY al.created_at DESC LIMIT 20
    `);

    res.json({
      farmers: {
        total: totalFarmers.c,
        verified: verifiedFarmers.c,
        verification_rate: totalFarmers.c > 0 ? ((verifiedFarmers.c / totalFarmers.c) * 100).toFixed(2) : 0
      },
      fields: {
        total: totalFields.c,
        valued: valuedFields.c,
        paid: paidFields.c
      },
      wallets: {
        total: totalWallets.c,
        active: activeWallets.c,
        total_balance: totalWalletBalance.total || 0
      },
      transactions: {
        total: totalTransactions.c,
        completed: completedTransactions.c,
        pending: pendingTransactions.c,
        failed: failedTransactions.c,
        total_amount: totalTransactionAmount.total || 0
      },
      mpesa: {
        total: totalMpesaTransactions.c,
        completed: completedMpesaTransactions.c,
        total_amount: totalMpesaAmount.total || 0
      },
      escrow: escrowSummary,
      recent_transactions: recentTransactions,
      recent_mpesa_transactions: recentMpesaTransactions,
      pending_payment_requests: pendingPaymentRequests,
      recent_audit_logs: recentAuditLogs
    });
  } catch (error) {
    console.error("Error fetching admin dashboard:", error);
    res.status(500).json({ error: "Failed to fetch admin dashboard" });
  }
});

// ─── GET /api/admin/payments ─────────────────────────────────────────────────
router.get("/payments", authorize("Admin"), async (req, res) => {
  try {
    const { status, payment_method, limit = 50, offset = 0 } = req.query;
    
    let query = `
      SELECT t.*, f.name as field_name, fr.full_name as farmer_name, u.name as investor_name 
      FROM agrihub.transactions t 
      LEFT JOIN agrihub.fields f ON t.field_id = f.id 
      LEFT JOIN agrihub.farmers fr ON t.farmer_id = fr.id 
      LEFT JOIN agrihub.users u ON t.investor_id = u.id 
      WHERE 1=1
    `;
    const params = [];
    let paramIndex = 1;
    
    if (status) {
      query += ` AND t.payment_status = $${paramIndex++}`;
      params.push(status);
    }
    if (payment_method) {
      query += ` AND t.payment_method = $${paramIndex++}`;
      params.push(payment_method);
    }
    
    query += ` ORDER BY t.created_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
    params.push(parseInt(limit), parseInt(offset));
    
    const payments = await queryMany(query, params);
    res.json(payments);
  } catch (error) {
    console.error("Error fetching admin payments:", error);
    res.status(500).json({ error: "Failed to fetch admin payments" });
  }
});

// ─── GET /api/admin/pending-transactions ─────────────────────────────────────
router.get("/pending-transactions", authorize("Admin"), async (req, res) => {
  try {
    const pending = await queryMany(`
      SELECT t.*, f.name as field_name, fr.full_name as farmer_name, u.name as investor_name, mt.status as mpesa_status
      FROM agrihub.transactions t 
      LEFT JOIN agrihub.fields f ON t.field_id = f.id 
      LEFT JOIN agrihub.farmers fr ON t.farmer_id = fr.id 
      LEFT JOIN agrihub.users u ON t.investor_id = u.id
      LEFT JOIN agrihub.mpesa_transactions mt ON t.payment_reference = mt.mpesa_receipt_number
      WHERE t.payment_status = 'pending'
      ORDER BY t.created_at DESC
    `);
    
    res.json(pending);
  } catch (error) {
    console.error("Error fetching pending transactions:", error);
    res.status(500).json({ error: "Failed to fetch pending transactions" });
  }
});

// ─── POST /api/admin/reverse-transaction ─────────────────────────────────────
router.post("/reverse-transaction", authorize("Admin"), async (req, res) => {
  try {
    const { transaction_id, reason } = req.body;
    
    if (!transaction_id) {
      return res.status(400).json({ error: "Transaction ID required" });
    }

    const txnRecord = await queryOne("SELECT * FROM agrihub.transactions WHERE id = $1", [transaction_id]);
    if (!txnRecord) return res.status(404).json({ error: "Transaction not found" });

    if (txnRecord.payment_status !== 'completed') {
      return res.status(400).json({ error: "Only completed transactions can be reversed" });
    }

    await transaction(async (client) => {
      // Update transaction status
      await client.query("UPDATE agrihub.transactions SET payment_status = 'reversed', updated_at = NOW() WHERE id = $1", [transaction_id]);

      // Update field status
      await client.query("UPDATE agrihub.fields SET status = 'surveyed', investor_id = NULL, updated_at = NOW() WHERE id = $1", [txnRecord.field_id]);

      // Refund to wallet if applicable
      if (txnRecord.wallet_transaction_id) {
        const walletTx = await queryOne("SELECT * FROM agrihub.wallet_transactions WHERE id = $1", [txnRecord.wallet_transaction_id]);
        if (walletTx) {
          const wallet = await queryOne("SELECT * FROM agrihub.wallets WHERE id = $1", [walletTx.wallet_id]);
          if (wallet) {
            const balanceBefore = wallet.balance;
            const balanceAfter = balanceBefore + walletTx.amount;
            
            await client.query("UPDATE agrihub.wallets SET balance = $1, available_balance = $2, updated_at = NOW() WHERE id = $3",
              [balanceAfter, balanceAfter, wallet.id]);

            const refundTxId = uuid();
            await client.query(
              `INSERT INTO agrihub.wallet_transactions (id, wallet_id, transaction_type, amount, balance_before, balance_after, reference, description, related_transaction_id, metadata)
              VALUES ($1, $2, 'refund', $3, $4, $5, $6, $7, $8, $9)`,
              [
                refundTxId, wallet.id, walletTx.amount, balanceBefore, balanceAfter,
                `REFUND-${transaction_id.slice(0, 8)}`, `Reversal refund: ${reason || 'Admin reversal'}`, transaction_id,
                JSON.stringify({ reversal_reason: reason, original_transaction: transaction_id })
              ]
            );
          }
        }
      }

      await logAudit(req.user.id, 'transaction_reversed', 'transaction', transaction_id, txnRecord.payment_amount, req, { payment_status: 'completed' }, { payment_status: 'reversed' }, transaction_id, null, null, null);
    });

    res.json({ ok: true, message: "Transaction reversed successfully" });
  } catch (err) {
    console.error("Reverse transaction error:", err);
    res.status(500).json({ error: "Failed to reverse transaction" });
  }
});

// ─── GET /api/admin/wallets ──────────────────────────────────────────────────
router.get("/wallets", authorize("Admin"), async (req, res) => {
  try {
    const { status, limit = 50, offset = 0 } = req.query;
    
    let query = `
      SELECT w.*, u.username, u.name as user_name, u.role 
      FROM agrihub.wallets w 
      LEFT JOIN agrihub.users u ON w.user_id = u.id 
      WHERE 1=1
    `;
    const params = [];
    let paramIndex = 1;
    
    if (status) {
      query += ` AND w.status = $${paramIndex++}`;
      params.push(status);
    }
    
    query += ` ORDER BY w.created_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
    params.push(parseInt(limit), parseInt(offset));
    
    const wallets = await queryMany(query, params);
    res.json(wallets);
  } catch (error) {
    console.error("Error fetching admin wallets:", error);
    res.status(500).json({ error: "Failed to fetch admin wallets" });
  }
});

// ─── GET /api/admin/audit-logs ─────────────────────────────────────────────
router.get("/audit-logs", authorize("Admin"), async (req, res) => {
  try {
    const { user_id, action, entity_type, limit = 100, offset = 0 } = req.query;
    
    let query = `
      SELECT al.*, u.name as user_name, u.username 
      FROM agrihub.audit_logs al 
      LEFT JOIN agrihub.users u ON al.user_id = u.id 
      WHERE 1=1
    `;
    const params = [];
    let paramIndex = 1;
    
    if (user_id) {
      query += ` AND al.user_id = $${paramIndex++}`;
      params.push(user_id);
    }
    if (action) {
      query += ` AND al.action = $${paramIndex++}`;
      params.push(action);
    }
    if (entity_type) {
      query += ` AND al.entity_type = $${paramIndex++}`;
      params.push(entity_type);
    }
    
    query += ` ORDER BY al.created_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
    params.push(parseInt(limit), parseInt(offset));
    
    const logs = await queryMany(query, params);
    res.json(logs.map(l => ({ ...l, before_state: l.before_state || null, after_state: l.after_state || null })));
  } catch (error) {
    console.error("Error fetching audit logs:", error);
    res.status(500).json({ error: "Failed to fetch audit logs" });
  }
});

// ─── GET /api/admin/system-config ───────────────────────────────────────────
router.get("/system-config", authorize("Admin"), async (req, res) => {
  try {
    const configs = await queryMany("SELECT * FROM agrihub.system_config ORDER BY key");
    res.json(configs);
  } catch (error) {
    console.error("Error fetching system config:", error);
    res.status(500).json({ error: "Failed to fetch system config" });
  }
});

// ─── PUT /api/admin/system-config/:key ───────────────────────────────────────
router.put("/system-config/:key", authorize("Admin"), async (req, res) => {
  try {
    const { value, description } = req.body;
    
    if (!value) {
      return res.status(400).json({ error: "Value required" });
    }

    const existing = await queryOne("SELECT * FROM agrihub.system_config WHERE key = $1", [req.params.key]);
    const beforeState = existing ? { value: existing.value } : null;

    await pool.query(
      `INSERT INTO agrihub.system_config (key, value, description, updated_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT(key) DO UPDATE SET value = $1, description = COALESCE($4, description), updated_at = NOW()`,
      [req.params.key, value, description, value, description]
    );

    const afterState = { value };

    await logAudit(req.user.id, 'system_config_updated', 'system_config', req.params.key, null, req, beforeState, afterState, null, null, null, null);

    res.json({ ok: true, key: req.params.key, value });
  } catch (error) {
    console.error("Error updating system config:", error);
    res.status(500).json({ error: "Failed to update system config" });
  }
});

// ─── GET /api/admin/users ────────────────────────────────────────────────────
router.get("/users", authorize("Admin"), async (req, res) => {
  try {
    const { role, status, limit = 50, offset = 0 } = req.query;
    
    let query = "SELECT id, username, name, role, phone, email, kyc_verified, created_at FROM agrihub.users WHERE 1=1";
    const params = [];
    let paramIndex = 1;
    
    if (role) {
      query += ` AND role = $${paramIndex++}`;
      params.push(role);
    }
    
    query += ` ORDER BY created_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
    params.push(parseInt(limit), parseInt(offset));
    
    const users = await queryMany(query, params);
    res.json(users);
  } catch (error) {
    console.error("Error fetching admin users:", error);
    res.status(500).json({ error: "Failed to fetch admin users" });
  }
});

// ─── POST /api/admin/users ────────────────────────────────────────────────────
router.post("/users", authorize("Admin"), async (req, res) => {
  try {
    const { username, password, role, name, phone, email } = req.body;
    
    if (!username || !password || !role || !name) {
      return res.status(400).json({ error: "Username, password, role, and name required" });
    }

    const hashedPassword = bcrypt.hashSync(password, 10);
    const id = uuid();

    await pool.query(
      `INSERT INTO agrihub.users (id, username, password, role, name, phone, email, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
      [id, username, hashedPassword, role, name, phone || null, email || null]
    );

    await logAudit(req.user.id, 'user_created', 'user', id, null, req, null, { username, role }, null, null, null, null);

    const user = await queryOne("SELECT id, username, name, role, phone, email, created_at FROM agrihub.users WHERE id = $1", [id]);
    res.status(201).json(user);
  } catch (err) {
    console.error("Create user error:", err);
    if (err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: "Username already exists" });
    }
    res.status(500).json({ error: "Failed to create user" });
  }
});

// ─── GET /api/admin/reports/financial ────────────────────────────────────────
router.get("/reports/financial", authorize("Admin"), async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    
    const startDate = start_date || new Date(new Date().setMonth(new Date().getMonth() - 1)).toISOString().split('T')[0];
    const endDate = end_date || new Date().toISOString().split('T')[0];

    const revenue = await queryOne(
      `SELECT SUM(payment_amount) as total, COUNT(*) as count 
      FROM agrihub.transactions 
      WHERE payment_status = 'completed' 
      AND payment_date >= $1 AND payment_date <= $2`,
      [startDate, endDate]
    );

    const platformFees = await queryOne(
      `SELECT SUM(platform_fee) as total 
      FROM agrihub.payment_requests 
      WHERE status = 'completed'
      AND created_at >= $1 AND created_at <= $2`,
      [startDate, endDate]
    );

    const refunds = await queryOne(
      `SELECT SUM(amount) as total, COUNT(*) as count 
      FROM agrihub.wallet_transactions 
      WHERE transaction_type = 'refund' 
      AND created_at >= $1 AND created_at <= $2`,
      [startDate, endDate]
    );

    const escrowActivity = await queryOne(
      `SELECT 
        COUNT(*) as total,
        SUM(amount) as total_amount,
        SUM(released_amount) as total_released,
        SUM(refund_amount) as total_refunded
      FROM agrihub.escrow_accounts
      WHERE created_at >= $1 AND created_at <= $2`,
      [startDate, endDate]
    );

    res.json({
      period: { start_date: startDate, end_date: endDate },
      revenue,
      platform_fees: platformFees,
      refunds,
      escrow_activity: escrowActivity,
      net_revenue: (revenue.total || 0) - (refunds.total || 0)
    });
  } catch (error) {
    console.error("Error fetching financial report:", error);
    res.status(500).json({ error: "Failed to fetch financial report" });
  }
});

export default router;
