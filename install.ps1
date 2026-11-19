# Correo installer / updater.
# Installs the latest GitHub release to C:\Program Files (x86)\Correo (needs admin once),
# and registers a small per-user "update helper" so later updates are one click
# inside Correo (no download, no unzip, no admin prompt).
#   One-liner  :  irm https://github.com/rolloll/CorreoExtension/releases/latest/download/install.ps1 | iex
#   Saved file :  powershell -ExecutionPolicy Bypass -File install.ps1
#   First time : then in Chrome load that folder once
#                (chrome://extensions -> Developer mode -> Load unpacked).
#   Updating   : use the "update now" button in Correo (or run this again, then
#                press Correo's reload button in chrome://extensions).
# Overrides exist only for testing and have deliberately unusual names, so a
# variable left behind in a terminal can never redirect a real install (an
# earlier name once sent an update to the Downloads folder):
#   CORREO_TEST_DIR, CORREO_TEST_HOST_DIR, CORREO_TEST_HOST_NAME,
#   CORREO_TEST_NO_REGISTRY, CORREO_REPO
#
# Keep this file ASCII-only and BOM-free. GitHub serves release assets as
# application/octet-stream, which Windows PowerShell 5.1's irm decodes as
# Latin-1: non-ASCII text turns to garbage and a BOM breaks the first line.
# No param() block either: "irm | iex" evaluates the text as an expression,
# where a param block is a syntax error. Everything runs inside & { } so its
# variables and $ErrorActionPreference don't leak into the caller's session.
& {
  $ErrorActionPreference = "Stop"
  $ProgressPreference = "SilentlyContinue"
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

  $Dir = if ($env:CORREO_TEST_DIR) { $env:CORREO_TEST_DIR } else { Join-Path ${env:ProgramFiles(x86)} "Correo" }
  $Repo = if ($env:CORREO_REPO) { $env:CORREO_REPO } else { "rolloll/CorreoExtension" }
  $HostDir = if ($env:CORREO_TEST_HOST_DIR) { $env:CORREO_TEST_HOST_DIR } else { Join-Path $env:LOCALAPPDATA "Correo\host" }
  $HostName = if ($env:CORREO_TEST_HOST_NAME) { $env:CORREO_TEST_HOST_NAME } else { "com.correo.updater" }
  # The extension id is fixed by the "key" in manifest.json.
  $ExtensionId = "lgccffbckaimbimcahkompkggmafodcc"

  # The update helper: Chrome starts it on demand (native messaging), it reads
  # one JSON request on stdin and answers on stdout. It can only fetch the
  # latest release of the configured repo and mirror it into the one folder
  # named in config.json. Nothing else is accepted from the extension.
  $HostScript = @'
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
# Windows PowerShell 5.1 reads BOM-less files as the ANSI code page, which garbles
# Korean text (manifest description, user names in paths): always read as UTF-8.
function Read-Json([string]$path) {
  return [IO.File]::ReadAllText($path, [Text.Encoding]::UTF8) | ConvertFrom-Json
}
$cfg = Read-Json (Join-Path $here "config.json")
$in = [Console]::OpenStandardInput()
$out = [Console]::OpenStandardOutput()

function Send-Reply($obj) {
  $json = $obj | ConvertTo-Json -Compress -Depth 5
  $bytes = [Text.Encoding]::UTF8.GetBytes($json)
  $out.Write([BitConverter]::GetBytes([int]$bytes.Length), 0, 4)
  $out.Write($bytes, 0, $bytes.Length)
  $out.Flush()
}

function Read-Exact([int]$count) {
  $buf = New-Object byte[] $count
  $got = 0
  while ($got -lt $count) {
    $r = $in.Read($buf, $got, $count - $got)
    if ($r -le 0) { return $null }
    $got += $r
  }
  return ,$buf
}

try {
  $lenBytes = Read-Exact 4
  if ($null -eq $lenBytes) { exit 0 }
  $body = Read-Exact ([BitConverter]::ToInt32($lenBytes, 0))
  $msg = [Text.Encoding]::UTF8.GetString($body) | ConvertFrom-Json

  if ($msg.type -eq "ping") {
    $v = ""
    $mf = Join-Path $cfg.extDir "manifest.json"
    if (Test-Path $mf) { $v = (Read-Json $mf).version }
    Send-Reply @{ ok = $true; installedVersion = $v }
  }
  elseif ($msg.type -eq "update") {
    $release = Invoke-RestMethod -Uri ("https://api.github.com/repos/" + $cfg.repo + "/releases/latest") -Headers @{ "User-Agent" = "correo-updater" }
    $asset = $release.assets | Where-Object { $_.name -like "Correo-v*.zip" } | Select-Object -First 1
    if (-not $asset) { throw "The release has no Correo zip file." }
    $tmp = Join-Path $env:TEMP ("correo-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    $zip = Join-Path $tmp $asset.name
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zip -UseBasicParsing
    $stage = Join-Path $tmp "files"
    Expand-Archive -Path $zip -DestinationPath $stage -Force
    $mf = Join-Path $stage "manifest.json"
    if (-not (Test-Path $mf)) { throw "manifest.json is missing from the zip." }
    if ((Read-Json $mf).name -ne "Correo") { throw "The zip is not the Correo extension." }
    New-Item -ItemType Directory -Force -Path $cfg.extDir | Out-Null
    robocopy $stage $cfg.extDir /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw ("Copying files failed (robocopy " + $LASTEXITCODE + ").") }
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    Send-Reply @{ ok = $true; version = ([string]$release.tag_name).TrimStart("v") }
  }
  else {
    Send-Reply @{ ok = $false; error = "unknown request" }
  }
}
catch {
  Send-Reply @{ ok = $false; error = ("" + $_) }
}
'@

  function Test-Writable([string]$path) {
    try {
      New-Item -ItemType Directory -Force -Path $path | Out-Null
      $probe = Join-Path $path ".write-test"
      Set-Content -Path $probe -Value "x" -ErrorAction Stop
      Remove-Item $probe -Force
      return $true
    } catch { return $false }
  }

  function Write-Utf8NoBom([string]$path, [string]$text) {
    [IO.File]::WriteAllText($path, $text, (New-Object Text.UTF8Encoding($false)))
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
    Write-Host "Install folder: $Dir"
    if ($env:CORREO_TEST_DIR) { Write-Host "(test override in effect)" -ForegroundColor Yellow }
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

    # Let the current user update this folder later without admin rights, so the
    # one-click updater works. Only possible while elevated (changing permissions
    # needs more than write access), and only needed the first time: on later
    # updates the user can already write here and this would just print
    # "access denied" for every file.
    $underProgramFiles = $Dir.StartsWith(${env:ProgramFiles(x86)}, [StringComparison]::OrdinalIgnoreCase) -or $Dir.StartsWith($env:ProgramFiles, [StringComparison]::OrdinalIgnoreCase)
    $isElevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if ($underProgramFiles -and $isElevated) {
      icacls "$Dir" /grant "${env:USERDOMAIN}\${env:USERNAME}:(OI)(CI)M" /T /C /Q 2>&1 | Out-Null
    }

    # Install the update helper and register it for Chrome (per-user, no admin).
    New-Item -ItemType Directory -Force -Path $HostDir | Out-Null
    $hostPs1 = Join-Path $HostDir "host.ps1"
    $hostBat = Join-Path $HostDir "host.bat"
    $hostJson = Join-Path $HostDir "$HostName.json"
    Set-Content -Path $hostPs1 -Value $HostScript -Encoding ASCII
    Set-Content -Path $hostBat -Value "@echo off`r`npowershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"%~dp0host.ps1`"" -Encoding ASCII
    Write-Utf8NoBom (Join-Path $HostDir "config.json") (@{ extDir = $Dir; repo = $Repo } | ConvertTo-Json)
    Write-Utf8NoBom $hostJson (@{
      name = $HostName
      description = "Correo update helper"
      path = $hostBat
      type = "stdio"
      allowed_origins = @("chrome-extension://$ExtensionId/")
    } | ConvertTo-Json)
    if (-not $env:CORREO_TEST_NO_REGISTRY) {
      $key = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"
      New-Item -Path $key -Force | Out-Null
      Set-ItemProperty -Path $key -Name "(default)" -Value $hostJson
    }

    Write-Host ""
    Write-Host "Installed $($release.tag_name) -> $Dir" -ForegroundColor Green
    Write-Host "  First install: Chrome > chrome://extensions > turn on Developer mode > Load unpacked > pick the folder above"
    Write-Host "  Already loaded: chrome://extensions > press Correo's reload button, then refresh Gmail/Correo tabs"
    Write-Host "  Next updates : click 'Update now' inside Correo (no download needed)"
  } catch {
    Write-Host "Failed: $_" -ForegroundColor Red
  }

  # A window opened by the elevation relaunch (or by double-click) would close
  # instantly; keep it open so the result can be read.
  if ($PSCommandPath -or $env:CORREO_PAUSE) { Read-Host "Press Enter to close" }
}
