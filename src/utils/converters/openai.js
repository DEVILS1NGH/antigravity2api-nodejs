// OpenAI format converter utilities
import config from '../../config/config.js';
import { extractSystemInstruction } from '../utils.js';
import { convertOpenAIToolsToAntigravity } from '../toolConverter.js';
import {
  getSignatureContext,
  pushUserMessage,
  findFunctionNameById,
  pushFunctionResponse,
  createThoughtPart,
  createFunctionCallPart,
  processToolName,
  pushModelMessage,
  buildRequestBody,
  modelMapping,
  isEnableThinking,
  generateGenerationConfig
} from './common.js';

function extractImagesFromContent(content) {
  const result = { text: '', images: [] };
  if (typeof content === 'string') {
    result.text = content;
    return result;
  }
  if (Array.isArray(content)) {
    for (const item of content) {
      if (item.type === 'text') {
        result.text += item.text;
      } else if (item.type === 'image_url') {
        const imageUrl = item.image_url?.url || '';
        const match = imageUrl.match(/^data:image\/(\w+);base64,(.+)$/);
        if (match) {
          result.images.push({
            inlineData: {
              mimeType: `image/${match[1]}`,
              data: match[2]
            }
          });
        }
      }
    }
  }
  return result;
}

function handleAssistantMessage(message, antigravityMessages, enableThinking, actualModelName, sessionId, hasTools) {
  const hasToolCalls = message.tool_calls && message.tool_calls.length > 0;
  const textContent = typeof message.content === 'string'
    ? message.content
    : (Array.isArray(message.content)
      ? message.content.filter(item => item.type === 'text').map(item => item.text || '').join('')
      : '');
  const hasContent = textContent.trim() !== '';

  // Skip completely empty assistant messages so we don't send empty model parts
  if (!hasContent && !hasToolCalls) {
    return;
  }

  const { reasoningSignature, reasoningContent, toolSignature, toolContent } = getSignatureContext(sessionId, actualModelName, hasTools);
  
  const toolCalls = hasToolCalls
    ? message.tool_calls.map(toolCall => {
      const safeName = processToolName(toolCall.function.name, sessionId, actualModelName);
      const signature = enableThinking
        ? (toolCall.thoughtSignature || toolSignature || message.thoughtSignature || reasoningSignature)
        : null;
      return createFunctionCallPart(toolCall.id, safeName, toolCall.function.arguments, signature);
    })
    : [];

  const parts = [];
  if (enableThinking) {
    // Prefer thinking content from the message itself; otherwise use cached content (bound to signature)
    let reasoningText = ' ';
    let signature = null;
    
    if (typeof message.reasoning_content === 'string' && message.reasoning_content.length > 0) {
      // Message has its own thinking content; use its signature or cached signature
      reasoningText = message.reasoning_content;
      signature = message.thoughtSignature || reasoningSignature || toolSignature;
    } else {
      // No thinking content; use cached signature + content (bound pair)
      signature = message.thoughtSignature || reasoningSignature || toolSignature;
      if (signature === reasoningSignature) {
        reasoningText = reasoningContent || ' ';
      } else if (signature === toolSignature) {
        reasoningText = toolContent || ' ';
      }
    }
    
    // Only add thought part when a signature is available to avoid API errors
    if (signature) {
      parts.push(createThoughtPart(reasoningText, signature));
    }
  }
  if (hasContent) {
    const part = { text: textContent.trimEnd() };
    parts.push(part);
  }
  if (!enableThinking && parts[0]) delete parts[0].thoughtSignature;

  pushModelMessage({ parts, toolCalls, hasContent }, antigravityMessages);
}

function handleToolCall(message, antigravityMessages) {
  const functionName = findFunctionNameById(message.tool_call_id, antigravityMessages);
  pushFunctionResponse(message.tool_call_id, functionName, message.content, antigravityMessages);
}

function openaiMessageToAntigravity(openaiMessages, enableThinking, actualModelName, sessionId, hasTools) {
  const antigravityMessages = [];
  for (const message of openaiMessages) {
    if (message.role === 'user' || message.role === 'system') {
      const extracted = extractImagesFromContent(message.content);
      if (message.role === 'system' && !extracted.text.trim() && extracted.images.length === 0) {
        continue;
      }
      pushUserMessage(extracted, antigravityMessages);
    } else if (message.role === 'assistant') {
      handleAssistantMessage(message, antigravityMessages, enableThinking, actualModelName, sessionId, hasTools);
    } else if (message.role === 'tool') {
      handleToolCall(message, antigravityMessages);
    }
  }

  // Claude 5.5 does not support assistant message prefill ("The conversation must end with a user message.")
  const isClaude = actualModelName && actualModelName.toLowerCase().includes('claude');
  if (isClaude && antigravityMessages.length > 0 && antigravityMessages[antigravityMessages.length - 1].role === 'model') {
    const lastModelMsg = antigravityMessages.pop();
    const prefillText = (lastModelMsg.parts || [])
      .filter(p => !p.thought && typeof p.text === 'string' && p.text.trim())
      .map(p => p.text.trim())
      .join('\n');
    if (prefillText) {
      pushUserMessage({ text: `[Begin your response with: ${prefillText}]`, images: [] }, antigravityMessages);
    }
  }
  if (antigravityMessages.length === 0) {
    pushUserMessage({ text: ' ', images: [] }, antigravityMessages);
  }

  return antigravityMessages;
}

export function generateRequestBody(openaiMessages, modelName, parameters, openaiTools, token) {
  const enableThinking = isEnableThinking(modelName);
  const requestedLevel = parameters?.thinking_level ?? parameters?.thinkingLevel ?? parameters?.reasoning_effort;
  const actualModelName = modelMapping(modelName, requestedLevel);
  const mergedSystemInstruction = extractSystemInstruction(openaiMessages);

  let filteredMessages = openaiMessages;
  let startIndex = 0;
  if (config.useContextSystemPrompt) {
    for (let i = 0; i < openaiMessages.length; i++) {
      if (openaiMessages[i].role === 'system') {
        startIndex = i + 1;
      } else {
        filteredMessages = openaiMessages.slice(startIndex);
        break;
      }
    }
  }

  const tools = convertOpenAIToolsToAntigravity(openaiTools, token.sessionId, actualModelName);
  const hasTools = tools && tools.length > 0;
  //console.log(JSON.stringify(tools, null, 2))
  return buildRequestBody({
    contents: openaiMessageToAntigravity(filteredMessages, enableThinking, actualModelName, token.sessionId, hasTools),
    tools: tools,
    generationConfig: generateGenerationConfig(parameters, enableThinking, actualModelName),
    sessionId: token.sessionId,
    systemInstruction: mergedSystemInstruction
  }, token, actualModelName);
}
