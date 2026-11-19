import { fileURLToPath } from 'url';
import path from 'path';
import log from '../src/utils/logger.js';
import tokenManager from '../src/auth/token_manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ACCOUNTS_FILE = path.join(__dirname, '..', 'data', 'accounts.json');

async function refreshAllTokens() {
  const tokens = tokenManager.getTokenList();
  if (!tokens || tokens.length === 0) {
    log.warn('No accounts found to refresh');
    return;
  }

  log.info(`Found ${tokens.length} accounts`);

  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    if (token.enable === false) {
      log.warn(`Account ${i + 1}: disabled, skipping`);
      continue;
    }

    try {
      log.info(`Refreshing account ${i + 1}...`);
      await tokenManager.refreshToken(token);
      successCount++;
      log.info(`Account ${i + 1}: refreshed successfully`);
    } catch (error) {
      failCount++;
      const statusCode = error.statusCode;
      log.error(`Account ${i + 1}: refresh failed - ${error.message}`);

      // For 400/403 errors, disable the account consistently with runtime behavior
      if (statusCode === 400 || statusCode === 403) {
        tokenManager.disableToken(token);
        log.warn(`Account ${i + 1}: token expired or invalid, account automatically disabled`);
      }
    }
  }

  log.info(`Refresh complete: ${successCount} succeeded, ${failCount} failed`);
  log.info(`Accounts file path: ${ACCOUNTS_FILE}`);
}

refreshAllTokens().catch(err => {
  log.error('Refresh failed:', err.message);
  process.exit(1);
});
