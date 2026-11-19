import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { getDataDir } from '../utils/paths.js';
import { FILE_CACHE_TTL } from '../constants/index.js';
import { log } from '../utils/logger.js';
import { generateSalt } from '../utils/idGenerator.js';

/**
 * Account data file structure:
 * {
 *   "salt": "Random salt value used to generate secure tokenIds",
 *   "tokens": [...]
 * }
 */

/**
 * Responsible for reading, writing, and caching the token file
 * Agnostic to business fields; only handles loading and saving the JSON array
 */
class TokenStore {
  constructor(filePath = path.join(getDataDir(), 'accounts.json')) {
    this.filePath = filePath;
    this._cache = null;
    this._cacheTime = 0;
    this._cacheTTL = FILE_CACHE_TTL;
    this._salt = null;
    this._lastReadOk = true;
    // Write lock: prevents concurrent writes from corrupting data
    this._writeQueue = Promise.resolve();
    this._pendingWrite = null;
  }

  async _ensureFileExists() {
    const dir = path.dirname(this.filePath);
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (e) {
      // Ignore errors such as directory already existing
    }

    try {
      await fs.access(this.filePath);
    } catch (e) {
      // Create an empty structure with a salt if the file does not exist
      const initialData = {
        salt: generateSalt(),
        tokens: []
      };
      await fs.writeFile(this.filePath, JSON.stringify(initialData, null, 2), 'utf8');
      log.info('✓ Created account config file (with security salt)');
    }
  }

  async _atomicWrite(content) {
    const dir = path.dirname(this.filePath);
    const base = path.basename(this.filePath);
    const tempPath = path.join(dir, `.${base}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);
    let handle;

    try {
      handle = await fs.open(tempPath, 'w');
      await handle.writeFile(content, 'utf8');
      await handle.sync();
      await handle.close();
      try {
        await fs.rename(tempPath, this.filePath);
      } catch (renameError) {
        if (renameError.code === 'EEXIST' || renameError.code === 'EPERM') {
          try {
            await fs.unlink(this.filePath);
          } catch (unlinkError) {
            if (unlinkError.code !== 'ENOENT') {
              throw unlinkError;
            }
          }
          await fs.rename(tempPath, this.filePath);
        } else {
          throw renameError;
        }
      }
    } catch (error) {
      if (handle) {
        try {
          await handle.close();
        } catch (closeError) {
          // Ignore close errors after write failures.
        }
      }
      try {
        await fs.unlink(tempPath);
      } catch (cleanupError) {
        // Ignore cleanup errors for temp files.
      }
      throw error;
    }
  }

  /**
   * Get the salt value (used to generate secure tokenIds)
   * @returns {Promise<string>} Salt value
   */
  async getSalt() {
    if (this._salt) return this._salt;
    
    await this._ensureFileExists();
    try {
      const data = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(data || '{}');
      
      // Backward compatibility: if it's an array, migrate to the new format
      if (Array.isArray(parsed)) {
        const newData = {
          salt: generateSalt(),
          tokens: parsed
        };
        await fs.writeFile(this.filePath, JSON.stringify(newData, null, 2), 'utf8');
        log.info('✓ Migrated account config file to new format (added security salt)');
        this._salt = newData.salt;
        return this._salt;
      }
      
      // Generate a salt if missing
      if (!parsed.salt) {
        parsed.salt = generateSalt();
        parsed.tokens = parsed.tokens || [];
        await fs.writeFile(this.filePath, JSON.stringify(parsed, null, 2), 'utf8');
        log.info('✓ Added security salt to account config file');
      }
      
      this._salt = parsed.salt;
      return this._salt;
    } catch (error) {
      log.error('Failed to read salt:', error.message);
      // Generate a temporary salt
      this._salt = generateSalt();
      return this._salt;
    }
  }

  _isCacheValid() {
    if (!this._cache) return false;
    const now = Date.now();
    return (now - this._cacheTime) < this._cacheTTL;
  }

  /**
   * Filter out invalid token entries
   * @param {Array} tokens - Raw token array
   * @returns {Array} Filtered array of valid tokens
   * @private
   */
  _filterValidTokens(tokens) {
    return tokens.filter(t => {
      if (!t || typeof t !== 'object') return false;
      if (!t.refresh_token && !t.access_token) {
        log.warn('Skipping invalid token entry (missing both refresh_token and access_token)');
        return false;
      }
      return true;
    });
  }

  /**
   * Read all tokens (including disabled ones) with simple in-memory caching
   * @returns {Promise<Array<object>>}
   */
  async readAll() {
    if (this._isCacheValid()) {
      return this._cache;
    }

    await this._ensureFileExists();
    try {
      const data = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(data || '{}');
      
      // Backward compatibility: if it's an array, use it directly
      if (Array.isArray(parsed)) {
        this._cache = this._filterValidTokens(parsed);
        this._lastReadOk = true;
      } else if (parsed.tokens && Array.isArray(parsed.tokens)) {
        this._cache = this._filterValidTokens(parsed.tokens);
        this._lastReadOk = true;
      } else {
        log.warn('Account config file format is invalid, keeping cache and skipping this read');
        this._lastReadOk = false;
        if (this._cache) {
          this._cacheTime = Date.now();
          return this._cache;
        }
        return [];
      }
    } catch (error) {
      log.error('Failed to read account config file:', error.message);
      this._lastReadOk = false;
      if (this._cache) {
        this._cacheTime = Date.now();
        return this._cache;
      }
      return [];
    }
    this._cacheTime = Date.now();
    return this._cache;
  }

  /**
   * Overwrite all tokens and update cache
   * Uses a write queue to ensure concurrency safety
   * @param {Array<object>} tokens
   */
  async writeAll(tokens) {
    const normalized = Array.isArray(tokens) ? tokens : [];
    
    // Use a queue to serialize writes and prevent data corruption from concurrent writes
    const writeOperation = async () => {
      await this._ensureFileExists();
      
      // Ensure salt is loaded
      const salt = await this.getSalt();
      
      try {
        const fileData = {
          salt: salt,
          tokens: normalized
        };
        await this._atomicWrite(JSON.stringify(fileData, null, 2));
        this._cache = normalized;
        this._cacheTime = Date.now();
        this._lastReadOk = true;
      } catch (error) {
        log.error('Failed to save account config file:', error.message);
        throw error;
      }
    };
    
    // Enqueue the write operation
    this._writeQueue = this._writeQueue
      .then(writeOperation)
      .catch(error => {
        // Catch errors without breaking the queue
        log.error('Write queue operation failed:', error.message);
      });
    
    return this._writeQueue;
  }

  /**
   * Merge in-memory enabled tokens back into the file
   * - Matches and updates existing records by refresh_token only
   * - Records not present in activeTokens (e.g., disabled accounts) remain unchanged
   * Uses debouncing to coalesce frequent write requests
   * @param {Array<object>} activeTokens - In-memory enabled tokens list (may include sessionId)
   * @param {object|null} tokenToUpdate - Optional single token to update to reduce iteration
   */
  async mergeActiveTokens(activeTokens, tokenToUpdate = null) {
    // Use write queue to ensure concurrency safety
    const mergeOperation = async () => {
      const allTokens = [...await this.readAll()];
      const hasActiveTokens = Array.isArray(activeTokens) && activeTokens.length > 0;

      const applyUpdate = (targetToken) => {
        if (!targetToken) return;
        const index = allTokens.findIndex(t => t.refresh_token === targetToken.refresh_token);
        if (index !== -1) {
          const { sessionId, ...plain } = targetToken;
          allTokens[index] = { ...allTokens[index], ...plain };
        }
      };

      if (!this._lastReadOk && allTokens.length === 0) {
        log.warn('Account config file read failed, skipping write to avoid overwriting');
        return null;
      }

      if (allTokens.length === 0 && hasActiveTokens) {
        return activeTokens.map(({ sessionId, ...plain }) => ({ ...plain }));
      }

      if (tokenToUpdate) {
        applyUpdate(tokenToUpdate);
      } else if (Array.isArray(activeTokens) && activeTokens.length > 0) {
        for (const memToken of activeTokens) {
          applyUpdate(memToken);
        }
      }

      return allTokens;
    };

    // Execute merge and write in the queue
    this._writeQueue = this._writeQueue
      .then(async () => {
        const mergedTokens = await mergeOperation();
        if (!mergedTokens) return;
        await this._ensureFileExists();
        const salt = await this.getSalt();
        
        try {
          const fileData = {
            salt: salt,
            tokens: mergedTokens
          };
          await this._atomicWrite(JSON.stringify(fileData, null, 2));
          this._cache = mergedTokens;
          this._cacheTime = Date.now();
          this._lastReadOk = true;
        } catch (error) {
          log.error('Failed to save account config file:', error.message);
          // Do not throw to avoid breaking the queue
        }
      })
      .catch(error => {
        log.error('Merge write queue operation failed:', error.message);
      });

    return this._writeQueue;
  }
}

export default TokenStore;
