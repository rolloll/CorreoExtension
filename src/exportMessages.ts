import type { DayMessage } from "./gmail/api";

export type ExportFormat = "csv" | "txt";
export type GroupLabeler = (m: DayMessage) => string;

export interface ExportOptions {
  groupOf?: GroupLabeler;
  // messageId -> 1-3 line summary; adds a 요약 column / line when given.
  summaries?: Record<string, string>;
}

type Addr = { addr: string; name: string | null };

function fmtAddrs(list: Addr[]): string {
  return list.map((a) => (a.name && a.name !== a.addr ? `${a.name} <${a.addr}>` : a.addr)).join("; ");
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function fmtTime(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function csvCell(s: string): string {
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Oldest first reads more naturally in a file than the on-screen newest-first.
function chronological(messages: DayMessage[]): DayMessage[] {
  return [...messages].sort((a, b) => a.timeMs - b.timeMs);
}

export function buildExport(messages: DayMessage[], format: ExportFormat, opts: ExportOptions = {}): string {
  const { groupOf, summaries } = opts;
  const rows = chronological(messages);
  if (format === "csv") {
    const header = [
      "일시",
      "구분",
      ...(groupOf ? ["그룹"] : []),
      "제목",
      ...(summaries ? ["요약"] : []),
      "보낸 사람",
      "받는 사람",
      "참조",
    ];
    const lines = [
      header,
      ...rows.map((m) => [
        fmtTime(m.timeMs),
        m.direction === "sent" ? "보냄" : "받음",
        ...(groupOf ? [groupOf(m)] : []),
        m.subject,
        // One line per cell keeps the CSV easy to filter and sort.
        ...(summaries ? [(summaries[m.messageId] ?? "").replace(/\n/g, " / ")] : []),
        fmtAddrs(m.fromAddrs),
        fmtAddrs(m.toAddrs),
        fmtAddrs(m.ccAddrs),
      ]),
    ].map((r) => r.map(csvCell).join(","));
    // BOM so Excel opens the UTF-8 file with Korean text intact.
    return String.fromCharCode(0xfeff) + lines.join("\r\n") + "\r\n";
  }
  return (
    rows
      .map((m) => {
        const out = [
          `[${fmtTime(m.timeMs)}] ${m.direction === "sent" ? "보냄" : "받음"}${groupOf ? ` [${groupOf(m)}]` : ""}`,
          `제목: ${m.subject}`,
        ];
        const summary = summaries?.[m.messageId];
        if (summary) out.push(...summary.split("\n").map((l, i) => (i === 0 ? `요약: ${l}` : `      ${l}`)));
        out.push(`보낸 사람: ${fmtAddrs(m.fromAddrs)}`, `받는 사람: ${fmtAddrs(m.toAddrs)}`);
        if (m.ccAddrs.length) out.push(`참조: ${fmtAddrs(m.ccAddrs)}`);
        return out.join("\n");
      })
      .join("\n\n") + "\n"
  );
}

export function downloadExport(
  messages: DayMessage[],
  format: ExportFormat,
  from: string,
  to: string,
  opts: ExportOptions = {},
): void {
  const mime = format === "csv" ? "text/csv;charset=utf-8" : "text/plain;charset=utf-8";
  const url = URL.createObjectURL(new Blob([buildExport(messages, format, opts)], { type: mime }));
  const name = `correo_${from === to ? from : `${from}_${to}`}.${format}`;
  void chrome.downloads.download({ url, filename: name, saveAs: true }).finally(() => {
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  });
}
