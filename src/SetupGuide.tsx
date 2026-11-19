import { useState, type ReactNode } from "react";
import "./SetupGuide.css";

export interface GuideStep {
  title: string;
  done: boolean;
  body: ReactNode;
}

// Presentational step list: the first unfinished step is open, finished steps
// collapse to a ✓ (click to reopen), later steps wait greyed out. The parent
// decides what "done" means for each step (detected automatically where it
// can be, otherwise a "완료했어요" button).
export default function SetupGuide({ steps }: { steps: GuideStep[] }) {
  const firstPending = steps.findIndex((s) => !s.done);
  const current = firstPending === -1 ? steps.length : firstPending;
  const [openIdx, setOpenIdx] = useState<number | null>(null);

  return (
    <ol className="sg-list">
      {steps.map((s, i) => {
        const open = i === current || i === openIdx;
        const state = s.done ? "done" : i === current ? "current" : "waiting";
        return (
          <li key={i} className={`sg-step ${state}`}>
            <button
              type="button"
              className="sg-head"
              onClick={() => setOpenIdx((v) => (v === i ? null : i))}
              aria-expanded={open}
            >
              <span className="sg-num">{s.done ? "✓" : i + 1}</span>
              <span className="sg-title">{s.title}</span>
            </button>
            {open && <div className="sg-body">{s.body}</div>}
          </li>
        );
      })}
    </ol>
  );
}

// Small helpers shared by the guides.
export function openLink(url: string) {
  void chrome.tabs.create({ url });
}

export function copyText(text: string): Promise<void> {
  return navigator.clipboard.writeText(text);
}
