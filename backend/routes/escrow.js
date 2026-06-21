import { Router } from "express";
import { v4 as uuid } from "uuid";
import pool, { queryOne, queryMany, transaction } from "../db-postgres.js";
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

// ─── GET /api/escrow/config ───────────────────────────────────────────────────
router.get("/config", authorize("Admin"), async (req, res) => {
  try {
    const escrowMode = await queryOne("SELECT value FROM agrihub.system_config WHERE key = 'escrow_mode'");
    res.json({ escrow_mode: escrowMode?.value || 'disabled' });
  } catch (error) {
    console.error("Error fetching escrow config:", error);
    res.status(500).json({ error: "Failed to fetch escrow config" });
  }
});

// ─── PUT /api/escrow/config ────────────────────────────────────────────────────
router.put("/config", authorize("Admin"), async (req, res) => {
  try {
    const { escrow_mode } = req.body;
    
    if (!escrow_mode || !['enabled', 'disabled'].includes(escrow_mode)) {
      return res.status(400).json({ error: "escrow_mode must be 'enabled' or 'disabled'" });
    }

    await pool.query("UPDATE agrihub.system_config SET value = $1, updated_at = NOW() WHERE key = 'escrow_mode'", [escrow_mode]);
    
    await logAudit(req.user.id, 'escrow_config_changed', 'system_config', 'escrow_mode', null, req, null, { escrow_mode }, null, null, null, null);

    res.json({ ok: true, escrow_mode });
  } catch (error) {
    console.error("Error updating escrow config:", error);
    res.status(500).json({ error: "Failed to update escrow config" });
  }
});

// ─── GET /api/escrow/accounts ─────────────────────────────────────────────────
router.get("/accounts", authorize("Admin"), async (req, res) => {
  try {
    const { status, field_id, investor_id } = req.query;
    
    let query = "SELECT * FROM agrihub.escrow_accounts WHERE 1=1";
    const params = [];
    let paramIndex = 1;
    
    if (status) {
      query += ` AND status = $${paramIndex++}`;
      params.push(status);
    }
    if (field_id) {
      query += ` AND field_id = $${paramIndex++}`;
      params.push(field_id);
    }
    if (investor_id) {
      query += ` AND investor_id = $${paramIndex++}`;
      params.push(investor_id);
    }
    
    query += " ORDER BY created_at DESC";
    const accounts = await queryMany(query, params);
    res.json(accounts);
  } catch (error) {
    console.error("Error fetching escrow accounts:", error);
    res.status(500).json({ error: "Failed to fetch escrow accounts" });
  }
});

// ─── GET /api/escrow/accounts/:id ─────────────────────────────────────────────
router.get("/accounts/:id", authenticate, async (req, res) => {
  try {
    const account = await queryOne("SELECT * FROM agrihub.escrow_accounts WHERE id = $1", [req.params.id]);
    if (!account) return res.status(404).json({ error: "Escrow account not found" });
    
    // Check authorization
    if (account.investor_id !== req.user.id && req.user.role !== 'Admin') {
      return res.status(403).json({ error: "Not authorized to view this escrow account" });
    }
    
    res.json(account);
  } catch (error) {
    console.error("Error fetching escrow account:", error);
    res.status(500).json({ error: "Failed to fetch escrow account" });
  }
});

// ─── POST /api/escrow/release ──────────────────────────────────────────────────
router.post("/release", authorize("Admin", "Field Officer"), async (req, res) => {
  try {
    const { escrow_account_id, release_amount, release_notes } = req.body;
    
    if (!escrow_account_id) {
      return res.status(400).json({ error: "Escrow account ID required" });
    }

    const account = await queryOne("SELECT * FROM agrihub.escrow_accounts WHERE id = $1", [escrow_account_id]);
    if (!account) return res.status(404).json({ error: "Escrow account not found" });

    if (account.status !== 'locked') {
      return res.status(400).json({ error: "Escrow account must be in locked status to release funds" });
    }

    const field = await queryOne("SELECT * FROM agrihub.fields WHERE id = $1", [account.field_id]);
    if (!field) return res.status(404).json({ error: "Field not found" });

    const farmer = await queryOne("SELECT * FROM agrihub.farmers WHERE id = $1", [account.farmer_id]);
    if (!farmer) return res.status(404).json({ error: "Farmer not found" });

    const amountToRelease = release_amount || account.amount;
    if (amountToRelease > account.amount) {
      return res.status(400).json({ error: "Release amount exceeds escrow balance" });
    }

    const isPartialRelease = amountToRelease < account.amount;
    const newStatus = isPartialRelease ? 'partial_release' : 'released';

    await transaction(async (client) => {
      // Update escrow account
      await client.query(
        `UPDATE agrihub.escrow_accounts 
        SET status = $1, 
            released_amount = released_amount + $2,
            released_at = CASE WHEN $3 = 'released' THEN NOW() ELSE released_at END,
            updated_at = NOW()
        WHERE id = $4`,
        [newStatus, amountToRelease, newStatus, escrow_account_id]
      );

      // Update field status
      await client.query("UPDATE agrihub.fields SET status = 'harvest_approved', updated_at = NOW() WHERE id = $1", [account.field_id]);

      // If full release, update transaction status
      if (!isPartialRelease) {
        await client.query("UPDATE agrihub.transactions SET payment_status = 'completed', updated_at = NOW() WHERE id = $1", [account.transaction_id]);
      }

      // Record wallet transaction for investor (if tracking)
      const wallet = await queryOne("SELECT * FROM agrihub.wallets WHERE user_id = $1", [account.investor_id]);
      if (wallet) {
        const walletTxId = uuid();
        await client.query(
          `INSERT INTO agrihub.wallet_transactions (id, wallet_id, transaction_type, amount, balance_before, balance_after, reference, description, related_escrow_id, metadata)
          VALUES ($1, $2, 'escrow_release', $3, $4, $5, $6, $7, $8, $9)`,
          [
            walletTxId, wallet.id, amountToRelease, wallet.balance, wallet.balance,
            `ESC-RELEASE-${escrow_account_id.slice(0, 8)}`, `Escrow release for field: ${field.name}`, escrow_account_id,
            JSON.stringify({ field_id: account.field_id, farmer_id: account.farmer_id, release_notes })
          ]
        );
      }

      await logAudit(
        req.user.id, 'escrow_release', 'escrow_account', escrow_account_id, amountToRelease, req,
        { status: 'locked', released_amount: account.released_amount },
        { status: newStatus, released_amount: account.released_amount + amountToRelease },
        account.transaction_id, null, null, null
      );
    });

    const updated = await queryOne("SELECT * FROM agrihub.escrow_accounts WHERE id = $1", [escrow_account_id]);
    res.json({ 
      ok: true, 
      escrow_account: updated,
      message: isPartialRelease ? "Partial release processed" : "Full release processed - funds available for farmer payment"
    });
  } catch (err) {
    console.error("Escrow release error:", err);
    res.status(500).json({ error: "Failed to release escrow funds" });
  }
});

// ─── POST /api/escrow/refund ──────────────────────────────────────────────────
router.post("/refund", authorize("Admin"), async (req, res) => {
  try {
    const { escrow_account_id, refund_amount, refund_reason } = req.body;
    
    if (!escrow_account_id) {
      return res.status(400).json({ error: "Escrow account ID required" });
    }

    const account = await queryOne("SELECT * FROM agrihub.escrow_accounts WHERE id = $1", [escrow_account_id]);
    if (!account) return res.status(404).json({ error: "Escrow account not found" });

    if (account.status === 'refunded') {
      return res.status(400).json({ error: "Escrow account already refunded" });
    }

    const amountToRefund = refund_amount || (account.amount - account.released_amount);
    if (amountToRefund > (account.amount - account.released_amount)) {
      return res.status(400).json({ error: "Refund amount exceeds available balance" });
    }

    const isFullRefund = (account.released_amount + amountToRefund) === account.amount;
    const newStatus = isFullRefund ? 'refunded' : account.status;

    await transaction(async (client) => {
      // Update escrow account
      await client.query(
        `UPDATE agrihub.escrow_accounts 
        SET status = $1,
            refund_amount = refund_amount + $2,
            refunded_at = CASE WHEN $3 = 'refunded' THEN NOW() ELSE refunded_at END,
            updated_at = NOW()
        WHERE id = $4`,
        [newStatus, amountToRefund, newStatus, escrow_account_id]
      );

      // Refund to investor wallet
      const wallet = await queryOne("SELECT * FROM agrihub.wallets WHERE user_id = $1", [account.investor_id]);
      if (wallet) {
        const balanceBefore = wallet.balance;
        const balanceAfter = balanceBefore + amountToRefund;
        
        await client.query("UPDATE agrihub.wallets SET balance = $1, available_balance = $2, updated_at = NOW() WHERE id = $3",
          [balanceAfter, balanceAfter, wallet.id]);

        const walletTxId = uuid();
        await client.query(
          `INSERT INTO agrihub.wallet_transactions (id, wallet_id, transaction_type, amount, balance_before, balance_after, reference, description, related_escrow_id, metadata)
          VALUES ($1, $2, 'refund', $3, $4, $5, $6, $7, $8, $9)`,
          [
            walletTxId, wallet.id, amountToRefund, balanceBefore, balanceAfter,
            `ESC-REFUND-${escrow_account_id.slice(0, 8)}`, `Escrow refund: ${refund_reason || 'Field purchase cancelled'}`, escrow_account_id,
            JSON.stringify({ field_id: account.field_id, refund_reason })
          ]
        );
      }

      // Update field status if full refund
      if (isFullRefund) {
        await client.query("UPDATE agrihub.fields SET status = 'surveyed', investor_id = NULL, updated_at = NOW() WHERE id = $1", [account.field_id]);
        await client.query("UPDATE agrihub.transactions SET payment_status = 'failed', updated_at = NOW() WHERE id = $1", [account.transaction_id]);
      }

      await logAudit(
        req.user.id, 'escrow_refund', 'escrow_account', escrow_account_id, amountToRefund, req,
        { status: account.status, refund_amount: account.refund_amount },
        { status: newStatus, refund_amount: account.refund_amount + amountToRefund },
        account.transaction_id, null, null, null
      );
    });

    const updated = await queryOne("SELECT * FROM agrihub.escrow_accounts WHERE id = $1", [escrow_account_id]);
    res.json({ 
      ok: true, 
      escrow_account: updated,
      message: isFullRefund ? "Full refund processed to investor wallet" : "Partial refund processed"
    });
  } catch (err) {
    console.error("Escrow refund error:", err);
    res.status(500).json({ error: "Failed to process escrow refund" });
  }
});

// ─── GET /api/escrow/summary ─────────────────────────────────────────────────
router.get("/summary", authorize("Admin"), async (req, res) => {
  try {
    const summary = await queryOne(
      `SELECT 
        COUNT(*) as total_escrow_accounts,
        SUM(CASE WHEN status = 'locked' THEN 1 ELSE 0 END) as locked_count,
        SUM(CASE WHEN status = 'released' THEN 1 ELSE 0 END) as released_count,
        SUM(CASE WHEN status = 'refunded' THEN 1 ELSE 0 END) as refunded_count,
        SUM(CASE WHEN status = 'partial_release' THEN 1 ELSE 0 END) as partial_release_count,
        SUM(amount) as total_escrowed_amount,
        SUM(released_amount) as total_released_amount,
        SUM(refund_amount) as total_refunded_amount,
        SUM(amount - released_amount - refund_amount) as current_locked_amount
      FROM agrihub.escrow_accounts`
    );

    res.json(summary);
  } catch (error) {
    console.error("Error fetching escrow summary:", error);
    res.status(500).json({ error: "Failed to fetch escrow summary" });
  }
});

export default router;
