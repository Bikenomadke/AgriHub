import { Router } from "express";
import pool, { queryOne, queryMany } from "../db-postgres.js";
import { authenticate } from "../middleware/auth.js";

const router = Router();
router.use(authenticate);

router.get("/dashboard", async (req, res) => {
  try {
    const fieldStats = await queryOne(`
      SELECT
        COUNT(*) as total_fields,
        COALESCE(SUM(area_acres), 0) as total_acres,
        COALESCE(SUM(estimated_total_tons), 0) as total_tons
      FROM agrihub.fields
    `);

    const txnStats = await queryOne(`
      SELECT
        COALESCE(SUM(tons), 0) as total_harvested_tons,
        COALESCE(SUM(gross_profit), 0) as total_gross_profit,
        COALESCE(SUM(buy_price * tons), 0) as total_cost
      FROM agrihub.transactions
    `);

    const pendingCount = await queryOne("SELECT COUNT(*) as c FROM agrihub.transactions WHERE payment_status IN ('unpaid','pending')");
    const completedCount = await queryOne("SELECT COUNT(*) as c FROM agrihub.transactions WHERE payment_status='completed'");

    const recentTransactions = await queryMany("SELECT * FROM agrihub.transactions ORDER BY created_at DESC LIMIT 10");
    const recentFields = await queryMany("SELECT * FROM agrihub.fields ORDER BY created_at DESC LIMIT 10");

    res.json({
      ...fieldStats,
      ...txnStats,
      pending_payments: pendingCount.c,
      completed_payments: completedCount.c,
      recent_transactions: recentTransactions,
      recent_fields: recentFields,
    });
  } catch (error) {
    console.error("Error fetching dashboard stats:", error);
    res.status(500).json({ error: "Failed to fetch dashboard stats" });
  }
});

router.get("/report", async (req, res) => {
  try {
    const { start, end } = req.query;
    if (!start || !end) return res.status(400).json({ error: "start and end dates required (YYYY-MM-DD)" });

    const fields = await queryMany("SELECT * FROM agrihub.fields WHERE created_at BETWEEN $1 AND $2", [start, end]);
    const transactions = await queryMany("SELECT * FROM agrihub.transactions WHERE date BETWEEN $1 AND $2 ORDER BY date DESC", [start, end]);

    const summary = await queryOne(`
      SELECT
        COUNT(*) as total_transactions,
        COALESCE(SUM(tons), 0) as total_tons,
        COALESCE(SUM(gross_profit), 0) as total_gross_profit,
        COALESCE(SUM(total_cost), 0) as total_cost
      FROM agrihub.transactions WHERE date BETWEEN $1 AND $2
    `, [start, end]);

    res.json({ fields, transactions, summary });
  } catch (error) {
    console.error("Error generating report:", error);
    res.status(500).json({ error: "Failed to generate report" });
  }
});

export default router;
