/**
 * Claude API routes
 * Handles /v1/messages endpoints
 */

import { Router } from 'express';
import { handleClaudeRequest } from '../server/handlers/claude.js';

const router = Router();

/**
 * POST /v1/messages
 * Handle Claude message requests
 */
router.post('/messages', (req, res) => {
  const isStream = req.body.stream === true;
  handleClaudeRequest(req, res, isStream);
});

/**
 * POST /v1/messages/count_tokens
 * Estimate the token count of a request
 * Claude Code calls this endpoint frequently during /init
 */
router.post('/messages/count_tokens', (req, res) => {
  try {
    const { messages, system } = req.body;

    // Simple token estimation: roughly 4 characters = 1 token
    let totalChars = 0;

    // Count system prompt characters
    if (system) {
      if (typeof system === 'string') {
        totalChars += system.length;
      } else if (Array.isArray(system)) {
        for (const item of system) {
          if (item.text) totalChars += item.text.length;
        }
      }
    }

    // Count message content characters
    if (messages && Array.isArray(messages)) {
      for (const msg of messages) {
        if (typeof msg.content === 'string') {
          totalChars += msg.content.length;
        } else if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (part.type === 'text' && part.text) {
              totalChars += part.text.length;
            }
          }
        }
      }
    }

    // Estimate token count (~2 chars/token for CJK, ~4 chars/token for English, average 3)
    const estimatedTokens = Math.ceil(totalChars / 3);

    res.json({
      input_tokens: estimatedTokens
    });
  } catch (error) {
    res.status(400).json({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: error.message || 'Failed to count tokens'
      }
    });
  }
});

export default router;