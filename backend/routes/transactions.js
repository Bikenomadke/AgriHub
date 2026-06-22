import { Router } from "express";
import { v4 as uuid } from "uuid";
import pool, { queryOne, queryMany } from "../db-postgres.js";
import { authenticate, authorize } from "../middleware/auth.js";

const router = Router();

router.use(authenticate);

// ─── POST /api/transactions/:id/initiate-payment ─────────────────────────────
router.post("/:id/initiate-payment", authorize("Admin", "Weighbridge Trader", "Investor"), async (req, res) => {
  try {
    const { phone, amount } = req.body;
    const transaction_id = req.params.id;
    
    if (!transaction_id) return res.status(400).json({ error: "Transaction ID required" });
    if (!phone || !amount) return res.status(400).json({ error: "Phone and amount required" });
    
    const txn = await queryOne("SELECT * FROM agrihub.transactions WHERE id = $1", [transaction_id]);
    if (!txn) return res.status(404).json({ error: "Transaction not found" });
    
    // Check if payment already initiated
    if (txn.payment_status === 'completed') {
      return res.status(400).json({ error: "Payment already completed" });
    }
    
    // Create M-Pesa request record
    const mpesaRequestId = uuid();
    await pool.query(
      `INSERT INTO agrihub.mpesa_requests (id, transaction_id, phone, amount, status)
      VALUES ($1, $2, $3, $4, 'pending')`,
      [mpesaRequestId, transaction_id, phone, amount]
    );
    
    // Update transaction to pending payment
    await pool.query(
      `UPDATE agrihub.transactions SET payment_status='pending', payment_phone=$1, payment_amount=$2 WHERE id=$3`,
      [phone, amount, transaction_id]
    );
    
    res.json({ 
      ok: true, 
      payment_request_id: mpesaRequestId, 
      transaction_id, 
      phone, 
      amount,
      message: "Payment initiated. Use M-Pesa STK Push to complete payment."
    });
  } catch (error) {
    console.error("Error initiating payment:", error);
    res.status(500).json({ error: "Failed to initiate payment" });
  }
});

// GET /api/transactions
router.get("/", authenticate, async (req, res) => {
  try {
    const txns = await queryMany("SELECT * FROM agrihub.transactions ORDER BY created_at DESC");
    res.json(txns);
  } catch (error) {
    console.error("Error fetching transactions:", error);
    res.status(500).json({ error: "Failed to fetch transactions" });
  }
});

// POST /api/transactions
router.post("/", authorize("Admin", "Weighbridge Trader"), async (req, res) => {
  console.log("=> [TRANSACTION] Incoming POST request!");
  console.log("   User:", req.user);
  console.log("   Body:", req.body);
  try {
    const { farmer_name, tons, buy_price, total_cost, expected_payout, gross_profit, date, note, ticket_number, ticket_image } = req.body;
    if (!farmer_name || !tons || !ticket_number) {
      console.log("=> [TRANSACTION] Failed: Missing required fields");
      return res.status(400).json({ error: "Farmer name, tons, and ticket number required" });
    }

    const id = uuid();
    await pool.query(
      `INSERT INTO agrihub.transactions (id, farmer_name, tons, buy_price, total_cost, expected_payout, gross_profit, date, note, ticket_number, ticket_image, created_by, payment_status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'pending')`,
      [
        id, farmer_name, tons, buy_price || 0, total_cost || 0, expected_payout || 0,
        gross_profit || 0, date || new Date().toISOString().slice(0, 10), note || "",
        ticket_number, ticket_image || null, req.user.id
      ]
    );
    const txn = await queryOne("SELECT * FROM agrihub.transactions WHERE id = $1", [id]);
    console.log("=> [TRANSACTION] Successfully created transaction:", id);
    res.status(201).json(txn);
  } catch (error) {
    console.error("=> [TRANSACTION] Error creating transaction:", error);
    res.status(500).json({ error: "Failed to create transaction", details: error.message });
  }
});

// PUT /api/transactions/:id
router.put("/:id", authorize("Admin", "Weighbridge Trader"), async (req, res) => {
  try {
    const existing = await queryOne("SELECT * FROM agrihub.transactions WHERE id = $1", [req.params.id]);
    if (!existing) return res.status(404).json({ error: "Transaction not found" });

    const { farmer_name, tons, buy_price, total_cost, expected_payout, gross_profit, date, note, ticket_number, ticket_image } = req.body;
    await pool.query(
      `UPDATE agrihub.transactions SET farmer_name=$1, tons=$2, buy_price=$3, total_cost=$4, expected_payout=$5, gross_profit=$6, date=$7, note=$8, ticket_number=$9, ticket_image=$10, updated_at=NOW() WHERE id=$11`,
      [
        farmer_name ?? existing.farmer_name, tons ?? existing.tons, buy_price ?? existing.buy_price,
        total_cost ?? existing.total_cost, expected_payout ?? existing.expected_payout,
        gross_profit ?? existing.gross_profit, date ?? existing.date, note ?? existing.note,
        ticket_number ?? existing.ticket_number, ticket_image ?? existing.ticket_image,
        req.params.id
      ]
    );
    const txn = await queryOne("SELECT * FROM agrihub.transactions WHERE id = $1", [req.params.id]);
    res.json(txn);
  } catch (error) {
    console.error("Error updating transaction:", error);
    res.status(500).json({ error: "Failed to update transaction" });
  }
});

// DELETE /api/transactions/:id
router.delete("/:id", authorize("Admin"), async (req, res) => {
  try {
    const result = await pool.query("DELETE FROM agrihub.transactions WHERE id = $1", [req.params.id]);
    if (result.rowCount === 0) return res.status(404).json({ error: "Transaction not found" });
    res.json({ ok: true });
  } catch (error) {
    console.error("Error deleting transaction:", error);
    res.status(500).json({ error: "Failed to delete transaction" });
  }
});

export default router;
