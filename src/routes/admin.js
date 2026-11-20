import express from 'express';
import os from 'os';
import { generateToken, authMiddleware, verifyToken } from '../auth/jwt.js';
import tokenManager from '../auth/token_manager.js';
import geminicliTokenManager from '../auth/geminicli_token_manager.js';
import quotaManager from '../auth/quota_manager.js';
import oauthManager from '../auth/oauth_manager.js';
import config, { getConfigJson, saveConfigJson } from '../config/config.js';
import logger from '../utils/logger.js';
import memoryManager from '../utils/memoryManager.js';
import { parseEnvFile, updateEnvFile } from '../utils/envParser.js';
import { reloadConfig } from '../utils/configReloader.js';
import { deepMerge } from '../utils/deepMerge.js';
import { getModelsWithQuotas } from '../api/client.js';
import { getEnvPath } from '../utils/paths.js';
import ipBlockManager from '../utils/ipBlockManager.js';
import dotenv from 'dotenv';

const envPath = getEnvPath();

const router = express.Router();

// Disable caching middleware to keep admin dashboard data real-time
router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

// Cookie options
const COOKIE_OPTIONS = {
  httpOnly: true,
  // secure: process.env.NODE_ENV === 'production', // Removed static setting in favor of dynamic check
  sameSite: 'strict',
  maxAge: 24 * 60 * 60 * 1000 // 24 hours
};

// Middleware to extract JWT token from Cookie or Authorization header
const cookieAuthMiddleware = (req, res, next) => {
  // Prefer cookie first
  let token = req.cookies?.authToken;

  // Fall back to Authorization header if not in cookie (legacy compatibility)
  if (!token) {
    const authHeader = req.headers.authorization;
    token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  }

  if (!token) {
    return res.status(401).json({ error: 'Token required' });
  }

  try {
    const decoded = verifyToken(token);
    req.user = decoded;
    next();
  } catch (error) {
    // Clear invalid cookie
    res.clearCookie('authToken', {
      ...COOKIE_OPTIONS,
      secure: req.secure || process.env.NODE_ENV === 'production'
    });
    return res.status(401).json({ error: 'Invalid token' });
  }
};

// Get client IP address
function getClientIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.headers['x-real-ip'] ||
    req.connection?.remoteAddress ||
    req.ip ||
    'unknown';
}

// Login endpoint
router.post('/login', async (req, res) => {
  const clientIP = getClientIP(req);

  // Check using unified IP block manager
  const blockStatus = ipBlockManager.check(clientIP);
  if (blockStatus.blocked) {
    if (blockStatus.reason === 'permanent') {
      return res.status(403).json({ success: false, message: 'Your IP has been permanently blocked' });
    }
    const remainingMinutes = Math.ceil((blockStatus.expiresAt - Date.now()) / 60000);
    return res.status(429).json({
      success: false,
      message: `Too many login attempts. Please try again in ${remainingMinutes} minute(s)`,
      retryAfter: remainingMinutes * 60
    });
  }

  const { username, password } = req.body;

  // Validate input
  if (!username || !password || typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ success: false, message: 'Username and password are required' });
  }

  // Limit input length to prevent DoS
  if (username.length > 100 || password.length > 100) {
    return res.status(400).json({ success: false, message: 'Input is too long' });
  }

  if (username === config.admin.username && password === config.admin.password) {
    const token = generateToken({ username, role: 'admin' });

    // Set HttpOnly cookie
    // Dynamically set secure: enabled when accessed via HTTPS (req.secure) or in production
    res.cookie('authToken', token, {
      ...COOKIE_OPTIONS,
      secure: req.secure || process.env.NODE_ENV === 'production'
    });

    // Also return token in body (for legacy frontend compatibility)
    logger.info(`Admin login succeeded IP: ${clientIP}`);
    res.json({ success: true, token });
  } else {
    // Record violation using unified IP block manager
    await ipBlockManager.recordViolation(clientIP, 'admin_login_fail');
    logger.warn(`Admin login failed IP: ${clientIP}`);
    res.status(401).json({ success: false, message: 'Invalid username or password' });
  }
});

// Logout endpoint
router.post('/logout', (req, res) => {
  res.clearCookie('authToken', {
    ...COOKIE_OPTIONS,
    secure: req.secure || process.env.NODE_ENV === 'production'
  });
  res.json({ success: true, message: 'Logged out' });
});

// Verify password (for sensitive operations)
function verifyPassword(password) {
  return password === config.admin.password;
}

// Token management API - requires JWT authentication (cookie preferred)
router.get('/tokens', cookieAuthMiddleware, async (req, res) => {
  try {
    const tokens = await tokenManager.getTokenList();
    res.json({ success: true, data: tokens });
  } catch (error) {
    logger.error('Failed to get token list:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/tokens', cookieAuthMiddleware, async (req, res) => {
  const { access_token, refresh_token, expires_in, timestamp, enable, projectId, email, sub, credits } = req.body;
  if (!access_token || !refresh_token) {
    return res.status(400).json({ success: false, message: 'access_token and refresh_token are required' });
  }
  const tokenData = { access_token, refresh_token, expires_in, sub };
  if (timestamp) tokenData.timestamp = timestamp;
  if (enable !== undefined) tokenData.enable = enable;
  if (projectId) tokenData.projectId = projectId;
  if (email) tokenData.email = email;
  if (credits !== null && credits !== undefined) tokenData.credits = credits;

  try {
    const result = await tokenManager.addToken(tokenData);
    logger.info(`Added new token: ${access_token.substring(0, 8)}...`);
    // Return in the format expected by the frontend
    res.json({ success: true, message: 'Token added successfully', data: result });
  } catch (error) {
    logger.error('Failed to add token:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});
// Use tokenId instead of refreshToken
router.put('/tokens/:tokenId', cookieAuthMiddleware, async (req, res) => {
  const { tokenId } = req.params;
  const updates = req.body;

  // Disallow updating sensitive fields via API
  delete updates.access_token;
  delete updates.refresh_token;

  try {
    const result = await tokenManager.updateTokenById(tokenId, updates);
    logger.info(`Updated token: ${tokenId}`);
    res.json(result);
  } catch (error) {
    logger.error('Failed to update token:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.delete('/tokens/:tokenId', cookieAuthMiddleware, async (req, res) => {
  const { tokenId } = req.params;
  try {
    const result = await tokenManager.deleteTokenById(tokenId);
    logger.info(`Deleted token: ${tokenId}`);
    res.json(result);
  } catch (error) {
    logger.error('Failed to delete token:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/tokens/reload', cookieAuthMiddleware, async (req, res) => {
  try {
    await tokenManager.reload();
    logger.info('Manually triggered token hot-reload');
    res.json({ success: true, message: 'Tokens reloaded' });
  } catch (error) {
    logger.error('Failed to reload tokens:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Refresh access_token for a specific token (using tokenId)
router.post('/tokens/:tokenId/refresh', cookieAuthMiddleware, async (req, res) => {
  const { tokenId } = req.params;
  try {
    // 1. Refresh access_token
    const result = await tokenManager.refreshTokenById(tokenId);

    // 2. Re-fetch credits and subscription info
    try {
      const subscriptionInfo = await tokenManager.refreshSubscriptionAndCreditsById(tokenId);

      if (subscriptionInfo.fetched === false) {
        logger.warn('[Refresh Token] Failed to fetch subscription and credits info, keeping existing data');
        return res.json({
          success: true,
          message: 'Token refreshed (failed to fetch subscription info)',
          data: {
            ...result,
            sub: subscriptionInfo.sub,
            credits: subscriptionInfo.credits,
            isActivated: subscriptionInfo.isActivated
          }
        });
      }

      logger.info(`[Refresh Token] Updated subscription and credits info: sub=${subscriptionInfo.sub}, credits=${subscriptionInfo.credits}`);

      res.json({
        success: true,
        message: 'Token refreshed successfully',
        data: {
          ...result,
          sub: subscriptionInfo.sub,
          credits: subscriptionInfo.credits,
          isActivated: subscriptionInfo.isActivated
        }
      });
    } catch (subscriptionError) {
      // Token refresh still succeeds even if fetching subscription info fails
      logger.warn(`Failed to fetch subscription info: ${subscriptionError.message}`);
      res.json({
        success: true,
        message: 'Token refreshed (failed to fetch subscription info)',
        data: result
      });
    }
  } catch (error) {
    logger.error('Failed to refresh token:', error.message);
    const status = error.statusCode || 500;
    res.status(status).json({ success: false, message: error.message });
  }
});

// Manually fetch Project ID for a specific token (using tokenId)
router.post('/tokens/:tokenId/fetch-project-id', cookieAuthMiddleware, async (req, res) => {
  const { tokenId } = req.params;
  try {
    const result = await tokenManager.fetchProjectIdForToken(tokenId);
    logger.info(`Manually fetched ProjectId: ${tokenId} -> ${result.projectId}`);
    res.json({ success: true, message: 'Project ID fetched successfully', projectId: result.projectId });
  } catch (error) {
    logger.error('Failed to fetch ProjectId:', error.message);
    const status = error.statusCode || 500;
    res.status(status).json({ success: false, message: error.message });
  }
});

// Export all tokens (requires password verification)
router.post('/tokens/export', cookieAuthMiddleware, async (req, res) => {
  const { password } = req.body;

  if (!password || !verifyPassword(password)) {
    return res.status(403).json({ success: false, message: 'Password verification failed' });
  }

  try {
    const allTokens = await tokenManager.store.readAll();

    // Export format: includes full token data
    logger.info('Exported all token data');
    const exportData = {
      version: 1,
      exportTime: new Date().toISOString(),
      tokens: allTokens.map(token => ({
        access_token: token.access_token,
        refresh_token: token.refresh_token,
        expires_in: token.expires_in,
        timestamp: token.timestamp,
        enable: token.enable,
        projectId: token.projectId,
        email: token.email,
        hasQuota: token.hasQuota
      }))
    };

    res.json({ success: true, data: exportData });
  } catch (error) {
    logger.error('Failed to export tokens:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Smart field lookup (case-insensitive substring match)
function findFieldByKeyword(obj, keyword) {
  if (!obj || typeof obj !== 'object') return undefined;
  const lowerKeyword = keyword.toLowerCase();
  for (const key of Object.keys(obj)) {
    if (key.toLowerCase().includes(lowerKeyword)) {
      return obj[key];
    }
  }
  return undefined;
}

function normalizeImportedTextValue(value) {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function normalizeImportedProjectId(value) {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'object') {
    return normalizeImportedProjectId(value.id ?? value.projectId ?? value.name);
  }
  return normalizeImportedTextValue(value);
}

function normalizeImportedBoolean(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function parseImportedEnable(rawToken) {
  let enable = findFieldByKeyword(rawToken, 'enable');
  if (enable === undefined) enable = findFieldByKeyword(rawToken, 'enabled');

  let disabled = findFieldByKeyword(rawToken, 'disable');
  if (disabled === undefined) disabled = findFieldByKeyword(rawToken, 'disabled');

  if (enable === undefined && disabled !== undefined) {
    return !normalizeImportedBoolean(disabled);
  }

  if (enable === undefined) return true;
  return normalizeImportedBoolean(enable);
}

function deriveImportedExpiresInAndTimestamp({ expires_in, expiry, timestamp }) {
  const nowMs = Date.now();

  let finalExpiresIn = null;
  if (expires_in !== undefined && expires_in !== null && String(expires_in).trim() !== '') {
    const parsed = parseInt(expires_in, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      finalExpiresIn = parsed;
    }
  }

  let finalTimestamp;
  if (finalExpiresIn === null && typeof expiry === 'string' && expiry.trim()) {
    const expiryMs = Date.parse(expiry);
    if (Number.isFinite(expiryMs)) {
      finalExpiresIn = Math.max(1, Math.floor((expiryMs - nowMs) / 1000));
      finalTimestamp = nowMs;
    }
  }

  if (finalTimestamp === undefined) {
    if (timestamp !== undefined && timestamp !== null && String(timestamp).trim() !== '') {
      if (typeof timestamp === 'number') {
        finalTimestamp = timestamp;
      } else {
        const parsedTimestamp = Date.parse(timestamp);
        finalTimestamp = Number.isFinite(parsedTimestamp) ? parsedTimestamp : nowMs;
      }
    } else {
      finalTimestamp = nowMs;
    }
  }

  return {
    expires_in: finalExpiresIn ?? 3599,
    timestamp: finalTimestamp
  };
}

// Smartly parse a single token object
function smartParseToken(rawToken) {
  if (!rawToken || typeof rawToken !== 'object') return null;

  const refresh_token = normalizeImportedTextValue(findFieldByKeyword(rawToken, 'refresh'));

  if (!refresh_token) return null;

  const token = { refresh_token };

  const projectId = normalizeImportedProjectId(findFieldByKeyword(rawToken, 'project'));
  const access_token = normalizeImportedTextValue(findFieldByKeyword(rawToken, 'access') || rawToken.token);
  const email = normalizeImportedTextValue(findFieldByKeyword(rawToken, 'email') || findFieldByKeyword(rawToken, 'mail'));
  const expires_in = findFieldByKeyword(rawToken, 'expires') || findFieldByKeyword(rawToken, 'expire');
  const timestamp = findFieldByKeyword(rawToken, 'time') || findFieldByKeyword(rawToken, 'stamp') || findFieldByKeyword(rawToken, 'created');
  const expiry = findFieldByKeyword(rawToken, 'expiry') || findFieldByKeyword(rawToken, 'expiresat');
  const hasQuota = findFieldByKeyword(rawToken, 'quota');
  const sub = normalizeImportedTextValue(findFieldByKeyword(rawToken, 'subscription') || findFieldByKeyword(rawToken, 'tier') || rawToken.sub);
  const credits = findFieldByKeyword(rawToken, 'credit');

  if (projectId) token.projectId = projectId;
  if (access_token) token.access_token = access_token;
  if (email) token.email = email;

  const derived = deriveImportedExpiresInAndTimestamp({ expires_in, expiry, timestamp });
  token.expires_in = derived.expires_in;
  token.timestamp = derived.timestamp;
  token.enable = parseImportedEnable(rawToken);

  if (hasQuota !== undefined) token.hasQuota = normalizeImportedBoolean(hasQuota);
  if (sub) token.sub = sub;
  if (credits !== undefined && credits !== null && String(credits).trim() !== '') {
    const parsedCredits = Number(credits);
    if (Number.isFinite(parsedCredits)) {
      token.credits = parsedCredits;
    }
  }

  return token;
}

// ==================== Gemini CLI Token Import Parsing Helpers ====================

function extractGeminiCliImportList(data) {
  // Compatible with multiple gcli export structures:
  // - { tokens: [...] }
  // - { accounts: [...] }
  // - { data: { tokens/accounts: [...] } }
  // - Direct array [...]
  // - Single credential object { token/refresh_token/project_id/expiry/... }
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return null;

  const list = data.tokens || data.accounts || data.data?.tokens || data.data?.accounts;
  if (Array.isArray(list)) return list;

  const hasRefresh = !!(data.refresh_token || data.refreshToken);
  const hasAccess = !!(data.access_token || data.accessToken || data.token);
  if (hasRefresh || hasAccess) return [data];
  return null;
}

function normalizeTruthyBoolean(value) {
  return value === true || value === 'true' || value === 1;
}

function parseGeminiCliEnable(rawToken) {
  // Support enable/enabled/disabled fields
  let enable = findFieldByKeyword(rawToken, 'enable');
  if (enable === undefined) enable = findFieldByKeyword(rawToken, 'enabled');
  let disabled = findFieldByKeyword(rawToken, 'disable');
  if (disabled === undefined) disabled = findFieldByKeyword(rawToken, 'disabled');
  if (enable === undefined && disabled !== undefined) {
    enable = !normalizeTruthyBoolean(disabled);
  }
  if (enable === undefined) enable = true;
  return normalizeTruthyBoolean(enable);
}

function deriveExpiresInAndTimestamp({ expires_in, expiry, timestamp }) {
  // Support expires_in / expiry:
  // - If expires_in (seconds) is present -> use directly
  // - If only expiry (ISO8601) is present -> compute remaining seconds and set timestamp to now
  const nowMs = Date.now();

  let finalExpiresIn = null;
  if (expires_in !== undefined && expires_in !== null && String(expires_in).trim() !== '') {
    const n = parseInt(expires_in, 10);
    if (Number.isFinite(n) && n > 0) finalExpiresIn = n;
  }

  let finalTimestamp = undefined;
  if (finalExpiresIn === null && typeof expiry === 'string' && expiry.trim()) {
    const expiryMs = Date.parse(expiry);
    if (Number.isFinite(expiryMs)) {
      finalExpiresIn = Math.max(1, Math.floor((expiryMs - nowMs) / 1000));
      // When deriving from expiry, set timestamp to the current time when the token is imported
      finalTimestamp = nowMs;
    }
  }

  if (finalTimestamp === undefined) {
    if (timestamp) {
      finalTimestamp = typeof timestamp === 'number' ? timestamp : new Date(timestamp).getTime();
    } else {
      finalTimestamp = nowMs;
    }
  }

  return {
    expires_in: finalExpiresIn ?? 3599,
    timestamp: finalTimestamp
  };
}

function smartParseGeminiCliToken(rawToken) {
  if (!rawToken || typeof rawToken !== 'object') return null;

  const refresh_token = findFieldByKeyword(rawToken, 'refresh');
  if (!refresh_token) return null;

  const token = { refresh_token };

  // Common gcli field: token (= access_token)
  const access_token = findFieldByKeyword(rawToken, 'access') || rawToken.token;
  const email = findFieldByKeyword(rawToken, 'email') || findFieldByKeyword(rawToken, 'mail');
  const expires_in = findFieldByKeyword(rawToken, 'expires') || findFieldByKeyword(rawToken, 'expire');
  const timestamp = findFieldByKeyword(rawToken, 'time') || findFieldByKeyword(rawToken, 'stamp') || findFieldByKeyword(rawToken, 'created');
  const expiry = findFieldByKeyword(rawToken, 'expiry') || findFieldByKeyword(rawToken, 'expiresat');
  const projectId = findFieldByKeyword(rawToken, 'project');

  if (access_token) token.access_token = access_token;
  if (email) token.email = email;
  if (projectId) token.projectId = projectId;

  const derived = deriveExpiresInAndTimestamp({ expires_in, expiry, timestamp });
  token.expires_in = derived.expires_in;
  token.timestamp = derived.timestamp;
  token.enable = parseGeminiCliEnable(rawToken);

  return token;
}

// Import tokens (requires password verification, supports smart field mapping)
router.post('/tokens/import', cookieAuthMiddleware, async (req, res) => {
  const { password, data, mode = 'merge' } = req.body;

  if (!password || !verifyPassword(password)) {
    return res.status(403).json({ success: false, message: 'Password verification failed' });
  }

  if (!data || !data.tokens || !Array.isArray(data.tokens)) {
    return res.status(400).json({ success: false, message: 'Invalid import data format' });
  }

  try {
    const importTokens = data.tokens;
    let addedCount = 0;
    let skippedCount = 0;
    let updatedCount = 0;

    // Smartly parse all tokens
    const parsedTokens = [];
    for (const rawToken of importTokens) {
      const parsed = smartParseToken(rawToken);
      if (parsed) {
        parsedTokens.push(parsed);
      } else {
        skippedCount++;
      }
    }

    if (mode === 'replace') {
      // Replace mode: clear existing data and import new data
      await tokenManager.store.writeAll(parsedTokens);
      addedCount = parsedTokens.length;
    } else {
      // Merge mode: deduplicate by refresh_token
      const existingTokens = await tokenManager.store.readAll();
      const existingRefreshTokens = new Set(existingTokens.map(t => t.refresh_token));

      for (const token of parsedTokens) {
        if (existingRefreshTokens.has(token.refresh_token)) {
          // Update existing token
          const index = existingTokens.findIndex(t => t.refresh_token === token.refresh_token);
          if (index !== -1) {
            existingTokens[index] = { ...existingTokens[index], ...token };
            updatedCount++;
          }
        } else {
          // Add new token
          existingTokens.push(token);
          addedCount++;
        }
      }

      await tokenManager.store.writeAll(existingTokens);
    }

    await tokenManager.reload();

    logger.info(`Imported tokens: added ${addedCount}, updated ${updatedCount}, skipped ${skippedCount}`);
    res.json({
      success: true,
      message: `Import complete: ${addedCount} added, ${updatedCount} updated, ${skippedCount} skipped`,
      data: { added: addedCount, updated: updatedCount, skipped: skippedCount }
    });
  } catch (error) {
    logger.error('Failed to import tokens:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/oauth/exchange', cookieAuthMiddleware, async (req, res) => {
  const { code, port, mode = 'antigravity' } = req.body;
  if (!code || !port) {
    return res.status(400).json({ success: false, message: 'code and port are required' });
  }

  try {
    const account = await oauthManager.authenticate(code, port, mode);
    
    if (mode === 'geminicli') {
      // Gemini CLI mode
      res.json({ success: true, data: account, message: 'Gemini CLI token added successfully' });
    } else {
      // Antigravity mode
      const message = account.hasQuota
        ? 'Token added successfully'
        : 'Token added successfully (account not eligible; a random ProjectId has been assigned automatically)';
      res.json({ success: true, data: account, message, fallbackMode: !account.hasQuota });
    }
  } catch (error) {
    logger.error(`[${mode}] Authentication failed:`, error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get configuration
router.get('/config', cookieAuthMiddleware, (req, res) => {
  try {
    const envData = parseEnvFile(envPath);
    const jsonData = getConfigJson();

    res.json({ success: true, data: { env: envData, json: jsonData } });
  } catch (error) {
    logger.error('Failed to read configuration:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Update configuration
router.put('/config', cookieAuthMiddleware, (req, res) => {
  try {
    const { env: envUpdates, json: jsonUpdates, password } = req.body;

    // Security check: require password verification when modifying OFFICIAL_SYSTEM_PROMPT
    if (envUpdates && envUpdates.OFFICIAL_SYSTEM_PROMPT !== undefined) {
      const currentEnv = parseEnvFile(envPath);
      // Normalize line endings before comparing (avoid false positives from \r\n vs \n)
      const normalizeNewlines = (str) => (str || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
      const newValue = normalizeNewlines(envUpdates.OFFICIAL_SYSTEM_PROMPT);
      const oldValue = normalizeNewlines(currentEnv.OFFICIAL_SYSTEM_PROMPT);

      // Only check when the value actually changed
      if (newValue !== oldValue) {
        if (!password || !verifyPassword(password)) {
          logger.warn(`Attempted to modify OFFICIAL_SYSTEM_PROMPT with failed password verification IP: ${getClientIP(req)}`);
          return res.status(403).json({
            success: false,
            message: 'Admin password verification is required to modify OFFICIAL_SYSTEM_PROMPT'
          });
        }
      }
    }

    if (envUpdates) updateEnvFile(envPath, envUpdates);
    if (jsonUpdates) saveConfigJson(deepMerge(getConfigJson(), jsonUpdates));

    dotenv.config({ override: true });
    reloadConfig();

    // Apply hot-reloadable runtime settings
    memoryManager.setCleanupInterval(config.server.memoryCleanupInterval);

    logger.info('System configuration updated and hot-reloaded');
    res.json({ success: true, message: 'Configuration saved and applied (port/host changes require a restart)' });
  } catch (error) {
    logger.error('Failed to update configuration:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get rotation strategy configuration
router.get('/rotation', cookieAuthMiddleware, (req, res) => {
  try {
    const rotationConfig = tokenManager.getRotationConfig();
    res.json({ success: true, data: rotationConfig });
  } catch (error) {
    logger.error('Failed to get rotation configuration:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Update rotation strategy configuration
router.put('/rotation', cookieAuthMiddleware, (req, res) => {
  try {
    const { strategy, requestCount } = req.body;

    // Validate strategy value
    const validStrategies = ['round_robin', 'quota_exhausted', 'request_count'];
    if (strategy && !validStrategies.includes(strategy)) {
      return res.status(400).json({
        success: false,
        message: `Invalid strategy. Allowed values: ${validStrategies.join(', ')}`
      });
    }

    // Update in-memory configuration
    tokenManager.updateRotationConfig(strategy, requestCount);

    // Save to config.json
    const currentConfig = getConfigJson();
    if (!currentConfig.rotation) currentConfig.rotation = {};
    if (strategy) currentConfig.rotation.strategy = strategy;
    if (requestCount) currentConfig.rotation.requestCount = requestCount;
    saveConfigJson(currentConfig);

    // Reload configuration into memory
    reloadConfig();

    logger.info(`Rotation strategy updated: ${strategy || 'unchanged'}, request count: ${requestCount || 'unchanged'}`);
    res.json({ success: true, message: 'Rotation strategy updated', data: tokenManager.getRotationConfig() });
  } catch (error) {
    logger.error('Failed to update rotation configuration:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==================== Log Management API ====================

// Get log entries
router.get('/logs', cookieAuthMiddleware, (req, res) => {
  try {
    const { level, search, limit, offset } = req.query;
    const options = {
      level: level || 'all',
      search: search || '',
      limit: parseInt(limit) || 100,
      offset: parseInt(offset) || 0
    };

    const result = logger.getLogs(options);
    res.json({ success: true, data: result });
  } catch (error) {
    logger.error('Failed to get logs:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get log statistics
router.get('/logs/stats', cookieAuthMiddleware, (req, res) => {
  try {
    const stats = logger.getLogStats();
    res.json({ success: true, data: stats });
  } catch (error) {
    logger.error('Failed to get log stats:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Clear logs
router.delete('/logs', cookieAuthMiddleware, (req, res) => {
  try {
    logger.clearLogs();
    logger.info('Logs cleared');
    res.json({ success: true, message: 'Logs cleared' });
  } catch (error) {
    logger.error('Failed to clear logs:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==================== Token Quota API ====================

// ==================== Gemini CLI Token Management API ====================

// Get Gemini CLI token list
router.get('/geminicli/tokens', cookieAuthMiddleware, async (req, res) => {
  try {
    const tokens = await geminicliTokenManager.getTokenList();
    res.json({ success: true, data: tokens });
  } catch (error) {
    logger.error('[GeminiCLI] Failed to get token list:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Add Gemini CLI token
router.post('/geminicli/tokens', cookieAuthMiddleware, async (req, res) => {
  const { access_token, refresh_token, expires_in, timestamp, enable, email } = req.body;
  if (!access_token || !refresh_token) {
    return res.status(400).json({ success: false, message: 'access_token and refresh_token are required' });
  }
  const tokenData = { access_token, refresh_token, expires_in };
  if (timestamp) tokenData.timestamp = timestamp;
  if (enable !== undefined) tokenData.enable = enable;
  if (email) tokenData.email = email;

  try {
    const result = await geminicliTokenManager.addToken(tokenData);
    logger.info(`[GeminiCLI] Added new token: ${access_token.substring(0, 8)}...`);
    res.json(result);
  } catch (error) {
    logger.error('[GeminiCLI] Failed to add token:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Update Gemini CLI token
router.put('/geminicli/tokens/:tokenId', cookieAuthMiddleware, async (req, res) => {
  const { tokenId } = req.params;
  const updates = req.body;

  // Disallow updating sensitive fields via API
  delete updates.access_token;
  delete updates.refresh_token;

  try {
    const result = await geminicliTokenManager.updateTokenById(tokenId, updates);
    logger.info(`[GeminiCLI] Updated token: ${tokenId}`);
    res.json(result);
  } catch (error) {
    logger.error('[GeminiCLI] Failed to update token:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Delete Gemini CLI token
router.delete('/geminicli/tokens/:tokenId', cookieAuthMiddleware, async (req, res) => {
  const { tokenId } = req.params;
  try {
    const result = await geminicliTokenManager.deleteTokenById(tokenId);
    logger.info(`[GeminiCLI] Deleted token: ${tokenId}`);
    res.json(result);
  } catch (error) {
    logger.error('[GeminiCLI] Failed to delete token:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Hot-reload Gemini CLI tokens
router.post('/geminicli/tokens/reload', cookieAuthMiddleware, async (req, res) => {
  try {
    await geminicliTokenManager.reload();
    logger.info('[GeminiCLI] Manually triggered token hot-reload');
    res.json({ success: true, message: 'Gemini CLI tokens reloaded' });
  } catch (error) {
    logger.error('[GeminiCLI] Failed to reload tokens:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Refresh a specific Gemini CLI token
router.post('/geminicli/tokens/:tokenId/refresh', cookieAuthMiddleware, async (req, res) => {
  const { tokenId } = req.params;
  try {
    const result = await geminicliTokenManager.refreshTokenById(tokenId);
    logger.info(`[GeminiCLI] Manually refreshed token: ${tokenId}`);
    res.json({ success: true, message: 'Token refreshed successfully', data: result });
  } catch (error) {
    logger.error('[GeminiCLI] Failed to refresh token:', error.message);
    const status = error.statusCode || 500;
    res.status(status).json({ success: false, message: error.message });
  }
});

// Manually fetch Project ID for a specific Gemini CLI token
router.post('/geminicli/tokens/:tokenId/fetch-project-id', cookieAuthMiddleware, async (req, res) => {
  const { tokenId } = req.params;
  try {
    const result = await geminicliTokenManager.fetchProjectIdForToken(tokenId);
    logger.info(`[GeminiCLI] Manually fetched ProjectId: ${tokenId} -> ${result.projectId}`);
    res.json({ success: true, message: 'Project ID fetched successfully', projectId: result.projectId });
  } catch (error) {
    logger.error('[GeminiCLI] Failed to fetch ProjectId:', error.message);
    const status = error.statusCode || 500;
    res.status(status).json({ success: false, message: error.message });
  }
});

// Export Gemini CLI tokens (requires password verification)
router.post('/geminicli/tokens/export', cookieAuthMiddleware, async (req, res) => {
  const { password } = req.body;

  if (!password || !verifyPassword(password)) {
    return res.status(403).json({ success: false, message: 'Password verification failed' });
  }

  try {
    const allTokens = await geminicliTokenManager.store.readAll();

    logger.info('[GeminiCLI] Exported all token data');
    const exportData = {
      version: 1,
      exportTime: new Date().toISOString(),
      tokens: allTokens.map(token => ({
        access_token: token.access_token,
        refresh_token: token.refresh_token,
        expires_in: token.expires_in,
        timestamp: token.timestamp,
        enable: token.enable,
        email: token.email,
        projectId: token.projectId
      }))
    };

    res.json({ success: true, data: exportData });
  } catch (error) {
    logger.error('[GeminiCLI] Failed to export tokens:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Import Gemini CLI tokens (requires password verification)
router.post('/geminicli/tokens/import', cookieAuthMiddleware, async (req, res) => {
  const { password, data, mode = 'merge' } = req.body;

  if (!password || !verifyPassword(password)) {
    return res.status(403).json({ success: false, message: 'Password verification failed' });
  }

  const importList = extractGeminiCliImportList(data);

  if (!Array.isArray(importList)) {
    return res.status(400).json({ success: false, message: 'Invalid import data format' });
  }

  try {
    const importTokens = importList;
    let addedCount = 0;
    let skippedCount = 0;
    let updatedCount = 0;

    const parsedTokens = [];
    for (const rawToken of importTokens) {
      const parsed = smartParseGeminiCliToken(rawToken);
      if (parsed) parsedTokens.push(parsed);
      else skippedCount++;
    }

    if (mode === 'replace') {
      await geminicliTokenManager.store.writeAll(parsedTokens);
      addedCount = parsedTokens.length;
    } else {
      const existingTokens = await geminicliTokenManager.store.readAll();
      const existingRefreshTokens = new Set(existingTokens.map(t => t.refresh_token));

      for (const token of parsedTokens) {
        if (existingRefreshTokens.has(token.refresh_token)) {
          const index = existingTokens.findIndex(t => t.refresh_token === token.refresh_token);
          if (index !== -1) {
            existingTokens[index] = { ...existingTokens[index], ...token };
            updatedCount++;
          }
        } else {
          existingTokens.push(token);
          addedCount++;
        }
      }

      await geminicliTokenManager.store.writeAll(existingTokens);
    }

    await geminicliTokenManager.reload();

    logger.info(`[GeminiCLI] Imported tokens: added ${addedCount}, updated ${updatedCount}, skipped ${skippedCount}`);
    res.json({
      success: true,
      message: `Import complete: ${addedCount} added, ${updatedCount} updated, ${skippedCount} skipped`,
      data: { added: addedCount, updated: updatedCount, skipped: skippedCount }
    });
  } catch (error) {
    logger.error('[GeminiCLI] Failed to import tokens:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==================== IP Block Management API ====================

// Get blocked IP list
router.get('/blocked-ips', cookieAuthMiddleware, async (req, res) => {
  try {
    const list = await ipBlockManager.listBlocked();
    res.json({ success: true, data: list });
  } catch (error) {
    logger.error('Failed to get blocked IP list:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Unblock an IP address
router.post('/unblock-ip', cookieAuthMiddleware, async (req, res) => {
  try {
    const { ip } = req.body;
    if (!ip) {
      return res.status(400).json({ success: false, message: 'IP address is required' });
    }
    const success = await ipBlockManager.unblock(ip);
    if (success) {
      res.json({ success: true, message: `IP ${ip} has been unblocked` });
    } else {
      res.status(404).json({ success: false, message: 'IP is not in the block list' });
    }
  } catch (error) {
    logger.error('Failed to unblock IP:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get security configuration
router.get('/security-config', cookieAuthMiddleware, async (req, res) => {
  try {
    const config = ipBlockManager.getConfig();
    res.json({ success: true, data: config });
  } catch (error) {
    logger.error('Failed to get security configuration:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Update security configuration
router.put('/security-config', cookieAuthMiddleware, async (req, res) => {
  try {
    const { config: updates } = req.body;
    const currentConfig = ipBlockManager.getConfig();
    const mergedConfig = deepMerge(currentConfig, updates);
    await ipBlockManager.updateConfig(mergedConfig);
    res.json({ success: true, message: 'Security configuration updated' });
  } catch (error) {
    logger.error('Failed to update security configuration:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Add IP to whitelist
router.post('/whitelist-ip', cookieAuthMiddleware, async (req, res) => {
  try {
    const { ip } = req.body;
    if (!ip) {
      return res.status(400).json({ success: false, message: 'IP address is required' });
    }
    const success = await ipBlockManager.addWhitelistIP(ip);
    if (success) {
      res.json({ success: true, message: `IP ${ip} added to whitelist` });
    } else {
      res.json({ success: false, message: 'IP is already in the whitelist' });
    }
  } catch (error) {
    logger.error('Failed to add IP to whitelist:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Remove IP from whitelist
router.delete('/whitelist-ip', cookieAuthMiddleware, async (req, res) => {
  try {
    const { ip } = req.body;
    if (!ip) {
      return res.status(400).json({ success: false, message: 'IP address is required' });
    }
    const success = await ipBlockManager.removeWhitelistIP(ip);
    if (success) {
      res.json({ success: true, message: `IP ${ip} removed from whitelist` });
    } else {
      res.status(404).json({ success: false, message: 'IP is not in the whitelist' });
    }
  } catch (error) {
    logger.error('Failed to remove IP from whitelist:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==================== Token Quota API ====================

// Get model quotas for a specific token (using tokenId)
router.get('/tokens/:tokenId/quotas', cookieAuthMiddleware, async (req, res) => {
  try {
    const { tokenId } = req.params;
    const forceRefresh = req.query.refresh === 'true';
    let subscriptionInfo = null;

    // Look up full token data by tokenId
    let tokenData = await tokenManager.findTokenById(tokenId);

    if (!tokenData) {
      return res.status(404).json({ success: false, message: 'Token not found' });
    }

    // Check if token is disabled
    const isDisabled = tokenData.enable === false;

    // Use tokenId as cache key, preferring cached data
    let quotaData = quotaManager.getQuota(tokenId);

    // Disabled tokens only return cached data without refreshing or fetching new data
    if (isDisabled) {
      if (!quotaData) {
        // No cached data; return empty structure
        quotaData = { lastUpdated: null, models: {} };
      }
    } else {
      // Handle enabled token normally
      // Check if token is expired and refresh if needed
      if (tokenManager.isExpired(tokenData)) {
        try {
          tokenData = await tokenManager.refreshToken(tokenData);
        } catch (error) {
          logger.error('Failed to refresh token:', error.message);
          // Return 400 instead of 401 so the frontend doesn't mistake this for an expired admin JWT session
          return res.status(400).json({ success: false, message: 'Google token expired and refresh failed; please re-authenticate your Google account' });
        }
      }

      // Clear cache on force refresh
      if (forceRefresh) {
        quotaData = null;

        try {
          subscriptionInfo = await tokenManager.refreshSubscriptionAndCreditsById(tokenId);
        } catch (subscriptionError) {
          logger.warn(`Failed to refresh credits info: ${subscriptionError.message}`);
        }
      }

      if (!quotaData) {
        // Cache miss or force refresh: fetch from API
        const quotas = await getModelsWithQuotas(tokenData);
        quotaManager.updateQuota(tokenId, quotas);
        // Retrieve complete data (including requestCounts) from cache rather than constructing a partial object
        quotaData = quotaManager.getQuota(tokenId) || { lastUpdated: Date.now(), models: quotas, requestCounts: {} };
      }
    }

    // Convert timestamps to Beijing time (UTC+8)
    const modelsWithBeijingTime = {};
    Object.entries(quotaData.models).forEach(([modelId, quota]) => {
      modelsWithBeijingTime[modelId] = {
        remaining: quota.r,
        resetTime: quotaManager.convertToBeijingTime(quota.t),
        resetTimeRaw: quota.t
      };
    });

    // Get request counts
    const requestCounts = quotaData.requestCounts || {};

    res.json({
      success: true,
      data: {
        lastUpdated: quotaData.lastUpdated,
        models: modelsWithBeijingTime,
        requestCounts, // Return request counts for frontend estimation
        tokenMeta: subscriptionInfo ? {
          sub: subscriptionInfo.sub,
          credits: subscriptionInfo.credits,
          isActivated: subscriptionInfo.isActivated
        } : null
      }
    });
  } catch (error) {
    logger.error('Failed to get quotas:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Detect the machine's non-internal LAN IPv4 addresses (prioritizing Wi-Fi / Ethernet LAN adapters)
function getMachineLanIps() {
  const interfaces = os.networkInterfaces();
  const candidates = [];

  for (const [name, addrs] of Object.entries(interfaces)) {
    if (!Array.isArray(addrs)) continue;
    for (const addr of addrs) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      if (addr.address.startsWith('169.254.')) continue; // skip APIPA link-local
      const lowerName = name.toLowerCase();
      const isVirtual = /vethernet|wsl|docker|virtualbox|vmware|hyper-v|loopback|tailscale|zerotier|hamachi|tun|tap/.test(lowerName);
      const isPrivateLan = /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(addr.address);
      const isPrimaryName = /^(wi-fi|wifi|wlan|ethernet|eth|en\d)/.test(lowerName);
      const score = (isVirtual ? 0 : 10) + (isPrivateLan ? 5 : 0) + (isPrimaryName ? 3 : 0);
      candidates.push({ name, address: addr.address, score });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}

// Get server LAN access URLs and credentials (for multi-device access, e.g., phone/tablet)
router.get('/server-info', cookieAuthMiddleware, (req, res) => {
  try {
    const port = config.server.port;
    const candidates = getMachineLanIps();
    const primaryIp = candidates[0]?.address || '127.0.0.1';
    const baseUrl = `http://${primaryIp}:${port}`;

    res.json({
      success: true,
      data: {
        ip: primaryIp,
        allIps: candidates.map(c => ({ name: c.name, address: c.address })),
        port,
        baseUrl,
        endpoints: {
          webUi: baseUrl,
          openai: `${baseUrl}/v1`,
          gemini: `${baseUrl}/v1beta`,
          claude: `${baseUrl}/v1`,
          geminiCliOpenai: `${baseUrl}/cli/v1`,
          geminiCliGemini: `${baseUrl}/cli/v1beta`
        },
        credentials: {
          username: config.admin.username,
          password: config.admin.password,
          apiKey: config.security.apiKey
        }
      }
    });
  } catch (error) {
    logger.error('Failed to get server info:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

export default router;
