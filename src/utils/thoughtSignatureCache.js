// Signature cache (file-backed version):
// - Caches the "latest N" signatures per model (ring buffer)
// - Stores signature paired with thinking content: { signature, content }
// - Automatic FIFO: evicts the oldest entry when capacity is exceeded
// - Stored under data/signature-cache/

import fs from 'fs';
import path from 'path';
import config from '../config/config.js';
import log from './logger.js';

// Cache directory path
const CACHE_DIR = path.join(process.cwd(), 'data', 'signature-cache');

// Limit: number of signatures retained per model
const MAX_SIGNATURES_PER_MODEL = 3;

/**
 * Ensure the cache directory exists
 */
function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

/**
 * Generate a cache file name for a model (sanitizing special characters)
 * @param {string} model - Model name
 * @returns {string} Safe file name
 */
function makeModelKey(model) {
  if (!model) return null;
  const raw = String(model);
  // Image generation models carry resolution suffixes (e.g. `-4K` / `-2K`), which are stripped to the base model name on actual requests.
  // Cache uniformly by "base model name" to avoid cache misses.
  const baseModel = raw.replace(/-(?:1k|2k|4k|8k)$/i, '');
  // Replace unsafe filename characters with underscores
  return baseModel.replace(/[<>:"/\\|?*]/g, '_');
}

/**
 * Get the cache file path for a model
 * @param {string} modelKey - Model key
 * @returns {string} File path
 */
function getCacheFilePath(modelKey) {
  return path.join(CACHE_DIR, `${modelKey}.json`);
}

/**
 * Read a model's signature cache from file
 * @param {string} modelKey - Model key
 * @returns {Array} Signature array [{ signature, content }, ...]
 */
function readModelCache(modelKey) {
  if (!modelKey) return [];
  
  try {
    const filePath = getCacheFilePath(modelKey);
    if (!fs.existsSync(filePath)) return [];
    
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Array.isArray(data.signatures) ? data.signatures : [];
  } catch (e) {
    log.warn(`Failed to read signature cache (${modelKey}):`, e?.message || e);
    return [];
  }
}

/**
 * Write a model's signature cache to file
 * @param {string} modelKey - Model key
 * @param {Array} signatures - Signature array
 */
function writeModelCache(modelKey, signatures) {
  if (!modelKey) return;
  
  try {
    ensureCacheDir();
    const filePath = getCacheFilePath(modelKey);
    const data = {
      model: modelKey,
      signatures: signatures,
      lastModified: Date.now()
    };
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    log.warn(`Failed to write signature cache (${modelKey}):`, e?.message || e);
  }
}

/**
 * Get the latest signature entry
 * @param {string} modelKey - Model key
 * @returns {{ signature: string, content: string } | null}
 */
function getLatestEntry(modelKey) {
  if (!modelKey) return null;
  
  const signatures = readModelCache(modelKey);
  if (signatures.length === 0) return null;
  
  return signatures[signatures.length - 1] || null;
}

/**
 * Push a new signature entry (FIFO ring buffer)
 * @param {string} modelKey - Model key
 * @param {Object} entry - Signature entry { signature, content }
 */
function pushEntry(modelKey, entry) {
  if (!modelKey || !entry || !entry.signature) return;
  
  const signatures = readModelCache(modelKey);
  
  // Deduplicate: avoid enqueueing the same signature twice in a row
  if (signatures.length > 0 && signatures[signatures.length - 1]?.signature === entry.signature) {
    return;
  }
  
  // Append new entry
  signatures.push(entry);
  
  // Evict oldest entries when capacity is exceeded
  while (signatures.length > MAX_SIGNATURES_PER_MODEL) {
    signatures.shift();
  }
  
  writeModelCache(modelKey, signatures);
}

/**
 * Determine whether a signature should be cached
 * @param {Object} options - Options
 * @param {boolean} options.hasTools - Whether tools were used
 * @param {boolean} options.isImageModel - Whether this is an image model
 * @returns {boolean}
 */
export function shouldCacheSignature({ hasTools = false, isImageModel = false } = {}) {
  // Always cache when cacheAllSignatures is enabled
  if (config.cacheAllSignatures) return true;
  
  // Tool signature caching is enabled and tools were used
  if (config.cacheToolSignatures && hasTools) return true;
  
  // Image signature caching is enabled and this is an image model
  if (config.cacheImageSignatures && isImageModel) return true;
  
  return false;
}

/**
 * Check if a model is an image generation model
 * @param {string} model - Model name
 * @returns {boolean}
 */
export function isImageModel(model) {
  if (!model) return false;
  const lowerModel = model.toLowerCase();
  // Image generation models contain 'image' or 'nano-banana'
  return lowerModel.includes('image') || lowerModel.includes('nano-banana');
}

/**
 * Process thinking content based on cacheThinking setting
 * @param {string} content - Raw thinking content
 * @returns {string} Processed content
 */
function processThinkingContent(content) {
  if (!config.cacheThinking) {
    return ' '; // Substitute with a single space when thinking content caching is disabled
  }
  return content || ' ';
}

/**
 * Set signature and content (unified interface)
 * @param {string} sessionId - Session ID (kept for compatibility, not part of cache key)
 * @param {string} model - Model name
 * @param {string} signature - Signature
 * @param {string} content - Thinking content (optional)
 * @param {Object} options - Options
 * @param {boolean} options.hasTools - Whether tools were used
 * @param {boolean} options.isImageModel - Whether this is an image model
 */
export function setSignature(sessionId, model, signature, content = ' ', options = {}) {
  if (!signature || !model) return;
  
  // Check whether this signature should be cached
  const isImage = options.isImageModel ?? isImageModel(model);
  const hasTools = options.hasTools ?? false;
  
  if (!shouldCacheSignature({ hasTools, isImageModel: isImage })) {
    return; // Does not meet caching criteria
  }
  
  const processedContent = processThinkingContent(content);
  pushEntry(makeModelKey(model), { signature, content: processedContent });
}

/**
 * Get signature and content
 * @param {string} sessionId - Session ID
 * @param {string} model - Model name
 * @param {Object} options - Options
 * @param {boolean} options.hasTools - Whether tools were used
 * @returns {{ signature: string, content: string } | null}
 */
export function getSignature(sessionId, model, options = {}) {
  if (!model) return null;
  
  const entry = getLatestEntry(makeModelKey(model));
  if (!entry) return null;
  
  // Process returned content according to cacheThinking setting
  return {
    signature: entry.signature,
    content: config.cacheThinking ? entry.content : ' '
  };
}

// ========== Legacy API Compatibility ==========

/**
 * Set reasoning signature and content (legacy API compatibility)
 * @param {string} sessionId - Session ID
 * @param {string} model - Model name
 * @param {string} signature - Signature
 * @param {string} content - Thinking content
 * @param {Object} options - Options
 */
export function setReasoningSignature(sessionId, model, signature, content = ' ', options = {}) {
  setSignature(sessionId, model, signature, content, options);
}

/**
 * Get reasoning signature and content (legacy API compatibility)
 * @param {string} sessionId - Session ID
 * @param {string} model - Model name
 * @param {Object} options - Options
 * @returns {{ signature: string, content: string } | null}
 */
export function getReasoningSignature(sessionId, model, options = {}) {
  return getSignature(sessionId, model, options);
}

/**
 * Set tool signature and content (legacy API compatibility; now stored uniformly)
 * @param {string} sessionId - Session ID
 * @param {string} model - Model name
 * @param {string} signature - Signature
 * @param {string} content - Thinking content
 * @param {Object} options - Options
 */
export function setToolSignature(sessionId, model, signature, content = ' ', options = {}) {
  // Default hasTools = true for tool signatures
  setSignature(sessionId, model, signature, content, { ...options, hasTools: true });
}

/**
 * Get tool signature and content (legacy API compatibility)
 * @param {string} sessionId - Session ID
 * @param {string} model - Model name
 * @param {Object} options - Options
 * @returns {{ signature: string, content: string } | null}
 */
export function getToolSignature(sessionId, model, options = {}) {
  return getSignature(sessionId, model, options);
}

/**
 * Clear all signature caches (deletes all files in the cache directory)
 */
export function clearThoughtSignatureCaches() {
  try {
    if (fs.existsSync(CACHE_DIR)) {
      const files = fs.readdirSync(CACHE_DIR);
      for (const file of files) {
        if (file.endsWith('.json')) {
          fs.unlinkSync(path.join(CACHE_DIR, file));
        }
      }
    }
    log.info('Signature cache cleared');
  } catch (e) {
    log.warn('Failed to clear signature cache:', e?.message || e);
  }
}

// Ensure directory exists on initialization
ensureCacheDir();
