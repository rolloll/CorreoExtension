# Correo

Gmail 라벨/답장 관리 + 주소록 + .eml 뷰어 Chrome 확장 프로그램 (Manifest V3, Vite + React + TypeScript).

## 설치 (사용자)

설치 위치는 `C:\Program Files (x86)\Correo`로 고정됩니다.

1. PowerShell에 아래 한 줄을 붙여넣어 실행합니다. 관리자 권한 창이 뜨면 `예`를 누릅니다. (zip을 받을 필요가 없습니다)
   ```powershell
   irm https://github.com/rolloll/CorreoExtension/releases/latest/download/install.ps1 | iex
   ```
2. `chrome://extensions` → 우측 상단 **개발자 모드** 켜기 → **압축해제된 확장 프로그램을 로드합니다** → `C:\Program Files (x86)\Correo` 선택 (처음 한 번만).

이 설치는 두 가지를 함께 합니다.
- 확장 파일을 위 폴더에 넣고, **현재 사용자에게 그 폴더의 쓰기 권한**을 줍니다 (이후 업데이트에 관리자 권한이 필요 없도록).
- 업데이트용 **작은 도우미**를 `%LOCALAPPDATA%\Correo\host`에 두고 Chrome에 등록합니다 (Chrome이 허용하는 네이티브 메시징). 도우미는 **이 저장소의 최신 릴리스를 받아 위 폴더에 덮어쓰는 일**만 하며, 확장이 다른 주소나 폴더를 지정할 수 없습니다.

> 크롬 확장 프로그램은 크롬 안에서 구동되므로 "구동 위치"를 바꿀 수는 없고, 위 폴더의 파일을 읽어 옵니다.
> 제거하고 다시 등록하면 저장된 설정이 지워집니다. 설정 화면의 **설정 내보내기**로 미리 백업하세요.

## 업데이트

새 버전이 게시되면 12시간 이내에 시스템 알림이 뜨고, Correo를 열면 상단에도 안내가 나옵니다. 설정 화면의 **업데이트 확인**으로 바로 확인할 수도 있습니다.

- **상단 안내의 `지금 업데이트` 버튼 한 번**이면 끝납니다. 새 버전을 받아 같은 폴더에 덮어쓰고 확장을 자동으로 다시 로드합니다. 끝나면 Gmail·Correo 탭만 새로고침하세요.
- 도우미가 아직 없는 PC(위 설치를 한 번도 실행하지 않은 경우)에서는 같은 자리에 **업데이트 명령 복사** 버튼이 나옵니다. 그 한 줄을 PowerShell에 실행하면 도우미까지 설치되고, 다음부터 `지금 업데이트` 버튼이 나옵니다. 이때는 `chrome://extensions`에서 Correo의 새로고침 버튼을 한 번 눌러 주세요.

설정은 새로고침·덮어쓰기로는 지워지지 않습니다 (확장을 **제거**할 때만 지워집니다).

## 개발

```bash
npm install
npm run build   # dist/ 생성 (앱 + content script + background 3단계 빌드)
```

## 릴리스 방법 (개발자)

1. `public/manifest.json`의 `version`을 올립니다 (예: `0.32.0`).
2. 태그를 푸시하면 GitHub Actions가 빌드 후 zip과 함께 Release를 만듭니다.

```bash
git tag v0.32.0
git push origin v0.32.0
```

태그(`v` 제외)와 manifest 버전이 다르면 워크플로가 실패합니다.
