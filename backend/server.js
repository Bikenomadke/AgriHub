import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import config from "./utils/config.js";
import securityHeaders from "./middleware/security-headers.js";
import { auditMiddleware } from "./utils/audit-logger.js";
import pool, { queryOne } from "./db-postgres.js";
import { createMetricsServer, metricsMiddleware } from "./utils/metrics.js";

import authRoutes from "./routes/auth.js";
import fieldRoutes from "./routes/fields.js";
import transactionRoutes from "./routes/transactions.js";
import mpesaRoutes from "./routes/mpesa.js";
import reportRoutes from "./routes/reports.js";
import uploadRoutes from "./routes/upload.js";
import farmerRoutes from "./routes/farmers.js";
import walletRoutes from "./routes/wallets.js";
import paymentRoutes from "./routes/payments.js";
import escrowRoutes from "./routes/escrow.js";
import reconciliationRoutes from "./routes/reconciliation.js";
import adminRoutes from "./routes/admin.js";
import accountingRoutes from "./routes/accounting.js";
import analysisUnlockRoutes from "./routes/analysis-unlocks.js";
import userManagementRoutes from "./routes/user-management.js";
import billingRoutes from "./routes/billing.js";
import paymentQueueWorker from "./workers/paymentQueue.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = config.PORT;

// Trust proxy for rate limiting and IP resolution behind reverse proxy
app.set('trust proxy', 1);

// API Versioning
const apiVersions = {
  v1: express.Router(),
  v2: express.Router()
};

// Mount routes to versioned routers
apiVersions.v1.use("/auth", authRoutes);
apiVersions.v1.use("/fields", fieldRoutes);
apiVersions.v1.use("/transactions", transactionRoutes);
apiVersions.v1.use("/mpesa", mpesaRoutes);
apiVersions.v1.use("/reports", reportRoutes);
apiVersions.v1.use("/upload", uploadRoutes);
apiVersions.v1.use("/farmers", farmerRoutes);
apiVersions.v1.use("/wallets", walletRoutes);
apiVersions.v1.use("/payments", paymentRoutes);
apiVersions.v1.use("/escrow", escrowRoutes);
apiVersions.v1.use("/reconciliation", reconciliationRoutes);
apiVersions.v1.use("/admin", adminRoutes);
apiVersions.v1.use("/accounting", accountingRoutes);
apiVersions.v1.use("/analysis-unlocks", analysisUnlockRoutes);
apiVersions.v1.use("/user-management", userManagementRoutes);
apiVersions.v1.use("/billing", billingRoutes);

// v2 can have different implementations or deprecations
apiVersions.v2.use("/auth", authRoutes);
apiVersions.v2.use("/fields", fieldRoutes);
apiVersions.v2.use("/transactions", transactionRoutes);
apiVersions.v2.use("/mpesa", mpesaRoutes);
apiVersions.v2.use("/reports", reportRoutes);
apiVersions.v2.use("/upload", uploadRoutes);
apiVersions.v2.use("/farmers", farmerRoutes);
apiVersions.v2.use("/wallets", walletRoutes);
apiVersions.v2.use("/payments", paymentRoutes);
apiVersions.v2.use("/escrow", escrowRoutes);
apiVersions.v2.use("/reconciliation", reconciliationRoutes);
apiVersions.v2.use("/admin", adminRoutes);
apiVersions.v2.use("/accounting", accountingRoutes);
apiVersions.v2.use("/analysis-unlocks", analysisUnlockRoutes);
apiVersions.v2.use("/user-management", userManagementRoutes);
apiVersions.v2.use("/billing", billingRoutes);

// Rate limiting configuration
const limiter = rateLimit({
  windowMs: config.RATE_LIMIT_WINDOW_MS,
  max: config.RATE_LIMIT_MAX_REQUESTS,
  message: { error: "Too many requests, please try again later" },
  standardHeaders: true,
  legacyHeaders: false,
});

// Stricter rate limiting for authentication endpoints
const authLimiter = rateLimit({
  windowMs: config.RATE_LIMIT_WINDOW_MS,
  max: config.AUTH_RATE_LIMIT_MAX_REQUESTS,
  message: { error: "Too many login attempts, please try again later" },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(limiter);
app.use(cors({ 
  origin: config.ALLOWED_ORIGINS,
  credentials: true 
}));
app.use(securityHeaders);
app.use(auditMiddleware);
app.use(metricsMiddleware);
app.use(express.json());
app.use("/uploads", express.static(join(__dirname, "uploads")));

// Mount versioned API routes
app.use("/api/v1", apiVersions.v1);
app.use("/api/v2", apiVersions.v2);

// Legacy API routes (redirect to v1)
app.use("/api", (req, res, next) => {
  // Redirect legacy API calls to v1
  req.url = req.url.replace(/^\/api/, '/api/v1');
  next();
}, apiVersions.v1);

// Health check endpoint
app.get("/health", async (req, res) => {
  try {
    // Check database connectivity
    const dbStatus = await queryOne("SELECT 1") ? 'healthy' : 'unhealthy';
    
    // Get database stats
    const dbStats = await queryOne(`
      SELECT 
        (SELECT COUNT(*) FROM agrihub.users) as users,
        (SELECT COUNT(*) FROM agrihub.fields) as fields,
        (SELECT COUNT(*) FROM agrihub.transactions) as transactions,
        (SELECT COUNT(*) FROM agrihub.farmers) as farmers,
        (SELECT COUNT(*) FROM agrihub.sessions WHERE revoked_at IS NULL) as active_sessions
    `);
    
    const health = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      environment: config.NODE_ENV,
      version: '1.0.0',
      services: {
        database: dbStatus,
        api: 'healthy',
        paymentQueue: config.ENABLE_PAYMENT_QUEUE ? 'enabled' : 'disabled'
      },
      database: dbStats,
      memory: {
        used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
        rss: Math.round(process.memoryUsage().rss / 1024 / 1024)
      }
    };
    
    res.status(200).json(health);
  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      error: error.message
    });
  }
});

// Readiness check endpoint (for Kubernetes)
app.get("/ready", async (req, res) => {
  try {
    // Check if database is accessible
    await queryOne("SELECT 1");
    
    res.status(200).json({ status: 'ready' });
  } catch (error) {
    res.status(503).json({ status: 'not ready', error: error.message });
  }
});

// Liveness check endpoint (for Kubernetes)
app.get("/live", (req, res) => {
  res.status(200).json({ status: 'alive' });
});

app.get("/api/health", (req, res) => res.json({ ok: true, timestamp: new Date().toISOString() }));

// In production, serve the built frontend from dist/
const distPath = join(__dirname, "../dist");
app.use(express.static(distPath));
app.get("*", (req, res) => {
  if (req.path.startsWith("/api/") || req.path.startsWith("/uploads/")) return;
  res.sendFile(join(distPath, "index.html"));
});

app.listen(PORT, () => {
  console.log(`AgriHub backend running on http://localhost:${PORT}`);
  
  // Start payment queue worker
  if (process.env.ENABLE_PAYMENT_QUEUE !== 'false') {
    paymentQueueWorker.start();
    console.log("Payment queue worker started");
  }
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  paymentQueueWorker.stop();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT signal received: closing HTTP server');
  paymentQueueWorker.stop();
  process.exit(0);
});
