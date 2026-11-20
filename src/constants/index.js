/**
 * Application constant definitions
 * @module constants
 */

// ==================== Cache Constants ====================

/**
 * File cache TTL (milliseconds)
 * @type {number}
 */
export const FILE_CACHE_TTL = 5000;

/**
 * File save delay (milliseconds) - used for debouncing
 * @type {number}
 */
export const FILE_SAVE_DELAY = 1000;

/**
 * Quota cache TTL (milliseconds) - 5 minutes
 * @type {number}
 */
export const QUOTA_CACHE_TTL = 5 * 60 * 1000;

/**
 * Quota cleanup interval (milliseconds) - 1 hour
 * @type {number}
 */
export const QUOTA_CLEANUP_INTERVAL = 60 * 60 * 1000;

/**
 * Default model list cache TTL (milliseconds) - 1 hour
 * @type {number}
 */
export const MODEL_LIST_CACHE_TTL = 60 * 60 * 1000;

// ==================== Memory Management Constants ====================

/**
 * Default memory cleanup interval (milliseconds)
 * Within this interval, even under MEDIUM/HIGH pressure, cleanup callbacks will not be triggered repeatedly,
 * avoiding performance overhead from frequent scanning and freeing.
 * @type {number}
 */
export const MEMORY_CLEANUP_INTERVAL = 30 * 60 * 1000;

// ==================== Server Constants ====================

/**
 * Default heartbeat interval (milliseconds)
 * @type {number}
 */
export const DEFAULT_HEARTBEAT_INTERVAL = 15000;

/**
 * Default server port
 * @type {number}
 */
export const DEFAULT_SERVER_PORT = 8045;

/**
 * Default server host
 * @type {string}
 */
export const DEFAULT_SERVER_HOST = '0.0.0.0';

/**
 * Default request timeout (milliseconds)
 * @type {number}
 */
export const DEFAULT_TIMEOUT = 300000;

/**
 * Default retry count
 * @type {number}
 */
export const DEFAULT_RETRY_TIMES = 3;

/**
 * Default fixed retry interval (milliseconds)
 * 503 retries directly at the fixed interval; 429 only retries when the upstream response provides a wait interval/reset time.
 * @type {number}
 */
export const DEFAULT_RETRY_INTERVAL_MS = 10000;

/**
 * Default maximum request body size
 * @type {string}
 */
export const DEFAULT_MAX_REQUEST_SIZE = '50mb';

// ==================== Token Rotation Constants ====================

/**
 * Default number of requests per token before rotating
 * @type {number}
 */
export const DEFAULT_REQUEST_COUNT_PER_TOKEN = 50;

/**
 * Token refresh buffer before expiration (milliseconds) - 5 minutes
 * @type {number}
 */
export const TOKEN_REFRESH_BUFFER = 300000;

/**
 * Long cooldown threshold (milliseconds) - 1 hour
 * When a 429 reset time exceeds this value, triggers model-series level disabling
 * @type {number}
 */
export const LONG_COOLDOWN_THRESHOLD = 60 * 60 * 1000;

/**
 * Short cooldown threshold (milliseconds) - 3 seconds
 * When a 429 reset time is between this value and LONG_COOLDOWN_THRESHOLD,
 * sets a cooldown on the current token+modelId and stops retrying so the caller switches tokens
 * @type {number}
 */
export const SHORT_COOLDOWN_THRESHOLD = 3000;

// ==================== Default Generation Parameters ====================

/**
 * Default generation parameters
 */
export const DEFAULT_GENERATION_PARAMS = {
  temperature: 1,
  top_p: 0.85,
  top_k: 50,
  max_tokens: 32000,
  thinking_budget: 1024
};

/**
 * Mapping from reasoning_effort to thinkingBudget
 */
export const REASONING_EFFORT_MAP = {
  low: 1024,
  medium: 16000,
  high: 32000,
  xhigh: 64000
};

// ==================== Image Constants ====================

/**
 * Default maximum number of retained images
 * @type {number}
 */
export const DEFAULT_MAX_IMAGES = 10;

/**
 * MIME type to file extension mapping
 */
export const MIME_TO_EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp'
};

// ==================== Stop Sequences ====================

/**
 * Default stop sequences
 * @type {string[]}
 */
export const DEFAULT_STOP_SEQUENCES = [
  '<|user|>',
  '<|bot|>',
  '<|context_request|>',
  '<|endoftext|>',
  '<|end_of_turn|>'
];

export const QA_PAIRS = [
    {
        question: "How do I implement JWT authentication in Express?",
        answer: "I can help you implement JWT authentication. First install the jsonwebtoken package, then create middleware to verify tokens. I'll build a complete authentication module for you."
    },
    {
        question: "This API endpoint is returning a 500 error, can you help me figure out why?",
        answer: "Let me check the error logs and related code. A 500 error is usually a server-side issue, such as an uncaught exception or a database connection problem."
    },
    {
        question: "How can I optimize the performance of this code?",
        answer: "I'll analyze the performance bottlenecks in this code. Common optimizations include reducing nested loops, adding caching, using asynchronous processing, and optimizing database queries. Let me take a closer look at your code."
    },
    {
        question: "Help me write a Redis caching utility class",
        answer: "Sure, I'll create a Redis caching utility class with basic get, set, and delete methods, along with expiration settings and batch operations."
    },
    {
        question: "There's a bug in this function's logic; it always returns undefined",
        answer: "Let me inspect the function's return paths. Common causes include a missing return statement, improper async handling, or faulty conditional checks. I'll help you pinpoint the issue."
    },
    {
        question: "How do I implement file uploads?",
        answer: "I'll help you implement file uploads. Using the multer middleware makes it easy to handle file uploads, including size limits, type validation, and storage path configuration."
    },
    {
        question: "How should I configure a database connection pool?",
        answer: "Database connection pool settings should be tuned to your actual workload. I'll create a sensible configuration for you, including max/min connections and timeout values."
    },
    {
        question: "How do I handle CORS issues?",
        answer: "CORS issues can be resolved by configuring CORS middleware. I'll help you set up an appropriate CORS policy, including allowed origins, methods, and headers."
    },
    {
        question: "This async function isn't properly awaiting the result",
        answer: "Asynchronous operations require proper use of async/await or Promises. Let me review your code to ensure every async operation is awaited correctly."
    },
    {
        question: "How do I implement API rate limiting?",
        answer: "I'll help you implement API rate limiting. You can use the express-rate-limit middleware, or build a more flexible rate-limiting strategy backed by Redis."
    },
    {
        question: "Memory usage is too high, how can I optimize it?",
        answer: "Memory optimization involves several areas: object pooling, releasing resources promptly, preventing memory leaks, and streaming large datasets. Let me analyze your code."
    },
    {
        question: "How do I implement real-time communication with WebSockets?",
        answer: "I'll help you implement WebSocket support. Using the ws or socket.io library makes it straightforward to build bidirectional real-time communication, including connection management and message broadcasting."
    }
];

// ==================== Default Admin Configuration ====================

// Note: Admin credentials (username, password, JWT secret) are now auto-generated randomly by config.js
// If not configured by the user, the generated credentials are printed to the console at startup
// Hardcoded defaults are no longer used to improve security
