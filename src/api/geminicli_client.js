import geminicliTokenManager from '../auth/geminicli_token_manager.js';
import config from '../config/config.js';
import logger from '../utils/logger.js';
import { createApiError } from '../utils/errors.js';
import {
  convertToToolCall
} from './stream_parser.js';
import { saveBase64Image } from '../utils/imageStorage.js';
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

// ==================== Debugging: reuse debug logging implementation from client.js ====================

/**
 * Gemini CLI API Client
 * Simplified implementation based on client.js, dedicated to Gemini CLI reverse proxy.
 * Main differences:
 * 1. Uses the cloudcode-pa.googleapis.com endpoint
 * 2. Uses the GeminiCLI User-Agent
 * 3. Uses the v1internal endpoint with the model name specified in the request body
 * 4. Does not require sessionId
 */

// ==================== Helper Functions ====================

/**
 * Build Gemini CLI request headers
 * @param {Object} token - Token object
 * @returns {Object} Request headers
 */
function buildHeaders(token) {
  const geminicliConfig = config.geminicli?.api || {};
  return {
    'Host': geminicliConfig.host || 'cloudcode-pa.googleapis.com',
    'User-Agent': geminicliConfig.userAgent || 'GeminiCLI/0.1.5 (Windows; AMD64)',
    'Authorization': `Bearer ${token.access_token}`,
    'Content-Type': 'application/json',
    'Accept-Encoding': 'gzip'
  };
}

/**
 * Build Gemini CLI API URL
 * @param {boolean} stream - Whether streaming is enabled
 * @returns {string} API URL
 */
function buildApiUrl(stream = true) {
  const geminicliConfig = config.geminicli?.api || {};
  // Uses the v1internal endpoint; model name is specified in the request body
  return stream
    ? (geminicliConfig.url || 'https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse')
    : (geminicliConfig.noStreamUrl || 'https://cloudcode-pa.googleapis.com/v1internal:generateContent');
}

/**
 * Build Gemini CLI request body
 * @param {Object} requestBody - Raw request body (already containing contents, generationConfig, etc.)
 * @param {string} model - Model name
 * @param {string} projectId - Project ID (required)
 * @returns {Object} Complete request body
 */
function buildRequestBody(requestBody, model, projectId) {
  // Gemini CLI uses the v1internal endpoint, with a request format similar to Antigravity
  // Requires model, project, and request fields
  // Note: the project field is required, otherwise a 500 Internal Error is returned
  return {
    model: model,
    project: projectId,
    request: requestBody
  };
}

/**
 * Unified error handling
 * @param {Error} error - Error object
 * @param {Object} token - Token object
 */
async function handleApiError(error, token) {
  const status = getUpstreamStatus(error);
  const errorBody = await readUpstreamErrorBody(error);
  
  if (status === 403) {
    if (isCallerDoesNotHavePermission(errorBody)) {
      throw createApiError(`Exceeded model maximum context length. Error details: ${errorBody}`, status, errorBody);
    }
    geminicliTokenManager.disableCurrentToken(token);
    throw createApiError(`This account does not have permission and has been automatically disabled. Error details: ${errorBody}`, status, errorBody);
  }
  
  if (status === 429) {
    throw createApiError(`Rate limit exceeded, please try again later. Error details: ${errorBody}`, status, errorBody);
  }
  
  throw createApiError(`API request failed (${status}): ${errorBody}`, status, errorBody);
}

// ==================== Exported Functions ====================

/**
 * Generate streaming response
 * @param {Object} requestBody - Request body in Gemini API format
 * @param {Object} token - Token object (must include projectId)
 * @param {string} model - Model name
 * @param {Function} callback - Callback function
 */
export async function generateStreamResponse(requestBody, token, model, callback) {
  if (!token.projectId) {
    throw createApiError('Token is missing projectId, please retrieve ProjectId on the admin page', 400);
  }
  
  const headers = buildHeaders(token);
  const url = buildApiUrl(true);
  const fullRequestBody = buildRequestBody(requestBody, model, token.projectId);
  
  // Debug logging
  const dumpId = isDebugDumpEnabled() ? createDumpId('cli_stream') : null;
  const streamCollector = dumpId ? createStreamCollector() : null;
  if (dumpId) {
    await dumpFinalRequest(dumpId, fullRequestBody);
  }
  
  // State object for stream parsing
  const state = {
    toolCalls: [],
    reasoningSignature: null,
    sessionId: null, // Gemini CLI does not use sessionId
    model: model
  };
  const processor = createStreamLineProcessor({
    state,
    onEvent: callback,
    onRawChunk: (chunk) => collectStreamChunk(streamCollector, chunk)
  });
  
  try {
    await runSseStream({
      url,
      headers,
      body: fullRequestBody,
      processor
    });
    
    // Write debug log after stream response ends
    if (dumpId) {
      await dumpStreamResponse(dumpId, streamCollector);
    }
  } catch (error) {
    try { processor.close(); } catch { }
    await handleApiError(error, token);
  }
}

/**
 * Generate non-streaming response
 * @param {Object} requestBody - Request body in Gemini API format
 * @param {Object} token - Token object (must include projectId)
 * @param {string} model - Model name
 * @returns {Promise<Object>} Response content
 */
export async function generateNoStreamResponse(requestBody, token, model) {
  if (!token.projectId) {
    throw createApiError('Token is missing projectId, please retrieve ProjectId on the admin page', 400);
  }
  
  const headers = buildHeaders(token);
  const url = buildApiUrl(false);
  const fullRequestBody = buildRequestBody(requestBody, model, token.projectId);
  
  // Debug logging
  const dumpId = isDebugDumpEnabled() ? createDumpId('cli_no_stream') : null;
  if (dumpId) {
    await dumpFinalRequest(dumpId, fullRequestBody);
  }
  
  let data;
  try {
    data = await postJsonAndParse({
      url,
      headers,
      body: fullRequestBody,
      dumpId,
      dumpFinalRawResponse
    });
  } catch (error) {
    await handleApiError(error, token);
  }
  
  // Handle GeminiCLI response wrapper format
  // GeminiCLI API returns: { "response": { "candidates": [...] } }
  if (data.response) {
    data = data.response;
  }
  
  // Parse response content
  const parts = (data.candidates?.[0]?.content?.parts) || [];
  const parsed = parseGeminiCandidateParts({
    parts,
    sessionId: null,
    model,
    convertToToolCall,
    saveBase64Image
  });

  const usageData = toOpenAIUsage(data.usageMetadata);

  if (parsed.imageUrls.length > 0) {
    let markdown = parsed.content ? parsed.content + '\n\n' : '';
    markdown += parsed.imageUrls.map(url => `![image](${url})`).join('\n\n');
    return {
      content: markdown,
      reasoningContent: parsed.reasoningContent,
      reasoningSignature: parsed.reasoningSignature,
      toolCalls: parsed.toolCalls,
      usage: usageData
    };
  }

  return {
    content: parsed.content,
    reasoningContent: parsed.reasoningContent,
    reasoningSignature: parsed.reasoningSignature,
    toolCalls: parsed.toolCalls,
    usage: usageData
  };
}

/**
 * Get an available token
 * @returns {Promise<Object|null>} Token object
 */
export async function getToken() {
  return geminicliTokenManager.getToken();
}

/**
 * Disable the current token
 * @param {Object} token - Token object
 */
export function disableCurrentToken(token) {
  geminicliTokenManager.disableCurrentToken(token);
}

/**
 * Record a request (used for round-robin strategy)
 * @param {Object} token - Token object
 */
export function recordRequest(token) {
  if (token && token.refresh_token) {
    geminicliTokenManager.incrementRequestCount(token.refresh_token);
  }
}
