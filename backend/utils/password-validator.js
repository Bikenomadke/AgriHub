/**
 * Password Security Validator
 * 
 * This module provides password validation according to security best practices:
 * - Minimum 12 characters
 * - Entropy validation
 * - Complexity requirements
 * - Common password detection
 */

import config from './config.js';

/**
 * Password complexity requirements
 */
const PASSWORD_REQUIREMENTS = {
  minLength: 12,
  maxLength: 128,
  requireUppercase: true,
  requireLowercase: true,
  requireNumbers: true,
  requireSpecialChars: true,
  minEntropy: 60, // Minimum entropy score (0-100)
};

/**
 * Common weak passwords that should be rejected
 */
const COMMON_PASSWORDS = [
  'password', '12345678', 'qwerty123', 'abc12345', 'password123',
  'admin123', 'letmein', 'welcome1', 'monkey123', 'dragon123',
  'master123', 'hello123', 'football123', 'iloveyou123', 'trustno1',
  'sunshine123', 'princess123', 'login123', 'starwars123', 'password1',
  '123456789', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm123', 'passw0rd',
  'agrihub2026', 'field123', 'trade123', 'admin2026', 'welcome2026'
];

/**
 * Calculate password entropy score
 * Entropy is calculated based on character set size and password length
 */
function calculateEntropy(password) {
  let charsetSize = 0;
  
  if (/[a-z]/.test(password)) charsetSize += 26;
  if (/[A-Z]/.test(password)) charsetSize += 26;
  if (/[0-9]/.test(password)) charsetSize += 10;
  if (/[^a-zA-Z0-9]/.test(password)) charsetSize += 32;
  
  if (charsetSize === 0) charsetSize = 26; // Default to lowercase
  
  const entropy = Math.log2(Math.pow(charsetSize, password.length));
  const maxEntropy = Math.log2(Math.pow(94, 128)); // Max entropy for 128 chars with all character types
  
  // Normalize to 0-100 scale
  return Math.min(100, (entropy / maxEntropy) * 100);
}

/**
 * Check if password contains common patterns
 */
function hasCommonPatterns(password) {
  const lowerPassword = password.toLowerCase();
  
  // Check against common passwords
  if (COMMON_PASSWORDS.some(common => lowerPassword.includes(common))) {
    return true;
  }
  
  // Check for sequential characters
  for (let i = 0; i < password.length - 2; i++) {
    const charCode = password.charCodeAt(i);
    const nextCharCode = password.charCodeAt(i + 1);
    const nextNextCharCode = password.charCodeAt(i + 2);
    
    // Check for ascending sequences (abc, 123)
    if (nextCharCode === charCode + 1 && nextNextCharCode === charCode + 2) {
      return true;
    }
    
    // Check for descending sequences (cba, 321)
    if (nextCharCode === charCode - 1 && nextNextCharCode === charCode - 2) {
      return true;
    }
  }
  
  // Check for repeated characters (aaa, 111)
  for (let i = 0; i < password.length - 2; i++) {
    if (password[i] === password[i + 1] && password[i] === password[i + 2]) {
      return true;
    }
  }
  
  return false;
}

/**
 * Validate password against requirements
 */
export function validatePassword(password) {
  const errors = [];
  const warnings = [];
  
  // Check length
  if (!password || password.length === 0) {
    errors.push('Password is required');
    return { valid: false, errors, warnings, entropy: 0 };
  }
  
  if (password.length < PASSWORD_REQUIREMENTS.minLength) {
    errors.push(`Password must be at least ${PASSWORD_REQUIREMENTS.minLength} characters long`);
  }
  
  if (password.length > PASSWORD_REQUIREMENTS.maxLength) {
    errors.push(`Password must not exceed ${PASSWORD_REQUIREMENTS.maxLength} characters`);
  }
  
  // Check character types
  if (PASSWORD_REQUIREMENTS.requireUppercase && !/[A-Z]/.test(password)) {
    errors.push('Password must contain at least one uppercase letter');
  }
  
  if (PASSWORD_REQUIREMENTS.requireLowercase && !/[a-z]/.test(password)) {
    errors.push('Password must contain at least one lowercase letter');
  }
  
  if (PASSWORD_REQUIREMENTS.requireNumbers && !/[0-9]/.test(password)) {
    errors.push('Password must contain at least one number');
  }
  
  if (PASSWORD_REQUIREMENTS.requireSpecialChars && !/[^a-zA-Z0-9]/.test(password)) {
    errors.push('Password must contain at least one special character');
  }
  
  // Check for common patterns
  if (hasCommonPatterns(password)) {
    errors.push('Password contains common patterns or is too predictable');
  }
  
  // Calculate entropy
  const entropy = calculateEntropy(password);
  
  if (entropy < PASSWORD_REQUIREMENTS.minEntropy) {
    warnings.push('Password has low entropy and may be vulnerable to brute force attacks');
  }
  
  const valid = errors.length === 0;
  
  return {
    valid,
    errors,
    warnings,
    entropy: Math.round(entropy),
    length: password.length
  };
}

/**
 * Check if password is in breach database (placeholder for future implementation)
 * This would integrate with services like HaveIBeenPwned
 */
export async function checkPasswordBreach(password) {
  // TODO: Implement actual breach checking using HaveIBeenPwned API
  // For now, return false (not breached)
  return false;
}

/**
 * Generate a secure random password
 */
export function generateSecurePassword(length = 16) {
  const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()_+-=[]{}|;:,.<>?';
  const array = new Uint32Array(length);
  crypto.getRandomValues(array);
  
  let password = '';
  for (let i = 0; i < length; i++) {
    password += charset[array[i] % charset.length];
  }
  
  return password;
}

/**
 * Get password strength description
 */
export function getPasswordStrength(entropy) {
  if (entropy >= 80) return 'Strong';
  if (entropy >= 60) return 'Good';
  if (entropy >= 40) return 'Fair';
  if (entropy >= 20) return 'Weak';
  return 'Very Weak';
}

/**
 * Hash password using bcrypt
 */
import bcrypt from 'bcryptjs';

export async function hashPassword(password) {
  const saltRounds = 12;
  return bcrypt.hash(password, saltRounds);
}

/**
 * Verify password against hash
 */
export async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

export default {
  validatePassword,
  checkPasswordBreach,
  generateSecurePassword,
  getPasswordStrength,
  hashPassword,
  verifyPassword,
  PASSWORD_REQUIREMENTS
};
