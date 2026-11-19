// Test thought signature logic: should not create a thought part when no signature is available
import { generateRequestBody } from '../src/utils/converters/openai.js';
import { generateClaudeRequestBody } from '../src/utils/converters/claude.js';
import { generateGeminiRequestBody } from '../src/utils/converters/gemini.js';
import config from '../src/config/config.js';

// Save original configuration
const originalUseCachedSignature = config.useCachedSignature;
const originalUseFallbackSignature = config.useFallbackSignature;

// Mock token object
const mockToken = {
  sessionId: 'test-session-no-signature',
  projectId: 'test-project',
};

console.log('\n=== Test Scenario: Should not create thought part without signature ===\n');

// Test 1: OpenAI format conversion (without signature)
console.log('Test 1: OpenAI format conversion (without signature)');
config.useCachedSignature = false;
config.useFallbackSignature = false;

const openaiMessages = [
  {
    role: 'user',
    content: 'Hello'
  },
  {
    role: 'assistant',
    content: 'Hi there!',
    reasoning_content: 'This is some reasoning'
  }
];

const openaiResult = generateRequestBody(openaiMessages, 'claude-sonnet-4-5', {}, [], mockToken);
const openaiContents = openaiResult.request.contents;

console.log('OpenAI conversion result:');
console.log(JSON.stringify(openaiContents, null, 2));

// Verify: the second message (model role) should not contain a thought part
const modelMessage = openaiContents.find(m => m.role === 'model');
const hasThoughtPart = modelMessage?.parts?.some(p => p.thought === true);
console.log(`✓ Model message should not contain thought part: ${!hasThoughtPart ? '✓ PASS' : '✗ FAIL'}`);

// Test 2: Claude format conversion (without signature)
console.log('\nTest 2: Claude format conversion (without signature)');

const claudeMessages = [
  {
    role: 'user',
    content: 'Hello'
  },
  {
    role: 'assistant',
    content: [
      {
        type: 'thinking',
        text: 'Some thinking'
      },
      {
        type: 'text',
        text: 'Response text'
      }
    ]
  }
];

const claudeResult = generateClaudeRequestBody(claudeMessages, 'claude-sonnet-4-5', {}, [], '', mockToken);
const claudeContents = claudeResult.request.contents;

console.log('Claude conversion result:');
console.log(JSON.stringify(claudeContents, null, 2));

const claudeModelMessage = claudeContents.find(m => m.role === 'model');
const claudeHasThoughtPart = claudeModelMessage?.parts?.some(p => p.thought === true);
console.log(`✓ Model message should not contain thought part: ${!claudeHasThoughtPart ? '✓ PASS' : '✗ FAIL'}`);

// Test 3: Gemini format conversion (without signature)
console.log('\nTest 3: Gemini format conversion (without signature)');

const geminiBody = {
  contents: [
    {
      role: 'user',
      parts: [{ text: 'Hello' }]
    },
    {
      role: 'model',
      parts: [{ text: 'Response' }]
    }
  ]
};

const geminiResult = generateGeminiRequestBody(geminiBody, 'claude-sonnet-4-5', mockToken);
const geminiContents = geminiResult.request.contents;

console.log('Gemini conversion result:');
console.log(JSON.stringify(geminiContents, null, 2));

const geminiModelMessage = geminiContents.find(m => m.role === 'model');
const geminiHasThoughtPart = geminiModelMessage?.parts?.some(p => p.thought === true);
console.log(`✓ Model message should not contain thought part: ${!geminiHasThoughtPart ? '✓ PASS' : '✗ FAIL'}`);

// Test 4: Verify it still works normally with signature (using a thinking model)
console.log('\nTest 4: Verify normal behavior with signature (fallback signature enabled + thinking model)');
config.useFallbackSignature = true;

// Use an explicit thinking model
const thinkingModelName = 'claude-opus-4-5-thinking';
const openaiResultWithSig = generateRequestBody(openaiMessages, thinkingModelName, {}, [], mockToken);
const openaiContentsWithSig = openaiResultWithSig.request.contents;

console.log('OpenAI conversion result (with signature):');
console.log(JSON.stringify(openaiContentsWithSig, null, 2));

const modelMessageWithSig = openaiContentsWithSig.find(m => m.role === 'model');
const hasThoughtPartWithSig = modelMessageWithSig?.parts?.some(p => p.thought === true && p.thoughtSignature);
console.log(`✓ Model message should contain signed thought part: ${hasThoughtPartWithSig ? '✓ PASS' : '✗ FAIL (expected behavior for non-thinking models)'}`);

// Test 5: Directly verify Gemini format with signature
console.log('\nTest 5: Gemini format test with signature (fallback signature enabled)');
const geminiBodyWithThinking = {
  contents: [
    {
      role: 'user',
      parts: [{ text: 'Hello' }]
    },
    {
      role: 'model',
      parts: [{ text: 'Response' }]
    }
  ]
};

const geminiResultWithSig = generateGeminiRequestBody(geminiBodyWithThinking, thinkingModelName, mockToken);
const geminiContentsWithSig = geminiResultWithSig.request.contents;

console.log('Gemini conversion result (with signature):');
console.log(JSON.stringify(geminiContentsWithSig, null, 2));

const geminiModelMessageWithSig = geminiContentsWithSig.find(m => m.role === 'model');
const geminiHasThoughtPartWithSig = geminiModelMessageWithSig?.parts?.some(p => p.thought === true && p.thoughtSignature);
console.log(`✓ Model message should contain signed thought part: ${geminiHasThoughtPartWithSig ? '✓ PASS' : '✗ FAIL'}`);

// Restore original configuration
config.useCachedSignature = originalUseCachedSignature;
config.useFallbackSignature = originalUseFallbackSignature;

console.log('\n=== Tests Completed ===\n');
