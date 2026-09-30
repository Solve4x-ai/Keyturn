# Security model

Keyturn lets an AI assistant investigate and propose work on real
endpoints. The design goal is simple to state: **an AI holding every token on
the machine still cannot make anything happen on an endpoint without a human.**
This page explains how.

## Two identities, never mixed

| Profile | NinjaOne app type | OAuth flow | Scopes | Local credentials |
| --- | --- | --- | --- | --- |
| `reporting` | API Services | Client credentials | `monitoring` | `config/reporting.env` |
| `command` | Native | Authorization code + S256 PKCE + refresh token | `monitoring management offline_access` | `config/command.env` + `~/.ninjaone-mcp/command/tokens.json` |

- The reporting client secret is used only in the back-channel token request;
  it never appears in a URL.
- The Native command app has **no client secret** — a desktop app cannot keep
  one confidential — so PKCE binds each authorization code to a one-time
  verifier instead.
- The profiles cannot borrow each other's credentials. The command profile
  fails closed without a valid token; the reporting profile never loads it.
- Refresh tokens rotate on every use and are written under a file lock, so two
  processes can't race and burn a token.

## Local only

- MCP runs over **stdio only**. Any `MCP_MODE` other than `stdio` fails at
  startup; there is no HTTP/SSE MCP endpoint.
- The Keyturn dashboard binds to `127.0.0.1`, requires a per-install bearer
  token (`~/.ninjaone-mcp/serve.token`), and serves `cache-control: no-store`.
- No hosted service, no telemetry, no credentials in MCP client configs — those
  only carry the *path* to an ignored env file.

## Nothing runs without a human

1. **Plans.** Endpoint-affecting work is created as an immutable plan: exact
   script, targets, parameters, and a SHA-256 hash binding them together.
   `confirm: true` on a tool call is an intent check supplied by the caller —
   it is **not** approval.
2. **Approval.** A human approves in the local UI. Approvals are single-use,
   expire, and bind to the plan hash.
3. **Passkeys.** Once a WebAuthn key (YubiKey, Windows Hello, Bitwarden, …) is
   enrolled, every approval requires a user-verified assertion. The first key
   bootstraps; adding or revoking keys needs an existing key; the last key
   can't be removed. Settings changes (credentials, policy, client-config
   merges) are passkey-gated too.
4. **Preflight.** Immediately before dispatch the target device is re-fetched
   from the RMM and checked against the organization allowlist again.
5. **Receipts.** "Accepted" never means "done". Results are final only when a
   receipt is reconciled to `verified` or `failed`.

## Policy

`config/policy.json` (copied from `config/policy.example.json`, which disables
every write) controls:

- `allowedOrganizationIds` — the only organizations writes may touch.
- Per-category switches: ticket writes, device management, device scripts,
  administrative writes, software deployment, remote control, destructive
  operations, review writes.
- `blockedActions` — explicit deny list that wins over any switch.
- PowerShell session bounds (`powershellSessionTtlSeconds`,
  `powershellSessionMaxCommands`; `0` = every command needs its own approval).

Unknown tools fail closed. Every write is re-checked at execution time, so
hiding a tool is never the only control.

## Capability matrix

"Exposed" means discoverable, not authorized for unattended use.

| Capability | Reporting | Command | Guard |
| --- | --- | --- | --- |
| Organizations, devices, alerts, activities, inventory, policies, tickets | Read | Read | OAuth + profile isolation |
| Pinned API endpoint discovery | Read | Read | Discovery only — no generic endpoint executor |
| Paginated exports | Read | Read | Fixed export dir, limits, secret-field redaction |
| Create/update/comment on tickets | Hidden | Exposed | Org allowlist + policy flag + confirmation |
| Reboot, maintenance mode, service control, alert reset | Hidden | Plan-only | Plan → human approval → preflight |
| Run saved device scripts / approved PowerShell runner | Hidden | Plan-only | Plan → human approval → preflight; SYSTEM context; timeout |
| OS / software patching | Hidden | Hidden | Disabled by policy |
| Administrative writes (orgs, locations, users, roles, webhooks, installers) | Hidden | Hidden | Disabled by policy + blocked-action list |
| Deletes | Hidden | Hidden | Destructive operations disabled |
| Remote control | — | — | Not implemented |

The endpoint catalog in `spec/` is documentation data, not an execution
allowlist. A new API operation never becomes callable just by appearing there.

## Protect local credentials (Windows)

After the command token exists, lock the credential files to your account.
From an elevated shell in the repo:

```powershell
.\scripts\harden-local-acls.ps1 -Account "$env:USERDOMAIN\$env:USERNAME"
```

Or by hand:

```powershell
$account = "$env:USERDOMAIN\$env:USERNAME"
$files = @(
  '.\config\reporting.env',
  '.\config\command.env',
  '.\config\policy.json',
  "$env:USERPROFILE\.ninjaone-mcp\command\tokens.json"
)
foreach ($file in $files) {
  icacls.exe $file /inheritance:r /grant:r "${account}:(F)" "SYSTEM:(F)"
}
```

Verify with `icacls.exe <path>` and stop if any unexpected account keeps access.

Never paste an authorization URL, authorization code, token, or client secret
into chat, tickets, logs, or shell history.

## Revocation

If the command token may be compromised:

1. In NinjaOne, go to **Administration → Apps → API → OAuth tokens** and revoke
   the Native app's authorization. (Deleting the local file alone does not
   revoke a copied token.)
2. Stop any running `ninjaone-command` process and delete
   `~/.ninjaone-mcp/command/tokens.json`.
3. Investigate local file access before authorizing again.

If the reporting secret may be compromised, rotate the API Services
credentials in NinjaOne, update `config/reporting.env`, and re-apply the ACLs.

## Known limits

- The approval UI and the MCP processes run as the same OS user. Until a key is
  enrolled, any local process that can read the serve token can approve plans —
  the UI says so. **Enroll a passkey.**
- OS-account separation for the command server is on the roadmap.

Found a vulnerability? See [SECURITY.md](../SECURITY.md).
