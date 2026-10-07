// LedgerView.tsx — FORWARD-VALIDATION LEDGER tab (2026-08-02).
// "Is live trading tracking the backtest?" — a pure consumer of GET /api/ledger/summary
// (all math in shared/ledger-stats.ts, all verdict wording imported from there — never
// re-derived here). Self-contained: own 60s poll, no useTerminalData coupling.
//
// Charts are hand-drawn <canvas> panels (DPR-correct pattern from SignalMiniChart) —
// NOT the trading chart; no lightweight-charts series involved.
//
// Honesty rules baked in:
//   - cold start shows "collecting: n/30" instead of a fake verdict (server-driven);
//   - the endpoint may not exist yet on a server booted before this feature landed —
//     a non-JSON response (vite catch-all serves index.html for unknown GETs) renders
//     an explicit "activates on the next server restart" panel, never a crash;
//   - transient fetch failures keep the last good payload on screen.
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { C } from "./terminalStyles";
import { verdictWords, ROLLING_WINDOW, MIN_CLOSED_FOR_VERDICT, PF_CAP, type BacktestExpectation, type LedgerReport, type CumulativePoint, type LedgerVerdict } from "@shared/ledger-stats";

interface LedgerSummary {
  symbol: string;
  sourceFile: string | null;
  expectation: BacktestExpectation | null;
  ledger: LedgerReport;
}

const POLL_MS = 60_000;

function verdictColor(v: LedgerVerdict): string {
  switch (v) {
    case "OK": return C.up;
    case "WATCH": return C.amber;
    case "ALERT": return C.down;
    case "COLLECTING": return C.muted;
  }
}

const fmt1 = (v: number | null | undefined, suffix = ""): string =>
  v == null || !Number.isFinite(v) ? "—" : `${v.toFixed(1)}${suffix}`;
const fmtSigned = (v: number | null | undefined): string =>
  v == null || !Number.isFinite(v) ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}`;
const fmtPF = (v: number | null | undefined): string =>
  v == null || !Number.isFinite(v) ? "—" : v >= PF_CAP ? "∞" : v.toFixed(2);

// ── canvas helpers (DPR-correct; measure → scale transform → draw in CSS px) ──
function prepCanvas(canvas: HTMLCanvasElement): { ctx: CanvasRenderingContext2D; w: number; h: number } | null {
  const rect = canvas.getBoundingClientRect();
  if (rect.width < 10 || rect.height < 10) return null;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);
  return { ctx, w: rect.width, h: rect.height };
}

/** Cumulative live points vs the model's expected line (+ its 2σ lower band). */
function CumulativeChart({ data }: { data: CumulativePoint[] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const draw = () => {
      const p = prepCanvas(canvas);
      if (!p) return;
      const { ctx, w, h } = p;
      if (!data.length) return;
      const padL = 46, padR = 12, padT = 10, padB = 18;
      let lo = 0, hi = 0;
      for (const d of data) {
        for (const v of [d.live, d.expected, d.lower2]) {
          if (v != null && Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
        }
      }
      if (hi === lo) hi = lo + 1;
      const span = hi - lo;
      lo -= span * 0.06; hi += span * 0.06;
      const x = (i: number) => padL + (data.length === 1 ? 0 : (i / (data.length - 1)) * (w - padL - padR));
      const y = (v: number) => padT + (1 - (v - lo) / (hi - lo)) * (h - padT - padB);
      // y grid + labels
      ctx.font = "9px 'IBM Plex Mono', monospace";
      ctx.textAlign = "right"; ctx.textBaseline = "middle";
      for (let g = 0; g <= 4; g++) {
        const v = lo + (g / 4) * (hi - lo);
        ctx.strokeStyle = C.lineSoft ?? "rgba(255,255,255,0.05)";
        ctx.beginPath(); ctx.moveTo(padL, y(v)); ctx.lineTo(w - padR, y(v)); ctx.stroke();
        ctx.fillStyle = C.dim;
        ctx.fillText(`${v >= 0 ? "+" : ""}${Math.round(v)}`, padL - 6, y(v));
      }
      // zero line
      if (lo < 0 && hi > 0) {
        ctx.strokeStyle = "rgba(255,255,255,0.18)";
        ctx.beginPath(); ctx.moveTo(padL, y(0)); ctx.lineTo(w - padR, y(0)); ctx.stroke();
      }
      const line = (pick: (d: CumulativePoint) => number | null, color: string, dash: number[], width: number) => {
        ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash);
        ctx.beginPath();
        let started = false;
        for (let i = 0; i < data.length; i++) {
          const v = pick(data[i]);
          if (v == null || !Number.isFinite(v)) continue;
          if (!started) { ctx.moveTo(x(i), y(v)); started = true; } else ctx.lineTo(x(i), y(v));
        }
        ctx.stroke(); ctx.setLineDash([]); ctx.lineWidth = 1;
      };
      line(d => d.lower2, "rgba(255,77,109,0.55)", [3, 4], 1);   // 2σ band floor
      line(d => d.expected, C.muted, [6, 4], 1.25);              // model expectation
      line(d => d.live, C.accent, [], 2);                        // reality
      // x label
      ctx.fillStyle = C.dim; ctx.textAlign = "center"; ctx.textBaseline = "bottom";
      ctx.fillText(`closed live trades → (${data.length})`, padL + (w - padL - padR) / 2, h - 3);
    };
    draw();
    window.addEventListener("resize", draw);
    return () => window.removeEventListener("resize", draw);
  }, [data]);
  return <canvas ref={ref} style={{ width: "100%", height: 220, display: "block" }} />;
}

/** Rolling 30-trade profit factor sparkline (display-clamped to 0..5). */
function PFSparkline({ series, expPF }: { series: Array<{ ts: number; pf: number | null }>; expPF: number | null }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const draw = () => {
      const p = prepCanvas(canvas);
      if (!p) return;
      const { ctx, w, h } = p;
      if (!series.length) return;
      const CLAMP = 5;
      const padL = 30, padR = 8, padT = 6, padB = 6;
      const vals = series.map(s => (s.pf == null ? null : Math.max(0, Math.min(CLAMP, s.pf))));
      const x = (i: number) => padL + (series.length === 1 ? 0 : (i / (series.length - 1)) * (w - padL - padR));
      const y = (v: number) => padT + (1 - v / CLAMP) * (h - padT - padB);
      ctx.font = "9px 'IBM Plex Mono', monospace"; ctx.textAlign = "right"; ctx.textBaseline = "middle";
      // break-even guide at PF 1.0 + the model's PF guide
      const guide = (v: number, color: string, label: string) => {
        if (v <= 0 || v > CLAMP) return;
        ctx.strokeStyle = color; ctx.setLineDash([3, 4]);
        ctx.beginPath(); ctx.moveTo(padL, y(v)); ctx.lineTo(w - padR, y(v)); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = color; ctx.fillText(label, padL - 4, y(v));
      };
      guide(1, "rgba(255,77,109,0.6)", "1.0");
      if (expPF != null && Number.isFinite(expPF)) guide(Math.min(expPF, CLAMP), C.muted, expPF.toFixed(1));
      ctx.strokeStyle = C.accent; ctx.lineWidth = 1.6;
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < vals.length; i++) {
        const v = vals[i];
        if (v == null) continue;
        if (!started) { ctx.moveTo(x(i), y(v)); started = true; } else ctx.lineTo(x(i), y(v));
      }
      ctx.stroke(); ctx.lineWidth = 1;
    };
    draw();
    window.addEventListener("resize", draw);
    return () => window.removeEventListener("resize", draw);
  }, [series, expPF]);
  return <canvas ref={ref} style={{ width: "100%", height: 90, display: "block" }} />;
}

function Corners() {
  return (<><span className="tt-corner tl" /><span className="tt-corner tr" /><span className="tt-corner bl" /><span className="tt-corner br" /></>);
}

function Tile({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="tt-stat">
      <div className="tt-stat-l">{label}</div>
      <div className="tt-stat-v" style={color ? { color } : undefined}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: C.muted, marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

export function LedgerView({ symbol = "MES" }: { symbol?: string }) {
  const [data, setData] = useState<LedgerSummary | null>(null);
  const [state, setState] = useState<"loading" | "unavailable" | "ready">("loading");

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      // A server booted before this feature HANGS on unknown /api/ledger/* GETs
      // (verified live — no 404, no catch-all): abort after 10s so the honest
      // "not live yet" panel appears instead of an eternal spinner.
      const ac = new AbortController();
      const timer = window.setTimeout(() => ac.abort(), 10_000);
      try {
        const res = await fetch(`/api/ledger/summary?symbol=${encodeURIComponent(symbol)}`, { signal: ac.signal });
        const ct = res.headers.get("content-type") ?? "";
        // A pre-feature server that DOES answer falls through to the vite catch-all,
        // which returns index.html with HTTP 200 — that is also "endpoint not live yet".
        if (!res.ok || !ct.includes("application/json")) {
          if (!cancelled) setState(prev => (prev === "ready" ? prev : "unavailable"));
          return;
        }
        const j = (await res.json()) as LedgerSummary;
        if (!cancelled && j && j.ledger) { setData(j); setState("ready"); }
      } catch {
        // abort or transient failure: keep whatever is on screen (never blank a good payload)
        if (!cancelled) setState(prev => (prev === "ready" ? prev : "unavailable"));
      } finally {
        window.clearTimeout(timer);
      }
    };
    // RETRY (2026-08-12 audit — the JournalView 2026-08-07 lesson applied here too): a boot-slab
    // stall on the FIRST probe wedged the "not live yet" panel until the next poll (and forever
    // in a hidden pane, where the poll is visibility-gated). One quick 4s retry self-heals the
    // common case; the poll also drops its hidden-gate for the unavailable state so a background
    // tab can recover.
    void load().then(() => {
      window.setTimeout(() => { if (!cancelled) void load(); }, 4_000);
    });
    const t = window.setInterval(() => { void load(); }, POLL_MS); // no hidden-gate: a stuck "unavailable" must be able to recover in background panes
    return () => { cancelled = true; window.clearInterval(t); };
  }, [symbol]);

  if (state !== "ready" || !data) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16, paddingBottom: 40 }}>
        <div className="tt-card" style={{ position: "relative" }}>
          <Corners />
          <div className="tt-card-head"><h3>FORWARD VALIDATION LEDGER</h3></div>
          <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.7 }}>
            {state === "loading"
              ? "Loading the ledger…"
              : "The ledger endpoint is not live yet on this server — it activates on the next server restart. Nothing is wrong with your data; check back after the next deploy."}
          </div>
        </div>
      </div>
    );
  }

  const { ledger, expectation } = data;
  const vColor = verdictColor(ledger.verdict);
  const ivs = [...new Set([...Object.keys(ledger.perInterval), ...Object.keys(expectation?.perInterval ?? {})])]
    .sort((a, b) => (parseInt(a) || 0) - (parseInt(b) || 0));
  const lastCum = ledger.cumulative.length ? ledger.cumulative[ledger.cumulative.length - 1] : null;

  const th: CSSProperties = { textAlign: "right", padding: "6px 10px", fontSize: 9, letterSpacing: 1.2, color: C.muted, whiteSpace: "nowrap" };
  const td: CSSProperties = { textAlign: "right", padding: "6px 10px", fontSize: 11, fontFamily: "var(--fm)", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, paddingBottom: 40 }}>
      {/* verdict + headline metrics */}
      <div className="tt-stat-grid" style={{ marginBottom: 0 }}>
        <Tile
          label="DRIFT VERDICT"
          value={verdictWords(ledger.verdict)}
          color={vColor}
          sub={ledger.collecting ? `${ledger.collecting.closed} of ${ledger.collecting.needed} live trades closed` : `rolling ${ROLLING_WINDOW}-trade check`}
        />
        <Tile
          label="LIVE TRADES"
          value={String(ledger.liveClosed)}
          sub={`closed · ${ledger.liveOpen} open/unresolved`}
        />
        <Tile
          label="LIVE WIN RATE"
          value={fmt1(ledger.liveWinRate, "%")}
          sub={`backtest ${fmt1(expectation?.expWinRate, "%")}`}
        />
        <Tile
          label="LIVE EXPECTANCY"
          value={`${fmtSigned(ledger.liveExpectancy)} pts`}
          sub={`backtest ${fmtSigned(expectation?.expExpectancy)} pts/trade`}
        />
        <Tile
          label={`PROFIT FACTOR (LAST ${ROLLING_WINDOW})`}
          value={fmtPF(ledger.rolling30?.pf ?? null)}
          sub={`all live ${fmtPF(ledger.livePF)} · backtest ${fmtPF(expectation?.expPF)}`}
        />
        <Tile
          label="NET POINTS (LIVE)"
          value={fmtSigned(ledger.liveNetPts)}
          color={ledger.liveNetPts >= 0 ? C.up : C.down}
          sub={lastCum?.expected != null ? `model expected ${fmtSigned(lastCum.expected)} by now` : "no model baseline on file"}
        />
      </div>

      {/* plain-English verdict */}
      <div className="tt-card" style={{ position: "relative", borderLeft: `2px solid ${vColor}` }}>
        <Corners />
        <div className="tt-card-head"><h3>WHAT THIS MEANS</h3></div>
        <div style={{ fontSize: 12, color: C.text, lineHeight: 1.7 }}>{ledger.verdictReason}</div>
        <div style={{ fontSize: 10, color: C.dim, marginTop: 8, lineHeight: 1.6 }}>
          Counts only signals fired live in production. Backtest re-runs are excluded — this page measures reality against the model, never the model against itself.
        </div>
      </div>

      {/* cumulative live vs expected */}
      <div className="tt-card" style={{ position: "relative" }}>
        <Corners />
        <div className="tt-card-head"><h3>LIVE POINTS VS THE MODEL</h3></div>
        <div style={{ display: "flex", gap: 16, fontSize: 10, color: C.muted, marginBottom: 8, flexWrap: "wrap" }}>
          <span><span style={{ color: C.accent }}>━</span> live (actual)</span>
          <span><span style={{ color: C.muted }}>╌</span> model expectation</span>
          <span><span style={{ color: C.down }}>╌</span> 2-sigma floor (below this = off track)</span>
        </div>
        {ledger.cumulative.length
          ? <CumulativeChart data={ledger.cumulative} />
          : <div style={{ fontSize: 12, color: C.muted }}>No closed live trades yet — the curve starts with the first resolved live signal.</div>}
      </div>

      {/* rolling PF sparkline */}
      <div className="tt-card" style={{ position: "relative" }}>
        <Corners />
        <div className="tt-card-head"><h3>ROLLING {ROLLING_WINDOW}-TRADE PROFIT FACTOR</h3></div>
        {ledger.rolling30PFSeries.length
          ? <PFSparkline series={ledger.rolling30PFSeries} expPF={expectation?.expPF ?? null} />
          : <div style={{ fontSize: 12, color: C.muted }}>Appears once {MIN_CLOSED_FOR_VERDICT} live trades have closed ({ledger.liveClosed} so far).</div>}
      </div>

      {/* per-interval mini-table */}
      <div className="tt-card" style={{ position: "relative" }}>
        <Corners />
        <div className="tt-card-head"><h3>BY TIMEFRAME — LIVE VS BACKTEST</h3></div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 520 }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${C.line}` }}>
                <th style={{ ...th, textAlign: "left" }}>TF</th>
                <th style={th}>LIVE N</th>
                <th style={th}>LIVE WIN</th>
                <th style={th}>LIVE EXP</th>
                <th style={th}>LIVE PF</th>
                <th style={th}>BT WIN</th>
                <th style={th}>BT EXP</th>
                <th style={th}>BT PF</th>
              </tr>
            </thead>
            <tbody>
              {ivs.length === 0 && (
                <tr><td style={{ ...td, textAlign: "left", color: C.muted }} colSpan={8}>No closed trades on either side yet.</td></tr>
              )}
              {ivs.map(iv => {
                const lv = ledger.perInterval[iv];
                const bt = expectation?.perInterval?.[iv];
                return (
                  <tr key={iv} style={{ borderBottom: `1px solid ${C.lineSoft ?? C.line}` }}>
                    <td style={{ ...td, textAlign: "left", color: C.accent }}>{iv}</td>
                    <td style={td}>{lv ? lv.trades : "—"}</td>
                    <td style={td}>{fmt1(lv?.winRate ?? null, "%")}</td>
                    <td style={td}>{lv ? fmtSigned(lv.expectancy) : "—"}</td>
                    <td style={td}>{fmtPF(lv?.pf ?? null)}</td>
                    <td style={{ ...td, color: C.muted }}>{fmt1(bt?.winRate ?? null, "%")}</td>
                    <td style={{ ...td, color: C.muted }}>{bt ? fmtSigned(bt.expectancy) : "—"}</td>
                    <td style={{ ...td, color: C.muted }}>{fmtPF(bt?.pf ?? null)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div style={{ fontSize: 10, color: C.dim, marginTop: 8, lineHeight: 1.6 }}>
          {expectation
            ? `Backtest baseline: ${expectation.trades} closed trades, ${expectation.windowFromKey ?? "?"} → ${expectation.windowToKey ?? "?"}${data.sourceFile ? ` (${data.sourceFile})` : ""}${expectation.generatedAt ? `, generated ${new Date(expectation.generatedAt).toLocaleString()}` : ""}.`
            : "No standing backtest results file on this server — live stats shown without a model baseline."}
        </div>
      </div>
    </div>
  );
}
