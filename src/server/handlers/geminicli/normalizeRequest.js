import { detectRequestFormat } from '../../../utils/converters/geminicli.js';
import { validateIncomingChatRequest } from '../../validators/chat.js';

/**
 * Normalize an incoming GeminiCLI request:
 * - Detect format (OpenAI/Gemini/Claude)
 * - Determine stream flag (for Gemini, set by the route's _isStream flag)
 * - Validate required fields
 * - Strip internal flags
 *
 * @param {any} requestBody
 * @param {('openai'|'gemini'|'claude'|null)} forceFormat
 * @returns {{ok: true, format: 'openai'|'gemini'|'claude', stream: boolean, cleanedBody: any} | {ok:false, status:number, message:string}}
 */
export function normalizeGeminiCliRequest(requestBody, forceFormat = null) {
  const format = forceFormat || detectRequestFormat(requestBody);

  let stream = false;
  if (format === 'openai' || format === 'claude') {
    stream = requestBody?.stream || false;
  } else if (format === 'gemini') {
    stream = requestBody?._isStream || false;
  }

  const validation = validateIncomingChatRequest(format, requestBody);
  if (!validation.ok) {
    return { ok: false, status: validation.status, message: validation.message };
  }

  const cleanedBody = { ...requestBody };
  delete cleanedBody._isStream;

  return { ok: true, format, stream, cleanedBody };
}
