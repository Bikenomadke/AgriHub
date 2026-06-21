/**
 * Configuration and Secrets Management
 * 
 * This module provides strict validation for environment variables and secrets.
 * The application will fail to start if any required secret is missing.
 */

import dotenv from "dotenv";

// Load environment variables
dotenv.config();

/**
 * Required environment variables
 * Application will fail to start if any of these are missing
 */
const REQUIRED_SECRETS = [
  'JWT_SECRET',
  'ENCRYPTION_KEY',
  'PORT',
];

/**
 * Optional environment variables with defaults
 */
const OPTIONAL_SECRETS = {
  ALLOWED_ORIGINS: 'http://localhost:3000,http://localhost:4000',
  MPESA_CONSUMER_KEY: '',
  MPESA_CONSUMER_SECRET: '',
  MPESA_PASSKEY: '',
  MPESA_SHORTCODE: '174379',
  MPESA_ENV: 'sandbox',
  ENABLE_PAYMENT_QUEUE: 'true',
  SUPABASE_URL: 'https://lykcuuxsplszplkoqlao.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_sWFd-3SM9f-aBvtGCKzYZg_x45ooUCU',
  SUPABASE_SERVICE_ROLE_KEY: '',
};

/**
 * Validate that a secret meets minimum security requirements
 */
function validateSecret(secret, name) {
  if (!secret || secret.trim() === '') {
    throw new Error(`Required secret '${name}' is missing or empty`);
  }

  // Specific validations for known secrets
  if (name === 'JWT_SECRET') {
    if (secret.length < 32) {
      throw new Error(`JWT_SECRET must be at least 32 characters long for security`);
    }
    if (secret === 'agrihub-super-secret-key-change-in-production') {
      throw new Error(`JWT_SECRET is using the default value. Please generate a strong secret using: node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"`);
    }
    if (secret === 'CHANGE_THIS_TO_A_STRONG_256_BIT_RANDOM_SECRET_GENERATED_USING_CRYPTO') {
      throw new Error(`JWT_SECRET is using the placeholder value. Please generate a strong secret using: node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"`);
    }
  }

  if (name === 'ENCRYPTION_KEY') {
    if (secret.length !== 64) {
      throw new Error(`ENCRYPTION_KEY must be exactly 64 hex characters (256 bits). Generate using: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`);
    }
    if (!/^[0-9a-fA-F]{64}$/.test(secret)) {
      throw new Error(`ENCRYPTION_KEY must be a valid 64-character hex string`);
    }
  }

  if (name === 'DEFAULT_ADMIN_PASSWORD') {
    if (secret === 'CHANGE_THIS_PASSWORD_IMMEDIATELY') {
      console.warn('WARNING: DEFAULT_ADMIN_PASSWORD is using the placeholder value. Please change it immediately.');
    }
    if (secret.length < 12) {
      console.warn('WARNING: DEFAULT_ADMIN_PASSWORD should be at least 12 characters long');
    }
  }

  return true;
}

/**
 * Validate all required secrets
 */
function validateRequiredSecrets() {
  const missing = [];
  const invalid = [];

  for (const secretName of REQUIRED_SECRETS) {
    const value = process.env[secretName];
    try {
      validateSecret(value, secretName);
    } catch (error) {
      if (error.message.includes('missing') || error.message.includes('empty')) {
        missing.push(secretName);
      } else {
        invalid.push({ name: secretName, error: error.message });
      }
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `CRITICAL: Application cannot start. Missing required secrets:\n` +
      `  ${missing.join('\n  ')}\n\n` +
      `Please set these environment variables before starting the application.`
    );
  }

  if (invalid.length > 0) {
    throw new Error(
      `CRITICAL: Application cannot start. Invalid secrets:\n` +
      invalid.map(i => `  ${i.name}: ${i.error}`).join('\n')
    );
  }

  console.log('✓ All required secrets validated successfully');
}

/**
 * Get configuration value with validation
 */
function getConfig(key, defaultValue = null) {
  const value = process.env[key];
  
  if (value !== undefined && value !== null && value !== '') {
    return value;
  }
  
  if (defaultValue !== null) {
    return defaultValue;
  }
  
  throw new Error(`Configuration key '${key}' is missing and no default was provided`);
}

/**
 * Get boolean configuration value
 */
function getBooleanConfig(key, defaultValue = false) {
  const value = process.env[key];
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }
  return value.toLowerCase() === 'true';
}

/**
 * Get numeric configuration value
 */
function getNumericConfig(key, defaultValue = null) {
  const value = process.env[key];
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }
  const num = parseInt(value, 10);
  if (isNaN(num)) {
    throw new Error(`Configuration key '${key}' must be a number, got '${value}'`);
  }
  return num;
}

/**
 * Get array configuration value (comma-separated)
 */
function getArrayConfig(key, defaultValue = []) {
  const value = process.env[key];
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }
  return value.split(',').map(item => item.trim()).filter(item => item !== '');
}

/**
 * Validate configuration on module load
 */
validateRequiredSecrets();

/**
 * Export configuration object
 */
const config = {
  // Server
  PORT: getNumericConfig('PORT', 4000),
  NODE_ENV: getConfig('NODE_ENV', 'development'),
  
  // Security
  JWT_SECRET: getConfig('JWT_SECRET'),
  JWT_ACCESS_EXPIRY: '15m',
  JWT_REFRESH_EXPIRY: '7d',
  ENCRYPTION_KEY: getConfig('ENCRYPTION_KEY'),
  
  // CORS
  ALLOWED_ORIGINS: getArrayConfig('ALLOWED_ORIGINS', ['http://localhost:3000', 'http://localhost:4000']),
  
  // Default User
  DEFAULT_ADMIN_PASSWORD: getConfig('DEFAULT_ADMIN_PASSWORD', 'CHANGE_THIS_PASSWORD_IMMEDIATELY'),
  
  // M-Pesa
  MPESA_CONSUMER_KEY: getConfig('MPESA_CONSUMER_KEY', ''),
  MPESA_CONSUMER_SECRET: getConfig('MPESA_CONSUMER_SECRET', ''),
  MPESA_PASSKEY: getConfig('MPESA_PASSKEY', ''),
  MPESA_SHORTCODE: getConfig('MPESA_SHORTCODE', '174379'),
  MPESA_ENV: getConfig('MPESA_ENV', 'sandbox'),
  
  // Features
  ENABLE_PAYMENT_QUEUE: getBooleanConfig('ENABLE_PAYMENT_QUEUE', true),

  // Supabase Auth
  SUPABASE_URL: getConfig('SUPABASE_URL', OPTIONAL_SECRETS.SUPABASE_URL),
  SUPABASE_ANON_KEY: getConfig('SUPABASE_ANON_KEY', OPTIONAL_SECRETS.SUPABASE_ANON_KEY),
  SUPABASE_SERVICE_ROLE_KEY: getConfig('SUPABASE_SERVICE_ROLE_KEY', OPTIONAL_SECRETS.SUPABASE_SERVICE_ROLE_KEY),
  
  // Rate Limiting
  RATE_LIMIT_WINDOW_MS: 15 * 60 * 1000, // 15 minutes
  RATE_LIMIT_MAX_REQUESTS: 100,
  AUTH_RATE_LIMIT_MAX_REQUESTS: 5,
  
  // Account Lockout
  ACCOUNT_LOCKOUT_ATTEMPTS: 5,
  ACCOUNT_LOCKOUT_DURATION_MS: 15 * 60 * 1000, // 15 minutes
};

export default config;
export { validateRequiredSecrets, getConfig, getBooleanConfig, getNumericConfig, getArrayConfig };
