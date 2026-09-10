param(
    [string]$Python = "python.exe",
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Arguments
)
# Pass native arguments as arguments. JSON payloads belong in --request-file/stdin.
$entry = Join-Path $PSScriptRoot 'mp'
& $Python $entry @Arguments
exit $LASTEXITCODE
