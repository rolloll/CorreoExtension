import { useEffect, useMemo, useState } from "react";
import type { LabelOut } from "./types";
import {
  listLabels,
  ensureLabel,
  createFilter,
  applyLabelToExisting,
  applySoloRecipientLabel,
  renameLabel,
  getLabelMessageCount,
  deleteLabel,
  mergeLabels,
} from "./gmail/api";
import type { Person } from "./contacts/api";
import { listContacts, listDirectoryPeople } from "./contacts/api";
import { IconChevronUp, IconChevronDown, IconMerge, IconTrash } from "./icons";
import "./Labels.css";

type Sub = "rule" | "tidy";

interface AddressOption {
  name: string;
  email: string;
}

function personToOption(p: Person): AddressOption | null {
  const email = p.emailAddresses?.[0]?.value;
  if (!email) return null;
  const n = p.names?.[0];
  const name = n?.displayName || [n?.givenName, n?.familyName].filter(Boolean).join(" ") || email;
  return { name, email };
}

function stripOrderPrefix(segment: string): string {
  return segment.replace(/^\d+_/, "");
}

interface OrderNode {
  segment: string;
  label: LabelOut | null;
  children: OrderNode[];
}

function buildOrderTree(labels: LabelOut[]): OrderNode[] {
  const sorted = [...labels].sort((a, b) => a.name.localeCompare(b.name));
  const roots: OrderNode[] = [];
  for (const label of sorted) {
    let siblings = roots;
    let node: OrderNode | undefined;
    for (const part of label.name.split("/")) {
      node = siblings.find((n) => n.segment === part);
      if (!node) {
        node = { segment: part, label: null, children: [] };
        siblings.push(node);
      }
      siblings = node.children;
    }
    if (node) node.label = label;
  }
  return roots;
}

function cloneOrderTree(nodes: OrderNode[]): OrderNode[] {
  return nodes.map((n) => ({ ...n, children: cloneOrderTree(n.children) }));
}

function getSiblingsAtPath(roots: OrderNode[], parentPath: number[]): OrderNode[] {
  let nodes = roots;
  for (const idx of parentPath) nodes = nodes[idx].children;
  return nodes;
}

interface PendingEntry {
  currentFullPath: string;
  pendingFullPath: string;
  label: LabelOut | null;
}

// Shared walk behind both collectLabelRenames (what to actually write on
// save) and the live "→ NN_" preview in the tidy list (so a move's effect
// on numbering is visible immediately, not just after saving).
function walkPending(nodes: OrderNode[], parentPath: string, currentPathPrefix: string): PendingEntry[] {
  const out: PendingEntry[] = [];
  const width = Math.max(2, String(nodes.length).length);
  nodes.forEach((node, i) => {
    const currentFullPath = currentPathPrefix ? `${currentPathPrefix}/${node.segment}` : node.segment;
    const prefix = String(i + 1).padStart(width, "0");
    const effectiveSegment = node.label ? `${prefix}_${stripOrderPrefix(node.segment)}` : node.segment;
    const pendingFullPath = parentPath ? `${parentPath}/${effectiveSegment}` : effectiveSegment;
    out.push({ currentFullPath, pendingFullPath, label: node.label });
    out.push(...walkPending(node.children, pendingFullPath, currentFullPath));
  });
  return out;
}

function collectLabelRenames(nodes: OrderNode[], parentPath: string): { id: string; newName: string }[] {
  return walkPending(nodes, parentPath, "")
    .filter((e) => e.label && e.pendingFullPath !== e.label.name)
    .map((e) => ({ id: e.label!.id, newName: e.pendingFullPath }));
}

interface FlatRow {
  label: LabelOut | null;
  displayName: string;
  fullPath: string;
  depth: number;
  parentPath: number[];
  index: number;
  siblingsLen: number;
}

function flattenOrderTree(nodes: OrderNode[], parentPath: number[], depth: number, pathPrefix: string): FlatRow[] {
  const out: FlatRow[] = [];
  nodes.forEach((node, i) => {
    const fullPath = pathPrefix ? `${pathPrefix}/${node.segment}` : node.segment;
    out.push({
      label: node.label,
      displayName: stripOrderPrefix(node.segment),
      fullPath,
      depth,
      parentPath,
      index: i,
      siblingsLen: nodes.length,
    });
    out.push(...flattenOrderTree(node.children, [...parentPath, i], depth + 1, fullPath));
  });
  return out;
}

type Confirm =
  | { type: "delete"; label: LabelOut; count: number | null }
  | { type: "merge"; sourceRow: FlatRow; count: number | null; mergeToId: string };

export default function Labels({
  initialAddress,
  onConsumeInitialAddress,
}: {
  initialAddress: string | null;
  onConsumeInitialAddress: () => void;
}) {
  const [sub, setSub] = useState<Sub>("rule");
  const [labels, setLabels] = useState<LabelOut[]>([]);
  const [addressBook, setAddressBook] = useState<AddressOption[]>([]);
  const [suggestOpen, setSuggestOpen] = useState(false);

  const [ruleWho, setRuleWho] = useState<"from" | "to">("from");
  const [ruleAddr, setRuleAddr] = useState("");
  const [ruleLabelPath, setRuleLabelPath] = useState("");
  const [ruleFuture, setRuleFuture] = useState(true);
  const [ruleExisting, setRuleExisting] = useState(true);
  const [ruleArchive, setRuleArchive] = useState(true);
  const [ruleToSoloOnly, setRuleToSoloOnly] = useState(true);
  const [ruleBusy, setRuleBusy] = useState(false);
  const [ruleDone, setRuleDone] = useState<string | null>(null);
  const [ruleError, setRuleError] = useState<string | null>(null);

  const [orderTree, setOrderTree] = useState<OrderNode[]>([]);
  const [orderDirty, setOrderDirty] = useState(false);
  const [orderBusy, setOrderBusy] = useState(false);
  const [orderMsg, setOrderMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [activeRowPath, setActiveRowPath] = useState<string | null>(null);

  function refreshLabels() {
    return listLabels().then((ls) => {
      setLabels(ls);
      setOrderTree(buildOrderTree(ls));
      setOrderDirty(false);
      return ls;
    });
  }

  useEffect(() => {
    refreshLabels().catch(() => {});
    Promise.all([listContacts().catch(() => []), listDirectoryPeople().catch(() => [])])
      .then(([personal, directory]) => {
        const seen = new Map<string, AddressOption>();
        for (const p of [...directory, ...personal]) {
          const opt = personToOption(p);
          if (!opt) continue;
          seen.set(opt.email.toLowerCase(), opt);
        }
        setAddressBook(Array.from(seen.values()));
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (initialAddress) {
      setSub("rule");
      setRuleWho("from");
      setRuleAddr(initialAddress);
      setRuleDone(null);
      onConsumeInitialAddress();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialAddress]);

  const addressMatches = useMemo(() => {
    const q = ruleAddr.trim().toLowerCase();
    if (!q) return [];
    return addressBook
      .filter((a) => a.name.toLowerCase().includes(q) || a.email.toLowerCase().includes(q))
      .slice(0, 6);
  }, [ruleAddr, addressBook]);

  const labelPaths = useMemo(() => labels.map((l) => l.name).sort((a, b) => a.localeCompare(b)), [labels]);

  const ruleTarget = ruleLabelPath.trim();
  // The strict "sole To recipient" check (below) can't be expressed as a Gmail
  // filter — Gmail's own `to:` search/filter only tests whether an address
  // is *among* the recipients, it can't say "and nobody else was on it" —
  // so a future-mail filter is only offered for "from" rules, or "to" rules
  // that dropped the solo-recipient requirement.
  const canUseFilter = ruleWho === "from" || (ruleWho === "to" && !ruleToSoloOnly);
  const ruleInvalid = !ruleAddr.trim() || !ruleTarget || (!ruleExisting && !(ruleFuture && canUseFilter));

  const ruleSummary =
    (ruleAddr.trim() || "(주소 미입력)") +
    (ruleWho === "from" ? "에서 온" : ruleToSoloOnly ? "만 단독 수신자인(참조 무관)" : "이 받는 사람에 포함된") +
    ` 메일에 "${ruleTarget || "?"}" 라벨을 붙입니다.` +
    (ruleArchive ? " 받은편지함은 건너뜁니다." : "") +
    (ruleWho === "to" && ruleToSoloOnly
      ? " 단독 수신 조건은 필터로 만들 수 없어 이미 받은 메일에만 적용됩니다."
      : ruleFuture && ruleExisting
        ? " 앞으로 오는 메일과 이미 받은 메일 모두."
        : ruleFuture
          ? " 앞으로 오는 메일만."
          : ruleExisting
            ? " 이미 받은 메일만."
            : "");

  async function applyRule() {
    const addr = ruleAddr.trim();
    const path = ruleTarget;
    if (!addr || !path) return;
    setRuleBusy(true);
    setRuleError(null);
    setRuleDone(null);
    try {
      const label = await ensureLabel(path);
      const parts: string[] = [];
      if (ruleWho === "to" && ruleToSoloOnly) {
        if (ruleExisting) {
          const n = await applySoloRecipientLabel(addr, label.id, ruleArchive);
          parts.push(`기존 메일 ${n}건에 적용했습니다`);
        }
      } else {
        const query = `${ruleWho}:${addr}`;
        if (ruleFuture) {
          await createFilter(query, label.id, ruleArchive);
          parts.push("필터를 만들었습니다");
        }
        if (ruleExisting) {
          const n = await applyLabelToExisting(query, label.id, ruleArchive);
          parts.push(`기존 메일 ${n}건에 적용했습니다`);
        }
      }
      setRuleDone(`"${path}" — ${parts.join(", ") || "규칙을 저장했습니다"}.`);
      setRuleAddr("");
      await refreshLabels();
    } catch (e) {
      setRuleError(String(e));
    } finally {
      setRuleBusy(false);
    }
  }

  const flatRows = useMemo(() => flattenOrderTree(orderTree, [], 0, ""), [orderTree]);
  const realLabelRows = flatRows.filter((r) => r.label);

  function descendantsOf(row: FlatRow): FlatRow[] {
    return flatRows.filter((r) => r.fullPath.startsWith(`${row.fullPath}/`));
  }
  const pendingByPath = useMemo(() => {
    const map = new Map<string, string>();
    for (const e of walkPending(orderTree, "", "")) map.set(e.currentFullPath, e.pendingFullPath);
    return map;
  }, [orderTree]);

  function moveRow(row: FlatRow, dir: -1 | 1) {
    setOrderTree((prev) => {
      const next = cloneOrderTree(prev);
      const siblings = getSiblingsAtPath(next, row.parentPath);
      const target = row.index + dir;
      if (target < 0 || target >= siblings.length) return prev;
      [siblings[row.index], siblings[target]] = [siblings[target], siblings[row.index]];
      return next;
    });
    setOrderDirty(true);
    // fullPath is stable across a move (only renaming on save changes it),
    // so tracking it — rather than the row's index, which is exactly what
    // just changed — keeps the highlight on the same label as it travels
    // up/down the list.
    setActiveRowPath(row.fullPath);
  }

  async function saveOrder() {
    setOrderBusy(true);
    setOrderMsg(null);
    const renames = collectLabelRenames(orderTree, "");
    // Applied one at a time rather than stopping at the first failure —
    // otherwise a single rejected rename (rate limiting, a stale label id
    // after an external edit, etc.) would leave the rest of the group
    // half-renumbered with no clear indication of what happened.
    const failures: string[] = [];
    for (const { id, newName } of renames) {
      try {
        await renameLabel(id, newName);
      } catch (e) {
        failures.push(`${newName}: ${String(e)}`);
      }
    }
    await refreshLabels().catch(() => {});
    if (failures.length > 0) {
      setOrderMsg({
        type: "err",
        text: `${renames.length - failures.length}/${renames.length}개 적용됨. 실패: ${failures.join(" · ")}`,
      });
    } else {
      setOrderMsg({
        type: "ok",
        text: renames.length > 0 ? `라벨 ${renames.length}개 이름 앞에 순번을 붙였습니다.` : "바뀐 순서가 없습니다.",
      });
    }
    setOrderBusy(false);
  }

  function askDelete(label: LabelOut, fullPath: string) {
    setConfirm({ type: "delete", label, count: null });
    setActiveRowPath(fullPath);
    getLabelMessageCount(label.id)
      .then((count) => setConfirm((p) => (p && p.type === "delete" && p.label.id === label.id ? { ...p, count } : p)))
      .catch(() => {});
  }

  // A merge source can be a real label, a virtual group (no label of its
  // own, only implied by children), or both — the target just needs a real
  // label id, since that's what messages actually get reassigned to and
  // what children's renamed paths are built from.
  function askMerge(row: FlatRow) {
    setActiveRowPath(row.fullPath);
    const excludeIds = new Set(descendantsOf(row).map((r) => r.label?.id).filter(Boolean));
    if (row.label) excludeIds.add(row.label.id);
    const other = realLabelRows.find((r) => r.label && !excludeIds.has(r.label.id))?.label;
    setConfirm({ type: "merge", sourceRow: row, count: row.label ? null : 0, mergeToId: other?.id || "" });
    if (row.label) {
      const labelId = row.label.id;
      getLabelMessageCount(labelId)
        .then((count) =>
          setConfirm((p) => (p && p.type === "merge" && p.sourceRow.label?.id === labelId ? { ...p, count } : p)),
        )
        .catch(() => {});
    }
  }

  async function doConfirm() {
    if (!confirm) return;
    setConfirmBusy(true);
    setOrderMsg(null);
    try {
      if (confirm.type === "delete") {
        await deleteLabel(confirm.label.id);
        setConfirm(null);
        setOrderMsg({ type: "ok", text: `"${confirm.label.name}" 라벨을 삭제했습니다.` });
      } else {
        const target = realLabelRows.find((r) => r.label?.id === confirm.mergeToId)?.label;
        if (!target) throw new Error("병합할 대상 라벨을 찾지 못했습니다.");
        const source = confirm.sourceRow;
        // Re-parent children first (non-destructive) so a partial failure
        // there still leaves the source label intact to retry from —
        // only once that's done do we merge+delete the source's own label.
        const descendants = descendantsOf(source).filter((d) => d.label);
        const failures: string[] = [];
        for (const d of descendants) {
          const newName = target.name + d.fullPath.slice(source.fullPath.length);
          try {
            await renameLabel(d.label!.id, newName);
          } catch (e) {
            failures.push(`${d.fullPath}: ${String(e)}`);
          }
        }
        let mergedOwnLabel = false;
        if (failures.length === 0 && source.label) {
          await mergeLabels(source.label.id, target.id);
          mergedOwnLabel = true;
        }
        setConfirm(null);
        if (failures.length > 0) {
          setOrderMsg({
            type: "err",
            text: `하위 라벨 ${descendants.length - failures.length}/${descendants.length}개 이동됨. 실패: ${failures.join(" · ")} (원본 라벨은 남아있어 다시 시도할 수 있습니다.)`,
          });
        } else {
          const parts = [];
          if (descendants.length > 0) parts.push(`하위 라벨 ${descendants.length}개`);
          if (mergedOwnLabel) parts.push("메일");
          setOrderMsg({
            type: "ok",
            text: `${parts.join(", ") || "선택한 항목"}을 "${target.name}"(으)로 옮겼습니다.`,
          });
        }
      }
      await refreshLabels();
    } catch (e) {
      setOrderMsg({ type: "err", text: String(e) });
    } finally {
      setConfirmBusy(false);
    }
  }

  return (
    <div className="lb-root">
      <div className="lb-head">
        <span className="lb-head-title">라벨</span>
        <div className="seg lb-seg">
          <label className="seg-opt">
            <input type="radio" name="lb-sub" checked={sub === "rule"} onChange={() => setSub("rule")} />
            새 규칙
          </label>
          <label className="seg-opt">
            <input type="radio" name="lb-sub" checked={sub === "tidy"} onChange={() => setSub("tidy")} />
            라벨 정리
          </label>
        </div>
      </div>

      {sub === "rule" && (
        <div className="lb-rule-scroll">
          <div className="blueprint lb-step">
            <i className="corner tl" />
            <i className="corner tr" />
            <i className="corner bl" />
            <i className="corner br" />
            <span className="lb-step-n">01</span>
            <div className="lb-step-body">
              <div className="lb-step-title">누구의 메일인가요?</div>
              <div className="seg">
                <label className="seg-opt">
                  <input type="radio" name="lb-who" checked={ruleWho === "from"} onChange={() => setRuleWho("from")} />
                  보낸 사람
                </label>
                <label className="seg-opt">
                  <input type="radio" name="lb-who" checked={ruleWho === "to"} onChange={() => setRuleWho("to")} />
                  받는 사람
                </label>
              </div>
              <div className="lb-address-field">
                <input
                  className="input"
                  value={ruleAddr}
                  onChange={(e) => setRuleAddr(e.target.value)}
                  onFocus={() => setSuggestOpen(true)}
                  onBlur={() => setTimeout(() => setSuggestOpen(false), 150)}
                  placeholder="이메일 또는 이름"
                />
                {suggestOpen && addressMatches.length > 0 && (
                  <div className="lb-suggest">
                    {addressMatches.map((a) => (
                      <button
                        key={a.email}
                        type="button"
                        className="btn btn-ghost lb-suggest-item"
                        onMouseDown={(e) => {
                          e.preventDefault();
                          setRuleAddr(a.email);
                          setSuggestOpen(false);
                        }}
                      >
                        <strong>{a.name}</strong>
                        <span className="text-muted">{a.email}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {ruleWho === "to" && (
                <label className="checkline">
                  <input
                    type="checkbox"
                    checked={ruleToSoloOnly}
                    onChange={(e) => setRuleToSoloOnly(e.target.checked)}
                  />
                  받는 사람(To)이 이 사람 한 명뿐일 때만 (참조자가 있어도 적용됩니다. 해제하면 다른 수신자가 함께 있어도 적용되고, 앞으로 오는 메일도 필터로 설정할 수 있습니다)
                </label>
              )}
            </div>
          </div>

          <div className="blueprint lb-step">
            <i className="corner tl" />
            <i className="corner tr" />
            <i className="corner bl" />
            <i className="corner br" />
            <span className="lb-step-n">02</span>
            <div className="lb-step-body">
              <div className="lb-step-title">어느 라벨로?</div>
              <input
                className="input"
                list="lb-label-paths"
                value={ruleLabelPath}
                onChange={(e) => setRuleLabelPath(e.target.value)}
                placeholder="예: 거래처/한빛상사"
              />
              <datalist id="lb-label-paths">
                {labelPaths.map((p) => (
                  <option key={p} value={p} />
                ))}
              </datalist>
              <div className="lb-hint">"회사/영업"처럼 / 로 하위 라벨을 만들 수 있습니다. 목록에 없으면 새로 만들어집니다.</div>
            </div>
          </div>

          <div className="blueprint lb-step">
            <i className="corner tl" />
            <i className="corner tr" />
            <i className="corner bl" />
            <i className="corner br" />
            <span className="lb-step-n">03</span>
            <div className="lb-step-body">
              <div className="lb-step-title">어디까지 적용할까요?</div>
              <label className="checkline" style={{ opacity: canUseFilter ? 1 : 0.45 }}>
                <input
                  type="checkbox"
                  checked={ruleFuture && canUseFilter}
                  disabled={!canUseFilter}
                  onChange={(e) => setRuleFuture(e.target.checked)}
                />
                앞으로 오는 메일
              </label>
              <label className="checkline">
                <input type="checkbox" checked={ruleExisting} onChange={(e) => setRuleExisting(e.target.checked)} />
                이미 받은 메일
              </label>
              <label className="checkline">
                <input type="checkbox" checked={ruleArchive} onChange={(e) => setRuleArchive(e.target.checked)} />
                받은편지함 건너뛰기
              </label>
            </div>
          </div>

          <div className="lb-summary">{ruleSummary}</div>
          <button className="btn btn-primary lb-run-btn" disabled={ruleInvalid || ruleBusy} onClick={applyRule}>
            {ruleBusy ? "적용 중…" : "규칙 실행"}
          </button>
          {ruleDone && <div className="lb-done">{ruleDone}</div>}
          {ruleError && <div className="lb-error">{ruleError}</div>}
        </div>
      )}

      {sub === "tidy" && (
        <>
          <div className="lb-tidy-scroll">
            {flatRows.length === 0 && <p className="text-muted" style={{ padding: 14 }}>아직 만든 라벨이 없습니다.</p>}
            {flatRows.map((row) => {
              const pending = pendingByPath.get(row.fullPath);
              const pendingChanged = !!row.label && !!pending && pending !== row.fullPath;
              const childCount = descendantsOf(row).length;
              const canMerge = !!row.label || childCount > 0;
              return (
              <div
                key={row.fullPath}
                className={row.fullPath === activeRowPath ? "lb-row active" : "lb-row"}
              >
                <span className="lb-row-actions">
                <button
                  className="btn btn-ghost btn-icon"
                  disabled={row.index === 0}
                  title="위로"
                  onClick={() => moveRow(row, -1)}
                >
                  <IconChevronUp />
                </button>
                <button
                  className="btn btn-ghost btn-icon"
                  disabled={row.index === row.siblingsLen - 1}
                  title="아래로"
                  onClick={() => moveRow(row, 1)}
                >
                  <IconChevronDown />
                </button>
                <button
                  className="btn btn-ghost btn-icon"
                  disabled={!canMerge}
                  title={childCount > 0 ? "다른 라벨로 병합 (하위 라벨 포함)" : "다른 라벨로 병합"}
                  onClick={() => canMerge && askMerge(row)}
                >
                  <IconMerge />
                </button>
                <button
                  className="btn btn-ghost btn-icon"
                  disabled={!row.label}
                  title="삭제"
                  onClick={() => row.label && askDelete(row.label, row.fullPath)}
                >
                  <IconTrash />
                </button>
                </span>
                <span
                  className="lb-row-name"
                  style={{ marginLeft: row.depth * 14, fontWeight: row.depth === 0 ? 600 : 400 }}
                >
                  {row.displayName}
                </span>
                {pendingChanged && (
                  <span className="lb-row-pending">→ {pending!.split("/").pop()}</span>
                )}
                <span className="lb-row-count">{row.label ? "" : `그룹${childCount ? ` (${childCount})` : ""}`}</span>
              </div>
              );
            })}
          </div>
          {orderDirty && (
            <div className="lb-order-banner">
              <span>순서를 바꿨습니다. 저장하면 라벨 이름 앞에 순번(01_)이 붙습니다.</span>
              <button className="btn btn-primary" disabled={orderBusy} onClick={saveOrder}>
                {orderBusy ? "저장 중…" : "순서 저장"}
              </button>
            </div>
          )}
          {orderMsg && (
            <div className={orderMsg.type === "ok" ? "lb-order-msg ok" : "lb-order-msg err"}>{orderMsg.text}</div>
          )}
        </>
      )}

      {confirm && (
        <div className="dialog-backdrop">
          <div className="dialog">
            <div className="dialog-title">
              {confirm.type === "delete" ? `"${confirm.label.name}" 라벨 삭제` : `"${confirm.sourceRow.fullPath}" 병합`}
            </div>
            {confirm.type === "merge" && (() => {
              const desc = descendantsOf(confirm.sourceRow);
              const excludeIds = new Set(desc.map((r) => r.label?.id).filter(Boolean));
              if (confirm.sourceRow.label) excludeIds.add(confirm.sourceRow.label.id);
              return (
                <>
                  <div className="field">
                    <label>병합할 대상 라벨</label>
                    <select
                      className="input"
                      value={confirm.mergeToId}
                      onChange={(e) => setConfirm({ ...confirm, mergeToId: e.target.value })}
                    >
                      {realLabelRows
                        .filter((r) => r.label && !excludeIds.has(r.label.id))
                        .map((r) => (
                          <option key={r.label!.id} value={r.label!.id}>
                            {r.label!.name}
                          </option>
                        ))}
                    </select>
                  </div>
                  {desc.length > 0 && (
                    <p className="lb-hint">하위 라벨 {desc.length}개도 대상 라벨 밑으로 함께 옮겨집니다.</p>
                  )}
                </>
              );
            })()}
            <div className="dialog-body">
              {confirm.count === null
                ? "메일 건수를 확인하는 중…"
                : confirm.type === "delete"
                  ? `이 라벨이 붙은 메일 ${confirm.count}건에서 라벨만 떨어집니다. 메일은 삭제되지 않으며 되돌릴 수 없습니다.`
                  : confirm.count > 0
                    ? `메일 ${confirm.count}건에 새 라벨을 붙이고 원본 라벨을 삭제합니다. 되돌릴 수 없습니다.`
                    : "이 그룹에는 직접 붙은 메일이 없습니다. 하위 라벨만 옮겨집니다. 되돌릴 수 없습니다."}
            </div>
            <div className="dialog-actions">
              <button className="btn btn-secondary" onClick={() => setConfirm(null)}>
                취소
              </button>
              <button
                className="btn btn-primary"
                disabled={confirmBusy || confirm.count === null || (confirm.type === "merge" && !confirm.mergeToId)}
                onClick={doConfirm}
              >
                {confirmBusy ? "처리 중…" : confirm.type === "merge" ? "병합" : "삭제"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
