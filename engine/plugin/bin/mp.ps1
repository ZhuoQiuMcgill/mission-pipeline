#!/usr/bin/env pwsh
# `mp` in PowerShell for a harness that puts this directory on its PATH: runs the engine's launcher.
# In PowerShell `mp` is an alias of Move-ItemProperty, so call this script as `mp.ps1`. Arguments are
# passed natively (quotes intact, unlike `mp.cmd`), piped input is passed through, and the script
# exits with the launcher's code.
$launcher = Join-Path $PSScriptRoot '../../bin/mp.mjs'
$node = if ($env:MP_NODE) { $env:MP_NODE } else { 'node' }
try {
  if ($MyInvocation.ExpectingInput) {
    $input | & $node $launcher $args
  } else {
    & $node $launcher $args
  }
} catch {
  Write-Error "mp: cannot start Node: $_"
  exit 1
}
exit $LASTEXITCODE
