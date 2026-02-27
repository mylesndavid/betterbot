import { createServer } from 'node:http';
import { URL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getCredential, setCredential } from './credentials.js';

const exec = promisify(execFile);

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/calendar';

// In-memory access token cache
let _accessToken = null;
let _tokenExpires = 0;

/**
 * Exchange an authorization code for tokens.
 */
async function exchangeCode(code, redirectUri) {
  const clientId = await getCredential('google_client_id');
  const clientSecret = await getCredential('google_client_secret');

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });

  const data = await res.json();
  if (data.error) throw new Error(`Token exchange failed: ${data.error_description || data.error}`);
  return data;
}

/**
 * Refresh the access token using the stored refresh token.
 * Caches in memory (~1hr TTL).
 */
export async function refreshAccessToken() {
  // Return cached token if still valid (with 60s margin)
  if (_accessToken && Date.now() < _tokenExpires - 60_000) {
    return _accessToken;
  }

  const clientId = await getCredential('google_client_id');
  const clientSecret = await getCredential('google_client_secret');
  const refreshToken = await getCredential('google_refresh_token');

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Google Calendar not configured. Run: betterbot auth google');
  }

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  const data = await res.json();
  if (data.error) throw new Error(`Token refresh failed: ${data.error_description || data.error}`);

  _accessToken = data.access_token;
  _tokenExpires = Date.now() + (data.expires_in || 3600) * 1000;

  return _accessToken;
}

/**
 * Start the OAuth2 authorization flow.
 * Spins up a localhost HTTP server, opens the browser, handles the callback,
 * exchanges the code for tokens, and stores them in Keychain.
 */
export async function startAuthFlow() {
  const clientId = await getCredential('google_client_id');
  const clientSecret = await getCredential('google_client_secret');

  if (!clientId || !clientSecret) {
    console.log(`\nGoogle OAuth2 Setup
═══════════════════

Before running this command, you need a Google Cloud project with the Calendar API enabled.

1. Go to https://console.cloud.google.com/apis/credentials
2. Create an OAuth 2.0 Client ID (type: Desktop app)
3. Store the credentials:

   betterbot creds set google_client_id YOUR_CLIENT_ID
   betterbot creds set google_client_secret YOUR_CLIENT_SECRET

4. Then run this command again: betterbot auth google
`);
    return;
  }

  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url, `http://localhost:${server.address().port}`);

      if (url.pathname !== '/callback') {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      if (error) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<h2>Authorization failed</h2><p>${error}</p><p>You can close this tab.</p>`);
        server.close();
        reject(new Error(`OAuth denied: ${error}`));
        return;
      }

      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end('<h2>Missing authorization code</h2><p>You can close this tab.</p>');
        return;
      }

      try {
        const redirectUri = `http://localhost:${server.address().port}/callback`;
        const tokens = await exchangeCode(code, redirectUri);

        // Store refresh token in Keychain
        if (tokens.refresh_token) {
          await setCredential('google_refresh_token', tokens.refresh_token);
        }

        // Cache the access token
        _accessToken = tokens.access_token;
        _tokenExpires = Date.now() + (tokens.expires_in || 3600) * 1000;

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h2>Google Calendar connected!</h2><p>You can close this tab and return to the terminal.</p>');
        server.close();

        console.log('\n✓ Google Calendar authorized and tokens stored.');
        resolve();
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end(`<h2>Error</h2><p>${err.message}</p>`);
        server.close();
        reject(err);
      }
    });

    // Listen on random port
    server.listen(0, '127.0.0.1', async () => {
      const port = server.address().port;
      const redirectUri = `http://localhost:${port}/callback`;

      const authUrl = `${GOOGLE_AUTH_URL}?` + new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: SCOPE,
        access_type: 'offline',
        prompt: 'consent',
      });

      console.log(`\nOpening browser for Google authorization...`);
      console.log(`If it doesn't open, visit:\n${authUrl}\n`);

      try {
        await exec('open', [authUrl]);
      } catch {
        // If open fails, user can copy the URL
      }
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      server.close();
      reject(new Error('OAuth flow timed out after 5 minutes'));
    }, 5 * 60 * 1000);
  });
}
