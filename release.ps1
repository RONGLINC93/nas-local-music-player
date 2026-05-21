# Auto Release Script
# Usage: .\release.ps1
# Optional: .\release.ps1 -Message "commit message" -AutoIncrement
# -AutoIncrement: Automatically increment minor version (e.g., 1.0.1 → 1.0.2)

param(
    [string]$Message = "",
    [switch]$AutoIncrement = $false
)

# Add Git to PATH if not already present
$gitPath = "C:\Program Files\Git\bin"
if (-not $env:PATH.Contains($gitPath)) {
    $env:PATH = "$gitPath;$env:PATH"
}

# Load .env config
Get-Content ".env" | ForEach-Object {
    if ($_ -match '^([^#][^=]+)=(.*)$') {
        [Environment]::SetEnvironmentVariable($matches[1].Trim(), $matches[2].Trim())
    }
}

$GITHUB_TOKEN = $env:GITHUB_TOKEN
$GITHUB_REPO = $env:GITHUB_REPO

if (-not $GITHUB_TOKEN) {
    Write-Host "Error: GITHUB_TOKEN not set in .env" -ForegroundColor Red
    exit 1
}

# Read version
$versionJsonRaw = [System.IO.File]::ReadAllText((Join-Path $PWD "version.json"), [System.Text.Encoding]::UTF8)
$versionJson = $versionJsonRaw | ConvertFrom-Json
$VERSION = $versionJson.version
$TAG = "v$VERSION"

# Auto-increment version if requested
if ($AutoIncrement) {
    Write-Host "Auto-incrementing version..." -ForegroundColor Yellow
    $versionParts = $VERSION -split '\.'
    if ($versionParts.Count -eq 3) {
        $major = [int]$versionParts[0]
        $minor = [int]$versionParts[1]
        $patch = [int]$versionParts[2] + 1
        $VERSION = "$major.$minor.$patch"
        $TAG = "v$VERSION"
        
        # Update version.json
        $versionJson.version = $VERSION
        $versionJson.buildTime = [System.DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
        $versionJson.buildNumber = [System.Guid]::NewGuid().ToString("n").Substring(0, 8)
        $newVersionJson = $versionJson | ConvertTo-Json -Depth 10
        [System.IO.File]::WriteAllText((Join-Path $PWD "version.json"), $newVersionJson, [System.Text.Encoding]::UTF8)
        
        Write-Host "Version incremented to: $VERSION" -ForegroundColor Green
    } else {
        Write-Host "Warning: Cannot auto-increment version format: $VERSION" -ForegroundColor Yellow
    }
}

Write-Host "=== Auto Release Script ===" -ForegroundColor Cyan
Write-Host "Version: $VERSION" -ForegroundColor Cyan
Write-Host "Tag: $TAG" -ForegroundColor Cyan
Write-Host ""

# 1. Check for uncommitted changes
$status = git status --porcelain
if ($status) {
    Write-Host "[1/5] Committing changes..." -ForegroundColor Yellow
    
    if ($Message) {
        git add -A
        git commit -m $Message
    } else {
        git add -A
        git commit -m "release: v$VERSION"
    }
    
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Commit failed" -ForegroundColor Red
        exit 1
    }
} else {
    Write-Host "[1/5] No changes to commit, skipping" -ForegroundColor Gray
}

# 2. Push to remote
Write-Host "[2/5] Pushing to GitHub..." -ForegroundColor Yellow
git push origin main
if ($LASTEXITCODE -ne 0) {
    Write-Host "Push failed" -ForegroundColor Red
    exit 1
}

# 3. Check if Tag exists
$existingTag = git tag -l $TAG
if ($existingTag) {
    Write-Host "[3/5] Tag $TAG already exists, skipping" -ForegroundColor Gray
} else {
    Write-Host "[3/5] Creating Tag $TAG..." -ForegroundColor Yellow
    git tag -a $TAG -m "Release $TAG"
    git push origin $TAG
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Tag creation failed" -ForegroundColor Red
        exit 1
    }
}

# 4. Check if Release exists
Write-Host "[4/5] Checking Release..." -ForegroundColor Yellow
$releaseCheck = Invoke-RestMethod `
    -Uri "https://api.github.com/repos/$GITHUB_REPO/releases/tags/$TAG" `
    -Headers @{ Authorization = "Bearer $GITHUB_TOKEN" } `
    -ErrorAction SilentlyContinue

if ($releaseCheck) {
    Write-Host "Release $TAG already exists, skipping" -ForegroundColor Gray
} else {
    # 5. Create Release
    Write-Host "[5/5] Creating GitHub Release $TAG..." -ForegroundColor Yellow

    # Read release notes from CHANGELOG (UTF-8 encoding)
    $changelog = Get-Content "CHANGELOG.md" -Raw -Encoding UTF8
    $releaseNotes = "Release $TAG"
    
    $pattern = "## [$VERSION]"
    $startIndex = $changelog.IndexOf($pattern)
    if ($startIndex -ge 0) {
        $startIndex = $changelog.IndexOf("`n", $startIndex) + 1
        $nextVersion = $changelog.IndexOf("`n## ", $startIndex)
        if ($nextVersion -ge 0) {
            $releaseNotes = $changelog.Substring($startIndex, $nextVersion - $startIndex).Trim()
        } else {
            $releaseNotes = $changelog.Substring($startIndex).Trim()
        }
    }

    # Create ZIP package
    $zipName = "nas-local-music-player-$VERSION.zip"
    $zipPath = Join-Path $PWD $zipName
    
    $excludeItems = @('.git', 'upgrades', 'temp', 'temp_uploads', '.env', 'PROJECT_MEMORY.md', 'release.ps1')
    $allItems = Get-ChildItem -Path $PWD -Force | Where-Object { 
        $_.Name -notin $excludeItems -and $_.Name -notmatch '\.zip$'
    }
    
    Compress-Archive -Path $allItems.FullName -DestinationPath $zipPath -Force
    Write-Host "Created ZIP: $zipName" -ForegroundColor Green

    # Create Release via API
    $releaseBody = @{
        tag_name = $TAG
        name = "NAS Local Music Player $TAG"
        body = $releaseNotes
        draft = $false
        prerelease = $false
    } | ConvertTo-Json

    # Convert release body to UTF-8 bytes to ensure proper Chinese encoding
    $releaseBodyUtf8 = [System.Text.Encoding]::UTF8.GetBytes($releaseBody)
    
    $release = Invoke-RestMethod `
        -Uri "https://api.github.com/repos/$GITHUB_REPO/releases" `
        -Method POST `
        -Headers @{
            Authorization = "Bearer $GITHUB_TOKEN"
            Accept = "application/vnd.github+json"
            "Content-Type" = "application/json; charset=utf-8"
        } `
        -Body $releaseBodyUtf8

    $releaseId = $release.id
    Write-Host "Release created: $($release.html_url)" -ForegroundColor Green

    # Upload ZIP asset
    Write-Host "Uploading ZIP package..." -ForegroundColor Yellow
    $uploadUrl = $release.upload_url -replace '\{.*\}$', ''
    $fileSize = (Get-Item $zipPath).Length
    
    Invoke-RestMethod `
        -Uri "${uploadUrl}?name=$zipName" `
        -Method POST `
        -Headers @{
            Authorization = "Bearer $GITHUB_TOKEN"
            Accept = "application/vnd.github+json"
            "Content-Type" = "application/zip"
            "Content-Length" = $fileSize
        } `
        -InFile $zipPath

    Write-Host "ZIP uploaded!" -ForegroundColor Green
    
    # Clean up temp ZIP
    Remove-Item $zipPath -Force
}

Write-Host ""
Write-Host "=== Release Complete! ===" -ForegroundColor Cyan
Write-Host "https://github.com/$GITHUB_REPO/releases/tag/$TAG" -ForegroundColor Cyan
