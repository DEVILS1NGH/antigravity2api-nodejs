// Token management: CRUD, enable/disable

let cachedTokens = [];
let currentFilter = localStorage.getItem('tokenFilter') || 'all'; // 'all', 'enabled', 'disabled'
let skipAnimation = false; // Whether to skip entrance animation

// Mobile action bar manual collapse/expand
let actionBarCollapsed = localStorage.getItem('actionBarCollapsed') === 'true';

// Store event listener references for cleanup
const eventListenerRegistry = new WeakMap();

// Register event listener (for later cleanup)
function registerEventListener(element, event, handler, options) {
    if (!element) return;
    element.addEventListener(event, handler, options);

    if (!eventListenerRegistry.has(element)) {
        eventListenerRegistry.set(element, []);
    }
    eventListenerRegistry.get(element).push({ event, handler, options });
}

// Clean up all registered event listeners on an element
function cleanupEventListeners(element) {
    if (!element || !eventListenerRegistry.has(element)) return;

    const listeners = eventListenerRegistry.get(element);
    for (const { event, handler, options } of listeners) {
        element.removeEventListener(event, handler, options);
    }
    eventListenerRegistry.delete(element);
}

// Check if projectId is randomly generated (legacy format: adjective-noun-random)
function isRandomProjectId(projectId) {
    if (!projectId) return true;
    // Random format pattern: word-word-alphanumeric (e.g. useful-fuze-abc12)
    const randomPattern = /^[a-z]+-[a-z]+-[a-z0-9]{5}$/;
    return randomPattern.test(projectId);
}

// Manually fetch Project ID (from API)
async function fetchProjectId(event, tokenId) {
    event.stopPropagation(); // Prevent triggering parent click handler

    const btn = event.target;
    btn.disabled = true;
    btn.textContent = '⏳';

    try {
        const response = await authFetch(`/admin/tokens/${encodeURIComponent(tokenId)}/fetch-project-id`, {
            method: 'POST'
        });

        const data = await response.json();
        if (data.success) {
            showToast(`Project ID fetched: ${data.projectId}`, 'success');
            loadTokens(); // Refresh list
        } else {
            showToast(`Fetch failed: ${data.message || 'Unknown error'}`, 'error');
            btn.disabled = false;
            btn.textContent = '🔍';
        }
    } catch (error) {
        if (error.message !== 'Unauthorized') {
            showToast(`Fetch failed: ${error.message}`, 'error');
        }
        btn.disabled = false;
        btn.textContent = '🔍';
    }
}

// Batch fetch Project IDs for all enabled tokens
async function batchFetchProjectIds() {
    if (!cachedTokens || cachedTokens.length === 0) {
        showToast('No Tokens available', 'warning');
        return;
    }

    // Only fetch for enabled tokens
    const enabledTokens = cachedTokens.filter(t => t.enable);
    if (enabledTokens.length === 0) {
        showToast('No enabled Tokens', 'warning');
        return;
    }

    showLoading(`Batch fetching Project IDs (0/${enabledTokens.length})...`);

    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < enabledTokens.length; i++) {
        const token = enabledTokens[i];
        updateLoadingText(`Batch fetching Project IDs (${i + 1}/${enabledTokens.length})...`);

        try {
            const response = await authFetch(`/admin/tokens/${encodeURIComponent(token.id)}/fetch-project-id`, {
                method: 'POST'
            });
            const data = await response.json();
            if (data.success) {
                successCount++;
            } else {
                failCount++;
            }
        } catch (error) {
            failCount++;
        }

        // Rate-limit requests with a 500ms delay between each
        if (i < enabledTokens.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }

    hideLoading();
    showToast(`Batch fetch complete: ${successCount} succeeded, ${failCount} failed`, successCount > 0 ? 'success' : 'error');
    loadTokens(); // Refresh list
}

// Update loading overlay text
function updateLoadingText(text) {
    const loadingText = document.querySelector('.loading-overlay .loading-text');
    if (loadingText) {
        loadingText.textContent = text;
    }
}

// Export Tokens (requires admin password)
async function exportTokens() {
    const password = await showPasswordPrompt('Enter admin password to export Tokens');
    if (!password) return;

    showLoading('Exporting...');
    try {
        const response = await authFetch('/admin/tokens/export', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password })
        });

        const data = await response.json();
        hideLoading();

        if (data.success) {
            // Trigger file download
            const blob = new Blob([JSON.stringify(data.data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `tokens-export-${new Date().toISOString().slice(0, 10)}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            showToast('Exported successfully', 'success');
        } else {
            // Show specific error message for wrong password or other errors
            if (response.status === 403) {
                showToast('Incorrect password, please try again', 'error');
            } else {
                showToast(data.message || 'Export failed', 'error');
            }
        }
    } catch (error) {
        hideLoading();
        showToast('Export failed: ' + error.message, 'error');
    }
}

// Import Tokens (requires admin password) - opens drag-and-drop upload modal
async function importTokens() {
    showImportUploadModal();
}

// Current import mode: 'file' | 'json' | 'manual'
let currentImportTab = 'file';

// Store event handler references for the import modal
let importModalHandlers = null;

// Show import/upload modal (supports drag-and-drop, JSON paste, and manual token entry)
function showImportUploadModal() {
    const modal = document.createElement('div');
    modal.className = 'modal form-modal';
    modal.id = 'importUploadModal';
    modal.innerHTML = `
        <div class="modal-content modal-lg">
            <div class="modal-title">📥 Add / Import Tokens</div>
            
            <!-- Import mode switch tabs -->
            <div class="import-tabs">
                <button class="import-tab active" data-tab="file" onclick="switchImportTab('file')">📁 File Upload</button>
                <button class="import-tab" data-tab="json" onclick="switchImportTab('json')">📝 JSON Input</button>
                <button class="import-tab" data-tab="manual" onclick="switchImportTab('manual')">✏️ Manual Entry</button>
            </div>
            
            <!-- File upload area -->
            <div class="import-tab-content" id="importTabFile">
                <div class="import-dropzone" id="importDropzone">
                    <div class="dropzone-icon">📁</div>
                    <div class="dropzone-text">Drag and drop file here</div>
                    <div class="dropzone-hint">or click to browse</div>
                    <input type="file" id="importFileInput" accept=".json" style="display: none;">
                </div>
                <div class="import-file-info hidden" id="importFileInfo">
                    <div class="file-info-icon">📄</div>
                    <div class="file-info-details">
                        <div class="file-info-name" id="importFileName">-</div>
                        <div class="file-info-meta" id="importFileMeta">-</div>
                    </div>
                    <button class="btn btn-xs btn-secondary" onclick="clearImportFile()">✕</button>
                </div>
            </div>
            
            <!-- Manual JSON input area -->
            <div class="import-tab-content hidden" id="importTabJson">
                <div class="form-group">
                    <label>📝 Paste JSON Content</label>
                    <textarea id="importJsonInput" rows="8" placeholder='{"tokens": [...], "exportTime": "..."}'></textarea>
                </div>
                <div class="import-json-actions">
                    <button class="btn btn-sm btn-info" onclick="parseImportJson()">🔍 Parse JSON</button>
                    <span class="import-json-status" id="importJsonStatus"></span>
                </div>
            </div>
            
            <!-- Manual Token entry area -->
            <div class="import-tab-content hidden" id="importTabManual">
                <div class="form-group">
                    <label>🔑 Access Token <span style="color: var(--danger);">*</span></label>
                    <input type="text" id="manualAccessToken" placeholder="Access Token (required)" autocomplete="off">
                </div>
                <div class="form-group">
                    <label>🔄 Refresh Token <span style="color: var(--danger);">*</span></label>
                    <input type="text" id="manualRefreshToken" placeholder="Refresh Token (required)" autocomplete="off">
                </div>
                <div class="form-group">
                    <label>📁 Project ID</label>
                    <div style="display: flex; gap: 0.5rem;">
                        <input type="text" id="manualProjectId" placeholder="Project ID (optional, auto-fetched if blank)" style="flex: 1;" autocomplete="off">
                        <button class="btn btn-sm btn-info" id="fetchProjectIdBtn" onclick="fetchProjectIdForManual()" style="white-space: nowrap;">🔍 Auto Fetch</button>
                    </div>
                    <p style="font-size: 0.75rem; color: var(--text-light); margin-top: 0.25rem;">💡 Enter manually, or fill in the tokens and click "Auto Fetch"</p>
                </div>
                <div class="form-group">
                    <label>⏱️ Expires In (seconds)</label>
                    <input type="number" id="manualExpiresIn" placeholder="Expires In (seconds)" value="3599" autocomplete="off">
                </div>
                <p style="font-size: 0.8rem; color: var(--text-light); margin-bottom: 0.5rem;">💡 Default expiry is 3599 seconds (~1 hour). Manual entry does not require password verification</p>
            </div>
            
            <!-- Import mode (shown only for file upload and JSON import) -->
            <div class="form-group" id="importModeGroup">
                <label>Import Mode</label>
                <select id="importMode">
                    <option value="merge">Merge (keep existing, add new)</option>
                    <option value="replace">Replace (clear existing, import new)</option>
                </select>
            </div>
            
            <!-- Password verification (shown only for file upload and JSON import) -->
            <div class="form-group" id="importPasswordGroup">
                <label>🔐 Admin Password</label>
                <input type="password" id="importPassword" placeholder="Enter admin password to verify">
            </div>
            
            <div class="modal-actions">
                <button class="btn btn-secondary" onclick="closeImportModal()">Cancel</button>
                <button class="btn btn-success" id="confirmImportBtn" onclick="confirmImportFromModal()" disabled>✅ Confirm</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    // Initialize active tab
    currentImportTab = 'file';

    // Bind events (keep references for cleanup)
    const dropzone = document.getElementById('importDropzone');
    const fileInput = document.getElementById('importFileInput');
    const manualAccessToken = document.getElementById('manualAccessToken');
    const manualRefreshToken = document.getElementById('manualRefreshToken');

    // Common bindings: dropzone + backdrop click close
    const cleanupDropzone = (typeof wireJsonFileDropzone === 'function')
        ? wireJsonFileDropzone({
            dropzone,
            fileInput,
            onFile: (file) => handleImportFile(file),
            onError: (message) => showToast(message, 'warning')
        })
        : null;
    const cleanupBackdrop = (typeof wireModalBackdropClose === 'function')
        ? wireModalBackdropClose(modal, closeImportModal)
        : null;

    // Create event handlers
    const handlers = {
        updateManualBtnState: () => {
            if (currentImportTab === 'manual') {
                const confirmBtn = document.getElementById('confirmImportBtn');
                confirmBtn.disabled = !manualAccessToken.value.trim() || !manualRefreshToken.value.trim();
            }
        }
    };

    // Save handler references
    importModalHandlers = {
        modal,
        dropzone,
        fileInput,
        manualAccessToken,
        manualRefreshToken,
        handlers,
        cleanup: () => {
            try { cleanupDropzone && cleanupDropzone(); } catch { /* ignore */ }
            try { cleanupBackdrop && cleanupBackdrop(); } catch { /* ignore */ }
        }
    };

    // Bind events (manual entry mode keeps existing logic)
    manualAccessToken.addEventListener('input', handlers.updateManualBtnState);
    manualRefreshToken.addEventListener('input', handlers.updateManualBtnState);
}

// Switch import mode tab
function switchImportTab(tab) {
    currentImportTab = tab;

    // Update tab active states
    document.querySelectorAll('.import-tab').forEach(t => t.classList.remove('active'));
    document.querySelector(`.import-tab[data-tab="${tab}"]`).classList.add('active');

    // Toggle tab content visibility
    document.getElementById('importTabFile').classList.toggle('hidden', tab !== 'file');
    document.getElementById('importTabJson').classList.toggle('hidden', tab !== 'json');
    document.getElementById('importTabManual').classList.toggle('hidden', tab !== 'manual');

    // Toggle import mode and password input visibility
    const importModeGroup = document.getElementById('importModeGroup');
    const importPasswordGroup = document.getElementById('importPasswordGroup');
    const confirmBtn = document.getElementById('confirmImportBtn');

    if (tab === 'manual') {
        // Manual entry mode: hide import mode and password
        importModeGroup.classList.add('hidden');
        importPasswordGroup.classList.add('hidden');
        // Update button state
        const accessToken = document.getElementById('manualAccessToken').value.trim();
        const refreshToken = document.getElementById('manualRefreshToken').value.trim();
        confirmBtn.disabled = !accessToken || !refreshToken;
        confirmBtn.textContent = '✅ Add';
    } else {
        // File upload or JSON import mode: show import mode and password
        importModeGroup.classList.remove('hidden');
        importPasswordGroup.classList.remove('hidden');
        confirmBtn.textContent = '✅ Confirm Import';

        // Clear previous inputs
        if (tab === 'file') {
            // Switching to file upload: clear JSON and manual inputs
            document.getElementById('importJsonInput').value = '';
            document.getElementById('importJsonStatus').textContent = '';
            document.getElementById('manualAccessToken').value = '';
            document.getElementById('manualRefreshToken').value = '';
            document.getElementById('manualExpiresIn').value = '3599';
            // Button state depends on selected file
            confirmBtn.disabled = !pendingImportData;
        } else if (tab === 'json') {
            // Switching to JSON input: clear file selection and manual inputs
            clearImportFile();
            document.getElementById('manualAccessToken').value = '';
            document.getElementById('manualRefreshToken').value = '';
            document.getElementById('manualExpiresIn').value = '3599';
            // Button state depends on parsed JSON
            confirmBtn.disabled = !pendingImportData;
        }
    }
}

// Smart field lookup (case-insensitive substring match)
function findFieldByKeyword(obj, keyword) {
    if (!obj || typeof obj !== 'object') return undefined;
    const lowerKeyword = keyword.toLowerCase();
    for (const key of Object.keys(obj)) {
        if (key.toLowerCase().includes(lowerKeyword)) {
            return obj[key];
        }
    }
    return undefined;
}

function normalizeImportedTextValue(value) {
    if (value === null || value === undefined) return undefined;
    if (typeof value === 'string') {
        const trimmed = value.trim();
        return trimmed || undefined;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
        return String(value);
    }
    return undefined;
}

function normalizeImportedProjectId(value) {
    if (value === null || value === undefined) return undefined;
    if (typeof value === 'object') {
        return normalizeImportedProjectId(value.id ?? value.projectId ?? value.name);
    }
    return normalizeImportedTextValue(value);
}

function parseImportedEnable(rawToken) {
    let enable = findFieldByKeyword(rawToken, 'enable');
    if (enable === undefined) enable = findFieldByKeyword(rawToken, 'enabled');

    let disabled = findFieldByKeyword(rawToken, 'disable');
    if (disabled === undefined) disabled = findFieldByKeyword(rawToken, 'disabled');

    if (enable === undefined && disabled !== undefined) {
        return !normalizeTruthyBoolean(disabled);
    }

    if (enable === undefined) return true;
    return normalizeTruthyBoolean(enable);
}

// Smart parse a single Token object
function smartParseToken(rawToken) {
    if (!rawToken || typeof rawToken !== 'object') return null;

    const refresh_token = normalizeImportedTextValue(findFieldByKeyword(rawToken, 'refresh'));

    if (!refresh_token) return null;

    const token = { refresh_token };

    const projectId = normalizeImportedProjectId(findFieldByKeyword(rawToken, 'project'));
    const access_token = normalizeImportedTextValue(findFieldByKeyword(rawToken, 'access') || rawToken.token);
    const email = normalizeImportedTextValue(findFieldByKeyword(rawToken, 'email') || findFieldByKeyword(rawToken, 'mail'));
    const expires_in = findFieldByKeyword(rawToken, 'expires') || findFieldByKeyword(rawToken, 'expire');
    const timestamp = findFieldByKeyword(rawToken, 'time') || findFieldByKeyword(rawToken, 'stamp') || findFieldByKeyword(rawToken, 'created');
    const expiry = findFieldByKeyword(rawToken, 'expiry') || findFieldByKeyword(rawToken, 'expiresat');
    const hasQuota = findFieldByKeyword(rawToken, 'quota');
    const sub = normalizeImportedTextValue(findFieldByKeyword(rawToken, 'subscription') || findFieldByKeyword(rawToken, 'tier') || rawToken.sub);
    const credits = findFieldByKeyword(rawToken, 'credit');

    if (projectId) token.projectId = projectId;
    if (access_token) token.access_token = access_token;
    if (email) token.email = email;

    const derived = deriveExpiresInAndTimestamp({ expires_in, expiry, timestamp });
    token.expires_in = derived.expires_in;
    token.timestamp = derived.timestamp;
    token.enable = parseImportedEnable(rawToken);

    if (hasQuota !== undefined) token.hasQuota = normalizeTruthyBoolean(hasQuota);
    if (sub) token.sub = sub;
    if (credits !== undefined && credits !== null && String(credits).trim() !== '') {
        const parsedCredits = Number(credits);
        if (Number.isFinite(parsedCredits)) {
            token.credits = parsedCredits;
        }
    }

    return token;
}

// Smart parse imported data (supports multiple formats)
function smartParseImportData(jsonText) {
    let data;
    let cleanText = jsonText.trim();

    // Preprocess: remove trailing commas (common JSON formatting issue)
    cleanText = cleanText.replace(/,(\s*[}\]])/g, '$1');

    try {
        data = JSON.parse(cleanText);
    } catch (e) {
        // Try handling multiple concatenated JSON objects without an enclosing array
        try {
            // Wrap multiple objects into an array
            // Match }{ or }\n{ and replace with },{
            const arrayText = '[' + cleanText.replace(/\}\s*\{/g, '},{') + ']';
            data = JSON.parse(arrayText);
        } catch (e2) {
            return { success: false, message: `JSON parse error: ${e.message}` };
        }
    }

    // Detect data structure: array or array nested in an object
    let tokensArray = [];
    if (Array.isArray(data)) {
        tokensArray = data;
    } else if (typeof data === 'object' && data !== null) {
        // Find any property containing an array
        for (const key of Object.keys(data)) {
            if (Array.isArray(data[key])) {
                tokensArray = data[key];
                break;
            }
        }
        // If no array found, try parsing as a single token
        if (tokensArray.length === 0) {
            const single = smartParseToken(data);
            if (single) tokensArray = [data];
        }
    }

    if (tokensArray.length === 0) {
        return { success: false, message: 'No valid data found; ensure at least refresh_token is included' };
    }

    // Parse each token
    const validTokens = [];
    let invalidCount = 0;
    for (const raw of tokensArray) {
        const parsed = smartParseToken(raw);
        if (parsed) {
            validTokens.push(parsed);
        } else {
            invalidCount++;
        }
    }

    if (validTokens.length === 0) {
        return { success: false, message: `All ${tokensArray.length} entries are missing the required field (refresh_token)` };
    }

    const message = invalidCount > 0
        ? `Parsed: ${validTokens.length} valid, ${invalidCount} invalid`
        : `Parsed: ${validTokens.length} Token(s)`;

    return { success: true, tokens: validTokens, message };
}

// Parse manually entered JSON
function parseImportJson() {
    const jsonInput = document.getElementById('importJsonInput');
    const statusEl = document.getElementById('importJsonStatus');
    const confirmBtn = document.getElementById('confirmImportBtn');

    const jsonText = jsonInput.value.trim();
    if (!jsonText) {
        statusEl.textContent = '❌ Please enter JSON content';
        statusEl.className = 'import-json-status error';
        pendingImportData = null;
        confirmBtn.disabled = true;
        return;
    }

    const result = smartParseImportData(jsonText);

    if (result.success) {
        // Store pending import data (normalized to standard format)
        pendingImportData = { tokens: result.tokens };
        statusEl.textContent = `✅ ${result.message}`;
        statusEl.className = 'import-json-status success';
        confirmBtn.disabled = false;
    } else {
        statusEl.textContent = `❌ ${result.message}`;
        statusEl.className = 'import-json-status error';
        pendingImportData = null;
        confirmBtn.disabled = true;
    }
}

// Pending data to import
let pendingImportData = null;

// Handle uploaded import file (using smart parser)
async function handleImportFile(file) {
    try {
        const text = await file.text();
        const result = smartParseImportData(text);

        if (!result.success) {
            showToast(result.message, 'error');
            return;
        }

        // Store pending import data (normalized to standard format)
        pendingImportData = { tokens: result.tokens };

        // Update UI to show file details
        const dropzone = document.getElementById('importDropzone');
        const fileInfo = document.getElementById('importFileInfo');
        const fileName = document.getElementById('importFileName');
        const fileMeta = document.getElementById('importFileMeta');
        const confirmBtn = document.getElementById('confirmImportBtn');

        dropzone.classList.add('hidden');
        fileInfo.classList.remove('hidden');
        fileName.textContent = file.name;
        fileMeta.textContent = result.message;
        confirmBtn.disabled = false;

    } catch (error) {
        showToast('Failed to read file: ' + error.message, 'error');
    }
}

// Clear selected file
function clearImportFile() {
    pendingImportData = null;

    const dropzone = document.getElementById('importDropzone');
    const fileInfo = document.getElementById('importFileInfo');
    const fileInput = document.getElementById('importFileInput');
    const confirmBtn = document.getElementById('confirmImportBtn');

    dropzone.classList.remove('hidden');
    fileInfo.classList.add('hidden');
    fileInput.value = '';
    confirmBtn.disabled = true;
}

// Close import modal
function closeImportModal() {
    // Clean up event listeners
    if (importModalHandlers) {
        const { manualAccessToken, manualRefreshToken, handlers, cleanup } = importModalHandlers;

        // Unified cleanup (dropzone, backdrop, etc.)
        if (typeof cleanup === 'function') {
            try { cleanup(); } catch { /* ignore */ }
        } else {
            // Legacy fallback cleanup
            const { modal, dropzone, fileInput } = importModalHandlers;
            if (dropzone && handlers) {
                if (handlers.dropzoneClick) dropzone.removeEventListener('click', handlers.dropzoneClick);
                if (handlers.dragover) dropzone.removeEventListener('dragover', handlers.dragover);
                if (handlers.dragleave) dropzone.removeEventListener('dragleave', handlers.dragleave);
                if (handlers.drop) dropzone.removeEventListener('drop', handlers.drop);
            }
            if (fileInput && handlers?.fileChange) {
                fileInput.removeEventListener('change', handlers.fileChange);
            }
            if (modal && handlers?.modalClick) {
                modal.removeEventListener('click', handlers.modalClick);
            }
        }

        // Unbind manual entry listeners
        if (manualAccessToken && handlers?.updateManualBtnState) {
            manualAccessToken.removeEventListener('input', handlers.updateManualBtnState);
        }
        if (manualRefreshToken && handlers?.updateManualBtnState) {
            manualRefreshToken.removeEventListener('input', handlers.updateManualBtnState);
        }

        importModalHandlers = null;
    }

    const modal = document.getElementById('importUploadModal');
    if (modal) {
        modal.remove();
    }
    pendingImportData = null;
}

// Confirm import or manual add from modal
async function confirmImportFromModal() {
    // Manual entry mode
    if (currentImportTab === 'manual') {
        const accessToken = document.getElementById('manualAccessToken').value.trim();
        const refreshToken = document.getElementById('manualRefreshToken').value.trim();
        const projectId = document.getElementById('manualProjectId').value.trim();
        const expiresIn = parseInt(document.getElementById('manualExpiresIn').value) || 3599;

        if (!accessToken || !refreshToken) {
            showToast('Please fill in all required Token fields', 'warning');
            return;
        }

        showLoading('Adding Token...');
        try {
            const tokenData = { access_token: accessToken, refresh_token: refreshToken, expires_in: expiresIn };
            if (projectId) {
                tokenData.projectId = projectId;
            }
            const response = await authFetch('/admin/tokens', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(tokenData)
            });

            const data = await response.json();
            hideLoading();

            if (data.success) {
                closeImportModal();
                showToast('Token added successfully', 'success');
                loadTokens();
            } else {
                showToast(data.message || 'Failed to add', 'error');
            }
        } catch (error) {
            hideLoading();
            showToast('Failed to add: ' + error.message, 'error');
        }
        return;
    }

    // File upload or JSON import mode
    if (!pendingImportData) {
        showToast('Please select a file or parse JSON first', 'warning');
        return;
    }

    const mode = document.getElementById('importMode').value;
    const password = document.getElementById('importPassword').value;

    if (!password) {
        showToast('Please enter the admin password', 'warning');
        return;
    }

    showLoading('Importing...');
    try {
        const response = await authFetch('/admin/tokens/import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password, data: pendingImportData, mode })
        });

        const data = await response.json();
        hideLoading();

        if (data.success) {
            closeImportModal();
            showToast(data.message, 'success');
            loadTokens();
        } else {
            // Show specific message when password is wrong
            if (response.status === 403) {
                showToast('Incorrect password, please try again', 'error');
            } else {
                showToast(data.message || 'Import failed', 'error');
            }
        }
    } catch (error) {
        hideLoading();
        showToast('Import failed: ' + error.message, 'error');
    }
}

// Password prompt dialog
function showPasswordPrompt(message) {
    return new Promise((resolve) => {
        const modal = document.createElement('div');
        modal.className = 'modal form-modal';
        modal.innerHTML = `
            <div class="modal-content">
                <div class="modal-title">🔐 Password Verification</div>
                <p>${message}</p>
                <div class="form-group">
                    <input type="password" id="promptPassword" placeholder="Enter password">
                </div>
                <div class="modal-actions">
                    <button class="btn btn-secondary" id="promptCancelBtn">Cancel</button>
                    <button class="btn btn-success" id="promptConfirmBtn">Confirm</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        const passwordInput = document.getElementById('promptPassword');
        const confirmBtn = document.getElementById('promptConfirmBtn');
        const cancelBtn = document.getElementById('promptCancelBtn');

        // Cleanup function
        const cleanup = () => {
            confirmBtn.removeEventListener('click', handleConfirm);
            cancelBtn.removeEventListener('click', handleCancel);
            passwordInput.removeEventListener('keydown', handleKeydown);
            modal.removeEventListener('click', handleModalClick);
            modal.remove();
        };

        const handleConfirm = () => {
            const password = passwordInput.value;
            cleanup();
            resolve(password || null);
        };

        const handleCancel = () => {
            cleanup();
            resolve(null);
        };

        const handleKeydown = (e) => {
            if (e.key === 'Enter') {
                handleConfirm();
            } else if (e.key === 'Escape') {
                handleCancel();
            }
        };

        const handleModalClick = (e) => {
            if (e.target === modal) {
                cleanup();
                resolve(null);
            }
        };

        confirmBtn.addEventListener('click', handleConfirm);
        cancelBtn.addEventListener('click', handleCancel);
        passwordInput.addEventListener('keydown', handleKeydown);
        modal.addEventListener('click', handleModalClick);

        passwordInput.focus();
    });
}

// Manually toggle action bar visibility (exposed globally)
window.toggleActionBar = function () {
    const actionBar = document.getElementById('actionBar');
    const toggleBtn = document.getElementById('actionToggleBtn');

    if (!actionBar || !toggleBtn) return;

    actionBarCollapsed = !actionBarCollapsed;
    localStorage.setItem('actionBarCollapsed', actionBarCollapsed);

    if (actionBarCollapsed) {
        actionBar.classList.add('collapsed');
        toggleBtn.classList.add('collapsed');
        toggleBtn.title = 'Expand action buttons';
    } else {
        actionBar.classList.remove('collapsed');
        toggleBtn.classList.remove('collapsed');
        toggleBtn.title = 'Collapse action buttons';
    }
}

// Initialize action bar state (restore saved collapsed/expanded state)
function initActionBarState() {
    const actionBar = document.getElementById('actionBar');
    const toggleBtn = document.getElementById('actionToggleBtn');

    if (!actionBar || !toggleBtn) return;

    // Restore saved state
    if (actionBarCollapsed) {
        actionBar.classList.add('collapsed');
        toggleBtn.classList.add('collapsed');
        toggleBtn.title = 'Expand action buttons';
    }
}

// Initialize on page load
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initActionBarState);
} else {
    initActionBarState();
}

// Initialize filter state
function initFilterState() {
    const savedFilter = localStorage.getItem('tokenFilter') || 'all';
    currentFilter = savedFilter;
    updateFilterButtonState(savedFilter);
}

// Update filter button active state
function updateFilterButtonState(filter) {
    document.querySelectorAll('.stat-item').forEach(item => {
        item.classList.remove('active');
    });
    const filterMap = { 'all': 'totalTokens', 'enabled': 'enabledTokens', 'disabled': 'disabledTokens' };
    const activeElement = document.getElementById(filterMap[filter]);
    if (activeElement) {
        activeElement.closest('.stat-item').classList.add('active');
    }
}

// Filter tokens
function filterTokens(filter) {
    currentFilter = filter;
    localStorage.setItem('tokenFilter', filter); // Persist filter state

    updateFilterButtonState(filter);

    // Re-render
    renderTokens(cachedTokens);
}

async function loadTokens() {
    try {
        const response = await authFetch('/admin/tokens');

        const data = await response.json();
        if (data.success) {
            renderTokens(data.data);
        } else {
            showToast('Failed to load: ' + (data.message || 'Unknown error'), 'error');
        }
    } catch (error) {
        showToast('Failed to load Tokens: ' + error.message, 'error');
    }
}

// Set of currently refreshing tokens (keyed by tokenId)
const refreshingTokens = new Set();

// Cap refreshingTokens set size to prevent memory leaks
function cleanupRefreshingTokens() {
    // Clear if too large (normally shouldn't have too many concurrent refreshes)
    if (refreshingTokens.size > 100) {
        refreshingTokens.clear();
    }
}

function renderTokens(tokens) {
    // Only update cache when a new array is provided
    if (tokens !== cachedTokens) {
        cachedTokens = tokens;
    }

    document.getElementById('totalTokens').textContent = tokens.length;
    document.getElementById('enabledTokens').textContent = tokens.filter(t => t.enable).length;
    document.getElementById('disabledTokens').textContent = tokens.filter(t => !t.enable).length;

    // Filter according to current filter setting
    let filteredTokens = tokens;
    if (currentFilter === 'enabled') {
        filteredTokens = tokens.filter(t => t.enable);
    } else if (currentFilter === 'disabled') {
        filteredTokens = tokens.filter(t => !t.enable);
    }

    const tokenList = document.getElementById('tokenList');
    if (filteredTokens.length === 0) {
        const emptyText = currentFilter === 'all' ? 'No Tokens' :
            currentFilter === 'enabled' ? 'No Enabled Tokens' : 'No Disabled Tokens';
        const emptyHint = currentFilter === 'all' ? 'Click the OAuth button above to add a Token' : 'Click "Total" above to view all';
        tokenList.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">📦</div>
                <div class="empty-state-text">${emptyText}</div>
                <div class="empty-state-hint">${emptyHint}</div>
            </div>
        `;
        return;
    }

    tokenList.innerHTML = filteredTokens.map((token, index) => {
        // Use safe tokenId instead of refresh_token
        const tokenId = token.id;
        const isRefreshing = refreshingTokens.has(tokenId);
        const cardId = tokenId.substring(0, 8);

        // Compute 1-based index in the original list (by insertion order)
        const originalIndex = cachedTokens.findIndex(t => t.id === token.id);
        const tokenNumber = originalIndex + 1;

        // Escape all user data to prevent XSS
        const safeTokenId = escapeJs(tokenId);
        const safeProjectId = escapeHtml(token.projectId || '');
        const safeEmail = escapeHtml(token.email || '');
        const safeProjectIdJs = escapeJs(token.projectId || '');
        const safeEmailJs = escapeJs(token.email || '');

        return `
        <div class="token-card ${!token.enable ? 'disabled' : ''} ${isRefreshing ? 'refreshing' : ''} ${skipAnimation ? 'no-animation' : ''}" id="card-${escapeHtml(cardId)}">
            <div class="token-header">
                <div class="token-header-left">
                    <span class="status ${token.enable ? 'enabled' : 'disabled'}">
                        ${token.enable ? '✅ Enabled' : '❌ Disabled'}
                    </span>
                    ${token.sub ? `<span class="status-subscription subscription-badge ${token.sub === 'free-tier' ? 'free-tier' : 'paid-tier'}" title="${escapeHtml(token.sub)}">${escapeHtml(formatSubTier(token.sub))}</span>` : ''}
                    <span class="status-credits ${token.credits !== null && token.credits !== undefined ? (Number(token.credits) <= 0 ? 'credits-empty' : '') : 'no-credits'}" title="${token.credits !== null && token.credits !== undefined ? 'Remaining Credits: ' + formatCredits(token.credits) : 'No credits info'}">🪙 ${formatCredits(token.credits)}</span>
                    <button class="btn-icon token-refresh-btn ${isRefreshing ? 'loading' : ''}" id="refresh-btn-${escapeHtml(cardId)}" onclick="manualRefreshToken('${safeTokenId}')" title="Refresh Token" ${isRefreshing ? 'disabled' : ''}>🔄</button>
                </div>
                <div class="token-header-right">
                    <button class="btn-icon" onclick="showTokenDetail('${safeTokenId}')" title="Edit">✏️</button>
                    <span class="token-id">#${tokenNumber}</span>
                </div>
            </div>
            <div class="token-info">
                <div class="info-row editable sensitive-row" onclick="editField(event, '${safeTokenId}', 'projectId', '${safeProjectIdJs}')" title="Click to edit">
                    <span class="info-label">📦</span>
                    <span class="info-value sensitive-info">${safeProjectId || 'Click to set'}</span>
                    <span class="info-edit-icon">✏️</span>
                    <button class="btn btn-xs btn-info fetch-project-btn" onclick="fetchProjectId(event, '${safeTokenId}')" title="Fetch Project ID from API">🔍</button>
                </div>
                <div class="info-row editable sensitive-row" onclick="editField(event, '${safeTokenId}', 'email', '${safeEmailJs}')" title="Click to edit">
                    <span class="info-label">📧</span>
                    <span class="info-value sensitive-info">${safeEmail || 'Click to set'}</span>
                    <span class="info-edit-icon">✏️</span>
                </div>
            </div>
            <div class="token-id-row" title="Token ID: ${escapeHtml(tokenId)}">
                <span class="token-id-label">🔑</span>
                <span class="token-id-value">${escapeHtml(tokenId.length > 24 ? tokenId.substring(0, 12) + '...' + tokenId.substring(tokenId.length - 8) : tokenId)}</span>
            </div>
            <div class="token-quota-inline" id="quota-inline-${escapeHtml(cardId)}">
                <div class="quota-inline-header" onclick="toggleQuotaExpand('${escapeJs(cardId)}', '${safeTokenId}')">
                    <span class="quota-inline-summary" id="quota-summary-${escapeHtml(cardId)}">📊 Loading...</span>
                    <span class="quota-inline-toggle" id="quota-toggle-${escapeHtml(cardId)}">▼</span>
                </div>
                <div class="quota-inline-detail hidden" id="quota-detail-${escapeHtml(cardId)}"></div>
            </div>
            <div class="token-actions">
                <button class="btn btn-info btn-xs" onclick="showQuotaModal('${safeTokenId}')" title="View Quota">📊 Details</button>
                <button class="btn ${token.enable ? 'btn-warning' : 'btn-success'} btn-xs" onclick="toggleToken('${safeTokenId}', ${!token.enable})" title="${token.enable ? 'Disable' : 'Enable'}">
                    ${token.enable ? '⏸️ Disable' : '▶️ Enable'}
                </button>
                <button class="btn btn-danger btn-xs" onclick="deleteToken('${safeTokenId}')" title="Delete">🗑️ Delete</button>
            </div>
        </div>
    `}).join('');

    filteredTokens.forEach(token => {
        loadTokenQuotaSummary(token.id);
    });

    updateSensitiveInfoDisplay();

    // Reset skip-animation flag
    skipAnimation = false;
}

// Manually refresh a Token (by tokenId)
async function manualRefreshToken(tokenId) {
    if (refreshingTokens.has(tokenId)) {
        showToast('This Token is already refreshing', 'warning');
        return;
    }
    await autoRefreshToken(tokenId);
}

// Refresh specified Token (manually triggered, by tokenId)
async function autoRefreshToken(tokenId) {
    if (refreshingTokens.has(tokenId)) return;

    refreshingTokens.add(tokenId);
    const cardId = tokenId.substring(0, 8);

    // Update UI to show refreshing state
    const card = document.getElementById(`card-${cardId}`);
    const refreshBtn = document.getElementById(`refresh-btn-${cardId}`);
    if (card) {
        card.classList.remove('refresh-failed');
        card.classList.add('refreshing');
    }
    if (refreshBtn) {
        refreshBtn.disabled = true;
        refreshBtn.classList.add('loading');
        refreshBtn.textContent = '🔄';
    }

    try {
        const response = await authFetch(`/admin/tokens/${encodeURIComponent(tokenId)}/refresh`, {
            method: 'POST'
        });

        const data = await response.json();
        if (data.success) {
            showToast('Token refreshed', 'success');
            // Reload list after refresh succeeds
            refreshingTokens.delete(tokenId);
            if (card) card.classList.remove('refreshing');
            if (refreshBtn) {
                refreshBtn.disabled = false;
                refreshBtn.classList.remove('loading');
                refreshBtn.textContent = '🔄';
            }
            loadTokens();
        } else {
            showToast(`Token refresh failed: ${data.message || 'Unknown error'}`, 'error');
            refreshingTokens.delete(tokenId);
            // Update UI to show refresh failure
            if (card) {
                card.classList.remove('refreshing');
                card.classList.add('refresh-failed');
            }
            if (refreshBtn) {
                refreshBtn.disabled = false;
                refreshBtn.classList.remove('loading');
                refreshBtn.textContent = '🔄';
            }
        }
    } catch (error) {
        if (error.message !== 'Unauthorized') {
            showToast(`Token refresh failed: ${error.message}`, 'error');
        }
        refreshingTokens.delete(tokenId);
        // Update UI to show refresh failure
        if (card) {
            card.classList.remove('refreshing');
            card.classList.add('refresh-failed');
        }
        if (refreshBtn) {
            refreshBtn.disabled = false;
            refreshBtn.classList.remove('loading');
            refreshBtn.textContent = '🔄';
        }
    }
}

// showManualModal has been merged into showImportUploadModal
function showManualModal() {
    // Open import modal and switch to manual entry tab
    showImportUploadModal();
    // Defer tab switch to ensure DOM is rendered
    setTimeout(() => switchImportTab('manual'), 0);
}

function editField(event, tokenId, field, currentValue) {
    event.stopPropagation();
    const row = event.currentTarget;
    const valueSpan = row.querySelector('.info-value');

    if (row.querySelector('input')) return;

    const fieldLabels = { projectId: 'Project ID', email: 'Email' };

    const input = document.createElement('input');
    input.type = field === 'email' ? 'email' : 'text';
    input.value = currentValue;
    input.className = 'inline-edit-input';
    input.placeholder = `Enter ${fieldLabels[field]}`;

    valueSpan.style.display = 'none';
    row.insertBefore(input, valueSpan.nextSibling);
    input.focus();
    input.select();

    const save = async () => {
        const newValue = input.value.trim();
        input.disabled = true;

        try {
            const response = await authFetch(`/admin/tokens/${encodeURIComponent(tokenId)}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ [field]: newValue })
            });

            const data = await response.json();
            if (data.success) {
                showToast('Saved', 'success');
                loadTokens();
            } else {
                showToast(data.message || 'Failed to save', 'error');
                cancel();
            }
        } catch (error) {
            showToast('Failed to save', 'error');
            cancel();
        }
    };

    const cancel = () => {
        input.remove();
        valueSpan.style.display = '';
    };

    input.addEventListener('blur', () => {
        setTimeout(() => {
            if (document.activeElement !== input) {
                if (input.value.trim() !== currentValue) {
                    save();
                } else {
                    cancel();
                }
            }
        }, 100);
    });

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            save();
        } else if (e.key === 'Escape') {
            cancel();
        }
    });
}

function showTokenDetail(tokenId) {
    const token = cachedTokens.find(t => t.id === tokenId);
    if (!token) {
        showToast('Token not found', 'error');
        return;
    }

    // Escape all user data to prevent XSS
    const safeTokenId = escapeJs(tokenId);
    const safeProjectId = escapeHtml(token.projectId || '');
    const safeEmail = escapeHtml(token.email || '');
    const updatedAtStr = escapeHtml(token.timestamp ? new Date(token.timestamp).toLocaleString('en-US') : 'Unknown');

    const modal = document.createElement('div');
    modal.className = 'modal form-modal';
    modal.innerHTML = `
        <div class="modal-content">
            <div class="modal-title">📝 Token Details</div>
            <div class="form-group compact">
                <label>🔑 Token ID</label>
                <div class="token-display">${escapeHtml(tokenId)}</div>
            </div>
            <div class="form-group compact">
                <label>📦 Project ID</label>
                <input type="text" id="editProjectId" value="${safeProjectId}" placeholder="Project ID">
            </div>
            <div class="form-group compact">
                <label>📧 Email</label>
                <input type="email" id="editEmail" value="${safeEmail}" placeholder="Account email">
            </div>
            <div class="form-group compact">
                <label>🕒 Last Updated</label>
                <input type="text" value="${updatedAtStr}" readonly style="background: var(--bg); cursor: not-allowed;">
            </div>
            <div class="modal-actions">
                <button class="btn btn-secondary" onclick="this.closest('.modal').remove()">Cancel</button>
                <button class="btn btn-success" onclick="saveTokenDetail('${safeTokenId}')">💾 Save</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
}

async function saveTokenDetail(tokenId) {
    const projectId = document.getElementById('editProjectId').value.trim();
    const email = document.getElementById('editEmail').value.trim();

    showLoading('Saving...');
    try {
        const response = await authFetch(`/admin/tokens/${encodeURIComponent(tokenId)}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ projectId, email })
        });

        const data = await response.json();
        hideLoading();
        if (data.success) {
            document.querySelector('.form-modal').remove();
            showToast('Saved successfully', 'success');
            loadTokens();
        } else {
            showToast(data.message || 'Failed to save', 'error');
        }
    } catch (error) {
        hideLoading();
        showToast('Failed to save: ' + error.message, 'error');
    }
}

async function toggleToken(tokenId, enable) {
    const action = enable ? 'Enable' : 'Disable';
    const confirmed = await showConfirm(`Are you sure you want to ${action.toLowerCase()} this Token?`, `Confirm ${action}`);
    if (!confirmed) return;

    showLoading(`${enable ? 'Enabling' : 'Disabling'}...`);
    try {
        const response = await authFetch(`/admin/tokens/${encodeURIComponent(tokenId)}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ enable })
        });

        const data = await response.json();
        hideLoading();
        if (data.success) {
            showToast(data.message || (enable ? 'Enabled' : 'Disabled'), data.syncedCredits === false ? 'warning' : 'success');
            skipAnimation = true; // Skip animation
            loadTokens();
        } else {
            showToast(data.message || 'Operation failed', 'error');
        }
    } catch (error) {
        hideLoading();
        showToast('Operation failed: ' + error.message, 'error');
    }
}

async function deleteToken(tokenId) {
    const confirmed = await showConfirm('Deleted tokens cannot be recovered. Are you sure?', '⚠️ Confirm Delete');
    if (!confirmed) return;

    showLoading('Deleting...');
    try {
        const response = await authFetch(`/admin/tokens/${encodeURIComponent(tokenId)}`, {
            method: 'DELETE'
        });

        const data = await response.json();
        hideLoading();
        if (data.success) {
            showToast('Deleted', 'success');
            loadTokens();
        } else {
            showToast(data.message || 'Delete failed', 'error');
        }
    } catch (error) {
        hideLoading();
        showToast('Delete failed: ' + error.message, 'error');
    }
}

// Auto-fetch Project ID in the manual entry form
async function fetchProjectIdForManual() {
    const accessToken = document.getElementById('manualAccessToken').value.trim();
    const refreshToken = document.getElementById('manualRefreshToken').value.trim();

    if (!accessToken || !refreshToken) {
        showToast('Please enter Access Token and Refresh Token first', 'warning');
        return;
    }

    const btn = document.getElementById('fetchProjectIdBtn');
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = '⏳ Fetching...';

    try {
        // Temporarily add the Token first, then fetch its Project ID
        const addResponse = await authFetch('/admin/tokens', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                access_token: accessToken,
                refresh_token: refreshToken,
                expires_in: 3599
            })
        });

        const addData = await addResponse.json();
        if (!addData.success) {
            throw new Error(addData.message || 'Failed to add Token');
        }

        const tokenId = addData.tokenId;

        // Fetch Project ID
        const fetchResponse = await authFetch(`/admin/tokens/${encodeURIComponent(tokenId)}/fetch-project-id`, {
            method: 'POST'
        });

        const fetchData = await fetchResponse.json();

        if (fetchData.success && fetchData.projectId) {
            document.getElementById('manualProjectId').value = fetchData.projectId;
            showToast(`Fetched: ${fetchData.projectId}`, 'success');

            // Remove the temporarily added Token (user hasn't confirmed yet)
            await authFetch(`/admin/tokens/${encodeURIComponent(tokenId)}`, {
                method: 'DELETE'
            });
        } else {
            // Remove temporary Token
            await authFetch(`/admin/tokens/${encodeURIComponent(tokenId)}`, {
                method: 'DELETE'
            });
            throw new Error(fetchData.message || 'Unable to fetch Project ID for this account');
        }
    } catch (error) {
        showToast('Fetch failed: ' + error.message, 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = originalText;
    }
}
