/**
 * CWIDS Structured JSON Logger with automated credential redaction.
 */

const SENSITIVE_KEY_PATTERNS = [
  /authorization/i,
  /signature/i,
  /verif[-_]?hash/i,
  /secret/i,
  /token/i,
  /password/i,
  /api[-_]?key/i,
  /private[-_]?key/i,
  /encrypted[-_]?payload/i,
  /\bdek\b/i,
  /\bkek\b/i,
  /credit[-_]?card/i,
  /cvv/i,
];

/**
 * Deeply redacts sensitive keys from an arbitrary object.
 * Protects against circular references.
 * @param {any} value
 * @param {WeakSet<object>} [seen=new WeakSet()]
 * @returns {any}
 */
export function redact(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (seen.has(value)) {
    return '[CIRCULAR]';
  }
  seen.add(value);

  if (Buffer.isBuffer(value)) {
    return `[BUFFER len=${value.length}]`;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, seen));
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      // @ts-ignore - optional custom property
      code: value.code,
      stack: value.stack,
    };
  }

  /** @type {Record<string, any>} */
  const sanitized = {};
  for (const [key, val] of Object.entries(value)) {
    const isSensitive = SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key));
    if (isSensitive) {
      sanitized[key] = '[REDACTED]';
    } else {
      sanitized[key] = redact(val, seen);
    }
  }

  return sanitized;
}

/**
 * Formats and outputs structured JSON log record.
 * @param {'debug' | 'info' | 'warn' | 'error'} level
 * @param {string} message
 * @param {Record<string, any>} [context={}]
 * @param {Error} [error]
 * @param {string} [destination='stdout']
 */
function log(level, message, context = {}, error = undefined, destination = 'stdout') {
  const record = {
    timestamp: new Date().toISOString(),
    level,
    message,
    context: redact(context),
    ...(error ? { error: redact(error) } : {}),
  };

  const output = JSON.stringify(record);
  if (destination === 'stderr' || level === 'error') {
    process.stderr.write(output + '\n');
  } else {
    process.stdout.write(output + '\n');
  }
  return record;
}

/**
 * @typedef {object} Logger
 * @property {(message: string, context?: Record<string, any>) => any} debug
 * @property {(message: string, context?: Record<string, any>) => any} info
 * @property {(message: string, context?: Record<string, any>, error?: Error) => any} warn
 * @property {(message: string, error?: Error, context?: Record<string, any>) => any} error
 */

/**
 * Creates a scoped logger with pre-bound context.
 * @param {Record<string, any>} [defaultContext={}]
 * @returns {Logger}
 */
export function createLogger(defaultContext = {}) {
  return {
    /**
     * @param {string} message
     * @param {Record<string, any>} [context={}]
     */
    debug(message, context = {}) {
      return log('debug', message, { ...defaultContext, ...context });
    },
    /**
     * @param {string} message
     * @param {Record<string, any>} [context={}]
     */
    info(message, context = {}) {
      return log('info', message, { ...defaultContext, ...context });
    },
    /**
     * @param {string} message
     * @param {Record<string, any>} [context={}]
     * @param {Error} [error]
     */
    warn(message, context = {}, error = undefined) {
      return log('warn', message, { ...defaultContext, ...context }, error);
    },
    /**
     * @param {string} message
     * @param {Error} [error]
     * @param {Record<string, any>} [context={}]
     */
    error(message, error = undefined, context = {}) {
      return log('error', message, { ...defaultContext, ...context }, error, 'stderr');
    },
  };
}

export const logger = createLogger();
