# Generate fnOS app icons from the application logo (public/favicon.png).
#   package icons : ICON.PNG (64)              / ICON_256.PNG (256)
#   desktop entry : app/ui/images/icon_64.png  / app/ui/images/icon_256.png
# The source image is center-cropped to a square, then scaled down, so the
# result is always a straight-cornered square PNG.
# Usage: powershell -ExecutionPolicy Bypass -File make-icons.ps1
# NOTE: keep this file ASCII-only (Windows PowerShell 5.1 reads .ps1 as ANSI
#       when there is no BOM, so non-ASCII literals would be garbled).
param(
  [string]$Root = $PSScriptRoot
)

Add-Type -AssemblyName System.Drawing

$pkg = Join-Path $Root 'nasmp'
$proj = (Resolve-Path (Join-Path $Root '..')).Path
$source = Join-Path $proj 'public\favicon.png'

$targets = @(
  @{ Path = Join-Path $pkg 'ICON_256.PNG'; Size = 256 },
  @{ Path = Join-Path $pkg 'ICON.PNG'; Size = 64 },
  @{ Path = Join-Path $pkg 'app\ui\images\icon_256.png'; Size = 256 },
  @{ Path = Join-Path $pkg 'app\ui\images\icon_64.png'; Size = 64 }
)

$src = $null
$crop = 0
if (Test-Path $source) {
  $src = [System.Drawing.Image]::FromFile($source)
  $crop = [Math]::Min($src.Width, $src.Height)
}

foreach ($t in $targets) {
  $size = [int]$t.Size
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

  if ($src) {
    $sx = [int](($src.Width - $crop) / 2)
    $sy = [int](($src.Height - $crop) / 2)
    $srcRect = New-Object System.Drawing.Rectangle($sx, $sy, $crop, $crop)
    $dstRect = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
    $g.DrawImage($src, $dstRect, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
  } else {
    # fallback: cyan -> blue gradient with a music note glyph (U+266A)
    $rect = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
    $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
      $rect,
      [System.Drawing.Color]::FromArgb(255, 56, 189, 248),
      [System.Drawing.Color]::FromArgb(255, 37, 99, 235),
      45.0
    )
    $g.FillRectangle($brush, $rect)

    $font = New-Object System.Drawing.Font(
      'Microsoft YaHei',
      [single]($size * 0.58),
      [System.Drawing.FontStyle]::Bold,
      [System.Drawing.GraphicsUnit]::Pixel
    )
    $sf = New-Object System.Drawing.StringFormat
    $sf.Alignment = [System.Drawing.StringAlignment]::Center
    $sf.LineAlignment = [System.Drawing.StringAlignment]::Center
    $box = New-Object System.Drawing.RectangleF(0, 0, $size, $size)
    $g.DrawString([string][char]0x266A, $font, [System.Drawing.Brushes]::White, $box, $sf)
  }

  $g.Dispose()
  $dir = Split-Path -Parent $t.Path
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  $bmp.Save($t.Path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()

  Write-Host ("icon " + $t.Path + "  (" + $size + "x" + $size + ")")
}

if ($src) { $src.Dispose() }
if (-not (Test-Path $source)) {
  Write-Host ("WARN: " + $source + " not found - used the fallback glyph")
}
