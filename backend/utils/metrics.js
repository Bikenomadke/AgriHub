/**
 * Metrics and Monitoring Utility
 * 
 * This module provides Prometheus metrics and OpenTelemetry instrumentation:
 * - HTTP request metrics
 * - Database query metrics
 * - Business metrics (transactions, payments, etc.)
 * - System metrics (memory, CPU)
 * - Custom metrics for security events
 */

import promClient from 'prom-client';
import { queryMany } from '../db-postgres.js';

// Create a Registry to register the metrics
const register = new promClient.Registry();

// Enable default metrics (CPU, memory, etc.)
promClient.collectDefaultMetrics({ register });

// HTTP Request Metrics
const httpRequestDuration = new promClient.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]
});

const httpRequestTotal = new promClient.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code']
});

const httpRequestInProgress = new promClient.Gauge({
  name: 'http_requests_in_progress',
  help: 'Number of HTTP requests currently in progress',
  labelNames: ['method', 'route']
});

// Database Metrics
const dbQueryDuration = new promClient.Histogram({
  name: 'db_query_duration_seconds',
  help: 'Duration of database queries in seconds',
  labelNames: ['operation', 'table'],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1]
});

const dbQueryTotal = new promClient.Counter({
  name: 'db_queries_total',
  help: 'Total number of database queries',
  labelNames: ['operation', 'table', 'status']
});

// Business Metrics
const transactionTotal = new promClient.Counter({
  name: 'transactions_total',
  help: 'Total number of transactions',
  labelNames: ['status', 'payment_method']
});

const paymentTotal = new promClient.Counter({
  name: 'payments_total',
  help: 'Total number of payments',
  labelNames: ['status', 'method']
});

const farmerRegistrationTotal = new promClient.Counter({
  name: 'farmer_registrations_total',
  help: 'Total number of farmer registrations',
  labelNames: ['verification_status']
});

// Security Metrics
const authFailuresTotal = new promClient.Counter({
  name: 'auth_failures_total',
  help: 'Total number of authentication failures',
  labelNames: ['reason']
});

const rateLimitHitsTotal = new promClient.Counter({
  name: 'rate_limit_hits_total',
  help: 'Total number of rate limit violations',
  labelNames: ['endpoint']
});

const authorizationDenialsTotal = new promClient.Counter({
  name: 'authorization_denials_total',
  help: 'Total number of authorization denials',
  labelNames: ['role', 'permission']
});

// Session Metrics
const activeSessions = new promClient.Gauge({
  name: 'active_sessions',
  help: 'Number of currently active sessions',
  labelNames: ['role']
});

// M-Pesa Metrics
const mpesaRequestTotal = new promClient.Counter({
  name: 'mpesa_requests_total',
  help: 'Total number of M-Pesa API requests',
  labelNames: ['operation', 'status']
});

const mpesaRequestDuration = new promClient.Histogram({
  name: 'mpesa_request_duration_seconds',
  help: 'Duration of M-Pesa API requests in seconds',
  labelNames: ['operation'],
  buckets: [0.5, 1, 2, 5, 10, 30, 60]
});

// Register all metrics
register.registerMetric(httpRequestDuration);
register.registerMetric(httpRequestTotal);
register.registerMetric(httpRequestInProgress);
register.registerMetric(dbQueryDuration);
register.registerMetric(dbQueryTotal);
register.registerMetric(transactionTotal);
register.registerMetric(paymentTotal);
register.registerMetric(farmerRegistrationTotal);
register.registerMetric(authFailuresTotal);
register.registerMetric(rateLimitHitsTotal);
register.registerMetric(authorizationDenialsTotal);
register.registerMetric(activeSessions);
register.registerMetric(mpesaRequestTotal);
register.registerMetric(mpesaRequestDuration);

// Middleware to track HTTP requests
export function metricsMiddleware(req, res, next) {
  const start = Date.now();
  const method = req.method;
  const route = req.route ? req.route.path : req.path;
  
  httpRequestInProgress.inc({ method, route });
  
  res.on('finish', () => {
    const duration = (Date.now() - start) / 1000;
    const statusCode = res.statusCode;
    
    httpRequestDuration.observe({ method, route, status_code: statusCode }, duration);
    httpRequestTotal.inc({ method, route, status_code: statusCode });
    
    httpRequestInProgress.dec({ method, route });
  });
  
  next();
}

// Track database queries
export function trackDbQuery(operation, table) {
  const start = Date.now();
  
  return {
    end: (status = 'success') => {
      const duration = (Date.now() - start) / 1000;
      dbQueryDuration.observe({ operation, table }, duration);
      dbQueryTotal.inc({ operation, table, status });
    }
  };
}

// Track business events
export function trackTransaction(status, paymentMethod) {
  transactionTotal.inc({ status, payment_method: paymentMethod });
}

export function trackPayment(status, method) {
  paymentTotal.inc({ status, method });
}

export function trackFarmerRegistration(verificationStatus) {
  farmerRegistrationTotal.inc({ verification_status: verificationStatus });
}

// Track security events
export function trackAuthFailure(reason) {
  authFailuresTotal.inc({ reason });
}

export function trackRateLimitHit(endpoint) {
  rateLimitHitsTotal.inc({ endpoint });
}

export function trackAuthorizationDenial(role, permission) {
  authorizationDenialsTotal.inc({ role, permission });
}

// Update session metrics
export async function updateSessionMetrics() {
  try {
    const sessions = await queryMany(`
      SELECT role, COUNT(*) as count
      FROM agrihub.sessions s
      JOIN agrihub.users u ON s.user_id = u.id
      WHERE s.revoked_at IS NULL AND s.expires_at > NOW()
      GROUP BY role
    `);
    
    // Reset gauge
    activeSessions.reset();
    
    // Set new values
    for (const session of sessions) {
      activeSessions.set({ role: session.role }, session.count);
    }
  } catch (error) {
    console.error('Failed to update session metrics:', error.message);
  }
}

// Track M-Pesa requests
export function trackMpesaRequest(operation, status, duration) {
  mpesaRequestTotal.inc({ operation, status });
  if (duration) {
    mpesaRequestDuration.observe({ operation }, duration);
  }
}

// Create metrics server
export function createMetricsServer(port = 9090) {
  const express = require('express');
  const app = express();
  
  app.get('/metrics', async (req, res) => {
    try {
      // Update dynamic metrics before serving
      updateSessionMetrics();
      
      res.set('Content-Type', register.contentType);
      res.end(await register.metrics());
    } catch (error) {
      res.status(500).end(error.message);
    }
  });
  
  return app.listen(port, () => {
    console.log(`Metrics server listening on port ${port}`);
  });
}

// Export metrics for external use
export {
  register,
  httpRequestDuration,
  httpRequestTotal,
  dbQueryDuration,
  dbQueryTotal,
  transactionTotal,
  paymentTotal,
  authFailuresTotal,
  rateLimitHitsTotal,
  authorizationDenialsTotal,
  activeSessions,
  mpesaRequestTotal,
  mpesaRequestDuration,
};

export default {
  register,
  metricsMiddleware,
  trackDbQuery,
  trackTransaction,
  trackPayment,
  trackFarmerRegistration,
  trackAuthFailure,
  trackRateLimitHit,
  trackAuthorizationDenial,
  updateSessionMetrics,
  trackMpesaRequest,
  createMetricsServer,
};
