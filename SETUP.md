# Local setup

This project runs two local stdio MCP processes: a read-only reporting profile and a separately authorized command profile. Node.js 22.13 or newer is required (built-in `node:sqlite` powers the local workspace database).

## 1. Install and build

```powershell
cd C:\Mission-Control
npm install
npm run verify
```

## 2. Create local configuration

```powershell
Copy-Item config\reporting.env.example config\reporting.env
Copy-Item config\command.env.example config\command.env
Copy-Item config\policy.example.json config\policy.json
```

These destination files are ignored by Git.

Configure `reporting.env` with an API Services application using Client Credentials and Monitoring scope. Configure `command.env` with a Native application's public client ID, the exact loopback redirect, Monitoring and Management scopes, and its profile-specific token path. Do not add a client secret to the Native profile.

In `policy.json`, set explicit allowed organization IDs. Leave every write category false until the category is required and reviewed.

## 3. Authorize the command profile

From an elevated PowerShell window:

```powershell
$env:DOTENV_CONFIG_PATH = 'C:\Mission-Control\config\command.env'
npm.cmd run auth
```

Complete the browser consent flow. Never paste the authorization URL, authorization code, token, or secret into chat or logs.

## 4. Protect local credentials

Replace `YOUR_WINDOWS_ACCOUNT` with the account that runs the MCP client:

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

Verify every file with `icacls.exe <path>`. Stop if an unexpected account retains access.

## 5. Configure the MCP client

Use both entries in [mcp-config.json.example](mcp-config.json.example). They pass only the path to the correct ignored profile file. Restart the MCP client after changing its configuration.

Call `get_auth_profile` first in each entry and verify:

- reporting reports profile `reporting`
- command reports profile `command`
- expected organization boundaries and disabled feature categories are shown

## 6. Operating rules

- Use reporting for normal investigation and audits.
- Use command only when the user explicitly requests a production change.
- Inspect exact targets and proposed fields before writes.
- Keep scripts, software deployment, administrative writes, destructive operations, and remote-control capabilities disabled unless separately designed and approved.
- Remember that `confirm: true` is not an independent physical approval.
- Revoke the command application's refresh token in NinjaOne if it may be compromised.

The runtime supports stdio only. Any non-`stdio` `MCP_MODE` fails at startup.
