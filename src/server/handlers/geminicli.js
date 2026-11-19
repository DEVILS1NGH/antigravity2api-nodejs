/**
 * Gemini CLI format handler
 * Handles /cli/v1/chat/completions requests with streaming and non-streaming responses
 */

import {
  generateStreamResponse,
  generateNoStreamResponse,
  getToken,
  recordRequest
} from '../../api/geminicli_client.js';
import {
  convertToGeminiCli,
  isFakeStreamingModel
} from '../../utils/converters/geminicli.js';
import { buildOpenAIErrorPayload } from '../../utils/errors.js';
import logger from '../../utils/logger.js';
import config from '../../config/config.js';
import geminicliTokenManager from '../../auth/geminicli_token_manager.js';
import { createGeminiCliStreamWriter, writeGeminiCliFakeStreamResponse } from './geminicli/writers.js';
import { normalizeGeminiCliRequest } from './geminicli/normalizeRequest.js';
import { createGeminiResponse } from '../formatters/gemini.js';
import { createClaudeResponse } from '../formatters/claude.js';
import { createOpenAIChatCompletionResponse } from '../formatters/openai.js';
import {
  createResponseMeta,
  setStreamHeaders,
  createHeartbeat,
  writeStreamData,
  endStream,
  with429Retry
} from '../stream.js';
import { setSignature, getSignature, shouldCacheSignature, isImageModel } from '../../utils/thoughtSignatureCache.js';
import { getSafeRetries } from './common/retry.js';
import { disableTimeouts } from './common/timeouts.js';

/**
 * Handle Gemini CLI chat requests (supports OpenAI, Gemini, and Claude formats)
 * @param {Request} req - Express request object
 * @param {Response} res - Express response object
 * @param {string} forceFormat - Optional forced format: 'openai' | 'gemini' | 'claude'
 */
export const handleGeminiCliRequest = async (req, res, forceFormat = null) => {
  const requestBody = req.body;

  const normalized = normalizeGeminiCliRequest(requestBody, forceFormat);
  if (!normalized.ok) {
    return res.status(normalized.status).json({ error: normalized.message });
  }

  const { format, stream, cleanedBody } = normalized;

  try {
    const token = await getToken();
    if (!token) {
      throw new Error('No available Gemini CLI token; please add an account in the admin dashboard');
    }
    const { geminiRequest, model: actualModel, features, sourceFormat } = convertToGeminiCli(cleanedBody);


    // Preserve the originally requested model name for the response
    const responseModel = requestBody.model || actualModel;

    const { id, created } = createResponseMeta();
    const safeRetries = getSafeRetries(config.retryTimes);

    // Fake streaming mode: fetch via non-streaming API, then emit as SSE stream
    const useFakeStreaming = features.fakeStreaming && stream;

    if (stream && !useFakeStreaming) {
      setStreamHeaders(res);

      // Start heartbeat to prevent idle timeout disconnects
      const heartbeatTimer = createHeartbeat(res);

      try {
        const writer = createGeminiCliStreamWriter({
          format,
          res,
          id,
          created,
          responseModel
        });

        await with429Retry(
          () => generateStreamResponse(geminiRequest, token, actualModel, (data) => writer.onEvent(data)),
          safeRetries,
          '[GeminiCLI] chat.stream ',
          () => recordRequest(token)
        );

        writer.finalize();

        clearInterval(heartbeatTimer);
        endStream(res, false);
      } catch (error) {
        clearInterval(heartbeatTimer);
        if (!res.writableEnded) {
          const statusCode = error.statusCode || error.status || 500;
          writeStreamData(res, buildOpenAIErrorPayload(error, statusCode));
          endStream(res, false);
        }
        logger.error('[GeminiCLI] Failed to generate response:', error.message);
        return;
      }
    } else if (useFakeStreaming) {
      // Fake streaming mode: fetch via non-streaming API, then emit as SSE stream
      setStreamHeaders(res);
      const heartbeatTimer = createHeartbeat(res);

      try {
        const { content, reasoningContent, reasoningSignature, toolCalls, usage } = await with429Retry(
          () => generateNoStreamResponse(geminiRequest, token, actualModel),
          safeRetries,
          '[GeminiCLI] chat.fake_stream ',
          () => recordRequest(token)
        );

        // Cache signature (fake streaming response)
        if (reasoningSignature && actualModel) {
          const hasTools = toolCalls && toolCalls.length > 0;
          const isImage = isImageModel(actualModel);
          if (shouldCacheSignature({ hasTools, isImageModel: isImage })) {
            setSignature(null, actualModel, reasoningSignature, reasoningContent || ' ', { hasTools, isImageModel: isImage });
          }
        }

        writeGeminiCliFakeStreamResponse({
          format,
          res,
          id,
          created,
          responseModel,
          content,
          reasoningContent,
          reasoningSignature,
          toolCalls,
          usage
        });

        clearInterval(heartbeatTimer);
        endStream(res, false);
      } catch (error) {
        clearInterval(heartbeatTimer);
        if (!res.writableEnded) {
          const statusCode = error.statusCode || error.status || 500;
          writeStreamData(res, buildOpenAIErrorPayload(error, statusCode));
          endStream(res, false);
        }
        logger.error('[GeminiCLI] Fake-streaming response failed:', error.message);
        return;
      }
    } else {
      // Non-streaming request
      disableTimeouts(req, res);

      const { content, reasoningContent, reasoningSignature, toolCalls, usage } = await with429Retry(
        () => generateNoStreamResponse(geminiRequest, token, actualModel),
        safeRetries,
        '[GeminiCLI] chat.no_stream ',
        () => recordRequest(token)
      );

      // Handle signature: prefer the API-returned signature, otherwise fall back to cached signature
      const hasTools = toolCalls && toolCalls.length > 0;
      const isImage = isImageModel(actualModel);
      let finalReasoningSignature = reasoningSignature;
      let finalReasoningContent = reasoningContent;

      if (!finalReasoningSignature && actualModel) {
        // Attempt to retrieve signature from cache
        const cached = getSignature(null, actualModel, { hasTools });
        if (cached) {
          finalReasoningSignature = cached.signature;
          // Use cached thinking content if API did not return any
          if (!finalReasoningContent && cached.content && cached.content !== ' ') {
            finalReasoningContent = cached.content;
          }
        }
      }

      // Cache signature (non-streaming response)
      if (finalReasoningSignature && actualModel) {
        if (shouldCacheSignature({ hasTools, isImageModel: isImage })) {
          setSignature(null, actualModel, finalReasoningSignature, finalReasoningContent || ' ', { hasTools, isImageModel: isImage });
        }
      }

      // Return response in the requested format
      if (format === 'gemini') {
        res.json(createGeminiResponse(
          content,
          finalReasoningContent || null,
          finalReasoningSignature || null,
          toolCalls,
          'STOP',
          usage,
          {
            passSignatureToClient: true,
            fallbackThoughtSignature: finalReasoningSignature || null
          }
        ));
      } else if (format === 'claude') {
        const claudeId = `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 9)}`;
        res.json(createClaudeResponse(
          claudeId,
          responseModel,
          content,
          finalReasoningContent || null,
          finalReasoningSignature || null,
          toolCalls,
          (toolCalls && toolCalls.length > 0) ? 'tool_use' : 'end_turn',
          usage,
          { passSignatureToClient: true }
        ));
      } else {
        res.json(createOpenAIChatCompletionResponse({
          id,
          created,
          model: responseModel,
          content,
          reasoningContent: finalReasoningContent || null,
          reasoningSignature: null,
          toolCalls,
          usage,
          passSignatureToClient: false,
          stripToolCallSignature: true
        }));
      }
    }
  } catch (error) {
    logger.error('[GeminiCLI] Failed to generate response:', error.message);
    if (res.headersSent) return;
    const statusCode = error.statusCode || error.status || 500;
    return res.status(statusCode).json(buildOpenAIErrorPayload(error, statusCode));
  }
};
