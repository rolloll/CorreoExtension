# Correo installer / updater.
# Installs the latest GitHub release to C:\Program Files (x86)\Correo (needs admin).
#   One-liner  :  irm https://github.com/rolloll/CorreoExtension/releases/latest/download/install.ps1 | iex
#   Saved file :  powershell -ExecutionPolicy Bypass -File install.ps1
#   First time : then in Chrome load that folder once
#                (chrome://extensions -> Developer mode -> Load unpacked).
#   Updating   : run this again, then press Correo's reload button in chrome://extensions.
# Optional overrides (environment variables): CORREO_DIR, CORREO_REPO.
#
# Keep this file ASCII-only and BOM-free. GitHub serves release assets as
# application/octet-stream, which Windows PowerShell 5.1's irm decodes as
# Latin-1: non-ASCII text turns to garbage and a BOM breaks the first line.
# No param() block either: "irm | iex" evaluates the text as an expression,
# where a param block is a syntax error. Everything runs inside & { } so its
# variables and $ErrorActionPreference don't leak into the caller's session.
& {
  $ErrorActionPreference = "Stop"
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

  $Dir = if ($env:CORREO_DIR) { $env:CORREO_DIR } else { Join-Path ${env:ProgramFiles(x86)} "Correo" }
  $Repo = if ($env:CORREO_REPO) { $env:CORREO_REPO } else { "rolloll/CorreoExtension" }

  function Test-Writable([string]$path) {
    try {
      New-Item -ItemType Directory -Force -Path $path | Out-Null
      $probe = Join-Path $path ".write-test"
      Set-Content -Path $probe -Value "x" -ErrorAction Stop
      Remove-Item $probe -Force
      return $true
    } catch { return $false }
  }

  # Program Files is read-only for normal users: relaunch elevated if needed.
  if (-not (Test-Writable $Dir)) {
    Write-Host "Administrator permission is needed. Click 'Yes' in the permission prompt..."
    if ($PSCommandPath) {
      Start-Process powershell -Verb RunAs -ArgumentList @(
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$PSCommandPath`""
      )
    } else {
      $url = "https://github.com/$Repo/releases/latest/download/install.ps1"
      Start-Process powershell -Verb RunAs -ArgumentList @(
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "`$env:CORREO_PAUSE='1'; irm $url | iex"
      )
    }
    return
  }

  try {
    Write-Host "Checking the latest release..."
    $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers @{ "User-Agent" = "correo-installer" }
    $asset = $release.assets | Where-Object { $_.name -like "Correo-v*.zip" } | Select-Object -First 1
    if (-not $asset) { throw "The release has no Correo zip file." }

    $tmp = Join-Path $env:TEMP ("correo-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    $zip = Join-Path $tmp $asset.name
    Write-Host "Downloading $($asset.name)..."
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zip -UseBasicParsing
    $stage = Join-Path $tmp "files"
    Expand-Archive -Path $zip -DestinationPath $stage -Force

    if (-not (Test-Path (Join-Path $stage "manifest.json"))) { throw "manifest.json is missing from the zip." }

    # Mirror into place so files removed in a newer version don't linger.
    New-Item -ItemType Directory -Force -Path $Dir | Out-Null
    robocopy $stage $Dir /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "Copying files failed (robocopy $LASTEXITCODE)." }

    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host ""
    Write-Host "Installed $($release.tag_name) -> $Dir" -ForegroundColor Green
    Write-Host "  First install: Chrome > chrome://extensions > turn on Developer mode > Load unpacked > pick the folder above"
    Write-Host "  Updating     : chrome://extensions > press Correo's reload button"
  } catch {
    Write-Host "Failed: $_" -ForegroundColor Red
  }

  # A window opened by the elevation relaunch (or by double-click) would close
  # instantly; keep it open so the result can be read.
  if ($PSCommandPath -or $env:CORREO_PAUSE) { Read-Host "Press Enter to close" }
}
