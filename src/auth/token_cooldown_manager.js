import fs from 'fs';
import path from 'path';
import { log } from '../utils/logger.js';
import { getDataDir } from '../utils/paths.js';
import { getGroupKey, MODEL_GROUPS } from '../utils/modelGroups.js';

/**
 * Token model-family cooldown manager
 * Temporarily disables a token's access to a model family when its quota is exhausted and recovery takes a long time
 *
 * Data structure:
 * {
 *   "meta": { "version": 1 },
 *   "cooldowns": {
 *     "tokenId1": {
 *       "claude": { "until": 1737500000000 },
 *       "gemini": null,
 *       "banana": { "until": 1737600000000 }
 *     }
 *   }
 * }
 */

class TokenCooldownManager {
  constructor(filePath = path.join(getDataDir(), 'token_cooldowns.json')) {
    this.filePath = filePath;
    /** @type {Map<string, Object>} tokenId -> { groupKey: { until: timestamp } } */
    this.cooldowns = new Map();
    this.ensureFileExists();
    this.loadFromFile();
  }

  ensureFileExists() {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(this.filePath)) {
      const initialData = {
        meta: { version: 1 },
        cooldowns: {}
      };
      fs.writeFileSync(this.filePath, JSON.stringify(initialData, null, 2), 'utf8');
    }
  }

  loadFromFile() {
    try {
      const data = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(data);
      const cooldowns = parsed.cooldowns || {};

      Object.entries(cooldowns).forEach(([tokenId, groups]) => {
        if (groups && typeof groups === 'object') {
          this.cooldowns.set(tokenId, groups);
        }
      });

      // Clean up expired cooldowns on startup
      this._cleanupExpired();
    } catch (error) {
      log.error('[CooldownManager] Failed to load cooldown state file:', error.message);
    }
  }

  saveToFile() {
    try {
      const cooldownsObj = {};
      this.cooldowns.forEach((groups, tokenId) => {
        // Only save entries with active cooldowns
        const validGroups = {};
        let hasValid = false;
        for (const [group, data] of Object.entries(groups)) {
          if (data && data.until && data.until > Date.now()) {
            validGroups[group] = data;
            hasValid = true;
          }
        }
        if (hasValid) {
          cooldownsObj[tokenId] = validGroups;
        }
      });

      const data = {
        meta: { version: 1 },
        cooldowns: cooldownsObj
      };
      fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf8');
    } catch (error) {
      log.error('[CooldownManager] Failed to save cooldown state file:', error.message);
    }
  }

  /**
   * Clean up expired cooldown states
   * @private
   */
  _cleanupExpired() {
    const now = Date.now();
    let cleaned = 0;

    this.cooldowns.forEach((groups, tokenId) => {
      for (const [group, data] of Object.entries(groups)) {
        if (data && data.until && data.until <= now) {
          groups[group] = null;
          cleaned++;
        }
      }
    });

    if (cleaned > 0) {
      log.info(`[CooldownManager] Cleaned up ${cleaned} expired cooldown states`);
      this.saveToFile();
    }
  }

  /**
   * Disable the specified model family for a token until the given timestamp
   * @param {string} tokenId - Token ID
   * @param {string} modelId - Model ID (used to determine model family)
   * @param {number} untilTimestamp - Cooldown end timestamp (milliseconds)
   */
  setCooldown(tokenId, modelId, untilTimestamp) {
    if (!tokenId || !untilTimestamp) return;

    const groupKey = getGroupKey(modelId);
    let groups = this.cooldowns.get(tokenId);

    if (!groups) {
      groups = {};
      this.cooldowns.set(tokenId, groups);
    }

    // Idempotency check: skip if an equal or later cooldown already exists
    const existing = groups[groupKey];
    if (existing && existing.until && existing.until >= untilTimestamp) {
      return; // A stricter cooldown already exists, no need to set again
    }

    groups[groupKey] = { until: untilTimestamp };

    const resetDate = new Date(untilTimestamp);
    log.warn(`[CooldownManager] Token ${tokenId} ${groupKey} family disabled, will recover at ${resetDate.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);

    this.saveToFile();
  }

  /**
   * Check whether the specified token is available for the given model (not in cooldown)
   * @param {string} tokenId - Token ID
   * @param {string} modelId - Model ID
   * @returns {boolean} true = available, false = in cooldown
   */
  isAvailable(tokenId, modelId) {
    if (!tokenId) return true;

    const groups = this.cooldowns.get(tokenId);
    if (!groups) return true;

    const groupKey = getGroupKey(modelId);
    const cooldown = groups[groupKey];

    if (!cooldown || !cooldown.until) return true;

    const now = Date.now();
    if (cooldown.until <= now) {
      // Cooldown expired, clear state
      groups[groupKey] = null;
      this.saveToFile();
      log.info(`[CooldownManager] Token ${tokenId} ${groupKey} family cooldown ended`);
      return true;
    }

    return false;
  }

  /**
   * Get the cooldown end timestamp for the specified token and model
   * @param {string} tokenId - Token ID
   * @param {string} modelId - Model ID
   * @returns {number|null} Cooldown end timestamp, or null if not in cooldown
   */
  getCooldownUntil(tokenId, modelId) {
    if (!tokenId) return null;

    const groups = this.cooldowns.get(tokenId);
    if (!groups) return null;

    const groupKey = getGroupKey(modelId);
    const cooldown = groups[groupKey];

    if (!cooldown || !cooldown.until) return null;

    const now = Date.now();
    if (cooldown.until <= now) {
      return null;
    }

    return cooldown.until;
  }

  /**
   * Clear the cooldown state for a specific token and model family
   * @param {string} tokenId - Token ID
   * @param {string} modelId - Model ID
   */
  clearCooldown(tokenId, modelId) {
    if (!tokenId) return;

    const groups = this.cooldowns.get(tokenId);
    if (!groups) return;

    const groupKey = getGroupKey(modelId);
    if (groups[groupKey]) {
      groups[groupKey] = null;
      log.info(`[CooldownManager] Cleared cooldown state for token ${tokenId} ${groupKey} family`);
      this.saveToFile();
    }
  }

  /**
   * Clear all cooldown states for a specific token
   * @param {string} tokenId - Token ID
   */
  clearAllCooldowns(tokenId) {
    if (!tokenId) return;

    if (this.cooldowns.has(tokenId)) {
      this.cooldowns.delete(tokenId);
      log.info(`[CooldownManager] Cleared all cooldown states for token ${tokenId}`);
      this.saveToFile();
    }
  }

  /**
   * Get all cooldown states (for admin UI display)
   * @returns {Object} All cooldown states
   */
  getAllCooldowns() {
    const result = {};
    const now = Date.now();

    this.cooldowns.forEach((groups, tokenId) => {
      const validGroups = {};
      for (const [group, data] of Object.entries(groups)) {
        if (data && data.until && data.until > now) {
          validGroups[group] = {
            until: data.until,
            untilFormatted: new Date(data.until).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
          };
        }
      }
      if (Object.keys(validGroups).length > 0) {
        result[tokenId] = validGroups;
      }
    });

    return result;
  }
}

const tokenCooldownManager = new TokenCooldownManager();
export default tokenCooldownManager;
