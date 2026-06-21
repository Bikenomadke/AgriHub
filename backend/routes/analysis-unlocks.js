import { Router } from "express";
import { v4 as uuid } from "uuid";
import crypto from "crypto";
import pool, { queryOne, queryMany } from "../db-postgres.js";
import { authenticate } from "../middleware/auth.js";
import { logAuditEvent } from "../utils/audit-logger.js";
import config from "../utils/config.js";
import { safeFetch } from "../utils/ssrf-protection.js";

const router = Router();

// ─── M-Pesa Helpers ─────────────────────────────────────────────────────────────
async function getAccessToken() {
  const key = config.MPESA_CONSUMER_KEY;
  const secret = config.MPESA_CONSUMER_SECRET;
  const auth = Buffer.from(`${key}:${secret}`).toString("base64");
  const env = config.MPESA_ENV === "production"
    ? "https://api.safaricom.co.ke"
    : "https://sandbox.safaricom.co.ke";

  const response = await safeFetch(`${env}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${auth}` },
  });
  
  const data = await response.json();
  return data.access_token;
}

function formatPhone(p) {
  const cleaned = p.replace(/\D/g, "");
  if (cleaned.startsWith("0")) return "254" + cleaned.slice(1);
  if (cleaned.startsWith("254") && cleaned.length === 12) return cleaned;
  return cleaned;
}

async function initiateStkPush(phone, amount, unlockId) {
  const hasRealCredentials = config.MPESA_CONSUMER_KEY && 
                            config.MPESA_CONSUMER_KEY !== "your_consumer_key_here";

  if (hasRealCredentials) {
    return await realStkPush(phone, amount, unlockId);
  } else {
    return await simulatedStkPush(phone, amount, unlockId);
  }
}

async function realStkPush(phone, amount, unlockId) {
  const token = await getAccessToken();
  const env = config.MPESA_ENV === "production"
    ? "https://api.safaricom.co.ke"
    : "https://sandbox.safaricom.co.ke";

  const timestamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  const passkey = config.MPESA_PASSKEY;
  const shortcode = config.MPESA_SHORTCODE || "174379";
  const password = Buffer.from(`${shortcode}${passkey}${timestamp}`).toString("base64");

  const callbackUrl = `${process.env.BASE_URL || "http://localhost:4000"}/api/analysis-unlocks/callback`;

  const body = {
    BusinessShortCode: shortcode,
    Password: password,
    Timestamp: timestamp,
    TransactionType: "CustomerPayBillOnline",
    Amount: Math.round(amount),
    PartyA: phone,
    PartyB: shortcode,
    PhoneNumber: phone,
    CallBackURL: callbackUrl,
    AccountReference: `AGRIHUB-UNLOCK-${unlockId.slice(0, 8)}`,
    TransactionDesc: "AgriHub Analysis Unlock",
  };

  const resp = await safeFetch(`${env}/mpesa/stkpush/v1/processrequest`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = await resp.json();

  // Record M-Pesa request
  const mpesaRequestId = uuid();
  await pool.query(
    `INSERT INTO agrihub.mpesa_requests (id, transaction_id, phone, amount, merchant_request_id, checkout_request_id, response_code, response_description, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')`,
    [mpesaRequestId, unlockId, phone, amount, data.MerchantRequestID, data.CheckoutRequestID, data.ResponseCode, data.ResponseDescription]
  );

  if (data.ResponseCode !== "0") {
    await pool.query(`UPDATE agrihub.analysis_unlocks SET status='failed', updated_at=NOW() WHERE id=$1`, [unlockId]);
    return { success: false, error: data.ResponseDescription, mpesaRequestId };
  }

  return { success: true, mpesaRequestId, merchantRequestID: data.MerchantRequestID, checkoutRequestID: data.CheckoutRequestID };
}

async function simulatedStkPush(phone, amount, unlockId) {
  // Record simulated M-Pesa request
  const mpesaRequestId = uuid();
  await pool.query(
    `INSERT INTO agrihub.mpesa_requests (id, transaction_id, phone, amount, status) 
     VALUES ($1, $2, $3, $4, 'pending')`,
    [mpesaRequestId, unlockId, phone, amount]
  );

  // Simulate callback after 5 seconds
  setTimeout(async () => {
    const ok = Math.random() > 0.1;
    const ref = "MP" + Date.now().toString(36).toUpperCase();
    
    await pool.query(
      `UPDATE agrihub.mpesa_requests 
       SET status=$1, reference=$2, result_code=$3, result_description=$4, updated_at=NOW() 
       WHERE id=$5`,
      [ok ? "completed" : "failed", ok ? ref : null, ok ? "0" : "1", ok ? "Success" : "Request cancelled by user", mpesaRequestId]
    );

    if (ok) {
      await pool.query(
        `UPDATE agrihub.analysis_unlocks 
         SET status='completed', mpesa_receipt=$1, updated_at=NOW() 
         WHERE id=$2`,
        [ref, unlockId]
      );
    } else {
      await pool.query(`UPDATE agrihub.analysis_unlocks SET status='failed', updated_at=NOW() WHERE id=$1`, [unlockId]);
    }
  }, 5000);

  return { success: true, mpesaRequestId, simulated: true };
}

// Tiered pricing based on field value
function calculateUnlockPrice(fieldValue) {
  // Field Value < 20,000 KES: Fee = 50 KES
  if (fieldValue < 20000) {
    return 50;
  }
  // Field Value 20,000 - 100,000 KES: Fee = 100 KES
  if (fieldValue <= 100000) {
    return 100;
  }
  // Field Value > 100,000 KES: Fee = 300 KES
  return 300;
}

// Get unlock price for a field
router.get("/price/:fieldId", authenticate, async (req, res) => {
  try {
    const { fieldId } = req.params;
    const userId = req.user.id;

    // Get field details
    const field = await queryOne(
      `SELECT id, area_acres, estimated_total_tons, buying_price_per_acre, valuation 
       FROM agrihub.fields 
       WHERE id = $1 AND deleted_at IS NULL`,
      [fieldId]
    );

    if (!field) {
      return res.status(404).json({ error: "Field not found" });
    }

    // Calculate field value (using valuation if available, otherwise estimate)
    const fieldValue = field.valuation || (field.area_acres * field.buying_price_per_acre) || 0;

    // Check if user already has an active unlock for this field
    const existingUnlock = await queryOne(
      `SELECT id, status, expires_at 
       FROM agrihub.analysis_unlocks 
       WHERE user_id = $1 AND field_id = $2 AND status = 'completed' 
       AND (expires_at IS NULL OR expires_at > NOW())`,
      [userId, fieldId]
    );

    if (existingUnlock) {
      return res.json({
        alreadyUnlocked: true,
        unlockId: existingUnlock.id,
        expiresAt: existingUnlock.expires_at,
        price: 0
      });
    }

    // Calculate price
    const price = calculateUnlockPrice(fieldValue);

    res.json({
      alreadyUnlocked: false,
      fieldId,
      fieldValue,
      price,
      currency: "KES"
    });
  } catch (error) {
    console.error("Error getting unlock price:", error);
    res.status(500).json({ error: "Failed to get unlock price" });
  }
});

// Request analysis unlock (initiate M-Pesa STK Push)
router.post("/request", authenticate, async (req, res) => {
  try {
    const { fieldId, phoneNumber } = req.body;
    const userId = req.user.id;

    if (!fieldId || !phoneNumber) {
      return res.status(400).json({ error: "fieldId and phoneNumber are required" });
    }

    // Get field details
    const field = await queryOne(
      `SELECT id, area_acres, estimated_total_tons, buying_price_per_acre, valuation 
       FROM agrihub.fields 
       WHERE id = $1 AND deleted_at IS NULL`,
      [fieldId]
    );

    if (!field) {
      return res.status(404).json({ error: "Field not found" });
    }

    // Calculate field value and price
    const fieldValue = field.valuation || (field.area_acres * field.buying_price_per_acre) || 0;
    const price = calculateUnlockPrice(fieldValue);

    // Check if user already has an active unlock
    const existingUnlock = await queryOne(
      `SELECT id, status 
       FROM agrihub.analysis_unlocks 
       WHERE user_id = $1 AND field_id = $2 AND status = 'completed' 
       AND (expires_at IS NULL OR expires_at > NOW())`,
      [userId, fieldId]
    );

    if (existingUnlock) {
      return res.json({
        alreadyUnlocked: true,
        unlockId: existingUnlock.id,
        message: "Analysis already unlocked for this field"
      });
    }

    // Check for pending unlock request
    const pendingUnlock = await queryOne(
      `SELECT id, status 
       FROM agrihub.analysis_unlocks 
       WHERE user_id = $1 AND field_id = $2 AND status = 'pending'`,
      [userId, fieldId]
    );

    if (pendingUnlock) {
      return res.json({
        unlockId: pendingUnlock.id,
        status: "pending",
        message: "Payment already in progress"
      });
    }

    // Create unlock record
    const unlockId = uuid();
    await pool.query(
      `INSERT INTO agrihub.analysis_unlocks (id, user_id, field_id, amount_paid, status, created_at)
       VALUES ($1, $2, $3, $4, 'pending', NOW())`,
      [unlockId, userId, fieldId, price]
    );

    // Log audit event
    await logAuditEvent({
      userId,
      action: "analysis_unlock_requested",
      entityType: "analysis_unlock",
      entityId: unlockId,
      amount: price,
      beforeState: { fieldId, phoneNumber }
    });

    // Initiate M-Pesa STK Push
    const formattedPhone = formatPhone(phoneNumber);
    const mpesaResult = await initiateStkPush(formattedPhone, price, unlockId);

    if (!mpesaResult.success) {
      return res.status(400).json({
        error: "Failed to initiate M-Pesa payment",
        details: mpesaResult.error
      });
    }

    res.json({
      unlockId,
      amount: price,
      currency: "KES",
      phoneNumber: formattedPhone,
      status: "pending",
      mpesaRequestId: mpesaResult.mpesaRequestId,
      ...(mpesaResult.merchantRequestID && { merchantRequestID: mpesaResult.merchantRequestID }),
      ...(mpesaResult.checkoutRequestID && { checkoutRequestID: mpesaResult.checkoutRequestID }),
      ...(mpesaResult.simulated && { simulated: true }),
      message: "M-Pesa STK Push initiated. Please enter your PIN on your phone."
    });
  } catch (error) {
    console.error("Error requesting unlock:", error);
    res.status(500).json({ error: "Failed to request unlock" });
  }
});

// Check unlock status
router.get("/status/:unlockId", authenticate, async (req, res) => {
  try {
    const { unlockId } = req.params;
    const userId = req.user.id;

    const unlock = await queryOne(
      `SELECT id, field_id, amount_paid, mpesa_receipt, status, expires_at, created_at 
       FROM agrihub.analysis_unlocks 
       WHERE id = $1 AND user_id = $2`,
      [unlockId, userId]
    );

    if (!unlock) {
      return res.status(404).json({ error: "Unlock not found" });
    }

    res.json({
      unlockId: unlock.id,
      fieldId: unlock.field_id,
      amountPaid: unlock.amount_paid,
      mpesaReceipt: unlock.mpesa_receipt,
      status: unlock.status,
      expiresAt: unlock.expires_at,
      createdAt: unlock.created_at
    });
  } catch (error) {
    console.error("Error checking unlock status:", error);
    res.status(500).json({ error: "Failed to check unlock status" });
  }
});

// Check if field is unlocked for current user
router.get("/field/:fieldId", authenticate, async (req, res) => {
  try {
    const { fieldId } = req.params;
    const userId = req.user.id;

    const unlock = await queryOne(
      `SELECT id, status, expires_at 
       FROM agrihub.analysis_unlocks 
       WHERE user_id = $1 AND field_id = $2 AND status = 'completed' 
       AND (expires_at IS NULL OR expires_at > NOW())`,
      [userId, fieldId]
    );

    if (unlock) {
      return res.json({
        unlocked: true,
        unlockId: unlock.id,
        expiresAt: unlock.expires_at
      });
    }

    res.json({
      unlocked: false
    });
  } catch (error) {
    console.error("Error checking field unlock status:", error);
    res.status(500).json({ error: "Failed to check unlock status" });
  }
});

// Get user's unlock history
router.get("/history", authenticate, async (req, res) => {
  try {
    const userId = req.user.id;

    const unlocks = await queryMany(
      `SELECT au.id, au.field_id, au.amount_paid, au.mpesa_receipt, au.status, 
              au.expires_at, au.created_at, f.name as field_name
       FROM agrihub.analysis_unlocks au
       LEFT JOIN agrihub.fields f ON au.field_id = f.id
       WHERE au.user_id = $1
       ORDER BY au.created_at DESC
       LIMIT 50`,
      [userId]
    );

    res.json({ unlocks });
  } catch (error) {
    console.error("Error getting unlock history:", error);
    res.status(500).json({ error: "Failed to get unlock history" });
  }
});

// M-Pesa callback for analysis unlock payment
router.post("/callback", async (req, res) => {
  try {
    const { Body } = req.body;
    const { stkCallback } = Body;
    
    if (!stkCallback) {
      return res.status(400).json({ error: "Invalid callback format" });
    }

    const { MerchantRequestID, CheckoutRequestID, ResultCode, ResultDesc } = stkCallback;
    const { CallbackMetadata } = stkCallback;
    const { Amount, MpesaReceiptNumber, TransactionDate } = CallbackMetadata.Item || {};

    // Find the unlock record using merchant request ID
    const mpesaRequest = await queryOne(
      `SELECT transaction_id as unlock_id 
       FROM agrihub.mpesa_requests 
       WHERE merchant_request_id = $1 OR checkout_request_id = $2`,
      [MerchantRequestID, CheckoutRequestID]
    );

    if (!mpesaRequest) {
      console.error("Unlock not found for M-Pesa callback:", MerchantRequestID);
      return res.status(404).json({ error: "Unlock not found" });
    }

    const unlockId = mpesaRequest.unlock_id;
    const unlock = await queryOne(
      `SELECT id, user_id, field_id, amount_paid, status 
       FROM agrihub.analysis_unlocks 
       WHERE id = $1`,
      [unlockId]
    );

    if (!unlock) {
      return res.status(404).json({ error: "Unlock not found" });
    }

    // Update M-Pesa request status
    await pool.query(
      `UPDATE agrihub.mpesa_requests 
       SET status=$1, reference=$2, result_code=$3, result_description=$4, updated_at=NOW() 
       WHERE merchant_request_id = $5 OR checkout_request_id = $6`,
      [ResultCode === "0" ? "completed" : "failed", MpesaReceiptNumber || null, ResultCode, ResultDesc, MerchantRequestID, CheckoutRequestID]
    );

    if (ResultCode === "0") {
      // Payment successful
      await pool.query(
        `UPDATE agrihub.analysis_unlocks 
         SET status = 'completed', mpesa_receipt = $1, updated_at = NOW()
         WHERE id = $2`,
        [MpesaReceiptNumber, unlockId]
      );

      // Log audit event
      await logAuditEvent({
        userId: unlock.user_id,
        action: "analysis_unlock_completed",
        entityType: "analysis_unlock",
        entityId: unlockId,
        amount: unlock.amount_paid,
        beforeState: { fieldId: unlock.field_id }
      });

      res.json({ success: true, status: "completed" });
    } else {
      // Payment failed
      await pool.query(
        `UPDATE agrihub.analysis_unlocks 
         SET status = 'failed', updated_at = NOW()
         WHERE id = $1`,
        [unlockId]
      );

      res.json({ success: false, status: "failed", error: ResultDesc });
    }
  } catch (error) {
    console.error("Error processing M-Pesa callback:", error);
    res.status(500).json({ error: "Failed to process callback" });
  }
});

export default router;
