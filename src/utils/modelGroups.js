/**
 * Model Grouping Utility
 * Centralizes model-to-group mapping logic shared by quota_manager and token_cooldown_manager
 */

/**
 * Supported model groups
 * - claude: Claude model family
 * - gemini: Gemini model family
 * - banana: Gemini Image / Nano Banana image generation models
 * - other: Other models
 */
export const MODEL_GROUPS = ['claude', 'gemini', 'banana', 'other'];

/**
 * Get the group key for a given model ID
 * @param {string} modelId - Model ID
 * @returns {string} Group key (claude | gemini | banana | other)
 */
export function getGroupKey(modelId) {
  if (!modelId) return 'other';
  const lower = modelId.toLowerCase();

  if (lower.includes('claude')) return 'claude';
  // Check banana (image generation) before gemini because model IDs contain 'gemini'
  if (
    lower.includes('nano-banana') ||
    (lower.includes('gemini') && lower.includes('-image')) ||
    lower.includes('imagen')
  ) {
    return 'banana';
  }
  if (
    lower.includes('gemini') ||
    lower.includes('publishers/google/') ||
    lower.includes('deep-research-') ||
    lower.includes('antigravity-')
  ) {
    return 'gemini';
  }

  return 'other';
}
