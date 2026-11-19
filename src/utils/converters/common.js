// Common converter module
import config from '../../config/config.js';
import { generateRequestId } from '../idGenerator.js';
import { getSignature, shouldCacheSignature, isImageModel } from '../thoughtSignatureCache.js';
import { setToolNameMapping } from '../toolNameCache.js';
import { getThoughtSignatureForModel, getToolSignatureForModel, sanitizeToolName, modelMapping, isEnableThinking, generateGenerationConfig } from '../utils.js';

/**
 * Get signature context
 * @param {string} sessionId - Session ID
 * @param {string} actualModelName - Actual model name
 * @param {boolean} hasTools - Whether the request includes tool definitions
 * @returns {Object} Object containing thought signature, thinking content, and tool signature
 */
export function getSignatureContext(sessionId, actualModelName, hasTools = false) {
  const isImage = isImageModel(actualModelName);

  // Determine whether to fetch the signature from cache
  const shouldGetCached = shouldCacheSignature({ hasTools, isImageModel: isImage });

  // Fetch cached signature + content object (returns { signature, content } or null)
  const cachedEntry = shouldGetCached ? getSignature(sessionId, actualModelName, { hasTools }) : null;

  // Build return value: prefer cache (signature + content), fallback to default signature (signature only, no content)
  let reasoningSignature = null;
  let reasoningContent = ' ';
  let toolSignature = null;
  let toolContent = ' ';

  if (cachedEntry) {
    // Unified cache: used for both reasoning and tool
    reasoningSignature = cachedEntry.signature;
    reasoningContent = cachedEntry.content || ' ';
    toolSignature = cachedEntry.signature;
    toolContent = cachedEntry.content || ' ';
  } else if (config.useFallbackSignature) {
    // Fallback signature
    reasoningSignature = getThoughtSignatureForModel(actualModelName);
    reasoningContent = config.cacheThinking ? ' ' : ' '; // Fallback signature has no associated content

    if (hasTools) {
      toolSignature = getToolSignatureForModel(actualModelName);
      toolContent = ' ';
    }
  }

  return {
    reasoningSignature,
    reasoningContent,
    toolSignature,
    toolContent
  };
}

/**
 * Append user message to antigravityMessages
 * @param {Object} extracted - Extracted content { text, images }
 * @param {Array} antigravityMessages - Target message array
 */
export function pushUserMessage(extracted, antigravityMessages) {
  antigravityMessages.push({
    role: 'user',
    parts: [{ text: extracted?.text || ' ' }, ...extracted.images]
  });
}

/**
 * Find function name by tool call ID
 * @param {string} toolCallId - Tool call ID
 * @param {Array} antigravityMessages - Message array
 * @returns {string} Function name
 */
export function findFunctionNameById(toolCallId, antigravityMessages) {
  for (let i = antigravityMessages.length - 1; i >= 0; i--) {
    if (antigravityMessages[i].role === 'model') {
      const parts = antigravityMessages[i].parts;
      for (const part of parts) {
        if (part.functionCall && part.functionCall.id === toolCallId) {
          return part.functionCall.name;
        }
      }
    }
  }
  return '';
}

/**
 * Append function response to antigravityMessages
 * @param {string} toolCallId - Tool call ID
 * @param {string} functionName - Function name
 * @param {string} resultContent - Response content
 * @param {Array} antigravityMessages - Target message array
 */
export function pushFunctionResponse(toolCallId, functionName, resultContent, antigravityMessages) {
  const lastMessage = antigravityMessages[antigravityMessages.length - 1];
  const functionResponse = {
    functionResponse: {
      id: toolCallId,
      name: functionName,
      response: { output: resultContent }
    }
  };

  if (lastMessage?.role === 'user' && lastMessage.parts.some(p => p.functionResponse)) {
    lastMessage.parts.push(functionResponse);
  } else {
    antigravityMessages.push({ role: 'user', parts: [functionResponse] });
  }
}

/**
 * Create a thought part with optional signature
 * @param {string} text - Thought text
 * @param {string} signature - Signature
 * @returns {Object} Thought part
 */
export function createThoughtPart(text, signature = null) {
  const part = { text: text || ' ', thought: true };
  if (signature) part.thoughtSignature = signature;
  return part;
}

/**
 * Create a function call part with optional signature
 * @param {string} id - Call ID
 * @param {string} name - Function name (sanitized)
 * @param {Object|string} args - Arguments
 * @param {string} signature - Signature (optional)
 * @returns {Object} Function call part
 */
export function createFunctionCallPart(id, name, args, signature = null) {
  const part = {
    functionCall: {
      id,
      name,
      args: typeof args === 'string' ? JSON.parse(args) : args
    }
  };
  if (signature) {
    part.thoughtSignature = signature;
  }
  return part;
}

/**
 * Process tool name mapping
 * @param {string} originalName - Original name
 * @param {string} sessionId - Session ID
 * @param {string} actualModelName - Actual model name
 * @returns {string} Sanitized safe name
 */
export function processToolName(originalName, sessionId, actualModelName) {
  const safeName = sanitizeToolName(originalName);
  if (actualModelName && safeName !== originalName) {
    setToolNameMapping(actualModelName, safeName, originalName);
  }
  return safeName;
}

/**
 * Append model message to antigravityMessages
 * @param {Object} options - Options
 * @param {Array} options.parts - Message parts
 * @param {Array} options.toolCalls - Tool call parts
 * @param {boolean} options.hasContent - Whether text content is present
 * @param {Array} antigravityMessages - Target message array
 */
export function pushModelMessage({ parts, toolCalls, hasContent }, antigravityMessages) {
  const lastMessage = antigravityMessages[antigravityMessages.length - 1];
  const hasToolCalls = toolCalls && toolCalls.length > 0;

  if (lastMessage?.role === 'model' && hasToolCalls && !hasContent) {
    lastMessage.parts.push(...toolCalls);
  } else {
    const allParts = [...parts, ...(toolCalls || [])];
    antigravityMessages.push({ role: 'model', parts: allParts });
  }
  //console.log(JSON.stringify(antigravityMessages,null,2));
}

/**
 * Build base request body
 * @param {Object} options - Options
 * @param {Array} options.contents - Message contents
 * @param {Array} options.tools - Tool list
 * @param {Object} options.generationConfig - Generation configuration
 * @param {string} options.sessionId - Session ID
 * @param {string} options.systemInstruction - System instruction
 * @param {boolean} options.useCredits - Whether to use credits (optional, used to force credits on retry)
 * @param {Object} token - Token object
 * @param {string} actualModelName - Actual model name
 * @returns {Object} Request body
 */
export function buildRequestBody({ contents, tools, generationConfig, sessionId, systemInstruction, useCredits }, token, actualModelName) {
  const hasTools = tools && tools.length > 0;

  const requestBody = {
    project: token.projectId,
    requestId: generateRequestId(),
    request: {
      contents,
      generationConfig,
      sessionId
    },
    model: actualModelName,
    userAgent: 'antigravity',
    requestType: 'agent'
  };

  // Only add tools and toolConfig fields when tools are present
  if (hasTools) {
    requestBody.request.tools = tools;
    requestBody.request.toolConfig = { functionCallingConfig: { mode: 'VALIDATED' } };
  }

  // Build system prompt
  const systemInstructionObj = buildSystemInstruction(systemInstruction);
  if (systemInstructionObj) {
    requestBody.request.systemInstruction = systemInstructionObj;
  }

  // Credit usage logic: inject credit field if alwaysUseCredits is enabled or useCredits is explicitly true
  if (config.alwaysUseCredits || useCredits === true) {
    requestBody.enabledCreditTypes = ["GOOGLE_ONE_AI"];
  }

  return requestBody;
}

/**
 * Clean system instruction part by removing fields unsupported by the Gemini API
 * @param {Object} part - Original part object
 * @returns {Object} Cleaned part object (keeping only Gemini-supported fields like text, inlineData)
 */
function cleanSystemPart(part) {
  if (!part || typeof part !== 'object') return part;

  const cleanedPart = {};

  // Keep only part fields supported by the Gemini API
  if (part.text !== undefined) {
    cleanedPart.text = part.text;
  }
  if (part.inlineData !== undefined) {
    cleanedPart.inlineData = part.inlineData;
  }
  if (part.fileData !== undefined) {
    cleanedPart.fileData = part.fileData;
  }

  // Return the cleaned part, or null if there is no valid content
  return Object.keys(cleanedPart).length > 0 ? cleanedPart : null;
}

/**
 * Build system prompt parts array
 *
 * Logic overview:
 * 1. Official prompt: Prompt required by Antigravity official backend, editable in frontend
 * 2. Proxy prompt: Built-in proxy prompt, editable in frontend
 * 3. User request prompt: System message passed by the user in the API request
 *
 * Configuration options:
 * - useContextSystemPrompt: When enabled, appends user request's system prompt after the proxy prompt
 * - mergeSystemPrompt: When enabled, merges all prompts into a single part (requires useContextSystemPrompt)
 * - officialPromptPosition: Position of official prompt, 'before' = before proxy prompt, 'after' = after proxy prompt
 *
 * @param {string|Array} userSystemPrompt - System prompt from the user request (string or parts array)
 * @returns {Array} System prompt parts array
 */
export function buildSystemPromptParts(userSystemPrompt) {
  const parts = [];

  // Get each prompt layer (config.js handles defaults, use directly)
  const officialPrompt = config.officialSystemPrompt;
  const proxyPrompt = config.systemInstruction;

  // Handle user prompt: may be a string or parts array
  let userParts = [];
  if (userSystemPrompt) {
    if (typeof userSystemPrompt === 'string' && userSystemPrompt.trim()) {
      userParts = [{ text: userSystemPrompt.trim() }];
    } else if (Array.isArray(userSystemPrompt)) {
      // Clean each part, removing fields unsupported by Gemini API (e.g., type, cache_control)
      userParts = userSystemPrompt
        .map(p => cleanSystemPart(p))
        .filter(p => p !== null);
    } else if (typeof userSystemPrompt === 'object' && userSystemPrompt.parts) {
      // Handle { role: 'user', parts: [...] } format
      userParts = userSystemPrompt.parts
        .map(p => cleanSystemPart(p))
        .filter(p => p !== null);
    }
  }

  // Build proxy prompt parts (may include user request's system prompt)
  const proxyParts = [];
  if (proxyPrompt.trim()) {
    proxyParts.push({ text: proxyPrompt.trim() });
  }

  // If context system prompt is enabled, append user request's system prompt after proxy prompt
  if (config.useContextSystemPrompt && userParts.length > 0) {
    proxyParts.push(...userParts);
  }

  // Combine final parts array according to officialPromptPosition configuration
  if (config.officialPromptPosition === 'before') {
    // Official prompt before proxy prompt
    if (officialPrompt.trim()) {
      parts.push({ text: officialPrompt.trim() });
    }
    parts.push(...proxyParts);
  } else {
    // Official prompt after proxy prompt
    parts.push(...proxyParts);
    if (officialPrompt.trim()) {
      parts.push({ text: officialPrompt.trim() });
    }
  }

  return parts;
}

/**
 * Build system instruction (merged into a single string or preserving multi-part structure)
 * @param {string|Array} userSystemPrompt - System prompt from the user request
 * @returns {Object} { text: string } or { parts: Array }
 */
export function buildSystemInstruction(userSystemPrompt) {
  const parts = buildSystemPromptParts(userSystemPrompt);

  if (parts.length === 0) {
    return null;
  }

  if (config.mergeSystemPrompt) {
    // Merge into a single string
    const mergedText = parts
      .map(p => p.text || '')
      .filter(t => t.trim())
      .join('\n\n');
    return {
      role: 'user',
      parts: [{ text: mergedText }]
    };
  } else {
    // Preserve multi-part structure
    return {
      role: 'user',
      parts: parts
    };
  }
}

/**
 * Merge system instructions (legacy interface compatibility)
 * @param {string} baseSystem - Base system instruction (proxy prompt)
 * @param {string} contextSystem - Context system instruction (prompt from user request)
 * @returns {string} Merged system instruction
 */
export function mergeSystemInstruction(baseSystem, contextSystem) {
  // Use the new builder function
  const result = buildSystemInstruction(contextSystem);

  if (!result) {
    return baseSystem || '';
  }

  // Return merged text
  if (result.parts && result.parts.length > 0) {
    return result.parts.map(p => p.text || '').filter(t => t.trim()).join('\n\n');
  }

  return baseSystem || '';
}

// Re-export common functions
export { sanitizeToolName, modelMapping, isEnableThinking, generateGenerationConfig };

// Re-export parameter normalization functions
export {
  normalizeOpenAIParameters,
  normalizeClaudeParameters,
  normalizeGeminiParameters,
  normalizeParameters,
  toGenerationConfig
} from '../parameterNormalizer.js';
