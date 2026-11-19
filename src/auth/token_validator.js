import { log } from '../utils/logger.js';
import { generateTokenId } from '../utils/idGenerator.js';
import quotaManager from './quota_manager.js';
import tokenCooldownManager from './token_cooldown_manager.js';

/**
 * Token validator class
 * Responsible for various token validation checks
 */
class TokenValidator {
  constructor(store) {
    this.store = store;
  }

  /**
   * Check whether a token has quota for the specified model
   * @param {Object} token - Token object
   * @param {string} modelId - Model ID
   * @returns {Promise<boolean>} true = has quota or no data, false = quota is 0
   */
  async hasQuotaForModel(token, modelId) {
    if (!token || !modelId) return true;

    try {
      const salt = await this.store.getSalt();
      if (!salt) return true; // No salt, assume quota is available

      const tokenId = generateTokenId(token.refresh_token, salt);
      return quotaManager.hasQuotaForModel(tokenId, modelId);
    } catch (error) {
      // Assume quota is available on error
      log.warn(`Error checking quota: ${error.message}`);
      return true;
    }
  }

  /**
   * Check whether a token is in cooldown for the specified model
   * @param {Object} token - Token object
   * @param {string} modelId - Model ID
   * @returns {Promise<boolean>} true = available (not in cooldown), false = in cooldown
   */
  async isAvailableForModel(token, modelId) {
    if (!token || !modelId) return true;

    try {
      const salt = await this.store.getSalt();
      if (!salt) return true;

      const tokenId = generateTokenId(token.refresh_token, salt);
      return tokenCooldownManager.isAvailable(tokenId, modelId);
    } catch (error) {
      log.warn(`Error checking cooldown status: ${error.message}`);
      return true;
    }
  }

  /**
   * Check whether a token can be used for the specified model (both has quota and is not in cooldown)
   * @param {Object} token - Token object
   * @param {string} modelId - Model ID
   * @returns {Promise<boolean>} true = available, false = unavailable
   */
  async canUseForModel(token, modelId) {
    if (!token || !modelId) return true;

    // Check cooldown status first (stricter restriction)
    const isAvailable = await this.isAvailableForModel(token, modelId);
    if (!isAvailable) {
      return false;
    }

    // Then check quota
    return await this.hasQuotaForModel(token, modelId);
  }

  /**
   * Batch check whether multiple tokens are available for the specified model
   * @param {Array<{tokenId: string, token: Object}>} tokens - Array of tokens
   * @param {string} modelId - Model ID
   * @returns {Promise<Array<{tokenId: string, token: Object, available: boolean}>>} Check results
   */
  async checkTokensAvailability(tokens, modelId) {
    if (!modelId || tokens.length === 0) {
      return tokens.map(t => ({ ...t, available: true }));
    }

    const results = await Promise.all(
      tokens.map(async ({ tokenId, token }) => {
        const available = await this.canUseForModel(token, modelId);
        return { tokenId, token, available };
      })
    );

    return results;
  }

  /**
   * Filter tokens that are available for the specified model
   * @param {Array<{tokenId: string, token: Object}>} tokens - Array of tokens
   * @param {string} modelId - Model ID
   * @returns {Promise<Array<{tokenId: string, token: Object}>>} Array of available tokens
   */
  async filterAvailableTokens(tokens, modelId) {
    if (!modelId || tokens.length === 0) {
      return tokens;
    }

    const results = await this.checkTokensAvailability(tokens, modelId);
    return results.filter(r => r.available).map(r => ({ tokenId: r.tokenId, token: r.token }));
  }

  /**
   * Check whether all tokens are unavailable for the specified model (0 quota or in cooldown)
   * @param {Array<{tokenId: string, token: Object}>} tokens - Array of tokens
   * @param {string} modelId - Model ID
   * @returns {Promise<boolean>} true = all tokens are unavailable for this model
   */
  async areAllTokensExhausted(tokens, modelId) {
    if (!modelId || tokens.length === 0) return false;

    for (const { token } of tokens) {
      const canUse = await this.canUseForModel(token, modelId);
      if (canUse) {
        return false; // At least one token is available
      }
    }
    return true; // All tokens are unavailable
  }

  /**
   * Validate whether basic token fields are complete
   * Only refresh_token is required (access_token can be auto-refreshed;
   * missing expires_in/timestamp is treated as expired, triggering auto-refresh)
   * @param {Object} token - Token object
   * @returns {Object} Validation result {valid: boolean, missing: Array<string>}
   */
  validateTokenStructure(token) {
    const requiredFields = ['refresh_token'];
    const missing = [];

    for (const field of requiredFields) {
      if (!token[field]) {
        missing.push(field);
      }
    }

    return {
      valid: missing.length === 0,
      missing
    };
  }

  /**
   * Check whether a token is enabled
   * @param {Object} token - Token object
   * @returns {boolean} Whether enabled
   */
  isEnabled(token) {
    return token.enable !== false;
  }

  /**
   * Check whether a token has a projectId
   * @param {Object} token - Token object
   * @returns {boolean} Whether it has a projectId
   */
  hasProjectId(token) {
    return !!token.projectId;
  }

  /**
   * Check the overall quota flag on a token
   * @param {Object} token - Token object
   * @returns {boolean} Whether it has quota
   */
  hasQuota(token) {
    return token.hasQuota !== false;
  }

  /**
   * Comprehensive check of whether a token is ready for requests
   * @param {Object} token - Token object
   * @param {string} [modelId] - Optional model ID
   * @returns {Promise<{ready: boolean, reasons: Array<string>}>} Check result
   */
  async isTokenReady(token, modelId = null) {
    const reasons = [];

    // Check basic structure
    const structureCheck = this.validateTokenStructure(token);
    if (!structureCheck.valid) {
      reasons.push(`Missing required fields: ${structureCheck.missing.join(', ')}`);
    }

    // Check enabled status
    if (!this.isEnabled(token)) {
      reasons.push('Token is disabled');
    }

    // Check projectId
    if (!this.hasProjectId(token)) {
      reasons.push('Missing projectId');
    }

    // Check overall quota flag
    if (!this.hasQuota(token)) {
      reasons.push('Token is marked as having no quota');
    }

    // If modelId is provided, check model-specific availability
    if (modelId) {
      const canUse = await this.canUseForModel(token, modelId);
      if (!canUse) {
        reasons.push(`Unavailable for model ${modelId} (quota exhausted or in cooldown)`);
      }
    }

    return {
      ready: reasons.length === 0,
      reasons
    };
  }

  /**
   * Get health status report for a token
   * @param {Object} token - Token object
   * @param {string} tokenId - Token ID
   * @returns {Promise<Object>} Health status report
   */
  async getHealthReport(token, tokenId) {
    const report = {
      tokenId,
      enabled: this.isEnabled(token),
      hasProjectId: this.hasProjectId(token),
      hasQuota: this.hasQuota(token),
      structure: this.validateTokenStructure(token),
      timestamp: new Date().toISOString()
    };

    return report;
  }
}

export default TokenValidator;