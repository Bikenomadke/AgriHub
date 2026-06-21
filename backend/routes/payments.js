import { Router } from "express";
import { v4 as uuid } from "uuid";
import pool, { queryOne, queryMany, transaction } from "../db-postgres.js";
import { authenticate, authorize } from "../middleware/auth.js";
import bcrypt from "bcryptjs";

const router = Router();
router.use(authenticate);

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function getSystemConfig(key) {
  const config = await queryOne("SELECT value FROM agrihub.system_config WHERE key = $1", [key]);
  return config ? config.value : null;
}

async function calculatePaymentDetails(field) {
  const platformFeePercent = parseFloat(await getSystemConfig('platform_fee_percentage')) || 5;
  const taxPercent = parseFloat(await getSystemConfig('tax_percentage')) || 0;
  
  const farmerPayment = field.valuation || 0;
  const harvestCost = field.harvest_cost || 0;
  const transportCost = field.transport_cost || 0;
  const pullingCost = field.pulling_cost || 0;
  
  const platformFee = (farmerPayment * platformFeePercent) / 100;
  const taxAmount = (farmerPayment * taxPercent) / 100;
  
  const grossAmount = farmerPayment + harvestCost + transportCost + pullingCost;
  const netAmount = farmerPayment - platformFee - taxAmount;
  
  return {
    farmer_payment: farmerPayment,
    harvest_cost: harvestCost,
    transport_cost: transportCost,
    pulling_cost: pullingCost,
    platform_fee: platformFee,
    tax_amount: taxAmount,
    gross_amount: grossAmount,
    net_amount: netAmount
  };
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

// ─── POST /api/payments/calculate ────────────────────────────────────────────
router.post("/calculate", authorize("Investor"), async (req, res) => {
  try {
    const { field_id, harvest_cost, transport_cost, pulling_cost } = req.body;
    
    if (!field_id) {
      return res.status(400).json({ error: "Field ID required" });
    }

    const field = await queryOne("SELECT * FROM agrihub.fields WHERE id = $1", [field_id]);
    if (!field) return res.status(404).json({ error: "Field not found" });

    if (field.status !== 'valued' && field.status !== 'surveyed') {
      return res.status(400).json({ error: "Field must be valued before purchase" });
    }

    const details = await calculatePaymentDetails({
      ...field,
      harvest_cost: harvest_cost || field.harvest_cost,
      transport_cost: transport_cost || field.transport_cost,
      pulling_cost: pulling_cost || field.pulling_cost
    });

    res.json({ field_id, ...details });
  } catch (error) {
    console.error("Error calculating payment:", error);
    res.status(500).json({ error: "Failed to calculate payment" });
  }
});

// ─── POST /api/payments/create-request ───────────────────────────────────────
router.post("/create-request", authorize("Investor"), async (req, res) => {
  try {
    const { field_id, harvest_cost, transport_cost, pulling_cost, auth_method } = req.body;
    
    if (!field_id) {
      return res.status(400).json({ error: "Field ID required" });
    }

    const field = await queryOne("SELECT * FROM agrihub.fields WHERE id = $1", [field_id]);
    if (!field) return res.status(404).json({ error: "Field not found" });

    if (field.status !== 'valued' && field.status !== 'surveyed') {
      return res.status(400).json({ error: "Field must be valued before purchase" });
    }

    if (!field.farmer_id) {
      return res.status(400).json({ error: "Field must be linked to a farmer" });
    }

    const farmer = await queryOne("SELECT * FROM agrihub.farmers WHERE id = $1", [field.farmer_id]);
    if (!farmer) return res.status(404).json({ error: "Farmer not found" });

    if (farmer.verification_status !== 'verified') {
      return res.status(400).json({ error: "Farmer must be verified before payment" });
    }

    const wallet = await queryOne("SELECT * FROM agrihub.wallets WHERE user_id = $1", [req.user.id]);
    if (!wallet) return res.status(400).json({ error: "Wallet not found" });

    const details = await calculatePaymentDetails({
      ...field,
      harvest_cost: harvest_cost || field.harvest_cost,
      transport_cost: transport_cost || field.transport_cost,
      pulling_cost: pulling_cost || field.pulling_cost
    });

    if (wallet.available_balance < details.gross_amount) {
      return res.status(400).json({ error: "Insufficient wallet balance" });
    }

    const maxPaymentAmount = parseFloat(await getSystemConfig('max_payment_amount')) || 1000000;
    const requiresAdditionalAuth = details.gross_amount > maxPaymentAmount;

    const paymentRequestId = uuid();
    const expiresAt = new Date(Date.now() + (parseInt(await getSystemConfig('payment_timeout_seconds')) || 300) * 1000).toISOString();

    await pool.query(
      `INSERT INTO agrihub.payment_requests (id, investor_id, farmer_id, field_id, amount, farmer_payment, harvest_cost, transport_cost, pulling_cost, platform_fee, tax_amount, gross_amount, net_amount, auth_method, expires_at, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'pending')`,
      [
        paymentRequestId, req.user.id, field.farmer_id, field_id,
        details.gross_amount, details.farmer_payment, details.harvest_cost,
        details.transport_cost, details.pulling_cost, details.platform_fee,
        details.tax_amount, details.gross_amount, details.net_amount,
        auth_method || (requiresAdditionalAuth ? 'otp' : 'pin'), expiresAt
      ]
    );

    await logAudit(
      req.user.id, 'payment_request_created', 'payment_request', paymentRequestId, details.gross_amount, req,
      null, { status: 'pending', expires_at: expiresAt },
      null, paymentRequestId, null, null
    );

    const paymentRequest = await queryOne("SELECT * FROM agrihub.payment_requests WHERE id = $1", [paymentRequestId]);
    res.status(201).json({ 
      payment_request: paymentRequest,
      requires_additional_auth: requiresAdditionalAuth,
      farmer: { full_name: farmer.full_name, mpesa_phone: farmer.mpesa_phone }
    });
  } catch (err) {
    console.error("Create payment request error:", err);
    res.status(500).json({ error: "Failed to create payment request" });
  }
});

// ─── POST /api/payments/authorize ────────────────────────────────────────────
router.post("/authorize", authorize("Investor"), async (req, res) => {
  try {
    const { payment_request_id, pin, otp, biometric_token } = req.body;
    
    if (!payment_request_id) {
      return res.status(400).json({ error: "Payment request ID required" });
    }

    const paymentRequest = await queryOne("SELECT * FROM agrihub.payment_requests WHERE id = $1", [payment_request_id]);
    if (!paymentRequest) return res.status(404).json({ error: "Payment request not found" });

    if (paymentRequest.status !== 'pending') {
      return res.status(400).json({ error: "Payment request is not pending" });
    }

    if (new Date(paymentRequest.expires_at) < new Date()) {
      await pool.query("UPDATE agrihub.payment_requests SET status = 'cancelled' WHERE id = $1", [payment_request_id]);
      return res.status(400).json({ error: "Payment request has expired" });
    }

    const user = await queryOne("SELECT * FROM agrihub.users WHERE id = $1", [req.user.id]);
    
    // PIN verification
    if (paymentRequest.auth_method === 'pin' || (!paymentRequest.auth_method && pin)) {
      if (!user.pin_hash) {
        return res.status(400).json({ error: "PIN not set for user" });
      }
      if (!bcrypt.compareSync(pin, user.pin_hash)) {
        return res.status(401).json({ error: "Invalid PIN" });
      }
    }

    // OTP verification (for large amounts)
    if (paymentRequest.auth_method === 'otp') {
      if (!otp) {
        return res.status(400).json({ error: "OTP required for this transaction" });
      }
      // In production, verify OTP from SMS service
      // For now, we'll accept any 6-digit OTP
      if (!/^\d{6}$/.test(otp)) {
        return res.status(400).json({ error: "Invalid OTP format" });
      }
    }

    // Biometric verification
    if (paymentRequest.auth_method === 'biometric') {
      if (!biometric_token) {
        return res.status(400).json({ error: "Biometric token required" });
      }
      // In production, verify biometric token with mobile app
    }

    await pool.query("UPDATE agrihub.payment_requests SET status = 'approved', auth_verified = true, updated_at = NOW() WHERE id = $1", [payment_request_id]);

    await logAudit(
      req.user.id, 'payment_authorized', 'payment_request', payment_request_id, paymentRequest.amount, req,
      { status: 'pending', auth_verified: false }, { status: 'approved', auth_verified: true },
      null, payment_request_id, null, null
    );

    res.json({ ok: true, message: "Payment authorized successfully" });
  } catch (err) {
    console.error("Authorize payment error:", err);
    res.status(500).json({ error: "Failed to authorize payment" });
  }
});

// ─── POST /api/payments/execute ──────────────────────────────────────────────
router.post("/execute", authorize("Investor"), async (req, res) => {
  try {
    const { payment_request_id } = req.body;
    
    if (!payment_request_id) {
      return res.status(400).json({ error: "Payment request ID required" });
    }

    const paymentRequest = await queryOne("SELECT * FROM agrihub.payment_requests WHERE id = $1", [payment_request_id]);
    if (!paymentRequest) return res.status(404).json({ error: "Payment request not found" });

    if (paymentRequest.status !== 'approved') {
      return res.status(400).json({ error: "Payment request must be approved before execution" });
    }

    const field = await queryOne("SELECT * FROM agrihub.fields WHERE id = $1", [paymentRequest.field_id]);
    const farmer = await queryOne("SELECT * FROM agrihub.farmers WHERE id = $1", [paymentRequest.farmer_id]);
    const wallet = await queryOne("SELECT * FROM agrihub.wallets WHERE user_id = $1", [paymentRequest.investor_id]);

    if (wallet.available_balance < paymentRequest.amount) {
      return res.status(400).json({ error: "Insufficient wallet balance" });
    }

    const escrowMode = await getSystemConfig('escrow_mode') === 'enabled';

    const { transactionId, escrowAccountId } = await transaction(async (client) => {
      // Update field status
      await client.query("UPDATE agrihub.fields SET status = 'reserved', investor_id = $1, updated_at = NOW() WHERE id = $2", [paymentRequest.investor_id, paymentRequest.field_id]);

      // Deduct from wallet
      const balanceBefore = wallet.balance;
      const balanceAfter = balanceBefore - paymentRequest.amount;
      
      await client.query(
        `UPDATE agrihub.wallets 
        SET balance = $1, available_balance = $2, updated_at = NOW()
        WHERE id = $3`,
        [balanceAfter, balanceAfter, wallet.id]
      );

      // Record wallet transaction
      const walletTransactionId = uuid();
      await client.query(
        `INSERT INTO agrihub.wallet_transactions (id, wallet_id, transaction_type, amount, balance_before, balance_after, reference, description, metadata)
        VALUES ($1, $2, 'payment', $3, $4, $5, $6, $7, $8)`,
        [
          walletTransactionId, wallet.id, paymentRequest.amount, balanceBefore, balanceAfter,
          `PAY-${payment_request_id.slice(0, 8)}`, `Field purchase: ${field.name}`,
          JSON.stringify({ field_id: paymentRequest.field_id, farmer_id: paymentRequest.farmer_id, payment_request_id: payment_request_id })
        ]
      );

      let escrowAccountId = null;

      if (escrowMode) {
        // Create escrow account
        escrowAccountId = uuid();
        await client.query(
          `INSERT INTO agrihub.escrow_accounts (id, investor_id, farmer_id, field_id, amount, status)
          VALUES ($1, $2, $3, $4, $5, 'locked')`,
          [escrowAccountId, paymentRequest.investor_id, paymentRequest.farmer_id, paymentRequest.field_id, paymentRequest.farmer_payment]
        );

        // Record escrow deposit in wallet
        const escrowWalletTxId = uuid();
        await client.query(
          `INSERT INTO agrihub.wallet_transactions (id, wallet_id, transaction_type, amount, balance_before, balance_after, reference, description, related_escrow_id, metadata)
          VALUES ($1, $2, 'escrow_deposit', $3, $4, $5, $6, $7, $8, $9)`,
          [
            escrowWalletTxId, wallet.id, paymentRequest.farmer_payment, balanceAfter, balanceAfter,
            `ESC-${escrowAccountId.slice(0, 8)}`, `Escrow deposit for field: ${field.name}`, escrowAccountId,
            JSON.stringify({ field_id: paymentRequest.field_id, payment_request_id: payment_request_id })
          ]
        );
      }

      // Create transaction record
      const transactionId = uuid();
      await client.query(
        `INSERT INTO agrihub.transactions (id, farmer_name, tons, buy_price, total_cost, expected_payout, gross_profit, date, ticket_number, payment_status, field_id, farmer_id, investor_id, wallet_transaction_id, escrow_transaction_id, created_by)
        VALUES ($1, $2, 0, $3, $4, $5, 0, NOW(), $6, 'pending', $7, $8, $9, $10, $11, $12)`,
        [
          transactionId, farmer.full_name, paymentRequest.farmer_payment,
          paymentRequest.gross_amount, paymentRequest.net_amount,
          `TXN-${transactionId.slice(0, 8)}`, paymentRequest.field_id,
          paymentRequest.farmer_id, paymentRequest.investor_id,
          walletTransactionId, escrowAccountId, req.user.id
        ]
      );

      // Update payment request with transaction_id and processing status
      await client.query(
        "UPDATE agrihub.payment_requests SET status = 'processing', transaction_id = $1, updated_at = NOW() WHERE id = $2",
        [transactionId, payment_request_id]
      );

      // Add to payment queue
      const queueId = uuid();
      await client.query(
        `INSERT INTO agrihub.payment_queue (id, payment_request_id, status, scheduled_at)
        VALUES ($1, $2, 'queued', NOW())`,
        [queueId, payment_request_id]
      );

      await logAudit(
        req.user.id, 'payment_executed', 'payment_request', payment_request_id, paymentRequest.amount, req,
        { wallet_balance: balanceBefore, field_status: field.status },
        { wallet_balance: balanceAfter, field_status: 'reserved' },
        transactionId, payment_request_id, null, walletTransactionId
      );

      return { transactionId, escrowAccountId };
    });

    res.status(201).json({ 
      ok: true, 
      transaction_id: transactionId,
      payment_request_id: payment_request_id,
      escrow_account_id: escrowAccountId,
      message: escrowMode ? "Payment held in escrow pending harvest confirmation" : "Payment initiated to farmer"
    });
  } catch (err) {
    console.error("Execute payment error:", err);
    res.status(500).json({ error: "Failed to execute payment" });
  }
});

// ─── POST /api/payments/cancel ────────────────────────────────────────────────
router.post("/cancel", authorize("Investor"), async (req, res) => {
  try {
    const { payment_request_id } = req.body;
    
    if (!payment_request_id) {
      return res.status(400).json({ error: "Payment request ID required" });
    }

    const paymentRequest = await queryOne("SELECT * FROM agrihub.payment_requests WHERE id = $1", [payment_request_id]);
    if (!paymentRequest) return res.status(404).json({ error: "Payment request not found" });

    if (paymentRequest.status !== 'pending' && paymentRequest.status !== 'approved') {
      return res.status(400).json({ error: "Payment request cannot be cancelled in current state" });
    }

    if (paymentRequest.investor_id !== req.user.id) {
      return res.status(403).json({ error: "Not authorized to cancel this payment request" });
    }

    await pool.query("UPDATE agrihub.payment_requests SET status = 'cancelled', updated_at = NOW() WHERE id = $1", [payment_request_id]);

    await logAudit(
      req.user.id, 'payment_cancelled', 'payment_request', payment_request_id, paymentRequest.amount, req,
      { status: paymentRequest.status }, { status: 'cancelled' },
      null, payment_request_id, null, null
    );

    res.json({ ok: true, message: "Payment request cancelled" });
  } catch (err) {
    console.error("Cancel payment error:", err);
    res.status(500).json({ error: "Failed to cancel payment" });
  }
});

// ─── GET /api/payments/requests ───────────────────────────────────────────────
router.get("/requests", authorize("Investor"), async (req, res) => {
  try {
    const { status } = req.query;
    let query = "SELECT * FROM agrihub.payment_requests WHERE investor_id = $1";
    const params = [req.user.id];
    let paramIndex = 2;
    
    if (status) {
      query += ` AND status = $${paramIndex++}`;
      params.push(status);
    }
    
    query += " ORDER BY created_at DESC";
    const requests = await queryMany(query, params);
    res.json(requests);
  } catch (error) {
    console.error("Error fetching payment requests:", error);
    res.status(500).json({ error: "Failed to fetch payment requests" });
  }
});

// ─── GET /api/payments/requests/:id ──────────────────────────────────────────
router.get("/requests/:id", authorize("Investor"), async (req, res) => {
  try {
    const request = await queryOne("SELECT * FROM agrihub.payment_requests WHERE id = $1", [req.params.id]);
    if (!request) return res.status(404).json({ error: "Payment request not found" });
    
    if (request.investor_id !== req.user.id) {
      return res.status(403).json({ error: "Not authorized to view this payment request" });
    }
    
    res.json(request);
  } catch (error) {
    console.error("Error fetching payment request:", error);
    res.status(500).json({ error: "Failed to fetch payment request" });
  }
});

// ─── POST /api/payments/set-pin ───────────────────────────────────────────────
router.post("/set-pin", authenticate, async (req, res) => {
  try {
    const { pin } = req.body;
    
    if (!pin || !/^\d{4}$/.test(pin)) {
      return res.status(400).json({ error: "PIN must be 4 digits" });
    }

    const pinHash = bcrypt.hashSync(pin, 10);
    await pool.query("UPDATE agrihub.users SET pin_hash = $1, updated_at = NOW() WHERE id = $2", [pinHash, req.user.id]);
    
    await logAudit(
      req.user.id, 'pin_set', 'user', req.user.id, null, req,
      { pin_hash: null }, { pin_hash: '***' },
      null, null, null, null
    );
    
    res.json({ ok: true, message: "PIN set successfully" });
  } catch (err) {
    console.error("Set PIN error:", err);
    res.status(500).json({ error: "Failed to set PIN" });
  }
});

export default router;
