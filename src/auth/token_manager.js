import { log } from '../utils/logger.js';
import { generateSessionId, generateInstanceId } from '../utils/idGenerator.js';
import config, { getConfigJson } from '../config/config.js';
import { DEFAULT_REQUEST_COUNT_PER_TOKEN } from '../constants/index.js';
import TokenStore from './token_store.js';
import TokenPool from './token_pool.js';
import TokenLifecycleManager from './token_lifecycle_manager.js';
import ProjectIdFetcher from './project_id_fetcher.js';
import TokenValidator from './token_validator.js';
import { StrategyFactory, RotationStrategy } from './token_rotation_strategy.js';
import { TokenError } from '../utils/errors.js';
import quotaManager from './quota_manager.js';
import tokenCooldownManager from './token_cooldown_manager.js';
import { randomUUID } from 'crypto';

/**
 * Token Manager (refactored)
 * Responsible for token storage, rotation, refreshing, and related operations
 */
class TokenManager {
  /**
   * @param {string} filePath - Path to token data file
   */
  constructor(filePath) {
    // Core components
    this.store = new TokenStore(filePath);
    this.pool = new TokenPool(this.store);
    this.lifecycle = new TokenLifecycleManager(this.store);
    this.projectIdFetcher = new ProjectIdFetcher();
    this.validator = new TokenValidator(this.store);

    // Rotation strategy
    this.strategy = null;
    this.rotationStrategyName = RotationStrategy.ROUND_ROBIN;
    this.requestCountPerToken = DEFAULT_REQUEST_COUNT_PER_TOKEN;

    // Initialization state
    this._initPromise = null;
  }

  /**
   * Normalize a token object to ensure all required fields exist
   * - sessionId: must be freshly generated on each startup (represents an IDE session validated upstream)
   * - instanceId/deviceId: keep existing value if present; generate only if missing or empty
   * - sub: keep existing value if present (subsequent fetchProjectId will overwrite with upstream value)
   * - boolean fields use ?? to preserve explicit false values
   * @param {Object} token - Raw token object
   * @returns {Object} Normalized token object
   * @private
   */
  static _normalizeToken(token) {
    return {
      ...token,
      sessionId: generateSessionId(),
      instanceId: token.instanceId || generateInstanceId(),
      deviceId: token.deviceId || randomUUID(),
      sub: token.sub || 'g1-pro-tier',
      hasQuota: token.hasQuota ?? true,
      enable: token.enable ?? true,
    };
  }

  /**
   * Initialize the token manager
   * @private
   */
  async _initialize() {
    try {
      log.info('Initializing token manager...');

      // 1. Read all tokens
      const tokenArray = await this.store.readAll();

      // 2. Clear the pool and reload
      this.pool.clear();

      // 3. Load all tokens into the pool; enabled state is managed separately by TokenPool
      const normalizedTokens = tokenArray.map(TokenManager._normalizeToken);

      // 4. Batch add to the pool
      await this.pool.addAll(normalizedTokens);

      // 5. Load rotation strategy configuration
      this._loadRotationConfig();

      // 6. Create rotation strategy instance
      this.strategy = StrategyFactory.create(this.rotationStrategyName, {
        requestCountPerToken: this.requestCountPerToken
      });

      // 7. Log summary
      const poolSize = this.pool.size();
      const enabledCount = this.pool.getEnabledIds().length;
      if (poolSize === 0) {
        log.warn('⚠ No available accounts. Please add accounts using one of the following methods:');
        log.warn('  Method 1: Run npm run login to sign in');
        log.warn('  Method 2: Visit the frontend admin page to add accounts');
      } else {
        log.info(`Loaded ${poolSize} tokens (${enabledCount} enabled, ${poolSize - enabledCount} disabled)`);
        if (this.rotationStrategyName === RotationStrategy.REQUEST_COUNT) {
          log.info(`Rotation strategy: ${this.rotationStrategyName}, switching after ${this.requestCountPerToken} requests per token`);
        } else {
          log.info(`Rotation strategy: ${this.rotationStrategyName}`);
        }

        // 8. Only refresh enabled and expired tokens
        if (enabledCount > 0) {
          await this._refreshExpiredTokens();
          await this._syncMissingCreditsForEnabledTokens();
        }
      }
    } catch (error) {
      log.error('Failed to initialize tokens:', error.message);
      this.pool.clear();
    }
  }

  /**
   * Load rotation strategy configuration
   * @private
   */
  _loadRotationConfig() {
    try {
      const jsonConfig = getConfigJson();
      if (jsonConfig.rotation) {
        this.rotationStrategyName = jsonConfig.rotation.strategy || RotationStrategy.ROUND_ROBIN;
        this.requestCountPerToken = jsonConfig.rotation.requestCount || DEFAULT_REQUEST_COUNT_PER_TOKEN;
      }
    } catch (error) {
      log.warn('Failed to load rotation config, using defaults:', error.message);
    }
  }

  /**
   * Refresh all expired tokens
   * @private
   */
  async _refreshExpiredTokens() {
    // Get all enabled tokens
    const allTokens = this.pool.getEnabledIds().map(tokenId => ({
      tokenId,
      token: this.pool.get(tokenId)
    }));

    // Filter expired tokens
    const expiredTokens = this.lifecycle.getExpiredTokens(allTokens);

    if (expiredTokens.length === 0) {
      return;
    }

    // Refresh concurrently
    const { tokensToDisable } = await this.lifecycle.refreshTokensConcurrently(expiredTokens);

    // Disable invalid tokens
    for (const { token, tokenId } of tokensToDisable) {
      await this._disableTokenInternal(tokenId);
    }
  }

  /**
   * Automatically backfill credits info for enabled tokens that are missing it
   * @private
   */
  async _syncMissingCreditsForEnabledTokens() {
    const tokenIds = this.pool.getEnabledIds().filter(tokenId => {
      const token = this.pool.get(tokenId);
      return token && token.sub !== 'free-tier' && (token.credits === null || token.credits === undefined);
    });

    if (tokenIds.length === 0) {
      return;
    }

    log.info(`Detected ${tokenIds.length} enabled tokens missing credits info, starting automatic sync`);

    const results = await Promise.allSettled(tokenIds.map(async (tokenId) => {
      const token = this.pool.get(tokenId);
      if (!token) return false;

      const subscriptionInfo = await this.projectIdFetcher.fetchSubscriptionAndCredits(token);
      if (subscriptionInfo.fetched === false) {
        return false;
      }

      this.pool.update(tokenId, {
        sub: subscriptionInfo.sub || 'free-tier',
        credits: subscriptionInfo.credits ?? null
      });
      await this._persistToken(token);
      return true;
    }));

    const successCount = results.filter(result => result.status === 'fulfilled' && result.value === true).length;
    const failCount = tokenIds.length - successCount;

    if (successCount > 0) {
      log.info(`Automatic credits sync complete: ${successCount} succeeded${failCount > 0 ? `, ${failCount} failed` : ''}`);
    } else if (failCount > 0) {
      log.warn(`Automatic credits sync failed: ${failCount} total`);
    }
  }

  /**
   * Ensure initialization has completed
   * @private
   */
  async _ensureInitialized() {
    if (!this._initPromise) {
      this._initPromise = this._initialize();
    }
    return this._initPromise;
  }

  /**
   * Internally disable a token (without persisting)
   * @param {string} tokenId - Token ID
   * @private
   */
  async _disableTokenInternal(tokenId) {
    this.pool.disable(tokenId);
    log.warn(`Token ${tokenId} has been disabled`);
  }

  /**
   * Get enabled token entries
   * @returns {Array<{tokenId: string, token: Object}>}
   * @private
   */
  _getEnabledTokenEntries() {
    return this.pool.getEnabledIds().map(tokenId => ({
      tokenId,
      token: this.pool.get(tokenId)
    }));
  }

  /**
   * Filter available tokens by model; only reset stale quota flags when allowed, and re-verify cooldown status after reset.
   * @param {string} modelId - Model ID
   * @param {Object} options - Filtering options
   * @param {boolean} options.allowQuotaReset - Whether to allow resetting hasQuota flags and retrying filtering
   * @returns {Promise<Array<{tokenId: string, token: Object}>>}
   * @private
   */
  async _getAvailableTokenEntries(modelId, { allowQuotaReset = true } = {}) {
    const enabledTokens = this._getEnabledTokenEntries();

    if (enabledTokens.length === 0) {
      log.error('No available tokens');
      return [];
    }

    if (!modelId) {
      return enabledTokens;
    }

    let availableTokens = await this.validator.filterAvailableTokens(enabledTokens, modelId);
    if (availableTokens.length > 0) {
      return availableTokens;
    }

    if (allowQuotaReset) {
      log.warn(`No tokens available for model ${modelId}, resetting local quota flags and re-verifying`);
      this.pool.resetAllQuotas();
      availableTokens = await this.validator.filterAvailableTokens(this._getEnabledTokenEntries(), modelId);
    }

    if (availableTokens.length === 0) {
      log.error(`No tokens available for model ${modelId}`);
    }

    return availableTokens;
  }

  /**
   * Select one token from available tokens and refresh it if necessary.
   * @param {string} modelId - Model ID
   * @param {Object} options - Selection options
   * @param {boolean} options.allowQuotaReset - Whether to allow resetting local quota flags
   * @param {string|null} options.excludeTokenId - Exclude this token when other candidates exist
   * @returns {Promise<Object|null>} Token object or null
   * @private
   */
  async _selectToken(modelId, { allowQuotaReset = true, excludeTokenId = null } = {}) {
    await this._ensureInitialized();

    let availableTokens = await this._getAvailableTokenEntries(modelId, { allowQuotaReset });
    if (excludeTokenId && availableTokens.length > 1) {
      availableTokens = availableTokens.filter(({ tokenId }) => tokenId !== excludeTokenId);
    }

    const selected = this.strategy.selectToken(availableTokens);
    if (!selected) return null;

    const { token, tokenId } = selected;

    if (this.lifecycle.isExpired(token)) {
      try {
        await this.lifecycle.refreshToken(token, tokenId);
        await this._persistToken(token);
      } catch (error) {
        log.error(`Failed to refresh token: ${error.message}`);
        if (error.statusCode === 403 || error.statusCode === 400) {
          await this.disableToken(token);
        }
        return this._selectToken(modelId, { allowQuotaReset: false, excludeTokenId });
      }
    }

    const shouldSwitch = this.strategy.recordUsage(tokenId);

    if (shouldSwitch && this.rotationStrategyName === RotationStrategy.REQUEST_COUNT) {
      this.strategy.switchToNext(availableTokens.length, tokenId);
    }

    return token;
  }

  /**
   * Get the next available token (legacy compatibility)
   * @param {string} modelId - Model ID
   * @returns {Promise<Object|null>} Token object or null
   */
  async getNextToken(modelId) {
    return this.getToken(modelId);
  }

  /**
   * Get an available token
   * @param {string} modelId - Model ID
   * @returns {Promise<Object|null>} Token object or null
   */
  async getToken(modelId) {
    return this._selectToken(modelId, { allowQuotaReset: true });
  }

  /**
   * Re-select an available token for the current model group before retrying.
   * Does not reset local quota flags; avoids the token that just failed if other candidates exist.
   * @param {string} modelId - Model ID
   * @param {string|null} previousTokenId - Token ID that just failed
   * @returns {Promise<Object|null>} Token object or null
   */
  async getTokenForRetry(modelId, previousTokenId = null) {
    return this._selectToken(modelId, {
      allowQuotaReset: false,
      excludeTokenId: previousTokenId
    });
  }

  /**
   * Persist a single token
   * @param {Object} token - Token object
   * @private
   */
  async _persistToken(token) {
    try {
      const allTokens = await this.store.readAll();
      const tokenId = await this.pool.generateTokenId(token);
      let index = -1;

      for (let i = 0; i < allTokens.length; i++) {
        const currentTokenId = await this.pool.generateTokenId(allTokens[i]);
        if (currentTokenId === tokenId) {
          index = i;
          break;
        }
      }

      if (index !== -1) {
        allTokens[index] = token;
        await this.store.writeAll(allTokens);
      }
    } catch (error) {
      log.error(`Failed to persist token: ${error.message}`);
    }
  }

  /**
   * Add a new token
   * @param {Object} tokenData - Token data
   * @returns {Promise<Object>} Added token
   */
  async addToken(tokenData) {
    await this._ensureInitialized();

    // 1. Fetch projectId, subscription, and credits info
    const fetchResult = await this.projectIdFetcher.fetchProjectId(tokenData);
    const { projectId, sub, credits } = fetchResult;

    // If fetchProjectId did not return credits, fall back to tokenData.credits
    let finalCredits = credits !== undefined ? credits : tokenData.credits;
    if (finalCredits === undefined) finalCredits = null;

    // 2. Build complete token object
    const token = {
      ...tokenData,
      projectId,
      sub,
      credits: finalCredits,
      enable: true,
      hasQuota: true,
      sessionId: generateSessionId(),
      instanceId: generateInstanceId(),
      deviceId: randomUUID()
    };

    // 3. Add to pool
    const tokenId = await this.pool.add(token);

    // 4. Persist
    const allTokens = await this.store.readAll();
    allTokens.push(token);
    await this.store.writeAll(allTokens);

    log.info(`Token ${tokenId} added successfully`);
    return token;
  }

  /**
   * Disable a token
   * @param {Object} token - Token object
   */
  async disableToken(token) {
    const tokenId = await this.pool.findTokenId(token.refresh_token);
    if (!tokenId) {
      log.warn('Attempted to disable a non-existent token');
      return;
    }

    // 1. Disable in pool
    this.pool.disable(tokenId);

    // 2. Persist
    try {
      const allTokens = await this.store.readAll();
      let index = -1;

      for (let i = 0; i < allTokens.length; i++) {
        const currentTokenId = await this.pool.generateTokenId(allTokens[i]);
        if (currentTokenId === tokenId) {
          index = i;
          break;
        }
      }

      if (index !== -1) {
        allTokens[index].enable = false;
        await this.store.writeAll(allTokens);
      }
    } catch (error) {
      log.error(`Failed to persist disabled state: ${error.message}`);
    }

    log.warn(`Token ${tokenId} has been disabled`);
  }

  /**
   * Mark a token's quota as exhausted
   * @param {Object} token - Token object
   */
  async markTokenQuotaExhausted(token) {
    const tokenId = await this.pool.findTokenId(token.refresh_token);
    if (!tokenId) {
      return;
    }

    this.pool.markQuotaExhausted(tokenId);

    // If using the quota_exhausted strategy, switch to the next token
    if (this.rotationStrategyName === RotationStrategy.QUOTA_EXHAUSTED) {
      const totalTokens = this.pool.getEnabledWithQuotaIds().length;
      this.strategy.switchToNext(totalTokens);
    }
  }

  /**
   * Refresh the specified token
   * @param {Object} token - Token object
   * @param {boolean} silent - Whether to run in silent mode
   * @returns {Promise<Object>} Refreshed token
   */
  async refreshToken(token, silent = false) {
    const tokenId = await this.pool.findTokenId(token.refresh_token);
    if (!tokenId) {
      throw new TokenError('Token does not exist', null, 404);
    }

    await this.lifecycle.refreshToken(token, tokenId, silent);
    await this._persistToken(token);

    return token;
  }

  /**
   * Check whether a token is expired
   * @param {Object} token - Token object
   * @returns {boolean} Whether expired
   */
  isExpired(token) {
    return this.lifecycle.isExpired(token);
  }

  /**
   * Reload all tokens
   */
  async reload() {
    this._initPromise = null;
    await this._ensureInitialized();
  }

  /**
   * Update rotation strategy configuration
   * @param {string} strategy - Strategy name
   * @param {number} requestCount - Request count (only used for request_count strategy)
   */
  updateRotationConfig(strategy, requestCount) {
    if (strategy && StrategyFactory.isValidStrategy(strategy)) {
      this.rotationStrategyName = strategy;
      this.strategy = StrategyFactory.create(strategy, {
        requestCountPerToken: requestCount || this.requestCountPerToken
      });

      if (requestCount && requestCount > 0) {
        this.requestCountPerToken = requestCount;
      }

      if (this.rotationStrategyName === RotationStrategy.REQUEST_COUNT) {
        log.info(`Rotation strategy updated: ${this.rotationStrategyName}, switching after ${this.requestCountPerToken} requests per token`);
      } else {
        log.info(`Rotation strategy updated: ${this.rotationStrategyName}`);
      }
    }
  }

  /**
   * Get rotation strategy configuration
   * @returns {Object} Configuration object
   */
  getRotationConfig() {
    const currentIndex = Number.isInteger(this.strategy?.currentIndex)
      ? this.strategy.currentIndex
      : 0;

    return {
      strategy: this.rotationStrategyName,
      requestCount: this.requestCountPerToken,
      currentIndex
    };
  }

  /**
   * Record a request (for quota management)
   * @param {Object} token - Token object
   * @param {string} modelId - Model ID
   */
  async recordRequest(token, modelId) {
    if (!token || !modelId) return;

    try {
      const tokenId = await this.pool.generateTokenId(token);
      quotaManager.recordRequest(tokenId, modelId);
    } catch (error) {
      // Recording failure does not affect the request
      log.warn('Failed to record request count:', error.message);
    }
  }

  /**
   * Get list of all tokens (excluding sensitive fields)
   * @returns {Promise<Array>} Token list
   */
  async getTokenList() {
    try {
      await this._ensureInitialized();
      const salt = await this.store.getSalt();

      return this.pool.getAllIds().map(tokenId => {
        const token = this.pool.get(tokenId);
        return {
          id: tokenId,
          expires_in: token.expires_in,
          timestamp: token.timestamp,
          enable: token.enable !== false,
          projectId: token.projectId || null,
          email: token.email || null,
          hasQuota: token.hasQuota !== false,
          sub: token.sub || null,
          credits: token.credits !== null && token.credits !== undefined ? token.credits : null
        };
      });
    } catch (error) {
      log.error('Failed to get token list:', error.message);
      return [];
    }
  }

  /**
   * Find token by tokenId
   * @param {string} tokenId - Token ID
   * @returns {Promise<Object|null>} Token object or null
   */
  async findTokenById(tokenId) {
    await this._ensureInitialized();
    return this.pool.get(tokenId);
  }

  /**
   * Update token by tokenId
   * @param {string} tokenId - Token ID
   * @param {Object} updates - Fields to update
   * @returns {Promise<Object>} Operation result
   */
  async updateTokenById(tokenId, updates) {
    try {
      await this._ensureInitialized();

      const tokenBeforeUpdate = this.pool.get(tokenId);
      if (!tokenBeforeUpdate) {
        return { success: false, message: 'Token does not exist' };
      }

      const wasEnabled = tokenBeforeUpdate.enable !== false;

      // Update token in pool
      const success = this.pool.update(tokenId, updates);
      if (!success) {
        return { success: false, message: 'Token does not exist' };
      }

      // Persist
      const token = this.pool.get(tokenId);
      await this._persistToken(token);

      const isEnabling = updates.enable === true && !wasEnabled;
      if (isEnabling) {
        let syncedCredits = false;

        try {
          if (this.lifecycle.isExpired(token)) {
            await this.lifecycle.refreshToken(token, tokenId);
            await this._persistToken(token);
          }

          const subscriptionInfo = await this.refreshSubscriptionAndCreditsById(tokenId);
          syncedCredits = subscriptionInfo.fetched !== false;
        } catch (error) {
          log.warn(`Failed to auto-sync credits after enabling token (${tokenId}): ${error.message}`);
        }

        return {
          success: true,
          message: syncedCredits ? 'Token enabled successfully, credits synced automatically' : 'Token enabled successfully, but credits sync failed',
          syncedCredits
        };
      }

      return { success: true, message: 'Token updated successfully' };
    } catch (error) {
      log.error('Failed to update token:', error.message);
      return { success: false, message: error.message };
    }
  }

  /**
   * Delete token by tokenId
   * @param {string} tokenId - Token ID
   * @returns {Promise<Object>} Operation result
   */
  async deleteTokenById(tokenId) {
    try {
      await this._ensureInitialized();

      // Remove from pool
      const success = this.pool.remove(tokenId);
      if (!success) {
        return { success: false, message: 'Token does not exist' };
      }

      // Persist
      const allTokens = await this.store.readAll();
      const filteredTokens = [];
      for (const token of allTokens) {
        const tid = await this.pool.generateTokenId(token);
        if (tid !== tokenId) {
          filteredTokens.push(token);
        }
      }

      await this.store.writeAll(filteredTokens);

      return { success: true, message: 'Token deleted successfully' };
    } catch (error) {
      log.error('Failed to delete token:', error.message);
      return { success: false, message: error.message };
    }
  }

  /**
   * Refresh token by tokenId
   * @param {string} tokenId - Token ID
   * @returns {Promise<Object>} Refreshed token info
   */
  async refreshTokenById(tokenId) {
    await this._ensureInitialized();

    const token = this.pool.get(tokenId);
    if (!token) {
      throw new TokenError('Token does not exist', null, 404);
    }

    await this.lifecycle.refreshToken(token, tokenId);
    await this._persistToken(token);

    return {
      expires_in: token.expires_in,
      timestamp: token.timestamp
    };
  }

  /**
   * Refresh subscription and credits info by tokenId
   * @param {string} tokenId - Token ID
   * @returns {Promise<{sub: string, credits: number|null, isActivated: boolean}>}
   */
  async refreshSubscriptionAndCreditsById(tokenId) {
    await this._ensureInitialized();

    const token = this.pool.get(tokenId);
    if (!token) {
      throw new TokenError('Token does not exist', null, 404);
    }

    const subscriptionInfo = await this.projectIdFetcher.fetchSubscriptionAndCredits(token);
    if (!subscriptionInfo.fetched) {
      return {
        sub: token.sub || 'free-tier',
        credits: token.credits ?? null,
        isActivated: false,
        fetched: false
      };
    }

    const updates = {
      sub: subscriptionInfo.sub || 'free-tier',
      credits: subscriptionInfo.credits ?? null
    };

    this.pool.update(tokenId, updates);
    await this._persistToken(token);

    return {
      ...subscriptionInfo,
      ...updates,
      fetched: true
    };
  }

  /**
   * Get salt value
   * @returns {Promise<string>} Salt value
   */
  async getSalt() {
    return this.store.getSalt();
  }

  /**
   * Get tokenId from token object
   * @param {Object} token - Token object
   * @returns {Promise<string|null>} tokenId
   */
  async getTokenId(token) {
    if (!token?.refresh_token) return null;
    try {
      return await this.pool.findTokenId(token.refresh_token);
    } catch (error) {
      log.error(`Failed to generate tokenId: ${error.message}`);
      return null;
    }
  }

  /**
   * Fetch projectId (legacy API compatibility)
   * @param {Object} token - Token object
   * @returns {Promise<Object>} {projectId, sub}
   */
  async fetchProjectId(token) {
    return this.projectIdFetcher.fetchProjectId(token);
  }

  /**
   * Fetch and update projectId by tokenId
   * @param {string} tokenId - Token ID
   * @returns {Promise<Object>} Result containing projectId
   */
  async fetchProjectIdForToken(tokenId) {
    await this._ensureInitialized();

    const token = this.pool.get(tokenId);
    if (!token) {
      throw new TokenError('Token does not exist', null, 404);
    }

    // Ensure token is not expired
    if (this.lifecycle.isExpired(token)) {
      await this.lifecycle.refreshToken(token, tokenId);
      await this._persistToken(token);
    }

    const { projectId, sub } = await this.projectIdFetcher.fetchProjectId(token);
    if (!projectId) {
      throw new TokenError('Unable to fetch projectId; this account may not be eligible', null, 400);
    }

    // Update token
    this.pool.update(tokenId, {
      projectId,
      sub,
      hasQuota: true
    });

    // Persist
    await this._persistToken(token);

    return { projectId };
  }
}

// Export strategy enum (backward compatibility)
export { RotationStrategy };

const tokenManager = new TokenManager();
export default tokenManager;
