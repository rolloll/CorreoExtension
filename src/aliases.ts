// User-editable overrides for "which addresses are me".
// Gmail's own send-as list is the starting point; `extra` adds addresses
// Gmail doesn't know about (e.g. a Workspace alias that only receives), and
// `excluded` drops detected ones that aren't really me (e.g. a group address).

export const ALIASES_KEY = "correo_aliases";

export interface AliasConfig {
  extra: string[];
  excluded: string[];
  // Addresses whose direct mail gets highlighted in Gmail. Undefined = just
  // the account's primary address.
  highlight?: string[];
}

export function normalizeAddress(s: string): string {
  return s.trim().toLowerCase();
}

export function isValidAddress(s: string): boolean {
  return /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(s);
}

export async function loadAliasConfig(): Promise<AliasConfig> {
  const s = await chrome.storage.local.get(ALIASES_KEY);
  const c = s[ALIASES_KEY] as Partial<AliasConfig> | undefined;
  return { extra: c?.extra ?? [], excluded: c?.excluded ?? [], highlight: c?.highlight };
}

export function saveAliasConfig(c: AliasConfig): Promise<void> {
  return chrome.storage.local.set({ [ALIASES_KEY]: c });
}
