# Write the project version (package.json "version", the single source of truth)
# into the fnOS package manifest (nasmp/manifest).
# Usage: powershell -ExecutionPolicy Bypass -File sync-version.ps1 `
#          -From ..\package.json -Manifest .\nasmp\manifest
# NOTE: keep this file ASCII-only (Windows PowerShell 5.1 reads .ps1 as ANSI
#       when there is no BOM, so non-ASCII literals would be garbled).
# NOTE: always read/write UTF-8 explicitly. Get-Content without -Encoding uses
#       the ANSI code page on Windows PowerShell, which would double-encode the
#       manifest's Chinese display_name/desc and corrupt the file.
param(
  [Parameter(Mandatory = $true)][string]$From,
  [Parameter(Mandatory = $true)][string]$Manifest
)

$utf8 = New-Object System.Text.UTF8Encoding($false)
$fromPath = (Resolve-Path -LiteralPath $From).Path
$manifestPath = (Resolve-Path -LiteralPath $Manifest).Path

$json = ConvertFrom-Json ([System.IO.File]::ReadAllText($fromPath, $utf8))
$version = ([string]$json.version).Trim()
if (-not $version) {
  Write-Error ("no 'version' field in " + $fromPath)
  exit 1
}

$text = [System.IO.File]::ReadAllText($manifestPath, $utf8)
if ($text -match '(?m)^[ \t]*version[ \t]*=') {
  # only the version line is touched; every other byte (incl. UTF-8 Chinese) is kept
  $text = [regex]::Replace($text, '(?m)^[ \t]*version[ \t]*=.*$',
    ('version               = ' + $version))
} else {
  $text = $text.TrimEnd("`r", "`n") + "`n" + 'version               = ' + $version + "`n"
}

# keep the package LF-only
$text = $text.Replace("`r`n", "`n").Replace("`r", "`n")
[System.IO.File]::WriteAllText($manifestPath, $text, $utf8)

Write-Host ("    manifest version -> " + $version)
