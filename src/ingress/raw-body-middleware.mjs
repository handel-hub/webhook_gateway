import crypto from 'node:crypto';
import { LIMITS } from '../config/limits.mjs';

/**
 * Express middleware that captures unaltered incoming request bytes into a raw Buffer.
 * Strictly enforces a 1 MB ceiling and computes payload SHA-256.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export function rawBodyMiddleware(req, res, next) {
  /** @type {Buffer[]} */
  const chunks = [];
  let totalBytes = 0;
  let exceeded = false;

  req.on('data', (chunk) => {
    if (exceeded) return;
    const bufChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += bufChunk.length;

    if (totalBytes > LIMITS.MAX_RAW_BODY_BYTES) {
      exceeded = true;
      req.destroy();
      res.status(413).json({
        error: 'Payload Too Large',
        message: `Request body exceeds maximum allowable limit of ${LIMITS.MAX_RAW_BODY_BYTES} bytes (1MB).`,
      });
      return;
    }

    chunks.push(bufChunk);
  });

  req.on('end', () => {
    if (exceeded) return;

    const rawBuffer = Buffer.concat(chunks);
    // @ts-ignore - custom request property
    req.rawBody = rawBuffer;
    // @ts-ignore - custom request property
    req.payloadSha256 = crypto.createHash('sha256').update(rawBuffer).digest('hex');

    next();
  });

  req.on('error', (err) => {
    next(err);
  });
}
