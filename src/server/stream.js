/**
 * SSE streaming response and heartbeat utility module
 */

import config from '../config/config.js';
import memoryManager, { registerMemoryPoolCleanup } from '../utils/memoryManager.js';
import { DEFAULT_HEARTBEAT_INTERVAL } from '../constants/index.js';

export { with429Retry } from './handlers/common/retry.js';

// ==================== Heartbeat Mechanism (prevents Cloudflare timeout) ====================
const HEARTBEAT_INTERVAL = config.server.heartbeatInterval || DEFAULT_HEARTBEAT_INTERVAL;
const SSE_HEARTBEAT = Buffer.from(': heartbeat\n\n');

/**
 * Create a heartbeat interval timer
 * @param {Response} res - Express response object
 * @returns {NodeJS.Timeout} Timer handle
 */
export const createHeartbeat = (res) => {
  const timer = setInterval(() => {
    if (!res.writableEnded) {
      res.write(SSE_HEARTBEAT);
    } else {
      clearInterval(timer);
    }
  }, HEARTBEAT_INTERVAL);

  res.on('close', () => clearInterval(timer));
  res.on('finish', () => clearInterval(timer));

  return timer;
};

// ==================== Pre-allocated Constant Buffers (avoid repeated allocation) ====================
const SSE_PREFIX = Buffer.from('data: ');
const SSE_SUFFIX = Buffer.from('\n\n');
const SSE_DONE = Buffer.from('data: [DONE]\n\n');

/**
 * Generate response metadata
 * @returns {{id: string, created: number}}
 */
export const createResponseMeta = () => ({
  id: `chatcmpl-${Date.now()}`,
  created: Math.floor(Date.now() / 1000)
});

/**
 * Set SSE streaming response headers
 * @param {Response} res - Express response object
 */
export const setStreamHeaders = (res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
};

// ==================== Object Pool (reduces GC pressure) ====================
const chunkPool = [];

/**
 * Acquire a chunk object from the pool
 * @returns {Object}
 */
export const getChunkObject = () => chunkPool.pop() || { choices: [{ index: 0, delta: {}, finish_reason: null }] };

/**
 * Release a chunk object back to the pool
 * @param {Object} obj
 */
export const releaseChunkObject = (obj) => {
  const maxSize = memoryManager.getPoolSizes().chunk;
  if (chunkPool.length < maxSize) chunkPool.push(obj);
};

registerMemoryPoolCleanup(chunkPool, () => memoryManager.getPoolSizes().chunk);

/**
 * Get current chunk pool size (for monitoring)
 * @returns {number}
 */
export const getChunkPoolSize = () => chunkPool.length;

/**
 * Clear the chunk pool
 */
export const clearChunkPool = () => {
  chunkPool.length = 0;
};

/**
 * Write streaming SSE data without extra buffer copies
 * @param {Response} res - Express response object
 * @param {Object} data - Payload to send
 */
export const writeStreamData = (res, data) => {
  const json = JSON.stringify(data);
  res.write(SSE_PREFIX);
  res.write(json);
  res.write(SSE_SUFFIX);
  if (typeof res.flush === 'function') {
    res.flush();
  }
};

/**
 * End the streaming response
 * @param {Response} res - Express response object
 */
export const endStream = (res, isWriteDone = true) => {
  if (res.writableEnded) return;
  if (isWriteDone) res.write(SSE_DONE);
  res.end();
};
