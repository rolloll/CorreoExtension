export async function getAuthToken(interactive: boolean): Promise<string> {
  const result = await chrome.identity.getAuthToken({ interactive });
  if (!result.token) {
    throw new Error("Gmail 인증 토큰을 가져오지 못했습니다.");
  }
  return result.token;
}

export async function getAccountEmail(token: string): Promise<string> {
  const resp = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`프로필 조회 실패 (${resp.status}): ${text}`);
  }
  const data = await resp.json();
  return data.emailAddress as string;
}

export async function signOut(token?: string): Promise<void> {
  if (token) {
    await chrome.identity.removeCachedAuthToken({ token });
  }
  await chrome.identity.clearAllCachedAuthTokens();
}

const ACCOUNT_KEY = "correo_gmail_account";

export async function saveAccountEmail(email: string): Promise<void> {
  await chrome.storage.local.set({ [ACCOUNT_KEY]: email });
}

export async function loadAccountEmail(): Promise<string | null> {
  const stored = await chrome.storage.local.get(ACCOUNT_KEY);
  return (stored[ACCOUNT_KEY] as string | undefined) ?? null;
}

export async function clearAccountEmail(): Promise<void> {
  await chrome.storage.local.remove(ACCOUNT_KEY);
}
