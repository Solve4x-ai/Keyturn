[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateNotNullOrEmpty()]
    [string]$CommandBase64,

    [Parameter(Position = 1)]
    [string]$RunId = '',

    [Parameter(Position = 2)]
    [ValidateRange(1, 900)]
    [int]$TimeoutSeconds = 120
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$maximumCombinedStreamCharacters = 24000
$maximumErrorCharacters = 8000
$startedUtc = [DateTime]::UtcNow
$workingDirectory = Join-Path $env:TEMP ("Solve4xRunner-{0}" -f ([guid]::NewGuid().ToString('N')))
$stdoutPath = Join-Path $workingDirectory 'stdout.txt'
$stderrPath = Join-Path $workingDirectory 'stderr.txt'
$exitCodePath = Join-Path $workingDirectory 'exit-code.txt'
$exitCodeTempPath = Join-Path $workingDirectory 'exit-code.tmp'
$batchPath = Join-Path $workingDirectory 'invoke-command.cmd'
$utf8NoBom = New-Object System.Text.UTF8Encoding -ArgumentList $false

function Limit-RunnerStreams {
    param(
        [AllowNull()][string]$StandardOutput,
        [AllowNull()][string]$StandardError
    )

    if ($null -eq $StandardOutput) { $StandardOutput = '' }
    if ($null -eq $StandardError) { $StandardError = '' }

    $errorBudget = [Math]::Min($maximumErrorCharacters, $maximumCombinedStreamCharacters)
    $errorWasTruncated = $StandardError.Length -gt $errorBudget
    if ($errorWasTruncated) {
        $StandardError = $StandardError.Substring(0, $errorBudget) + "`r`n[TRUNCATED BY SOLVE4X RUNNER]"
    }

    $outputBudget = [Math]::Max(0, $maximumCombinedStreamCharacters - $StandardError.Length)
    $outputWasTruncated = $StandardOutput.Length -gt $outputBudget
    if ($outputWasTruncated) {
        $StandardOutput = $StandardOutput.Substring(0, $outputBudget) + "`r`n[TRUNCATED BY SOLVE4X RUNNER]"
    }

    return [pscustomobject]@{
        stdout = $StandardOutput
        stderr = $StandardError
        stdoutTruncated = $outputWasTruncated
        stderrTruncated = $errorWasTruncated
    }
}

function Write-RunnerReport {
    param(
        [Parameter(Mandatory = $true)][System.Collections.IDictionary]$Result,
        [AllowNull()][string]$StandardOutput,
        [AllowNull()][string]$StandardError
    )

    $statusText = if ($Result.success) { 'SUCCESS' } elseif ($Result.timedOut) { 'TIMED OUT' } else { 'FAILED' }
    $timeoutText = if ($Result.timedOut) { 'Yes' } else { 'No' }
    $exitCodeText = if ($null -eq $Result.exitCode) { 'Unavailable' } else { [string]$Result.exitCode }

    Write-Output '============================================================'
    Write-Output 'SOLVE4X APPROVED POWERSHELL RUNNER'
    Write-Output '============================================================'
    Write-Output ("Status          : {0}" -f $statusText)
    Write-Output ("Exit code       : {0}" -f $exitCodeText)
    Write-Output ("Timed out       : {0}" -f $timeoutText)
    Write-Output ("Duration        : {0:N3} seconds" -f ($Result.durationMs / 1000))
    Write-Output ("Run ID          : {0}" -f $Result.runId)
    Write-Output ("Command SHA-256 : {0}" -f $Result.commandSha256)
    if (-not [string]::IsNullOrWhiteSpace([string]$Result.runnerError)) {
        Write-Output ("Runner error    : {0}" -f $Result.runnerError)
    }

    Write-Output ''
    Write-Output '-------------------- STANDARD OUTPUT -----------------------'
    Write-Output ("S4X_RUNNER_STDOUT_BEGIN:{0}" -f $Result.runId)
    if ([string]::IsNullOrEmpty($StandardOutput)) {
        Write-Output '(none)'
    }
    else {
        Write-Output $StandardOutput
    }
    Write-Output ("S4X_RUNNER_STDOUT_END:{0}" -f $Result.runId)

    Write-Output ''
    Write-Output '-------------------- STANDARD ERROR ------------------------'
    Write-Output ("S4X_RUNNER_STDERR_BEGIN:{0}" -f $Result.runId)
    if ([string]::IsNullOrEmpty($StandardError)) {
        Write-Output '(none)'
    }
    else {
        Write-Output $StandardError
    }
    Write-Output ("S4X_RUNNER_STDERR_END:{0}" -f $Result.runId)

    Write-Output ''
    Write-Output '-------------------- MACHINE RESULT ------------------------'
    Write-Output 'S4X_RUNNER_RESULT_BEGIN'
    Write-Output ($Result | ConvertTo-Json -Compress -Depth 5)
    Write-Output 'S4X_RUNNER_RESULT_END'
    Write-Output '============================================================'
}

function Get-TextFileContent {
    param([Parameter(Mandatory = $true)][string]$LiteralPath)
    if (-not (Test-Path -LiteralPath $LiteralPath -PathType Leaf)) { return '' }
    return [IO.File]::ReadAllText($LiteralPath, $utf8NoBom)
}

try {
    if ([string]::IsNullOrWhiteSpace($RunId)) {
        $RunId = [guid]::NewGuid().ToString()
    }

    $parsedRunId = [guid]::Empty
    if (-not [guid]::TryParse($RunId, [ref]$parsedRunId)) {
        throw 'RunId must be a valid GUID.'
    }
    $RunId = $parsedRunId.ToString()

    try {
        $commandBytes = [Convert]::FromBase64String($CommandBase64)
        $command = [Text.Encoding]::Unicode.GetString($commandBytes)
    }
    catch {
        throw 'CommandBase64 is not valid UTF-16LE Base64.'
    }

    if ([string]::IsNullOrWhiteSpace($command)) {
        throw 'Decoded command is empty.'
    }

    $sha256 = [Security.Cryptography.SHA256]::Create()
    try {
        $utf8CommandBytes = $utf8NoBom.GetBytes($command)
        $commandHash = ([BitConverter]::ToString($sha256.ComputeHash($utf8CommandBytes))).Replace('-', '').ToLowerInvariant()
    }
    finally {
        $sha256.Dispose()
    }

    New-Item -ItemType Directory -Path $workingDirectory -Force | Out-Null

    # The child envelope gives native commands and PowerShell errors consistent exit semantics.
    # A command that explicitly calls `exit` still propagates its chosen exit code.
    $childEnvelope = @"
`$ErrorActionPreference = 'Stop'
`$ProgressPreference = 'SilentlyContinue'
`$s4xUtf8 = New-Object System.Text.UTF8Encoding -ArgumentList `$false
`$OutputEncoding = `$s4xUtf8
[Console]::OutputEncoding = `$s4xUtf8
`$global:LASTEXITCODE = `$null
try {
    `$s4xBytes = [Convert]::FromBase64String('$CommandBase64')
    `$s4xCommand = [Text.Encoding]::Unicode.GetString(`$s4xBytes)
    `$s4xScriptBlock = [ScriptBlock]::Create(`$s4xCommand)
    & `$s4xScriptBlock
    `$s4xPowerShellSucceeded = `$?
    `$s4xNativeExitCode = `$global:LASTEXITCODE
    if (-not `$s4xPowerShellSucceeded) { exit 1 }
    if (`$null -ne `$s4xNativeExitCode) { exit ([int]`$s4xNativeExitCode) }
    exit 0
}
catch {
    [Console]::Error.WriteLine((`$_ | Out-String))
    exit 1
}
"@
    $childEnvelopeBase64 = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($childEnvelope))
    $powershellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

    # cmd.exe records the child PowerShell exit code in a sidecar file. This is intentional:
    # NinjaOne's host returned a null Process.ExitCode even after WaitForExit/Refresh.
    $batchLines = @(
        '@echo off',
        'setlocal',
        ('"{0}" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand {1} 1>"{2}" 2>"{3}"' -f $powershellPath, $childEnvelopeBase64, $stdoutPath, $stderrPath),
        'set "S4X_EXIT=%ERRORLEVEL%"',
        ('>"{0}" echo %S4X_EXIT%' -f $exitCodeTempPath),
        ('move /y "{0}" "{1}" >nul' -f $exitCodeTempPath, $exitCodePath),
        'exit /b %S4X_EXIT%'
    )
    [IO.File]::WriteAllLines($batchPath, $batchLines, [Text.Encoding]::ASCII)

    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $env:ComSpec
    $startInfo.Arguments = ('/d /q /c call "{0}"' -f $batchPath)
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true

    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $startInfo
    if (-not $process.Start()) {
        throw 'Failed to start the child PowerShell process.'
    }

    $finished = $process.WaitForExit($TimeoutSeconds * 1000)
    $timedOut = -not $finished
    if ($timedOut) {
        $previousErrorActionPreference = $ErrorActionPreference
        try {
            $ErrorActionPreference = 'SilentlyContinue'
            $taskkillOutput = (& taskkill.exe /PID $process.Id /T /F 2>&1 | Out-String).Trim()
            $taskkillExitCode = $LASTEXITCODE
        }
        finally {
            $ErrorActionPreference = $previousErrorActionPreference
        }
        [void]$process.WaitForExit(10000)
        $exitCode = 124
        if ($taskkillExitCode -eq 0) {
            $runnerError = "Command exceeded the $TimeoutSeconds second timeout and its process tree was terminated."
        }
        else {
            $runnerError = "Command exceeded the $TimeoutSeconds second timeout. Process-tree termination returned exit code ${taskkillExitCode}: $taskkillOutput"
        }
    }
    else {
        $process.WaitForExit()
        if (-not (Test-Path -LiteralPath $exitCodePath -PathType Leaf)) {
            throw 'The child process completed without recording an exit code.'
        }

        $exitCodeText = (Get-Content -LiteralPath $exitCodePath -Raw -ErrorAction Stop).Trim()
        $parsedExitCode = 0
        if (-not [int]::TryParse($exitCodeText, [ref]$parsedExitCode)) {
            throw ("The child process recorded an invalid exit code: '{0}'." -f $exitCodeText)
        }
        $exitCode = $parsedExitCode
        $runnerError = $null
    }

    $stdout = Get-TextFileContent -LiteralPath $stdoutPath
    $stderr = Get-TextFileContent -LiteralPath $stderrPath
    $limitedStreams = Limit-RunnerStreams -StandardOutput $stdout -StandardError $stderr
    $completedUtc = [DateTime]::UtcNow

    $result = [ordered]@{
        schemaVersion = 2
        runId = $RunId
        success = (-not $timedOut -and $exitCode -eq 0)
        timedOut = $timedOut
        exitCode = $exitCode
        commandSha256 = $commandHash
        startedUtc = $startedUtc.ToString('o')
        completedUtc = $completedUtc.ToString('o')
        durationMs = [Math]::Round(($completedUtc - $startedUtc).TotalMilliseconds)
        stdoutCharacters = $limitedStreams.stdout.Length
        stderrCharacters = $limitedStreams.stderr.Length
        stdoutTruncated = $limitedStreams.stdoutTruncated
        stderrTruncated = $limitedStreams.stderrTruncated
        runnerError = $runnerError
    }

    Write-RunnerReport -Result $result -StandardOutput $limitedStreams.stdout -StandardError $limitedStreams.stderr
    exit $exitCode
}
catch {
    $completedUtc = [DateTime]::UtcNow
    $runnerMessage = $_.Exception.Message
    $result = [ordered]@{
        schemaVersion = 2
        runId = $RunId
        success = $false
        timedOut = $false
        exitCode = 125
        commandSha256 = $commandHash
        startedUtc = $startedUtc.ToString('o')
        completedUtc = $completedUtc.ToString('o')
        durationMs = [Math]::Round(($completedUtc - $startedUtc).TotalMilliseconds)
        stdoutCharacters = 0
        stderrCharacters = $runnerMessage.Length
        stdoutTruncated = $false
        stderrTruncated = $false
        runnerError = $runnerMessage
    }

    Write-RunnerReport -Result $result -StandardOutput '' -StandardError $runnerMessage
    exit 125
}
finally {
    if (Test-Path -LiteralPath $workingDirectory) {
        Remove-Item -LiteralPath $workingDirectory -Recurse -Force -ErrorAction SilentlyContinue
    }
}
