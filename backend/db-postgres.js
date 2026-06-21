import { Pool } from "pg";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import config from "./utils/config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// PostgreSQL connection pool configuration
const pool = new Pool({
  host: process.env.DB_HOST || "localhost",
  port: parseInt(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME || "agrihub",
  user: process.env.DB_USER || "agrihub",
  password: process.env.DB_PASSWORD,
  min: parseInt(process.env.DB_POOL_MIN) || 2,
  max: parseInt(process.env.DB_POOL_MAX) || 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
  ssl: process.env.DB_SSL_MODE === "require" ? { rejectUnauthorized: false } : false,
});

// Initialize database schema on startup
export async function initializeSchema() {
  try {
    // Check if tables actually exist (not just the schema)
    const schemaCheck = await pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'agrihub' AND table_name = 'users'`
    );

    if (schemaCheck.rows.length === 0) {
      console.log('Schema not found — running full migration from schema-postgresql.sql...');
      const sqlFile = path.join(__dirname, 'schema-postgresql.sql');
      const sql = fs.readFileSync(sqlFile, 'utf8');
      await pool.query(sql);
      console.log('✓ Database schema and tables created successfully!');
    } else {
      console.log('✓ Database schema already exists — skipping migration.');
    }
  } catch (error) {
    console.error('✗ Schema initialization error:', error.message);
    // Don't exit - allow the app to continue
  }
}

// Test connection on startup
pool.on('connect', () => {
  console.log('✓ PostgreSQL connection established');
});

pool.on('error', (err) => {
  console.error('✗ PostgreSQL connection error:', err);
  process.exit(-1);
});

// Helper function to execute queries
export async function query(text, params) {
  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    const duration = Date.now() - start;
    console.log('Executed query', { text: text.substring(0, 50), duration, rows: result.rowCount });
    return result;
  } catch (error) {
    console.error('Query error:', error);
    throw error;
  }
}

// Helper function to get a single row
export async function queryOne(text, params) {
  const result = await query(text, params);
  return result.rows[0] || null;
}

// Helper function to get multiple rows
export async function queryMany(text, params) {
  const result = await query(text, params);
  return result.rows;
}

// Helper function to execute a transaction
export async function transaction(callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// Health check function
export async function healthCheck() {
  try {
    const result = await pool.query('SELECT NOW()');
    return { status: 'healthy', timestamp: result.rows[0].now };
  } catch (error) {
    return { status: 'unhealthy', error: error.message };
  }
}

// Get database statistics
export async function getStats() {
  try {
    const result = await pool.query(`
      SELECT 
        (SELECT COUNT(*) FROM agrihub.users) as users,
        (SELECT COUNT(*) FROM agrihub.fields) as fields,
        (SELECT COUNT(*) FROM agrihub.transactions) as transactions,
        (SELECT COUNT(*) FROM agrihub.farmers) as farmers,
        (SELECT COUNT(*) FROM agrihub.sessions WHERE revoked_at IS NULL) as active_sessions
    `);
    return result.rows[0];
  } catch (error) {
    console.error('Failed to get stats:', error);
    return null;
  }
}

// Graceful shutdown
export async function closePool() {
  try {
    await pool.end();
    console.log('✓ PostgreSQL connection pool closed');
  } catch (error) {
    console.error('✗ Error closing connection pool:', error);
  }
}

// Export the pool for advanced use cases
export default pool;
