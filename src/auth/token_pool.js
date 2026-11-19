import { log } from '../utils/logger.js';
import { generateTokenId } from '../utils/idGenerator.js';

/**
 * Token pool manager class
 * Responsible for token storage and basic operations, using a Map instead of array indices to avoid index invalidation issues
 */
class TokenPool {
  constructor(store) {
    this.store = store;
    /** @type {Map<string, Object>} key: tokenId, value: token object */
    this.tokens = new Map();
    /** @type {Set<string>} Set of enabled tokenIds */
    this.enabledTokens = new Set();
    /** @type {Set<string>} Set of tokenIds with available quota */
    this.quotaAvailableTokens = new Set();
    /** @type {boolean} Operation lock for transaction handling */
    this._locked = false;
  }

  /**
   * Generate a unique identifier for a token
   * @param {Object} token - Token object
   * @returns {Promise<string>} tokenId
   */
  async generateTokenId(token) {
    const salt = await this.store.getSalt();
    return generateTokenId(token.refresh_token, salt);
  }

  /**
   * Add a token to the pool
   * @param {Object} token - Token object
   * @returns {Promise<string>} Added tokenId
   */
  async add(token) {
    const tokenId = await this.generateTokenId(token);
    this.tokens.set(tokenId, token);
    
    if (token.enable !== false) {
      this.enabledTokens.add(tokenId);
    }
    
    if (token.hasQuota !== false) {
      this.quotaAvailableTokens.add(tokenId);
    }
    
    return tokenId;
  }

  /**
   * Batch add tokens
   * @param {Array<Object>} tokenArray - Array of tokens
   * @returns {Promise<Array<string>>} Array of added tokenIds
   */
  async addAll(tokenArray) {
    const tokenIds = [];
    for (const token of tokenArray) {
      const tokenId = await this.add(token);
      tokenIds.push(tokenId);
    }
    return tokenIds;
  }

  /**
   * Get a token by tokenId
   * @param {string} tokenId - Token ID
   * @returns {Object|null} Token object or null
   */
  get(tokenId) {
    return this.tokens.get(tokenId) || null;
  }

  /**
   * Find tokenId by refresh_token
   * @param {string} refreshToken - refresh_token
   * @returns {Promise<string|null>} tokenId or null
   */
  async findTokenId(refreshToken) {
    const salt = await this.store.getSalt();
    const expectedTokenId = generateTokenId(refreshToken, salt);
    return this.tokens.has(expectedTokenId) ? expectedTokenId : null;
  }

  /**
   * Find a token by refresh_token
   * @param {string} refreshToken - refresh_token
   * @returns {Promise<Object|null>} Token object or null
   */
  async findByRefreshToken(refreshToken) {
    const tokenId = await this.findTokenId(refreshToken);
    return tokenId ? this.get(tokenId) : null;
  }

  /**
   * Update a token
   * @param {string} tokenId - Token ID
   * @param {Object} updates - Fields to update
   * @returns {boolean} Whether the update succeeded
   */
  update(tokenId, updates) {
    const token = this.tokens.get(tokenId);
    if (!token) return false;

    // Update token data
    Object.assign(token, updates);

    // Update enabled state
    if (updates.enable !== undefined) {
      if (updates.enable) {
        this.enabledTokens.add(tokenId);
      } else {
        this.enabledTokens.delete(tokenId);
      }
    }

    // Update quota state
    if (updates.hasQuota !== undefined) {
      if (updates.hasQuota) {
        this.quotaAvailableTokens.add(tokenId);
      } else {
        this.quotaAvailableTokens.delete(tokenId);
      }
    }

    return true;
  }

  /**
   * Disable a token
   * @param {string} tokenId - Token ID
   * @returns {boolean} Whether the operation succeeded
   */
  disable(tokenId) {
    const token = this.tokens.get(tokenId);
    if (!token) return false;

    token.enable = false;
    this.enabledTokens.delete(tokenId);
    return true;
  }

  /**
   * Enable a token
   * @param {string} tokenId - Token ID
   * @returns {boolean} Whether the operation succeeded
   */
  enable(tokenId) {
    const token = this.tokens.get(tokenId);
    if (!token) return false;

    token.enable = true;
    this.enabledTokens.add(tokenId);
    return true;
  }

  /**
   * Mark a token's quota as exhausted
   * @param {string} tokenId - Token ID
   * @returns {boolean} Whether the operation succeeded
   */
  markQuotaExhausted(tokenId) {
    const token = this.tokens.get(tokenId);
    if (!token) return false;

    token.hasQuota = false;
    this.quotaAvailableTokens.delete(tokenId);
    return true;
  }

  /**
   * Restore a token's quota
   * @param {string} tokenId - Token ID
   * @returns {boolean} Whether the operation succeeded
   */
  restoreQuota(tokenId) {
    const token = this.tokens.get(tokenId);
    if (!token) return false;

    token.hasQuota = true;
    this.quotaAvailableTokens.add(tokenId);
    return true;
  }

  /**
   * Remove a token
   * @param {string} tokenId - Token ID
   * @returns {boolean} Whether the operation succeeded
   */
  remove(tokenId) {
    const result = this.tokens.delete(tokenId);
    if (result) {
      this.enabledTokens.delete(tokenId);
      this.quotaAvailableTokens.delete(tokenId);
    }
    return result;
  }

  /**
   * Clear the pool
   */
  clear() {
    this.tokens.clear();
    this.enabledTokens.clear();
    this.quotaAvailableTokens.clear();
  }

  /**
   * Get all enabled tokens
   * @returns {Array<Object>} Array of tokens
   */
  getEnabled() {
    return Array.from(this.enabledTokens).map(id => this.tokens.get(id));
  }

  /**
   * Get all tokens with available quota
   * @returns {Array<Object>} Array of tokens
   */
  getWithQuota() {
    return Array.from(this.quotaAvailableTokens).map(id => this.tokens.get(id));
  }

  /**
   * Get all tokens that are both enabled and have available quota
   * @returns {Array<Object>} Array of tokens
   */
  getEnabledWithQuota() {
    const enabledWithQuota = new Set(
      [...this.enabledTokens].filter(id => this.quotaAvailableTokens.has(id))
    );
    return Array.from(enabledWithQuota).map(id => this.tokens.get(id));
  }

  /**
   * Get all tokens
   * @returns {Array<Object>} Array of tokens
   */
  getAll() {
    return Array.from(this.tokens.values());
  }

  /**
   * Get all tokenIds
   * @returns {Array<string>} Array of tokenIds
   */
  getAllIds() {
    return Array.from(this.tokens.keys());
  }

  /**
   * Get enabled tokenIds
   * @returns {Array<string>} Array of tokenIds
   */
  getEnabledIds() {
    return Array.from(this.enabledTokens);
  }

  /**
   * Get tokenIds with available quota
   * @returns {Array<string>} Array of tokenIds
   */
  getQuotaAvailableIds() {
    return Array.from(this.quotaAvailableTokens);
  }

  /**
   * Get tokenIds that are both enabled and have available quota
   * @returns {Array<string>} Array of tokenIds
   */
  getEnabledWithQuotaIds() {
    return [...this.enabledTokens].filter(id => this.quotaAvailableTokens.has(id));
  }

  /**
   * Check whether a token exists
   * @param {string} tokenId - Token ID
   * @returns {boolean} Whether it exists
   */
  has(tokenId) {
    return this.tokens.has(tokenId);
  }

  /**
   * Check whether a token is enabled
   * @param {string} tokenId - Token ID
   * @returns {boolean} Whether it is enabled
   */
  isEnabled(tokenId) {
    return this.enabledTokens.has(tokenId);
  }

  /**
   * Check whether a token has quota
   * @param {string} tokenId - Token ID
   * @returns {boolean} Whether it has quota
   */
  hasQuota(tokenId) {
    return this.quotaAvailableTokens.has(tokenId);
  }

  /**
   * Get the pool size
   * @returns {number} Total number of tokens
   */
  size() {
    return this.tokens.size;
  }

  /**
   * Get the number of enabled tokens
   * @returns {number} Number of enabled tokens
   */
  enabledSize() {
    return this.enabledTokens.size;
  }

  /**
   * Get the number of tokens with available quota
   * @returns {number} Number of tokens with quota
   */
  quotaAvailableSize() {
    return this.quotaAvailableTokens.size;
  }

  /**
   * Reset quota status for all tokens
   */
  resetAllQuotas() {
    log.warn('Resetting quota status for all tokens');
    for (const token of this.tokens.values()) {
      token.hasQuota = true;
    }
    // Rebuild quota-available set
    this.quotaAvailableTokens.clear();
    for (const tokenId of this.tokens.keys()) {
      this.quotaAvailableTokens.add(tokenId);
    }
  }

  /**
   * Execute a transactional operation (with lock)
   * @param {Function} fn - Operation function to execute
   * @returns {Promise<any>} Operation result
   */
  async transaction(fn) {
    // Simple spin lock
    while (this._locked) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }

    this._locked = true;
    try {
      return await fn();
    } finally {
      this._locked = false;
    }
  }

  /**
   * Disable a token inside a transaction
   * @param {string} tokenId - Token ID
   * @returns {Promise<boolean>} Whether the operation succeeded
   */
  async disableWithTransaction(tokenId) {
    return this.transaction(() => {
      return this.disable(tokenId);
    });
  }

  /**
   * Remove a token inside a transaction
   * @param {string} tokenId - Token ID
   * @returns {Promise<boolean>} Whether the operation succeeded
   */
  async removeWithTransaction(tokenId) {
    return this.transaction(() => {
      return this.remove(tokenId);
    });
  }
}

export default TokenPool;