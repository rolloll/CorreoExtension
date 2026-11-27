// Pure helpers for the date-range view's two filters (kept dependency-free so
// they can be tested on their own):
//   account      - one of MY addresses: mail received at it, or sent from it
//   counterpart  - the other party: who sent it to me / who I sent it to
export interface Addr {
  addr: string;
  name: string | null;
}

export function cleanTerm(s: string): string {
  return s.trim().replace(/["{}()]/g, "").toLowerCase();
}

// The chosen accounts, cleaned and de-duplicated. Empty = every address of mine.
export function cleanAccounts(accountsRaw: string[]): string[] {
  return [...new Set(accountsRaw.map(cleanTerm).filter(Boolean))];
}

// Gmail search for the range, narrowed by the chosen filters. {a b} is OR, and
// separate groups are AND-ed. `deliveredto:` is the account that actually
// received the message (covers aliases / group delivery where it isn't in To).
// With several accounts selected, mail of any of them matches.
export function buildRangeQuery(startSec: number, endSec: number, counterpartRaw: string, accountsRaw: string[]): string {
  let q = `after:${startSec} before:${endSec} -in:draft`;
  const accounts = cleanAccounts(accountsRaw);
  if (accounts.length) {
    q += ` {${accounts.map((a) => `from:${a} to:${a} cc:${a} deliveredto:${a}`).join(" ")}}`;
  }
  const who = cleanTerm(counterpartRaw);
  // The bare-text term catches mail reflected by a group, whose From is the group.
  if (who) q += ` {from:(${who}) to:(${who}) cc:(${who}) "${who}"}`;
  return q;
}

// Exact check on the real headers (the search above only narrows candidates).
// Sent mail belongs to the account it was sent FROM; received mail to the
// account it was addressed or delivered TO.
export function matchesAccount(
  accountsRaw: string[],
  isMine: boolean,
  from: Addr[],
  to: Addr[],
  cc: Addr[],
  deliveredTo: string[],
): boolean {
  const accounts = cleanAccounts(accountsRaw);
  if (accounts.length === 0) return true;
  const chosen = new Set(accounts);
  if (isMine) return from.some((a) => chosen.has(a.addr));
  return (
    to.some((a) => chosen.has(a.addr)) ||
    cc.some((a) => chosen.has(a.addr)) ||
    deliveredTo.some((d) => chosen.has(d.trim().toLowerCase()))
  );
}

// The other side of the conversation: the sender of received mail, or the
// To/Cc recipients (other than me) of sent mail.
export function matchesCounterpart(
  counterpartRaw: string,
  isMine: boolean,
  from: Addr[],
  to: Addr[],
  cc: Addr[],
  myAddrs: Set<string>,
): boolean {
  const who = cleanTerm(counterpartRaw);
  if (!who) return true;
  const others = isMine ? [...to, ...cc].filter((a) => !myAddrs.has(a.addr)) : from;
  return others.some((a) => a.addr.includes(who) || (a.name ?? "").toLowerCase().includes(who));
}
