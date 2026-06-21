import { queryOne } from "../db-postgres.js";

// Middleware to check if user has active subscription
export async function requireSubscription(req, res, next) {
  try {
    const userId = req.user.id;
    const userRole = req.user.role;

    // Skip subscription check for admins
    if (userRole === 'Admin') {
      return next();
    }

    // Check if user has active subscription
    const subscription = await queryOne(
      `SELECT * FROM agrihub.user_subscriptions 
       WHERE user_id = $1 AND status = 'active' AND expires_at > NOW()
       ORDER BY expires_at DESC LIMIT 1`,
      [userId]
    );

    if (!subscription) {
      return res.status(403).json({ 
        error: "Active subscription required",
        message: "Please purchase a subscription to continue"
      });
    }

    // Attach subscription to request for use in routes
    req.subscription = subscription;
    next();
  } catch (error) {
    console.error("Subscription check error:", error);
    res.status(500).json({ error: "Failed to verify subscription" });
  }
}

// Middleware to check if user is a trader
export function requireTrader(req, res, next) {
  const userRole = req.user.role;

  if (userRole !== 'Trader' && userRole !== 'Weighbridge Trader') {
    return res.status(403).json({ 
      error: "Trader access required",
      message: "This feature is only available to traders"
    });
  }

  next();
}

// Middleware to check if user has paid outstanding invoices
export async function requireNoOutstandingInvoices(req, res, next) {
  try {
    const userId = req.user.id;

    // Check for unpaid invoices
    const unpaidInvoices = await queryOne(
      `SELECT COUNT(*) as count FROM agrihub.trader_invoices 
       WHERE user_id = $1 AND status = 'pending'`,
      [userId]
    );

    if (unpaidInvoices.count > 0) {
      return res.status(403).json({ 
        error: "Outstanding invoices",
        message: "Please pay your outstanding invoices before continuing"
      });
    }

    next();
  } catch (error) {
    console.error("Invoice check error:", error);
    res.status(500).json({ error: "Failed to check invoice status" });
  }
}
