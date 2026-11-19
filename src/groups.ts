import type { DayMessage } from "./gmail/api";

// Local-only grouping for the date-range view (not Gmail labels): a message
// belongs to the first group, in order, with a keyword found in its subject
// or in any sender/recipient name or address; otherwise to OTHER_GROUP.
export interface MailGroup {
  name: string;
  keywords: string[];
}

export const OTHER_GROUP = "기타";

const GROUPS_KEY = "correo_groups";

export const DEFAULT_GROUPS: MailGroup[] = [
  { name: "노블", keywords: ["노블", "웹소설", "소설", "novel"] },
  { name: "웹툰", keywords: ["웹툰", "webtoon", "만화"] },
];

export async function loadGroups(): Promise<MailGroup[]> {
  const s = await chrome.storage.local.get(GROUPS_KEY);
  return (s[GROUPS_KEY] as MailGroup[] | undefined) ?? DEFAULT_GROUPS;
}

export async function saveGroups(groups: MailGroup[]): Promise<void> {
  await chrome.storage.local.set({ [GROUPS_KEY]: groups });
}

export function groupOf(m: DayMessage, groups: MailGroup[]): string {
  const haystack = [m.subject, ...[...m.fromAddrs, ...m.toAddrs, ...m.ccAddrs].flatMap((a) => [a.addr, a.name ?? ""])]
    .join("\n")
    .toLowerCase();
  for (const g of groups) {
    if (g.keywords.some((k) => k && haystack.includes(k.toLowerCase()))) return g.name;
  }
  return OTHER_GROUP;
}
