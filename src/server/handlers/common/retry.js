import config from '../../../config/config.js';
import { DEFAULT_RETRY_INTERVAL_MS, LONG_COOLDOWN_THRESHOLD } from '../../../constants/index.js';
import tokenCooldownManager from '../../../auth/token_cooldown_manager.js';
import { getGroupKey } from '../../../utils/modelGroups.js';
import { hasOtherAvailableModelGroups, getAvailableModelGroups } from '../../../utils/tokenQuotaHelper.js';
import logger from '../../../utils/logger.js';

/**
 * Normalize retry count
 * @param {any} retryTimes
 * @returns {number}
 */
export function getSafeRetries(retryTimes) {
  const maxRetries = Number(retryTimes || 0);
  return maxRetries > 0 ? Math.floor(maxRetries) : 0;
}

/**
 * Normalize fixed retry interval
 * @param {any} retryIntervalMs
 * @returns {number}
 */
export function getSafeRetryIntervalMs(retryIntervalMs) {
  const value = Number(retryIntervalMs);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_RETRY_INTERVAL_MS;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseDurationToMs(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.floor(value));
  if (typeof value !== 'string') return null;

  const s = value.trim();
  if (!s) return null;

  const msMatch = s.match(/^(\d+(\.\d+)?)\s*ms$/i);
  if (msMatch) return Math.max(0, Math.floor(Number(msMatch[1])));

  const secMatch = s.match(/^(\d+(\.\d+)?)\s*s$/i);
  if (secMatch) return Math.max(0, Math.floor(Number(secMatch[1]) * 1000));

  const num = Number(s);
  if (Number.isFinite(num)) return Math.max(0, Math.floor(num));
  return null;
}

function tryParseJson(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    const first = value.indexOf('{');
    const last = value.lastIndexOf('}');
    if (first !== -1 && last !== -1 && last > first) {
      try {
        return JSON.parse(value.slice(first, last + 1));
      } catch { }
    }
    return null;
  }
}

function extractUpstreamErrorBody(error) {
  if (error?.isUpstreamApiError && error.rawBody) {
    return tryParseJson(error.rawBody) || error.rawBody;
  }
  if (error?.response?.data) {
    return tryParseJson(error.response.data) || error.response.data;
  }
  return tryParseJson(error?.message);
}

function getErrorDetails(body) {
  const root = body && typeof body === 'object' ? body : null;
  const inner = root?.error || root;
  return Array.isArray(inner?.details) ? inner.details : [];
}

function collectRetryHintsFromObject(obj, hints) {
  if (!obj || typeof obj !== 'object') return;

  const durationKeys = [
    'retryDelay',
    'quotaResetDelay',
    'retryAfter',
    'retry_after',
    'delay'
  ];

  for (const key of durationKeys) {
    const ms = parseDurationToMs(obj[key]);
    if (ms !== null) hints.delays.push(ms);
  }

  const timestampKeys = [
    'quotaResetTimeStamp',
    'quotaResetTimestamp',
    'resetTime',
    'resetTimestamp',
    'retryAt'
  ];

  for (const key of timestampKeys) {
    const value = obj[key];
    if (typeof value !== 'string') continue;
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) hints.timestamps.push(timestamp);
  }
}

/**
 * Extract retry hints from an upstream error response body.
 * Returns hasRetryHint=false when no explicit retryDelay / quotaResetDelay / quotaResetTimeStamp is present.
 * @param {Error} error
 * @returns {{body: any, details: Array, explicitDelayMs: number|null, resetTimestamp: number|null, reason: string|null, hasRetryHint: boolean}}
 */
export function getRetryHint(error) {
  const body = extractUpstreamErrorBody(error);
  const details = getErrorDetails(body);
  const hints = { delays: [], timestamps: [] };

  const root = body && typeof body === 'object' ? body : null;
  const inner = root?.error || root;
  collectRetryHintsFromObject(inner, hints);

  for (const detail of details) {
    if (!detail || typeof detail !== 'object') continue;
    collectRetryHintsFromObject(detail, hints);
    collectRetryHintsFromObject(detail.metadata, hints);
  }

  const resetTimestamp = hints.timestamps.length > 0
    ? Math.max(...hints.timestamps)
    : null;

  const resetDelay = resetTimestamp !== null
    ? Math.max(0, resetTimestamp - Date.now())
    : null;

  const delayCandidates = [...hints.delays];
  if (resetDelay !== null) delayCandidates.push(resetDelay);

  const explicitDelayMs = delayCandidates.length > 0 ? Math.max(...delayCandidates) : null;
  const reason = details.find(detail => detail?.reason)?.reason || inner?.status || null;

  return {
    body,
    details,
    explicitDelayMs,
    resetTimestamp,
    reason,
    hasRetryHint: explicitDelayMs !== null || resetTimestamp !== null
  };
}

function stringifyErrorBody(body, fallbackMessage) {
  if (typeof body === 'string') return body;
  try {
    return JSON.stringify(body || fallbackMessage || '');
  } catch {
    return String(fallbackMessage || '');
  }
}

function hasQuotaExhaustionSignal(error, hint) {
  const text = stringifyErrorBody(hint.body, error?.message).toLowerCase();
  return (
    text.includes('quota') ||
    text.includes('exhaust') ||
    text.includes('resource_exhausted') ||
    text.includes('limit exceeded') ||
    text.includes('rate limit') ||
    text.includes('too many requests')
  );
}

function isLongQuotaCooldown(status, error, hint, thresholdMs) {
  return (
    status === 429 &&
    hint.explicitDelayMs !== null &&
    hint.explicitDelayMs >= thresholdMs &&
    hasQuotaExhaustionSignal(error, hint)
  );
}

function normalizeRetryOptions(options, legacyOnAttempt) {
  if (typeof options === 'string') {
    return {
      loggerPrefix: options,
      onAttempt: legacyOnAttempt
    };
  }
  return options && typeof options === 'object' ? options : {};
}

function getCurrentTokenId(options) {
  if (typeof options.getTokenId === 'function') return options.getTokenId();
  return options.tokenId || null;
}

function getCurrentToken(options) {
  if (typeof options.getToken === 'function') return options.getToken();
  return options.token || null;
}

async function applyLongQuotaCooldown({ options, loggerPrefix, modelId, hint, thresholdMs }) {
  const tokenId = getCurrentTokenId(options);
  if (!tokenId || !modelId) return;

  const cooldownUntil = hint.resetTimestamp || (Date.now() + hint.explicitDelayMs);
  if (!cooldownUntil || cooldownUntil <= Date.now()) return;

  const groupKey = getGroupKey(modelId);
  const delayMinutes = Math.round((cooldownUntil - Date.now()) / 1000 / 60);
  const thresholdMinutes = Math.round(thresholdMs / 1000 / 60);

  logger.warn(
    `${loggerPrefix}[Long Cooldown] Received 429 quota exhausted; resets in ~${delayMinutes} min, ` +
    `exceeding threshold (${thresholdMinutes} min); disabling ${groupKey} series for token ${tokenId}`
  );

  tokenCooldownManager.setCooldown(tokenId, modelId, cooldownUntil);

  if (!hasOtherAvailableModelGroups(tokenId)) {
    logger.warn(`${loggerPrefix}All core model groups disabled for token ${tokenId}; marking quota exhausted`);
    const tokenManager = options.tokenManager || null;
    const token = getCurrentToken(options);
    if (tokenManager && token) {
      try {
        await tokenManager.markTokenQuotaExhausted(token);
      } catch (error) {
        logger.error(`${loggerPrefix}Failed to mark token quota exhausted: ${error.message}`);
      }
    }
  } else {
    const availableGroups = getAvailableModelGroups(tokenId);
    logger.info(`${loggerPrefix}Token ${tokenId} still has other available model groups: ${availableGroups.join(', ')}`);
  }
}

async function prepareNextAttempt(options, context) {
  if (typeof options.onBeforeRetry !== 'function') return true;
  const result = await options.onBeforeRetry(context);
  return result !== false;
}

function getStatus(error) {
  return Number(error?.status || error?.statusCode || error?.response?.status);
}

/**
 * Executor with 429/503 retry support.
 * Core strategy:
 * - 429 only retries when a wait interval / reset time can be extracted from the upstream error body.
 * - 503 (temporary capacity/resource unavailability) retries at a fixed interval without relying on upstream hints.
 * - Uses the configured fixed interval for actual waits to avoid turning 503 bursts into 429s.
 * - Long 429 quota exhaustion puts the model group into cooldown; continues only when token polling on retry is enabled.
 *
 * @param {Function} fn - Async function to execute, receiving (attempt, shouldUseCredits)
 * @param {number} maxRetries - Maximum retry count
 * @param {Object|string} options - Options object or legacy loggerPrefix string
 * @param {Function|null} legacyOnAttempt - Legacy attempt callback
 * @returns {Promise<any>}
 */
export async function with429Retry(fn, maxRetries, options = {}, legacyOnAttempt = null) {
  const retryOptions = normalizeRetryOptions(options, legacyOnAttempt);
  const loggerPrefix = retryOptions.loggerPrefix || '';
  const retries = getSafeRetries(maxRetries);
  const retryIntervalMs = getSafeRetryIntervalMs(config.retryIntervalMs);
  const longCooldownThreshold = config.retryLongCooldownThresholdMs || LONG_COOLDOWN_THRESHOLD;
  const canPollTokenForRetry = config.retryPollTokenWithQuota === true && typeof retryOptions.onBeforeRetry === 'function';

  let attempt = 0;
  let shouldUseCredits = false;

  while (true) {
    try {
      if (typeof retryOptions.onAttempt === 'function') {
        retryOptions.onAttempt(attempt);
      }
      return await fn(attempt, shouldUseCredits);
    } catch (error) {
      const status = getStatus(error);
      if (status !== 429 && status !== 503) {
        throw error;
      }

      const hint = getRetryHint(error);
      const errorType = status === 503 ? '503' : '429';
      const modelId = retryOptions.modelId || null;
      const previousTokenId = getCurrentTokenId(retryOptions);

      if (status === 429 && !hint.hasRetryHint) {
        logger.warn(`${loggerPrefix}Received 429 without a wait interval or reset time in error body; treating as non-retryable`);
        throw error;
      }

      const longQuotaCooldown = isLongQuotaCooldown(status, error, hint, longCooldownThreshold);
      if (longQuotaCooldown) {
        await applyLongQuotaCooldown({ options: retryOptions, loggerPrefix, modelId, hint, thresholdMs: longCooldownThreshold });
        if (!canPollTokenForRetry) {
          throw error;
        }
      }

      if (attempt >= retries) {
        throw error;
      }

      const nextAttempt = attempt + 1;
      if (!config.alwaysUseCredits && !shouldUseCredits) {
        shouldUseCredits = true;
      }

      const hintText = hint.hasRetryHint
        ? ` (upstream hint ~${hint.explicitDelayMs}ms)`
        : ' (no upstream wait hint)';

      logger.warn(
        `${loggerPrefix}Received ${errorType}, waiting fixed interval ${retryIntervalMs}ms before retry ${nextAttempt}/${retries}` +
        hintText +
        (shouldUseCredits ? ' (using credits)' : '') +
        (canPollTokenForRetry ? ' (polling for available token before retry)' : '')
      );

      await sleep(retryIntervalMs);

      const prepared = await prepareNextAttempt(retryOptions, {
        attempt,
        nextAttempt,
        status,
        error,
        hint,
        previousTokenId,
        modelId,
        longQuotaCooldown
      });

      if (!prepared) {
        logger.warn(`${loggerPrefix}No available token found for model ${modelId || 'unknown'} before retry; aborting retries`);
        throw error;
      }

      attempt = nextAttempt;
    }
  }
}
