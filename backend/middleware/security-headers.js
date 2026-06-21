/**
 * Security Headers Middleware
 * 
 * This middleware implements OWASP-recommended security headers:
 * - Strict-Transport-Security (HSTS)
 * - X-Frame-Options
 * - X-Content-Type-Options
 * - Referrer-Policy
 * - Permissions-Policy
 * - Content-Security-Policy (CSP)
 */

import config from '../utils/config.js';

/**
 * Content Security Policy configuration
 * Compatible with:
 * - FastAPI backend
 * - Next.js frontend
 * - Google Fonts
 * - API calls
 * - Static assets
 */
const CSP_DIRECTIVES = {
  'default-src': ["'self'"],
  'script-src': ["'self'", "'unsafe-inline'", "'unsafe-eval'", 'https://*.googleapis.com', 'https://*.gstatic.com'],
  'style-src': ["'self'", "'unsafe-inline'", 'https://*.googleapis.com', 'https://*.gstatic.com'],
  'img-src': ["'self'", 'data:', 'https:', 'http:'],
  'font-src': ["'self'", 'https://*.googleapis.com', 'https://*.gstatic.com', 'data:'],
  'connect-src': ["'self'", 'https://*.supabase.co', 'ws:', 'wss:'],
  'frame-src': ["'none'"],
  'frame-ancestors': ["'none'"],
  'object-src': ["'none'"],
  'base-uri': ["'self'"],
  'form-action': ["'self'"],
  'manifest-src': ["'self'"],
  'worker-src': ["'self'", 'blob:'],
  'child-src': ["'self'", 'blob:'],
};

/**
 * Generate CSP header value
 */
function generateCSP() {
  return Object.entries(CSP_DIRECTIVES)
    .map(([directive, sources]) => {
      return `${directive} ${sources.join(' ')}`;
    })
    .join('; ');
}

/**
 * Security headers middleware
 */
export function securityHeaders(req, res, next) {
  // Strict-Transport-Security (HSTS)
  // Forces HTTPS for 1 year including subdomains
  if (config.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  }

  // X-Frame-Options
  // Prevents clickjacking attacks
  res.setHeader('X-Frame-Options', 'DENY');

  // X-Content-Type-Options
  // Prevents MIME-sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // Referrer-Policy
  // Controls how much referrer information is sent
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  // Permissions-Policy (formerly Feature-Policy)
  // Controls which browser features can be used
  const permissionsPolicy = [
    'geolocation=(self)',
    'camera=(self)',
    'microphone=(self)',
    'payment=(self)',
    'usb=()',
    'magnetometer=()',
    'gyroscope=()',
    'accelerometer=()',
    'ambient-light-sensor=()',
  ];
  res.setHeader('Permissions-Policy', permissionsPolicy.join(', '));

  // Content-Security-Policy
  // Prevents XSS and data injection attacks
  res.setHeader('Content-Security-Policy', generateCSP());

  // X-XSS-Protection
  // Enables XSS filter (legacy, but still useful for older browsers)
  res.setHeader('X-XSS-Protection', '1; mode=block');

  // Cross-Origin-Opener-Policy
  // Isolates browsing contexts
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');

  // Cross-Origin-Embedder-Policy
  // Controls embedding of cross-origin resources
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');

  // Cache-Control for API responses
  // Prevents caching of sensitive data
  if (req.path.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  }

  // Remove X-Powered-By header (security by obscurity)
  res.removeHeader('X-Powered-By');

  next();
}

/**
 * Nonce-based CSP for dynamic content
 * Use this for endpoints that need to inject dynamic scripts
 */
export function nonceBasedCSP(req, res, next) {
  const nonce = Buffer.from(crypto.randomBytes(16)).toString('base64');
  res.locals.cspNonce = nonce;

  const cspWithNonce = Object.entries(CSP_DIRECTIVES)
    .map(([directive, sources]) => {
      if (directive === 'script-src') {
        return `${directive} ${sources.join(' ')} 'nonce-${nonce}'`;
      }
      return `${directive} ${sources.join(' ')}`;
    })
    .join('; ');

  res.setHeader('Content-Security-Policy', cspWithNonce);
  next();
}

/**
 * Report-Only CSP for testing
 * Use this in development to test CSP without blocking resources
 */
export function reportOnlyCSP(req, res, next) {
  const csp = generateCSP();
  res.setHeader('Content-Security-Policy-Report-Only', csp);
  next();
}

/**
 * Security headers for development
 * Relaxed headers for development environment
 */
export function devSecurityHeaders(req, res, next) {
  // Less strict HSTS in development
  res.setHeader('Strict-Transport-Security', 'max-age=3600');

  // Allow framing in development for debugging tools
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');

  // Report-only CSP in development
  reportOnlyCSP(req, res, next);
}

export default securityHeaders;
