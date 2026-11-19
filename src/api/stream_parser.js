import memoryManager, { registerMemoryPoolCleanup } from '../utils/memoryManager.js';
import { generateToolCallId } from '../utils/idGenerator.js';
import { setSignature, shouldCacheSignature, isImageModel } from '../utils/thoughtSignatureCache.js';
import { getOriginalToolName } from '../utils/toolNameCache.js';
import config from '../config/config.js';

// Precompiled constants (avoid repeated string creation)
const DATA_PREFIX = 'data: ';
const DATA_PREFIX_LEN = DATA_PREFIX.length;

// Efficient line splitter (zero-copy, avoids creating new arrays via split)
// Uses an object pool to reuse LineBuffer instances
class LineBuffer {
  constructor() {
    this.buffer = '';
    this.lines = [];
  }
  
  // Append data and return complete lines
  append(chunk) {
    this.buffer += chunk;
    this.lines.length = 0; // Reuse array
    
    let start = 0;
    let end;
    while ((end = this.buffer.indexOf('\n', start)) !== -1) {
      this.lines.push(this.buffer.slice(start, end));
      start = end + 1;
    }
    
    // Retain incomplete trailing portion
    this.buffer = start < this.buffer.length ? this.buffer.slice(start) : '';
    return this.lines;
  }
  
  clear() {
    this.buffer = '';
    this.lines.length = 0;
  }
}

// LineBuffer object pool
const lineBufferPool = [];
const getLineBuffer = () => {
  const buffer = lineBufferPool.pop();
  if (buffer) {
    buffer.clear();
    return buffer;
  }
  return new LineBuffer();
};
const releaseLineBuffer = (buffer) => {
  const maxSize = memoryManager.getPoolSizes().lineBuffer;
  if (lineBufferPool.length < maxSize) {
    buffer.clear();
    lineBufferPool.push(buffer);
  }
};

// toolCall object pool
const toolCallPool = [];
const getToolCallObject = () => toolCallPool.pop() || { id: '', type: 'function', function: { name: '', arguments: '' } };
const releaseToolCallObject = (obj) => {
  const maxSize = memoryManager.getPoolSizes().toolCall;
  if (toolCallPool.length < maxSize) toolCallPool.push(obj);
};

// Register memory cleanup callbacks (invoked centrally by external caller)
function registerStreamMemoryCleanup() {
  registerMemoryPoolCleanup(toolCallPool, () => memoryManager.getPoolSizes().toolCall);
  registerMemoryPoolCleanup(lineBufferPool, () => memoryManager.getPoolSizes().lineBuffer);
}

// Convert functionCall to OpenAI format (using object pool)
// Attempts to restore sanitized tool names back to original tool names
function convertToToolCall(functionCall, sessionId, model) {
  const toolCall = getToolCallObject();
  toolCall.id = functionCall.id || generateToolCallId();
  let name = functionCall.name;
  if (model) {
    const original = getOriginalToolName(model, functionCall.name);
    if (original) name = original;
  }
  toolCall.function.name = name;
  toolCall.function.arguments = JSON.stringify(functionCall.args);
  return toolCall;
}

// Parse and emit streaming response chunk (mutates state and triggers callback)
// Supports DeepSeek format: chain-of-thought content is emitted via the reasoning_content field
// Also passes through thoughtSignature for downstream client reuse
// Signature and thought content are stored together: cached once complete thought content is collected
function parseAndEmitStreamChunk(line, state, callback) {
  if (!line.startsWith(DATA_PREFIX)) return;
  
  try {
    const data = JSON.parse(line.slice(DATA_PREFIX_LEN));
    const parts = data.response?.candidates?.[0]?.content?.parts;
    
    if (parts) {
      for (const part of parts) {
        if (part.thoughtSignature) {
          // Models like Gemini may only provide thoughtSignature on the functionCall part;
          // treat it as the "latest signature" for this turn as a fallback for subsequent functionCalls and caching for the next request.
          if (part.thoughtSignature !== state.reasoningSignature) {
            state.reasoningSignature = part.thoughtSignature;
            // Defer caching until thought content collection is complete
          }
        }

        if (part.thought === true) {
          // Accumulate thought content
          if (part.text) {
            state.reasoningContent = (state.reasoningContent || '') + part.text;
          }
          
          if (part.thoughtSignature) {
            state.reasoningSignature = part.thoughtSignature;
            // Defer caching until stream ends to ensure complete thought content is collected
          }
          callback({
            type: 'reasoning',
            reasoning_content: part.text || '',
            thoughtSignature: part.thoughtSignature || state.reasoningSignature || null
          });
        } else if (part.text !== undefined) {
          callback({ type: 'text', content: part.text });
        } else if (part.functionCall) {
          const toolCall = convertToToolCall(part.functionCall, state.sessionId, state.model);
          const sig = part.thoughtSignature || state.reasoningSignature || null;
          if (sig) {
            toolCall.thoughtSignature = sig;
            // Mark that tool calls are present
            state.hasToolCalls = true;
          }
          state.toolCalls.push(toolCall);
        }
      }
    }
    
    if (data.response?.candidates?.[0]?.finishReason) {
      // At stream end, determine whether the signature should be cached
      const hasTools = state.hasToolCalls || state.toolCalls.length > 0;
      const isImage = isImageModel(state.model);
      
      // Note: GeminiCLI does not use sessionId, but signature caching should still work
      // The sessionId parameter is no longer used as a cache key in thoughtSignatureCache.js
      if (state.model && state.reasoningSignature) {
        if (shouldCacheSignature({ hasTools, isImageModel: isImage })) {
          const content = state.reasoningContent || ' ';
          setSignature(state.sessionId, state.model, state.reasoningSignature, content, { hasTools, isImageModel: isImage });
        }
      }
      
      if (state.toolCalls.length > 0) {
        callback({ type: 'tool_calls', tool_calls: state.toolCalls });
        state.toolCalls = [];
      }
      const usage = data.response?.usageMetadata;
      if (usage) {
        callback({
          type: 'usage',
          usage: {
            prompt_tokens: usage.promptTokenCount || 0,
            completion_tokens: usage.candidatesTokenCount || 0,
            total_tokens: usage.totalTokenCount || 0
          }
        });
      }
      // Clear accumulated thought content and state
      state.reasoningContent = '';
      state.hasToolCalls = false;
    }
  } catch {
    // Ignore JSON parse errors
  }
}

export {
  getLineBuffer,
  releaseLineBuffer,
  parseAndEmitStreamChunk,
  convertToToolCall,
  registerStreamMemoryCleanup,
  releaseToolCallObject
};
