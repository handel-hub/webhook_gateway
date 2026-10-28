import { ERROR_CODES } from './error-codes.mjs';

/**
 * Base system error for all CWIDS exceptions.
 */
export class CwidsError extends Error {
  /**
   * @param {string} message - Descriptive error message.
   * @param {string} [code=ERROR_CODES.INTERNAL_SERVER_ERROR] - Machine-readable error code.
   * @param {number} [statusCode=500] - Associated HTTP response status code.
   * @param {Record<string, any>} [context={}] - Safe contextual attributes.
   * @param {boolean} [isOperational=true] - Whether this error is a known operational condition.
   */
  constructor(
    message,
    code = ERROR_CODES.INTERNAL_SERVER_ERROR,
    statusCode = 500,
    context = {},
    isOperational = true,
  ) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.statusCode = statusCode;
    this.context = context;
    this.isOperational = isOperational;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class ValidationError extends CwidsError {
  /**
   * @param {string} message
   * @param {Record<string, any>} [context={}]
   */
  constructor(message, context = {}) {
    super(message, ERROR_CODES.VALIDATION_ERROR, 400, context, true);
  }
}

export class AuthenticationError extends CwidsError {
  /**
   * @param {string} message
   * @param {Record<string, any>} [context={}]
   */
  constructor(message, context = {}) {
    super(message, ERROR_CODES.AUTHENTICATION_ERROR, 401, context, true);
  }
}

export class ForbiddenError extends CwidsError {
  /**
   * @param {string} message
   * @param {Record<string, any>} [context={}]
   */
  constructor(message, context = {}) {
    super(message, ERROR_CODES.FORBIDDEN_ERROR, 403, context, true);
  }
}

export class NotFoundError extends CwidsError {
  /**
   * @param {string} message
   * @param {Record<string, any>} [context={}]
   */
  constructor(message, context = {}) {
    super(message, ERROR_CODES.NOT_FOUND_ERROR, 404, context, true);
  }
}

export class ConflictError extends CwidsError {
  /**
   * @param {string} message
   * @param {Record<string, any>} [context={}]
   */
  constructor(message, context = {}) {
    super(message, ERROR_CODES.CONFLICT_ERROR, 409, context, true);
  }
}

export class StaleFencingTokenError extends CwidsError {
  /**
   * @param {string} deliveryId
   * @param {number} presentedToken
   * @param {number} currentToken
   */
  constructor(deliveryId, presentedToken, currentToken) {
    super(
      `Delivery ${deliveryId} lease was preempted. Presented token ${presentedToken} is stale (current: ${currentToken}).`,
      ERROR_CODES.STALE_FENCING_TOKEN,
      409,
      { deliveryId, presentedToken, currentToken },
      true,
    );
  }
}

export class RateLimitError extends CwidsError {
  /**
   * @param {string} message
   * @param {Record<string, any>} [context={}]
   */
  constructor(message, context = {}) {
    super(message, ERROR_CODES.RATE_LIMIT_ERROR, 429, context, true);
  }
}

export class DatabaseOperationError extends CwidsError {
  /**
   * @param {string} message
   * @param {Record<string, any>} [context={}]
   * @param {Error} [cause]
   */
  constructor(message, context = {}, cause = undefined) {
    super(message, ERROR_CODES.DATABASE_OPERATION_FAILED, 500, context, true);
    if (cause) {
      this.cause = cause;
    }
  }
}

export class SsrfBlockedError extends CwidsError {
  /**
   * @param {string} targetUrl
   * @param {string} resolvedIp
   * @param {string} reason
   */
  constructor(targetUrl, resolvedIp, reason) {
    super(
      `Outbound request to ${targetUrl} (${resolvedIp}) blocked by SSRF policy: ${reason}`,
      ERROR_CODES.SSRF_BLOCKED,
      403,
      { targetUrl, resolvedIp, reason },
      true,
    );
  }
}

export class CryptoOperationError extends CwidsError {
  /**
   * @param {string} message
   * @param {Record<string, any>} [context={}]
   */
  constructor(message, context = {}) {
    super(message, ERROR_CODES.CRYPTO_OPERATION_FAILED, 500, context, false);
  }
}

export class CircuitBreakerOpenError extends CwidsError {
  /**
   * @param {string} destinationEndpointId
   * @param {number} cooldownRemainingMs
   */
  constructor(destinationEndpointId, cooldownRemainingMs) {
    super(
      `Circuit breaker for endpoint ${destinationEndpointId} is OPEN. Cooldown remaining: ${cooldownRemainingMs}ms`,
      ERROR_CODES.CIRCUIT_BREAKER_OPEN,
      503,
      { destinationEndpointId, cooldownRemainingMs },
      true,
    );
  }
}
