// ShadowScalpsCard.tsx — "Shadow scalps (record only)" card for the Signals tab (2026-10-06).
//
// Reads GET /api/signals/shadow-scalps/summary?era=live|all&friction=0.7|1.0|1.5 (server/
// shadow-scalps-routes.ts, read-only, body cached 60 s server-side) and shows one row per shadow
// strategy — S1 ORB-30, S2 box fade [limit], S2 box fade [close] — at the decision cell TP6/SL8
// under PESSIMISTIC fills: n, win %, net/trade, PF, max DD, both halves, plus a status chip driven by
// the route's own kill / promotion flags (live-only, pessimistic, 1.0-pt friction — never recomputed
// here). Learning cells (4/6, 5/8) sit behind a toggle. Collapsed by default; polls every 60 s.
//
// RECORD ONLY: nothing on this card places orders, sends alerts or feeds the engine.
// NO RANDOM-ENTRY CONTROL (owner decision 2026-10-07): there is no RANDOM / Δ-vs-RANDOM column; the
// promotion bar is the bracket's break-even arithmetic (6/8 at 1.0 pt → 64.3 % win) plus the
// robustness checks the route reports.
//
// The pure helpers below (status chip, number formatting, row selection) are exported so
// scripts/shadow-scalps-card.test.ts can run them under tsx with no DOM; keep them free of React.
import { useEffect, useMemo, useState } from "react";
import { C } from "./terminalStyles";

// ───────────────────────────── types (mirror of the route body) ─────────────────────────────

export type ShadowEra = "live" | "all";
export type ShadowFriction = 0.7 | 1.0 | 1.5;
export const SHADOW_FRICTIONS: ShadowFriction[] = [0.7, 1.0, 1.5];
export const SHADOW_POLL_MS = 60_000;
export const SHADOW_DECISION_CELL = "6/8";
export const SHADOW_DECISION_MODEL = "pessimistic";
export const SHADOW_KILL_MIN_N = 100;
export const SHADOW_PROMOTE_MIN_N = 300;

export interface ShadowStats {
  n: number; wins: number; winPct: number | null; netPerTrade: number | null; netPts: number;
  pf: number | null; maxDD: number;
  halves: { h1: { n: number; netPerTrade: number | null }; h2: { n: number; netPerTrade: number | null }; splitDay: string | null };
  dropBest3NetPerTrade: number | null;
  sd: number | null;
}
export interface ShadowSummaryRow {
  strategy: string; variant: string; cell: string; decisionCell: boolean; fillModel: string;
  stats: ShadowStats;
  netPerTradeByFriction: Record<string, number | null>;
  kill: boolean | null;
}
export interface ShadowDecision {
  strategy: string; variant: string; cell: string; decisionCell: boolean;
  liveN: number; netPerTrade: number | null; h1: number | null; h2: number | null;
  dropBest3NetPerTrade: number | null;
  kill: boolean;
  promotion: { nOk: boolean; netOk: boolean; halvesOk: boolean; dropBest3Ok: boolean; all: boolean };
  verdict: "KEEP" | "KILL";
}
export interface ShadowSummary {
  enabled?: boolean;
  era?: ShadowEra; frictionPts?: number; frictionsShown?: number[];
  sessions?: { count: number; first: string | null; last: string | null; halvesSplitDay: string | null; byEra?: { backfill: number; live: number } };
  rows?: ShadowSummaryRow[];
  decisions?: ShadowDecision[];
  lastRunAt?: string | null;
  lastJob?: { at: string; trigger: string; era: string; rows: number; error?: string } | null;
  cells?: Array<{ id: string; tp: number; sl: number; decision: boolean }>;
  decisionCell?: string;
  rules?: { killMinN?: number; killNetBelow?: number; promoteMinN?: number; promoteNetAtLeast?: number };
  note?: string;
}

// ───────────────────────────── pure helpers (unit-tested) ─────────────────────────────

/** The three shadow strategies, in display order. */
export const SHADOW_STRATEGIES: Array<{ strategy: string; variant: string; label: string; tip: string }> = [
  { strategy: "S1", variant: "orb30", label: "S1 ORB-30",
    tip: "Opening-range breakout: first 1m close beyond the 09:30–10:00 ET range, at most once per side per day, entries until 12:00, flat 16:55. Entry at the next bar's open + 1 tick." },
  { strategy: "S2", variant: "limit", label: "S2 box fade [limit]",
    tip: "Yellow-box edge fade with a RESTING LIMIT at the edge, placed only while price is within 2 pts of it; a fill needs a 1-tick trade-through. The hypothesis under test — does the cheaper fill turn the fade's small direction skill positive?" },
  { strategy: "S2", variant: "close", label: "S2 box fade [close]",
    tip: "The same yellow-box edge fade entered at the bar close (market), recorded alongside the limit version for comparison." },
];

export type ShadowStatus = "RECORDING" | "KEEP" | "KILL" | "PROMOTABLE";

/** Status chip from the route's own flags. PROMOTABLE (every promotion check met) and KILL are
 *  mutually exclusive by construction (net ≥ +0.3 vs net < −0.3); below the kill-rule sample the
 *  row is still RECORDING; otherwise KEEP (the route's default verdict). */
export function shadowStatus(d: { liveN: number; kill: boolean; promotable: boolean }, killMinN = SHADOW_KILL_MIN_N): ShadowStatus {
  if (d.promotable) return "PROMOTABLE";
  if (d.kill) return "KILL";
  if (!(d.liveN >= killMinN)) return "RECORDING";
  return "KEEP";
}

export function shadowStatusColor(s: ShadowStatus): string {
  switch (s) {
    case "PROMOTABLE": return C.up;
    case "KILL": return C.down;
    case "KEEP": return C.accent;
    default: return C.muted;
  }
}

export function shadowStatusTip(s: ShadowStatus, liveN: number, rules?: ShadowSummary["rules"]): string {
  const killN = rules?.killMinN ?? SHADOW_KILL_MIN_N;
  const promoN = rules?.promoteMinN ?? SHADOW_PROMOTE_MIN_N;
  const killBelow = rules?.killNetBelow ?? -0.3;
  const promoAt = rules?.promoteNetAtLeast ?? 0.3;
  switch (s) {
    case "RECORDING": return `Recording — ${liveN} of ${killN} live trades before the kill rule applies (net < ${fmtSigned(killBelow)}/trade at pessimistic fills, 1.0-pt friction). Promotion needs ${promoN}.`;
    case "KILL": return `Kill rule tripped: ${liveN} live trades and net/trade below ${fmtSigned(killBelow)} at pessimistic fills, 1.0-pt friction. Stop recording this candidate.`;
    case "PROMOTABLE": return `Every promotion check holds on live rows: n ≥ ${promoN}, net ≥ ${fmtSigned(promoAt)}/trade at pessimistic fills + 1.0 pt (the 6/8 bracket breaks even at a 64.3 % win rate), both halves positive, still positive without its best 3 days. NEXT STEP is 50+ hand-placed SIM trades, not an order.`;
    default: return `Keep recording — ${liveN} live trades, not killed, promotion bar (n ≥ ${promoN}, net ≥ ${fmtSigned(promoAt)}, both halves > 0, drop-best-3 > 0) not yet met.`;
  }
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Signed fixed-point points: "+0.42" / "−1.30" / "—". */
export function fmtSigned(v: number | null | undefined, digits = 2): string {
  if (!isNum(v)) return "—";
  const s = Math.abs(v).toFixed(digits);
  return (v < 0 && Number(s) !== 0 ? "−" : v > 0 ? "+" : "") + s;
}
/** Plain fixed-point: "12.50" / "—". */
export function fmtNum(v: number | null | undefined, digits = 2): string {
  return isNum(v) ? v.toFixed(digits) : "—";
}
/** Percent with one decimal: "61.3%" / "—". */
export function fmtPct(v: number | null | undefined): string {
  return isNum(v) ? `${v.toFixed(1)}%` : "—";
}
/** Profit factor: "1.24" / "∞" (no losses, some gain) / "—". */
export function fmtPF(v: number | null | undefined, hasWins = false): string {
  if (isNum(v)) return v.toFixed(2);
  return hasWins ? "∞" : "—";
}
/** Relative time for the LAST RUN footer: "never" / "just now" / "12 min ago" / "3 h ago" / "2 d ago". */
export function fmtAgo(iso: string | null | undefined, nowMs = Date.now()): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "never";
  const s = Math.max(0, Math.round((nowMs - t) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}
/** "2026-09-16" → "Sep 16" (a day KEY, not an instant — no timezone math). */
export function fmtDayKey(key: string | null | undefined): string {
  if (!key) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return key;
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const mi = Number(m[2]) - 1;
  return `${MON[mi] ?? m[2]} ${Number(m[3])}`;
}
/** "14 sessions · Sep 16 → Oct 6 · live 14 / backfill 0" (null-safe). */
export function sessionsLine(s: ShadowSummary | null | undefined): string {
  const ses = s?.sessions;
  if (!ses || !isNum(ses.count) || ses.count <= 0) return "no sessions recorded yet";
  const span = ses.first && ses.last ? (ses.first === ses.last ? fmtDayKey(ses.first) : `${fmtDayKey(ses.first)} → ${fmtDayKey(ses.last)}`) : "";
  const byEra = ses.byEra ? ` · live ${ses.byEra.live ?? 0} / backfill ${ses.byEra.backfill ?? 0}` : "";
  return `${ses.count} session${ses.count === 1 ? "" : "s"}${span ? ` · ${span}` : ""}${byEra}`;
}

/** One rendered row: a strategy × cell at pessimistic fills, joined with its live-only decision. */
export interface ShadowViewRow {
  key: string; label: string; tip: string; strategy: string; variant: string; cell: string; decisionCell: boolean;
  n: number; winPct: number | null; netPerTrade: number | null; pf: number | null; hasWins: boolean; maxDD: number | null;
  h1: number | null; h2: number | null; splitDay: string | null;
  byFriction: Record<string, number | null>;
  liveN: number; status: ShadowStatus;
}

/** Whether the route body is something we can render rows from. `{enabled:false}`, null, a
 *  non-object or a body without a rows array all count as "no data" (never throws). */
export function shadowEnabled(s: ShadowSummary | null | undefined): boolean {
  if (!s || typeof s !== "object") return false;
  if (s.enabled === false) return false;
  return Array.isArray(s.rows);
}

/** Pick the display rows: the three strategies × (decision cell, + learning cells when asked) at
 *  pessimistic fills, always in the fixed order, a placeholder (n = 0, RECORDING) when the route
 *  has nothing for a slot. Decisions are matched by strategy|variant|cell — they are live-only
 *  regardless of the era shown, which is what the chip must reflect. */
export function selectShadowRows(s: ShadowSummary | null | undefined, opts: { showLearning?: boolean } = {}): ShadowViewRow[] {
  const rows = shadowEnabled(s) ? (s!.rows as ShadowSummaryRow[]) : [];
  const decisions = Array.isArray(s?.decisions) ? (s!.decisions as ShadowDecision[]) : [];
  const killMinN = s?.rules?.killMinN ?? SHADOW_KILL_MIN_N;
  const decisionCell = s?.decisionCell ?? SHADOW_DECISION_CELL;
  const cellIds: string[] = (() => {
    const fromRoute = Array.isArray(s?.cells) ? s!.cells!.map((c) => c?.id).filter((id): id is string => typeof id === "string") : [];
    const all = fromRoute.length ? fromRoute : [SHADOW_DECISION_CELL, "4/6", "5/8"];
    const ordered = [decisionCell, ...all.filter((c) => c !== decisionCell)];
    return opts.showLearning ? ordered : ordered.filter((c) => c === decisionCell);
  })();
  const out: ShadowViewRow[] = [];
  for (const st of SHADOW_STRATEGIES) {
    for (const cell of cellIds) {
      const r = rows.find((x) => x && x.strategy === st.strategy && x.variant === st.variant && x.cell === cell && x.fillModel === SHADOW_DECISION_MODEL);
      const d = decisions.find((x) => x && x.strategy === st.strategy && x.variant === st.variant && x.cell === cell);
      const stats = r?.stats;
      const liveN = isNum(d?.liveN) ? d!.liveN : 0;
      const kill = d?.kill === true || r?.kill === true;
      const promotable = d?.promotion?.all === true;
      out.push({
        key: `${st.strategy}|${st.variant}|${cell}`, label: st.label, tip: st.tip,
        strategy: st.strategy, variant: st.variant, cell, decisionCell: cell === decisionCell,
        n: isNum(stats?.n) ? stats!.n : 0,
        winPct: isNum(stats?.winPct) ? stats!.winPct : null,
        netPerTrade: isNum(stats?.netPerTrade) ? stats!.netPerTrade : null,
        pf: isNum(stats?.pf) ? stats!.pf : null,
        hasWins: isNum(stats?.wins) ? stats!.wins > 0 : false,
        maxDD: isNum(stats?.maxDD) ? stats!.maxDD : null,
        h1: isNum(stats?.halves?.h1?.netPerTrade) ? stats!.halves.h1.netPerTrade : null,
        h2: isNum(stats?.halves?.h2?.netPerTrade) ? stats!.halves.h2.netPerTrade : null,
        splitDay: stats?.halves?.splitDay ?? null,
        byFriction: r?.netPerTradeByFriction && typeof r.netPerTradeByFriction === "object" ? r.netPerTradeByFriction : {},
        liveN,
        status: shadowStatus({ liveN, kill, promotable }, killMinN),
      });
    }
  }
  return out;
}

/** Tooltip for the NET/TR cell: the same row at every recorded friction. */
export function frictionTip(byFriction: Record<string, number | null>, shown: number): string {
  const keys = Object.keys(byFriction).sort((a, b) => Number(a) - Number(b));
  if (!keys.length) return `Net per trade at ${shown.toFixed(1)}-pt round-trip friction (pessimistic fills).`;
  return `Net/trade by round-trip friction (pessimistic fills): ${keys.map((k) => `${k} pt → ${fmtSigned(byFriction[k])}`).join(" · ")}. Shown: ${shown.toFixed(1)} pt.`;
}

export function shadowQueryUrl(era: ShadowEra, friction: ShadowFriction): string {
  return `/api/signals/shadow-scalps/summary?era=${era}&friction=${friction.toFixed(1)}`;
}

// ───────────────────────────── the card ─────────────────────────────

/** The table header, in render order (exported so the card test pins it — no RANDOM / Δ-vs-RANDOM
 *  column since the owner's 2026-10-07 decision). */
export const SHADOW_HEADER: Array<{ label: string; title?: string; right?: boolean }> = [
  { label: "STRATEGY" },
  { label: "CELL", title: "TP / SL in points. 6/8 is the decision cell; 4/6 and 5/8 are learning cells." },
  { label: "N", right: true, title: "Trades in the era shown (pessimistic fills)" },
  { label: "WIN %", right: true, title: "Share of trades with net > 0 after friction. The 6/8 bracket breaks even at 64.3 % with 1.0-pt friction." },
  { label: "NET/TR", right: true, title: "Net points per trade after friction" },
  { label: "PF", right: true, title: "Profit factor: gross wins ÷ gross losses after friction" },
  { label: "MAX DD", right: true, title: "Max drawdown in points, by trade sequence" },
  { label: "H1 / H2", right: true, title: "Net/trade in the first and second half of the recorded span (split at the middle session)" },
  { label: "STATUS", title: "RECORDING (below the kill-rule sample) · KEEP · KILL · PROMOTABLE — from the route's live-only verdicts" },
];
// 9-column grid, one track per SHADOW_HEADER entry.
export const SHADOW_GRID = "1.5fr 0.45fr 0.5fr 0.6fr 0.65fr 0.5fr 0.6fr 0.95fr 0.95fr";
export const SHADOW_FOOTNOTE = "Record only — no orders, no alerts.";
const GRID = SHADOW_GRID;

type LoadState = "loading" | "ready" | "off" | "missing" | "error";

function Corners() {
  return (<><span className="tt-corner tl" /><span className="tt-corner tr" /><span className="tt-corner bl" /><span className="tt-corner br" /></>);
}

const pillOn = { color: C.bg, background: C.accent, borderColor: C.accent } as const;

export function ShadowScalpsCard() {
  const [open, setOpen] = useState(false);
  const [era, setEra] = useState<ShadowEra>("live");
  const [friction, setFriction] = useState<ShadowFriction>(1.0);
  const [showLearning, setShowLearning] = useState(false);
  const [data, setData] = useState<ShadowSummary | null>(null);
  const [state, setState] = useState<LoadState>("loading");
  const [fetchedAt, setFetchedAt] = useState<number>(0);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let retried = false;
    const load = async () => {
      try {
        const res = await fetch(shadowQueryUrl(era, friction));
        if (cancelled) return;
        if (res.status === 404) { setState("missing"); return; } // server not restarted since the route landed
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as ShadowSummary;
        if (cancelled) return;
        setData(body);
        setFetchedAt(Date.now());
        setState(shadowEnabled(body) ? "ready" : "off");
      } catch {
        if (cancelled) return;
        setState((prev) => (prev === "ready" ? "ready" : "error")); // keep the last good table on a transient miss
        // ONE-SHOT WEDGE FIX (JournalView/LedgerView lesson): a busy server must not blank the card
        // until the next 60 s tick — one 4 s retry heals a transient stall.
        if (!retried) { retried = true; window.setTimeout(() => { if (!cancelled) void load(); }, 4_000); }
      }
    };
    void load();
    const t = window.setInterval(() => { void load(); }, SHADOW_POLL_MS); // no hidden-gate: a background pane must still recover
    return () => { cancelled = true; window.clearInterval(t); };
  }, [era, friction, nonce]);

  const rows = useMemo(() => selectShadowRows(data, { showLearning }), [data, showLearning]);
  const decisionRows = useMemo(() => rows.filter((r) => r.decisionCell), [rows]);
  const headline = decisionRows.map((r) => `${r.label.split(" ")[0]}${r.label.includes("[") ? r.label.slice(r.label.indexOf("[")) : ""} ${r.status}`).join(" · ");
  const worst = decisionRows.some((r) => r.status === "KILL") ? "KILL"
    : decisionRows.some((r) => r.status === "PROMOTABLE") ? "PROMOTABLE"
    : decisionRows.some((r) => r.status === "KEEP") ? "KEEP" : "RECORDING";

  return (
    <div className="tt-card" style={{ position: "relative", marginTop: 16 }}>
      <Corners />
      <div className="tt-card-head" style={{ cursor: "pointer", marginBottom: open ? 6 : 0, paddingBottom: open ? 14 : 0, borderBottom: open ? undefined : "none" }}
        onClick={() => setOpen((v) => !v)} title={open ? "Collapse" : "Expand"}>
        <span className="tt-card-ico" style={{ fontSize: 12, width: 12, display: "inline-block", color: C.muted }}>{open ? "▾" : "▸"}</span>
        <h3>Shadow scalps (record only)</h3>
        {state === "ready" && (
          <span className="mono" style={{ fontSize: 10, color: shadowStatusColor(worst as ShadowStatus), letterSpacing: 0.5 }} title={headline}>
            {headline}
          </span>
        )}
        <span className="tt-hint" style={{ marginLeft: "auto" }}>
          {state === "ready" ? `last run ${fmtAgo(data?.lastRunAt)}` : state === "loading" ? "loading…" : state === "missing" ? "route not live yet" : state === "off" ? "recorder off" : "unavailable"}
        </span>
      </div>

      {open && (
        <div>
          <div className="tt-sig-toolbar" style={{ marginTop: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <div className="tt-filters" title="Which recorded era the table counts. Kill / promotion verdicts always use live rows only.">
                {(["live", "all"] as ShadowEra[]).map((e) => (
                  <button key={e} className="tt-filter" onClick={() => setEra(e)} style={era === e ? pillOn : undefined}
                    title={e === "live" ? "Rows recorded after the recorder went live (the only era the rules count)" : "Live + boot-backfill rows (backfill = replayed history, shown for context)"}>
                    {e === "live" ? "LIVE" : "ALL"}
                  </button>
                ))}
              </div>
              <div className="tt-filters" title="Round-trip friction subtracted from every gross trade (MES: 0.7 good RTH day · 1.0 project standard · 1.5 open/news/overnight)">
                {SHADOW_FRICTIONS.map((f) => (
                  <button key={f} className="tt-filter" onClick={() => setFriction(f)} style={friction === f ? pillOn : undefined}
                    title={`${f.toFixed(1)} pt round-trip friction`}>
                    {f.toFixed(1)} pt
                  </button>
                ))}
              </div>
              <button className="tt-filter" onClick={() => setShowLearning((v) => !v)} style={showLearning ? pillOn : undefined}
                title="Also show the learning cells TP 4 / SL 6 and TP 5 / SL 8 — recorded for learning only, never a decision">
                {showLearning ? "hide learning cells" : "show learning cells"}
              </button>
            </div>
            <div className="tt-hint" title="Sessions with recorded rows in the era shown">{sessionsLine(data)}</div>
          </div>

          {state === "missing" && (
            <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.7 }}>
              The shadow-scalps summary route is not live on this server yet — it activates on the owner's next restart. Nothing else is affected.
            </div>
          )}
          {state === "off" && (
            <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.7 }}>
              The shadow-scalps recorder is off on this server (or has not recorded anything yet). No rows to show.
            </div>
          )}
          {state === "error" && (
            <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.7 }}>
              Summary unavailable right now — retrying. <button className="tt-filter" style={{ padding: "3px 9px", fontSize: 10 }} onClick={() => setNonce((n) => n + 1)}>retry now</button>
            </div>
          )}
          {state === "loading" && <div style={{ fontSize: 12, color: C.muted }}>Loading the shadow record…</div>}

          {state === "ready" && (
            <div className="tt-table-wrap">
              <div className="tt-table" style={{ minWidth: 820 }}>
                <div className="tt-thead" style={{ gridTemplateColumns: GRID }}>
                  {SHADOW_HEADER.map((h) => (
                    <span key={h.label} className={h.right ? "r" : undefined} title={h.title}>{h.label}</span>
                  ))}
                </div>
                <div className="tt-tbody">
                  {rows.length === 0 && <div className="tt-empty-row">no shadow rows yet</div>}
                  {rows.map((r, i) => {
                    const col = shadowStatusColor(r.status);
                    const netCol = r.netPerTrade == null ? C.dim : r.netPerTrade >= 0 ? C.up : C.down;
                    return (
                      <div key={r.key} className="tt-trow" style={{ gridTemplateColumns: GRID, animationDelay: i * 45 + "ms", opacity: r.decisionCell ? 1 : 0.72 }}>
                        <span style={{ fontSize: 12 }} title={r.tip}>{r.label}</span>
                        <span className="mono dim" title={r.decisionCell ? "Decision cell" : "Learning cell — never a decision"}>{r.cell}{r.decisionCell ? "" : " ·"}</span>
                        <span className="mono r" title={`${r.n} trades in the era shown · ${r.liveN} live`}>{r.n}</span>
                        <span className="mono r">{fmtPct(r.winPct)}</span>
                        <span className="mono r" style={{ color: netCol }} title={frictionTip(r.byFriction, friction)}>{fmtSigned(r.netPerTrade)}</span>
                        <span className="mono r">{fmtPF(r.pf, r.hasWins)}</span>
                        <span className="mono r down-t">{r.maxDD == null ? "—" : `−${fmtNum(r.maxDD)}`}</span>
                        <span className="mono r" title={r.splitDay ? `Second half starts ${fmtDayKey(r.splitDay)}` : "Not enough sessions to split"}>
                          <span style={{ color: r.h1 == null ? C.dim : r.h1 > 0 ? C.up : C.down }}>{fmtSigned(r.h1)}</span>
                          <span className="dim"> / </span>
                          <span style={{ color: r.h2 == null ? C.dim : r.h2 > 0 ? C.up : C.down }}>{fmtSigned(r.h2)}</span>
                        </span>
                        <span>
                          <span title={shadowStatusTip(r.status, r.liveN, data?.rules)}
                            style={{ fontSize: 9, letterSpacing: 0.6, fontWeight: 700, color: col, border: `1px solid ${col}`, borderRadius: 4, padding: "1px 6px", whiteSpace: "nowrap" }}>
                            {r.status}{r.status === "RECORDING" ? ` ${r.liveN}/${data?.rules?.killMinN ?? SHADOW_KILL_MIN_N}` : ""}
                          </span>
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginTop: 10 }}>
            <div className="tt-prob-note" style={{ marginBottom: 0 }}>{SHADOW_FOOTNOTE}</div>
            <div className="tt-hint mono" title={data?.lastRunAt ? `Last recorder run ${data.lastRunAt}` : "The recorder has not run yet"}>
              {state === "ready" ? `last run ${fmtAgo(data?.lastRunAt)}${data?.lastJob?.error ? " · last job errored" : ""} · refreshed ${fetchedAt ? fmtAgo(new Date(fetchedAt).toISOString()) : "—"} · pessimistic fills` : ""}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
