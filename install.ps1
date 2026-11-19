# Correo installer / updater.
# Installs the latest GitHub release to C:\Program Files (x86)\Correo (needs admin).
#   First time : run this, then in Chrome load that folder once
#                (chrome://extensions -> Developer mode -> Load unpacked).
#   Updating   : run this again, then press Correo's reload button in chrome://extensions.
param(
  [string]$Dir = (Join-Path ${env:ProgramFiles(x86)} "Correo"),
  [string]$Repo = "rolloll/CorreoExtension"
)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

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
  if ($PSCommandPath) {
    Write-Host "관리자 권한이 필요합니다. 권한 요청 창에서 '예'를 눌러 주세요..."
    Start-Process powershell -Verb RunAs -ArgumentList @(
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$PSCommandPath`"", "-Dir", "`"$Dir`"", "-Repo", $Repo
    )
    exit
  } else {
    # Run as "irm <url> | iex": there is no file to relaunch, so relaunch the one-liner.
    Write-Host "관리자 권한이 필요합니다. 권한 요청 창에서 '예'를 눌러 주세요..."
    $url = "https://github.com/$Repo/releases/latest/download/install.ps1"
    Start-Process powershell -Verb RunAs -ArgumentList @(
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "irm $url | iex"
    )
    return
  }
}

try {
  Write-Host "최신 릴리스를 확인하는 중..."
  $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers @{ "User-Agent" = "correo-installer" }
  $asset = $release.assets | Where-Object { $_.name -like "Correo-v*.zip" } | Select-Object -First 1
  if (-not $asset) { throw "릴리스에 Correo zip 파일이 없습니다." }

  $tmp = Join-Path $env:TEMP ("correo-" + [guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  $zip = Join-Path $tmp $asset.name
  Write-Host "$($asset.name) 내려받는 중..."
  Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zip -UseBasicParsing
  $stage = Join-Path $tmp "files"
  Expand-Archive -Path $zip -DestinationPath $stage -Force

  if (-not (Test-Path (Join-Path $stage "manifest.json"))) { throw "압축 파일에 manifest.json이 없습니다." }

  # Mirror into place so files removed in a newer version don't linger.
  New-Item -ItemType Directory -Force -Path $Dir | Out-Null
  robocopy $stage $Dir /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "파일 복사에 실패했습니다 (robocopy $LASTEXITCODE)." }

  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host ""
  Write-Host "설치 완료: $($release.tag_name) -> $Dir" -ForegroundColor Green
  Write-Host "  처음 설치: Chrome > chrome://extensions > 개발자 모드 > '압축해제된 확장 프로그램을 로드합니다' > 위 폴더 선택"
  Write-Host "  업데이트 : chrome://extensions 에서 Correo의 새로고침 버튼 클릭"
} catch {
  Write-Host "실패: $_" -ForegroundColor Red
}
Read-Host "Enter를 누르면 닫힙니다"
