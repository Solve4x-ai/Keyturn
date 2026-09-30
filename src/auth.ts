import { createServer } from 'http';
import { spawn } from 'child_process';
import { URL } from 'url';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { config } from 'dotenv';
import { UserOAuth } from './oauth-user.js';

config({ path: process.env.DOTENV_CONFIG_PATH || '.env' });

const REGION_MAP: Record<string, string> = {
  us: 'https://app.ninjarmm.com',
  us2: 'https://us2.ninjarmm.com',
  eu: 'https://eu.ninjarmm.com',
  ca: 'https://ca.ninjarmm.com',
  oc: 'https://oc.ninjarmm.com',
};

function resolveBaseUrl(): string {
  const envBase = process.env.NINJA_BASE_URL;
  if (envBase) return envBase.replace(/\/$/, '');
  const region = (process.env.NINJA_REGION || '').toLowerCase();
  if (region && REGION_MAP[region]) return REGION_MAP[region];
  throw new Error('Set NINJA_BASE_URL or NINJA_REGION before running auth.');
}

function resolveRedirectUri(): URL {
  const configured = (process.env.NINJA_REDIRECT_URI || '').trim();
  if (!configured) {
    throw new Error(
      'Set NINJA_REDIRECT_URI to the exact loopback redirect expected by the NinjaOne Native application.',
    );
  }
  const redirectUri = new URL(configured);
  const loopbackHosts = new Set(['localhost', '127.0.0.1', '::1']);
  const hostname = redirectUri.hostname.replace(/^\[|\]$/g, '');
  if (redirectUri.protocol !== 'http:' || !loopbackHosts.has(hostname)) {
    throw new Error('NINJA_REDIRECT_URI must use HTTP on localhost, 127.0.0.1, or ::1');
  }
  return redirectUri;
}

function oauthRedirectUriValue(redirectUri: URL): string {
  if (redirectUri.pathname === '/' && !redirectUri.search && !redirectUri.hash) {
    return redirectUri.origin;
  }
  return redirectUri.toString();
}

function base64Url(input: Buffer): string {
  return input.toString('base64url');
}

function stateMatches(expected: string, actual: string | null): boolean {
  if (!actual) return false;
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  return (
    expectedBuffer.length === actualBuffer.length &&
    timingSafeEqual(expectedBuffer, actualBuffer)
  );
}

function openBrowser(url: string): void {
  const platform = process.platform;
  if (platform === 'win32') {
    spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], {
      detached: true,
      stdio: 'ignore',
    }).unref();
  } else if (platform === 'darwin') {
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  }
}

async function receiveAuthorizationCode(
  redirectUri: URL,
  expectedState: string,
  authorizationUrl: string,
): Promise<string> {
  const port = redirectUri.port ? Number.parseInt(redirectUri.port, 10) : 80;
  const listenHost = redirectUri.hostname.replace(/^\[|\]$/g, '');

  return new Promise((resolve, reject) => {
    let settled = false;
    const server = createServer((req, res) => {
      if (!req.url) return;
      const callbackUrl = new URL(req.url, redirectUri.origin);
      if (callbackUrl.pathname !== redirectUri.pathname) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const returnedState = callbackUrl.searchParams.get('state');
      const returnedCode = callbackUrl.searchParams.get('code');
      const oauthError = callbackUrl.searchParams.get('error');

      const finish = (error?: Error, code?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        server.close();
        if (error) reject(error);
        else resolve(code!);
      };

      if (oauthError) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h1>Authorization failed</h1><p>NinjaOne denied the request.</p>');
        finish(new Error(`Authorization returned error: ${oauthError}`));
        return;
      }
      if (!stateMatches(expectedState, returnedState)) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h1>Authorization failed</h1><p>State validation failed.</p>');
        finish(new Error('OAuth state mismatch — possible CSRF attempt.'));
        return;
      }
      if (!returnedCode) {
        res.writeHead(400);
        res.end('Missing authorization code');
        finish(new Error('NinjaOne callback did not include an authorization code'));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1>NinjaOne authorization complete</h1><p>You can close this tab.</p>');
      finish(undefined, returnedCode);
    });

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      server.close();
      reject(new Error('Timed out waiting for the NinjaOne authorization callback'));
    }, 5 * 60 * 1000);

    server.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });

    server.listen(port, listenHost, () => {
      console.log(`Listening for the NinjaOne callback on ${redirectUri.origin}${redirectUri.pathname}`);
      console.log(
        'Authorization request checks: client_secret absent; state present; code_challenge present; code_challenge_method=S256.',
      );
      openBrowser(authorizationUrl);
      console.log('Opened the NinjaOne consent page in the default browser.');
    });
  });
}

async function main() {
  if ((process.env.NINJA_AUTH_PROFILE || '').toLowerCase() !== 'command') {
    throw new Error('The PKCE helper may only run with NINJA_AUTH_PROFILE=command');
  }
  if ((process.env.NINJA_AUTH_FLOW || '').toLowerCase() !== 'pkce') {
    throw new Error('The command profile must set NINJA_AUTH_FLOW=pkce');
  }

  const clientId = (process.env.NINJA_NATIVE_CLIENT_ID || '').trim();
  if (!clientId) throw new Error('NINJA_NATIVE_CLIENT_ID must be set for Native PKCE.');
  if (process.env.NINJA_CLIENT_SECRET || process.env.NINJA_NATIVE_CLIENT_SECRET) {
    throw new Error('Native PKCE configuration must not contain a client secret');
  }

  const baseUrl = resolveBaseUrl();
  const redirectUri = resolveRedirectUri();
  const redirectUriValue = oauthRedirectUriValue(redirectUri);
  const scopes = (process.env.NINJA_SCOPES || 'monitoring management offline_access')
    .split(/\s+/)
    .filter(Boolean);
  if (!scopes.includes('offline_access')) {
    throw new Error('Native PKCE scopes must include offline_access to obtain a refresh token');
  }
  if (scopes.includes('control')) {
    throw new Error('Control scope is intentionally disabled for the initial command profile');
  }

  const state = base64Url(randomBytes(32));
  const codeVerifier = base64Url(randomBytes(64));
  const codeChallenge = base64Url(createHash('sha256').update(codeVerifier).digest());

  const authorizationParams: Array<[string, string]> = [
    ['response_type', 'code'],
    ['client_id', clientId],
    ['redirect_uri', redirectUriValue],
    ['scope', scopes.join(' ')],
    ['state', state],
    ['code_challenge', codeChallenge],
    ['code_challenge_method', 'S256'],
  ];
  const authorizationQuery = authorizationParams
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
  const authorizationUrl = `${baseUrl}/ws/oauth/authorize?${authorizationQuery}`;

  const code = await receiveAuthorizationCode(redirectUri, state, authorizationUrl);

  console.log('Exchanging the one-time authorization code through the token endpoint...');
  const tokenBody = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: clientId,
    code,
    redirect_uri: redirectUriValue,
    code_verifier: codeVerifier,
  });
  const tokenResponse = await fetch(`${baseUrl}/ws/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: tokenBody.toString(),
  });
  if (!tokenResponse.ok) {
    throw new Error(
      `Native PKCE token exchange failed: ${tokenResponse.status} ${tokenResponse.statusText}`,
    );
  }

  const tokens: any = await tokenResponse.json();
  if (typeof tokens.refresh_token !== 'string') {
    throw new Error(
      'No refresh token was returned. Confirm the Native app enables Refresh Token and the request includes offline_access.',
    );
  }

  await UserOAuth.saveTokens({
    refresh_token: tokens.refresh_token,
    base_url: baseUrl,
    scope: typeof tokens.scope === 'string' ? tokens.scope : scopes.join(' '),
    saved_at: Date.now(),
  });

  console.log(`Command refresh token saved to ${UserOAuth.filePath}`);
  console.log('Native PKCE authorization completed without a client secret.');
}

main().catch((error) => {
  console.error('ERROR:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
