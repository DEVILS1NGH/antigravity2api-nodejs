# Frontend Module Overview

The original `app.js` (1300+ lines) has been split into the following modules:

## Module Structure

```
js/
├── utils.js    - Utility functions (font size, sensitive info hiding)
├── ui.js       - UI components (Toast, Modal, Loading, Tab switching)
├── auth.js     - Authentication (login, logout, OAuth authorization)
├── tokens.js   - Token management (CRUD, enable/disable, inline editing)
├── quota.js    - Quota management (view, refresh, cache, inline display)
├── config.js   - Configuration management (load, save, polling strategy)
└── main.js     - Main entry point (initialization, event binding)
```

## Loading Order

Modules are loaded according to their dependencies (in `index.html`):

1. **utils.js** - Core utility functions
2. **ui.js** - UI components (depends on utils)
3. **auth.js** - Authentication module (depends on ui)
4. **quota.js** - Quota module (depends on auth)
5. **tokens.js** - Token module (depends on auth, quota, ui)
6. **config.js** - Config module (depends on auth, ui)
7. **main.js** - Main entry point (depends on all modules)

## Module Responsibilities

### utils.js
- Font size setting and persistence
- Sensitive info show/hide toggle
- localStorage management

### ui.js
- Toast notifications
- Confirm dialogs
- Loading overlay
- Tab page switching

### auth.js
- User login/logout
- OAuth authorization flow
- `authFetch` wrapper (automatically handles 401)
- Token authentication state management

### tokens.js
- Token list loading and rendering
- Token CRUD operations
- Inline field editing (`projectId`, `email`)
- Token details modal

### quota.js
- Quota data caching (5-minute TTL)
- Inline quota summary display
- Quota details expand/collapse
- Quota modal (multi-account switching)
- Force refresh quota

### config.js
- Config loading (`.env` + `config.json`)
- Config saving (separating sensitive/non-sensitive)
- Polling strategy management
- Polling status display

### main.js
- Page initialization
- Login form event binding
- Config form event binding
- Auto-login check

## Global Variables

Global variables shared across modules:

- `authToken` - Auth token (`auth.js`)
- `cachedTokens` - Token list cache (`tokens.js`)
- `currentQuotaToken` - Currently viewed quota token (`quota.js`)
- `quotaCache` - Quota data cache object (`quota.js`)
- `sensitiveInfoHidden` - Sensitive info hidden state (`utils.js`)

## Benefits

1. **Maintainability** - Each module has a single responsibility, making it easy to locate and modify code
2. **Readability** - Reasonable file sizes (200-400 lines) with clear structure
3. **Extensibility** - Adding new features only requires editing the corresponding module
4. **Testability** - Independent modules are easier to unit test
5. **Collaboration-friendly** - Reduces merge conflicts during team development

## Notes

1. Modules communicate through global variables and functions
2. Maintain the script loading order to avoid dependency issues
3. Be mindful of cross-module function calls when making changes