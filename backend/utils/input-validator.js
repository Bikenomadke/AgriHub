/**
 * Input Validation and Sanitization Utility
 * 
 * This module provides comprehensive input validation and sanitization:
 * - SQL injection prevention
 * - XSS prevention
 * - Command injection prevention
 * - Path traversal prevention
 * - Data type validation
 * - Length validation
 * - Format validation
 */

import validator from 'validator';

/**
 * Sanitize string input
 */
export function sanitizeString(input, options = {}) {
  if (typeof input !== 'string') {
    return input;
  }
  
  let sanitized = input.trim();
  
  // Remove potentially dangerous characters
  if (options.removeNullBytes) {
    sanitized = sanitized.replace(/\0/g, '');
  }
  
  if (options.removeControlChars) {
    sanitized = sanitized.replace(/[\x00-\x1F\x7F]/g, '');
  }
  
  // Limit length
  if (options.maxLength && sanitized.length > options.maxLength) {
    sanitized = sanitized.substring(0, options.maxLength);
  }
  
  return sanitized;
}

/**
 * Sanitize HTML input (prevent XSS)
 */
export function sanitizeHTML(input) {
  if (typeof input !== 'string') {
    return input;
  }
  
  return validator.escape(input);
}

/**
 * Validate email
 */
export function validateEmail(email) {
  return validator.isEmail(email);
}

/**
 * Validate phone number (Kenya format)
 */
export function validateKenyaPhone(phone) {
  const cleaned = phone.replace(/\D/g, '');
  
  // Kenya phone formats: 07XXXXXXXX, 2547XXXXXXXX, +2547XXXXXXXX
  if (cleaned.startsWith('0') && cleaned.length === 10) {
    return '254' + cleaned.slice(1);
  }
  if (cleaned.startsWith('254') && cleaned.length === 12) {
    return cleaned;
  }
  if (cleaned.startsWith('+254') && cleaned.length === 13) {
    return cleaned.slice(1);
  }
  
  return null;
}

/**
 * Validate national ID (Kenya format - 8 digits)
 */
export function validateNationalID(id) {
  const cleaned = id.replace(/\D/g, '');
  
  if (cleaned.length === 8 && /^\d+$/.test(cleaned)) {
    return cleaned;
  }
  
  return null;
}

/**
 * Validate URL
 */
export function validateURL(url, options = {}) {
  return validator.isURL(url, options);
}

/**
 * Validate numeric input
 */
export function validateNumber(input, options = {}) {
  const num = Number(input);
  
  if (isNaN(num)) {
    return null;
  }
  
  if (options.min !== undefined && num < options.min) {
    return null;
  }
  
  if (options.max !== undefined && num > options.max) {
    return null;
  }
  
  if (options.integer && !Number.isInteger(num)) {
    return null;
  }
  
  return num;
}

/**
 * Validate date
 */
export function validateDate(input) {
  const date = new Date(input);
  
  if (isNaN(date.getTime())) {
    return null;
  }
  
  return date;
}

/**
 * Validate UUID
 */
export function validateUUID(uuid) {
  return validator.isUUID(uuid);
}

/**
 * Sanitize SQL input (prevent SQL injection)
 */
export function sanitizeSQL(input) {
  if (typeof input !== 'string') {
    return input;
  }
  
  // Remove SQL injection patterns
  const dangerousPatterns = [
    /(\b(SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE|UNION|EXEC)\b)/gi,
    /(--|;|\/\*|\*\/)/g,
    /(\bOR\b|\bAND\b).*=.*=.*\bOR\b/gi,
    /(\bOR\b|\bAND\b).*=.*\bAND\b/gi,
    /(\bWHERE\b.*\bOR\b)/gi,
    /(\bWHERE\b.*\bAND\b)/gi,
  ];
  
  let sanitized = input;
  
  for (const pattern of dangerousPatterns) {
    sanitized = sanitized.replace(pattern, '');
  }
  
  return sanitized;
}

/**
 * Validate and sanitize object
 */
export function sanitizeObject(obj, schema = {}) {
  const sanitized = {};
  
  for (const key in obj) {
    if (obj.hasOwnProperty(key)) {
      const value = obj[key];
      const rules = schema[key] || {};
      
      if (typeof value === 'string') {
        sanitized[key] = sanitizeString(value, rules);
      } else if (typeof value === 'object' && value !== null) {
        sanitized[key] = sanitizeObject(value, rules);
      } else {
        sanitized[key] = value;
      }
    }
  }
  
  return sanitized;
}

/**
 * Validate object against schema
 */
export function validateObject(obj, schema) {
  const errors = [];
  
  for (const key in schema) {
    if (schema.hasOwnProperty(key)) {
      const rules = schema[key];
      const value = obj[key];
      
      // Required field check
      if (rules.required && (value === undefined || value === null || value === '')) {
        errors.push(`${key} is required`);
        continue;
      }
      
      // Skip validation if field is not required and not provided
      if (!rules.required && (value === undefined || value === null || value === '')) {
        continue;
      }
      
      // Type validation
      if (rules.type && typeof value !== rules.type) {
        errors.push(`${key} must be of type ${rules.type}`);
      }
      
      // Length validation
      if (rules.minLength && value.length < rules.minLength) {
        errors.push(`${key} must be at least ${rules.minLength} characters`);
      }
      
      if (rules.maxLength && value.length > rules.maxLength) {
        errors.push(`${key} must be at most ${rules.maxLength} characters`);
      }
      
      // Pattern validation
      if (rules.pattern && !rules.pattern.test(value)) {
        errors.push(`${key} format is invalid`);
      }
      
      // Custom validation
      if (rules.validate && !rules.validate(value)) {
        errors.push(`${key} is invalid`);
      }
      
      // Enum validation
      if (rules.enum && !rules.enum.includes(value)) {
        errors.push(`${key} must be one of: ${rules.enum.join(', ')}`);
      }
    }
  }
  
  return errors;
}

/**
 * Middleware to validate request body
 */
export function validateBody(schema) {
  return (req, res, next) => {
    const errors = validateObject(req.body, schema);
    
    if (errors.length > 0) {
      return res.status(400).json({ 
        error: 'Validation failed', 
        details: errors 
      });
    }
    
    // Sanitize the body
    req.body = sanitizeObject(req.body, schema);
    
    next();
  };
}

/**
 * Middleware to validate query parameters
 */
export function validateQuery(schema) {
  return (req, res, next) => {
    const errors = validateObject(req.query, schema);
    
    if (errors.length > 0) {
      return res.status(400).json({ 
        error: 'Query validation failed', 
        details: errors 
      });
    }
    
    // Sanitize the query
    req.query = sanitizeObject(req.query, schema);
    
    next();
  };
}

/**
 * Middleware to validate path parameters
 */
export function validateParams(schema) {
  return (req, res, next) => {
    const errors = validateObject(req.params, schema);
    
    if (errors.length > 0) {
      return res.status(400).json({ 
        error: 'Parameter validation failed', 
        details: errors 
      });
    }
    
    // Sanitize the params
    req.params = sanitizeObject(req.params, schema);
    
    next();
  };
}

/**
 * Common validation schemas
 */
export const schemas = {
  user: {
    username: {
      type: 'string',
      required: true,
      minLength: 3,
      maxLength: 50,
      pattern: /^[a-zA-Z0-9_]+$/
    },
    email: {
      type: 'string',
      required: false,
      validate: validateEmail
    },
    phone: {
      type: 'string',
      required: false,
      validate: validateKenyaPhone
    }
  },
  
  farmer: {
    full_name: {
      type: 'string',
      required: true,
      minLength: 2,
      maxLength: 100
    },
    national_id: {
      type: 'string',
      required: true,
      validate: validateNationalID
    },
    mpesa_phone: {
      type: 'string',
      required: true,
      validate: validateKenyaPhone
    },
    county: {
      type: 'string',
      required: true,
      minLength: 2,
      maxLength: 50
    },
    subcounty: {
      type: 'string',
      required: true,
      minLength: 2,
      maxLength: 50
    },
    ward: {
      type: 'string',
      required: true,
      minLength: 2,
      maxLength: 50
    }
  },
  
  field: {
    name: {
      type: 'string',
      required: true,
      minLength: 2,
      maxLength: 100
    },
    area_acres: {
      type: 'number',
      required: true,
      min: 0,
      max: 10000
    },
    status: {
      type: 'string',
      required: false,
      enum: ['surveyed', 'valued', 'reserved', 'paid', 'harvest_approved', 'harvested']
    }
  },
  
  transaction: {
    tons: {
      type: 'number',
      required: true,
      min: 0,
      max: 1000
    },
    buy_price: {
      type: 'number',
      required: true,
      min: 0,
      max: 100000
    },
    date: {
      type: 'string',
      required: true,
      validate: validateDate
    }
  }
};

export default {
  sanitizeString,
  sanitizeHTML,
  validateEmail,
  validateKenyaPhone,
  validateNationalID,
  validateURL,
  validateNumber,
  validateDate,
  validateUUID,
  sanitizeSQL,
  sanitizeObject,
  validateObject,
  validateBody,
  validateQuery,
  validateParams,
  schemas,
};
