import { useRef, useState } from "react";
import { exportSettings, importSettings } from "./settingsBackup";

// Settings block: save/restore everything configured in Correo as one file.
export default function BackupSettings() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function doExport() {
    const n = await exportSettings();
    setMsg(`설정 ${n}종을 파일로 저장합니다.`);
  }

  async function onFile(file: File | undefined) {
    if (!file) return;
    try {
      const n = await importSettings(await file.text());
      setMsg(`설정 ${n}종을 복원했습니다. 화면을 새로고침하면 모두 반영됩니다.`);
    } catch (e) {
      setMsg(`복원 실패: ${e instanceof Error ? e.message : e}`);
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <div className="st-block">
      <div className="st-block-title">설정 백업 / 복원</div>
      <div className="st-toggle-hint">
        열람 추적 서버, 텔레그램, AI 키, 그룹 키워드 등 설정을 파일 하나로 저장했다가 다시 불러옵니다. 확장 프로그램을 제거하고 다시 등록하면 설정이
        지워지므로, 그 전에 저장해 두세요. 파일에는 토큰과 API 키가 들어 있으니 다른 사람에게 보내지 마세요.
      </div>
      <div style={{ display: "flex", gap: 6, margin: "8px 0 0" }}>
        <button className="btn btn-secondary" onClick={doExport}>
          설정 내보내기
        </button>
        <button className="btn btn-secondary" onClick={() => fileRef.current?.click()}>
          설정 가져오기
        </button>
        <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={(e) => void onFile(e.target.files?.[0])} />
      </div>
      {msg && (
        <div className="text-muted" style={{ fontSize: 12, marginTop: 6 }}>
          {msg}
        </div>
      )}
    </div>
  );
}
