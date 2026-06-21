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

// ─── POST /api/reconciliation/start ───────────────────────────────────────────
router.post("/start", authorize("Admin"), async (req, res) => {
  try {
    const { period_type = "daily", start_date, end_date } = req.body;
    
    if (!start_date || !end_date) {
      return res.status(400).json({ error: "Start date and end date required" });
    }

    // Check if reconciliation already exists for this period
    const existing = await queryOne(
      `SELECT * FROM agrihub.reconciliation_records 
      WHERE period_type = $1 AND start_date = $2 AND end_date = $3 AND status != 'failed'`,
      [period_type, start_date, end_date]
    );
    
    if (existing) {
      return res.status(400).json({ error: "Reconciliation already exists for this period", existing });
    }

    const { reconciliationId, discrepancies } = await transaction(async (client) => {
      // Create reconciliation record
      const reconciliationId = uuid();
      await client.query(
        `INSERT INTO agrihub.reconciliation_records (id, reconciliation_date, period_type, start_date, end_date, status, performed_by)
        VALUES ($1, NOW(), $2, $3, $4, 'in_progress', $5)`,
        [reconciliationId, period_type, start_date, end_date, req.user.id]
      );

      // Get all transactions in the period
      const transactions = await client.query(
        `SELECT * FROM agrihub.transactions 
        WHERE payment_status IN ('completed', 'reversed')
        AND payment_date >= $1 AND payment_date <= $2
        ORDER BY payment_date`,
        [start_date, end_date]
      );

      const totalTransactions = transactions.rows.length;
      const totalAmount = transactions.rows.reduce((sum, t) => sum + (t.payment_amount || 0), 0);

      // Get M-Pesa transactions in the period
      const mpesaTransactions = await client.query(
        `SELECT * FROM agrihub.mpesa_transactions 
        WHERE status = 'completed'
        AND created_at >= $1 AND created_at <= $2
        ORDER BY created_at`,
        [start_date, end_date]
      );

      const mpesaTotalAmount = mpesaTransactions.rows.reduce((sum, t) => sum + (t.amount || 0), 0);

      // Match transactions
      let matchedCount = 0;
      let unmatchedCount = 0;
      let failedCount = 0;
      let reversalCount = 0;
      const discrepancies = [];

      for (const txn of transactions.rows) {
        const mpesaMatch = mpesaTransactions.rows.find(m => 
          m.mpesa_receipt_number === txn.payment_reference ||
          m.transaction_id === txn.id
        );

        if (mpesaMatch) {
          matchedCount++;
          
          // Check amount match
          if (Math.abs((txn.payment_amount || 0) - (mpesaMatch.amount || 0)) > 0.01) {
            discrepancies.push({
              transaction_id: txn.id,
              type: 'amount_mismatch',
              system_amount: txn.payment_amount,
              mpesa_amount: mpesaMatch.amount
            });
          }
        } else if (txn.payment_status === 'reversed') {
          reversalCount++;
        } else {
          unmatchedCount++;
          discrepancies.push({
            transaction_id: txn.id,
            type: 'no_mpesa_match',
            payment_reference: txn.payment_reference
          });
        }
      }

      // Check for failed transactions
      const failedTransactions = await client.query(
        `SELECT * FROM agrihub.transactions 
        WHERE payment_status = 'failed'
        AND payment_date >= $1 AND payment_date <= $2`,
        [start_date, end_date]
      );
      
      failedCount = failedTransactions.rows.length;

      // Update reconciliation record
      await client.query(
        `UPDATE agrihub.reconciliation_records 
        SET total_transactions = $1,
            total_amount = $2,
            mpesa_total_amount = $3,
            matched_transactions = $4,
            unmatched_transactions = $5,
            failed_transactions = $6,
            reversal_count = $7,
            discrepancies = $8,
            status = 'completed',
            updated_at = NOW()
        WHERE id = $9`,
        [
          totalTransactions, totalAmount, mpesaTotalAmount,
          matchedCount, unmatchedCount, failedCount, reversalCount,
          JSON.stringify(discrepancies), reconciliationId
        ]
      );

      await logAudit(req.user.id, 'reconciliation_completed', 'reconciliation_record', reconciliationId, totalAmount, req, null, { status: 'completed', matched_count: matchedCount }, null, null, null, null);

      return { reconciliationId, discrepancies };
    });

    const reconciliation = await queryOne("SELECT * FROM agrihub.reconciliation_records WHERE id = $1", [reconciliationId]);
    res.status(201).json({ reconciliation, discrepancies });
  } catch (err) {
    console.error("Reconciliation error:", err);
    res.status(500).json({ error: "Failed to perform reconciliation" });
  }
});

// ─── GET /api/reconciliation/records ─────────────────────────────────────────
router.get("/records", authorize("Admin"), async (req, res) => {
  try {
    const { period_type, status, limit = 50, offset = 0 } = req.query;
    
    let query = "SELECT * FROM agrihub.reconciliation_records WHERE 1=1";
    const params = [];
    let paramIndex = 1;
    
    if (period_type) {
      query += ` AND period_type = $${paramIndex++}`;
      params.push(period_type);
    }
    if (status) {
      query += ` AND status = $${paramIndex++}`;
      params.push(status);
    }
    
    query += ` ORDER BY reconciliation_date DESC LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
    params.push(parseInt(limit), parseInt(offset));
    
    const records = await queryMany(query, params);
    res.json(records.map(r => ({ ...r, discrepancies: r.discrepancies || [] })));
  } catch (error) {
    console.error("Error fetching reconciliation records:", error);
    res.status(500).json({ error: "Failed to fetch reconciliation records" });
  }
});

// ─── GET /api/reconciliation/records/:id ────────────────────────────────────
router.get("/records/:id", authorize("Admin"), async (req, res) => {
  try {
    const record = await queryOne("SELECT * FROM agrihub.reconciliation_records WHERE id = $1", [req.params.id]);
    if (!record) return res.status(404).json({ error: "Reconciliation record not found" });
    
    res.json({ ...record, discrepancies: record.discrepancies || [] });
  } catch (error) {
    console.error("Error fetching reconciliation record:", error);
    res.status(500).json({ error: "Failed to fetch reconciliation record" });
  }
});

// ─── POST /api/reconciliation/auto ────────────────────────────────────────────
router.post("/auto", authorize("Admin"), async (req, res) => {
  try {
    const { period_type = "daily" } = req.body;
    
    const autoReconciliation = await queryOne("SELECT value FROM agrihub.system_config WHERE key = 'auto_reconciliation'");
    if (autoReconciliation?.value !== 'enabled') {
      return res.status(400).json({ error: "Auto reconciliation is disabled" });
    }

    // Calculate date range based on period type
    let startDate, endDate;
    const now = new Date();
    
    if (period_type === 'daily') {
      startDate = new Date(now.setHours(0, 0, 0, 0)).toISOString().split('T')[0];
      endDate = new Date(now.setHours(23, 59, 59, 999)).toISOString().split('T')[0];
    } else if (period_type === 'monthly') {
      startDate = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
      endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split('T')[0];
    }

    // Perform reconciliation
    const response = await fetch(`${req.protocol}://${req.get('host')}/api/reconciliation/start`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': req.get('Authorization')
      },
      body: JSON.stringify({
        period_type,
        start_date: startDate,
        end_date: endDate
      })
    });

    const data = await response.json();
    
    if (response.ok) {
      res.json(data);
    } else {
      res.status(response.status).json(data);
    }
  } catch (err) {
    console.error("Auto reconciliation error:", err);
    res.status(500).json({ error: "Failed to perform auto reconciliation" });
  }
});

// ─── POST /api/reconciliation/resolve-discrepancy ─────────────────────────────
router.post("/resolve-discrepancy", authorize("Admin"), async (req, res) => {
  try {
    const { reconciliation_id, transaction_id, resolution, notes } = req.body;
    
    if (!reconciliation_id || !transaction_id || !resolution) {
      return res.status(400).json({ error: "Reconciliation ID, transaction ID, and resolution required" });
    }

    const record = await queryOne("SELECT * FROM agrihub.reconciliation_records WHERE id = $1", [reconciliation_id]);
    if (!record) return res.status(404).json({ error: "Reconciliation record not found" });

    const discrepancies = record.discrepancies || [];
    const discrepancyIndex = discrepancies.findIndex(d => d.transaction_id === transaction_id);
    
    if (discrepancyIndex === -1) {
      return res.status(404).json({ error: "Discrepancy not found" });
    }

    discrepancies[discrepancyIndex].resolution = resolution;
    discrepancies[discrepancyIndex].resolved_at = new Date().toISOString();
    discrepancies[discrepancyIndex].resolved_by = req.user.id;
    discrepancies[discrepancyIndex].notes = notes;

    await pool.query(
      `UPDATE agrihub.reconciliation_records 
      SET discrepancies = $1, updated_at = NOW()
      WHERE id = $2`,
      [JSON.stringify(discrepancies), reconciliation_id]
    );

    await logAudit(req.user.id, 'discrepancy_resolved', 'reconciliation_record', reconciliation_id, null, req, null, { resolution }, null, null, null, null);

    res.json({ ok: true, discrepancies });
  } catch (err) {
    console.error("Resolve discrepancy error:", err);
    res.status(500).json({ error: "Failed to resolve discrepancy" });
  }
});

// ─── GET /api/reconciliation/summary ─────────────────────────────────────────
router.get("/summary", authorize("Admin"), async (req, res) => {
  try {
    const summary = await queryOne(
      `SELECT 
        COUNT(*) as total_reconciliations,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_count,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_count,
        SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress_count,
        SUM(total_amount) as total_reconciled_amount,
        SUM(mpesa_total_amount) as total_mpesa_amount,
        SUM(matched_transactions) as total_matched,
        SUM(unmatched_transactions) as total_unmatched,
        SUM(failed_transactions) as total_failed,
        SUM(reversal_count) as total_reversals
      FROM agrihub.reconciliation_records`
    );

    const recentDiscrepancies = await queryMany(
      `SELECT discrepancies FROM agrihub.reconciliation_records 
      WHERE status = 'completed' AND discrepancies IS NOT NULL
      ORDER BY reconciliation_date DESC LIMIT 10`
    );

    const allDiscrepancies = recentDiscrepancies
      .filter(r => r.discrepancies)
      .flatMap(r => r.discrepancies)
      .filter(d => !d.resolution);

    res.json({
      ...summary,
      unresolved_discrepancies: allDiscrepancies.length,
      recent_unresolved_discrepancies: allDiscrepancies.slice(0, 10)
    });
  } catch (error) {
    console.error("Error fetching reconciliation summary:", error);
    res.status(500).json({ error: "Failed to fetch reconciliation summary" });
  }
});

// ─── POST /api/reconciliation/export ───────────────────────────────────────────
router.post("/export", authorize("Admin"), async (req, res) => {
  try {
    const { reconciliation_id } = req.body;
    
    if (!reconciliation_id) {
      return res.status(400).json({ error: "Reconciliation ID required" });
    }

    const record = await queryOne("SELECT * FROM agrihub.reconciliation_records WHERE id = $1", [reconciliation_id]);
    if (!record) return res.status(404).json({ error: "Reconciliation record not found" });

    // Get detailed transaction data
    const transactions = await queryMany(
      `SELECT * FROM agrihub.transactions 
      WHERE payment_date >= $1 AND payment_date <= $2
      ORDER BY payment_date`,
      [record.start_date, record.end_date]
    );

    const mpesaTransactions = await queryMany(
      `SELECT * FROM agrihub.mpesa_transactions 
      WHERE created_at >= $1 AND created_at <= $2
      ORDER BY created_at`,
      [record.start_date, record.end_date]
    );

    const exportData = {
      reconciliation: record,
      transactions,
      mpesa_transactions: mpesaTransactions,
      discrepancies: record.discrepancies || [],
      exported_at: new Date().toISOString(),
      exported_by: req.user.username
    };

    res.json(exportData);
  } catch (err) {
    console.error("Export reconciliation error:", err);
    res.status(500).json({ error: "Failed to export reconciliation data" });
  }
});

export default router;
