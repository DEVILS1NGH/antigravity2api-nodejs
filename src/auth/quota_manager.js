import fs from 'fs';
import path from 'path';
import { log } from '../utils/logger.js';
import { getDataDir } from '../utils/paths.js';
import { QUOTA_CACHE_TTL, QUOTA_CLEANUP_INTERVAL } from '../constants/index.js';
import { getGroupKey } from '../utils/modelGroups.js';

// Quota percentage consumed per request (differentiated by model family)
const REQUEST_COST_PERCENT = 0.6667;

// Quota percentage consumed per request for each model family
const GROUP_COST_PERCENT = {
  claude: 0.6667,
  gemini: 0.6667,
  banana: 5.0,    // Image generation models consume more, ~20 requests per full quota
  other: 0.6667
};

class QuotaManager {
  /**
   * @param {string} filePath - Path to the quota data file
   */
  constructor(filePath = path.join(getDataDir(), 'quotas.json')) {
    this.filePath = filePath;
    /** @type {Map<string, {lastUpdated: number, models: Object, requestCounts: Object, resetTimes: Object}>} */
    this.cache = new Map();
    this.CACHE_TTL = QUOTA_CACHE_TTL;
    this.CLEANUP_INTERVAL = QUOTA_CLEANUP_INTERVAL;
    this.cleanupTimer = null;
    this.ensureFileExists();
    this.loadFromFile();
    this.startCleanupTimer();
  }

  ensureFileExists() {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, JSON.stringify({ meta: { lastCleanup: Date.now(), ttl: this.CLEANUP_INTERVAL }, quotas: {} }, null, 2), 'utf8');
    }
  }

  loadFromFile() {
    try {
      const data = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(data);
      Object.entries(parsed.quotas || {}).forEach(([key, value]) => {
        // Ensure requestCounts and resetTimes fields exist
        if (!value.requestCounts) value.requestCounts = {};
        if (!value.resetTimes) value.resetTimes = {};
        this.cache.set(key, value);
      });
    } catch (error) {
      log.error('Failed to load quota file:', error.message);
    }
  }

  saveToFile() {
    try {
      const quotas = {};
      this.cache.forEach((value, key) => {
        quotas[key] = value;
      });
      const data = {
        meta: { lastCleanup: Date.now(), ttl: this.CLEANUP_INTERVAL },
        quotas
      };
      fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf8');
    } catch (error) {
      log.error('Failed to save quota file:', error.message);
    }
  }

  /**
   * Update quota data
   * @param {string} refreshToken - Token ID
   * @param {Object} quotas - Quota data
   */
  updateQuota(refreshToken, quotas) {
    const existing = this.cache.get(refreshToken) || {};
    const existingModels = existing.models || {};
    const existingRequestCounts = existing.requestCounts || {};
    const existingResetTimes = existing.resetTimes || {};

    // Check reset times and quota changes for each model group
    const newResetTimes = {};
    const newRequestCounts = { ...existingRequestCounts };

    // Track groups whose quota truly reset (for logging)
    const quotaResetGroups = new Set();

    // Track minimum remaining quota per group to detect quota changes
    const groupMinRemaining = {};
    const existingGroupMinRemaining = {};

    // Compute minimum remaining quota and reset time per group in the new data
    Object.entries(quotas || {}).forEach(([modelId, quotaData]) => {
      const groupKey = getGroupKey(modelId);
      const remaining = quotaData.r || 0;

      if (groupMinRemaining[groupKey] === undefined || remaining < groupMinRemaining[groupKey]) {
        groupMinRemaining[groupKey] = remaining;
      }

      const resetTimeRaw = quotaData.t;
      if (resetTimeRaw) {
        const newResetMs = Date.parse(resetTimeRaw);

        // Update reset time (keep the earliest one)
        if (!newResetTimes[groupKey] || newResetMs < Date.parse(newResetTimes[groupKey])) {
          newResetTimes[groupKey] = resetTimeRaw;
        }
      }
    });

    // Compute minimum remaining quota per group in the existing data
    Object.entries(existingModels).forEach(([modelId, quotaData]) => {
      const groupKey = getGroupKey(modelId);
      const remaining = quotaData.r || 0;

      if (existingGroupMinRemaining[groupKey] === undefined || remaining < existingGroupMinRemaining[groupKey]) {
        existingGroupMinRemaining[groupKey] = remaining;
      }
    });

    // Detect quota reset: only consider it a true reset when the previous reset time has passed
    const now = Date.now();
    for (const groupKey of Object.keys(groupMinRemaining)) {
      const newMin = groupMinRemaining[groupKey];
      const oldMin = existingGroupMinRemaining[groupKey];
      const oldResetTimeRaw = existingResetTimes[groupKey];
      const oldResetMs = oldResetTimeRaw ? Date.parse(oldResetTimeRaw) : null;

      // Condition 1: Previous reset time has passed (entered a new quota cycle)
      const resetTimePassed = oldResetMs && Number.isFinite(oldResetMs) && now > oldResetMs;

      // Condition 2: New quota is significantly higher than old quota (quota actually recovered)
      const quotaIncreased = oldMin !== undefined && newMin > oldMin + 0.05;

      if (resetTimePassed && existingRequestCounts[groupKey] > 0) {
        // Reset time has passed, clear request count
        newRequestCounts[groupKey] = 0;
        quotaResetGroups.add(groupKey);
      } else if (resetTimePassed && quotaIncreased) {
        // Reset time has passed and quota increased, clear request count
        newRequestCounts[groupKey] = 0;
        quotaResetGroups.add(groupKey);
      }
      // Note: If the reset time has not passed, do not reset counts even if the API returns a higher quota
      // This avoids false resets caused by fluctuations in official API responses
    }

    // Only log when quota truly resets
    if (quotaResetGroups.size > 0) {
      log.info(`[QuotaManager] Quota reset (reset time passed), clearing request counts: ${Array.from(quotaResetGroups).join(', ')}`);
    }

    this.cache.set(refreshToken, {
      lastUpdated: Date.now(),
      models: quotas,
      requestCounts: newRequestCounts,
      resetTimes: newResetTimes
    });
    this.saveToFile();
  }

  /**
   * Record a request
   * @param {string} refreshToken - Token ID
   * @param {string} modelId - Model ID used
   */
  recordRequest(refreshToken, modelId) {
    let data = this.cache.get(refreshToken);

    // Create a new cache entry if none exists
    if (!data) {
      data = {
        lastUpdated: Date.now(),
        models: {},
        requestCounts: {},
        resetTimes: {}
      };
      this.cache.set(refreshToken, data);
    }

    const groupKey = getGroupKey(modelId);
    if (!data.requestCounts) data.requestCounts = {};

    // Check if reset time has passed
    const resetTimeRaw = data.resetTimes?.[groupKey];
    if (resetTimeRaw) {
      const resetMs = Date.parse(resetTimeRaw);
      if (Date.now() > resetMs) {
        // Reset time has passed, reset count
        data.requestCounts[groupKey] = 0;
      }
    }

    data.requestCounts[groupKey] = (data.requestCounts[groupKey] || 0) + 1;
    this.saveToFile();
  }

  /**
   * Get quota data (including request counts and estimates)
   * @param {string} refreshToken - Token ID
   * @returns {Object|null} Quota data
   */
  getQuota(refreshToken) {
    const data = this.cache.get(refreshToken);
    if (!data) return null;

    // Check if cache has expired
    if (Date.now() - data.lastUpdated > this.CACHE_TTL) {
      return null;
    }

    return data;
  }

  /**
   * Get request counts for a specific token
   * @param {string} refreshToken - Token ID
   * @returns {Object} Request counts { claude: number, gemini: number, banana: number, other: number }
   */
  getRequestCounts(refreshToken) {
    const data = this.cache.get(refreshToken);
    return data?.requestCounts || {};
  }

  /**
   * Check whether a token has quota for a specific model group
   * @param {string} tokenId - Token ID
   * @param {string} modelId - Model ID
   * @returns {boolean} Whether quota is available (true = has quota or no data, false = quota is 0)
   */
  hasQuotaForModel(tokenId, modelId) {
    const data = this.cache.get(tokenId);
    if (!data || !data.models) {
      // No quota data, assume quota is available
      return true;
    }

    const groupKey = getGroupKey(modelId);

    // Use the minimum quota in this group to decide (consistent with getModelGroupQuota)
    let minRemaining = null;

    for (const [id, quotaData] of Object.entries(data.models)) {
      const idGroupKey = getGroupKey(id);
      if (idGroupKey === groupKey) {
        const remaining = quotaData.r || 0;
        if (minRemaining === null || remaining < minRemaining) {
          minRemaining = remaining;
        }
      }
    }

    // No model data found for this group, assume quota is available
    if (minRemaining === null) return true;

    // Minimum quota for this group is 0, meaning quota is exhausted
    return minRemaining > 0;
  }

  /**
   * Get the minimum quota for a model group
   * @param {string} tokenId - Token ID
   * @param {string} modelId - Model ID
   * @returns {number} Minimum quota for the group (0-1), or 1 if no data
   */
  getModelGroupQuota(tokenId, modelId) {
    const data = this.cache.get(tokenId);
    if (!data || !data.models) {
      return 1; // No data, assume full quota
    }

    const groupKey = getGroupKey(modelId);
    let minRemaining = 1;
    let found = false;

    for (const [id, quotaData] of Object.entries(data.models)) {
      const idGroupKey = getGroupKey(id);
      if (idGroupKey === groupKey) {
        found = true;
        const remaining = quotaData.r || 0;
        if (remaining < minRemaining) {
          minRemaining = remaining;
        }
      }
    }

    return found ? minRemaining : 1;
  }

  /**
   * Get the earliest recovery time for a model family
   * @param {string} tokenId - Token ID
   * @param {string} modelId - Model ID
   * @returns {{resetTime: number|null, hasData: boolean}} resetTime is a timestamp (ms), hasData indicates whether data exists for this family
   */
  getModelGroupResetTime(tokenId, modelId) {
    const data = this.cache.get(tokenId);
    if (!data || !data.models) {
      return { resetTime: null, hasData: false };
    }

    const groupKey = getGroupKey(modelId);
    let earliestReset = null;
    let found = false;

    for (const [id, quotaData] of Object.entries(data.models)) {
      const idGroupKey = getGroupKey(id);
      if (idGroupKey === groupKey) {
        found = true;
        const resetTimeRaw = quotaData.t;
        if (resetTimeRaw) {
          const resetMs = Date.parse(resetTimeRaw);
          if (Number.isFinite(resetMs)) {
            if (earliestReset === null || resetMs < earliestReset) {
              earliestReset = resetMs;
            }
          }
        }
      }
    }

    return { resetTime: earliestReset, hasData: found };
  }

  /**
   * Check whether quota data exists for the specified token
   * @param {string} tokenId - Token ID
   * @returns {boolean} Whether data exists
   */
  hasQuotaData(tokenId) {
    const data = this.cache.get(tokenId);
    return !!(data && data.models && Object.keys(data.models).length > 0);
  }

  /**
   * Calculate estimated remaining requests
   * @param {number} remainingFraction - Remaining quota fraction (0-1)
   * @param {number} requestCount - Number of requests already used
   * @param {string} [groupKey] - Model family key (used to get the corresponding consumption rate)
   * @returns {number} Estimated remaining requests
   */
  calculateEstimatedRequests(remainingFraction, requestCount = 0, groupKey = null) {
    // Use different consumption rates depending on model family
    const costPercent = (groupKey && GROUP_COST_PERCENT[groupKey]) || REQUEST_COST_PERCENT;
    // Calculate total available requests based on the current threshold
    const percentageValue = remainingFraction * 100;
    const totalFromThreshold = Math.floor(percentageValue / costPercent);
    // Subtract recorded request count
    return Math.max(0, totalFromThreshold - requestCount);
  }

  /**
   * Get model family consumption rate configuration (for frontend use)
   * @returns {Object} Consumption rates per family
   */
  static getGroupCostPercent() {
    return { ...GROUP_COST_PERCENT };
  }

  cleanup() {
    const now = Date.now();
    let cleaned = 0;

    this.cache.forEach((value, key) => {
      if (now - value.lastUpdated > this.CLEANUP_INTERVAL) {
        this.cache.delete(key);
        cleaned++;
      }
    });

    if (cleaned > 0) {
      log.info(`Cleaned up ${cleaned} expired quota records`);
      this.saveToFile();
    }
  }

  startCleanupTimer() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
    this.cleanupTimer = setInterval(() => this.cleanup(), this.CLEANUP_INTERVAL);
    // Use unref to avoid preventing process exit
    this.cleanupTimer.unref?.();
  }

  stopCleanupTimer() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  convertToBeijingTime(utcTimeStr) {
    if (!utcTimeStr) return 'N/A';
    try {
      const utcDate = new Date(utcTimeStr);
      return utcDate.toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Asia/Shanghai'
      });
    } catch (error) {
      return 'N/A';
    }
  }
}

const quotaManager = new QuotaManager();
export default quotaManager;
