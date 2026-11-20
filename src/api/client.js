import { randomUUID } from 'crypto';
import tokenManager from '../auth/token_manager.js';
import config from '../config/config.js';
import { saveBase64Image } from '../utils/imageStorage.js';
import logger from '../utils/logger.js';
import memoryManager from '../utils/memoryManager.js';
import requesterManager from '../utils/requesterManager.js';
import { generateTrajectorybody } from '../utils/trajectory.js';
import { buildRecordCodeAssistMetricsBody } from '../utils/recordCodeAssistMetrics.js';
import { createTelemetryBatch, serializeTelemetryBatch } from "../utils/createTelemetry.js"
import { createLog1, createLog2 } from "../utils/additionalLogs.js"
import { buildClientRegister, buildFrontEnd, buildClientFeatrueHeaders, buildClientRegisterHeaders, buildFrontEndHeaders } from "../utils/unleash.js"
import { DEFAULT_RETRY_INTERVAL_MS, MODEL_LIST_CACHE_TTL, QA_PAIRS } from '../constants/index.js';
import { createApiError } from '../utils/errors.js';
import { generateCheckpointBody } from '../utils/checkPoint.js';
import axios from 'axios';
import {
  convertToToolCall,
  registerStreamMemoryCleanup
} from './stream_parser.js';
import { setSignature, shouldCacheSignature, isImageModel } from '../utils/thoughtSignatureCache.js';
import {
  isDebugDumpEnabled,
  createDumpId,
  createStreamCollector,
  collectStreamChunk,
  dumpFinalRequest,
  dumpStreamResponse,
  dumpFinalRawResponse
} from './debugDump.js';
import { getUpstreamStatus, readUpstreamErrorBody, isCallerDoesNotHavePermission } from './upstreamError.js';
import { createStreamLineProcessor } from './streamLineProcessor.js';
import { runSseStream, postJsonAndParse } from './geminiTransport.js';
import { parseGeminiCandidateParts, toOpenAIUsage } from './geminiResponseParser.js';

// ==================== Token Timer Management ====================
const tokenTimers = new Map(); // { tokenKey: { lastUsed: timestamp, intervalId: intervalId } }
const TOKEN_TIMEOUT = 3 * 60 * 1000; // 3 minutes
const BACKEND_CALL_INTERVAL = 60 * 1000; // 60 seconds
const checkPointList = new Set([]);

function getTokenKey(token) {
  return token.access_token;
}

function startTokenTimer(token) {
  const key = getTokenKey(token);
  const now = Date.now();

  if (tokenTimers.has(key)) {
    tokenTimers.get(key).lastUsed = now;
    return;
  }
  sendClientRegister(token).catch(err => logger.warn('Scheduled ClientRegister call failed:', err.message));
  sendClientFeature(token).catch(err => logger.warn('Scheduled ClientFeature call failed:', err.message));
  sendFrontEnd(token).catch(err => logger.warn('Scheduled FrontEnd call failed:', err.message));

  const intervalId = setInterval(() => {
    sendClientRegister(token).catch(err => logger.warn('Scheduled ClientRegister call failed:', err.message));
    sendClientFeature(token).catch(err => logger.warn('Scheduled ClientFeature call failed:', err.message));
    sendFrontEnd(token).catch(err => logger.warn('Scheduled FrontEnd call failed:', err.message));
  }, BACKEND_CALL_INTERVAL);

  tokenTimers.set(key, { lastUsed: now, intervalId });
}

function checkTokenTimeout() {
  const now = Date.now();
  for (const [key, data] of tokenTimers.entries()) {
    if (now - data.lastUsed > TOKEN_TIMEOUT) {
      clearInterval(data.intervalId);
      tokenTimers.delete(key);
    }
  }
}

setInterval(checkTokenTimeout, 30 * 1000); // Check for timeout every 30 seconds

// ==================== Model List Cache (Smart Management) ====================
const getModelCacheTTL = () => {
  return config.cache?.modelListTTL || MODEL_LIST_CACHE_TTL;
};

let modelListCache = null;
let modelListCacheTime = 0;

// Default model list (currently supported Antigravity models, used as fallback and merged into /v1/models)
// Frozen with Object.freeze to prevent accidental mutation and aid V8 optimization
const DEFAULT_MODELS = Object.freeze([
  // Gemini 4 (Latest Frontier Models — upstream tier-suffixed IDs + bare aliases)
  'gemini-4-carbon-high',
  'gemini-4-carbon-medium',
  'gemini-4-carbon-low',
  'gemini-4-carbon',
  'gemini-4-argon-high',
  'gemini-4-argon-medium',
  'gemini-4-argon-low',
  'gemini-4-argon',
  'gemini-4-neon-high',
  'gemini-4-neon-medium',
  'gemini-4-neon-low',
  'gemini-4-neon',
  'gemini-4-hydrogen-sonar',
  'gemini-4-hydrogen-high',
  'gemini-4-hydrogen-medium',
  'gemini-4-hydrogen-low',
  'gemini-4-hydrogen',
  // Gemini 3.8 & 3.5
  'gemini-3.8-flash-tiered',
  'gemini-3.8-flash',
  'gemini-3.5-flash-lite',
  // Gemini 3.1 & 3.0
  'gemini-3.1-pro-high',
  'gemini-3.1-pro-low',
  'gemini-3.1-flash-lite',
  'gemini-3-flash',
  // Gemini Image / Nano Banana Models
  'gemini-nano-banana-2.1',
  'gemini-nano-banana-2.1-2K',
  'gemini-nano-banana-2.1-4K',
  'gemini-3.1-flash-image',
  'gemini-3.1-flash-image-2K',
  'gemini-3.1-flash-image-4K',
  // Gemini 2.5
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-2.5-flash-thinking',
  'gemini-2.5-flash-lite',
  // Claude 5.5 Models (Latest supported in Antigravity)
  'claude-opus-5-5-thinking',
  'claude-sonnet-5-5-thinking'
]);

// Models deprecated / removed from Google Antigravity
const DEPRECATED_MODELS = Object.freeze(new Set([
  'claude-opus-4-5',
  'claude-opus-4-5-thinking',
  'claude-opus-4-6',
  'claude-opus-4-6-thinking',
  'claude-opus-4-7',
  'claude-opus-4-7-thinking',
  'claude-sonnet-4-5',
  'claude-sonnet-4-5-thinking',
  'claude-sonnet-4-6',
  'claude-sonnet-4-6-thinking',
  'gpt-oss-120b-medium',
  'chat_20706',
  'rev19-uic3-1p',
  'chat_23310'
]));

// Generate default model list response
function getDefaultModelList() {
  const created = Math.floor(Date.now() / 1000);
  return {
    object: 'list',
    data: DEFAULT_MODELS.map(id => ({
      id,
      object: 'model',
      created,
      owned_by: 'google'
    }))
  };
}


// Register memory cleanup callbacks for object pools and model cache
function registerMemoryCleanup() {
  // Stream parser module manages its own object pool sizes
  registerStreamMemoryCleanup();

  // Periodically triggered by the memory manager: only clears expired model list cache
  memoryManager.registerCleanup(() => {
    const ttl = getModelCacheTTL();
    const now = Date.now();
    if (modelListCache && (now - modelListCacheTime) > ttl) {
      modelListCache = null;
      modelListCacheTime = 0;
    }
  });
}

// Register cleanup callbacks on initialization
registerMemoryCleanup();

// ==================== Helper Functions ====================

function buildHeaders(token, hostOverride = null) {
  return {
    'Host': hostOverride || config.api.host,
    'User-Agent': config.api.userAgent,
    'Transfer-Encoding': 'chunked',
    'Authorization': `Bearer ${token.access_token}`,
    'Content-Type': 'application/json',
    'Accept-Encoding': 'gzip'
  };
}

// ==================== Upstream baseURL Fallback ====================

/**
 * Determine whether an error should trigger baseURL fallback.
 * 429 does not trigger fallback (handled by with429Retry's three-tier logic).
 * 403/400 do not trigger fallback (permission/request errors where switching URL won't help).
 */
function shouldFallback(error) {
  // Disallow fallback if stream data has already been sent to the client (avoid corrupted data)
  if (error?._skipFallback) return false;
  const status = getUpstreamStatus(error);
  if (status === 429) return false;
  if (status === 403) return false;
  if (status === 400) return false;
  if (status === 503) return true;
  if (status >= 500) return true;
  // Network error / timeout (no status or fallback default 500)
  const code = error?.code || error?.cause?.code;
  const networkCodes = [
    'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND',
    'EAI_AGAIN', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT', 'ERR_SOCKET_CONNECTION_TIMEOUT'
  ];
  if (code && networkCodes.includes(code)) return true;
  if (error?.message?.includes('timeout')) return true;
  return false;
}

function getSafeUpstreamFallbackDelayMs() {
  const value = Number(config.retryIntervalMs);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_RETRY_INTERVAL_MS;
}

function shouldWaitBeforeFallback(error) {
  return getUpstreamStatus(error) === 503;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Executor with upstream baseURL fallback.
 * Tries candidates in config.api.upstreamCandidates order, automatically switching to the next on 503/network error/5xx.
 * 503 indicates temporary capacity/resource unavailability, so it waits a fixed retry interval before trying the next upstream.
 * 429/403/400 etc. do not fallback and are rethrown for upper-layer handling.
 *
 * @param {Function} fn - (candidate) => Promise, where candidate contains { name, url, noStreamUrl, host, ... }.
 *                        When candidate is null, no candidate list is configured and default config should be used.
 * @returns {Promise<any>}
 */
async function withUpstreamFallback(fn) {
  const candidates = config.api.upstreamCandidates;
  if (!candidates || candidates.length === 0) {
    // No candidate list; execute directly with default configuration
    return fn(null);
  }
  let lastError = null;
  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index];
    try {
      return await fn(candidate);
    } catch (error) {
      lastError = error;
      if (!shouldFallback(error)) {
        throw error; // Rethrow non-fallback errors like 429/403/400 directly
      }
      const status = getUpstreamStatus(error);
      const nextCandidate = candidates[index + 1];
      if (nextCandidate && shouldWaitBeforeFallback(error)) {
        const retryIntervalMs = getSafeUpstreamFallbackDelayMs();
        logger.warn(
          `[upstream-fallback] ${candidate.name} failed (${status || 'network error'}: ${error.message?.substring(0, 100)}), ` +
          `waiting fixed interval ${retryIntervalMs}ms before trying next upstream ${nextCandidate.name}...`
        );
        await sleep(retryIntervalMs);
      } else {
        logger.warn(
          `[upstream-fallback] ${candidate.name} failed (${status || 'network error'}: ${error.message?.substring(0, 100)}), ` +
          (nextCandidate ? `trying next upstream ${nextCandidate.name}...` : 'no more upstreams to try')
        );
      }
    }
  }
  logger.error('[upstream-fallback] All upstreams failed');
  throw lastError;
}

// Unified error handling
async function handleApiError(error, token, dumpId = null) {
  const status = getUpstreamStatus(error);
  const errorBody = await readUpstreamErrorBody(error);

  if (dumpId) {
    await dumpFinalRawResponse(dumpId, String(errorBody ?? ''));
  }

  if (status === 403) {
    if (isCallerDoesNotHavePermission(errorBody)) {
      throw createApiError(`Exceeded model maximum context length. Error details: ${errorBody}`, status, errorBody);
    }
    tokenManager.disableToken(token);
    throw createApiError(`This account does not have permission and has been automatically disabled. Error details: ${errorBody}`, status, errorBody);
  }

  throw createApiError(`API request failed (${status}): ${errorBody}`, status, errorBody);
}


// ==================== Exported Functions ====================

export async function generateAssistantResponse(requestBody, token, callback) {
  startTokenTimer(token);
  const trajectoryId = requestBody.requestId.split('/')[2];
  const conversationId = randomUUID();
  const messageId = randomUUID();
  const modelName = requestBody.model;
  const dumpId = isDebugDumpEnabled() ? createDumpId('stream') : null;
  const streamCollector = dumpId ? createStreamCollector() : null;
  let num = Math.floor(Math.random() * QA_PAIRS.length);
  if (dumpId) {
    await dumpFinalRequest(dumpId, requestBody);
  }
  //console.log(JSON.stringify(requestBody,null,2));

  try {
    // Track whether stream data has already been emitted to the client (to prevent corrupted data on fallback)
    let hasEmittedData = false;
    const safeCallback = (...args) => {
      hasEmittedData = true;
      return callback(...args);
    };

    await withUpstreamFallback(async (candidate) => {
      const targetUrl = candidate?.url || config.api.url;
      const targetHost = candidate?.host || config.api.host;
      const headers = buildHeaders(token, targetHost);
      headers["Content-Length"] = String(Buffer.byteLength(JSON.stringify(requestBody)));

      // Create fresh state/processor for each fallback attempt (avoid dirty state from previous attempt)
      const state = {
        toolCalls: [],
        reasoningSignature: null,
        sessionId: requestBody.request?.sessionId,
        model: requestBody.model
      };
      const processor = createStreamLineProcessor({
        state,
        onEvent: safeCallback,
        onRawChunk: (chunk) => collectStreamChunk(streamCollector, chunk)
      });

      try {
        await runSseStream({
          url: targetUrl,
          headers,
          body: requestBody,
          processor,
          onErrorChunk: (chunk) => collectStreamChunk(streamCollector, chunk)
        });
      } catch (error) {
        try { processor.close(); } catch { }
        // Do not fallback if data has already been sent to the client (otherwise client receives duplicate/garbled stream events)
        if (hasEmittedData) {
          error._skipFallback = true;
        }
        throw error; // Let withUpstreamFallback decide whether to fallback
      }
    });

    // Write stream response to log in JSON format after it ends
    if (dumpId) {
      await dumpStreamResponse(dumpId, streamCollector);
    }
    sendRecordCodeAssistMetrics(token, trajectoryId).catch(err => logger.warn('Failed to send RecordCodeAssistMetrics:', err.message));
    sendRecordTrajectoryAnalytics(token, num, trajectoryId, messageId, conversationId, modelName).catch(err => logger.warn('Failed to send trajectory analytics:', err.message));
    sendLog(token, num, trajectoryId, conversationId, messageId).catch(err => logger.warn('Failed to send log:', err.message));
    sendCheckPoint(token).catch(err => logger.warn('Failed to send checkPoint:', err.message));;
  } catch (error) {
    await handleApiError(error, token, dumpId);
  }
}

// Internal helper: fetch raw complete model data from remote
async function fetchRawModels(headers, token) {
  try {
    const { data } = await requesterManager.fetch(config.api.modelsUrl, {
      method: 'POST',
      headers,
      body: {},
    });
    return data;
  } catch (error) {
    await handleApiError(error, token);
  }
}

export async function getAvailableModels() {
  // Check if cache is valid (dynamic TTL)
  const now = Date.now();
  const ttl = getModelCacheTTL();
  if (modelListCache && (now - modelListCacheTime) < ttl) {
    return modelListCache;
  }

  const token = await tokenManager.getToken();
  if (!token) {
    // Return default model list when no token is available
    logger.warn('No available token, returning default model list');
    return getDefaultModelList();
  }

  const headers = buildHeaders(token);
  const data = await fetchRawModels(headers, token);
  if (!data) {
    // fetchRawModels already handles errors uniformly; fall back to default list here
    return getDefaultModelList();
  }

  const created = Math.floor(Date.now() / 1000);
  const modelList = Object.keys(data.models || {})
    .filter(id => !DEPRECATED_MODELS.has(id.toLowerCase()))
    .map(id => ({
      id,
      object: 'model',
      created,
      owned_by: 'google'
    }));

  // Add default models if not present in the API response list
  const existingIds = new Set(modelList.map(m => m.id));
  for (const defaultModel of DEFAULT_MODELS) {
    if (!existingIds.has(defaultModel)) {
      modelList.push({
        id: defaultModel,
        object: 'model',
        created,
        owned_by: 'google'
      });
    }
  }

  const result = {
    object: 'list',
    data: modelList
  };

  // Update cache
  modelListCache = result;
  modelListCacheTime = now;
  const currentTTL = getModelCacheTTL();
  logger.info(`Model list cached (TTL: ${currentTTL / 1000}s, model count: ${modelList.length})`);

  return result;
}

// Clear model list cache (can be used for manual refresh)
export function clearModelListCache() {
  modelListCache = null;
  modelListCacheTime = 0;
  logger.info('Model list cache cleared');
}

export async function getModelsWithQuotas(token) {
  const headers = buildHeaders(token);
  const data = await fetchRawModels(headers, token);
  if (!data) return {};

  const quotas = {};
  Object.entries(data.models || {}).forEach(([modelId, modelData]) => {
    if (modelData.quotaInfo) {
      quotas[modelId] = {
        r: modelData.quotaInfo.remainingFraction,
        t: modelData.quotaInfo.resetTime
      };
    }
  });

  return quotas;
}

export async function generateAssistantResponseNoStream(requestBody, token) {
  startTokenTimer(token);
  const trajectoryId = requestBody.requestId.split('/')[2];
  const conversationId = randomUUID();
  const messageId = randomUUID();
  const modelName = requestBody.model;
  const dumpId = isDebugDumpEnabled() ? createDumpId('no_stream') : null;
  let num = Math.floor(Math.random() * QA_PAIRS.length);

  if (dumpId) await dumpFinalRequest(dumpId, requestBody);
  let data;
  try {
    data = await withUpstreamFallback(async (candidate) => {
      const targetUrl = candidate?.noStreamUrl || config.api.noStreamUrl;
      const targetHost = candidate?.host || config.api.host;
      const headers = buildHeaders(token, targetHost);
      headers["Content-Length"] = String(Buffer.byteLength(JSON.stringify(requestBody)));

      return postJsonAndParse({
        url: targetUrl,
        headers,
        body: requestBody,
        dumpId,
        dumpFinalRawResponse,
        rawFormat: 'json'
      });
    });
    sendRecordCodeAssistMetrics(token, trajectoryId).catch(err => logger.warn('Failed to send RecordCodeAssistMetrics:', err.message));
    sendRecordTrajectoryAnalytics(token, num, trajectoryId, messageId, conversationId, modelName).catch(err => logger.warn('Failed to send trajectory analytics:', err.message));
    sendLog(token, num, trajectoryId, conversationId, messageId).catch(err => logger.warn('Failed to send log:', err.message));
  } catch (error) {
    await handleApiError(error, token, dumpId);
  }
  //console.log(JSON.stringify(data));
  const parts = data.response?.candidates?.[0]?.content?.parts || [];
  const parsed = parseGeminiCandidateParts({
    parts,
    sessionId: requestBody.request?.sessionId,
    model: requestBody.model,
    convertToToolCall,
    saveBase64Image
  });

  const usageData = toOpenAIUsage(data.response?.usageMetadata);

  // Store the new signature and thought content in the global cache (keyed by model) as a fallback for subsequent requests
  const sessionId = requestBody.request?.sessionId;
  const model = requestBody.model;
  const hasTools = parsed.toolCalls.length > 0;
  const isImage = isImageModel(model);

  // Determine whether the signature should be cached
  if (sessionId && model && shouldCacheSignature({ hasTools, isImageModel: isImage })) {
    // Get the final signature to cache (prefer tool signature, fallback to reasoning signature)
    let finalSignature = parsed.reasoningSignature;

    // Tool signature: pick the last tool call with a thoughtSignature as the cache source (closer to "latest")
    if (hasTools) {
      for (let i = parsed.toolCalls.length - 1; i >= 0; i--) {
        const sig = parsed.toolCalls[i]?.thoughtSignature;
        if (sig) {
          finalSignature = sig;
          break;
        }
      }
    }

    if (finalSignature) {
      const cachedContent = parsed.reasoningContent || ' ';
      setSignature(sessionId, model, finalSignature, cachedContent, { hasTools, isImageModel: isImage });
    }
  }

  // Image generation models: convert to markdown format
  if (parsed.imageUrls.length > 0) {
    let markdown = parsed.content ? parsed.content + '\n\n' : '';
    markdown += parsed.imageUrls.map(url => `![image](${url})`).join('\n\n');
    return { content: markdown, reasoningContent: parsed.reasoningContent, reasoningSignature: parsed.reasoningSignature, toolCalls: parsed.toolCalls, usage: usageData };
  }

  return { content: parsed.content, reasoningContent: parsed.reasoningContent, reasoningSignature: parsed.reasoningSignature, toolCalls: parsed.toolCalls, usage: usageData };
}

export async function generateImageForSD(requestBody, token) {
  startTokenTimer(token);
  const trajectoryId = requestBody.requestId.split('/')[2];
  const conversationId = randomUUID();
  const messageId = randomUUID();
  const modelName = requestBody.model;
  const headers = buildHeaders(token);
  headers["Content-Length"] = String(Buffer.byteLength(JSON.stringify(requestBody), 'utf-8'));
  let num = Math.floor(Math.random() * QA_PAIRS.length);

  //console.log(JSON.stringify(requestBody,null,2));

  let data;
  try {
    const result = await requesterManager.fetch(config.api.noStreamUrl, {
      method: 'POST',
      headers,
      body: requestBody,
    });
    data = result.data;
  } catch (error) {
    await handleApiError(error, token);
  }
  sendRecordCodeAssistMetrics(token, trajectoryId).catch(err => logger.warn('Failed to send RecordCodeAssistMetrics:', err.message));
  sendRecordTrajectoryAnalytics(token, num, trajectoryId, messageId, conversationId, modelName).catch(err => logger.warn('Failed to send trajectory analytics:', err.message));
  sendLog(token, num, trajectoryId, conversationId, messageId).catch(err => logger.warn('Failed to send log:', err.message));

  const parts = data.response?.candidates?.[0]?.content?.parts || [];
  const images = parts.filter(p => p.inlineData).map(p => p.inlineData.data);

  return images;
}

export async function sendRecordTrajectoryAnalytics(token, num, trajectoryId, executionId, cascadeId, modelName = "claude-opus-5-5-thinking") {
  const trajectorybody = generateTrajectorybody(num, trajectoryId, executionId, cascadeId, modelName, token);
  const headers = buildHeaders(token);
  headers["Content-Length"] = String(Buffer.byteLength(JSON.stringify(trajectorybody)));
  try {
    await requesterManager.fetch(config.api.recordTrajectory, {
      method: 'POST',
      headers,
      body: trajectorybody,
      okStatus: [200],
    });
  } catch (error) {
    throw new Error(`Trajectory analytics request failed (${error.status ?? ''}): ${error.message}`);
  }
}

export async function sendLog(token, num, trajectoryId, conversationId, messageId) {
  const sessionId = trajectoryId;
  //const conversationId = randomUUID();

  const logs = [
    createLog2(conversationId, token, sessionId),
    createTelemetryBatch(num, sessionId, conversationId, messageId, token.sub),
    createLog1(conversationId, token, sessionId)
  ];

  const headers = buildHeaders(token);
  headers["Host"] = "play.googleapis.com";
  headers["User-Agent"] = "Go-http-client/1.1";
  headers["Content-Type"] = "application/octet-stream";
  headers["Accept-Encoding"] = "gzip";

  // TLS requester does not support binary body yet; always use axios here
  try {
    for (const log of logs) {
      const serializeData = serializeTelemetryBatch(log);
      if (!serializeData.success) {
        throw new Error(`Telemetry proto serialization failed: ${serializeData.error}`);
      }
      const serializeLogBody = serializeData.data;
      headers["Content-Length"] = String(serializeLogBody.length);

      await axios({
        method: 'POST',
        url: "https://play.googleapis.com/log",
        headers,
        data: serializeLogBody
      });
    }
  } catch (error) {
    throw error;
  }
}

export async function sendRecordCodeAssistMetrics(token, trajectoryId) {
  const requestBody = buildRecordCodeAssistMetricsBody(token, trajectoryId);
  const headers = buildHeaders(token);
  headers["Content-Length"] = String(Buffer.byteLength(JSON.stringify(requestBody), 'utf-8'));
  try {
    await requesterManager.fetch(config.api.recordCodeAssistMetrics, {
      method: 'POST',
      headers,
      body: requestBody,
      okStatus: [200],
    });
  } catch (error) {
    throw new Error(`RecordCodeAssistMetrics request failed (${error.status ?? ''}): ${error.message}`);
  }
}

export async function sendClientRegister(token) {
  const requestBody = buildClientRegister(token);
  const headers = buildClientRegisterHeaders(token);
  headers["Content-Length"] = String(Buffer.byteLength(JSON.stringify(requestBody), 'utf-8'));
  try {
    await requesterManager.fetch(config.api.unleash.register, {
      method: 'POST',
      headers,
      body: requestBody,
      okStatus: [200, 202],
    });
  } catch (error) {
    throw new Error(`ClientRegister request failed (${error.status ?? ''}): ${error.message}`);
  }
}

export async function sendClientFeature(token) {
  const headers = buildClientFeatrueHeaders(token);
  //console.log(headers);
  try {
    await requesterManager.fetch(config.api.unleash.features, {
      method: 'GET',
      headers,
      okStatus: [200, 202],
    });
  } catch (error) {
    throw new Error(`ClientFeature request failed (${error.status ?? ''}): ${error.message}`);
  }
}

export async function sendFrontEnd(token) {
  const requestBody = buildFrontEnd(token);
  const headers = buildFrontEndHeaders(token);
  headers["Content-Length"] = String(Buffer.byteLength(JSON.stringify(requestBody), 'utf-8'));
  try {
    await requesterManager.fetch(config.api.unleash.frontend, {
      method: 'POST',
      headers,
      body: requestBody,
      okStatus: [200, 202],
    });
  } catch (error) {
    throw new Error(`FrontEnd request failed (${error.status ?? ''}): ${error.message}`);
  }
}

export async function sendCheckPoint(token) {
  const requestBody = generateCheckpointBody(token);
  const headers = buildHeaders(token);
  headers["Content-Length"] = String(Buffer.byteLength(JSON.stringify(requestBody), 'utf-8'));
  if (checkPointList.has(token.sessionId)) {
    return;
  } else {
    checkPointList.add(token.sessionId);
  }
  try {
    await requesterManager.fetch(config.api.url, {
      method: 'POST',
      headers,
      body: requestBody,
      okStatus: [200, 202],
    });
  } catch (error) {
    throw new Error(`CheckPoint request failed (${error.status ?? ''}): ${error.message}`);
  }
}

// Export memory cleanup registration function (for external invocation)
export { registerMemoryCleanup };
