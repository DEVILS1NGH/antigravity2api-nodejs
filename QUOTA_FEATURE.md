# Model Quota Management

## Overview

The Model Quota Management feature lets you inspect each token's remaining model quota and reset time directly in the Web Admin Dashboard.

## Architecture

### Data Storage
- **`data/accounts.json`**: Stores only core account authentication credentials.
- **`data/quotas.json`**: Dedicated lightweight persistence file for cached quota data.
- **In-memory cache**: 5-minute TTL to avoid excessive upstream API calls.
- **Auto cleanup**: Runs hourly to purge entries not updated in over 1 hour.

### Core Files
1. **`src/api/client.js`**
   - `getModelsWithQuotas(token)` extracts `quotaInfo` from upstream model metadata.
2. **`src/auth/quota_manager.js`**
   - Manages in-memory cache, file persistence, timezone formatting, and automatic expiration cleanup.
3. **`src/routes/admin.js`**
   - Exposes `GET /admin/tokens/:refreshToken/quotas` for on-demand quota fetching (supports `?refresh=true`).
4. **`public/js/quota.js`**
   - Handles expanding/collapsing quota panels, loading quota data, grouping models (**Claude**, **Gemini**, **Nano Banana**, **Other**), and rendering progress bars.
5. **`public/css/pages.css`**
   - Styles quota progress bars with color coding: green (>50%), yellow (20–50%), red (<20%).

## Usage

### In the Web Dashboard
1. Log in to the Web Admin Dashboard (`http://localhost:8045`).
2. Click **"View Quota"** on any token card.
3. Quotas are automatically fetched and grouped by model family, displaying:
   - Model ID
   - Remaining quota percentage and color-coded progress bar
   - Next quota reset time

### Data Formats

#### API Response Example
```json
{
  "success": true,
  "data": {
    "lastUpdated": 1765109350660,
    "models": {
      "gemini-4-hydrogen": {
        "remaining": 0.972,
        "resetTime": "11-19 15:27",
        "resetTimeRaw": "2026-11-19T07:27:44Z"
      },
      "gemini-3.8-flash": {
        "remaining": 0.85,
        "resetTime": "11-19 16:15",
        "resetTimeRaw": "2026-11-19T08:15:30Z"
      }
    }
  }
}
```

#### `data/quotas.json` Storage Format
```json
{
  "meta": {
    "lastCleanup": 1765109350660,
    "ttl": 3600000
  },
  "quotas": {
    "1//0eDtvmkC_KgZv": {
      "lastUpdated": 1765109350660,
      "models": {
        "gemini-4-hydrogen": {
          "r": 0.972,
          "t": "2026-11-19T07:27:44Z"
        }
      }
    }
  }
}
```

## Key Features

- **On-Demand Loading**: Quotas are only fetched when requested.
- **Smart Caching**: Reuses cached data within 5 minutes to reduce API requests.
- **Automatic Cleanup**: Periodically removes stale quota records.
- **Visual Progress Bars**: Color-coded indicators for quick status scanning.
- **Lightweight Storage**: Compact keys (`r` for remaining fraction, `t` for reset timestamp).

## Notes

1. The first quota check calls the upstream Google API and may take a few seconds.
2. Results are cached for 5 minutes; click **Refresh Now** (or pass `?refresh=true`) to force a live update.
3. `data/quotas.json` is created automatically — no manual setup required.
4. Expired or invalid tokens will display an error message.
