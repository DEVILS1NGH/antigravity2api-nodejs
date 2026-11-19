/**
 * Claude format handler
 * Handles /v1/messages requests with streaming and non-streaming responses
 */

import { generateAssistantResponse, generateAssistantResponseNoStream, getModelsWithQuotas } from '../../api/client.js';
import { generateClaudeRequestBody, prepareImageRequest } from '../../utils/utils.js';
import { normalizeClaudeParameters } from '../../utils/parameterNormalizer.js';
import { buildClaudeErrorPayload } from '../../utils/errors.js';
import logger from '../../utils/logger.js';
import config from '../../config/config.js';
import tokenManager from '../../auth/token_manager.js';
import quotaManager from '../../auth/quota_manager.js';
import { createClaudeResponse } from '../formatters/claude.js';
import { validateIncomingChatRequest } from '../validators/chat.js';
import { getSafeRetries } from './common/retry.js';
import {
  setStreamHeaders,
  createHeartbeat,
  with429Retry
} from '../stream.js';

/**
 * Create a Claude SSE streaming event
 * @param {string} eventType - Event type
 * @param {Object} data - Event payload
 * @returns {string}
 */
export const createClaudeStreamEvent = (eventType, data) => {
  return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
};

/**
 * Handle Claude-format chat requests
 * @param {Request} req - Express request object
 * @param {Response} res - Express response object
 * @param {boolean} isStream - Whether to stream the response
 */
export const handleClaudeRequest = async (req, res, isStream) => {
  const body = req.body || {};
  const { messages, model, system, tools, ...rawParams } = body;

  try {
    const validation = validateIncomingChatRequest('claude', body);
    if (!validation.ok) {
      return res.status(validation.status).json(buildClaudeErrorPayload({ message: validation.message }, validation.status));
    }
    if (typeof model !== 'string' || !model) {
      return res.status(400).json(buildClaudeErrorPayload({ message: 'model is required' }, 400));
    }

    // Normalize Claude-format parameters using the unified parameter normalizer
    const parameters = normalizeClaudeParameters(rawParams);

    const isImageModel = model.includes('-image');
    let token = null;
    let tokenId = null;
    let requestBody = null;

    const applyTokenState = async (nextToken) => {
      if (!nextToken) return false;

      token = nextToken;
      tokenId = await tokenManager.getTokenId(token);
      requestBody = generateClaudeRequestBody(messages, model, parameters, tools, system, token);
      if (isImageModel) {
        prepareImageRequest(requestBody);
      }
      return true;
    };

    if (!await applyTokenState(await tokenManager.getToken(model))) {
      throw new Error('No available tokens. Please run npm run login to obtain a token');
    }

    const refreshQuota = async () => {
      if (!tokenId || !token) return;
      const quotas = await getModelsWithQuotas(token);
      quotaManager.updateQuota(tokenId, quotas);
    };

    // Build with429Retry options
    const createRetryOptions = (prefix) => ({
      loggerPrefix: prefix,
      onAttempt: () => tokenManager.recordRequest(token, model),
      getTokenId: () => tokenId,
      modelId: model,
      refreshQuota,
      tokenManager,
      getToken: () => token,
      onBeforeRetry: async ({ previousTokenId }) => {
        const nextToken = await tokenManager.getTokenForRetry(model, previousTokenId);
        return applyTokenState(nextToken);
      }
    });

    const msgId = `msg_${Date.now()}`;
    const safeRetries = getSafeRetries(config.retryTimes);

    if (isStream) {
      setStreamHeaders(res);
      const heartbeatTimer = createHeartbeat(res);

      try {
        let contentIndex = 0;
        let usageData = null;
        let hasToolCall = false;
        let currentBlockType = null;
        let reasoningSent = false;

        // Send message_start
        res.write(createClaudeStreamEvent('message_start', {
          type: "message_start",
          message: {
            id: msgId,
            type: "message",
            role: "assistant",
            content: [],
            model: model,
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 }
          }
        }));

        if (isImageModel) {
          // Image model: fetch non-streaming result and return in streaming format
          const { content, usage } = await with429Retry(
            (attempt, shouldUseCredits) => {
              const actualRequestBody = shouldUseCredits 
                ? { ...requestBody, enabledCreditTypes: ["GOOGLE_ONE_AI"] }
                : requestBody;
              return generateAssistantResponseNoStream(actualRequestBody, token);
            },
            safeRetries,
            createRetryOptions('claude.stream.image ')
          );

          // Send text block
          res.write(createClaudeStreamEvent('content_block_start', {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" }
          }));
          res.write(createClaudeStreamEvent('content_block_delta', {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: content || '' }
          }));
          res.write(createClaudeStreamEvent('content_block_stop', {
            type: "content_block_stop",
            index: 0
          }));

          // Send message_delta and message_stop
          res.write(createClaudeStreamEvent('message_delta', {
            type: "message_delta",
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: usage ? { output_tokens: usage.completion_tokens || 0 } : { output_tokens: 0 }
          }));
          res.write(createClaudeStreamEvent('message_stop', {
            type: "message_stop"
          }));

          clearInterval(heartbeatTimer);
          res.end();
          return;
        }

        await with429Retry(
          (attempt, shouldUseCredits) => {
            const actualRequestBody = shouldUseCredits 
              ? { ...requestBody, enabledCreditTypes: ["GOOGLE_ONE_AI"] }
              : requestBody;
            return generateAssistantResponse(actualRequestBody, token, (data) => {
              if (data.type === 'usage') {
                usageData = data.usage;
              } else if (data.type === 'reasoning') {
                // Chain-of-thought content - emit as thinking block
                if (!reasoningSent) {
                  // Close any previously opened text block first
                  if (currentBlockType === 'text') {
                    res.write(createClaudeStreamEvent('content_block_stop', {
                      type: "content_block_stop",
                      index: contentIndex
                    }));
                    contentIndex++;
                    currentBlockType = null;
                  }
                  // Start thinking block
                  const contentBlock = { type: "thinking", thinking: "" };
                  if (data.thoughtSignature && config.passSignatureToClient) {
                    contentBlock.signature = data.thoughtSignature;
                  }
                  res.write(createClaudeStreamEvent('content_block_start', {
                    type: "content_block_start",
                    index: contentIndex,
                    content_block: contentBlock
                  }));
                  currentBlockType = 'thinking';
                  reasoningSent = true;
                }
                // Send thinking delta
                const delta = { type: "thinking_delta", thinking: data.reasoning_content || '' };
                if (data.thoughtSignature && config.passSignatureToClient) {
                  delta.signature = data.thoughtSignature;
                }
                res.write(createClaudeStreamEvent('content_block_delta', {
                  type: "content_block_delta",
                  index: contentIndex,
                  delta: delta
                }));
              } else if (data.type === 'tool_calls') {
                hasToolCall = true;
                // Close previous block if any
                if (currentBlockType) {
                  res.write(createClaudeStreamEvent('content_block_stop', {
                    type: "content_block_stop",
                    index: contentIndex
                  }));
                  contentIndex++;
                }
                // Tool calls
                for (const tc of data.tool_calls) {
                  try {
                    const inputObj = JSON.parse(tc.function.arguments);
                    const toolContentBlock = { type: "tool_use", id: tc.id, name: tc.function.name, input: {} };
                    if (tc.thoughtSignature && config.passSignatureToClient) {
                      toolContentBlock.signature = tc.thoughtSignature;
                    }
                    res.write(createClaudeStreamEvent('content_block_start', {
                      type: "content_block_start",
                      index: contentIndex,
                      content_block: toolContentBlock
                    }));
                    // Send input delta
                    res.write(createClaudeStreamEvent('content_block_delta', {
                      type: "content_block_delta",
                      index: contentIndex,
                      delta: { type: "input_json_delta", partial_json: JSON.stringify(inputObj) }
                    }));
                    res.write(createClaudeStreamEvent('content_block_stop', {
                      type: "content_block_stop",
                      index: contentIndex
                    }));
                    contentIndex++;
                  } catch (e) {
                    // Skip on parse failure
                  }
                }
                currentBlockType = null;
              } else {
                // Regular text content
                const textContent = data.content || '';

                // Skip empty text before thinking is sent (avoid creating an empty text block ahead of thinking)
                if (!reasoningSent && !textContent) {
                  return;
                }

                if (currentBlockType === 'thinking') {
                  // Close thinking block
                  res.write(createClaudeStreamEvent('content_block_stop', {
                    type: "content_block_stop",
                    index: contentIndex
                  }));
                  contentIndex++;
                  currentBlockType = null;
                }
                if (currentBlockType !== 'text') {
                  // Start text block
                  res.write(createClaudeStreamEvent('content_block_start', {
                    type: "content_block_start",
                    index: contentIndex,
                    content_block: { type: "text", text: "" }
                  }));
                  currentBlockType = 'text';
                }
                // Send text delta
                res.write(createClaudeStreamEvent('content_block_delta', {
                  type: "content_block_delta",
                  index: contentIndex,
                  delta: { type: "text_delta", text: textContent }
                }));
              }
            });
          },
          safeRetries,
          createRetryOptions('claude.stream ')
        );

        // Close the final content block
        if (currentBlockType) {
          res.write(createClaudeStreamEvent('content_block_stop', {
            type: "content_block_stop",
            index: contentIndex
          }));
        }

        // Send message_delta
        const stopReason = hasToolCall ? 'tool_use' : 'end_turn';
        res.write(createClaudeStreamEvent('message_delta', {
          type: "message_delta",
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage: usageData ? { output_tokens: usageData.completion_tokens || 0 } : { output_tokens: 0 }
        }));

        // Send message_stop
        res.write(createClaudeStreamEvent('message_stop', {
          type: "message_stop"
        }));

        clearInterval(heartbeatTimer);
        res.end();
      } catch (error) {
        clearInterval(heartbeatTimer);
        if (!res.writableEnded) {
          const statusCode = error.statusCode || error.status || 500;
          res.write(createClaudeStreamEvent('error', buildClaudeErrorPayload(error, statusCode)));
          res.end();
        }
        logger.error('Claude streaming request failed:', error.message);
        return;
      }
    } else if (config.fakeNonStream && !isImageModel) {
      // Fake non-stream mode: fetch via streaming API and assemble a non-streaming response
      req.setTimeout(0);
      res.setTimeout(0);

      let content = '';
      let reasoningContent = '';
      let reasoningSignature = null;
      const toolCalls = [];
      let usageData = null;

      try {
        await with429Retry(
          (attempt, shouldUseCredits) => {
            const actualRequestBody = shouldUseCredits 
              ? { ...requestBody, enabledCreditTypes: ["GOOGLE_ONE_AI"] }
              : requestBody;
            return generateAssistantResponse(actualRequestBody, token, (data) => {
              if (data.type === 'usage') {
                usageData = data.usage;
              } else if (data.type === 'reasoning') {
                reasoningContent += data.reasoning_content || '';
                if (data.thoughtSignature) {
                  reasoningSignature = data.thoughtSignature;
                }
              } else if (data.type === 'tool_calls') {
                toolCalls.push(...data.tool_calls);
              } else if (data.type === 'text') {
                content += data.content || '';
              }
            });
          },
          safeRetries,
          createRetryOptions('claude.fake_no_stream ')
        );

        const stopReason = toolCalls.length > 0 ? 'tool_use' : 'end_turn';
        const response = createClaudeResponse(
          msgId,
          model,
          content,
          reasoningContent || null,
          reasoningSignature,
          toolCalls,
          stopReason,
          usageData,
          { passSignatureToClient: config.passSignatureToClient }
        );

        res.json(response);
      } catch (error) {
        logger.error('Claude fake non-stream request failed:', error.message);
        if (res.headersSent) return;
        const statusCode = error.statusCode || error.status || 500;
        res.status(statusCode).json(buildClaudeErrorPayload(error, statusCode));
      }
    } else {
      // Non-streaming request
      req.setTimeout(0);
      res.setTimeout(0);

      const { content, reasoningContent, reasoningSignature, toolCalls, usage } = await with429Retry(
        (attempt, shouldUseCredits) => {
          const actualRequestBody = shouldUseCredits 
            ? { ...requestBody, enabledCreditTypes: ["GOOGLE_ONE_AI"] }
            : requestBody;
          return generateAssistantResponseNoStream(actualRequestBody, token);
        },
        safeRetries,
        createRetryOptions('claude.no_stream ')
      );

      const stopReason = toolCalls.length > 0 ? 'tool_use' : 'end_turn';
      const response = createClaudeResponse(
        msgId,
        model,
        content,
        reasoningContent,
        reasoningSignature,
        toolCalls,
        stopReason,
        usage,
        { passSignatureToClient: config.passSignatureToClient }
      );

      res.json(response);
    }
  } catch (error) {
    logger.error('Claude request failed:', error.message);
    if (res.headersSent) return;
    const statusCode = error.statusCode || error.status || 500;
    res.status(statusCode).json(buildClaudeErrorPayload(error, statusCode));
  }
};
