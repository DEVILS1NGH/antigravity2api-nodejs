// Main entry point: initialization and event binding

// Initialize on page load
initFontSize();
initSensitiveInfo();
initFilterState(); // Restore filter state

// Check login status and initialize
(async function initApp() {
    try {
        // Check if logged in (via Cookie)
        const loggedIn = await checkLoginStatus();
        
        // Verification complete, switch to auth-ready state
        document.documentElement.classList.remove('auth-checking');
        document.documentElement.classList.add('auth-ready');
        
        if (loggedIn) {
            showMainContent();
            // Restore Tab state; switchTab loads corresponding data based on tab type
            const savedTab = localStorage.getItem('currentTab');
            if (savedTab === 'settings') {
                switchTab('settings', false);
            } else if (savedTab === 'logs') {
                switchTab('logs', false);
            } else if (savedTab === 'geminicli') {
                switchTab('geminicli', false);
            } else {
                // Default to tokens page
                switchTab('tokens', false);
            }
        }
    } catch (e) {
        // Switch state even on failure so the login form is displayed
        document.documentElement.classList.remove('auth-checking');
        document.documentElement.classList.add('auth-ready');
    }
})();

// Login form submission
document.getElementById('login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    if (btn.disabled) return;
    
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    
    btn.disabled = true;
    btn.classList.add('loading');
    const originalText = btn.textContent;
    btn.textContent = 'Logging in';
    
    try {
        const response = await fetch('/admin/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ username, password })
        });
        
        const data = await response.json();
        if (data.success) {
            // No longer store token in localStorage; uses HttpOnly Cookie
            showToast('Login successful', 'success');
            showMainContent();
            loadTokens();
            loadConfig();
        } else {
            showToast(data.message || 'Invalid username or password', 'error');
        }
    } catch (error) {
        showToast('Login failed: ' + error.message, 'error');
    } finally {
        btn.disabled = false;
        btn.classList.remove('loading');
        btn.textContent = originalText;
    }
});

// Config form submission
document.getElementById('configForm').addEventListener('submit', saveConfig);
