import { useRef, useState } from "react";

// Add / edit / delete a list of keywords as chips: click a chip to rename it,
// × to remove it, and type in the trailing field + Enter (or ",") to add one.
export default function KeywordChips({
  keywords,
  onChange,
}: {
  keywords: string[];
  onChange: (next: string[]) => void;
}) {
  const [editIdx, setEditIdx] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [newText, setNewText] = useState("");
  // Escape unmounts the field, which can still fire blur; don't save then.
  const cancelled = useRef(false);

  // Trims and drops blanks/duplicates (case-insensitive, keeping the first).
  function clean(list: string[]): string[] {
    const seen = new Set<string>();
    return list
      .map((k) => k.trim())
      .filter((k) => {
        const key = k.toLowerCase();
        if (!k || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }

  function commitEdit() {
    if (editIdx === null) return;
    if (cancelled.current) {
      cancelled.current = false;
      return;
    }
    // An emptied chip is removed, which clean() handles.
    onChange(clean(keywords.map((k, i) => (i === editIdx ? draft : k))));
    setEditIdx(null);
  }

  function addNew() {
    const parts = newText.split(",");
    setNewText("");
    if (parts.some((p) => p.trim())) onChange(clean([...keywords, ...parts]));
  }

  return (
    <div className="kw-chips">
      {keywords.map((k, i) =>
        editIdx === i ? (
          <input
            key={`${i}-edit`}
            className="kw-edit"
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitEdit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitEdit();
              if (e.key === "Escape") {
                cancelled.current = true;
                setEditIdx(null);
              }
            }}
            aria-label="키워드 수정"
          />
        ) : (
          <span key={`${i}-${k}`} className="kw-chip">
            <button
              type="button"
              className="kw-chip-text"
              title="클릭해서 수정"
              onClick={() => {
                cancelled.current = false;
                setEditIdx(i);
                setDraft(k);
              }}
            >
              {k}
            </button>
            <button
              type="button"
              className="kw-chip-x"
              title="삭제"
              aria-label={`${k} 삭제`}
              onClick={() => onChange(keywords.filter((_, j) => j !== i))}
            >
              ×
            </button>
          </span>
        ),
      )}
      <input
        className="kw-add"
        value={newText}
        placeholder="키워드 추가 후 Enter"
        onChange={(e) => setNewText(e.target.value)}
        onBlur={addNew}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            addNew();
          }
        }}
        aria-label="키워드 추가"
      />
    </div>
  );
}
