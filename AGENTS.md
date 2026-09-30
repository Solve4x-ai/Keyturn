# Working notes

Guidance for humans and coding agents working in this repository.

## Local UI server (command profile)

`npm run serve` alone is not enough — `dist/serve.js` requires env vars:

```sh
NINJA_AUTH_PROFILE=command \
NINJA_POLICY_PATH=config/policy.json \
NINJA_SERVE_PORT=39300 \
NINJA_BASE_URL=https://<region>.ninjarmm.com \
node dist/serve.js
```

- `NINJA_BASE_URL` is **required**: without it the API base URL defaults to
  `https://app.ninjarmm.com`, connection resolution picks the wrong store,
  and review/infra queries silently return empty instead of erroring.
- A bearer token is generated per start at `~/.ninjaone-mcp/serve.token`;
  the UI requires it.
- `config/policy.json` is gitignored — copy `config/policy.example.json`
  and enable writes only for the organizations you intend.
- **Passkey approvals need `http://localhost:<port>`**, not `127.0.0.1` —
  WebAuthn refuses IP-address origins. Override with
  `NINJA_WEBAUTHN_RP_ID` / `NINJA_WEBAUTHN_ORIGINS`.
- Set `NINJA_SYNC_INTERVAL_MINUTES=5` for live inventory (connector API
  reads only; runs nothing on endpoints). Without it, status is only as
  fresh as the last manual sync.
- MCP stdio clients each spawn their own `dist/index.js`; after a rebuild,
  stop those node processes and the clients respawn on the next tool call.

## Read-only test server (for agents)

Agents verifying UI work must use a **reporting-profile** server so nothing
can be approved or dispatched, with background workers disabled:

```sh
NINJA_SERVE_PORT=39301 NINJA_RECONCILE_TICK_MS=0 NINJA_SCHEDULE_TICK_MS=2000000000 \
NINJA_SYNC_INTERVAL_MINUTES=0 DOTENV_CONFIG_PATH=config/reporting.env \
node --require dotenv/config dist/serve.js
```

Never call `/approve`, `/execute`, `/release`, or `/tools/*` write tools
while testing. Never target endpoints outside your explicit authorization.

## Verify

- `npm run build` then `npm test` (mocked; never touches a live tenant).
- New API routes only exist after `npm run build` **and** a restart of the
  running server — the browser loads new `public/` code immediately, so a
  stale server shows up as `404 Route GET:/api/v1/... not found`.
- `public/` is served statically — JS/CSS changes need no rebuild.
- `node --check public/app.js public/js/*.js` catches browser-module syntax
  errors without a browser.
