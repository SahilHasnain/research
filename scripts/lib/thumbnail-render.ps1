<#
  Render a 1280x720 YouTube thumbnail from a source image and stamp
  "NO EXPLANATION" (+ optional title/artist).

  Used by scripts/lib/thumbnail.cjs with -Layout band (the style chosen for the
  pipeline). The other layouts are kept for experimentation.

  Usage:
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\research\thumbnail-render.ps1 `
      -Base <image> -Out <jpg> -Layout badge|band|tag `
      [-Kicker "NO EXPLANATION"] [-Title "Chamane Taiba"] [-Artist "Owais Raza Qadri"] `
      [-Accent "#E53935"] [-TitleSize 64] [-KickerSize 46]

  Layouts:
    badge = rounded pill in the top-left corner (title only when -Title is given)
    band  = bottom gradient with kicker + wrapped title + artist
    tag   = translucent full-width strip across the top
#>
param(
  [Parameter(Mandatory = $true)][string]$Base,
  [Parameter(Mandatory = $true)][string]$Out,
  [ValidateSet("badge", "band", "tag")][string]$Layout = "band",
  [string]$Kicker = "NO EXPLANATION",
  [string]$Title = "",
  [string]$Artist = "",
  [string]$Accent = "#E53935",
  [int]$KickerSize = 46,
  [int]$TitleSize = 64,
  [int]$ArtistSize = 34
)

Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = "Stop"

$W = 1280
$H = 720
$Margin = 56
$script:CanvasW = $W
$script:CanvasH = $H

function Get-Color([string]$hex) {
  return [System.Drawing.ColorTranslator]::FromHtml($hex)
}

function New-RoundedPath([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
  $p = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $d = [float]($r * 2)
  if ($d -gt $h) { $d = $h }
  if ($d -gt $w) { $d = $w }
  $p.AddArc($x, $y, $d, $d, [float]180, [float]90)
  $p.AddArc(($x + $w - $d), $y, $d, $d, [float]270, [float]90)
  $p.AddArc(($x + $w - $d), ($y + $h - $d), $d, $d, [float]0, [float]90)
  $p.AddArc($x, ($y + $h - $d), $d, $d, [float]90, [float]90)
  $p.CloseFigure()
  return $p
}

function Get-TextWidth($graphics, [string]$text, $font) {
  $fmt = [System.Drawing.StringFormat]::GenericTypographic
  return [double]$graphics.MeasureString($text, $font, 4000, $fmt).Width
}

function Get-WrappedLines($graphics, [string]$text, $font, [double]$maxWidth) {
  $result = [System.Collections.Generic.List[string]]::new()
  $words = @($text -split '\s+' | Where-Object { $_ -ne "" })
  if ($words.Count -eq 0) { return $result }
  $current = ""
  foreach ($word in $words) {
    $try = if ($current) { "$current $word" } else { $word }
    if ((Get-TextWidth $graphics $try $font) -le $maxWidth -or $current -eq "") {
      $current = $try
    } else {
      $result.Add($current)
      $current = $word
    }
  }
  if ($current) { $result.Add($current) }
  return $result
}

function Draw-OutlinedText($graphics, [string]$text, $font, [float]$x, [float]$y, $fill, $stroke, [float]$strokeWidth) {
  $fmt = [System.Drawing.StringFormat]::new()
  $fmt.FormatFlags = [System.Drawing.StringFormatFlags]::MeasureTrailingSpaces
  $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $origin = [System.Drawing.PointF]::new($x, $y)
  $path.AddString($text, $font.FontFamily, [int]$font.Style, [float]$font.Size, $origin, $fmt)

  # soft drop shadow first, then stroke, then fill
  $shadowBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(150, 0, 0, 0))
  $shadowPath = $path.Clone()
  $matrix = [System.Drawing.Drawing2D.Matrix]::new()
  $matrix.Translate([float]4, [float]5)
  $shadowPath.Transform($matrix)
  $graphics.FillPath($shadowBrush, $shadowPath)
  $matrix.Dispose()
  $shadowPath.Dispose()
  $shadowBrush.Dispose()

  if ($strokeWidth -gt 0) {
    $pen = [System.Drawing.Pen]::new($stroke, $strokeWidth)
    $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    $graphics.DrawPath($pen, $path)
    $pen.Dispose()
  }
  $fillBrush = [System.Drawing.SolidBrush]::new($fill)
  $graphics.FillPath($fillBrush, $path)
  $fillBrush.Dispose()
  $fmt.Dispose()
  $path.Dispose()
}

function Draw-BottomScrim($graphics, [float]$fromY, [int]$alpha) {
  $rect = [System.Drawing.RectangleF]::new([float]0, $fromY, [float]$script:CanvasW, [float]($script:CanvasH - $fromY))
  $c1 = [System.Drawing.Color]::FromArgb(0, 0, 0, 0)
  $c2 = [System.Drawing.Color]::FromArgb($alpha, 0, 0, 0)
  $brush = [System.Drawing.Drawing2D.LinearGradientBrush]::new($rect, $c1, $c2, [float]90)
  $graphics.FillRectangle($brush, $rect)
  $brush.Dispose()
}

# --- canvas ---------------------------------------------------------------
$src = [System.Drawing.Image]::FromFile((Resolve-Path $Base))
$bmp = [System.Drawing.Bitmap]::new($W, $H)
$bmp.SetResolution(72, 72)
$graphics = [System.Drawing.Graphics]::FromImage($bmp)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias

# cover-crop the source into 1280x720
$scale = [Math]::Max(($W / $src.Width), ($H / $src.Height))
$dw = $src.Width * $scale
$dh = $src.Height * $scale
$dx = ($W - $dw) / 2
$dy = ($H - $dh) / 2
$graphics.DrawImage($src, [float]$dx, [float]$dy, [float]$dw, [float]$dh)

$accentColor = [System.Drawing.ColorTranslator]::FromHtml($Accent)
$white = [System.Drawing.Color]::White
$artistFill = [System.Drawing.ColorTranslator]::FromHtml("#E6E6E6")
$stroke = [System.Drawing.Color]::FromArgb(230, 0, 0, 0)
$kickerFill = [System.Drawing.ColorTranslator]::FromHtml("#FFD400")

$kickerFont = [System.Drawing.Font]::new("Impact", [float]$KickerSize, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$titleFont = [System.Drawing.Font]::new("Arial Black", [float]$TitleSize, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$artistFont = [System.Drawing.Font]::new("Segoe UI Semibold", [float]$ArtistSize, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)

if ($Layout -eq "badge") {
  $padX = 30
  $pillH = [double]($KickerSize + 34)
  $textWidth = Get-TextWidth $graphics $Kicker $kickerFont
  $pillW = [double]($textWidth + $padX * 2)
  $pill = New-RoundedPath ([float]$Margin) ([float]$Margin) ([float]$pillW) ([float]$pillH) ([float]($pillH / 2))
  $pillColor = [System.Drawing.Color]::FromArgb(242, $accentColor.R, $accentColor.G, $accentColor.B)
  $pillBrush = [System.Drawing.SolidBrush]::new($pillColor)
  $graphics.FillPath($pillBrush, $pill)
  $pillBrush.Dispose()
  Draw-OutlinedText $graphics $Kicker $kickerFont ([float]($Margin + $padX)) ([float]($Margin + 15)) $white $stroke ([float]3)
  $pill.Dispose()

  if ($Title) {
    Draw-BottomScrim $graphics ([float]380) 225
    $lines = Get-WrappedLines $graphics $Title $titleFont 1080
    $lineH = [double]($TitleSize * 1.12)
    $bottom = [double]($H - $Margin - 40)
    $startY = $bottom - ($lines.Count - 1) * $lineH
    for ($i = 0; $i -lt $lines.Count; $i++) {
      $lineY = $startY + $i * $lineH
      Draw-OutlinedText $graphics $lines[$i] $titleFont ([float]$Margin) ([float]$lineY) $white $stroke ([float]7)
    }
    if ($Artist) {
      Draw-OutlinedText $graphics $Artist $artistFont ([float]$Margin) ([float]($bottom + 16)) $artistFill $stroke ([float]4)
    }
  }
}
elseif ($Layout -eq "band") {
  Draw-BottomScrim $graphics ([float]300) 235

  $lines = [System.Collections.Generic.List[string]]::new()
  if ($Title) { $lines = Get-WrappedLines $graphics $Title $titleFont 1120 }
  $lineH = [double]($TitleSize * 1.12)
  $titleH = [double]($lines.Count * $lineH)

  $bottom = [double]($H - $Margin)
  if ($Artist) { $bottom = $bottom - ($ArtistSize + 18) }
  $titleTop = [double]($bottom - $titleH)

  # accent rule above the kicker
  $ruleY = [double]($titleTop - $KickerSize - 46)
  $ruleBrush = [System.Drawing.SolidBrush]::new($accentColor)
  $graphics.FillRectangle($ruleBrush, [float]$Margin, [float]$ruleY, [float]90, [float]10)
  $ruleBrush.Dispose()

  Draw-OutlinedText $graphics $Kicker $kickerFont ([float]$Margin) ([float]($ruleY + 18)) $kickerFill $stroke ([float]6)

  for ($i = 0; $i -lt $lines.Count; $i++) {
    $lineY = $titleTop + $i * $lineH
    Draw-OutlinedText $graphics $lines[$i] $titleFont ([float]$Margin) ([float]$lineY) $white $stroke ([float]7)
  }
  if ($Artist) {
    Draw-OutlinedText $graphics $Artist $artistFont ([float]$Margin) ([float]($bottom + 4)) $artistFill $stroke ([float]4)
  }
}
elseif ($Layout -eq "tag") {
  $stripH = [double]($KickerSize + 44)
  $stripBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(210, 0, 0, 0))
  $graphics.FillRectangle($stripBrush, [float]0, [float]0, [float]$W, [float]$stripH)
  $stripBrush.Dispose()
  $barBrush = [System.Drawing.SolidBrush]::new($accentColor)
  $graphics.FillRectangle($barBrush, [float]0, [float]$stripH, [float]$W, [float]8)
  $barBrush.Dispose()

  $label = $Kicker
  if ($Title) { $label = "$Kicker  |  $Title" }
  $textWidth = Get-TextWidth $graphics $label $kickerFont
  if ($textWidth -gt ($W - 2 * $Margin)) {
    $label = $Kicker
    $textWidth = Get-TextWidth $graphics $label $kickerFont
  }
  $labelX = ($W - $textWidth) / 2
  Draw-OutlinedText $graphics $label $kickerFont ([float]$labelX) ([float]22) $white $stroke ([float]5)
}

$graphics.Dispose()
$src.Dispose()

$outDir = Split-Path -Parent $Out
if ($outDir -and -not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }

$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq "image/jpeg" }
$encoderParams = [System.Drawing.Imaging.EncoderParameters]::new(1)
$encoderParams.Param[0] = [System.Drawing.Imaging.EncoderParameter]::new([System.Drawing.Imaging.Encoder]::Quality, [long]92)
$bmp.Save($Out, $codec, $encoderParams)
$bmp.Dispose()
$encoderParams.Dispose()

$size = (Get-Item $Out).Length
Write-Output ("{0}  {1:N0} KB  [{2}]" -f (Split-Path -Leaf $Out), ($size / 1KB), $Layout)
if ($size -gt 2MB) { Write-Warning "over YouTube's 2 MB limit: $Out" }
