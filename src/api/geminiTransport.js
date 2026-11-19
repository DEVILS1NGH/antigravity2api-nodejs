import requesterManager from '../utils/requesterManager.js';

/**
 * Unified streaming SSE request (both TLS fingerprint and axios route through requesterManager)
 *
 * streamResponse implements the chainable onStart/onData/onEnd/onError interface
 * (TLS path returns src/requester.js StreamResponse,
 *  axios path returns AxiosStreamResponse inside requesterManager)
 */
export async function runSseStream({ url, method = 'POST', headers, body, processor, onErrorChunk } = {}) {
  const streamResponse = await requesterManager.fetchStream(url, { method, headers, body });

  let errorBody = '';
  let statusCode = null;

  await new Promise((resolve, reject) => {
    streamResponse
      .onStart(({ status }) => {
        statusCode = status;
      })
      .onData((chunk) => {
        if (statusCode !== 200) {
          errorBody += chunk;
          if (onErrorChunk) onErrorChunk(chunk);
        } else {
          processor.processChunk(chunk);
        }
      })
      .onEnd(() => {
        processor.close();
        if (statusCode !== 200) {
          reject({ status: statusCode, message: errorBody });
        } else {
          resolve();
        }
      })
      .onError(reject);
  });
}

/**
 * Send a JSON request and parse the response (non-streaming)
 *
 * @param {object} options
 * @param {string}   options.url
 * @param {object}   options.headers
 * @param {*}        options.body
 * @param {string}   [options.dumpId]
 * @param {Function} [options.dumpFinalRawResponse]
 * @param {string}   [options.rawFormat='json']
 * @returns {Promise<any>} Parsed JSON data
 */
export async function postJsonAndParse({
  url,
  headers,
  body,
  dumpId,
  dumpFinalRawResponse,
  rawFormat = 'json',
} = {}) {
  const { data } = await requesterManager.fetch(url, {
    method: 'POST',
    headers,
    body,
  });

  if (dumpId) {
    const rawText = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    await dumpFinalRawResponse(dumpId, rawText, rawFormat);
    return typeof data === 'string' ? JSON.parse(data) : data;
  }

  return data;
}
