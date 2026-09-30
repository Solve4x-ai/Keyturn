import { promises as fs } from 'fs';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';

/**
 * Cross-process mutex for refresh: two processes must never race a
 * refresh-token rotation. Exported so every rotation path (runtime refresh,
 * Settings credential test) serializes on the same lock directory.
 */
export async function withTokenLock<T>(fn: () => Promise<T>, tokenFile: string = UserOAuth.filePath): Promise<T> {
  const lockDir = `${tokenFile}.lock`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      await fs.mkdir(lockDir);
      break;
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        const stat = await fs.stat(lockDir);
        if (Date.now() - stat.mtimeMs > 30_000) {
          await fs.rmdir(lockDir).catch(() => {});
          continue; // stale lock — previous holder died
        }
      } catch {}
      if (Date.now() > deadline) {
        throw new Error('Timed out waiting for the NinjaOne token refresh lock');
      }
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  try {
    return await fn();
  } finally {
    await fs.rmdir(lockDir).catch(() => {});
  }
}

export interface StoredTokens {
  refresh_token: string;
  base_url: string;
  scope: string;
  saved_at: number;
}

function resolveTokenFile(): string {
  const configured = (process.env.NINJA_TOKEN_PATH || '').trim();
  if (configured) return resolve(configured);
  const profile = (process.env.NINJA_AUTH_PROFILE || 'command').trim().toLowerCase();
  return join(homedir(), '.ninjaone-mcp', profile, 'tokens.json');
}

export class UserOAuth {
  private cachedAccessToken: string | null = null;
  private cachedExpiry: number | null = null;
  private grantedScope: string | null = null;
  private stored: StoredTokens | null = null;
  private readonly clientId: string;

  constructor(clientId: string) {
    this.clientId = clientId;
  }

  static get filePath(): string {
    return resolveTokenFile();
  }

  static async saveTokens(tokens: StoredTokens): Promise<void> {
    const tokenFile = UserOAuth.filePath;
    const tokenDir = dirname(tokenFile);
    const temporaryFile = `${tokenFile}.${process.pid}.tmp`;
    await fs.mkdir(tokenDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(temporaryFile, JSON.stringify(tokens, null, 2), { mode: 0o600 });
    await fs.rename(temporaryFile, tokenFile);
    await fs.chmod(tokenFile, 0o600);
  }

  static async loadTokens(): Promise<StoredTokens | null> {
    try {
      const raw = await fs.readFile(UserOAuth.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<StoredTokens>;
      if (
        typeof parsed.refresh_token !== 'string' ||
        typeof parsed.base_url !== 'string' ||
        typeof parsed.saved_at !== 'number'
      ) {
        throw new Error('Stored NinjaOne token file is invalid');
      }
      return {
        refresh_token: parsed.refresh_token,
        base_url: parsed.base_url,
        scope: typeof parsed.scope === 'string' ? parsed.scope : '',
        saved_at: parsed.saved_at,
      };
    } catch (error: any) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async isAvailable(): Promise<boolean> {
    if (!this.stored) this.stored = await UserOAuth.loadTokens();
    return Boolean(this.stored?.refresh_token);
  }

  getGrantedScope(): string {
    return this.grantedScope || this.stored?.scope || '';
  }

  /**
   * Returns a valid Native-PKCE user-context token, refreshing through the
   * token endpoint without a confidential client secret.
   */
  async getAccessToken(): Promise<string> {
    if (this.cachedAccessToken && this.cachedExpiry && Date.now() < (this.cachedExpiry - 300_000)) {
      return this.cachedAccessToken;
    }

    // Serialize refresh across processes: re-read the token file inside the
    // lock — a peer may have just rotated the refresh token for us.
    return withTokenLock(async () => {
      if (this.cachedAccessToken && this.cachedExpiry && Date.now() < (this.cachedExpiry - 300_000)) {
        return this.cachedAccessToken;
      }
      const fresh = await UserOAuth.loadTokens();
      if (fresh) this.stored = fresh;
      return this.refreshLocked();
    });
  }

  private async refreshLocked(): Promise<string> {
    if (!this.stored?.refresh_token) {
      throw new Error('No stored NinjaOne command token. Run the Native PKCE auth helper first.');
    }

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: this.stored.refresh_token,
      client_id: this.clientId,
    });

    const response = await fetch(`${this.stored.base_url}/ws/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!response.ok) {
      throw new Error(
        `Native refresh-token exchange failed: ${response.status} ${response.statusText}. Re-run the PKCE auth helper.`,
      );
    }

    const json: any = await response.json();
    if (typeof json.access_token !== 'string' || typeof json.expires_in !== 'number') {
      throw new Error('Native refresh-token response did not contain a valid access token');
    }

    const stored = this.stored;
    const accessToken: string = json.access_token;
    const grantedScope =
      typeof json.scope === 'string' ? json.scope : stored.scope;
    this.cachedAccessToken = accessToken;
    this.cachedExpiry = Date.now() + (json.expires_in * 1000);
    this.grantedScope = grantedScope;

    if (
      (typeof json.refresh_token === 'string' && json.refresh_token !== stored.refresh_token) ||
      grantedScope !== stored.scope
    ) {
      const rotated: StoredTokens = {
        ...stored,
        refresh_token:
          typeof json.refresh_token === 'string' ? json.refresh_token : stored.refresh_token,
        scope: grantedScope,
        saved_at: Date.now(),
      };
      this.stored = rotated;
      await UserOAuth.saveTokens(rotated);
    }

    return accessToken;
  }
}
