[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$Account
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$targets = @(
  (Join-Path $repoRoot 'config\reporting.env'),
  (Join-Path $repoRoot 'config\command.env'),
  (Join-Path $repoRoot 'config\policy.json'),
  (Join-Path $env:USERPROFILE '.ninjaone-mcp\command\tokens.json')
)

foreach ($target in $targets) {
  if (-not (Test-Path -LiteralPath $target -PathType Leaf)) {
    throw "Required security file does not exist: $target"
  }

  & icacls.exe $target /inheritance:r /grant:r "${Account}:(F)" 'SYSTEM:(F)'
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to harden ACL for $target (icacls exit code $LASTEXITCODE)"
  }
}

