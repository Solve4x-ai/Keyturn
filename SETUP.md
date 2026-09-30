# Setup

About 15 minutes. You'll need **Windows**, **Node.js 22.13+**
([download](https://nodejs.org)), and NinjaOne administrator access to create
two API applications.

> Just want to look around first? `npm install && npm run demo` runs the full
> UI with fictional data and no NinjaOne account.

## 1. Create two NinjaOne API apps

In NinjaOne go to **Administration → Apps → API → Client App IDs → Add**.

**Reporting app** (read-only)

| Field | Value |
|---|---|
| Application platform | API Services (machine-to-machine) |
| Name | e.g. `Keyturn Reporting` |
| Scopes | **Monitoring** only |
| Allowed grant types | **Client credentials** |

Copy the **client ID** and **client secret**.

**Command app** (writes, always behind your approval)

| Field | Value |
|---|---|
| Application platform | **Native** |
| Name | e.g. `Keyturn Command` |
| Redirect URI | `http://127.0.0.1` (exactly — no port, no trailing slash) |
| Scopes | **Monitoring** and **Management** (leave Control off) |
| Allowed grant types | **Authorization code** and **Refresh token** |

Copy the **client ID**. Native apps have no secret — that's intentional.

Why two apps? The read-only identity can never borrow write authority. See
[docs/security-model.md](docs/security-model.md).

## 2. Install and configure

```powershell
git clone https://github.com/Solve4x-ai/Keyturn.git
cd Keyturn
npm install
npm run setup
```

`npm run setup` asks for your region and the IDs from step 1, writes the
git-ignored `config/reporting.env`, `config/command.env`, and
`config/policy.json` (with every write disabled), and builds. Re-run it any
time; press Enter to keep a value.

<details>
<summary>Prefer to edit files by hand?</summary>

```powershell
Copy-Item config\reporting.env.example config\reporting.env
Copy-Item config\command.env.example   config\command.env
Copy-Item config\policy.example.json   config\policy.json
npm run build
```

Fill in the IDs, set `NINJA_BASE_URL` to your region
(`https://app|us2|eu|ca|oc.ninjarmm.com`), and set `NINJA_POLICY_PATH` in both
env files to the **absolute** path of `config\policy.json`.
</details>

## 3. Authorize the command app (once)

From an **elevated** PowerShell in the repo (the `http://127.0.0.1` redirect
listens on port 80, which needs admin):

```powershell
npm run auth:command
```

Sign in and consent in the browser. The refresh token is saved to
`%USERPROFILE%\.ninjaone-mcp\command\tokens.json` and rotates on every use.
Later re-authorizations can be done from **Settings → Reconnect** in the UI.

Never paste the authorization URL, code, token, or secret into chat or logs.

## 4. Start the dashboard

```powershell
npm run ui
```

Your browser opens at `http://localhost:39300`, signed in. (Use `localhost`,
not `127.0.0.1` — browsers only allow passkeys on a hostname.) Inventory syncs
from NinjaOne every 5 minutes; that's plain API reads and runs nothing on
endpoints.

Then, in the UI:

1. **Security → Enroll a key.** A YubiKey, Windows Hello, or Bitwarden passkey.
   From now on every approval and every settings change needs it.
2. **Settings → Safety policy.** Allow the organizations you manage and turn
   on only the write categories you need.
3. **Settings → MCP clients → Merge** next to your AI client (Claude Desktop,
   Cursor, Windsurf, Codex, Devin). It writes both server entries with the
   right paths and keeps a backup. Restart the client afterwards.

## 5. Try it

Ask your assistant something like:

- "Which of my servers are offline, and since when?"
- "Show DHCP scopes above 80% for Contoso."
- "Run the AD health runbook on DC01." → it creates a plan → approve it in
  **Approvals** with your passkey → the results appear under
  **Infrastructure**.

The assistant should call `get_auth_profile` first; the reporting entry must
report `reporting` and the command entry `command`.

### Endpoint runbooks

Diagnostics run through one saved NinjaOne automation, the approved PowerShell
runner. Add [`automations/Solve4x-Approved-PowerShell-Runner.ps1`](automations/README.md)
to your NinjaOne script library and put its script ID in **Settings → Safety
policy → PowerShell runner script ID**.

## 6. Lock down local credentials (recommended)

From an elevated PowerShell in the repo:

```powershell
.\scripts\harden-local-acls.ps1 -Account "$env:USERDOMAIN\$env:USERNAME"
```

This removes inherited access to the env files, the policy, and the command
token. Check with `icacls.exe config\command.env`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Everything is empty / "no connection" | `NINJA_BASE_URL` is missing or the wrong region. |
| `404 Route GET:/api/v1/... not found` | You rebuilt but didn't restart `npm run ui`. |
| Passkey prompt never appears | Open `http://localhost:39300`, not `127.0.0.1`. |
| `npm run auth:command` fails to listen | Run it from an elevated PowerShell; the redirect needs port 80. |
| AI client doesn't see the tools | Restart the client after Merge; check `NINJA_POLICY_PATH` is absolute. |
| `ExperimentalWarning: SQLite` | Harmless — Node's built-in `node:sqlite`. |

## Operating rules

- Use the reporting profile for investigation and audits.
- Use the command profile only when you intend a change.
- `confirm: true` on a tool call is not approval — the plan still waits for you.
- If the command token may be compromised, revoke it in NinjaOne
  (**Administration → Apps → API → OAuth tokens**) before anything else.
