# Convert every text file in the package dir to UTF-8 (no BOM) + LF newlines.
# Required because cmd/* and wizard/* are executed by bash on fnOS: CRLF would
# break `#!/bin/bash`, and a UTF-8 BOM would break JSON parsing.
# NOTE: keep this file ASCII-only (Windows PowerShell 5.1 reads .ps1 as ANSI
#       when there is no BOM, so non-ASCII literals would be garbled).
param(
  [Parameter(Mandatory = $true)][string]$Path
)

$utf8 = New-Object System.Text.UTF8Encoding($false)
$skipExt = @('.png', '.jpg', '.jpeg', '.gif', '.ico', '.zip', '.gz', '.tgz', '.fpk', '.woff', '.woff2')

Get-ChildItem -LiteralPath $Path -Recurse -File | ForEach-Object {
  $rel = $_.FullName.Substring($Path.Length).Replace('\', '/')
  if ($rel -like '/app/server/*') { return }
  if ($skipExt -contains $_.Extension.ToLower()) { return }

  $text = [System.IO.File]::ReadAllText($_.FullName)
  $lf = $text.Replace("`r`n", "`n").Replace("`r", "`n")
  [System.IO.File]::WriteAllText($_.FullName, $lf, $utf8)
  Write-Host ("LF   " + $rel)
}
