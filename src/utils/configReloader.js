import config, { getConfigJson, getUpstreamConfig, buildConfig } from '../config/config.js';
import requesterManager from './requesterManager.js';

/**
 * Reload configuration into the config object
 * Also resets the requester so new useNativeAxios / proxy / timeout settings take effect
 */
export function reloadConfig() {
  const newConfig = buildConfig(getConfigJson(), getUpstreamConfig());
  Object.assign(config, newConfig);
  requesterManager.reload();
}
