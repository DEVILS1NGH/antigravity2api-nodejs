# API Documentation

This guide explains how to use the OpenAI, Claude, Gemini, SD WebUI, and Admin APIs provided by **Antigravity2API**.

## Base Configuration

All `/v1/*`, `/v1beta/*`, and `/cli/*` API requests require your API key in the `Authorization` header (or `x-api-key` for Claude / `key` query param for Gemini):

```
Authorization: Bearer YOUR_API_KEY
```

Default base URL: `http://localhost:8045`

## Table of Contents

- [List Models](#list-models)
- [Chat Completions](#chat-completions)
- [Function Calling (Tools)](#function-calling-tools)
- [Multimodal Image Input](#multimodal-image-input)
- [Image Generation](#image-generation)
- [Thinking / Reasoning Models](#thinking--reasoning-models)
- [Gemini CLI Endpoints](#gemini-cli-endpoints)
- [SD WebUI Compatible API](#sd-webui-compatible-api)
- [Admin API](#admin-api)
- [SDK Examples](#sdk-examples)
- [Advanced Options](#advanced-options)

---

## List Models

```bash
curl http://localhost:8045/v1/models \
  -H "Authorization: Bearer sk-text"
```

The model list is cached for 1 hour by default (configurable via `cache.modelListTTL` in `config.json`) and includes all latest Gemini 4, Gemini 3.8/3.6/3.5/3.1/3.0, Nano Banana image, Omni Flash, Gemini 2.5, specialized Gemini, and Claude models.

---

## Chat Completions

### Streaming Response

```bash
curl http://localhost:8045/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-text" \
  -d '{
    "model": "gemini-4-hydrogen",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

### Non-Streaming Response

```bash
curl http://localhost:8045/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-text" \
  -d '{
    "model": "gemini-4-hydrogen",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": false
  }'
```

---

## Function Calling (Tools)

```bash
curl http://localhost:8045/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-text" \
  -d '{
    "model": "gemini-4-argon",
    "messages": [{"role": "user", "content": "What is the weather in Tokyo?"}],
    "tools": [{
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "Get current weather information",
        "parameters": {
          "type": "object",
          "properties": {
            "location": {"type": "string", "description": "City name"}
          },
          "required": ["location"]
        }
      }
    }]
  }'
```

---

## Multimodal Image Input

Supports Base64-encoded image inputs in standard OpenAI multimodal format:

```bash
curl http://localhost:8045/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-text" \
  -d '{
    "model": "gemini-3.8-flash",
    "messages": [{
      "role": "user",
      "content": [
        {"type": "text", "text": "What is in this image?"},
        {
          "type": "image_url",
          "image_url": {
            "url": "data:image/jpeg;base64,/9j/4AAQSkZJRg..."
          }
        }
      ]
    }],
    "stream": true
  }'
```

### Supported Image Formats
- JPEG/JPG (`data:image/jpeg;base64,...`)
- PNG (`data:image/png;base64,...`)
- GIF (`data:image/gif;base64,...`)
- WebP (`data:image/webp;base64,...`)

---

## Image Generation

Generate images with Gemini Image / Nano Banana models (`gemini-nano-banana-2.1`, `gemini-3.1-flash-image`, `gemini-3.1-flash-lite-image`, `gemini-3-pro-image`, `gemini-2.5-flash-image`, plus `-2K` and `-4K` resolution suffixes). Generated images are returned as Markdown image links:

```bash
curl http://localhost:8045/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-text" \
  -d '{
    "model": "gemini-nano-banana-2.1",
    "messages": [{"role": "user", "content": "Draw a cute cat in watercolor style"}],
    "stream": false
  }'
```

**Response Example**:
```json
{
  "choices": [{
    "message": {
      "role": "assistant",
      "content": "![image](http://localhost:8045/images/abc123.png)"
    }
  }]
}
```

**Notes**:
- Generated images are saved under `public/images/`.
- Set `IMAGE_BASE_URL` in `.env` so returned image URLs use your public domain.

---

## Request Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `model` | string | Yes | Model ID (e.g., `gemini-4-carbon`, `gemini-4-hydrogen`, `gemini-3.8-flash`) |
| `messages` | array | Yes | Conversation message list |
| `stream` | boolean | No | Enable SSE streaming (default: `false`) |
| `temperature` | number | No | Sampling temperature (default: `1`) |
| `top_p` | number | No | Top-P nucleus sampling (default: `1`) |
| `top_k` | number | No | Top-K sampling (default: `50`) |
| `max_tokens` | number | No | Maximum output tokens (default: `32000`) |
| `thinking_budget` | number | No | Thinking token budget (`0` to disable, or `1024`–`32000`, default: `1024`) |
| `reasoning_effort` | string | No | OpenAI-compatible reasoning depth: `low` (1024), `medium` (16000), `high` (32000) |
| `response_format` | object | No | Structured output (`{ "type": "json_object" }`, supported on Gemini models) |
| `tools` | array | No | Tool definitions for Function Calling |

---

## Response Formats

### Non-Streaming Response
```json
{
  "id": "chatcmpl-xxx",
  "object": "chat.completion",
  "created": 1763560000,
  "model": "gemini-4-hydrogen",
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": "Hello! How can I help you today?"
    },
    "finish_reason": "stop"
  }],
  "usage": {
    "prompt_tokens": 10,
    "completion_tokens": 20,
    "total_tokens": 30
  }
}
```

### Streaming Response (SSE)
```
data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","created":1763560000,"model":"gemini-4-hydrogen","choices":[{"index":0,"delta":{"role":"assistant","content":"Hello"},"finish_reason":null}]}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","created":1763560000,"model":"gemini-4-hydrogen","choices":[{"index":0,"delta":{"content":"!"},"finish_reason":null}]}

data: [DONE]
```

---

## Error Handling

| HTTP Status | Meaning |
|-------------|---------|
| `200` | Success |
| `400` | Invalid request parameters |
| `401` | Invalid or missing API key |
| `429` | Rate limit / quota exceeded |
| `500` | Internal server error |

Error response format:
```json
{
  "error": {
    "message": "Error description",
    "type": "invalid_request_error",
    "code": "invalid_api_key"
  }
}
```

---

## Thinking / Reasoning Models

Reasoning models (such as `gemini-4-carbon`, `gemini-4-argon`, `gemini-4-neon`, `gemini-4-hydrogen`, `gemini-3.8-flash`, `gemini-3.6-flash`, `gemini-3.1-pro-preview`, `gemini-2.5-pro`, and Claude `-thinking` models) support controlling thinking depth:

### Using `reasoning_effort`
```bash
curl http://localhost:8045/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-text" \
  -d '{
    "model": "gemini-4-carbon",
    "messages": [{"role": "user", "content": "Explain quantum entanglement"}],
    "stream": true,
    "reasoning_effort": "high"
  }'
```

| `reasoning_effort` | `thinking_budget` | Description |
|--------------------|-------------------|-------------|
| `low` | `1024` | Fast response for straightforward prompts (default) |
| `medium` | `16000` | Balanced reasoning depth |
| `high` | `32000` | Deep reasoning for complex tasks |

### Using `thinking_budget` Directly
```bash
curl http://localhost:8045/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-text" \
  -d '{
    "model": "gemini-4-carbon",
    "messages": [{"role": "user", "content": "Prove the Pythagorean theorem"}],
    "stream": true,
    "thinking_budget": 24000
  }'
```

### Automatic 429 / 503 Retry Configuration
Retries are configured server-side in `config.json`:
```json
"other": {
  "timeout": 300000,
  "retryTimes": 3,
  "retryIntervalMs": 10000,
  "retryPollTokenWithQuota": false,
  "skipProjectIdFetch": false,
  "useNativeAxios": false
}
```
- `retryTimes`: Maximum retry attempts (default: `3`).
- `retryIntervalMs`: Fixed wait interval in milliseconds (default: `10000`).
- `retryPollTokenWithQuota`: When enabled, switches to another non-cooled-down token with remaining quota before retrying.

### Reasoning Response Format
Thinking content is returned in the `reasoning_content` field (DeepSeek-compatible):

```json
{
  "choices": [{
    "message": {
      "role": "assistant",
      "reasoning_content": "Let me think through this step by step...",
      "content": "Quantum entanglement is..."
    }
  }]
}
```

---

## Gemini CLI Endpoints

When Gemini CLI mode is enabled, additional endpoints are available under `/cli`:
- `GET /cli/v1/models`
- `POST /cli/v1/chat/completions`
- `POST /cli/v1/messages`
- `POST /cli/v1beta/models/:model:generateContent`
- `POST /cli/v1beta/models/:model:streamGenerateContent`

Supported model modifiers on `/cli/*`:
- **Prefixes**: `fake-stream/` (fake streaming), `anti-truncation/` (streaming anti-truncation)
- **Suffixes**: `-maxthinking`, `-nothinking`, `-search` (Google Search grounding)

Example: `anti-truncation/gemini-4-hydrogen-maxthinking-search`

---

## SD WebUI Compatible API

### Text-to-Image (`txt2img`)
```bash
curl http://localhost:8045/sdapi/v1/txt2img \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "a cute cat, high quality, detailed",
    "negative_prompt": "",
    "steps": 20,
    "width": 512,
    "height": 512
  }'
```

### Image-to-Image (`img2img`)
```bash
curl http://localhost:8045/sdapi/v1/img2img \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "enhance this image, high quality",
    "init_images": ["BASE64_ENCODED_IMAGE"],
    "steps": 20
  }'
```

### Other SD WebUI Endpoints
| Endpoint | Description |
|----------|-------------|
| `GET /sdapi/v1/sd-models` | List available Gemini / Nano Banana image generation models |
| `GET /sdapi/v1/options` | Get current SD options |
| `GET /sdapi/v1/samplers` | List available samplers |
| `GET /sdapi/v1/upscalers` | List available upscalers |
| `GET /sdapi/v1/progress` | Get generation progress |

---

## Admin API

Admin endpoints require a JWT token obtained via `/admin/login`.

### Login
```bash
curl http://localhost:8045/admin/login \
  -H "Content-Type: application/json" \
  -d '{
    "username": "admin",
    "password": "admin123"
  }'
```

### Token Management
```bash
# List tokens
curl http://localhost:8045/admin/tokens \
  -H "Authorization: Bearer JWT_TOKEN"

# Add token
curl http://localhost:8045/admin/tokens \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer JWT_TOKEN" \
  -d '{
    "access_token": "ya29.xxx",
    "refresh_token": "1//xxx",
    "expires_in": 3599
  }'

# Delete token
curl -X DELETE http://localhost:8045/admin/tokens/REFRESH_TOKEN \
  -H "Authorization: Bearer JWT_TOKEN"
```

### Model Quotas
```bash
# Get quotas for a token
curl http://localhost:8045/admin/tokens/REFRESH_TOKEN/quotas \
  -H "Authorization: Bearer JWT_TOKEN"

# Force refresh quotas
curl "http://localhost:8045/admin/tokens/REFRESH_TOKEN/quotas?refresh=true" \
  -H "Authorization: Bearer JWT_TOKEN"
```

### Rotation Strategy
```bash
# Get current rotation config
curl http://localhost:8045/admin/rotation \
  -H "Authorization: Bearer JWT_TOKEN"

# Update rotation strategy
curl -X PUT http://localhost:8045/admin/rotation \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer JWT_TOKEN" \
  -d '{
    "strategy": "request_count",
    "requestCount": 20
  }'
```

### Configuration Management
```bash
# Get config
curl http://localhost:8045/admin/config \
  -H "Authorization: Bearer JWT_TOKEN"

# Update config
curl -X PUT http://localhost:8045/admin/config \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer JWT_TOKEN" \
  -d '{
    "json": {
      "defaults": {
        "temperature": 0.7
      }
    }
  }'
```

---

## SDK Examples

### Python (`openai` SDK)
```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:8045/v1",
    api_key="sk-text"
)

stream = client.chat.completions.create(
    model="gemini-4-hydrogen",
    messages=[{"role": "user", "content": "Hello!"}],
    stream=True
)

for chunk in stream:
    if chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="")
```

### Node.js (`openai` SDK)
```javascript
import OpenAI from 'openai';

const openai = new OpenAI({
  baseURL: 'http://localhost:8045/v1',
  apiKey: 'sk-text'
});

const stream = await openai.chat.completions.create({
  model: 'gemini-4-hydrogen',
  messages: [{ role: 'user', content: 'Hello!' }],
  stream: true
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content || '');
}
```

---

## Advanced Options

### `passSignatureToClient`
Controls whether `thoughtSignature` is forwarded to the client in `config.json`:
```json
{
  "other": {
    "passSignatureToClient": false
  }
}
```
- `false` (default): `thoughtSignature` is omitted from responses.
- `true`: `thoughtSignature` is included in streaming deltas / responses.

### `useContextSystemPrompt`
Controls whether leading `system` messages in a request are merged into `SystemInstruction`:
```json
{
  "other": {
    "useContextSystemPrompt": false
  }
}
```
- `false` (default): Uses only the global `SYSTEM_INSTRUCTION` environment variable.
- `true`: Merges consecutive leading `system` messages with the global `SYSTEM_INSTRUCTION`.
