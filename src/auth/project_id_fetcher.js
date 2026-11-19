import { log } from '../utils/logger.js';
import config from '../config/config.js';
import requesterManager from '../utils/requesterManager.js';

/**
 * ProjectId fetcher class
 * Responsible for fetching projectId from Google API
 */
class ProjectIdFetcher {
  constructor(options = {}) {
    this.maxRetries = options.maxRetries || 5;
    this.retryDelay = options.retryDelay || 2000;
    this.timeout = options.timeout || 30000;
  }

  /**
   * Full account validation flow (refactored)
   * @param {Object} token - Token object
   * @returns {Promise<{projectId: string|null, sub: string, hasQuota: boolean, source: string, isActivated: boolean, credits: number|null}>}
   */
  async validateAccount(token) {
    const result = {
      projectId: null,
      sub: 'free-tier',
      hasQuota: false,
      source: 'none',
      isActivated: false,
      credits: null
    };

    // Step 1: Try loadCodeAssist
    try {
      const loadResult = await this._tryLoadCodeAssist(token);
      
      // Scenario 2/3: Activated account (loadCodeAssist returns currentTier and projectId)
      if (loadResult?.projectId) {
        result.projectId = loadResult.projectId;
        result.sub = loadResult.sub;
        result.hasQuota = true;
        result.source = 'loadCodeAssist';
        result.isActivated = true;
        result.credits = loadResult.credits;
        
        log.info(`[validateAccount] Scenario 2/3: Activated account, sub=${result.sub}, credits=${result.credits}`);
        return result;
      }
      
      // loadCodeAssist returned currentTier without projectId (abnormal case)
      if (loadResult?.sub && loadResult.sub !== 'free-tier') {
        log.warn('[validateAccount] Account is activated but has no projectId (abnormal)');
        result.sub = loadResult.sub;
        result.isActivated = true;
        result.hasQuota = false;
        return result;
      }
      
    } catch (err) {
      log.warn(`[validateAccount] loadCodeAssist failed: ${err.message}`);
    }

    // Step 2: loadCodeAssist did not return a valid result, try onboardUser
    log.info('[validateAccount] Not activated via loadCodeAssist, trying onboardUser');
    
    try {
      const onboardResult = await this._tryOnboardUser(token);
      
      // Scenario 4: Unactivated Pro account (onboardUser can obtain projectId)
      if (onboardResult?.projectId) {
        result.projectId = onboardResult.projectId;
        result.sub = 'g1-pro-tier'; // Default subscription for Pro accounts
        result.hasQuota = true;
        result.source = 'onboardUser';
        result.isActivated = false;
        
        log.info('[validateAccount] Scenario 4: Unactivated Pro account');
        return result;
      }
      
    } catch (err) {
      log.warn(`[validateAccount] onboardUser failed: ${err.message}`);
    }

    // Step 3: Both methods failed, Scenario 1: Regular unactivated account
    log.info('[validateAccount] Scenario 1: Regular unactivated account (free-tier)');
    result.sub = 'free-tier';
    result.hasQuota = false;
    result.source = 'none';
    result.isActivated = false;
    
    return result;
  }

  /**
   * Fetch projectId (tries both methods)
   * @param {Object} token - Token object
   * @returns {Promise<{projectId: string|undefined, sub: string}>} projectId and sub
   */
  async fetchProjectId(token) {
    let cachedCredits = null;

    // Step 1: Try loadCodeAssist
    try {
      const result = await this._tryLoadCodeAssist(token);
      // Cache credits first (credits info may still be valid even if projectId is empty)
      if (result?.credits != null) cachedCredits = result.credits;
      if (result?.projectId) {
        return result;
      }
      log.warn('[fetchProjectId] loadCodeAssist did not return projectId, falling back to onboardUser');
    } catch (err) {
      log.warn(`[fetchProjectId] loadCodeAssist failed: ${err.message}, falling back to onboardUser`);
    }

    // Step 2: Fallback to onboardUser
    try {
      const result = await this._tryOnboardUser(token);
      if (result?.projectId) {
        if (cachedCredits != null) result.credits = cachedCredits;
        return result;
      }
      log.error('[fetchProjectId] Both loadCodeAssist and onboardUser failed to obtain projectId');
      return { projectId: undefined, sub: 'free-tier', credits: cachedCredits };
    } catch (err) {
      log.error(`[fetchProjectId] onboardUser failed: ${err.message}`);
      return { projectId: undefined, sub: 'free-tier', credits: cachedCredits };
    }
  }

  /**
   * Attempt to fetch projectId via loadCodeAssist
   * @param {Object} token - Token object
   * @returns {Promise<{projectId: string|null, sub: string, isActivated: boolean, credits: number|null}|null>} projectId, sub, activation status, and credits
   * @private
   */
  async _tryLoadCodeAssist(token) {
    const apiHost = config.api.host;
    const requestUrl = `https://${apiHost}/v1internal:loadCodeAssist`;
    const requestBody = {
      metadata: {
        ideType: 'ANTIGRAVITY',
        platform: 'PLATFORM_UNSPECIFIED',
        pluginType: 'GEMINI'
      }
    };

    log.info(`[loadCodeAssist] Request: ${requestUrl}`);
    const response = await requesterManager.fetch(requestUrl, {
      method: 'POST',
      headers: {
        'Host': apiHost,
        'User-Agent': config.api.userAgent,
        'Authorization': `Bearer ${token.access_token}`,
        'Content-Type': 'application/json',
        'Accept-Encoding': 'gzip'
      },
      body: requestBody,
      okStatus: [200]
    });

    const data = response.data;

    // Unconditionally extract credits info
    let credits = null;
    // Debug: print paidTier structure to troubleshoot credits extraction
    if (data?.paidTier) {
      // log.info(`[loadCodeAssist] paidTier raw data: ${JSON.stringify(data.paidTier)}`);
    }
    const creditAmount = data?.paidTier?.availableCredits?.[0]?.creditAmount;
    if (creditAmount != null) {
      const parsed = Number(creditAmount);
      if (Number.isFinite(parsed)) {
        credits = parsed;
        // log.info(`[loadCodeAssist] Retrieved credits info: ${credits}`);
      }
    } else {
      // log.info(`[loadCodeAssist] creditAmount not found, paidTier exists: ${!!data?.paidTier}, availableCredits: ${JSON.stringify(data?.paidTier?.availableCredits)}`);
    }

    // Check if currentTier exists (indicates the user is activated)
    if (data?.currentTier) {
      log.info('[loadCodeAssist] User is activated');
      const projectId = data.cloudaicompanionProject || null;
      let sub = data.currentTier.id || 'free-tier';
      const sub2 = data.paidTier?.id;
      if (sub2){
        sub = sub2;
      }
      
      return {
        projectId,
        sub,
        isActivated: true,
        credits
      };
    }

    // Not activated
    log.info('[loadCodeAssist] User is not activated (no currentTier)');
    return {
      projectId: null,
      sub: 'free-tier',
      isActivated: false,
      credits
    };
  }

  /**
   * Attempt to fetch projectId via onboardUser (long-running operation, requires polling)
   * @param {Object} token - Token object
   * @returns {Promise<{projectId: string, sub: string}|null>} projectId and sub, or null
   * @private
   */
  async _tryOnboardUser(token) {
    const apiHost = config.api.host;
    const requestUrl = `https://${apiHost}/v1internal:onboardUser`;

    // First fetch the user's tier info
    const tierId = await this._getOnboardTier(token);
    if (!tierId) {
      log.error('[onboardUser] Unable to determine user tier');
      return null;
    }

    log.info(`[onboardUser] User tier: ${tierId}`);

    const requestBody = {
      tierId: tierId,
      metadata: {
        ideType: 'ANTIGRAVITY',
        platform: 'PLATFORM_UNSPECIFIED',
        pluginType: 'GEMINI'
      }
    };

    log.info(`[onboardUser] Request: ${requestUrl}`);

    // onboardUser is a long-running operation and requires polling
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      log.info(`[onboardUser] Polling attempt ${attempt}/${this.maxRetries}`);

      const response = await requesterManager.fetch(requestUrl, {
        method: 'POST',
        headers: {
          'Host': apiHost,
          'User-Agent': config.api.userAgent,
          'Authorization': `Bearer ${token.access_token}`,
          'Content-Type': 'application/json',
          'Accept-Encoding': 'gzip'
        },
        body: requestBody,
        okStatus: [200]
      });

      const data = response.data;

      // Check whether the long-running operation is done
      let sub = 'g1-pro-tier';
      if (data?.done) {
        log.info('[onboardUser] Operation completed');
        const responseData = data.response || {};
        const projectObj = responseData.cloudaicompanionProject;

        let projectId = null;
        if (typeof projectObj === 'object' && projectObj !== null) {
          projectId = projectObj.id;
        } else if (typeof projectObj === 'string') {
          projectId = projectObj;
        }

        if (projectId) {
          log.info(`[onboardUser] Successfully retrieved projectId: ${projectId}`);
          return { projectId, sub };
        }
        log.warn('[onboardUser] Operation completed but no projectId in response');
        return null;
      }

      log.info(`[onboardUser] Operation in progress, waiting ${this.retryDelay}ms...`);
      await this._sleep(this.retryDelay);
    }

    log.error(`[onboardUser] Timeout: operation did not complete within ${this.maxRetries * this.retryDelay / 1000} seconds`);
    return null;
  }

  /**
   * Get the tier the user should onboard to from the loadCodeAssist response
   * @param {Object} token - Token object
   * @returns {Promise<string|null>} tier_id or null
   * @private
   */
  async _getOnboardTier(token) {
    const apiHost = config.api.host;
    const requestUrl = `https://${apiHost}/v1internal:loadCodeAssist`;
    const requestBody = {
      metadata: {
        ideType: 'ANTIGRAVITY',
        platform: 'PLATFORM_UNSPECIFIED',
        pluginType: 'GEMINI'
      }
    };

    log.info(`[_getOnboardTier] Request: ${requestUrl}`);

    try {
      const response = await requesterManager.fetch(requestUrl, {
        method: 'POST',
        headers: {
          'Host': apiHost,
          'User-Agent': config.api.userAgent,
          'Authorization': `Bearer ${token.access_token}`,
          'Content-Type': 'application/json',
          'Accept-Encoding': 'gzip'
        },
        body: requestBody,
        okStatus: [200]
      });

      const data = response.data;

      // Look for the default tier
      const allowedTiers = data?.allowedTiers || [];
      for (const tier of allowedTiers) {
        if (tier.isDefault) {
          log.info(`[_getOnboardTier] Found default tier: ${tier.id}`);
          return tier.id;
        }
      }

      // If no default tier is found, fall back to LEGACY
      log.warn('[_getOnboardTier] Default tier not found, using LEGACY');
      return 'LEGACY';
    } catch (err) {
      log.error(`[_getOnboardTier] Failed to get tier: ${err.message}`);
      return null;
    }
  }

  /**
   * Sleep for the specified duration
   * @param {number} ms - Milliseconds
   * @returns {Promise<void>}
   * @private
   */
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Fetch subscription and credits information
   * @param {Object} token - Token object
   * @returns {Promise<{sub: string, credits: number|null, isActivated: boolean}>}
   */
  async fetchSubscriptionAndCredits(token) {
    const result = {
      sub: 'free-tier',
      credits: null,
      isActivated: false,
      fetched: false
    };

    try {
      const loadResult = await this._tryLoadCodeAssist(token);
      result.fetched = true;
      
      if (loadResult?.isActivated) {
        result.sub = loadResult.sub || 'free-tier';
        result.credits = loadResult.credits;
        result.isActivated = true;
        
        log.info(`[fetchSubscriptionAndCredits] Subscription: ${result.sub}, Credits: ${result.credits}`);
      } else {
        log.info('[fetchSubscriptionAndCredits] Account is not activated, keeping free-tier');
      }
      
      return result;
    } catch (err) {
      log.error(`[fetchSubscriptionAndCredits] Fetch failed: ${err.message}`);
      return result;
    }
  }

  /**
   * Set maximum retry count
   * @param {number} retries - Number of retries
   */
  setMaxRetries(retries) {
    if (retries > 0) {
      this.maxRetries = retries;
    }
  }

  /**
   * Set retry delay
   * @param {number} delay - Delay in milliseconds
   */
  setRetryDelay(delay) {
    if (delay > 0) {
      this.retryDelay = delay;
    }
  }

  /**
   * Set timeout duration
   * @param {number} timeout - Timeout in milliseconds
   */
  setTimeout(timeout) {
    if (timeout > 0) {
      this.timeout = timeout;
    }
  }
}

export default ProjectIdFetcher;
