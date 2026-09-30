/**
 * Connection identity — an explicit local UUID plus a JSON manifest, never
 * the sanitized API host (work-order invariant 1; commandcenter.md §5.2).
 *
 * The manifest at `%USERPROFILE%\.ninjaone-mcp\connections.json` maps each
 * connection UUID to its canonical API origin and database file. The host
 * string is only a discovery hint: it may match a manifest row to find the
 * connection for this server, but the row's UUID is the durable identity.
 *
 * Migration: pre-manifest databases were named `<host>.db`. When exactly one
 * legacy file matches and no manifest row claims the origin, the file is
 * adopted in place (manifest points at it — no copy, no rename, nothing
 * merges). Ambiguous claims are surfaced, never silently resolved.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { tenantKeyFromBaseUrl } from './storage.js';

export interface ConnectionRecord {
  /** Local connection UUID — the durable identity used by journals/meta. */
  id: string;
  /** Canonical API origin, e.g. https://us2.ninjarmm.com */
  apiOrigin: string;
  /** Sanitized host — a matching hint only, never the identity. */
  tenantHost: string;
  /** Absolute path to this connection's SQLite database. */
  dbFile: string;
  createdAt: number;
  /** Set when a legacy host-named database was adopted in place. */
  adoptedFrom?: string;
}

export interface ConnectionResolution {
  dbPath: string;
  /** null for explicit test paths (:memory:, NINJA_DB_PATH) — unbound storage. */
  connection: ConnectionRecord | null;
  /** true when an existing legacy host-named file was adopted rather than created. */
  adopted: boolean;
  /** Manifest row ids that also claimed this origin (losing candidates). */
  ambiguousIds: string[];
}

interface Manifest {
  version: 1;
  connections: ConnectionRecord[];
}

function defaultBaseDir(): string {
  return join(homedir(), '.ninjaone-mcp');
}

function manifestPath(baseDir: string): string {
  return join(baseDir, 'connections.json');
}

function loadManifest(baseDir: string): Manifest {
  const file = manifestPath(baseDir);
  if (!existsSync(file)) return { version: 1, connections: [] };
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as Manifest;
  if (!Array.isArray(parsed.connections)) {
    throw new Error(`Connection manifest ${file} is corrupt: missing connections array`);
  }
  return parsed;
}

function saveManifest(baseDir: string, manifest: Manifest): void {
  mkdirSync(baseDir, { recursive: true });
  const file = manifestPath(baseDir);
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  renameSync(tmp, file);
}

function canonicalOrigin(apiBaseUrl: string | null): { origin: string; host: string } {
  const raw = (apiBaseUrl || '').trim() || 'default';
  let host: string;
  try {
    host = new URL(raw).host;
  } catch {
    host = raw.replace(/^https?:\/\//, '').split('/')[0] || raw;
  }
  host = host.toLowerCase();
  return { origin: `https://${host}`, host };
}

/**
 * Resolve which local database this server should use for `apiBaseUrl`.
 *
 * Precedence:
 *  1. `NINJA_DB_PATH` — explicit test/portability path, unbound (no connection).
 *  2. `NINJA_CONNECTION_ID` — explicit selection; fails closed when unknown.
 *  3. Manifest row matching the canonical origin or sanitized host.
 *  4. Adoption of a legacy `<host>.db` file into a new manifest row.
 *  5. Creation of a fresh `conn-<uuid>.db` + manifest row.
 *
 * When more than one manifest row claims the origin, the oldest row wins
 * deterministically and every competing id is reported — caches never merge.
 */
export function resolveConnection(
  apiBaseUrl: string | null,
  opts: { baseDir?: string } = {},
): ConnectionResolution {
  const override = (process.env.NINJA_DB_PATH || '').trim();
  if (override) {
    return { dbPath: override, connection: null, adopted: false, ambiguousIds: [] };
  }

  const baseDir = opts.baseDir ?? defaultBaseDir();
  const dataDir = join(baseDir, 'data');
  const manifest = loadManifest(baseDir);
  const { origin, host } = canonicalOrigin(apiBaseUrl);
  const legacyHostFile = join(dataDir, `${tenantKeyFromBaseUrl(apiBaseUrl || 'default')}.db`);

  const explicitId = (process.env.NINJA_CONNECTION_ID || '').trim();
  if (explicitId) {
    const found = manifest.connections.find((c) => c.id === explicitId);
    if (!found) {
      throw new Error(
        `NINJA_CONNECTION_ID "${explicitId}" is not in the connection manifest — refusing to guess a database`,
      );
    }
    return { dbPath: found.dbFile, connection: found, adopted: false, ambiguousIds: [] };
  }

  const matches = manifest.connections.filter(
    (c) => c.apiOrigin === origin || c.tenantHost === host,
  );

  const chosen = matches.sort((a, b) => a.createdAt - b.createdAt)[0];
  if (chosen) {
    const rest = matches.slice(1);
    if (rest.length > 0) {
      console.error(
        `WARNING: ${matches.length} connections claim ${origin}; using ${chosen.id} ` +
          `(oldest). Ignored: ${rest.map((r) => r.id).join(', ')}. Caches were NOT merged.`,
      );
    }
    return {
      dbPath: chosen.dbFile,
      connection: chosen,
      adopted: false,
      ambiguousIds: rest.map((r) => r.id),
    };
  }

  // No manifest row claims this origin. Adopt a legacy host-named file in
  // place when it exists — the file is left untouched, only registered.
  if (existsSync(legacyHostFile)) {
    const record: ConnectionRecord = {
      id: randomUUID(),
      apiOrigin: origin,
      tenantHost: host,
      dbFile: legacyHostFile,
      createdAt: Date.now(),
      adoptedFrom: legacyHostFile,
    };
    manifest.connections.push(record);
    saveManifest(baseDir, manifest);
    console.error(
      `Adopted legacy database ${legacyHostFile} as connection ${record.id} ` +
        `(identity now lives in connections.json, not the filename)`,
    );
    return { dbPath: record.dbFile, connection: record, adopted: true, ambiguousIds: [] };
  }

  const record: ConnectionRecord = {
    id: randomUUID(),
    apiOrigin: origin,
    tenantHost: host,
    dbFile: join(dataDir, `conn-${randomUUID()}.db`),
    createdAt: Date.now(),
  };
  manifest.connections.push(record);
  saveManifest(baseDir, manifest);
  return { dbPath: record.dbFile, connection: record, adopted: false, ambiguousIds: [] };
}
