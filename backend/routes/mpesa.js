import { Router } from "express";
import { v4 as uuid } from "uuid";
import crypto from "crypto";
import pool, { queryOne, queryMany } from "../db-postgres.js";
import { authenticate, authorize } from "../middleware/auth.js";
import config from "../utils/config.js";
import { safeFetch } from "../utils/ssrf-protection.js";

const router = Router();
router.use(authenticate);

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function getAccessToken() {
  const key = config.MPESA_CONSUMER_KEY;
  const secret = config.MPESA_CONSUMER_SECRET;
  const auth = Buffer.from(`${key}:${secret}`).toString("base64");
  const env = config.MPESA_ENV === "production"
    ? "https://api.safaricom.co.ke"
    : "https://sandbox.safaricom.co.ke";

  // Use safeFetch with SSRF protection
  const response = await safeFetch(`${env}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${auth}` },
  });
  
  const data = await response.json();
  return data.access_token;
}

export function formatPhone(p) {
  const cleaned = p.replace(/\D/g, "");
  if (cleaned.startsWith("0")) return "254" + cleaned.slice(1);
  if (cleaned.startsWith("254") && cleaned.length === 12) return cleaned;
  return cleaned;
}

function generateSecurityCredential() {
  const initiatorPassword = process.env.MPESA_INITIATOR_PASSWORD;
  const certPath = process.env.MPESA_CERT_PATH;
  
  if (!initiatorPassword || !certPath) {
    throw new Error("M-Pesa initiator credentials not configured");
  }
  
  // In production, use actual certificate
  // For now, return base64 of password
  return Buffer.from(initiatorPassword).toString("base64");
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

function verifyCallbackSignature(data, signature) {
  const callbackSecret = process.env.MPESA_CALLBACK_SECRET;
  if (!callbackSecret) {
    throw new Error("MPESA_CALLBACK_SECRET not configured. Callback signature verification cannot be performed.");
  }
  const computedSignature = crypto
    .createHmac('sha256', callbackSecret)
    .update(JSON.stringify(data))
    .digest('hex');
  return computedSignature === signature;
}

async function checkRateLimit(userId, action) {
  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  
  const recentAttempts = await queryOne(
    `SELECT COUNT(*) as count FROM agrihub.audit_logs 
    WHERE user_id = $1 AND action = $2 AND created_at > $3`,
    [userId, action, oneHourAgo.toISOString()]
  );
  
  const limits = {
    'stk_push': 10,
    'b2c_payment': 20,
    'reversal': 5
  };
  
  return (recentAttempts?.count || 0) < (limits[action] || 10);
}

async function detectFraud(userId, amount, phone) {
  // Check for suspicious patterns
  const warnings = [];
  
  // Check for multiple failed transactions
  const failedCount = await queryOne(
    `SELECT COUNT(*) as count FROM agrihub.mpesa_transactions 
    WHERE status = 'failed' AND phone = $1 AND created_at > NOW() - INTERVAL '1 hour'`,
    [phone]
  );
  
  if (failedCount?.count > 3) {
    warnings.push("Multiple failed transactions from this phone");
  }
  
  // Check for unusually large amount
  const avgAmount = await queryOne(
    `SELECT AVG(amount) as avg FROM agrihub.mpesa_transactions 
    WHERE status = 'completed' AND created_at > NOW() - INTERVAL '7 days'`
  );
  
  if (avgAmount?.avg && amount > avgAmount.avg * 10) {
    warnings.push("Transaction amount significantly above average");
  }
  
  return warnings;
}

// ─── Simulated STK Push (fallback when no real credentials) ────────────────────
export async function simulatedStkPush(phone, amount, transactionId) {
  const id = uuid();
  await pool.query(`INSERT INTO agrihub.mpesa_requests (id, transaction_id, phone, amount, status) VALUES ($1, $2, $3, $4, 'pending')`,
    [id, transactionId, phone, amount]);

  // Simulate callback after 10 seconds
  setTimeout(async () => {
    const ok = Math.random() > 0.1;
    const ref = "MP" + Date.now().toString(36).toUpperCase();
    const status = ok ? "completed" : "failed";
    await pool.query(`UPDATE agrihub.mpesa_requests SET status=$1, reference=$2, result_code=$3, result_description=$4, updated_at=NOW() WHERE id=$5`,
      [status, ok ? ref : null, ok ? "0" : "1", ok ? "Success" : "Request cancelled by user", id]);

    const paymentStatus = ok ? "completed" : "failed";
    const paymentFields = ok
      ? { payment_status: "completed", payment_method: "M-Pesa", payment_phone: phone, payment_amount: amount, payment_reference: ref, payment_date: new Date().toISOString() }
      : { payment_status: "failed" };
    await pool.query(`UPDATE agrihub.transactions SET payment_status=$1, payment_method=$2, payment_phone=$3, payment_amount=$4, payment_reference=$5, payment_date=$6 WHERE id=$7`,
      [paymentFields.payment_status || "failed", paymentFields.payment_method || null, paymentFields.payment_phone || null, paymentFields.payment_amount || null, paymentFields.payment_reference || null, paymentFields.payment_date || null, transactionId]);
  }, 10000);

  return id;
}

// ─── Real Daraja STK Push ─────────────────────────────────────────────────────
export async function realStkPush(phone, amount, transactionId) {
  const token = await getAccessToken();
  const env = process.env.MPESA_ENV === "production"
    ? "https://api.safaricom.co.ke"
    : "https://sandbox.safaricom.co.ke";

  const timestamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  const passkey = process.env.MPESA_PASSKEY;
  const shortcode = process.env.MPESA_SHORTCODE || "174379";
  const password = Buffer.from(`${shortcode}${passkey}${timestamp}`).toString("base64");

  const callbackUrl = `${process.env.BASE_URL || "http://localhost:4000"}/api/mpesa/callback`;

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
    AccountReference: `AGRIHUB-${transactionId.slice(0, 8)}`,
    TransactionDesc: "AgriHub Farmer Payout",
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
  const id = uuid();
  await pool.query(`INSERT INTO agrihub.mpesa_requests (id, transaction_id, phone, amount, merchant_request_id, checkout_request_id, response_code, response_description, status)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')`,
    [id, transactionId, phone, amount, data.MerchantRequestID, data.CheckoutRequestID, data.ResponseCode, data.ResponseDescription]);

  if (data.ResponseCode !== "0") {
    await pool.query(`UPDATE agrihub.mpesa_requests SET status='failed', updated_at=NOW() WHERE id=$1`, [id]);
    await pool.query(`UPDATE agrihub.transactions SET payment_status='failed' WHERE id=$1`, [transactionId]);
  } else {
    await pool.query(`UPDATE agrihub.transactions SET payment_status='pending' WHERE id=$1`, [transactionId]);
  }

  return id;
}

// ─── POST /api/mpesa/stkpush ──────────────────────────────────────────────────
router.post("/stkpush", authorize("Admin", "Weighbridge Trader", "Investor"), async (req, res) => {
  try {
    const { transaction_id, phone, amount, payment_request_id } = req.body;
    if (!transaction_id || !phone || !amount) return res.status(400).json({ error: "transaction_id, phone, and amount required" });

    // Rate limiting check
    if (!await checkRateLimit(req.user.id, 'stk_push')) {
      return res.status(429).json({ error: "Too many STK push requests. Please try again later." });
    }

    // Fraud detection
    const fraudWarnings = await detectFraud(req.user.id, amount, phone);
    if (fraudWarnings.length > 0) {
      await logAudit(req.user.id, 'stk_push_fraud_warning', 'mpesa_transaction', null, amount, req, null, { warnings: fraudWarnings }, transaction_id, payment_request_id, null, null);
    }

    const txn = await queryOne("SELECT * FROM agrihub.transactions WHERE id = $1", [transaction_id]);
    if (!txn) return res.status(404).json({ error: "Transaction not found" });

    const formattedPhone = formatPhone(phone);
    const hasRealCredentials = process.env.MPESA_CONSUMER_KEY && process.env.MPESA_CONSUMER_KEY !== "your_consumer_key_here";
    const simulationMode = process.env.MPESA_SIMULATION_MODE === "true";

    let requestId;
    if (hasRealCredentials) {
      requestId = await realStkPush(formattedPhone, amount, transaction_id, payment_request_id);
    } else if (simulationMode) {
      requestId = await simulatedStkPush(formattedPhone, amount, transaction_id, payment_request_id);
      await pool.query(`UPDATE agrihub.transactions SET payment_status='pending', payment_method='M-Pesa', payment_phone=$1, payment_amount=$2 WHERE id=$3`,
        [formattedPhone, amount, transaction_id]);
    } else {
      throw new Error("M-Pesa credentials not configured. Set MPESA_SIMULATION_MODE=true for development or configure production credentials.");
    }

    await logAudit(req.user.id, 'stk_push_initiated', 'mpesa_transaction', requestId, amount, req, null, { status: 'pending' }, transaction_id, payment_request_id, requestId, null);

    res.json({ ok: true, request_id: requestId, mode: hasRealCredentials ? "live" : "simulated", fraud_warnings: fraudWarnings });
  } catch (err) {
    console.error("STK Push error:", err);
    return res.status(500).json({ error: "STK Push failed", details: err.message });
  }
});

// ─── POST /api/mpesa/callback ────────────────────────────────────────────────
router.post("/callback", async (req, res) => {
  try {
    const data = req.body;
    const signature = req.get('x-mpesa-signature');
    
    // Verify callback signature for security
    if (signature && !verifyCallbackSignature(data, signature)) {
      console.error("Invalid callback signature");
      return res.status(401).json({ error: "Invalid signature" });
    }

    const stkCallback = data?.Body?.stkCallback;
    if (!stkCallback) return res.status(400).json({ error: "Invalid callback" });

    const { MerchantRequestID, CheckoutRequestID, ResultCode, ResultDesc } = stkCallback;

    const reqRecord = await queryOne("SELECT * FROM agrihub.mpesa_requests WHERE merchant_request_id = $1 OR checkout_request_id = $2", [MerchantRequestID, CheckoutRequestID]);
    if (!reqRecord) return res.status(404).json({ error: "Request not found" });

    // Check for duplicate callbacks (idempotency)
    if (reqRecord.status !== 'pending') {
      console.log("Duplicate callback received, ignoring");
      return res.json({ ok: true, duplicate: true });
    }

    const status = ResultCode === "0" ? "completed" : "failed";
    const reference = stkCallback.CallbackMetadata?.Item?.find(i => i.Name === "MpesaReceiptNumber")?.Value || null;

    await pool.query(`UPDATE agrihub.mpesa_requests SET status=$1, reference=$2, result_code=$3, result_description=$4, updated_at=NOW() WHERE id=$5`,
      [status, reference, ResultCode, ResultDesc, reqRecord.id]);

    const paymentStatus = status === "completed" ? "completed" : "failed";
    if (status === "completed") {
      await pool.query(`UPDATE agrihub.transactions SET payment_status=$1, payment_method='M-Pesa', payment_phone=$2, payment_amount=$3, payment_reference=$4, payment_date=$5 WHERE id=$6`,
        [paymentStatus, reqRecord.phone, reqRecord.amount, reference, new Date().toISOString(), reqRecord.transaction_id]);
      
      // Update field status to paid
      await pool.query(`UPDATE agrihub.fields SET status = 'paid' WHERE id IN (SELECT field_id FROM agrihub.transactions WHERE id = $1)`, [reqRecord.transaction_id]);
    } else {
      await pool.query(`UPDATE agrihub.transactions SET payment_status=$1 WHERE id=$2`, [paymentStatus, reqRecord.transaction_id]);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("Callback error:", err);
    res.status(500).json({ error: "Callback processing failed" });
  }
});

// ─── GET /api/mpesa/status/:transaction_id ─────────────────────────────────────
router.get("/status/:transaction_id", authenticate, async (req, res) => {
  try {
    const txn = await queryOne("SELECT * FROM agrihub.transactions WHERE id = $1", [req.params.transaction_id]);
    if (!txn) return res.status(404).json({ error: "Transaction not found" });

    const request = await queryOne("SELECT * FROM agrihub.mpesa_requests WHERE transaction_id = $1 ORDER BY created_at DESC LIMIT 1", [req.params.transaction_id]);

    res.json({
      transaction_id: txn.id,
      payment_status: txn.payment_status,
      payment_method: txn.payment_method,
      payment_phone: txn.payment_phone,
      payment_amount: txn.payment_amount,
      payment_reference: txn.payment_reference,
      payment_date: txn.payment_date,
      request,
    });
  } catch (error) {
    console.error("Error fetching M-Pesa status:", error);
    res.status(500).json({ error: "Failed to fetch M-Pesa status" });
  }
});

// ─── POST /api/mpesa/confirm (manual confirm for simulation mode) ────────────
router.post("/confirm", authorize("Admin", "Weighbridge Trader"), async (req, res) => {
  try {
    const { transaction_id, ok } = req.body;
    if (!transaction_id) return res.status(400).json({ error: "transaction_id required" });

    const txn = await queryOne("SELECT * FROM agrihub.transactions WHERE id = $1", [transaction_id]);
    if (!txn) return res.status(404).json({ error: "Transaction not found" });

    const request = await queryOne("SELECT * FROM agrihub.mpesa_requests WHERE transaction_id = $1 AND status='pending' ORDER BY created_at DESC LIMIT 1", [transaction_id]);

    if (ok) {
      const ref = "MP" + Date.now().toString(36).toUpperCase();
      if (request) {
        await pool.query(`UPDATE agrihub.mpesa_requests SET status='completed', reference=$1, result_code='0', result_description='User confirmed', updated_at=NOW() WHERE id=$2`,
          [ref, request.id]);
      }
      await pool.query(`UPDATE agrihub.transactions SET payment_status='completed', payment_method='M-Pesa', payment_phone=$1, payment_amount=$2, payment_reference=$3, payment_date=$4 WHERE id=$5`,
        [txn.payment_phone || request?.phone, txn.payment_amount || request?.amount, ref, new Date().toISOString(), transaction_id]);
      
      // Update field status to paid
      await pool.query(`UPDATE agrihub.fields SET status = 'paid' WHERE id IN (SELECT field_id FROM agrihub.transactions WHERE id = $1)`, [transaction_id]);
      
      res.json({ ok: true, status: "completed", reference: ref });
    } else {
      if (request) {
        await pool.query(`UPDATE agrihub.mpesa_requests SET status='failed', result_code='1', result_description='User declined', updated_at=NOW() WHERE id=$1`, [request.id]);
      }
      await pool.query(`UPDATE agrihub.transactions SET payment_status='failed' WHERE id=$1`, [transaction_id]);
      res.json({ ok: true, status: "failed" });
    }
  } catch (error) {
    console.error("Error confirming M-Pesa transaction:", error);
    res.status(500).json({ error: "Failed to confirm M-Pesa transaction" });
  }
});

// ─── POST /api/mpesa/b2c ───────────────────────────────────────────────────────
router.post("/b2c", authorize("Admin"), async (req, res) => {
  try {
    const { phone, amount, command_id = "BusinessPayment", remarks } = req.body;
    
    if (!phone || !amount) {
      return res.status(400).json({ error: "Phone and amount required" });
    }

    // Rate limiting check
    if (!await checkRateLimit(req.user.id, 'b2c_payment')) {
      return res.status(429).json({ error: "Too many B2C payment requests. Please try again later." });
    }

    const formattedPhone = formatPhone(phone);
    const hasRealCredentials = process.env.MPESA_CONSUMER_KEY && process.env.MPESA_CONSUMER_KEY !== "your_consumer_key_here";
    const simulationMode = process.env.MPESA_SIMULATION_MODE === "true";

    let result;
    if (hasRealCredentials) {
      const token = await getAccessToken();
      const env = process.env.MPESA_ENV === "production"
        ? "https://api.safaricom.co.ke"
        : "https://sandbox.safaricom.co.ke";

      const securityCredential = generateSecurityCredential();
      const initiatorName = process.env.MPESA_INITIATOR_NAME || "testapi";
      const shortcode = process.env.MPESA_SHORTCODE || "174379";

      const body = {
        InitiatorName: initiatorName,
        SecurityCredential: securityCredential,
        CommandID: command_id,
        Amount: Math.round(amount),
        PartyA: shortcode,
        PartyB: formattedPhone,
        Remarks: remarks || "AgriHub B2C Payment",
        QueueTimeOutURL: `${process.env.BASE_URL || "http://localhost:4000"}/api/mpesa/b2c/timeout`,
        ResultURL: `${process.env.BASE_URL || "http://localhost:4000"}/api/mpesa/b2c/result`,
        Occasion: "AgriHubPayment"
      };

      const resp = await safeFetch(`${env}/mpesa/b2c/v1/paymentrequest`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      const data = await resp.json();
      result = { success: data.ResponseCode === "0", data };
    } else if (simulationMode) {
      // Simulated B2C
      const id = uuid();
      await pool.query(
        `INSERT INTO agrihub.mpesa_transactions (id, transaction_type, phone, amount, status, result_code, result_description)
        VALUES ($1, 'b2c', $2, $3, 'completed', '0', 'Simulated B2C payment successful')`,
        [id, formattedPhone, amount]
      );
      result = { success: true, simulated: true, id };
    } else {
      throw new Error("M-Pesa credentials not configured. Set MPESA_SIMULATION_MODE=true for development or configure production credentials.");
    }

    await logAudit(req.user.id, 'b2c_payment_initiated', 'mpesa_transaction', result.id || null, amount, req, null, { status: result.success ? 'completed' : 'failed' }, null, null, result.id, null);

    res.json(result);
  } catch (err) {
    console.error("B2C payment error:", err);
    res.status(500).json({ error: "Failed to process B2C payment" });
  }
});

// ─── POST /api/mpesa/b2c/result ───────────────────────────────────────────────
router.post("/b2c/result", async (req, res) => {
  try {
    const data = req.body;
    const signature = req.get('x-mpesa-signature');
    
    if (signature && !verifyCallbackSignature(data, signature)) {
      return res.status(401).json({ error: "Invalid signature" });
    }

    const { Result, ResultType } = data;
    if (!Result) return res.status(400).json({ error: "Invalid B2C result" });

    const conversationId = Result.ConversationID;
    const resultCode = Result.ResultCode;
    const resultDesc = Result.ResultDescription;

    const mpesaTxn = await queryOne("SELECT * FROM agrihub.mpesa_transactions WHERE conversation_id = $1", [conversationId]);
    if (!mpesaTxn) {
      // Create new record if not exists
      const id = uuid();
      await pool.query(
        `INSERT INTO agrihub.mpesa_transactions (id, transaction_type, phone, amount, conversation_id, result_code, result_description, status)
        VALUES ($1, 'b2c', $2, $3, $4, $5, $6, $7)`,
        [id, Result?.PartyB || "unknown", Result?.TransactionAmount || 0, conversationId, resultCode, resultDesc, resultCode === "0" ? "completed" : "failed"]
      );
    } else {
      await pool.query(
        `UPDATE agrihub.mpesa_transactions 
        SET result_code = $1, result_description = $2, status = $3, callback_received = 1, callback_data = $4, updated_at = NOW()
        WHERE id = $5`,
        [resultCode, resultDesc, resultCode === "0" ? "completed" : "failed", JSON.stringify(data), mpesaTxn.id]
      );
    }

    res.json({ ok: true });
  } catch (error) {
    console.error("B2C result error:", error);
    res.status(500).json({ error: "Failed to process B2C result" });
  }
});

// ─── POST /api/mpesa/b2c/timeout ──────────────────────────────────────────────
router.post("/b2c/timeout", (req, res) => {
  const data = req.body;
  console.log("B2C timeout:", data);
  res.json({ ok: true });
});

// ─── POST /api/mpesa/transaction-status ───────────────────────────────────────
router.post("/transaction-status", authorize("Admin"), async (req, res) => {
  try {
    const { transaction_id, party_a, identifier_type = "4", remarks } = req.body;
    
    if (!transaction_id) {
      return res.status(400).json({ error: "Transaction ID required" });
    }

    const hasRealCredentials = process.env.MPESA_CONSUMER_KEY && process.env.MPESA_CONSUMER_KEY !== "your_consumer_key_here";
    const simulationMode = process.env.MPESA_SIMULATION_MODE === "true";

    let result;
    if (hasRealCredentials) {
      const token = await getAccessToken();
      const env = process.env.MPESA_ENV === "production"
        ? "https://api.safaricom.co.ke"
        : "https://sandbox.safaricom.co.ke";

      const securityCredential = generateSecurityCredential();
      const initiatorName = process.env.MPESA_INITIATOR_NAME || "testapi";
      const shortcode = process.env.MPESA_SHORTCODE || "174379";

      const body = {
        InitiatorName: initiatorName,
        SecurityCredential: securityCredential,
        CommandID: "TransactionStatusQuery",
        TransactionID: transaction_id,
        PartyA: party_a || shortcode,
        IdentifierType: identifier_type,
        ResultURL: `${process.env.BASE_URL || "http://localhost:4000"}/api/mpesa/transaction-status/result`,
        QueueTimeOutURL: `${process.env.BASE_URL || "http://localhost:4000"}/api/mpesa/transaction-status/timeout`,
        Remarks: remarks || "Status check",
        Occasion: "StatusCheck"
      };

      const resp = await safeFetch(`${env}/mpesa/transactionstatus/v1/query`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      const data = await resp.json();
      result = { success: data.ResponseCode === "0", data };
    } else if (simulationMode) {
      // Simulated status check
      const mpesaTxn = await queryOne("SELECT * FROM agrihub.mpesa_transactions WHERE id = $1 OR mpesa_receipt_number = $1", [transaction_id, transaction_id]);
      result = { 
        success: true, 
        simulated: true, 
        status: mpesaTxn?.status || "not_found",
        transaction: mpesaTxn
      };
    } else {
      throw new Error("M-Pesa credentials not configured. Set MPESA_SIMULATION_MODE=true for development or configure production credentials.");
    }

    await logAudit(req.user.id, 'transaction_status_query', 'mpesa_transaction', transaction_id, null, req, null, { result }, null, null, null, null);

    res.json(result);
  } catch (err) {
    console.error("Transaction status error:", err);
    res.status(500).json({ error: "Failed to query transaction status" });
  }
});

// ─── POST /api/mpesa/account-balance ─────────────────────────────────────────
router.post("/account-balance", authorize("Admin"), async (req, res) => {
  try {
    const hasRealCredentials = process.env.MPESA_CONSUMER_KEY && process.env.MPESA_CONSUMER_KEY !== "your_consumer_key_here";

    let result;
    if (hasRealCredentials) {
      const token = await getAccessToken();
      const env = process.env.MPESA_ENV === "production"
        ? "https://api.safaricom.co.ke"
        : "https://sandbox.safaricom.co.ke";

      const securityCredential = generateSecurityCredential();
      const initiatorName = process.env.MPESA_INITIATOR_NAME || "testapi";
      const shortcode = process.env.MPESA_SHORTCODE || "174379";

      const body = {
        InitiatorName: initiatorName,
        SecurityCredential: securityCredential,
        CommandID: "AccountBalance",
        PartyA: shortcode,
        IdentifierType: "4",
        Remarks: "Balance check",
        ResultURL: `${process.env.BASE_URL || "http://localhost:4000"}/api/mpesa/account-balance/result`,
        QueueTimeOutURL: `${process.env.BASE_URL || "http://localhost:4000"}/api/mpesa/account-balance/timeout`
      };

      const resp = await safeFetch(`${env}/mpesa/accountbalance/v1/query`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      const data = await resp.json();
      result = { success: data.ResponseCode === "0", data };
    } else {
      // Simulated balance
      result = { 
        success: true, 
        simulated: true, 
        balance: 1000000,
        currency: "KES"
      };
    }

    await logAudit(req.user.id, 'account_balance_query', 'system', null, null, req, null, { result }, null, null, null, null);

    res.json(result);
  } catch (err) {
    console.error("Account balance error:", err);
    res.status(500).json({ error: "Failed to query account balance" });
  }
});

// ─── POST /api/mpesa/reversal ──────────────────────────────────────────────────
router.post("/reversal", authorize("Admin"), async (req, res) => {
  try {
    const { transaction_id, amount, remarks } = req.body;
    
    if (!transaction_id || !amount) {
      return res.status(400).json({ error: "Transaction ID and amount required" });
    }

    // Rate limiting check
    if (!await checkRateLimit(req.user.id, 'reversal')) {
      return res.status(429).json({ error: "Too many reversal requests. Please try again later." });
    }

    const hasRealCredentials = process.env.MPESA_CONSUMER_KEY && process.env.MPESA_CONSUMER_KEY !== "your_consumer_key_here";

    let result;
    if (hasRealCredentials) {
      const token = await getAccessToken();
      const env = process.env.MPESA_ENV === "production"
        ? "https://api.safaricom.co.ke"
        : "https://sandbox.safaricom.co.ke";

      const securityCredential = generateSecurityCredential();
      const initiatorName = process.env.MPESA_INITIATOR_NAME || "testapi";
      const shortcode = process.env.MPESA_SHORTCODE || "174379";

      const body = {
        InitiatorName: initiatorName,
        SecurityCredential: securityCredential,
        CommandID: "TransactionReversal",
        TransactionID: transaction_id,
        Amount: Math.round(amount),
        ReceiverParty: shortcode,
        RecieverIdentifierType: "4",
        ResultURL: `${process.env.BASE_URL || "http://localhost:4000"}/api/mpesa/reversal/result`,
        QueueTimeOutURL: `${process.env.BASE_URL || "http://localhost:4000"}/api/mpesa/reversal/timeout`,
        Remarks: remarks || "Transaction reversal",
        Occasion: "Reversal"
      };

      const resp = await safeFetch(`${env}/mpesa/reversal/v1/request`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      const data = await resp.json();
      result = { success: data.ResponseCode === "0", data };
    } else {
      // Simulated reversal
      const id = uuid();
      await pool.query(
        `INSERT INTO agrihub.mpesa_transactions (id, transaction_type, amount, result_code, result_description, status)
        VALUES ($1, 'reversal', $2, '0', 'Simulated reversal successful', 'completed')`,
        [id, amount]
      );
      
      // Update original transaction
      await pool.query(`UPDATE agrihub.transactions SET payment_status = 'reversed' WHERE payment_reference = $1`, [transaction_id]);
      
      result = { success: true, simulated: true, id };
    }

    await logAudit(req.user.id, 'transaction_reversal', 'mpesa_transaction', transaction_id, amount, req, { payment_status: 'completed' }, { payment_status: 'reversed' }, null, null, null, null);

    res.json(result);
  } catch (err) {
    console.error("Reversal error:", err);
    res.status(500).json({ error: "Failed to process reversal" });
  }
});

// ─── GET /api/mpesa/transactions ───────────────────────────────────────────────
router.get("/transactions", authorize("Admin"), async (req, res) => {
  try {
    const { status, transaction_type, limit = 50, offset = 0 } = req.query;
    
    let query = "SELECT * FROM agrihub.mpesa_transactions WHERE 1=1";
    const params = [];
    let paramIndex = 1;
    
    if (status) {
      query += ` AND status = $${paramIndex++}`;
      params.push(status);
    }
    if (transaction_type) {
      query += ` AND transaction_type = $${paramIndex++}`;
      params.push(transaction_type);
    }
    
    query += ` ORDER BY created_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
    params.push(parseInt(limit), parseInt(offset));
    
    const transactions = await queryMany(query, params);
    res.json(transactions);
  } catch (error) {
    console.error("Error fetching M-Pesa transactions:", error);
    res.status(500).json({ error: "Failed to fetch M-Pesa transactions" });
  }
});

export default router;
