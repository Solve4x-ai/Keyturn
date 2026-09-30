# Mission Control security profiles (NinjaOne connector)

This installation uses two separate NinjaOne applications and two separate Codex MCP entries. The separation prevents a read-only reporting process from inheriting user-context write authority.

## Architecture

| Profile | NinjaOne app | OAuth flow | Scopes | Local credentials |
| --- | --- | --- | --- | --- |
| `ninjaone-reporting` | Existing API Services app | Client credentials | `monitoring` | `config/reporting.env` |
| `ninjaone-command` | `Solve4x MCP Command Center` Native app | Authorization Code with S256 PKCE and refresh token | `monitoring management offline_access` | `config/command.env` plus the profile-specific token file |

The reporting client secret is used only in the back-channel token request. It is never placed in an authorization URL. The Native command app has no client secret: a desktop application cannot reliably keep one confidential, so PKCE binds the authorization code to a one-time verifier instead.

The two processes cannot silently borrow each other's credentials. The command profile fails closed when its Native token is absent or invalid, and the reporting profile never loads the command token.

The MCP runtime is local stdio only and opens no HTTP or SSE listener. Any configured `MCP_MODE` other than `stdio` fails at startup. Remote transport should not be added without a separate threat model and modern authenticated Streamable HTTP design.

## Local files

- `config/reporting.env` contains the existing reporting client credentials.
- `config/command.env` contains the Native public client ID, loopback redirect, scopes, and token path. It must not contain a client secret.
- `config/policy.json` limits command actions to approved organizations and feature categories.
- `%USERPROFILE%\.ninjaone-mcp\command\tokens.json` contains the command refresh token after authorization.

All four files are ignored by Git. Their tracked `.example` counterparts contain placeholders only.

The Native registration fixes the loopback redirect at the literal value `http://127.0.0.1`. This NinjaOne region rejects an added high port or a normalized trailing slash, so the one-time authorization helper preserves that exact OAuth value, binds only `127.0.0.1:80`, and requires an elevated shell. It still validates the exact loopback host and root path, an unguessable state value, and the S256 PKCE verifier before accepting the callback. The MCP servers themselves do not need port 80 or elevation after authorization.

## One-time command authorization

1. In NinjaOne, create a Native app named `Solve4x MCP Command Center`.
2. Enable only `Monitoring` and `Management`.
3. Enable `Authorization code` and `Refresh token`. Leave `Control` off; Native apps do not enable client credentials.
4. Put the resulting public client ID in `NINJA_NATIVE_CLIENT_ID` inside `config/command.env`.
5. From an elevated PowerShell window in `C:\Mission-Control`, run:

   ```powershell
   $env:DOTENV_CONFIG_PATH = 'C:\Mission-Control\config\command.env'
   npm.cmd run auth
   ```

6. Complete the NinjaOne sign-in and consent in the browser. The helper validates an unguessable `state`, uses an ephemeral S256 PKCE verifier, accepts only the configured loopback callback, and has a five-minute callback timeout.

Do not paste an authorization URL, authorization code, access token, refresh token, or reporting client secret into chat, tickets, logs, or shell history.

## Local access control

Run the following in an elevated PowerShell window after the command token file exists. Replace `YOUR_WINDOWS_ACCOUNT` with the account that runs Codex.

```powershell
$account = 'YOUR_WINDOWS_ACCOUNT'
$files = @(
  'C:\Mission-Control\config\reporting.env',
  'C:\Mission-Control\config\command.env',
  'C:\Mission-Control\config\policy.json',
  "$env:USERPROFILE\.ninjaone-mcp\command\tokens.json"
)

foreach ($file in $files) {
  icacls.exe $file /inheritance:r /grant:r "${account}:(F)" "SYSTEM:(F)"
}
```

Verify each result with `icacls.exe <path>`. Do not continue if an unexpected user or group retains access.

## Capability matrix

“Exposed” means the tool is discoverable. It does not mean an action has been authorized for unattended use.

The existing `confirm: true` arguments are server-enforced intent checks, but the MCP caller supplies them. They are not independent proof of a physical human approval. Until a separate approval broker exists, access to the command profile itself must be treated as privileged.

| Capability | Reporting | Command | Additional command guard |
| --- | --- | --- | --- |
| Organizations, devices, alerts, activities, inventory, policies, users, contacts, tickets, and query endpoints | Read | Read | None beyond OAuth and profile isolation |
| Pinned API endpoint discovery and domain navigation | Read | Read | Discovery only; no generic endpoint executor |
| Complete device/ticket pagination and local audit exports | Read | Read | Fixed export directory, pagination limits, completeness metadata, secret-field redaction |
| Create/update/comment on tickets | Hidden | Exposed | ACME organization boundary, policy flag, and explicit per-call confirmation |
| Reboot, maintenance mode, device metadata, service control, alert reset, device approval, policy assignment | Hidden | Exposed | ACME organization boundary, policy flag, and explicit per-call confirmation |
| List saved automations | Read | Read | Uses the documented `GET /v2/automation/scripts` endpoint |
| Inspect device scripting options | Hidden | Read | Command profile only; resolves scripts/actions available to the selected device |
| Run saved device scripts | Hidden | Exposed | ACME organization boundary, script policy flag, and explicit per-call confirmation |
| Run approved PowerShell commands | Hidden | Exposed after runner ID configuration | Uses one saved runner, ACME/Solve4x organization boundary, SYSTEM context, Base64 parameters, timeout, and explicit per-call confirmation |
| Create or upload NinjaOne scripts | Not implemented | Not implemented | The pinned NinjaOne Public API exposes script listing and execution but no script-definition creation endpoint |
| Scan/apply OS or software patches | Hidden | Hidden | Disabled by policy |
| Administrative writes to organizations, locations, users, contacts, custom fields, roles, webhooks, or installers | Hidden | Hidden | Disabled by policy and explicit blocked-action list |
| Delete users, contacts, webhooks, policy overrides, or role members | Hidden | Hidden | Destructive operations disabled |
| Start a remote-control session | Not implemented | Not implemented | No remote-control tool exists |
| Deploy arbitrary approved software | Not implemented | Not implemented | Patch APIs are separate and disabled |

Unknown tools fail closed and are not exposed by either profile. Every command write is checked again at execution time, so hiding a tool is not the only control.

The endpoint catalog under `spec` is documentation data, not an execution
allowlist. Finding a new API operation never makes it callable. Specification
updates require an explicitly approved SHA-256 hash, review, verification, and
an MCP process restart.

## Revocation and recovery

If the command token may be compromised:

1. Go to NinjaOne **Administration → Apps → API → OAuth tokens**.
2. Revoke the authorization for `Solve4x MCP Command Center`.
3. Stop any running `ninjaone-command` process.
4. Remove the local command token file.
5. Investigate local file access and process logs before authorizing again.

Revocation invalidates the refresh token and related access tokens. Deleting only the local file does not revoke a copied token, so use the NinjaOne OAuth Tokens dashboard first.

If the reporting client secret may be compromised, rotate or replace the API Services application credentials in NinjaOne, update `config/reporting.env`, and reapply the ACL.

To disable command access completely, revoke its OAuth tokens and disable or remove the Native client app in NinjaOne. The older `NinjaOne MCP Local` Web app is not used by these profiles and may be disabled separately after confirming nothing else depends on it.
