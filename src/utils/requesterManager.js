import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import axios from 'axios';
import fingerprintRequester from '../requester.js';
import config from '../config/config.js';
import logger from './logger.js';
import { buildAxiosRequestConfig } from './httpClient.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Unified requester manager
 *
 * - Decides between the TLS fingerprint requester and axios based on config.useNativeAxios
 * - Supports hot reload: calling reload() triggers re-initialization on the next request
 * - Automatically falls back to axios if TLS requester initialization fails
 * - For scenarios requiring a binary body such as sendLog, use axios directly (TLS requester does not currently support binary bodies)
 */
class RequesterManager {
  constructor() {
    this._tlsRequester = null;
    this._tlsInitFailed = false;
    this._initPromise = null;
  }

  // ==================== Initialization ====================

  _ensureInit() {
    if (this._initPromise) return this._initPromise;
    this._initPromise = this._doInit();
    return this._initPromise;
  }

  async _doInit() {
    if (config.useNativeAxios === true) {
      this._tlsInitFailed = true;
      logger.info('[RequesterManager] Using native axios for requests');
      return;
    }

    try {
      const isPkg = typeof process.pkg !== 'undefined';
      const configPath = isPkg
        ? path.join(path.dirname(process.execPath), 'bin', 'tls_config.json')
        : path.join(__dirname, '..', 'bin', 'tls_config.json');

      const requester = fingerprintRequester.create({
        configPath,
        timeout: config.timeout ? Math.ceil(config.timeout / 1000) : 30,
        proxy: config.proxy || null,
      });

      // Proactively probe whether the binary is executable (catches architecture mismatch, corrupted binary, etc.)
      await this._probeBinary(requester.binaryPath);

      this._tlsRequester = requester;
      logger.info('[RequesterManager] Using FingerprintRequester (TLS fingerprint) for requests');
    } catch (error) {
      logger.warn('[RequesterManager] FingerprintRequester initialization failed, falling back to axios:', error.message);
      this._tlsInitFailed = true;
    }
  }

  /**
   * Proactively spawn the binary to probe executability, then terminate immediately
   * Throws an error if spawn fails (UNKNOWN / ENOENT, etc.), triggering fallback
   */
  _probeBinary(binaryPath) {
    return new Promise((resolve, reject) => {
      const proc = spawn(binaryPath);
      proc.on('error', (err) => {
        reject(new Error(`Binary cannot be executed: ${err.message}`));
      });
      // Terminate immediately once spawned; no need to wait for completion
      proc.on('spawn', () => {
        proc.kill();
        resolve();
      });
      // Compatibility with older Node versions (no 'spawn' event): stdout data also confirms process started
      proc.stdout.once('data', () => {
        proc.kill();
        resolve();
      });
      proc.stdin.end();
    });
  }

  get _useAxios() {
    return this._tlsInitFailed || !this._tlsRequester;
  }

  /**
   * Hot reload: reset the requester so it re-initializes with the latest config on the next request
   */
  reload() {
    if (this._tlsRequester) {
      try { this._tlsRequester.close(); } catch { /* ignore */ }
    }
    this._tlsRequester = null;
    this._tlsInitFailed = false;
    this._initPromise = null;
    logger.info('[RequesterManager] Requester reset; will re-initialize with new configuration on next request');
  }

  /**
   * Close all active child processes (called on process exit)
   */
  close() {
    if (this._tlsRequester) {
      try { this._tlsRequester.close(); } catch { /* ignore */ }
    }
  }

  // ==================== Core Request Methods ====================

  /**
   * Send a standard JSON request (non-streaming)
   *
   * @param {string} url
   * @param {object} options
   * @param {string}  [options.method='POST']
   * @param {object}  [options.headers={}]
   * @param {*}       [options.body=null]  - JSON object or string; use axios directly for binary bodies
   * @param {number[]} [options.okStatus]  - List of status codes treated as success, default [200]
   * @returns {Promise<{ status: number, data: any }>}
   *   data is the parsed JSON object (axios path) or raw text (if JSON parsing fails)
   */
  async fetch(url, { method = 'POST', headers = {}, body = null, okStatus = [200] } = {}) {
    await this._ensureInit();

    if (this._useAxios) {
      return this._axiosFetch(url, { method, headers, body, okStatus });
    }
    return this._tlsFetch(url, { method, headers, body, okStatus });
  }

  /**
   * Send a streaming SSE request
   *
   * @param {string} url
   * @param {object} options
   * @param {string}  [options.method='POST']
   * @param {object}  [options.headers={}]
   * @param {*}       [options.body=null]
   * @returns {Promise<StreamResponse | AxiosStreamResponse>}
   *   Both implement the chainable onStart/onData/onEnd/onError interface
   */
  async fetchStream(url, { method = 'POST', headers = {}, body = null } = {}) {
    await this._ensureInit();

    if (this._useAxios) {
      return this._axiosFetchStream(url, { method, headers, body });
    }
    return this._tlsFetchStream(url, { method, headers, body });
  }

  // ==================== TLS Path ====================

  async _tlsFetch(url, { method, headers, body, okStatus }) {
    const reqConfig = this._buildTlsConfig(method, headers, body);
    const response = await this._tlsRequester.antigravity_fetch(url, reqConfig);

    if (!okStatus.includes(response.status)) {
      const errorBody = await response.text();
      throw { status: response.status, message: errorBody };
    }

    const text = await response.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    return { status: response.status, data };
  }

  _tlsFetchStream(url, { method, headers, body }) {
    const reqConfig = this._buildTlsConfig(method, headers, body);
    return this._tlsRequester.antigravity_fetchStream(url, reqConfig);
  }

  _buildTlsConfig(method, headers, body) {
    const reqConfig = {
      method,
      headers,
      timeout_ms: config.timeout,
      proxy: config.proxy || null,
    };
    if (body !== null) {
      // Pass Buffer / Uint8Array directly (TLS requester currently does not support binary body; callers should use axios)
      if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
        reqConfig.body = body;
      } else {
        reqConfig.body = typeof body === 'string' ? body : JSON.stringify(body);
      }
    }
    return reqConfig;
  }

  // ==================== axios Path ====================

  async _axiosFetch(url, { method, headers, body, okStatus }) {
    const axiosConfig = buildAxiosRequestConfig({
      method,
      url,
      headers,
      data: body,
      timeout: config.timeout,
    });

    // axios throws by default on non-2xx status codes; handle uniformly here
    axiosConfig.validateStatus = (status) => true;

    const response = await axios(axiosConfig);

    if (!okStatus.includes(response.status)) {
      const errorBody = typeof response.data === 'string'
        ? response.data
        : JSON.stringify(response.data);
      throw { status: response.status, message: errorBody };
    }

    return { status: response.status, data: response.data };
  }

  /**
   * axios streaming SSE path
   * Returns an object implementing onStart/onData/onEnd/onError, compatible with TLS StreamResponse
   */
  _axiosFetchStream(url, { method, headers, body }) {
    const streamResponse = new AxiosStreamResponse();

    const axiosConfig = buildAxiosRequestConfig({
      method,
      url,
      headers,
      data: body,
      timeout: config.timeout,
    });
    axiosConfig.responseType = 'stream';

    axios(axiosConfig)
      .then((response) => {
        const status = response.status;
        streamResponse._status = status;
        if (streamResponse._onStart) {
          streamResponse._onStart({ status, headers: response.headers });
        }

        response.data.on('data', (chunk) => {
          const text = chunk.toString('utf8');
          if (streamResponse._onData) {
            streamResponse._onData(text);
          }
        });

        response.data.on('end', () => {
          if (streamResponse._onEnd) {
            streamResponse._onEnd();
          }
        });

        response.data.on('error', (err) => {
          if (streamResponse._onError) {
            streamResponse._onError(err);
          }
        });
      })
      .catch((err) => {
        if (streamResponse._onError) {
          streamResponse._onError(err);
        }
      });

    return streamResponse;
  }
}

// ==================== AxiosStreamResponse ====================

/**
 * axios streaming response wrapper matching the StreamResponse interface in src/requester.js
 */
class AxiosStreamResponse {
  constructor() {
    this._status = null;
    this._onStart = null;
    this._onData = null;
    this._onEnd = null;
    this._onError = null;
  }

  get status() { return this._status; }

  onStart(callback) { this._onStart = callback; return this; }
  onData(callback)  { this._onData  = callback; return this; }
  onEnd(callback)   { this._onEnd   = callback; return this; }
  onError(callback) { this._onError = callback; return this; }
}

// ==================== Singleton Export ====================

export default new RequesterManager();
