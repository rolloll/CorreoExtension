export interface Addr {
  name: string | null;
  address: string | null;
}

export interface Attachment {
  index: number;
  filename: string;
  contentType: string;
  size: number;
  dataBase64: string;
}

export interface ParsedEmail {
  subject: string | null;
  from: Addr[];
  to: Addr[];
  cc: Addr[];
  date: string | null;
  messageId: string | null;
  htmlBody: string | null;
  textBody: string | null;
  attachments: Attachment[];
  rawHeaders: [string, string][];
  rawSource: string;
}

export interface OpenEmail {
  id: string;
  fileName: string;
  parsed: ParsedEmail;
}

export interface LabelOut {
  id: string;
  name: string;
  type: string;
}

export interface Correspondent {
  address: string;
  name: string | null;
  sentCount: number;
  receivedCount: number;
  lastContactMs: number | null;
  awaitingMyReply: boolean;
  awaitingTheirReply: boolean;
  isGenericAddress: boolean;
}

export interface ThreadFlag {
  threadId: string;
  subject: string;
  counterpartAddress: string;
  counterpartName: string | null;
  lastDateMs: number | null;
  ccOnly: boolean;
  counterpartIsGeneric: boolean;
}

// Per-thread classification computed for every scanned thread (not just
// unanswered ones), so the Gmail inbox overlay can tag every row — whether
// you were directly addressed or only Cc'd — without anyone opening it.
export interface ThreadTag {
  threadId: string;
  subject: string;
  counterpartAddress: string | null;
  counterpartName: string | null;
  toOrCc: "to" | "cc" | null;
  isGeneric: boolean;
  lastDateMs: number | null;
  isResolved: boolean;
  // Timestamp/sender of the most recent message *received* in the thread
  // (as opposed to lastDateMs, which is whichever side spoke last), plus
  // whether a message of mine came after it — lets a "받은 메일" view show
  // when something actually arrived and whether it's been answered since.
  lastReceivedMs: number | null;
  lastReceivedAddress: string | null;
  lastReceivedName: string | null;
  repliedAfterLastReceived: boolean;
  // My address was directly in To (not just Cc) on that last received message.
  // Absent in caches written before this field existed.
  lastReceivedToMe?: boolean;
  // To addresses of that last received message, so the Gmail overlay can
  // match them against the user's chosen highlight addresses at display time.
  lastReceivedTo?: string[];
}

export interface ActivitySummary {
  correspondents: Correspondent[];
  awaitingMyReply: ThreadFlag[];
  awaitingTheirReply: ThreadFlag[];
  allThreads: ThreadTag[];
  threadsScanned: number;
  resolvedHidden: number;
}

export interface CachedActivity {
  email: string;
  days: number;
  syncedAtMs: number;
  summary: ActivitySummary;
}
