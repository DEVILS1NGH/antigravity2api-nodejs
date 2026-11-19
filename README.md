# Antigravity2API — OpenAI, Claude & Gemini Compatible API Proxy

A lightweight Node.js proxy server that exposes Google Antigravity and Gemini CLI APIs as **OpenAI**, **Claude**, and **Gemini** compatible endpoints — with streaming, function calling, thinking/reasoning output, image generation, multi-account rotation, and a built-in Web Admin Dashboard.

## ✨ Features

- ✅ **Multi-Format API Compatibility**: OpenAI (`/v1/chat/completions`), Claude (`/v1/messages`), and Gemini (`/v1beta/models/:model:generateContent`) endpoints
- ✅ **Latest Gemini Models Built-In**: Full support for **Gemini 4** (`gemini-4-carbon`, `gemini-4-argon`, `gemini-4-neon`, `gemini-4-hydrogen`), **Gemini 3.8 / 3.6 / 3.5 / 3.1 / 3.0**, **Nano Banana** image generation models, **Gemini Omni Flash**, **Gemini 2.5**, and specialized/agent models
- ✅ **Streaming & Non-Streaming Responses**: Full SSE streaming with configurable heartbeat to prevent CDN/Cloudflare timeouts
- ✅ **Structured JSON Output**: Supports `response_format` (`json_object`)
- ✅ **Tool / Function Calling**: Unified tool conversion across OpenAI, Claude, and Gemini formats
- ✅ **Thinking / Reasoning Output**: Compatible with OpenAI `reasoning_effort`, DeepSeek `reasoning_content`, Claude `thinking`, and Gemini `thinkingConfig`
- ✅ **Multimodal Input & Image Generation**: Base64 image inputs + native image generation via Nano Banana / Gemini Image models (`gemini-nano-banana-2.1`, `gemini-3.1-flash-image`, `gemini-3.1-flash-lite-image`, `gemini-3-pro-image`, `gemini-2.5-flash-image`)
- ✅ **SD WebUI Compatible API**: Supports `/sdapi/v1/txt2img` and `/sdapi/v1/img2img`
- ✅ **Multi-Account Pool & Auto-Rotation**: Supports `round_robin`, `quota_exhausted`, and `request_count` rotation strategies with automatic OAuth token refresh
- ✅ **Real-Time Quota Viewer**: Inspect remaining model quotas and reset times per account in the Web UI
- ✅ **Web Admin Dashboard**: Manage tokens, view quotas, edit configuration live, monitor real-time logs, and manage IP security rules
- ✅ **Privacy Mode**: Automatically masks sensitive tokens and project IDs in the Web UI
- ✅ **Memory Optimization**: Object pooling, dynamic memory thresholds, and low-footprint execution (~50MB RAM)
- ✅ **Prebuilt Binaries & Docker**: Run with Node.js, standalone binaries (Windows/Linux/macOS), Docker, or Zeabur

---

## 🤖 Supported Gemini Models (2025–2026)

All modern Gemini models released within the last 2 years are included out of the box (older deprecated Gemini 1.x / 2.0 models are omitted):

### Gemini 4 (Latest Flagship Frontier Models)
| Model ID | Description |
|----------|-------------|
| `gemini-4-carbon` | Most capable frontier reasoning model for complex software engineering, math, science, and long-horizon agentic tasks |
| `gemini-4-argon` | Efficient frontier reasoning model with faster responses and lower token spend per turn |
| `gemini-4-neon` | Frontier-level intelligence with fast end-to-end task completion |
| `gemini-4-hydrogen` | Fast, efficient everyday coding and agentic workflows (default Antigravity model) |

### Gemini 3.8, 3.6 & 3.5
| Model ID | Description |
|----------|-------------|
| `gemini-3.8-flash` | High-intelligence Flash model for software engineering, autonomous agents, and enterprise workflows |
| `gemini-3.8-live` | Low-latency real-time voice/dialogue Live API model |
| `gemini-3.8-live-extended-thinking` | High-reasoning audio-to-audio Live API model |
| `gemini-3.8-flash-tts` | Flagship creative text-to-speech across 130 languages |
| `gemini-3.8-flash-lite-tts` | Fast, cost-efficient text-to-speech across 101 languages |
| `gemini-3.6-flash` | Balanced Flash model for general agentic and everyday tasks |
| `gemini-3.5-flash` | Earlier 3.5 Flash model (routes to `gemini-3.6-flash`) |
| `gemini-3.5-flash-lite` | Fast, cost-effective 3.5 model for high-throughput workloads |
| `gemini-3.5-transcribe` / `gemini-3.5-transcribe-live` | Low-latency speech-to-text with diarization and timestamps |
| `gemini-3.5-live-translate-preview` | Real-time speech-to-speech translation across 70+ languages |

### Gemini 3.1 & 3.0
| Model ID | Description |
|----------|-------------|
| `gemini-3.1-pro-preview` / `gemini-3.1-pro-high` / `gemini-3.1-pro-low` | Gemini 3.1 Pro reasoning variants |
| `gemini-3.1-flash-lite` | Lightweight Gemini 3.1 Flash model |
| `gemini-3.1-flash-live-preview` / `gemini-3.1-flash-tts-preview` | Legacy Gemini 3.1 Live & TTS preview models |
| `gemini-3-pro-preview` / `gemini-3-flash-preview` | Gemini 3.0 Pro & Flash preview models |

### Gemini Image Generation (Nano Banana) & Video (Omni)
| Model ID | Description |
|----------|-------------|
| `gemini-nano-banana-2.1` | Latest Nano Banana 2.1 image generation & editing model |
| `gemini-3.1-flash-image` (`-2K`, `-4K`) | Nano Banana 2 — high-efficiency native image generation & editing |
| `gemini-3.1-flash-lite-image` (`-2K`, `-4K`) | Nano Banana 2 Lite — ultra-low latency image generation |
| `gemini-3-pro-image` (`-2K`, `-4K`) | Nano Banana Pro — high-fidelity contextual image generation |
| `gemini-2.5-flash-image` | Nano Banana — fast native image generation & editing |
| `gemini-omni-1.2-flash` / `gemini-omni-1.1-flash` | Video generation and editing with native audio |

### Gemini 2.5 & Specialized Models
| Model ID | Description |
|----------|-------------|
| `gemini-2.5-pro` / `gemini-2.5-flash` / `gemini-2.5-flash-thinking` / `gemini-2.5-flash-lite` | Gemini 2.5 text & reasoning models |
| `gemini-2.5-flash-native-audio-preview-12-2025` / `gemini-2.5-flash-preview-tts` / `gemini-2.5-pro-preview-tts` | Gemini 2.5 Live audio & TTS models |
| `gemini-decision-1` | Calibrated multimodal yes/no, choice, and score decisions |
| `gemini-embedding-2` / `gemini-embedding-001` | Multimodal and text embedding models |
| `gemini-robotics-er-2-preview` | Embodied spatial reasoning for robotics |
| `deep-research-preview-04-2026` / `deep-research-max-preview-04-2026` | Autonomous multi-step Deep Research agents |
| `antigravity-preview-09-2026` | Managed Antigravity coding & web agent |

> Claude models (`claude-opus-4-7`, `claude-opus-4-6`, `claude-sonnet-4-6`, and `-thinking` variants) are also supported alongside Gemini models.

---

## 📋 Requirements

- **Node.js >= 18.0.0** (not required if using prebuilt binaries or Docker)
- **Git** (for cloning / updating)

---

## 🚀 Quick Start

### Option 1: One-Click Setup Script (Recommended)

**Windows (Command Prompt / `cmd.exe`):**
```cmd
curl -O https://raw.githubusercontent.com/DEVILS1NGH/antigravity2api-nodejs/main/setup.bat && setup.bat
```

**Windows (PowerShell):**
```powershell
Invoke-WebRequest -Uri https://raw.githubusercontent.com/DEVILS1NGH/antigravity2api-nodejs/main/setup.bat -OutFile setup.bat; .\setup.bat
```

**Linux / macOS:**
```bash
curl -O https://raw.githubusercontent.com/DEVILS1NGH/antigravity2api-nodejs/main/setup.sh && chmod +x setup.sh && ./setup.sh
```
*(Or with `wget`: `wget https://raw.githubusercontent.com/DEVILS1NGH/antigravity2api-nodejs/main/setup.sh && chmod +x setup.sh && ./setup.sh`)*

The script automatically:
1. Clones the repository
2. Installs npm dependencies
3. Copies `.env.example` to `.env`
4. Prompts you for your admin username, admin password, and API key
5. Starts the server at `http://localhost:8045`

#### Quick Restart (Already Installed)
- **Windows**: `start.bat`
- **Linux / macOS**: `chmod +x start.sh && ./start.sh`

#### Updating to the Latest Version
- **Windows**: `update.bat`
- **Linux / macOS**: `chmod +x update.sh && ./update.sh`

After updating, you can restore local edits with `git stash pop` or discard them with `git stash drop`.

---

### Option 2: Manual Installation

#### 1. Clone and install dependencies
```bash
git clone https://github.com/DEVILS1NGH/antigravity2api-nodejs.git
cd antigravity2api-nodejs
npm install
```

#### 2. Configure environment variables
On first startup, `.env` and `config.json` are automatically created if they don't exist. You can also copy them manually:

```bash
cp .env.example .env
cp config.json.example config.json
```

Edit `.env`:
```env
# Required (if left unset, random credentials will be generated and printed on startup)
API_KEY=sk-your-api-key
ADMIN_USERNAME=admin
ADMIN_PASSWORD=your-strong-password
JWT_SECRET=your-jwt-secret-key-change-this-in-production

# Optional
# PROXY=http://127.0.0.1:7890
# SYSTEM_INSTRUCTION=You are a helpful AI assistant.
# IMAGE_BASE_URL=http://your-domain.com
```

#### 3. Authenticate with Google OAuth
You can either run the CLI login helper:
```bash
npm run login
```
This opens your browser to authorize with Google and saves the token to `data/accounts.json`. Alternatively, start the server first and add accounts directly in the Web Admin UI.

#### 4. Start the server
```bash
npm start
```

The server will start at **`http://localhost:8045`**.

---

## 📦 Standalone Binary Deployment (No Node.js Required)

Download the prebuilt archive for your platform from [GitHub Releases](https://github.com/DEVILS1NGH/antigravity2api-nodejs/releases):

| Platform | Archive |
|----------|---------|
| Windows x64 | `antigravity-win-x64.zip` |
| Linux x64 | `antigravity-linux-x64.tar.gz` |
| Linux ARM64 (Termux / ARM servers) | `antigravity-linux-arm64.tar.gz` |
| macOS x64 | `antigravity-macos-x64.tar.gz` |
| macOS ARM64 (Apple Silicon) | `antigravity-macos-arm64.tar.gz` |

Extract the archive and ensure the directory structure looks like:
```
├── antigravity-linux-x64   # (or .exe on Windows)
├── .env                    # Optional (auto-created on first run)
├── config.json             # Auto-created if missing
├── public/                 # Required Web UI static files
└── data/                   # Auto-created for tokens & quotas
```

Run it:
- **Windows**: Double-click `antigravity-win-x64.exe` or run it from Command Prompt.
- **Linux / macOS**:
  ```bash
  chmod +x antigravity-linux-x64
  ./antigravity-linux-x64
  ```

### Running as a Linux `systemd` Service
Create `/etc/systemd/system/antigravity2api.service`:
```ini
[Unit]
Description=Antigravity2API Service
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/antigravity2api
ExecStart=/opt/antigravity2api/antigravity-linux-x64
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```
Enable and start:
```bash
sudo systemctl daemon-reload
sudo systemctl enable antigravity2api
sudo systemctl start antigravity2api
```

---

## 🐳 Docker Deployment

### Using Docker Compose (Recommended)

1. **Prepare & build**:
   ```bash
   npm run docker:build
   ```
   *(This creates `.env`, `config.json`, `data/`, and `public/images/` if missing, then runs `docker compose build`.)*

2. **Start in background**:
   ```bash
   docker compose up -d
   ```

3. **View logs / stop**:
   ```bash
   docker compose logs -f
   docker compose down
   ```

### Manual Docker Build & Run
```bash
cp .env.example .env
cp config.json.example config.json
mkdir -p data public/images

docker build -t antigravity2api .

docker run -d \
  --name antigravity2api \
  -p 8045:8045 \
  -e API_KEY=sk-your-api-key \
  -e ADMIN_USERNAME=admin \
  -e ADMIN_PASSWORD=admin123 \
  -e JWT_SECRET=your-jwt-secret-key \
  -e IMAGE_BASE_URL=http://your-domain.com \
  -v $(pwd)/data:/app/data \
  -v $(pwd)/public/images:/app/public/images \
  -v $(pwd)/.env:/app/.env \
  -v $(pwd)/config.json:/app/config.json \
  antigravity2api
```

### Zeabur Deployment
1. Create a new service in Zeabur using the image `ghcr.io/devils1ngh/antigravity2api-nodejs:latest`.
2. Add environment variables: `API_KEY`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `JWT_SECRET`, `IMAGE_BASE_URL` (and optionally `PROXY`, `SYSTEM_INSTRUCTION`).
3. Mount persistent volumes **only** at `/app/data` and `/app/public/images` (do not mount `/app/.env` or `/app/config.json`).
4. Bind a domain in Networking and set `IMAGE_BASE_URL` to that domain.

---

## 🖥️ Web Admin Dashboard

Open **`http://localhost:8045`** in your browser after starting the server.

1. **Log In**: Enter your `ADMIN_USERNAME` and `ADMIN_PASSWORD` from `.env` (or the auto-generated credentials printed in the console).
2. **Add Accounts / Tokens**:
   - **OAuth Login (Recommended)**: Click **OAuth Login**, open the Google authorization link, complete sign-in, copy the full callback URL from your browser's address bar, and paste it into the form.
   - **Manual Entry**: Paste an existing `access_token`, `refresh_token`, and expiry time directly.
3. **Manage Accounts & Quotas**:
   - Toggle tokens **Enable / Disable**, delete invalid tokens, or edit credentials.
   - Click **View Quota** on any token card to see remaining quota percentages and reset times grouped by **Claude**, **Gemini**, **Nano Banana**, and **Other**.
   - Toggle **Show Sensitive Info** to reveal or mask tokens and project IDs.
4. **Live Settings & Logs**:
   - Adjust rotation strategy, default generation parameters (`temperature`, `topP`, `topK`, `maxTokens`, `thinkingBudget`), retry settings, memory threshold, heartbeat interval, and security IP rules directly from the **Settings** tab.
   - View real-time server logs via WebSocket in the **Logs** tab.

---

## 🔌 API Usage

See **[API.md](API.md)** for full API documentation and code examples.

### Quick Test (OpenAI Format)
```bash
curl http://localhost:8045/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-your-api-key" \
  -d '{
    "model": "gemini-4-hydrogen",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

### Available Endpoints
| Format | Antigravity Endpoint | Gemini CLI Endpoint |
|--------|----------------------|---------------------|
| **OpenAI Chat** | `POST /v1/chat/completions` | `POST /cli/v1/chat/completions` |
| **OpenAI Models** | `GET /v1/models` | `GET /cli/v1/models` |
| **Claude Messages** | `POST /v1/messages` | `POST /cli/v1/messages` |
| **Gemini Generate** | `POST /v1beta/models/:model:generateContent` | `POST /cli/v1beta/models/:model:generateContent` |
| **Gemini Stream** | `POST /v1beta/models/:model:streamGenerateContent` | `POST /cli/v1beta/models/:model:streamGenerateContent` |
| **SD WebUI** | `POST /sdapi/v1/txt2img`, `POST /sdapi/v1/img2img` | — |

### Unified Parameters Across Formats
All three API formats normalize to the same internal parameters:
- **Priority**: Request parameter > `config.json` default
- **Thinking budget priority**: `thinking_budget` / `budget_tokens` / `thinkingBudget` > `reasoning_effort` (`low`=1024, `medium`=16000, `high`=32000) > config default
- **Disable thinking**: Set `thinking_budget: 0`, `thinking.type: "disabled"`, or `thinkingConfig.includeThoughts: false`

---

## ⚙️ Configuration Reference

### `config.json`
```json
{
  "server": {
    "port": 8045,
    "host": "0.0.0.0",
    "maxRequestSize": "500mb",
    "heartbeatInterval": 15000,
    "memoryThreshold": 100
  },
  "rotation": {
    "strategy": "request_count",
    "requestCount": 50
  },
  "defaults": {
    "temperature": 1,
    "topP": 1,
    "topK": 50,
    "maxTokens": 32000,
    "thinkingBudget": 1024
  },
  "cache": {
    "modelListTTL": 3600000
  },
  "other": {
    "timeout": 300000,
    "retryTimes": 3,
    "retryIntervalMs": 10000,
    "retryPollTokenWithQuota": false,
    "skipProjectIdFetch": false,
    "useNativeAxios": false,
    "useContextSystemPrompt": false,
    "passSignatureToClient": false
  }
}
```

### Rotation Strategies
| Strategy | Behavior |
|----------|----------|
| `round_robin` | Switches to the next token on every request |
| `quota_exhausted` | Uses the current token until its quota is exhausted |
| `request_count` | Switches token after `requestCount` requests (default: 50) |

### Environment Variables (`.env`)
| Variable | Description | Required |
|----------|-------------|----------|
| `API_KEY` | Bearer token for authenticating API requests | Auto-generated if unset |
| `ADMIN_USERNAME` | Web Admin Dashboard username | Auto-generated if unset |
| `ADMIN_PASSWORD` | Web Admin Dashboard password | Auto-generated if unset |
| `JWT_SECRET` | Secret key for signing Admin JWTs | Auto-generated if unset |
| `PROXY` | HTTP/SOCKS proxy URL (also supports `HTTP_PROXY` / `HTTPS_PROXY`) | Optional |
| `SYSTEM_INSTRUCTION` | Global system instruction prepended to requests | Optional |
| `OFFICIAL_SYSTEM_PROMPT` | Official system prompt override | Optional |
| `IMAGE_BASE_URL` | Public base URL for generated image links | Optional |
| `DEBUG_DUMP_REQUEST_RESPONSE` | Set to `1` to dump raw requests/responses for debugging | Optional |

---

## 🛠️ npm Scripts

```bash
npm start            # Start server with --expose-gc
npm run dev          # Development mode with auto-reload
npm run login        # Interactive Google OAuth login
npm run refresh      # Refresh stored OAuth tokens
npm run build:all    # Build standalone binaries for all platforms
npm run docker:build # Build Docker image
```

---

## 🔒 Security Notes

- Never commit `.env`, `config.json`, `security.json`, or `data/accounts.json` to public repositories.
- Change default credentials before exposing the server to the public internet.
- See **[QUOTA_FEATURE.md](QUOTA_FEATURE.md)** for details on quota caching and management.

## 📄 License

See [LICENSE](LICENSE) (CC BY-NC-SA 4.0 — for educational and non-commercial use).
