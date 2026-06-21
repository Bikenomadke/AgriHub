import pool, { queryOne, queryMany } from "../db-postgres.js";
import { v4 as uuid } from "uuid";

// ─── Payment Queue Worker ───────────────────────────────────────────────────────
class PaymentQueueWorker {
  constructor() {
    this.isRunning = false;
    this.interval = null;
    this.processingInterval = 5000; // 5 seconds
  }

  start() {
    if (this.isRunning) {
      console.log("Payment queue worker already running");
      return;
    }

    this.isRunning = true;
    console.log("Starting payment queue worker...");

    this.interval = setInterval(() => {
      this.processQueue();
    }, this.processingInterval);

    // Process immediately on start
    this.processQueue();
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.isRunning = false;
    console.log("Payment queue worker stopped");
  }

  async processQueue() {
    try {
      // Get queued items that are ready to process
      const now = new Date().toISOString();
      const queuedItems = await queryMany(`
        SELECT * FROM agrihub.payment_queue 
        WHERE status = 'queued' 
        AND (scheduled_at IS NULL OR scheduled_at <= $1)
        ORDER BY priority DESC, created_at ASC 
        LIMIT 10
      `, [now]);

      if (queuedItems.length === 0) {
        return;
      }

      console.log(`Processing ${queuedItems.length} queued payment items`);

      for (const item of queuedItems) {
        await this.processQueueItem(item);
      }
    } catch (err) {
      console.error("Error processing payment queue:", err);
    }
  }

  async processQueueItem(item) {
    try {
      // Mark as processing
      await pool.query(
        `UPDATE agrihub.payment_queue 
        SET status = 'processing', started_at = NOW(), updated_at = NOW()
        WHERE id = $1`,
        [item.id]
      );

      // Get payment request details
      const paymentRequest = await queryOne("SELECT * FROM agrihub.payment_requests WHERE id = $1", [item.payment_request_id]);
      if (!paymentRequest) {
        throw new Error("Payment request not found");
      }

      // Get farmer details
      const farmer = await queryOne("SELECT * FROM agrihub.farmers WHERE id = $1", [paymentRequest.farmer_id]);
      if (!farmer) {
        throw new Error("Farmer not found");
      }

      // Get transaction details
      const transaction = await queryOne("SELECT * FROM agrihub.transactions WHERE id = $1", [paymentRequest.transaction_id]);
      if (!transaction) {
        throw new Error("Transaction not found");
      }

      // Check if already processed (idempotency)
      if (transaction.payment_status === 'completed') {
        await pool.query(
          `UPDATE agrihub.payment_queue 
          SET status = 'completed', completed_at = NOW(), updated_at = NOW()
          WHERE id = $1`,
          [item.id]
        );
        return;
      }

      // Initiate M-Pesa payment
      const mpesaResult = await this.initiateMpesaPayment(farmer.mpesa_phone, paymentRequest.net_amount, transaction.id, paymentRequest.id);

      if (mpesaResult.success) {
        await pool.query(
          `UPDATE agrihub.payment_queue 
          SET status = 'completed', completed_at = NOW(), updated_at = NOW()
          WHERE id = $1`,
          [item.id]
        );

        await pool.query(
          `UPDATE agrihub.payment_requests 
          SET status = 'processing', updated_at = NOW()
          WHERE id = $1`,
          [paymentRequest.id]
        );
      } else {
        throw new Error(mpesaResult.error || "M-Pesa payment failed");
      }

    } catch (err) {
      console.error(`Error processing queue item ${item.id}:`, err);

      const retryCount = item.retry_count + 1;
      const maxRetries = item.max_retries || 3;

      if (retryCount < maxRetries) {
        // Schedule for retry with exponential backoff
        const backoffSeconds = Math.pow(2, retryCount) * 30; // 30s, 60s, 120s
        const scheduledAt = new Date(Date.now() + backoffSeconds * 1000).toISOString();

        await pool.query(
          `UPDATE agrihub.payment_queue 
          SET status = 'retry', 
              retry_count = $1, 
              error_message = $2,
              scheduled_at = $3,
              updated_at = NOW()
          WHERE id = $4`,
          [retryCount, err.message, scheduledAt, item.id]
        );

        console.log(`Queue item ${item.id} scheduled for retry ${retryCount}/${maxRetries} in ${backoffSeconds}s`);
      } else {
        // Mark as failed after max retries
        await pool.query(
          `UPDATE agrihub.payment_queue 
          SET status = 'failed', 
              retry_count = $1,
              error_message = $2,
              completed_at = NOW(),
              updated_at = NOW()
          WHERE id = $3`,
          [retryCount, err.message, item.id]
        );

        // Update payment request to failed
        await pool.query(
          `UPDATE agrihub.payment_requests 
          SET status = 'failed', updated_at = NOW()
          WHERE id = $1`,
          [item.payment_request_id]
        );

        console.error(`Queue item ${item.id} failed after ${maxRetries} retries`);
      }
    }
  }

  async initiateMpesaPayment(phone, amount, transactionId, paymentRequestId) {
    try {
      // Check if we have real M-Pesa credentials
      const hasRealCredentials = process.env.MPESA_CONSUMER_KEY && 
                                process.env.MPESA_CONSUMER_KEY !== "your_consumer_key_here";

      if (hasRealCredentials) {
        // Use real M-Pesa API
        return await this.realMpesaPayment(phone, amount, transactionId, paymentRequestId);
      } else {
        // Use simulated payment
        return await this.simulatedMpesaPayment(phone, amount, transactionId, paymentRequestId);
      }
    } catch (err) {
      console.error("M-Pesa payment initiation error:", err);
      return { success: false, error: err.message };
    }
  }

  async realMpesaPayment(phone, amount, transactionId, paymentRequestId) {
    const key = process.env.MPESA_CONSUMER_KEY;
    const secret = process.env.MPESA_CONSUMER_SECRET;
    const auth = Buffer.from(`${key}:${secret}`).toString("base64");
    const env = process.env.MPESA_ENV === "production"
      ? "https://api.safaricom.co.ke"
      : "https://sandbox.safaricom.co.ke";

    // Get access token
    const tokenResponse = await fetch(`${env}/oauth/v1/generate?grant_type=client_credentials`, {
      headers: { Authorization: `Basic ${auth}` },
    });
    const tokenData = await tokenResponse.json();
    const token = tokenData.access_token;

    // Format phone number
    const formattedPhone = phone.replace(/\D/g, "");
    const kenyaPhone = formattedPhone.startsWith("0") 
      ? "254" + formattedPhone.slice(1) 
      : formattedPhone.startsWith("254") && formattedPhone.length === 12 
        ? formattedPhone 
        : formattedPhone;

    // Generate password
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
      PartyA: kenyaPhone,
      PartyB: shortcode,
      PhoneNumber: kenyaPhone,
      CallBackURL: callbackUrl,
      AccountReference: `AGRIHUB-${transactionId.slice(0, 8)}`,
      TransactionDesc: "AgriHub Farmer Payout",
    };

    const response = await fetch(`${env}/mpesa/stkpush/v1/processrequest`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const data = await response.json();

    // Record M-Pesa transaction
    const mpesaTxnId = uuid();
    await pool.query(
      `INSERT INTO agrihub.mpesa_transactions (id, transaction_id, payment_request_id, transaction_type, phone, amount, merchant_request_id, checkout_request_id, response_code, response_description, status)
      VALUES ($1, $2, $3, 'stk_push', $4, $5, $6, $7, $8, $9, 'pending')`,
      [
        mpesaTxnId, transactionId, paymentRequestId, kenyaPhone, amount,
        data.MerchantRequestID, data.CheckoutRequestID,
        data.ResponseCode, data.ResponseDescription
      ]
    );

    if (data.ResponseCode === "0") {
      return { success: true, mpesa_transaction_id: mpesaTxnId };
    } else {
      return { success: false, error: data.ResponseDescription };
    }
  }

  async simulatedMpesaPayment(phone, amount, transactionId, paymentRequestId) {
    // Simulate M-Pesa payment with delay
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Record simulated M-Pesa transaction
    const mpesaTxnId = uuid();
    await pool.query(
      `INSERT INTO agrihub.mpesa_transactions (id, transaction_id, payment_request_id, transaction_type, phone, amount, result_code, result_description, status)
      VALUES ($1, $2, $3, 'stk_push', $4, $5, '0', 'Simulated payment successful', 'completed')`,
      [mpesaTxnId, transactionId, paymentRequestId, phone, amount]
    );

    // Update transaction as completed
    const mpesaReceipt = "MP" + Date.now().toString(36).toUpperCase();
    await pool.query(
      `UPDATE agrihub.transactions 
      SET payment_status = 'completed', 
          payment_method = 'M-Pesa', 
          payment_phone = $1, 
          payment_amount = $2, 
          payment_reference = $3, 
          payment_date = NOW(),
          updated_at = NOW()
      WHERE id = $4`,
      [phone, amount, mpesaReceipt, transactionId]
    );

    // Update field status
    await pool.query(
      `UPDATE agrihub.fields 
      SET status = 'paid', updated_at = NOW()
      WHERE id IN (SELECT field_id FROM agrihub.transactions WHERE id = $1)`,
      [transactionId]
    );

    return { success: true, mpesa_transaction_id: mpesaTxnId, simulated: true };
  }

  // Add item to queue
  static async enqueue(paymentRequestId, priority = 0, scheduledAt = null) {
    const id = uuid();
    await pool.query(
      `INSERT INTO agrihub.payment_queue (id, payment_request_id, priority, status, scheduled_at, created_at)
      VALUES ($1, $2, $3, 'queued', $4, NOW())`,
      [id, paymentRequestId, priority, scheduledAt || null]
    );
    return id;
  }

  // Get queue status
  static async getQueueStatus() {
    const status = await queryOne(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) as queued,
        SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) as processing,
        SUM(CASE WHEN status = 'retry' THEN 1 ELSE 0 END) as retry,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
      FROM agrihub.payment_queue
    `);

    const recentItems = await queryMany(`
      SELECT pq.*, pr.amount, pr.status as payment_status
      FROM agrihub.payment_queue pq
      LEFT JOIN agrihub.payment_requests pr ON pq.payment_request_id = pr.id
      ORDER BY pq.created_at DESC LIMIT 20
    `);

    return { status, recent_items: recentItems };
  }

  // Clear completed items older than specified days
  static async clearOldCompleted(days = 7) {
    const cutoffDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const result = await pool.query(
      `DELETE FROM agrihub.payment_queue 
      WHERE status = 'completed' AND completed_at < $1`,
      [cutoffDate]
    );
    return result.rowCount;
  }
}

// Export singleton instance
const paymentQueueWorker = new PaymentQueueWorker();

export default paymentQueueWorker;
