# Solve4x approved PowerShell runner

NinjaOne's public API can run saved automations but cannot create them. Install
`Solve4x-Approved-PowerShell-Runner.ps1` once in the NinjaOne Automation
Library, then configure its numeric script ID in `config/policy.json` as
`powershellRunnerScriptId`.

## One-time NinjaOne setup

1. Go to **Administration > Library > Automation**.
2. Create a restricted category named **Solve4x Privileged Runners** and grant
   access only to technicians who may execute arbitrary commands.
3. Add a new script with these settings:
   - Name: `Solve4x Approved PowerShell Runner`
   - Description: `Confirmation-gated SYSTEM PowerShell runner for the local Solve4x MCP command profile.`
   - Language: PowerShell
   - Operating system: Windows
   - Architecture: All, or both 32-bit and 64-bit
   - Run as: System
   - Category: Solve4x Privileged Runners
   - Script variables: none
   - Preset parameters: none
4. Paste or import `Solve4x-Approved-PowerShell-Runner.ps1` and save it. Do not
   schedule it or attach it to a policy.
5. Query `get_device_scripting_options` for an allowed Windows test device and
   locate the exact saved name. Put its numeric ID in the protected command
   policy, restart the MCP connector, dry-run the command, then execute only
   after explicit approval.

The MCP tool passes three positional values: the UTF-16LE Base64 command, a
GUID run ID, and the timeout in seconds. The runner executes the command in a
separate Windows PowerShell process and records that process's exit code in an
independent sidecar file. This avoids relying on the nullable process exit-code
property exposed by some NinjaOne PowerShell hosts.

## Activity output and result semantics

The Activity panel begins with a human-readable report containing:

- `SUCCESS`, `FAILED`, or `TIMED OUT`
- exit code, duration, run ID, and command SHA-256
- separate standard-output and standard-error sections
- compact machine metadata for the MCP result parser

MCP reconstructs `stdout` and `stderr` from the readable sections. Combined
stream output is limited to approximately 24,000 characters so the machine
result remains present in NinjaOne activity data. Truncation is explicitly
marked in both the readable output and the structured metadata.

Exit codes have these meanings:

- `0`: the approved command completed successfully
- `1-123` or `126+`: the command returned that failure code
- `124`: the configured timeout expired; the child process tree was targeted
  for termination
- `125`: the runner itself failed before it could obtain a trustworthy command
  result

NinjaOne's action status and the embedded command status are separate signals.
Use the structured `success`, `exitCode`, and `timedOut` fields as the command
result.

## Local validation

Run `tests/powershell-runner.test.ps1` with Windows PowerShell 5.1. It verifies
successful commands, native failures, PowerShell errors, stderr with a zero
exit code, timeouts, Base64 quoting/Unicode, and output truncation.
