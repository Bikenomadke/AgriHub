import { Router } from "express";
import { v4 as uuid } from "uuid";
import pool, { queryOne, queryMany, transaction } from "../db-postgres.js";
import { authenticate, authorize } from "../middleware/auth.js";

const router = Router();
router.use(authenticate);

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function createWallet(userId) {
  const id = uuid();
  await pool.query(
    `INSERT INTO agrihub.wallets (id, user_id, balance, available_balance, frozen_balance, status)
    VALUES ($1, $2, 0, 0, 0, 'active')`,
    [id, userId]
  );
  return id;
}

async function ensureWalletExists(userId) {
  let wallet = await queryOne("SELECT * FROM agrihub.wallets WHERE user_id = $1", [userId]);
  if (!wallet) {
    const walletId = await createWallet(userId);
    wallet = await queryOne("SELECT * FROM agrihub.wallets WHERE id = $1", [walletId]);
  }
  return wallet;
}

async function recordWalletTransaction(walletId, type, amount, balanceBefore, balanceAfter, reference, description, relatedTransactionId, relatedEscrowId, metadata) {
  const id = uuid();
  await pool.query(
    `INSERT INTO agrihub.wallet_transactions (id, wallet_id, transaction_type, amount, balance_before, balance_after, reference, description, related_transaction_id, related_escrow_id, metadata)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [id, walletId, type, amount, balanceBefore, balanceAfter, reference, description, relatedTransactionId, relatedEscrowId, metadata]
  );
  return id;
}

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

// ─── GET /api/wallets/my-wallet ───────────────────────────────────────────────
router.get("/my-wallet", authenticate, async (req, res) => {
  try {
    const wallet = await ensureWalletExists(req.user.id);
    const transactions = await queryMany(
      `SELECT * FROM agrihub.wallet_transactions 
      WHERE wallet_id = $1 
      ORDER BY created_at DESC 
      LIMIT 50`,
      [wallet.id]
    );
    
    res.json({
      wallet,
      transactions: transactions.map(t => ({ ...t, metadata: t.metadata || null }))
    });
  } catch (error) {
    console.error("Error fetching wallet:", error);
    res.status(500).json({ error: "Failed to fetch wallet" });
  }
});

// ─── POST /api/wallets/deposit ────────────────────────────────────────────────
router.post("/deposit", authorize("Admin", "Investor"), async (req, res) => {
  const { amount, reference, description } = req.body;
  
  if (!amount || amount <= 0) {
    return res.status(400).json({ error: "Valid deposit amount required" });
  }

  try {
    const wallet = await ensureWalletExists(req.user.id);
    const balanceBefore = wallet.balance;
    const balanceAfter = balanceBefore + amount;

    await transaction(async (client) => {
      await client.query(
        `UPDATE agrihub.wallets 
        SET balance = $1, available_balance = $2, updated_at = NOW()
        WHERE id = $3`,
        [balanceAfter, balanceAfter, wallet.id]
      );

      const transactionId = await recordWalletTransaction(
        wallet.id, 'deposit', amount, balanceBefore, balanceAfter,
        reference, description, null, null,
        JSON.stringify({ method: 'manual', performed_by: req.user.username })
      );

      await logAudit(
        req.user.id, 'wallet_deposit', 'wallet', wallet.id, amount, req,
        { balance: balanceBefore }, { balance: balanceAfter },
        null, null, null, transactionId
      );

      return transactionId;
    });

    const updatedWallet = await queryOne("SELECT * FROM agrihub.wallets WHERE id = $1", [wallet.id]);
    res.status(201).json({ wallet: updatedWallet });
  } catch (err) {
    console.error("Deposit error:", err);
    res.status(500).json({ error: "Failed to process deposit" });
  }
});

// ─── POST /api/wallets/withdraw ───────────────────────────────────────────────
router.post("/withdraw", authorize("Admin", "Investor"), async (req, res) => {
  const { amount, reference, description } = req.body;
  
  if (!amount || amount <= 0) {
    return res.status(400).json({ error: "Valid withdrawal amount required" });
  }

  try {
    const wallet = await ensureWalletExists(req.user.id);
    
    if (wallet.available_balance < amount) {
      return res.status(400).json({ error: "Insufficient available balance" });
    }

    const balanceBefore = wallet.balance;
    const balanceAfter = balanceBefore - amount;

    await transaction(async (client) => {
      await client.query(
        `UPDATE agrihub.wallets 
        SET balance = $1, available_balance = $2, updated_at = NOW()
        WHERE id = $3`,
        [balanceAfter, balanceAfter, wallet.id]
      );

      const transactionId = await recordWalletTransaction(
        wallet.id, 'withdrawal', amount, balanceBefore, balanceAfter,
        reference, description, null, null,
        JSON.stringify({ method: 'manual', performed_by: req.user.username })
      );

      await logAudit(
        req.user.id, 'wallet_withdrawal', 'wallet', wallet.id, amount, req,
        { balance: balanceBefore }, { balance: balanceAfter },
        null, null, null, transactionId
      );

      return transactionId;
    });

    const updatedWallet = await queryOne("SELECT * FROM agrihub.wallets WHERE id = $1", [wallet.id]);
    res.status(201).json({ wallet: updatedWallet });
  } catch (err) {
    console.error("Withdrawal error:", err);
    res.status(500).json({ error: "Failed to process withdrawal" });
  }
});

// ─── GET /api/wallets/transactions ───────────────────────────────────────────
router.get("/transactions", authenticate, async (req, res) => {
  try {
    const wallet = await ensureWalletExists(req.user.id);
    const { limit = 50, offset = 0, type } = req.query;
    
    let query = "SELECT * FROM agrihub.wallet_transactions WHERE wallet_id = $1";
    const params = [wallet.id];
    let paramIndex = 2;
    
    if (type) {
      query += ` AND transaction_type = $${paramIndex++}`;
      params.push(type);
    }
    
    query += ` ORDER BY created_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
    params.push(parseInt(limit), parseInt(offset));
    
    const transactions = await queryMany(query, params);
    res.json(transactions.map(t => ({ ...t, metadata: t.metadata || null })));
  } catch (error) {
    console.error("Error fetching wallet transactions:", error);
    res.status(500).json({ error: "Failed to fetch wallet transactions" });
  }
});

// ─── GET /api/wallets/statement ──────────────────────────────────────────────
router.get("/statement", authenticate, async (req, res) => {
  try {
    const wallet = await ensureWalletExists(req.user.id);
    const { start_date, end_date } = req.query;
    
    let query = "SELECT * FROM agrihub.wallet_transactions WHERE wallet_id = $1";
    const params = [wallet.id];
    let paramIndex = 2;
    
    if (start_date) {
      query += ` AND created_at >= $${paramIndex++}`;
      params.push(start_date);
    }
    if (end_date) {
      query += ` AND created_at <= $${paramIndex++}`;
      params.push(end_date);
    }
    
    query += " ORDER BY created_at ASC";
    
    const transactions = await queryMany(query, params);
    
    const summary = {
      total_deposits: transactions.filter(t => t.transaction_type === 'deposit').reduce((sum, t) => sum + t.amount, 0),
      total_withdrawals: transactions.filter(t => t.transaction_type === 'withdrawal').reduce((sum, t) => sum + t.amount, 0),
      total_payments: transactions.filter(t => t.transaction_type === 'payment').reduce((sum, t) => sum + t.amount, 0),
      total_refunds: transactions.filter(t => t.transaction_type === 'refund').reduce((sum, t) => sum + t.amount, 0),
      opening_balance: transactions.length > 0 ? transactions[0].balance_before : 0,
      closing_balance: wallet.balance
    };
    
    res.json({
      wallet,
      summary,
      transactions: transactions.map(t => ({ ...t, metadata: t.metadata || null }))
    });
  } catch (error) {
    console.error("Error fetching wallet statement:", error);
    res.status(500).json({ error: "Failed to fetch wallet statement" });
  }
});

// ─── GET /api/wallets/:userId (Admin only) ─────────────────────────────────────
router.get("/:userId", authorize("Admin"), async (req, res) => {
  try {
    const wallet = await ensureWalletExists(req.params.userId);
    const transactions = await queryMany(
      `SELECT * FROM agrihub.wallet_transactions 
      WHERE wallet_id = $1 
      ORDER BY created_at DESC 
      LIMIT 100`,
      [wallet.id]
    );
    
    res.json({
      wallet,
      transactions: transactions.map(t => ({ ...t, metadata: t.metadata || null }))
    });
  } catch (error) {
    console.error("Error fetching user wallet:", error);
    res.status(500).json({ error: "Failed to fetch user wallet" });
  }
});

// ─── POST /api/wallets/:userId/freeze (Admin only) ────────────────────────────
router.post("/:userId/freeze", authorize("Admin"), async (req, res) => {
  try {
    const wallet = await queryOne("SELECT * FROM agrihub.wallets WHERE user_id = $1", [req.params.userId]);
    if (!wallet) return res.status(404).json({ error: "Wallet not found" });
    
    const beforeState = { status: wallet.status };
    
    await pool.query(
      `UPDATE agrihub.wallets 
      SET status = 'frozen', updated_at = NOW()
      WHERE user_id = $1`,
      [req.params.userId]
    );
    
    const afterState = { status: 'frozen' };
    
    await logAudit(
      req.user.id, 'wallet_freeze', 'wallet', wallet.id, null, req,
      beforeState, afterState,
      null, null, null, null
    );
    
    const updated = await queryOne("SELECT * FROM agrihub.wallets WHERE user_id = $1", [req.params.userId]);
    res.json({ wallet: updated });
  } catch (err) {
    console.error("Freeze wallet error:", err);
    res.status(500).json({ error: "Failed to freeze wallet" });
  }
});

// ─── POST /api/wallets/:userId/unfreeze (Admin only) ──────────────────────────
router.post("/:userId/unfreeze", authorize("Admin"), async (req, res) => {
  try {
    const wallet = await queryOne("SELECT * FROM agrihub.wallets WHERE user_id = $1", [req.params.userId]);
    if (!wallet) return res.status(404).json({ error: "Wallet not found" });
    
    const beforeState = { status: wallet.status };
    
    await pool.query(
      `UPDATE agrihub.wallets 
      SET status = 'active', updated_at = NOW()
      WHERE user_id = $1`,
      [req.params.userId]
    );
    
    const afterState = { status: 'active' };
    
    await logAudit(
      req.user.id, 'wallet_unfreeze', 'wallet', wallet.id, null, req,
      beforeState, afterState,
      null, null, null, null
    );
    
    const updated = await queryOne("SELECT * FROM agrihub.wallets WHERE user_id = $1", [req.params.userId]);
    res.json({ wallet: updated });
  } catch (err) {
    console.error("Unfreeze wallet error:", err);
    res.status(500).json({ error: "Failed to unfreeze wallet" });
  }
});

// ─── POST /api/wallets/adjust (Admin only) ───────────────────────────────────
router.post("/adjust", authorize("Admin"), async (req, res) => {
  const { user_id, amount, reason, reference } = req.body;
  
  if (!user_id || !amount) {
    return res.status(400).json({ error: "User ID and amount required" });
  }

  try {
    const wallet = await ensureWalletExists(user_id);
    const balanceBefore = wallet.balance;
    const balanceAfter = balanceBefore + amount;
    
    if (balanceAfter < 0) {
      return res.status(400).json({ error: "Adjustment would result in negative balance" });
    }

    await transaction(async (client) => {
      await client.query(
        `UPDATE agrihub.wallets 
        SET balance = $1, available_balance = $2, updated_at = NOW()
        WHERE id = $3`,
        [balanceAfter, balanceAfter, wallet.id]
      );

      const transactionType = amount >= 0 ? 'adjustment' : 'adjustment';
      const transactionId = await recordWalletTransaction(
        wallet.id, transactionType, Math.abs(amount), balanceBefore, balanceAfter,
        reference, reason || 'Admin adjustment', null, null,
        JSON.stringify({ method: 'admin_adjustment', performed_by: req.user.username, adjustment_type: amount >= 0 ? 'credit' : 'debit' })
      );

      await logAudit(
        req.user.id, 'wallet_adjustment', 'wallet', wallet.id, amount, req,
        { balance: balanceBefore }, { balance: balanceAfter },
        null, null, null, transactionId
      );

      return transactionId;
    });

    const updatedWallet = await queryOne("SELECT * FROM agrihub.wallets WHERE id = $1", [wallet.id]);
    res.status(201).json({ wallet: updatedWallet });
  } catch (err) {
    console.error("Adjustment error:", err);
    res.status(500).json({ error: "Failed to process adjustment" });
  }
});

export default router;
