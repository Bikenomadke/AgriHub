/**
 * SSRF Protection Utility
 * 
 * This module provides Server-Side Request Forgery (SSRF) protection by:
 * - Enforcing HTTPS-only outbound requests
 * - Domain allowlist validation
 * - Private IP blocking
 * - Loopback blocking
 * - Metadata endpoint blocking
 */

import config from './config.js';

/**
 * Private IP ranges that should be blocked
 */
const PRIVATE_IP_RANGES = [
  // IPv4 private ranges
  /^10\./,                              // 10.0.0.0/8
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,    // 172.16.0.0/12
  /^192\.168\./,                        // 192.168.0.0/16
  /^127\./,                             // 127.0.0.0/8 (loopback)
  /^0\./,                               // 0.0.0.0/8
  /^169\.254\./,                        // 169.254.0.0/16 (link-local)
  /^100\.(6[4-9]|[7-9][0-9]|1[0-1][0-9]|12[0-7])\./, // 100.64.0.0/10 (carrier-grade NAT)
  /^192\.0\.0\./,                       // 192.0.0.0/24 (IETF protocol assignments)
  /^192\.0\.2\./,                       // 192.0.2.0/24 (TEST-NET-1)
  /^198\.51\.100\./,                    // 198.51.100.0/24 (TEST-NET-2)
  /^203\.0\.113\./,                     // 203.0.113.0/24 (TEST-NET-3)
  /^224\./,                             // 224.0.0.0/4 (multicast)
  /^240\./,                             // 240.0.0.0/4 (reserved)
  
  // IPv6 private ranges
  /^::1$/,                              // IPv6 loopback
  /^fe80:/i,                            // IPv6 link-local
  /^fc00:/i,                            // IPv6 unique local
  /^fd00:/i,                            // IPv6 unique local
  /^ff00:/i,                            // IPv6 multicast
];

/**
 * Cloud metadata endpoints that should be blocked
 */
const BLOCKED_METADATA_ENDPOINTS = [
  'metadata.google.internal',
  '169.254.169.254',
  'metadata',
  '169.254.169.254',
  '100.100.100.200', // Alibaba Cloud
  '100.100.0.96',    // Alibaba Cloud
];

/**
 * Allowed domains for outbound requests
 * This should be configured based on your application's needs
 */
const ALLOWED_DOMAINS = [
  // M-Pesa API
  'api.safaricom.et',
  'sandbox.safaricom.et',
  
  // Supabase (if used)
  'lykcuuxsplszplkoqlao.supabase.co',
  
  // Add other allowed domains as needed
];

/**
 * Check if IP address is in private range
 */
function isPrivateIP(ip) {
  if (!ip) return true;
  
  // Check against private IP ranges
  for (const range of PRIVATE_IP_RANGES) {
    if (range.test(ip)) {
      return true;
    }
  }
  
  return false;
}

/**
 * Check if hostname is a metadata endpoint
 */
function isMetadataEndpoint(hostname) {
  if (!hostname) return true;
  
  const lowerHostname = hostname.toLowerCase();
  
  // Check against blocked metadata endpoints
  for (const endpoint of BLOCKED_METADATA_ENDPOINTS) {
    if (lowerHostname.includes(endpoint)) {
      return true;
    }
  }
  
  return false;
}

/**
 * Check if domain is in allowlist
 */
function isDomainAllowed(hostname) {
  if (!hostname) return false;
  
  const lowerHostname = hostname.toLowerCase();
  
  // Check against allowlist
  for (const allowedDomain of ALLOWED_DOMAINS) {
    if (lowerHostname === allowedDomain || lowerHostname.endsWith('.' + allowedDomain)) {
      return true;
    }
  }
  
  return false;
}

/**
 * Validate URL for SSRF protection
 */
export function validateURL(url) {
  try {
    const parsedURL = new URL(url);
    
    // Enforce HTTPS only (except for localhost in development)
    if (config.NODE_ENV === 'production' && parsedURL.protocol !== 'https:') {
      throw new Error('HTTPS is required for outbound requests');
    }
    
    // Check for metadata endpoints
    if (isMetadataEndpoint(parsedURL.hostname)) {
      throw new Error('Access to metadata endpoints is blocked');
    }
    
    // Check for private IPs
    if (isPrivateIP(parsedURL.hostname)) {
      throw new Error('Access to private IP addresses is blocked');
    }
    
    // Check domain allowlist
    if (!isDomainAllowed(parsedURL.hostname)) {
      throw new Error(`Domain ${parsedURL.hostname} is not in the allowlist`);
    }
    
    // Check for port-based attacks
    const port = parseInt(parsedURL.port) || (parsedURL.protocol === 'https:' ? 443 : 80);
    if (port < 1 || port > 65535) {
      throw new Error('Invalid port number');
    }
    
    // Block common non-HTTP ports
    const blockedPorts = [22, 23, 25, 53, 110, 143, 3306, 3389, 5432, 6379, 27017];
    if (blockedPorts.includes(port)) {
      throw new Error(`Port ${port} is blocked`);
    }
    
    return true;
  } catch (error) {
    if (error.message.includes('Invalid URL')) {
      throw new Error('Invalid URL format');
    }
    throw error;
  }
}

/**
 * Safe fetch with SSRF protection
 */
export async function safeFetch(url, options = {}) {
  // Validate URL before making request
  validateURL(url);
  
  // Enforce HTTPS in production
  if (config.NODE_ENV === 'production' && !url.startsWith('https://')) {
    throw new Error('HTTPS is required for outbound requests');
  }
  
  // Add security headers to request
  const secureOptions = {
    ...options,
    headers: {
      'User-Agent': 'AgriHub/1.0',
      ...options.headers,
    },
    // Disable redirects to prevent SSRF via redirect chains
    redirect: 'manual',
  };
  
  try {
    const response = await fetch(url, secureOptions);
    
    // Validate redirect if present
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (location) {
        validateURL(location);
      }
    }
    
    return response;
  } catch (error) {
    throw new Error(`SSRF protection blocked request: ${error.message}`);
  }
}

/**
 * Add domain to allowlist (runtime configuration)
 */
export function addAllowedDomain(domain) {
  if (!ALLOWED_DOMAINS.includes(domain)) {
    ALLOWED_DOMAINS.push(domain);
  }
}

/**
 * Remove domain from allowlist (runtime configuration)
 */
export function removeAllowedDomain(domain) {
  const index = ALLOWED_DOMAINS.indexOf(domain);
  if (index > -1) {
    ALLOWED_DOMAINS.splice(index, 1);
  }
}

/**
 * Get current allowlist
 */
export function getAllowedDomains() {
  return [...ALLOWED_DOMAINS];
}

export default {
  validateURL,
  safeFetch,
  addAllowedDomain,
  removeAllowedDomain,
  getAllowedDomains,
  PRIVATE_IP_RANGES,
  BLOCKED_METADATA_ENDPOINTS,
};
