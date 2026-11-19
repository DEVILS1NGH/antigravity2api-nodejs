/**
 * Gemini CLI API routes
 * Handles multiple API format endpoints:
 * - /cli/v1/chat/completions (OpenAI format)
 * - /cli/v1beta/models/:model:generateContent (Gemini format)
 * - /cli/v1beta/models/:model:streamGenerateContent (Gemini streaming format)
 * - /cli/v1/messages (Claude format)
 *
 * Entry point for the Gemini CLI proxy supporting OpenAI, Gemini, and Claude compatible APIs
 */

import { Router } from 'express';
import { handleGeminiCliRequest } from '../server/handlers/geminicli.js';
import logger from '../utils/logger.js';
import config from '../config/config.js';

const router = Router();

/**
 * Middleware: check whether Gemini CLI is enabled
 */
const checkGeminiCliEnabled = (req, res, next) => {
  if (config.geminicli?.enabled === false) {
    return res.status(503).json({
      error: {
        message: 'Gemini CLI feature is not enabled',
        type: 'service_unavailable',
        code: 'geminicli_disabled'
      }
    });
  }
  next();
};

// Apply middleware to all routes
router.use(checkGeminiCliEnabled);

/**
 * Generate the list of available Gemini CLI models
 */
function getGeminiCliModels() {
  const baseModels = [
    // Gemini 4
    'gemini-4-carbon',
    'gemini-4-argon',
    'gemini-4-neon',
    'gemini-4-hydrogen',
    // Gemini 3.8 / 3.6 / 3.5
    'gemini-3.8-flash',
    'gemini-3.6-flash',
    'gemini-3.5-flash',
    'gemini-3.5-flash-lite',
    // Gemini 3.1 / 3.0
    'gemini-3.1-pro-preview',
    'gemini-3.1-flash-lite',
    'gemini-3-pro-preview',
    'gemini-3-flash-preview',
    // Gemini 2.5
    'gemini-2.5-pro',
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite'
  ];

  const models = [];
  const featurePrefixes = ['', 'fake-stream/', 'anti-truncation/'];
  const thinkingSuffixes = ['', '-maxthinking', '-nothinking'];
  const searchSuffix = '-search';

  for (const baseModel of baseModels) {
    for (const prefix of featurePrefixes) {
      // Base model
      models.push(`${prefix}${baseModel}`);

      // With thinking suffix
      for (const thinkingSuffix of thinkingSuffixes) {
        if (thinkingSuffix) {
          models.push(`${prefix}${baseModel}${thinkingSuffix}`);
        }
      }

      // With search suffix
      models.push(`${prefix}${baseModel}${searchSuffix}`);

      // With thinking + search combined suffix
      for (const thinkingSuffix of thinkingSuffixes) {
        if (thinkingSuffix) {
          models.push(`${prefix}${baseModel}${thinkingSuffix}${searchSuffix}`);
        }
      }
    }
  }

  return models;
}

/**
 * Return model list (OpenAI format)
 */
function handleModelsRequestOpenAI(req, res) {
  try {
    const created = Math.floor(Date.now() / 1000);
    const models = getGeminiCliModels();

    const modelList = {
      object: 'list',
      data: models.map(id => ({
        id,
        object: 'model',
        created,
        owned_by: 'google'
      }))
    };

    res.json(modelList);
  } catch (error) {
    logger.error('[GeminiCLI] Failed to get model list:', error.message);
    res.status(500).json({ error: error.message });
  }
}

/**
 * Return model list (Gemini format)
 */
function handleModelsRequestGemini(req, res) {
  try {
    const models = getGeminiCliModels();

    const modelList = {
      models: models.map(id => ({
        name: `models/${id}`,
        version: '001',
        displayName: id,
        description: 'GeminiCLI model',
        inputTokenLimit: 1048576,
        outputTokenLimit: 65536,
        supportedGenerationMethods: ['generateContent', 'countTokens'],
        temperature: 1.0,
        topP: 0.95,
        topK: 40
      }))
    };

    res.json(modelList);
  } catch (error) {
    logger.error('[GeminiCLI] Failed to get model list:', error.message);
    res.status(500).json({ error: error.message });
  }
}

/**
 * GET /cli/v1/models
 * Get available model list (OpenAI format)
 */
router.get('/v1/models', handleModelsRequestOpenAI);

/**
 * GET /cli/v1beta/models
 * Get available model list (Gemini format)
 */
router.get('/v1beta/models', handleModelsRequestGemini);

/**
 * POST /cli/v1/chat/completions
 * Handle OpenAI-format chat completion requests
 */
router.post('/v1/chat/completions', (req, res) => handleGeminiCliRequest(req, res, 'openai'));

// ==================== Gemini Format Endpoints ====================

/**
 * POST /cli/v1beta/models/:model:generateContent
 * Handle Gemini-format non-streaming requests
 * Uses regex to support model names containing '/' (e.g. "fake-stream/gemini-2.5-pro")
 */
router.post(/^\/v1beta\/models\/(.+):generateContent$/, (req, res) => {
  // Attach decoded model name to request body
  req.body.model = decodeURIComponent(req.params[0]);
  handleGeminiCliRequest(req, res, 'gemini');
});

/**
 * POST /cli/v1beta/models/:model:streamGenerateContent
 * Handle Gemini-format streaming requests
 * Uses regex to support model names containing '/' (e.g. "fake-stream/gemini-2.5-pro")
 */
router.post(/^\/v1beta\/models\/(.+):streamGenerateContent$/, (req, res) => {
  // Attach decoded model name to request body and mark as streaming
  req.body.model = decodeURIComponent(req.params[0]);
  req.body._isStream = true; // Internal flag
  handleGeminiCliRequest(req, res, 'gemini');
});

// ==================== Claude Format Endpoints ====================

/**
 * POST /cli/v1/messages
 * Handle Claude-format message requests
 */
router.post('/v1/messages', (req, res) => handleGeminiCliRequest(req, res, 'claude'));

// ==================== Health Check ====================

/**
 * GET /cli/health
 * Health check endpoint
 */
router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'geminicli',
    enabled: config.geminicli?.enabled !== false,
    supportedFormats: ['openai', 'gemini', 'claude']
  });
});

export default router;