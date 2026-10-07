import { getAuthToken } from "./auth";

const TASKS_BASE = "https://tasks.googleapis.com/tasks/v1";

async function tasksJson<T>(path: string, context: string, init: RequestInit = {}): Promise<T> {
  const token = await getAuthToken(false);
  const resp = await fetch(`${TASKS_BASE}${path}`, {
    ...init,
    headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` },
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`${context} 실패 (${resp.status}): ${text}`);
  }
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    throw new Error(`${context} 응답 해석 실패: ${e} / 응답 내용: ${text.slice(0, 300)}`);
  }
}

interface TaskList {
  id: string;
  title: string;
}

// Most accounts only ever have the one default list ("내 할 일"), so rather
// than making the user pick a list for every email, just file into whichever
// list Google Tasks returns first.
async function getDefaultTaskListId(): Promise<string> {
  const data = await tasksJson<{ items?: TaskList[] }>("/users/@me/lists", "할 일 목록 조회");
  const first = (data.items || [])[0];
  if (!first) {
    throw new Error("Google 할 일 목록이 없습니다. Google Tasks에서 목록을 먼저 만들어주세요.");
  }
  return first.id;
}

export async function addThreadAsTask(threadId: string, title: string): Promise<void> {
  const taskListId = await getDefaultTaskListId();
  const link = `https://mail.google.com/mail/u/0/#all/${threadId}`;
  await tasksJson(`/lists/${taskListId}/tasks`, "할 일 추가", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, notes: link }),
  });
}
