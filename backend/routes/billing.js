import { Router } from "express";
import { v4 as uuid } from "uuid";
import pool, { queryOne, queryMany } from "../db-postgres.js";
import { authenticate, authorize } from "../middleware/auth.js";
import { logAuditEvent } from "../utils/audit-logger.js";
import { simulatedStkPush, realStkPush, formatPhone } from "./mpesa.js";

const router = Router();

// ─── Admin Settings Endpoints ─────────────────────────────────────────────────

// Get trader billing settings
router.get("/settings/trader", authenticate, authorize("Admin"), async (req, res) => {
  try {
    const settings = await queryMany(
      `SELECT setting_key, setting_value, description 
       FROM agrihub.system_settings 
       WHERE setting_key LIKE 'trader_%'`
    );

    const settingsMap = {};
    settings.forEach(setting => {
      settingsMap[setting.setting_key] = parseFloat(setting.setting_value);
    });

    res.json({
      dailyPrice: settingsMap.trader_daily_price || 50,
      weeklyPrice: settingsMap.trader_weekly_price || 250,
      monthlyPrice: settingsMap.trader_monthly_price || 1000,
      levyPerTon: settingsMap.trader_levy_per_ton || 10,
      freeTonnage: settingsMap.trader_free_tonnage || 100
    });
  } catch (error) {
    console.error("Error fetching trader settings:", error);
    res.status(500).json({ error: "Failed to fetch trader settings" });
  }
});

// Update trader billing settings
router.put("/settings/trader", authenticate, authorize("Admin"), async (req, res) => {
  try {
    const { dailyPrice, weeklyPrice, monthlyPrice, levyPerTon, freeTonnage } = req.body;
    const adminId = req.user.id;

    if (!dailyPrice || !weeklyPrice || !monthlyPrice || !levyPerTon || !freeTonnage) {
      return res.status(400).json({ error: "All pricing fields are required" });
    }

    // Get current values for audit log
    const currentSettings = await queryMany(
      `SELECT setting_key, setting_value 
       FROM agrihub.system_settings 
       WHERE setting_key LIKE 'trader_%'`
    );

    const currentSettingsMap = {};
    currentSettings.forEach(setting => {
      currentSettingsMap[setting.setting_key] = setting.setting_value;
    });

    // Update settings
    const updates = [
      { key: 'trader_daily_price', value: dailyPrice.toString() },
      { key: 'trader_weekly_price', value: weeklyPrice.toString() },
      { key: 'trader_monthly_price', value: monthlyPrice.toString() },
      { key: 'trader_levy_per_ton', value: levyPerTon.toString() },
      { key: 'trader_free_tonnage', value: freeTonnage.toString() }
    ];

    for (const update of updates) {
      const oldValue = currentSettingsMap[update.key];
      
      // Log audit if value changed
      if (oldValue !== update.value) {
        await pool.query(
          `INSERT INTO agrihub.pricing_audit_logs (setting_key, old_value, new_value, changed_by)
           VALUES ($1, $2, $3, $4)`,
          [update.key, oldValue, update.value, adminId]
        );
      }

      // Update setting
      await pool.query(
        `INSERT INTO agrihub.system_settings (setting_key, setting_value, updated_by)
         VALUES ($1, $2, $3)
         ON CONFLICT (setting_key) 
         DO UPDATE SET setting_value = $2, updated_by = $3, updated_at = NOW()`,
        [update.key, update.value, adminId]
      );
    }

    res.json({
      dailyPrice,
      weeklyPrice,
      monthlyPrice,
      levyPerTon,
      freeTonnage
    });
  } catch (error) {
    console.error("Error updating trader settings:", error);
    res.status(500).json({ error: "Failed to update trader settings" });
  }
});

// Get pricing audit history
router.get("/settings/audit", authenticate, authorize("Admin"), async (req, res) => {
  try {
    const auditLogs = await queryMany(
      `SELECT pal.*, u.name as changed_by_name
       FROM agrihub.pricing_audit_logs pal
       LEFT JOIN agrihub.users u ON pal.changed_by = u.id
       ORDER BY pal.changed_at DESC
       LIMIT 100`
    );

    res.json({ auditLogs });
  } catch (error) {
    console.error("Error fetching audit logs:", error);
    res.status(500).json({ error: "Failed to fetch audit logs" });
  }
});

// ─── Subscription Endpoints ─────────────────────────────────────────────────────

// Purchase subscription
router.post("/subscriptions/purchase", authenticate, async (req, res) => {
  try {
    const { planType, phoneNumber } = req.body;
    const userId = req.user.id;

    if (!planType || !phoneNumber) {
      return res.status(400).json({ error: "planType and phoneNumber are required" });
    }

    if (!['daily', 'weekly', 'monthly'].includes(planType)) {
      return res.status(400).json({ error: "Invalid plan type" });
    }

    // Get pricing
    const setting = await queryOne(
      `SELECT setting_value FROM agrihub.system_settings 
       WHERE setting_key = $1`,
      [`trader_${planType}_price`]
    );

    if (!setting) {
      return res.status(500).json({ error: "Pricing not configured" });
    }

    const amount = parseFloat(setting.setting_value);

    // Calculate expiry
    const now = new Date();
    let expiresAt;
    
    switch (planType) {
      case 'daily':
        expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
        break;
      case 'weekly':
        expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
        break;
      case 'monthly':
        expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
        break;
    }

    // Create subscription record
    const subscriptionId = uuid();
    await pool.query(
      `INSERT INTO agrihub.user_subscriptions (id, user_id, plan_type, amount_paid, starts_at, expires_at, status)
       VALUES ($1, $2, $3, $4, NOW(), $5, 'pending')`,
      [subscriptionId, userId, planType, amount, expiresAt]
    );

    // Log audit event
    await logAuditEvent({
      userId,
      action: "subscription_purchased",
      entityType: "subscription",
      entityId: subscriptionId,
      amount: amount,
      beforeState: null,
      afterState: { planType, amount, expiresAt }
    });

    // Initiate M-Pesa STK Push
    const formattedPhone = formatPhone(phoneNumber);
    const mpesaRequestId = await realStkPush(formattedPhone, amount, subscriptionId) || 
                           await simulatedStkPush(formattedPhone, amount, subscriptionId);

    res.json({
      subscriptionId,
      planType,
      amount,
      status: "pending",
      mpesaRequestId,
      message: "M-Pesa STK Push initiated. Please enter your PIN on your phone."
    });
  } catch (error) {
    console.error("Error purchasing subscription:", error);
    res.status(500).json({ error: "Failed to purchase subscription" });
  }
});

// Get user subscriptions
router.get("/subscriptions", authenticate, async (req, res) => {
  try {
    const userId = req.user.id;

    const subscriptions = await queryMany(
      `SELECT * FROM agrihub.user_subscriptions 
       WHERE user_id = $1 
       ORDER BY created_at DESC`,
      [userId]
    );

    // Get active subscription
    const activeSubscription = await queryOne(
      `SELECT * FROM agrihub.user_subscriptions 
       WHERE user_id = $1 AND status = 'active' AND expires_at > NOW()
       ORDER BY expires_at DESC LIMIT 1`,
      [userId]
    );

    res.json({
      subscriptions,
      activeSubscription
    });
  } catch (error) {
    console.error("Error fetching subscriptions:", error);
    res.status(500).json({ error: "Failed to fetch subscriptions" });
  }
});

// ─── Usage Tracking Endpoints ───────────────────────────────────────────────────

// Record trader usage
router.post("/usage", authenticate, async (req, res) => {
  try {
    const { ticketId, tonnes } = req.body;
    const userId = req.user.id;

    if (!ticketId || !tonnes) {
      return res.status(400).json({ error: "ticketId and tonnes are required" });
    }

    // Record usage
    const usageId = uuid();
    await pool.query(
      `INSERT INTO agrihub.trader_usage (id, user_id, ticket_id, tonnes)
       VALUES ($1, $2, $3, $4)`,
      [usageId, userId, ticketId, tonnes]
    );

    res.json({ usageId, tonnes });
  } catch (error) {
    console.error("Error recording usage:", error);
    res.status(500).json({ error: "Failed to record usage" });
  }
});

// Get user usage for current month
router.get("/usage/current", authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const usage = await queryOne(
      `SELECT SUM(tonnes) as total_tonnage 
       FROM agrihub.trader_usage 
       WHERE user_id = $1 AND processed_at >= $2`,
      [userId, startOfMonth]
    );

    const totalTonnage = parseFloat(usage.total_tonnage) || 0;

    // Get free tonnage setting
    const setting = await queryOne(
      `SELECT setting_value FROM agrihub.system_settings 
       WHERE setting_key = 'trader_free_tonnage'`
    );

    const freeTonnage = parseFloat(setting?.setting_value) || 100;
    const chargeableTonnage = Math.max(totalTonnage - freeTonnage, 0);

    // Get levy rate
    const levySetting = await queryOne(
      `SELECT setting_value FROM agrihub.system_settings 
       WHERE setting_key = 'trader_levy_per_ton'`
    );

    const levyRate = parseFloat(levySetting?.setting_value) || 10;
    const levyAmount = chargeableTonnage * levyRate;

    res.json({
      totalTonnage,
      freeTonnage,
      chargeableTonnage,
      levyRate,
      levyAmount,
      month: now.toLocaleString('default', { month: 'long', year: 'numeric' })
    });
  } catch (error) {
    console.error("Error fetching usage:", error);
    res.status(500).json({ error: "Failed to fetch usage" });
  }
});

// ─── Invoice Endpoints ─────────────────────────────────────────────────────────

// Generate monthly invoice
router.post("/invoices/generate", authenticate, async (req, res) => {
  try {
    const { billingMonth } = req.body;
    const userId = req.user.id;

    if (!billingMonth) {
      return res.status(400).json({ error: "billingMonth is required (format: YYYY-MM)" });
    }

    // Check if invoice already exists
    const existingInvoice = await queryOne(
      `SELECT * FROM agrihub.trader_invoices 
       WHERE user_id = $1 AND billing_month = $2`,
      [userId, billingMonth]
    );

    if (existingInvoice) {
      return res.json(existingInvoice);
    }

    // Get total tonnage for the month
    const [year, month] = billingMonth.split('-');
    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 0, 23, 59, 59);

    const usage = await queryOne(
      `SELECT SUM(tonnes) as total_tonnage 
       FROM agrihub.trader_usage 
       WHERE user_id = $1 AND processed_at >= $2 AND processed_at <= $3`,
      [userId, startDate, endDate]
    );

    const totalTonnage = parseFloat(usage.total_tonnage) || 0;

    // Get settings
    const freeTonnageSetting = await queryOne(
      `SELECT setting_value FROM agrihub.system_settings 
       WHERE setting_key = 'trader_free_tonnage'`
    );
    const freeTonnage = parseFloat(freeTonnageSetting?.setting_value) || 100;

    const levyRateSetting = await queryOne(
      `SELECT setting_value FROM agrihub.system_settings 
       WHERE setting_key = 'trader_levy_per_ton'`
    );
    const levyRate = parseFloat(levyRateSetting?.setting_value) || 10;

    const chargeableTonnage = Math.max(totalTonnage - freeTonnage, 0);
    const levyAmount = chargeableTonnage * levyRate;

    // Create invoice
    const invoiceId = uuid();
    await pool.query(
      `INSERT INTO agrihub.trader_invoices 
       (id, user_id, billing_month, total_tonnage, free_tonnage, chargeable_tonnage, levy_rate, levy_amount, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')`,
      [invoiceId, userId, billingMonth, totalTonnage, freeTonnage, chargeableTonnage, levyRate, levyAmount]
    );

    const invoice = await queryOne(
      `SELECT * FROM agrihub.trader_invoices WHERE id = $1`,
      [invoiceId]
    );

    res.json(invoice);
  } catch (error) {
    console.error("Error generating invoice:", error);
    res.status(500).json({ error: "Failed to generate invoice" });
  }
});

// Get user invoices
router.get("/invoices", authenticate, async (req, res) => {
  try {
    const userId = req.user.id;

    const invoices = await queryMany(
      `SELECT * FROM agrihub.trader_invoices 
       WHERE user_id = $1 
       ORDER BY billing_month DESC`,
      [userId]
    );

    res.json({ invoices });
  } catch (error) {
    console.error("Error fetching invoices:", error);
    res.status(500).json({ error: "Failed to fetch invoices" });
  }
});

// Pay invoice
router.post("/invoices/:id/pay", authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { phoneNumber } = req.body;
    const userId = req.user.id;

    const invoice = await queryOne(
      `SELECT * FROM agrihub.trader_invoices 
       WHERE id = $1 AND user_id = $2`,
      [id, userId]
    );

    if (!invoice) {
      return res.status(404).json({ error: "Invoice not found" });
    }

    if (invoice.status === 'paid') {
      return res.status(400).json({ error: "Invoice already paid" });
    }

    // Initiate M-Pesa STK Push for invoice payment
    const formattedPhone = formatPhone(phoneNumber);
    const mpesaRequestId = await realStkPush(formattedPhone, invoice.levy_amount, id) || 
                           await simulatedStkPush(formattedPhone, invoice.levy_amount, id);

    res.json({
      invoiceId: id,
      amount: invoice.levy_amount,
      status: "pending",
      mpesaRequestId,
      message: "M-Pesa STK Push initiated. Please enter your PIN on your phone."
    });
  } catch (error) {
    console.error("Error paying invoice:", error);
    res.status(500).json({ error: "Failed to pay invoice" });
  }
});

// ─── Dashboard Endpoints ───────────────────────────────────────────────────────

// Get trader billing dashboard data
router.get("/dashboard", authenticate, async (req, res) => {
  try {
    const userId = req.user.id;

    // Get active subscription
    const activeSubscription = await queryOne(
      `SELECT * FROM agrihub.user_subscriptions 
       WHERE user_id = $1 AND status = 'active' AND expires_at > NOW()
       ORDER BY expires_at DESC LIMIT 1`,
      [userId]
    );

    // Get current month usage
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const usage = await queryOne(
      `SELECT SUM(tonnes) as total_tonnage 
       FROM agrihub.trader_usage 
       WHERE user_id = $1 AND processed_at >= $2`,
      [userId, startOfMonth]
    );

    const totalTonnage = parseFloat(usage.total_tonnage) || 0;

    // Get settings
    const freeTonnageSetting = await queryOne(
      `SELECT setting_value FROM agrihub.system_settings 
       WHERE setting_key = 'trader_free_tonnage'`
    );
    const freeTonnage = parseFloat(freeTonnageSetting?.setting_value) || 100;

    const levyRateSetting = await queryOne(
      `SELECT setting_value FROM agrihub.system_settings 
       WHERE setting_key = 'trader_levy_per_ton'`
    );
    const levyRate = parseFloat(levyRateSetting?.setting_value) || 10;

    const chargeableTonnage = Math.max(totalTonnage - freeTonnage, 0);
    const levyAmount = chargeableTonnage * levyRate;

    // Get pending invoices
    const pendingInvoices = await queryOne(
      `SELECT SUM(levy_amount) as total_pending 
       FROM agrihub.trader_invoices 
       WHERE user_id = $1 AND status = 'pending'`,
      [userId]
    );

    const outstandingLevy = parseFloat(pendingInvoices.total_pending) || 0;

    res.json({
      subscription: activeSubscription,
      usage: {
        totalTonnage,
        freeTonnage,
        chargeableTonnage,
        levyRate,
        levyAmount,
        month: now.toLocaleString('default', { month: 'long', year: 'numeric' })
      },
      outstandingLevy
    });
  } catch (error) {
    console.error("Error fetching dashboard data:", error);
    res.status(500).json({ error: "Failed to fetch dashboard data" });
  }
});

// ─── M-Pesa Callback Handler ─────────────────────────────────────────────────────

// Handle M-Pesa callback for subscription payments
router.post("/callback/subscription", async (req, res) => {
  try {
    const { Body } = req.body;
    const { stkCallback } = Body;
    
    if (!stkCallback) {
      return res.status(400).json({ error: "Invalid callback format" });
    }

    const { MerchantRequestID, CheckoutRequestID, ResultCode, ResultDesc } = stkCallback;
    const { CallbackMetadata } = stkCallback;
    const { Amount, MpesaReceiptNumber, TransactionDate } = CallbackMetadata.Item || {};

    // Find the mpesa request to get the subscription ID
    const mpesaRequest = await queryOne(
      `SELECT transaction_id as subscription_id 
       FROM agrihub.mpesa_requests 
       WHERE merchant_request_id = $1 OR checkout_request_id = $2`,
      [MerchantRequestID, CheckoutRequestID]
    );

    if (!mpesaRequest) {
      console.error("Subscription not found for M-Pesa callback:", MerchantRequestID);
      return res.status(404).json({ error: "Subscription not found" });
    }

    const subscriptionId = mpesaRequest.subscription_id;

    // Update M-Pesa request status
    await pool.query(
      `UPDATE agrihub.mpesa_requests 
       SET status=$1, reference=$2, result_code=$3, result_description=$4, updated_at=NOW() 
       WHERE merchant_request_id = $5 OR checkout_request_id = $6`,
      [ResultCode === "0" ? "completed" : "failed", MpesaReceiptNumber || null, ResultCode, ResultDesc, MerchantRequestID, CheckoutRequestID]
    );

    if (ResultCode === "0") {
      // Payment successful - activate subscription
      await pool.query(
        `UPDATE agrihub.user_subscriptions 
         SET status = 'active', mpesa_receipt = $1, updated_at = NOW()
         WHERE id = $2`,
        [MpesaReceiptNumber, subscriptionId]
      );

      // Get subscription for audit log
      const subscription = await queryOne(
        `SELECT * FROM agrihub.user_subscriptions WHERE id = $1`,
        [subscriptionId]
      );

      // Log audit event
      await logAuditEvent({
        userId: subscription.user_id,
        action: "subscription_activated",
        entityType: "subscription",
        entityId: subscriptionId,
        amount: subscription.amount_paid,
        beforeState: { status: 'pending' },
        afterState: { status: 'active', mpesaReceipt: MpesaReceiptNumber }
      });

      res.json({ success: true, status: "active" });
    } else {
      // Payment failed
      await pool.query(
        `UPDATE agrihub.user_subscriptions 
         SET status = 'cancelled', updated_at = NOW()
         WHERE id = $1`,
        [subscriptionId]
      );

      res.json({ success: false, status: "cancelled", error: ResultDesc });
    }
  } catch (error) {
    console.error("Error processing subscription callback:", error);
    res.status(500).json({ error: "Failed to process callback" });
  }
});

// Handle M-Pesa callback for invoice payments
router.post("/callback/invoice", async (req, res) => {
  try {
    const { Body } = req.body;
    const { stkCallback } = Body;
    
    if (!stkCallback) {
      return res.status(400).json({ error: "Invalid callback format" });
    }

    const { MerchantRequestID, CheckoutRequestID, ResultCode, ResultDesc } = stkCallback;
    const { CallbackMetadata } = stkCallback;
    const { Amount, MpesaReceiptNumber, TransactionDate } = CallbackMetadata.Item || {};

    // Find the mpesa request to get the invoice ID
    const mpesaRequest = await queryOne(
      `SELECT transaction_id as invoice_id 
       FROM agrihub.mpesa_requests 
       WHERE merchant_request_id = $1 OR checkout_request_id = $2`,
      [MerchantRequestID, CheckoutRequestID]
    );

    if (!mpesaRequest) {
      console.error("Invoice not found for M-Pesa callback:", MerchantRequestID);
      return res.status(404).json({ error: "Invoice not found" });
    }

    const invoiceId = mpesaRequest.invoice_id;

    // Update M-Pesa request status
    await pool.query(
      `UPDATE agrihub.mpesa_requests 
       SET status=$1, reference=$2, result_code=$3, result_description=$4, updated_at=NOW() 
       WHERE merchant_request_id = $5 OR checkout_request_id = $6`,
      [ResultCode === "0" ? "completed" : "failed", MpesaReceiptNumber || null, ResultCode, ResultDesc, MerchantRequestID, CheckoutRequestID]
    );

    if (ResultCode === "0") {
      // Payment successful - mark invoice as paid
      await pool.query(
        `UPDATE agrihub.trader_invoices 
         SET status = 'paid', mpesa_receipt = $1, paid_at = NOW(), updated_at = NOW()
         WHERE id = $2`,
        [MpesaReceiptNumber, invoiceId]
      );

      // Get invoice for audit log
      const invoice = await queryOne(
        `SELECT * FROM agrihub.trader_invoices WHERE id = $1`,
        [invoiceId]
      );

      // Log audit event
      await logAuditEvent({
        userId: invoice.user_id,
        action: "invoice_paid",
        entityType: "invoice",
        entityId: invoiceId,
        amount: invoice.levy_amount,
        beforeState: { status: 'pending' },
        afterState: { status: 'paid', mpesaReceipt: MpesaReceiptNumber }
      });

      res.json({ success: true, status: "paid" });
    } else {
      // Payment failed
      res.json({ success: false, status: "pending", error: ResultDesc });
    }
  } catch (error) {
    console.error("Error processing invoice callback:", error);
    res.status(500).json({ error: "Failed to process callback" });
  }
});

export default router;
