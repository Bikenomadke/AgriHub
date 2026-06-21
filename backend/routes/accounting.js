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

// Account types for double-entry accounting
const ACCOUNT_TYPES = {
  ASSET: 'asset',
  LIABILITY: 'liability',
  EQUITY: 'equity',
  REVENUE: 'revenue',
  EXPENSE: 'expense'
};

// Account codes
const ACCOUNT_CODES = {
  CASH: '1000',
  WALLET_BALANCE: '1100',
  ESCROW_HOLDINGS: '1200',
  ACCOUNTS_RECEIVABLE: '1300',
  ACCOUNTS_PAYABLE: '2000',
  INVESTOR_EQUITY: '3000',
  PLATFORM_REVENUE: '4000',
  PLATFORM_FEES: '5000',
  TRANSACTION_COSTS: '5100',
  FARMER_PAYMENTS: '5200'
};

// ─── Initialize accounting ledger tables if they don't exist ──────────────────
async function initializeAccountingTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agrihub.chart_of_accounts (
      code TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('asset','liability','equity','revenue','expense')),
      balance REAL DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS agrihub.journal_entries (
      id TEXT PRIMARY KEY,
      entry_number TEXT UNIQUE NOT NULL,
      date TIMESTAMPTZ NOT NULL,
      description TEXT,
      reference TEXT,
      status TEXT DEFAULT 'posted' CHECK(status IN ('draft','posted','void')),
      created_by TEXT REFERENCES agrihub.users(id),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS agrihub.ledger_entries (
      id TEXT PRIMARY KEY,
      journal_entry_id TEXT REFERENCES agrihub.journal_entries(id),
      account_code TEXT REFERENCES agrihub.chart_of_accounts(code),
      debit REAL DEFAULT 0,
      credit REAL DEFAULT 0,
      description TEXT,
      reference TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_journal_entries_date ON agrihub.journal_entries(date);
    CREATE INDEX IF NOT EXISTS idx_ledger_entries_journal ON agrihub.ledger_entries(journal_entry_id);
    CREATE INDEX IF NOT EXISTS idx_ledger_entries_account ON agrihub.ledger_entries(account_code);
  `);

  // Seed chart of accounts if empty
  const count = await queryOne("SELECT COUNT(*) as c FROM agrihub.chart_of_accounts");
  if (count.c === 0) {
    const accounts = [
      { code: ACCOUNT_CODES.CASH, name: 'Cash', type: ACCOUNT_TYPES.ASSET },
      { code: ACCOUNT_CODES.WALLET_BALANCE, name: 'Wallet Balances', type: ACCOUNT_TYPES.ASSET },
      { code: ACCOUNT_CODES.ESCROW_HOLDINGS, name: 'Escrow Holdings', type: ACCOUNT_TYPES.ASSET },
      { code: ACCOUNT_CODES.ACCOUNTS_RECEIVABLE, name: 'Accounts Receivable', type: ACCOUNT_TYPES.ASSET },
      { code: ACCOUNT_CODES.ACCOUNTS_PAYABLE, name: 'Accounts Payable', type: ACCOUNT_TYPES.LIABILITY },
      { code: ACCOUNT_CODES.INVESTOR_EQUITY, name: 'Investor Equity', type: ACCOUNT_TYPES.EQUITY },
      { code: ACCOUNT_CODES.PLATFORM_REVENUE, name: 'Platform Revenue', type: ACCOUNT_TYPES.REVENUE },
      { code: ACCOUNT_CODES.PLATFORM_FEES, name: 'Platform Fees', type: ACCOUNT_TYPES.REVENUE },
      { code: ACCOUNT_CODES.TRANSACTION_COSTS, name: 'Transaction Costs', type: ACCOUNT_TYPES.EXPENSE },
      { code: ACCOUNT_CODES.FARMER_PAYMENTS, name: 'Farmer Payments', type: ACCOUNT_TYPES.EXPENSE }
    ];

    for (const acc of accounts) {
      await pool.query("INSERT INTO agrihub.chart_of_accounts (code, name, type) VALUES ($1, $2, $3)", [acc.code, acc.name, acc.type]);
    }
  }
}

initializeAccountingTables();

// ─── POST /api/accounting/entry ───────────────────────────────────────────────
router.post("/entry", authorize("Admin"), async (req, res) => {
  try {
    const { description, reference, entries } = req.body;
    
    if (!entries || !Array.isArray(entries) || entries.length < 2) {
      return res.status(400).json({ error: "At least two ledger entries required for double-entry accounting" });
    }

    // Validate debits equal credits
    const totalDebit = entries.reduce((sum, e) => sum + (e.debit || 0), 0);
    const totalCredit = entries.reduce((sum, e) => sum + (e.credit || 0), 0);
    
    if (Math.abs(totalDebit - totalCredit) > 0.01) {
      return res.status(400).json({ error: "Debits must equal credits in double-entry accounting" });
    }

    await transaction(async (client) => {
      // Generate entry number
      const entryCount = await client.query("SELECT COUNT(*) as c FROM agrihub.journal_entries WHERE date >= date_trunc('month', NOW())");
      const entryNumber = `JE-${new Date().getFullYear()}${String(new Date().getMonth() + 1).padStart(2, '0')}-${String(entryCount.rows[0].c + 1).padStart(4, '0')}`;

      // Create journal entry
      const journalId = uuid();
      await client.query(
        `INSERT INTO agrihub.journal_entries (id, entry_number, date, description, reference, status, created_by)
        VALUES ($1, $2, NOW(), $3, $4, 'posted', $5)`,
        [journalId, entryNumber, description, reference, req.user.id]
      );

      // Create ledger entries
      for (const entry of entries) {
        if (!entry.account_code) {
          throw new Error("Account code required for each ledger entry");
        }

        const account = await client.query("SELECT * FROM agrihub.chart_of_accounts WHERE code = $1", [entry.account_code]);
        if (account.rows.length === 0) {
          throw new Error(`Account not found: ${entry.account_code}`);
        }

        const ledgerId = uuid();
        await client.query(
          `INSERT INTO agrihub.ledger_entries (id, journal_entry_id, account_code, debit, credit, description, reference)
          VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [ledgerId, journalId, entry.account_code, entry.debit || 0, entry.credit || 0, entry.description, reference]
        );

        // Update account balance
        const balanceChange = (entry.debit || 0) - (entry.credit || 0);
        const isAssetOrExpense = account.rows[0].type === ACCOUNT_TYPES.ASSET || account.rows[0].type === ACCOUNT_TYPES.EXPENSE;
        const newBalance = isAssetOrExpense 
          ? account.rows[0].balance + balanceChange 
          : account.rows[0].balance - balanceChange;

        await client.query("UPDATE agrihub.chart_of_accounts SET balance = $1 WHERE code = $2", [newBalance, entry.account_code]);
      }

      await logAudit(req.user.id, 'journal_entry_created', 'journal_entry', journalId, totalDebit, req, null, { entry_number: entryNumber, status: 'posted' }, null, null, null, null);

      return { journalId, entryNumber };
    });

    const journalEntry = await queryOne("SELECT * FROM agrihub.journal_entries WHERE id = $1", [req.params.journalId]);
    const ledgerEntries = await queryMany("SELECT * FROM agrihub.ledger_entries WHERE journal_entry_id = $1", [req.params.journalId]);

    res.status(201).json({ 
      journal_entry: journalEntry, 
      ledger_entries,
      entry_number: req.params.entryNumber 
    });
  } catch (err) {
    console.error("Accounting entry error:", err);
    res.status(500).json({ error: err.message || "Failed to create accounting entry" });
  }
});

// ─── GET /api/accounting/chart-of-accounts ────────────────────────────────────
router.get("/chart-of-accounts", authorize("Admin"), async (req, res) => {
  try {
    const accounts = await queryMany("SELECT * FROM agrihub.chart_of_accounts ORDER BY code");
    res.json(accounts);
  } catch (error) {
    console.error("Error fetching chart of accounts:", error);
    res.status(500).json({ error: "Failed to fetch chart of accounts" });
  }
});

// ─── GET /api/accounting/journal-entries ───────────────────────────────────────
router.get("/journal-entries", authorize("Admin"), async (req, res) => {
  try {
    const { start_date, end_date, status, limit = 50, offset = 0 } = req.query;
    
    let query = "SELECT * FROM agrihub.journal_entries WHERE 1=1";
    const params = [];
    let paramIndex = 1;
    
    if (start_date) {
      query += ` AND date >= $${paramIndex++}`;
      params.push(start_date);
    }
    if (end_date) {
      query += ` AND date <= $${paramIndex++}`;
      params.push(end_date);
    }
    if (status) {
      query += ` AND status = $${paramIndex++}`;
      params.push(status);
    }
    
    query += ` ORDER BY date DESC, entry_number DESC LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
    params.push(parseInt(limit), parseInt(offset));
    
    const entries = await queryMany(query, params);
    res.json(entries);
  } catch (error) {
    console.error("Error fetching journal entries:", error);
    res.status(500).json({ error: "Failed to fetch journal entries" });
  }
});

// ─── GET /api/accounting/journal-entries/:id ───────────────────────────────────
router.get("/journal-entries/:id", authorize("Admin"), async (req, res) => {
  try {
    const entry = await queryOne("SELECT * FROM agrihub.journal_entries WHERE id = $1", [req.params.id]);
    if (!entry) return res.status(404).json({ error: "Journal entry not found" });
    
    const ledgerEntries = await queryMany("SELECT * FROM agrihub.ledger_entries WHERE journal_entry_id = $1", [req.params.id]);
    res.json({ journal_entry: entry, ledger_entries });
  } catch (error) {
    console.error("Error fetching journal entry:", error);
    res.status(500).json({ error: "Failed to fetch journal entry" });
  }
});

// ─── GET /api/accounting/trial-balance ────────────────────────────────────────
router.get("/trial-balance", authorize("Admin"), async (req, res) => {
  try {
    const asOfDate = req.query.as_of_date || new Date().toISOString().split('T')[0];
    
    const accounts = await queryMany("SELECT * FROM agrihub.chart_of_accounts ORDER BY code");
    
    let totalDebits = 0;
    let totalCredits = 0;
    
    const trialBalance = accounts.map(acc => {
      const isAssetOrExpense = acc.type === ACCOUNT_TYPES.ASSET || acc.type === ACCOUNT_TYPES.EXPENSE;
      const debit = isAssetOrExpense ? Math.max(0, acc.balance) : 0;
      const credit = isAssetOrExpense ? 0 : Math.max(0, acc.balance);
      
      totalDebits += debit;
      totalCredits += credit;
      
      return {
        code: acc.code,
        name: acc.name,
        type: acc.type,
        debit,
        credit
      };
    });
    
    res.json({
      as_of_date: asOfDate,
      accounts: trialBalance,
      total_debits: totalDebits,
      total_credits: totalCredits,
      is_balanced: Math.abs(totalDebits - totalCredits) < 0.01
    });
  } catch (error) {
    console.error("Error fetching trial balance:", error);
    res.status(500).json({ error: "Failed to fetch trial balance" });
  }
});

// ─── GET /api/accounting/balance-sheet ─────────────────────────────────────────
router.get("/balance-sheet", authorize("Admin"), async (req, res) => {
  try {
    const asOfDate = req.query.as_of_date || new Date().toISOString().split('T')[0];
    
    const accounts = await queryMany("SELECT * FROM agrihub.chart_of_accounts ORDER BY code");
    
    const assets = accounts.filter(a => a.type === ACCOUNT_TYPES.ASSET);
    const liabilities = accounts.filter(a => a.type === ACCOUNT_TYPES.LIABILITY);
    const equity = accounts.filter(a => a.type === ACCOUNT_TYPES.EQUITY);
    
    const totalAssets = assets.reduce((sum, a) => sum + a.balance, 0);
    const totalLiabilities = liabilities.reduce((sum, a) => sum + a.balance, 0);
    const totalEquity = equity.reduce((sum, a) => sum + a.balance, 0);
    
    res.json({
      as_of_date: asOfDate,
      assets: {
        accounts: assets.map(a => ({ code: a.code, name: a.name, balance: a.balance })),
        total: totalAssets
      },
      liabilities: {
        accounts: liabilities.map(a => ({ code: a.code, name: a.name, balance: a.balance })),
        total: totalLiabilities
      },
      equity: {
        accounts: equity.map(a => ({ code: a.code, name: a.name, balance: a.balance })),
        total: totalEquity
      },
      total_liabilities_and_equity: totalLiabilities + totalEquity,
      is_balanced: Math.abs(totalAssets - (totalLiabilities + totalEquity)) < 0.01
    });
  } catch (error) {
    console.error("Error fetching balance sheet:", error);
    res.status(500).json({ error: "Failed to fetch balance sheet" });
  }
});

// ─── GET /api/accounting/income-statement ──────────────────────────────────────
router.get("/income-statement", authorize("Admin"), async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    
    const startDate = start_date || new Date(new Date().setMonth(new Date().getMonth() - 1)).toISOString().split('T')[0];
    const endDate = end_date || new Date().toISOString().split('T')[0];
    
    const accounts = await queryMany("SELECT * FROM agrihub.chart_of_accounts ORDER BY code");
    
    const revenue = accounts.filter(a => a.type === ACCOUNT_TYPES.REVENUE);
    const expenses = accounts.filter(a => a.type === ACCOUNT_TYPES.EXPENSE);
    
    const totalRevenue = revenue.reduce((sum, a) => sum + a.balance, 0);
    const totalExpenses = expenses.reduce((sum, a) => sum + a.balance, 0);
    const netIncome = totalRevenue - totalExpenses;
    
    res.json({
      period: { start_date: startDate, end_date: endDate },
      revenue: {
        accounts: revenue.map(a => ({ code: a.code, name: a.name, balance: a.balance })),
        total: totalRevenue
      },
      expenses: {
        accounts: expenses.map(a => ({ code: a.code, name: a.name, balance: a.balance })),
        total: totalExpenses
      },
      net_income: netIncome
    });
  } catch (error) {
    console.error("Error fetching income statement:", error);
    res.status(500).json({ error: "Failed to fetch income statement" });
  }
});

// ─── POST /api/accounting/auto-entry/payment ──────────────────────────────────
router.post("/auto-entry/payment", authorize("Admin"), async (req, res) => {
  try {
    const { transaction_id, farmer_payment, platform_fee, harvest_cost, transport_cost, pulling_cost, tax_amount } = req.body;
    
    if (!transaction_id) {
      return res.status(400).json({ error: "Transaction ID required" });
    }

    const transaction = await queryOne("SELECT * FROM agrihub.transactions WHERE id = $1", [transaction_id]);
    if (!transaction) return res.status(404).json({ error: "Transaction not found" });

    const entries = [
      // Debit: Farmer Payments (Expense)
      {
        account_code: ACCOUNT_CODES.FARMER_PAYMENTS,
        debit: farmer_payment || transaction.expected_payout,
        credit: 0,
        description: `Farmer payment for transaction ${transaction.ticket_number}`
      },
      // Credit: Wallet Balances (Asset)
      {
        account_code: ACCOUNT_CODES.WALLET_BALANCE,
        debit: 0,
        credit: farmer_payment || transaction.expected_payout,
        description: `Payment from investor wallet for transaction ${transaction.ticket_number}`
      }
    ];

    // Add platform fee if applicable
    if (platform_fee > 0) {
      entries.push({
        account_code: ACCOUNT_CODES.PLATFORM_FEES,
        debit: platform_fee,
        credit: 0,
        description: `Platform fee for transaction ${transaction.ticket_number}`
      });
      entries.push({
        account_code: ACCOUNT_CODES.PLATFORM_REVENUE,
        debit: 0,
        credit: platform_fee,
        description: `Platform revenue from transaction ${transaction.ticket_number}`
      });
    }

    // Add costs if applicable
    if (harvest_cost > 0) {
      entries.push({
        account_code: ACCOUNT_CODES.TRANSACTION_COSTS,
        debit: harvest_cost,
        credit: 0,
        description: `Harvest cost for transaction ${transaction.ticket_number}`
      });
    }
    if (transport_cost > 0) {
      entries.push({
        account_code: ACCOUNT_CODES.TRANSACTION_COSTS,
        debit: transport_cost,
        credit: 0,
        description: `Transport cost for transaction ${transaction.ticket_number}`
      });
    }
    if (pulling_cost > 0) {
      entries.push({
        account_code: ACCOUNT_CODES.TRANSACTION_COSTS,
        debit: pulling_cost,
        credit: 0,
        description: `Pulling cost for transaction ${transaction.ticket_number}`
      });
    }

    const response = await fetch(`${req.protocol}://${req.get('host')}/api/accounting/entry`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': req.get('Authorization')
      },
      body: JSON.stringify({
        description: `Auto-generated accounting entry for transaction ${transaction.ticket_number}`,
        reference: transaction_id,
        entries
      })
    });

    const data = await response.json();
    
    if (response.ok) {
      res.json(data);
    } else {
      res.status(response.status).json(data);
    }
  } catch (err) {
    console.error("Auto accounting entry error:", err);
    res.status(500).json({ error: "Failed to create auto accounting entry" });
  }
});

export default router;
