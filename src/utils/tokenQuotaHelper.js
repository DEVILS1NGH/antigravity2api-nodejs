/**
 * Token Quota Check Helper
 * Checks model group availability for a token to support cascade quota management on 429 errors
 */
import tokenCooldownManager from '../auth/token_cooldown_manager.js';

// Core model groups and their representative models
const CORE_GROUPS = {
  claude: 'claude-sonnet-4-6',
  gemini: 'gemini-4-hydrogen',
  banana: 'gemini-3.1-flash-image'
};

/**
 * Check if the token still has other available model groups
 * @param {string} tokenId - Token ID
 * @returns {boolean} Whether any other model group is available
 */
export function hasOtherAvailableModelGroups(tokenId) {
  for (const [, modelId] of Object.entries(CORE_GROUPS)) {
    if (tokenCooldownManager.isAvailable(tokenId, modelId)) {
      return true;
    }
  }
  return false;
}

/**
 * Get the list of currently available model groups for a token
 * @param {string} tokenId - Token ID
 * @returns {string[]} Array of available model group keys
 */
export function getAvailableModelGroups(tokenId) {
  return Object.entries(CORE_GROUPS)
    .filter(([, modelId]) => tokenCooldownManager.isAvailable(tokenId, modelId))
    .map(([groupKey]) => groupKey);
}