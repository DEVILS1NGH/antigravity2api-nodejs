/**
 * OpenAI format handler
 * Handles /v1/chat/completions requests with streaming and non-streaming responses
 */

import { generateAssistantResponse, generateAssistantResponseNoStream, getModelsWithQuotas } from '../../api/client.js';
import { generateRequestBody, prepareImageRequest } from '../../utils/utils.js';
import { buildOpenAIErrorPayload } from '../../utils/errors.js';
import logger from '../../utils/logger.js';
import config from '../../config/config.js';
import tokenManager from '../../auth/token_manager.js';
import quotaManager from '../../auth/quota_manager.js';
import {
  createOpenAIStreamChunk as createStreamChunk,
  createOpenAIChatCompletionResponse
} from '../formatters/openai.js';
import { validateIncomingChatRequest } from '../validators/chat.js';
import { getSafeRetries } from './common/retry.js';
import {
  createResponseMeta,
  setStreamHeaders,
  createHeartbeat,
  writeStreamData,
  endStream,
  with429Retry
} from '../stream.js';

/**
 * Handle OpenAI-format chat requests
 * @param {Request} req - Express request object
 * @param {Response} res - Express response object
 */
export const handleOpenAIRequest = async (req, res) => {
  const body = req.body || {};
  const { messages, model, stream = false, tools, ...params } = body;

  try {
    const validation = validateIncomingChatRequest('openai', body);
    if (!validation.ok) {
      return res.status(validation.status).json({ error: validation.message });
    }
    if (typeof model !== 'string' || !model) {
      return res.status(400).json({ error: 'model is required' });
    }

    const isImageModel = model.includes('-image');
    let token = null;
    let tokenId = null;
    let requestBody = null;

    const applyTokenState = async (nextToken) => {
      if (!nextToken) return false;

      token = nextToken;
      tokenId = await tokenManager.getTokenId(token);
      requestBody = generateRequestBody(messages, model, params, tools, token);
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
    //console.log(JSON.stringify(requestBody,null,2));
    const { id, created } = createResponseMeta();
    const safeRetries = getSafeRetries(config.retryTimes);

    if (stream) {
      setStreamHeaders(res);

      // Start heartbeat to prevent Cloudflare idle timeout disconnects
      const heartbeatTimer = createHeartbeat(res);

      try {
        if (isImageModel) {
          const { content, usage, reasoningSignature } = await with429Retry(
            (attempt, shouldUseCredits) => {
              const actualRequestBody = shouldUseCredits 
                ? { ...requestBody, enabledCreditTypes: ["GOOGLE_ONE_AI"] }
                : requestBody;
              return generateAssistantResponseNoStream(actualRequestBody, token);
            },
            safeRetries,
            createRetryOptions('chat.stream.image ')
          );
          const delta = { content };
          if (reasoningSignature && config.passSignatureToClient) {
            delta.thoughtSignature = reasoningSignature;
          }
          writeStreamData(res, createStreamChunk(id, created, model, delta));
          writeStreamData(res, { ...createStreamChunk(id, created, model, {}, 'stop'), usage });
        } else {
          let hasToolCall = false;
          let usageData = null;
          let hasEmittedTextContent = false;
          let accumulatedReasoning = '';

          await with429Retry(
            (attempt, shouldUseCredits) => {
              const actualRequestBody = shouldUseCredits 
                ? { ...requestBody, enabledCreditTypes: ["GOOGLE_ONE_AI"] }
                : requestBody;
              return generateAssistantResponse(actualRequestBody, token, (data) => {
                if (data.type === 'usage') {
                  usageData = data.usage;
                } else if (data.type === 'reasoning') {
                  if (data.reasoning_content) {
                    accumulatedReasoning += data.reasoning_content;
                  }
                  const delta = { reasoning_content: data.reasoning_content };
                  if (data.thoughtSignature && config.passSignatureToClient) {
                    delta.thoughtSignature = data.thoughtSignature;
                  }
                  writeStreamData(res, createStreamChunk(id, created, model, delta));
                } else if (data.type === 'tool_calls') {
                  hasToolCall = true;
                  // Determine whether to pass through tool call signatures based on config
                  const toolCallsWithIndex = data.tool_calls.map((toolCall, index) => {
                    if (config.passSignatureToClient) {
                      return { index, ...toolCall };
                    } else {
                      const { thoughtSignature, ...rest } = toolCall;
                      return { index, ...rest };
                    }
                  });
                  const delta = { tool_calls: toolCallsWithIndex };
                  writeStreamData(res, createStreamChunk(id, created, model, delta));
                } else {
                  if (data.content && data.content.length > 0) {
                    hasEmittedTextContent = true;
                    const delta = { content: data.content };
                    writeStreamData(res, createStreamChunk(id, created, model, delta));
                  }
                }
              });
            },
            safeRetries,
            createRetryOptions('chat.stream ')
          );

          // Fallback: if the model only emitted thought/reasoning tokens and zero visible content tokens,
          // emit the accumulated reasoning as content so clients never display an empty reply.
          if (!hasEmittedTextContent && !hasToolCall && accumulatedReasoning.trim().length > 0) {
            writeStreamData(res, createStreamChunk(id, created, model, { content: accumulatedReasoning }));
          }

          writeStreamData(res, { ...createStreamChunk(id, created, model, {}, hasToolCall ? 'tool_calls' : 'stop'), usage: usageData });
        }

        clearInterval(heartbeatTimer);
        endStream(res);
      } catch (error) {
        clearInterval(heartbeatTimer);
        if (!res.writableEnded) {
          const statusCode = error.statusCode || error.status || 500;
          writeStreamData(res, buildOpenAIErrorPayload(error, statusCode));
          endStream(res);
        }
        logger.error('Failed to generate response:', error.message);
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
          createRetryOptions('chat.fake_no_stream ')
        );

        const finalContent = (!content && toolCalls.length === 0 && reasoningContent)
          ? reasoningContent
          : content;

        res.json(createOpenAIChatCompletionResponse({
          id,
          created,
          model,
          content: finalContent,
          reasoningContent,
          reasoningSignature,
          toolCalls,
          usage: usageData,
          passSignatureToClient: config.passSignatureToClient,
          stripToolCallSignature: !config.passSignatureToClient
        }));
      } catch (error) {
        logger.error('Fake non-stream response failed:', error.message);
        if (res.headersSent) return;
        const statusCode = error.statusCode || error.status || 500;
        return res.status(statusCode).json(buildOpenAIErrorPayload(error, statusCode));
      }
    } else {
      // Non-streaming request: disable timeouts to accommodate long LLM responses
      req.setTimeout(0); // Disable request timeout
      res.setTimeout(0); // Disable response timeout

      const { content, reasoningContent, reasoningSignature, toolCalls, usage } = await with429Retry(
        (attempt, shouldUseCredits) => {
          const actualRequestBody = shouldUseCredits 
            ? { ...requestBody, enabledCreditTypes: ["GOOGLE_ONE_AI"] }
            : requestBody;
          return generateAssistantResponseNoStream(actualRequestBody, token);
        },
        safeRetries,
        createRetryOptions('chat.no_stream ')
      );

      const finalContent = (!content && toolCalls.length === 0 && reasoningContent)
        ? reasoningContent
        : content;

      // Use pre-built response helper to reduce memory allocations
      res.json(createOpenAIChatCompletionResponse({
        id,
        created,
        model,
        content: finalContent,
        reasoningContent,
        reasoningSignature,
        toolCalls,
        usage,
        passSignatureToClient: config.passSignatureToClient,
        stripToolCallSignature: !config.passSignatureToClient
      }));
    }
  } catch (error) {
    logger.error('Failed to generate response:', error.message);
    if (res.headersSent) return;
    const statusCode = error.statusCode || error.status || 500;
    return res.status(statusCode).json(buildOpenAIErrorPayload(error, statusCode));
  }
};
