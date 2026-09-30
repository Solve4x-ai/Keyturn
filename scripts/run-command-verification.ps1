$ErrorActionPreference = 'Stop'

$node = 'C:\Program Files\nodejs\node.exe'
$verifier = 'C:\Mission-Control\scripts\verify-command-profile.mjs'
$stdout = 'C:\tmp\ninja-command-verify.out.log'
$stderr = 'C:\tmp\ninja-command-verify.err.log'

$process = Start-Process `
  -FilePath $node `
  -ArgumentList @($verifier) `
  -WorkingDirectory 'C:\Mission-Control' `
  -RedirectStandardOutput $stdout `
  -RedirectStandardError $stderr `
  -WindowStyle Hidden `
  -Wait `
  -PassThru

exit $process.ExitCode
