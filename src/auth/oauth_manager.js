import crypto from 'crypto';
import log from '../utils/logger.js';
import requesterManager from '../utils/requesterManager.js';
import ProjectIdFetcher from './project_id_fetcher.js';
import { OAUTH_CONFIG, OAUTH_SCOPES, GEMINICLI_OAUTH_CONFIG, GEMINICLI_OAUTH_SCOPES } from '../constants/oauth.js';

class OAuthManager {
	constructor() {
		this.state = crypto.randomUUID();
	}

	/**
	 * Generate authorization URL
	 * @param {number} port - Callback port
	 * @param {string} mode - Mode: 'antigravity' or 'geminicli'
	 */
	generateAuthUrl(port, mode = 'antigravity') {
		const oauthConfig = mode === 'geminicli' ? GEMINICLI_OAUTH_CONFIG : OAUTH_CONFIG;
		const scopes = mode === 'geminicli' ? GEMINICLI_OAUTH_SCOPES : OAUTH_SCOPES;

		const params = new URLSearchParams({
			access_type: 'offline',
			client_id: oauthConfig.CLIENT_ID,
			prompt: 'consent',
			redirect_uri: `http://localhost:${port}/oauth-callback`,
			response_type: 'code',
			scope: scopes.join(' '),
			state: `${this.state}_${mode}` // Include mode info in state
		});
		return `${oauthConfig.AUTH_URL}?${params.toString()}`;
	}

	/**
	 * Exchange authorization code for token
	 * @param {string} code - Authorization code
	 * @param {number} port - Callback port
	 * @param {string} mode - Mode: 'antigravity' or 'geminicli'
	 */
	async exchangeCodeForToken(code, port, mode = 'antigravity') {
		const oauthConfig = mode === 'geminicli' ? GEMINICLI_OAUTH_CONFIG : OAUTH_CONFIG;

		const postData = new URLSearchParams({
			code,
			client_id: oauthConfig.CLIENT_ID,
			client_secret: oauthConfig.CLIENT_SECRET,
			redirect_uri: `http://localhost:${port}/oauth-callback`,
			grant_type: 'authorization_code'
		});

		const headers = {
			'Host': 'oauth2.googleapis.com',
			'User-Agent': 'Go-http-client/1.1',
			'Content-Type': 'application/x-www-form-urlencoded',
			'Accept-Encoding': 'gzip'
		};

		try {
			const { data } = await requesterManager.fetch(oauthConfig.TOKEN_URL, {
				method: 'POST',
				headers,
				body: postData.toString(),
			});
			return data;
		} catch (error) {
			throw new Error(`Token exchange request failed (${error.status ?? ''}): ${error.message}`);
		}
	}

	/**
	 * Fetch user email
	 */
	async fetchUserEmail(accessToken) {
		const headers = {
			'Host': 'www.googleapis.com',
			'User-Agent': 'Go-http-client/1.1',
			'Authorization': `Bearer ${accessToken}`,
			'Accept-Encoding': 'gzip'
		};

		try {
			const { data } = await requesterManager.fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
				method: 'GET',
				headers,
			});
			return data?.email;
		} catch (err) {
			log.warn('Failed to fetch user email:', err.message);
			return null;
		}
	}

	/**
	 * Perform full account validation using ProjectIdFetcher
	 * @param {string} accessToken - Access token
	 * @returns {Promise<{projectId: string|null, sub: string, hasQuota: boolean, source: string, isActivated: boolean, credits: number|null}>}
	 */
	async validateAccount(accessToken) {
		const fetcher = new ProjectIdFetcher();
		return await fetcher.validateAccount({ access_token: accessToken });
	}

	/**
	 * Full OAuth authentication flow: exchange token -> fetch email -> validate eligibility
	 * @param {string} code - Authorization code
	 * @param {number} port - Callback port
	 * @param {string} mode - Mode: 'antigravity' or 'geminicli'
	 */
	async authenticate(code, port, mode = 'antigravity') {
		// 1. Exchange authorization code for token
		const tokenData = await this.exchangeCodeForToken(code, port, mode);

		if (!tokenData.access_token) {
			throw new Error('Token exchange failed: access_token not received');
		}

		const account = {
			access_token: tokenData.access_token,
			refresh_token: tokenData.refresh_token,
			expires_in: tokenData.expires_in,
			timestamp: Date.now()
		};

		// 2. Fetch user email
		const email = await this.fetchUserEmail(account.access_token);
		if (email) {
			account.email = email;
			log.info(`[${mode}] Fetched user email: ${email}`);
		}

		// 3. Eligibility validation (only required for antigravity mode)
		if (mode === 'antigravity') {
			const validation = await this.validateAccount(account.access_token);
			
			account.projectId = validation.projectId;
			account.sub = validation.sub;
			account.hasQuota = validation.hasQuota;
			account.isActivated = validation.isActivated;
			
			// Save credits info (only available for subscriptions above free-tier)
			if (validation.credits !== null && validation.credits !== undefined) {
				account.credits = validation.credits;
				log.info(`[${mode}] Account validation completed: sub=${validation.sub}, source=${validation.source}, credits=${validation.credits}`);
			} else {
				log.info(`[${mode}] Account validation completed: sub=${validation.sub}, source=${validation.source}`);
			}
		}

		account.enable = true;

		return account;
	}

	/**
	 * Gemini CLI dedicated authentication flow (simplified, does not require projectId)
	 * @param {string} code - Authorization code
	 * @param {number} port - Callback port
	 */
	async authenticateGeminiCli(code, port) {
		return this.authenticate(code, port, 'GeminiCLI');
	}
}

export default new OAuthManager();
