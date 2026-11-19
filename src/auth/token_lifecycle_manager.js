import { log } from '../utils/logger.js';
import { OAUTH_CONFIG } from '../constants/oauth.js';
import { TOKEN_REFRESH_BUFFER } from '../constants/index.js';
import { TokenError } from '../utils/errors.js';
import requesterManager from '../utils/requesterManager.js';

/**
 * Token lifecycle manager class
 * Responsible for token expiration checks and refreshing
 */
class TokenLifecycleManager {
  constructor(store) {
    this.store = store;
  }

  /**
   * Check whether a token is expired
   * @param {Object} token - Token object
   * @returns {boolean} Whether the token is expired
   */
  isExpired(token) {
    if (!token.timestamp || !token.expires_in) return true;
    const expiresAt = token.timestamp + (token.expires_in * 1000);
    return Date.now() >= expiresAt - TOKEN_REFRESH_BUFFER;
  }

  /**
   * Refresh a single token
   * @param {Object} token - Token object
   * @param {string} tokenId - Token ID (for logging)
   * @param {boolean} silent - Whether to run in silent mode (suppress logs)
   * @returns {Promise<Object>} Refreshed token
   * @throws {TokenError} Throws when refresh fails
   */
  async refreshToken(token, tokenId, silent = false) {
    if (!silent) {
      log.info(`Refreshing token: ${tokenId}`);
    }

    const body = new URLSearchParams({
      client_id: OAUTH_CONFIG.CLIENT_ID,
      client_secret: OAUTH_CONFIG.CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: token.refresh_token
    });

    try {
      const response = await requesterManager.fetch(OAUTH_CONFIG.TOKEN_URL, {
        method: 'POST',
        headers: {
          'Host': 'oauth2.googleapis.com',
          'User-Agent': 'Go-http-client/1.1',
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept-Encoding': 'gzip'
        },
        body: body.toString(),
        okStatus: [200]
      });

      token.access_token = response.data.access_token;
      token.expires_in = response.data.expires_in;
      token.timestamp = Date.now();
      
      return token;
    } catch (error) {
      const statusCode = error.status || 500;
      const rawBody = error.message;
      const message = typeof rawBody === 'string' 
        ? rawBody 
        : (rawBody?.error?.message || 'Failed to refresh token');
      throw new TokenError(message, tokenId, statusCode);
    }
  }

  /**
   * Safely refresh a single token (does not throw)
   * @param {Object} token - Token object
   * @param {string} tokenId - Token ID
   * @returns {Promise<'success'|'disable'|'skip'>} Refresh result
   */
  async refreshTokenSafe(token, tokenId) {
    try {
      await this.refreshToken(token, tokenId, true);
      return 'success';
    } catch (error) {
      if (error.statusCode === 403 || error.statusCode === 400) {
        return 'disable';
      }
      return 'skip';
    }
  }

  /**
   * Refresh multiple tokens concurrently
   * @param {Array<{token: Object, tokenId: string}>} tokens - Array of tokens
   * @returns {Promise<Object>} Refresh result {success: number, failed: number, tokensToDisable: Array}
   */
  async refreshTokensConcurrently(tokens) {
    if (tokens.length === 0) {
      return { success: 0, failed: 0, tokensToDisable: [], failedTokenIds: [] };
    }

    const tokenIds = tokens.map(t => t.tokenId);
    log.info(`Batch refreshing ${tokenIds.length} tokens: ${tokenIds.join(', ')}`);
    const startTime = Date.now();

    const results = await Promise.allSettled(
      tokens.map(({ token, tokenId }) => this.refreshTokenSafe(token, tokenId))
    );

    let successCount = 0;
    let failCount = 0;
    const tokensToDisable = [];
    const failedTokenIds = [];

    results.forEach((result, index) => {
      const { token, tokenId } = tokens[index];
      if (result.status === 'fulfilled') {
        if (result.value === 'success') {
          successCount++;
        } else if (result.value === 'disable') {
          tokensToDisable.push({ token, tokenId });
          failCount++;
          failedTokenIds.push(tokenId);
        } else {
          // skip
          failCount++;
          failedTokenIds.push(tokenId);
        }
      } else {
        failCount++;
        failedTokenIds.push(tokenId);
      }
    });

    const elapsed = Date.now() - startTime;
    if (failCount > 0) {
      log.warn(`Refresh complete: ${successCount} succeeded, ${failCount} failed (${failedTokenIds.join(', ')}), took ${elapsed}ms`);
    } else {
      log.info(`Refresh complete: ${successCount} succeeded, took ${elapsed}ms`);
    }

    return {
      success: successCount,
      failed: failCount,
      tokensToDisable,
      failedTokenIds
    };
  }

  /**
   * Get expired tokens
   * @param {Array<{token: Object, tokenId: string}>} tokens - Array of tokens
   * @returns {Array<{token: Object, tokenId: string}>} Array of expired tokens
   */
  getExpiredTokens(tokens) {
    return tokens.filter(({ token }) => this.isExpired(token));
  }

  /**
   * Calculate remaining validity time of a token (in seconds)
   * @param {Object} token - Token object
   * @returns {number} Remaining seconds, or 0 if already expired
   */
  getTimeToExpire(token) {
    if (!token.timestamp || !token.expires_in) return 0;
    const expiresAt = token.timestamp + (token.expires_in * 1000);
    const remaining = expiresAt - Date.now();
    return Math.max(0, Math.floor(remaining / 1000));
  }

  /**
   * Check whether a token is expiring soon (within the buffer window)
   * @param {Object} token - Token object
   * @param {number} bufferSeconds - Buffer time in seconds, defaults to TOKEN_REFRESH_BUFFER
   * @returns {boolean} Whether the token is expiring soon
   */
  isExpiringSoon(token, bufferSeconds = TOKEN_REFRESH_BUFFER / 1000) {
    const remaining = this.getTimeToExpire(token);
    return remaining <= bufferSeconds;
  }
}

export default TokenLifecycleManager;