param(
  [Parameter(Mandatory = $true)]
  [string]$CandidatePath,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-fA-F0-9]{64}$')]
  [string]$ApproveHash
)

$ErrorActionPreference = 'Stop'
$candidate = [System.IO.Path]::GetFullPath($CandidatePath)
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$target = [System.IO.Path]::GetFullPath((Join-Path $projectRoot 'spec\NinjaRMM-API-v2.json'))

if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
  throw "Candidate specification does not exist: $candidate"
}

$document = Get-Content -LiteralPath $candidate -Raw | ConvertFrom-Json
if ($document.openapi -notlike '3.*' -or -not $document.paths) {
  throw 'Candidate is not a valid OpenAPI 3 document with paths'
}

$actualHash = (Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualHash -ne $ApproveHash.ToLowerInvariant()) {
  throw "Candidate hash $actualHash does not match the explicitly approved hash"
}

Copy-Item -LiteralPath $candidate -Destination $target -Force
Write-Output "Pinned NinjaOne API specification updated."
Write-Output "Version: $($document.info.version)"
Write-Output "SHA256: $actualHash"
Write-Output 'Review and update spec\README.md, run npm run verify, then restart the MCP processes.'

