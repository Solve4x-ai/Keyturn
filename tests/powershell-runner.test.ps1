[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$runnerPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'automations\Solve4x-Approved-PowerShell-Runner.ps1'
$windowsPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$utf8NoBom = New-Object System.Text.UTF8Encoding -ArgumentList $false
$script:passed = 0

function Assert-Equal {
    param($Actual, $Expected, [string]$Message)
    if ($Actual -ne $Expected) {
        throw "$Message Expected: '$Expected'. Actual: '$Actual'."
    }
}

function Assert-Contains {
    param([AllowNull()][string]$Actual, [string]$Expected, [string]$Message)
    if ($null -eq $Actual -or -not $Actual.Contains($Expected)) {
        throw "$Message Missing text: '$Expected'."
    }
}

function Get-Sha256 {
    param([string]$Value)
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($sha256.ComputeHash($utf8NoBom.GetBytes($Value)))).Replace('-', '').ToLowerInvariant()
    }
    finally {
        $sha256.Dispose()
    }
}

function Get-MarkedSection {
    param([string]$Text, [string]$BeginMarker, [string]$EndMarker)
    $begin = $Text.IndexOf($BeginMarker, [StringComparison]::Ordinal)
    $end = $Text.IndexOf($EndMarker, [StringComparison]::Ordinal)
    if ($begin -lt 0 -or $end -le $begin) {
        throw "Missing marked section: $BeginMarker"
    }
    $start = $begin + $BeginMarker.Length
    $value = $Text.Substring($start, $end - $start).Trim("`r", "`n")
    if ($value -eq '(none)') { return '' }
    return $value
}

function Invoke-Runner {
    # Windows PowerShell cold starts can be slow on endpoint-security-heavy hosts.
    # Production defaults to 120 seconds; 30 keeps non-timeout tests deterministic.
    param([string]$Command, [int]$TimeoutSeconds = 30)
    $runId = [guid]::NewGuid().ToString()
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($Command))
    $output = (& $windowsPowerShell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $runnerPath -CommandBase64 $encoded -RunId $runId -TimeoutSeconds $TimeoutSeconds 2>&1 | Out-String)
    $processExitCode = $LASTEXITCODE
    $resultBegin = $output.LastIndexOf('S4X_RUNNER_RESULT_BEGIN', [StringComparison]::Ordinal)
    $resultEnd = $output.LastIndexOf('S4X_RUNNER_RESULT_END', [StringComparison]::Ordinal)
    if ($resultBegin -lt 0 -or $resultEnd -le $resultBegin) {
        throw "Runner result markers were missing.`r`n$output"
    }
    $jsonStart = $resultBegin + 'S4X_RUNNER_RESULT_BEGIN'.Length
    $json = $output.Substring($jsonStart, $resultEnd - $jsonStart).Trim()
    $result = $json | ConvertFrom-Json
    $stdout = Get-MarkedSection -Text $output -BeginMarker "S4X_RUNNER_STDOUT_BEGIN:$runId" -EndMarker "S4X_RUNNER_STDOUT_END:$runId"
    $stderr = Get-MarkedSection -Text $output -BeginMarker "S4X_RUNNER_STDERR_BEGIN:$runId" -EndMarker "S4X_RUNNER_STDERR_END:$runId"
    return [pscustomobject]@{
        command = $Command
        processExitCode = $processExitCode
        output = $output
        result = $result
        stdout = $stdout
        stderr = $stderr
    }
}

function Test-Case {
    param([string]$Name, [scriptblock]$Test)
    & $Test
    $script:passed++
    Write-Output "PASS: $Name"
}

Test-Case 'successful native command returns exit code zero' {
    $run = Invoke-Runner -Command "& cmd.exe /d /s /c 'echo hello-from-runner'"
    Assert-Equal $run.processExitCode 0 'Outer runner exit code mismatch.'
    Assert-Equal $run.result.success $true 'Structured success mismatch.'
    Assert-Equal $run.result.exitCode 0 'Structured exit code mismatch.'
    Assert-Equal $run.result.schemaVersion 2 'Schema mismatch.'
    Assert-Equal $run.result.commandSha256 (Get-Sha256 $run.command) 'Command hash mismatch.'
    Assert-Contains $run.stdout 'hello-from-runner' 'Standard output mismatch.'
    Assert-Equal $run.stderr '' 'Standard error should be empty.'
}

Test-Case 'native failure preserves its nonzero exit code and stderr' {
    $run = Invoke-Runner -Command "& cmd.exe /d /s /c 'echo native-failure 1>&2 & exit /b 7'"
    Assert-Equal $run.processExitCode 7 'Outer runner exit code mismatch.'
    Assert-Equal $run.result.success $false 'Structured success mismatch.'
    Assert-Equal $run.result.exitCode 7 'Native exit code was not preserved.'
    Assert-Contains $run.stderr 'native-failure' 'Native stderr mismatch.'
}

Test-Case 'terminating PowerShell error becomes exit code one' {
    $run = Invoke-Runner -Command "throw 'intentional-powershell-failure'"
    Assert-Equal $run.processExitCode 1 'Outer runner exit code mismatch.'
    Assert-Equal $run.result.success $false 'Structured success mismatch.'
    Assert-Equal $run.result.exitCode 1 'PowerShell error exit code mismatch.'
    Assert-Contains $run.stderr 'intentional-powershell-failure' 'PowerShell error was not captured.'
}

Test-Case 'stderr with exit code zero remains a successful command' {
    $run = Invoke-Runner -Command "[Console]::Error.WriteLine('diagnostic-warning'); Write-Output 'completed'"
    Assert-Equal $run.processExitCode 0 'Outer runner exit code mismatch.'
    Assert-Equal $run.result.success $true 'A zero exit code should remain successful.'
    Assert-Contains $run.stdout 'completed' 'Standard output mismatch.'
    Assert-Contains $run.stderr 'diagnostic-warning' 'Standard error mismatch.'
}

Test-Case 'timeout terminates the child process tree and returns 124' {
    $run = Invoke-Runner -Command 'Start-Sleep -Seconds 5' -TimeoutSeconds 1
    Assert-Equal $run.processExitCode 124 'Outer timeout exit code mismatch.'
    Assert-Equal $run.result.success $false 'Timeout cannot be successful.'
    Assert-Equal $run.result.timedOut $true 'Timeout flag mismatch.'
    Assert-Equal $run.result.exitCode 124 'Structured timeout exit code mismatch.'
    Assert-Contains $run.result.runnerError 'exceeded the 1 second timeout' 'Timeout diagnostic mismatch.'
}

Test-Case 'multiline, quoting, symbols, and Unicode survive Base64 transport' {
    $accentedE = [char]0x00E9
    $command = @'
Write-Output 'line one'
Write-Output 'symbols: "double" ''single'' & | < >'
Write-Output ('unicode: caf' + [char]0x00E9)
'@
    $run = Invoke-Runner -Command $command
    Assert-Equal $run.processExitCode 0 'Outer runner exit code mismatch.'
    Assert-Contains $run.stdout 'line one' 'Multiline output mismatch.'
    Assert-Contains $run.stdout 'symbols: "double" ''single'' & | < >' 'Quoted/symbol output mismatch.'
    Assert-Contains $run.stdout ("unicode: caf" + $accentedE) 'Unicode output mismatch.'
}

Test-Case 'large output is bounded and marked as truncated' {
    $run = Invoke-Runner -Command "Write-Output ('x' * 30000)"
    Assert-Equal $run.processExitCode 0 'Outer runner exit code mismatch.'
    Assert-Equal $run.result.stdoutTruncated $true 'Large output should be marked truncated.'
    Assert-Contains $run.stdout '[TRUNCATED BY SOLVE4X RUNNER]' 'Truncation marker mismatch.'
}

Write-Output "All $script:passed PowerShell runner tests passed."
