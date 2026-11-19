import { log } from '../utils/logger.js';

/**
 * Base class for token rotation strategies
 */
class TokenRotationStrategy {
  /**
   * Select one token from the list of available tokens
   * @param {Array<{tokenId: string, token: Object}>} tokens - List of available tokens
   * @param {Object} context - Context info
   * @returns {Object|null} Selected token info {tokenId, token}
   */
  selectToken(tokens, context) {
    throw new Error('Must implement selectToken');
  }

  /**
   * Record usage for this request
   * @param {string} tokenId - Token ID that was used
   */
  recordUsage(tokenId) {
    // Default implementation: no-op
  }

  /**
   * Reset strategy state
   */
  reset() {
    // Default implementation: stateless
  }

  /**
   * Get strategy name
   * @returns {string} Strategy name
   */
  getName() {
    return this.constructor.name;
  }
}

/**
 * Rotation strategy: Round Robin (load balancing)
 * Switches to the next token on every request
 */
class RoundRobinStrategy extends TokenRotationStrategy {
  constructor() {
    super();
    this.currentIndex = 0;
  }

  selectToken(tokens, context) {
    if (tokens.length === 0) return null;
    
    const selected = tokens[this.currentIndex % tokens.length];
    this.currentIndex = (this.currentIndex + 1) % tokens.length;
    
    return selected;
  }

  reset() {
    this.currentIndex = 0;
  }

  getName() {
    return 'round_robin';
  }
}

/**
 * Rotation strategy: Quota Exhausted (switch only when quota is exhausted)
 * Uses one token until its quota is exhausted, then switches to the next
 */
class QuotaExhaustedStrategy extends TokenRotationStrategy {
  constructor() {
    super();
    this.currentIndex = 0;
  }

  selectToken(tokens, context) {
    if (tokens.length === 0) return null;
    
    // Always return the token at the current index without auto-switching
    // Switching is triggered externally via switchToNext()
    const selected = tokens[this.currentIndex % tokens.length];
    return selected;
  }

  /**
   * Switch to the next token
   * @param {number} totalTokens - Total number of tokens
   */
  switchToNext(totalTokens) {
    if (totalTokens > 0) {
      this.currentIndex = (this.currentIndex + 1) % totalTokens;
    }
  }

  reset() {
    this.currentIndex = 0;
  }

  getName() {
    return 'quota_exhausted';
  }
}

/**
 * Rotation strategy: Request Count
 * Switches after each token handles a fixed number of requests
 */
class RequestCountStrategy extends TokenRotationStrategy {
  constructor(requestCountPerToken = 10) {
    super();
    this.requestCountPerToken = requestCountPerToken;
    this.currentIndex = 0;
    /** @type {Map<string, number>} */
    this.tokenRequestCounts = new Map();
  }

  selectToken(tokens, context) {
    if (tokens.length === 0) return null;
    
    const selected = tokens[this.currentIndex % tokens.length];
    return selected;
  }

  recordUsage(tokenId) {
    const current = this.tokenRequestCounts.get(tokenId) || 0;
    const newCount = current + 1;
    this.tokenRequestCounts.set(tokenId, newCount);
    
    // If threshold is reached, signal that a switch is needed
    if (newCount >= this.requestCountPerToken) {
      return true; // Return true to indicate switching is needed
    }
    return false;
  }

  /**
   * Switch to the next token
   * @param {number} totalTokens - Total number of tokens
   * @param {string} currentTokenId - Current tokenId
   */
  switchToNext(totalTokens, currentTokenId) {
    if (totalTokens > 0) {
      this.currentIndex = (this.currentIndex + 1) % totalTokens;
      // Reset the request count for the current token
      if (currentTokenId) {
        this.tokenRequestCounts.set(currentTokenId, 0);
      }
    }
  }

  /**
   * Reset the request count for a specific token
   * @param {string} tokenId - Token ID
   */
  resetCount(tokenId) {
    this.tokenRequestCounts.set(tokenId, 0);
  }

  /**
   * Get the request count for a specific token
   * @param {string} tokenId - Token ID
   * @returns {number} Request count
   */
  getCount(tokenId) {
    return this.tokenRequestCounts.get(tokenId) || 0;
  }

  /**
   * Set the request count threshold per token
   * @param {number} count - Request count
   */
  setRequestCountPerToken(count) {
    if (count > 0) {
      this.requestCountPerToken = count;
    }
  }

  reset() {
    this.currentIndex = 0;
    this.tokenRequestCounts.clear();
  }

  getName() {
    return 'request_count';
  }
}

/**
 * Strategy factory
 */
class StrategyFactory {
  /**
   * Create a strategy instance
   * @param {string} strategyName - Strategy name
   * @param {Object} options - Strategy options
   * @returns {TokenRotationStrategy} Strategy instance
   */
  static create(strategyName, options = {}) {
    switch (strategyName) {
      case 'round_robin':
        return new RoundRobinStrategy();
      
      case 'quota_exhausted':
        return new QuotaExhaustedStrategy();
      
      case 'request_count':
        return new RequestCountStrategy(options.requestCountPerToken || 10);
      
      default:
        log.warn(`Unknown rotation strategy: ${strategyName}, falling back to default round_robin`);
        return new RoundRobinStrategy();
    }
  }

  /**
   * Get all supported strategy names
   * @returns {Array<string>} List of strategy names
   */
  static getSupportedStrategies() {
    return ['round_robin', 'quota_exhausted', 'request_count'];
  }

  /**
   * Validate whether a strategy name is valid
   * @param {string} strategyName - Strategy name
   * @returns {boolean} Whether valid
   */
  static isValidStrategy(strategyName) {
    return this.getSupportedStrategies().includes(strategyName);
  }
}

// Rotation strategy enum (kept for backward compatibility)
const RotationStrategy = {
  ROUND_ROBIN: 'round_robin',
  QUOTA_EXHAUSTED: 'quota_exhausted',
  REQUEST_COUNT: 'request_count'
};

export {
  TokenRotationStrategy,
  RoundRobinStrategy,
  QuotaExhaustedStrategy,
  RequestCountStrategy,
  StrategyFactory,
  RotationStrategy
};