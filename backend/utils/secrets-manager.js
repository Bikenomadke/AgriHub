/**
 * Secrets Manager Abstraction
 * 
 * This module provides an abstraction layer for secrets management:
 * - Development: Environment variables (.env)
 * - Production: Cloud secrets managers (AWS Secrets Manager, Azure Key Vault, GCP Secret Manager)
 * 
 * Features:
 * - Unified API for secret retrieval
 * - Automatic secret rotation support
 * - Caching for performance
 * - Fallback mechanisms
 */

import config from "./config.js";

/**
 * Secrets Manager Type
 */
const SECRETS_MANAGER_TYPE = process.env.SECRETS_MANAGER_TYPE || 'env';

/**
 * Cache for secrets (TTL: 5 minutes)
 */
const secretCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Get secret from cache if available and not expired
 */
function getCachedSecret(key) {
  const cached = secretCache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.value;
  }
  return null;
}

/**
 * Set secret in cache
 */
function setCachedSecret(key, value) {
  secretCache.set(key, {
    value,
    timestamp: Date.now()
  });
}

/**
 * Clear secret cache
 */
function clearSecretCache(key) {
  if (key) {
    secretCache.delete(key);
  } else {
    secretCache.clear();
  }
}

/**
 * Get secret from environment variables
 */
async function getSecretFromEnv(key) {
  return process.env[key] || null;
}

/**
 * Get secret from AWS Secrets Manager
 */
async function getSecretFromAWS(key) {
  try {
    // AWS SDK v3
    const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
    
    const client = new SecretsManagerClient({
      region: process.env.AWS_REGION || 'us-east-1'
    });
    
    const command = new GetSecretValueCommand({
      SecretId: key
    });
    
    const response = await client.send(command);
    
    if (response.SecretString) {
      return response.SecretString;
    } else if (response.SecretBinary) {
      return Buffer.from(response.SecretBinary).toString('utf-8');
    }
    
    return null;
  } catch (error) {
    console.error(`Failed to get secret from AWS Secrets Manager: ${error.message}`);
    // Fallback to environment variables
    return getSecretFromEnv(key);
  }
}

/**
 * Get secret from Azure Key Vault
 */
async function getSecretFromAzure(key) {
  try {
    // Azure SDK
    const { SecretClient } = await import('@azure/keyvault-secrets');
    
    const vaultUrl = process.env.AZURE_KEY_VAULT_URL;
    if (!vaultUrl) {
      throw new Error('AZURE_KEY_VAULT_URL not set');
    }
    
    const credential = await getAzureCredential();
    const client = new SecretClient(vaultUrl, credential);
    
    const secret = await client.getSecret(key);
    return secret.value;
  } catch (error) {
    console.error(`Failed to get secret from Azure Key Vault: ${error.message}`);
    // Fallback to environment variables
    return getSecretFromEnv(key);
  }
}

/**
 * Get Azure credential
 */
async function getAzureCredential() {
  const { DefaultAzureCredential } = await import('@azure/identity');
  return new DefaultAzureCredential();
}

/**
 * Get secret from GCP Secret Manager
 */
async function getSecretFromGCP(key) {
  try {
    // GCP SDK
    const { SecretManagerServiceClient } = await import('@google-cloud/secret-manager');
    
    const client = new SecretManagerServiceClient();
    const projectId = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT_ID;
    const secretName = `projects/${projectId}/secrets/${key}/versions/latest`;
    
    const [version] = await client.accessSecretVersion({
      name: secretName
    });
    
    return version.payload.data.toString('utf-8');
  } catch (error) {
    console.error(`Failed to get secret from GCP Secret Manager: ${error.message}`);
    // Fallback to environment variables
    return getSecretFromEnv(key);
  }
}

/**
 * Get secret based on configured secrets manager type
 */
export async function getSecret(key, options = {}) {
  const { forceRefresh = false } = options;
  
  // Check cache first
  if (!forceRefresh) {
    const cached = getCachedSecret(key);
    if (cached !== null) {
      return cached;
    }
  }
  
  let value = null;
  
  switch (SECRETS_MANAGER_TYPE.toLowerCase()) {
    case 'aws':
      value = await getSecretFromAWS(key);
      break;
    case 'azure':
      value = await getSecretFromAzure(key);
      break;
    case 'gcp':
    case 'google':
      value = await getSecretFromGCP(key);
      break;
    case 'env':
    default:
      value = await getSecretFromEnv(key);
      break;
  }
  
  // Cache the value
  if (value !== null) {
    setCachedSecret(key, value);
  }
  
  return value;
}

/**
 * Get multiple secrets at once
 */
export async function getSecrets(keys, options = {}) {
  const secrets = {};
  
  for (const key of keys) {
    secrets[key] = await getSecret(key, options);
  }
  
  return secrets;
}

/**
 * Set secret (for environment variables only)
 * Note: Cloud secrets managers have their own methods for setting secrets
 */
export async function setSecret(key, value) {
  if (SECRETS_MANAGER_TYPE === 'env') {
    process.env[key] = value;
    setCachedSecret(key, value);
    return true;
  }
  
  console.warn(`Setting secrets not supported for ${SECRETS_MANAGER_TYPE}`);
  return false;
}

/**
 * Rotate secret (for cloud secrets managers with rotation enabled)
 */
export async function rotateSecret(key) {
  // Clear cache to force refresh
  clearSecretCache(key);
  
  // Get the new value
  const newValue = await getSecret(key, { forceRefresh: true });
  
  return newValue;
}

/**
 * Health check for secrets manager
 */
export async function healthCheck() {
  try {
    // Try to get a known secret
    const testKey = 'JWT_SECRET';
    const value = await getSecret(testKey);
    
    return {
      status: 'healthy',
      type: SECRETS_MANAGER_TYPE,
      testSecretRetrieved: value !== null
    };
  } catch (error) {
    return {
      status: 'unhealthy',
      type: SECRETS_MANAGER_TYPE,
      error: error.message
    };
  }
}

/**
 * Get encryption key from secrets manager
 */
export async function getEncryptionKey(keyId = 'default') {
  const keyEnvVar = `ENCRYPTION_KEY_${keyId.toUpperCase()}`;
  const key = await getSecret(keyEnvVar);
  
  if (!key) {
    throw new Error(`Encryption key not found: ${keyEnvVar}`);
  }
  
  return key;
}

/**
 * Get JWT secret from secrets manager
 */
export async function getJWTSecret() {
  const secret = await getSecret('JWT_SECRET');
  
  if (!secret) {
    throw new Error('JWT_SECRET not found');
  }
  
  return secret;
}

/**
 * Get M-Pesa credentials from secrets manager
 */
export async function getMpesaCredentials() {
  const credentials = await getSecrets([
    'MPESA_CONSUMER_KEY',
    'MPESA_CONSUMER_SECRET',
    'MPESA_PASSKEY'
  ]);
  
  return {
    consumerKey: credentials.MPESA_CONSUMER_KEY,
    consumerSecret: credentials.MPESA_CONSUMER_SECRET,
    passkey: credentials.MPESA_PASSKEY
  };
}

/**
 * Initialize secrets manager
 */
export async function initialize() {
  console.log(`Initializing Secrets Manager: ${SECRETS_MANAGER_TYPE}`);
  
  if (SECRETS_MANAGER_TYPE === 'aws') {
    console.log('AWS Secrets Manager configured');
  } else if (SECRETS_MANAGER_TYPE === 'azure') {
    console.log('Azure Key Vault configured');
  } else if (SECRETS_MANAGER_TYPE === 'gcp' || SECRETS_MANAGER_TYPE === 'google') {
    console.log('GCP Secret Manager configured');
  } else {
    console.log('Environment variables configured');
  }
  
  // Perform health check
  const health = await healthCheck();
  console.log('Secrets Manager health:', health.status);
  
  return health;
}

export default {
  getSecret,
  getSecrets,
  setSecret,
  rotateSecret,
  healthCheck,
  getEncryptionKey,
  getJWTSecret,
  getMpesaCredentials,
  initialize,
  clearSecretCache,
};
