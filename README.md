# Correo

Gmail 라벨/답장 관리 + 주소록 + .eml 뷰어 Chrome 확장 프로그램 (Manifest V3, Vite + React + TypeScript).

## 설치 (사용자)

1. [Releases](https://github.com/rolloll/CorreoExtension/releases/latest)에서 `Correo-vX.Y.Z.zip`을 받아 압축을 풉니다.
2. `chrome://extensions` → 우측 상단 **개발자 모드** 켜기 → **압축해제된 확장 프로그램을 로드합니다** → 압축 푼 폴더 선택.

## 업데이트

새 버전이 게시되면 12시간 이내에 시스템 알림이 뜨고, 클릭하면 릴리스 페이지가 열립니다.
설정 화면의 **업데이트 확인** 버튼으로 바로 확인할 수도 있습니다.
새 zip을 받아 **기존 폴더에 덮어쓴 뒤** `chrome://extensions`에서 Correo의 새로고침 버튼을 누르세요.

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
