/**
 * Lightweight periodic memory cleaner
 * - No longer checks memory usage/thresholds (avoids frequent scanning and GC jitter)
 * - Only triggers module cleanup callbacks on a timer (object pool trimming, cache pruning, etc.)
 * @module utils/memoryManager
 */

import logger from './logger.js';

// Maximum object pool sizes (fixed values, no longer dynamically adjusted by "pressure")
const POOL_SIZES = { chunk: 30, toolCall: 15, lineBuffer: 5 };

class MemoryManager {
  constructor() {
    /** @type {Set<Function>} */
    this.cleanupCallbacks = new Set();
    /** @type {NodeJS.Timeout|null} */
    this.timer = null;
    /** @type {number} */
    this.cleanupIntervalMs = 30 * 60 * 1000;
    this.isShuttingDown = false;
  }

  /**
   * Start periodic cleanup
   * @param {number} cleanupIntervalMs - Cleanup interval in milliseconds
   */
  start(cleanupIntervalMs = 30 * 60 * 1000) {
    if (this.timer) return;
    this.setCleanupInterval(cleanupIntervalMs);
    this.isShuttingDown = false;
    logger.info(`Memory cleaner started (interval: ${Math.round(this.cleanupIntervalMs / 1000)}s)`);
  }

  /**
   * Dynamically adjust the cleanup interval (hot reload)
   * @param {number} cleanupIntervalMs
   */
  setCleanupInterval(cleanupIntervalMs) {
    if (Number.isFinite(cleanupIntervalMs) && cleanupIntervalMs > 0) {
      this.cleanupIntervalMs = Math.floor(cleanupIntervalMs);
    }

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    this.timer = setInterval(() => {
      if (!this.isShuttingDown) this.cleanup('timer');
    }, this.cleanupIntervalMs);

    this.timer.unref?.();
  }

  /**
   * Stop periodic cleanup
   */
  stop() {
    this.isShuttingDown = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.cleanupCallbacks.clear();
    logger.info('Memory cleaner stopped');
  }

  /**
   * Register a cleanup callback
   * @param {(reason: string) => void} callback
   */
  registerCleanup(callback) {
    this.cleanupCallbacks.add(callback);
  }

  /**
   * Unregister a cleanup callback
   * @param {Function} callback
   */
  unregisterCleanup(callback) {
    this.cleanupCallbacks.delete(callback);
  }

  /**
   * Trigger a cleanup pass
   * @param {string} reason
   */
  cleanup(reason = 'manual') {
    for (const callback of this.cleanupCallbacks) {
      try {
        callback(reason);
      } catch (error) {
        logger.error('Cleanup callback execution failed:', error.message);
      }
    }
  }

  /**
   * Get object pool size configuration
   */
  getPoolSizes() {
    return POOL_SIZES;
  }
}

const memoryManager = new MemoryManager();
export default memoryManager;

// Unified wrapper: register object pool trimming (executed when periodic cleanup triggers)
export function registerMemoryPoolCleanup(pool, getMaxSize) {
  memoryManager.registerCleanup(() => {
    const maxSize = getMaxSize();
    while (pool.length > maxSize) pool.pop();
  });
}
