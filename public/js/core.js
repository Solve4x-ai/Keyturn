/* Core plumbing — token, api(), shared state, format/escape utilities.
   Feature modules import from here; cross-module wiring goes through ctx
   (app.js registers callbacks at boot) so modules never import each other
   in a cycle. */

const params = new URLSearchParams(location.search);
export const token =
  params.get('token') || localStorage.getItem('n1_token') ||
  prompt('Serve token (~/.ninjaone-mcp/serve.token):') || '';
localStorage.setItem('n1_token', token);
if (params.get('token')) history.replaceState(null, '', location.pathname + location.hash);

export const SESSION = 'ui-' + Math.random().toString(36).slice(2, 10);

export const state = {
  view: 'devices', page: 1, q: '', orgId: null, offline: null,
  sort: 'name', dir: 'asc', changesType: null, meta: null, infraCat: null,
  deviceId: null, deviceSnapId: null, deviceTab: 'overview',
  planId: null, opId: null,
  infraOrg: null, infraTab: 'overview', infraGpoQ: '',
};

/** Cross-module hooks registered by app.js — ctx.render(), ctx.openEntityDrawer(), ctx.openDeviceDrawer(). */
export const ctx = {};

export async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { authorization: `Bearer ${token}`, 'x-session-id': SESSION, 'content-type': 'application/json', ...(opts.headers || {}) },
  });
  if (res.status === 401) { localStorage.removeItem('n1_token'); location.reload(); }
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

export const $ = (sel) => document.querySelector(sel);
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// PowerShell ConvertTo-Json emits .NET date wrappers ('/Date(1322878261000)/');
// coerce to epoch ms so stored attrs render as dates.
export const tsToMs = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const m = typeof v === 'string' ? /^\/Date\((\d+)\)\/$/.exec(v.trim()) : null;
  const n = m ? Number(m[1]) : Number(v);
  if (!Number.isFinite(n)) return null;
  return n > 1e12 ? n : n * 1000; // seconds vs ms heuristic
};
export const ago = (ts) => {
  const ms = tsToMs(ts);
  if (ms === null) return 'never';
  const m = Math.round((Date.now() - ms) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};
export const fmtBool = (v) => (v ? 'yes' : 'no');
// Byte counts (validated unit for NinjaOne capacity/freeSpace fields).
export const fmtBytes = (n) => {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return 'unknown';
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)} GB`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)} MB`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)} KB`;
  return `${v} B`;
};
// NinjaOne timestamps are epoch seconds (sometimes fractional); local cache
// timestamps are epoch ms. Render both as local time.
export const fmtTs = (v) => {
  const ms = tsToMs(v);
  if (ms === null) return v === null || v === undefined || v === '' ? '—' : String(v);
  return new Date(ms).toLocaleString();
};

export function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

/* ── SSE invalidation stream ────────────────────────────────────────────
   EventSource can't set the Authorization header, so the stream is read
   via fetch. Emits 'entities' payloads to the handler; auto-reconnects. */
export async function streamInvalidations({ onEvent, onStatus, signal }) {
  const read = async () => {
    const res = await fetch('/api/v1/events/stream', { headers: { authorization: `Bearer ${token}` }, signal });
    if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
    onStatus?.('live');
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const frames = buf.split('\n\n');
      buf = frames.pop();
      for (const frame of frames) {
        const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
        if (!dataLine) continue;
        try { onEvent?.(JSON.parse(dataLine.slice(6))); } catch { /* malformed frame */ }
      }
    }
  };
  while (!signal?.aborted) {
    try { await read(); } catch { /* fall through to retry */ }
    if (signal?.aborted) break;
    onStatus?.('offline');
    await new Promise((r) => setTimeout(r, 3000));
  }
}
