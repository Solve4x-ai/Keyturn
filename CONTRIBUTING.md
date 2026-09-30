# Contributing

Thanks for helping! Bug reports, docs fixes, new runbooks, and new RMM
connectors are all welcome.

## Get running

```powershell
git clone https://github.com/Solve4x-ai/Mission-Control.git
cd Mission-Control
npm install
npm run demo        # full UI on fictional data — no RMM account needed
```

The demo is the best place to work on the UI: it's sandboxed, read-only, and
reproducible (`npm run demo -- --reset`).

## Project layout

| Path | What |
|---|---|
| `src/index.ts` | MCP server (stdio) and tool dispatch |
| `src/serve.ts` | Local Fastify server: bearer auth, `/api/v1/*`, static UI |
| `src/operations.ts` | Plans, approvals, dispatch, receipts |
| `src/webauthn.ts` | Passkey enrollment and assertions |
| `src/infra*.ts`, `src/runbooks.ts` | Evidence collection, extraction, topology |
| `src/review.ts` | Review Center (never dispatches anything) |
| `src/storage.ts` | SQLite schema and versioned migrations |
| `public/` | UI — vanilla ES modules and CSS, **no build step** |
| `tests/` | `node:test` suites, fully mocked |
| `scripts/` | `setup`, `ui`, and `demo` launchers |

## Before you open a PR

```powershell
npm run build
npm test                               # must pass; never touches a live tenant
node --check public/app.js public/js/*.js   # catches UI syntax errors
```

On Windows, `npm run verify` also runs the PowerShell runner tests.

- `public/` changes need no rebuild — just refresh. `src/` changes need
  `npm run build` **and** a server restart (a stale server shows up as
  `404 Route GET:/api/v1/... not found`).
- Add or update tests for behavior changes. Safety-relevant changes (plans,
  approvals, policy, org boundaries, credentials) need a regression test.
- Keep the UI framework-free and match the existing design tokens.

## Safety rules for contributors (and coding agents)

- **Never test against a production tenant.** Use the demo, the mocked tests,
  or a read-only `reporting` server with workers off:

  ```sh
  NINJA_SERVE_PORT=39301 NINJA_RECONCILE_TICK_MS=0 NINJA_SCHEDULE_TICK_MS=2000000000 \
  NINJA_SYNC_INTERVAL_MINUTES=0 DOTENV_CONFIG_PATH=config/reporting.env \
  node --require dotenv/config dist/serve.js
  ```

- Never call `/approve`, `/execute`, `/release`, or write tools while testing
  against real data.
- Never commit real tenant names, hostnames, IPs, device IDs, client IDs,
  secrets, or tokens — in code, tests, fixtures, screenshots, or issues. Use
  the fictional Contoso / Northwind / Fabrikam names and RFC 1918 addresses.
- The AI proposes; humans approve. Don't add any path that lets a tool
  approve or dispatch its own plan.

## Adding an RMM connector

The core (plans, approvals, evidence, review, receipts) is connector-agnostic.
Open an issue first to discuss the connector's auth model and how it runs
scripts on endpoints — it must fit the plan → approval → receipt pipeline.

## Commit and PR style

Small, focused PRs with a clear description of *why*. Reference an issue when
there is one. By contributing you agree your work is licensed under the
[MIT License](LICENSE).
