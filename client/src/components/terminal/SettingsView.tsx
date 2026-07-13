// SettingsView.tsx — Contract (Symbol), the FULL Exit Strategy controls (same as the old
// market page: Tight/Standard/Wide, direction, TP targets, trailer, zone targets, side-entry
// longs), Signal Engine, Machine Learning, and a single Discord-bot link card.
import { useEffect, useRef, useState } from "react";
import { Ico } from "./icons";
import { Card, Row, Seg, Toggle, Stepper } from "./controls";
import { C } from "./terminalStyles";
import type { TerminalSettings, ExitProfile, TradeDirection } from "@/lib/terminalSettings";

const PROFILES: { key: ExitProfile; label: string; sub: string; color: string }[] = [
  { key: "safe", label: "Tight", sub: "SL 4 · TP2 28", color: "#26c87a" },
  { key: "risky", label: "Standard", sub: "SL 5 · TP2 20", color: "#f59e0b" },
  { key: "riskiest", label: "Wide", sub: "SL 10 · TP2 30", color: "#ef4444" },
];

// ── AutoTrader card — arm / disarm + contract config, mirrors the old market page ──
type ContractType = "MES" | "ES";
type AutoDir = "both" | "long" | "short";

const ALL_INTERVALS = ["1m", "5m", "15m", "60m"] as const;

// PROGRAM-BACKUP: one-press mirror of the project source into the Desktop backup folder
// ("DAY TRADING PC - DO NOT TOUCH"). The server does the copy (robocopy /MIR) so the same
// button always refreshes the same folder — press it whenever the program is in a state
// worth keeping.
function BackupCard() {
  const [state, setState] = useState<"idle" | "running" | "ok" | "err">("idle");
  const [detail, setDetail] = useState("");

  const run = async () => {
    if (state === "running") return;
    setState("running");
    setDetail("");
    try {
      const r = await fetch("/api/backup/program", { method: "POST" });
      const d = await r.json();
      if (d?.ok) {
        setState("ok");
        setDetail(d.changed ? (d.copied != null ? `${d.copied} files updated` : "backup updated") : "already up to date");
      } else {
        setState("err");
        setDetail(d?.error ?? "backup failed");
      }
    } catch {
      setState("err");
      setDetail("server unreachable");
    }
    setTimeout(() => setState("idle"), 6000);
  };

  const color = state === "ok" ? "#26c87a" : state === "err" ? "#ef4444" : C.accent;
  return (
    <Card icon={Ico.sliders()} title="Program Backup">
      <Row label="Back Up Program" hint="mirrors the program into the Desktop backup folder">
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {detail && <span style={{ fontSize: 11, color }}>{detail}</span>}
          <button
            onClick={run}
            disabled={state === "running"}
            style={{
              padding: "6px 16px", borderRadius: 6, border: `1px solid ${color}88`,
              background: color + "1a", color, fontWeight: 600, fontSize: 12,
              cursor: state === "running" ? "wait" : "pointer", transition: "all .2s",
            }}>
            {state === "running" ? "BACKING UP…" : state === "ok" ? "BACKED UP ✓" : state === "err" ? "FAILED — RETRY" : "BACK UP NOW"}
          </button>
        </div>
      </Row>
    </Card>
  );
}

function AutoTraderCard() {
  const [connected, setConnected] = useState(false);
  const [hasActiveTrade, setHasActiveTrade] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [contractType, setContractType] = useState<ContractType>("MES");
  const [contracts, setContracts] = useState(1);
  const [tp1Only, setTp1Only] = useState(false);
  const [direction, setDirection] = useState<AutoDir>("both");
  const [intervals, setIntervals] = useState<string[]>(["1m", "5m", "15m", "60m"]);
  const [syncing, setSyncing] = useState(false);
  const [testState, setTestState] = useState<"idle" | "sending" | "ok" | "err">("idle");
  const testMsg = useRef("");
  const loaded = useRef(false);

  // Poll status + load settings on mount.
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      // cache:"no-store" — never let the browser revalidate (a 304 isn't res.ok, which would
      // skip the update and leave a stale "Engine disconnected" even when the study is connected).
      try { const r = await fetch("/api/trade/status", { cache: "no-store" }); if (r.ok) { const d = await r.json(); if (alive) { setConnected(!!d.connected); } } } catch { if (alive) setConnected(false); }
      try { const r2 = await fetch("/api/trade/current", { cache: "no-store" }); if (r2.ok) { const d2 = await r2.json(); if (alive) setHasActiveTrade(!!(d2.trade && d2.trade.status === "open")); } } catch {}
    };
    fetch("/api/trade/settings").then((r) => r.json()).then((d) => {
      if (!alive) return;
      if (typeof d.enabled === "boolean") setEnabled(d.enabled);
      if (d.contractType === "MES" || d.contractType === "ES") setContractType(d.contractType);
      if (typeof d.contracts === "number") setContracts(d.contracts);
      if (typeof d.tp1Only === "boolean") setTp1Only(d.tp1Only);
      if (d.direction === "both" || d.direction === "long" || d.direction === "short") setDirection(d.direction);
      if (Array.isArray(d.intervals) && d.intervals.length > 0) setIntervals(d.intervals);
      loaded.current = true;
    }).catch(() => { loaded.current = true; });
    poll();
    const id = setInterval(poll, 5000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const save = async (patch: Record<string, unknown>) => {
    setSyncing(true);
    try { await fetch("/api/trade/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) }); }
    catch { /* non-fatal */ } finally { setSyncing(false); }
  };

  const toggleArm = async () => {
    if (!connected || syncing) return;
    const next = !enabled;
    setSyncing(true);
    try {
      await fetch("/api/trade/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: next }) });
      setEnabled(next);
    } catch { /* keep current state on error */ } finally { setSyncing(false); }
  };

  const sendTestOrder = async () => {
    setTestState("sending");
    try {
      const r = await fetch("/api/trade/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol: contractType,
          direction: "Long",
          interval: "test",
          riskLevel: "safe",
          price: 6900,
          tp1: 6910,
          tp2: 6920,
          sl: 6890,
          contracts,
          tp1Only,
        }),
      });
      if (r.ok) {
        testMsg.current = "Test order sent — check MotiveWave order manager";
        setTestState("ok");
      } else {
        const d = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
        testMsg.current = d.error ?? `HTTP ${r.status}`;
        setTestState("err");
      }
    } catch (e: unknown) {
      testMsg.current = e instanceof Error ? e.message : "Network error";
      setTestState("err");
    }
    setTimeout(() => setTestState("idle"), 7000);
  };

  const armState = !enabled ? "OFF" : !connected ? "OFF" : hasActiveTrade ? "LIVE" : "ARMED";
  const armColor = armState === "LIVE" ? "#1fd98a" : armState === "ARMED" ? "#ffb454" : "#7c8190";

  return (
    <Card icon={Ico.bars()} title="AutoTrader" span>
      {/* Status banner */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px", borderRadius: 10, border: `1px solid ${armColor}55`, background: `${armColor}12`, marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ width: 8, height: 8, borderRadius: 4, background: armColor, display: "inline-block" }} />
          <span style={{ fontWeight: 700, fontSize: 13, color: armColor, letterSpacing: 1 }}>{armState}</span>
          {armState === "LIVE" && <span style={{ fontSize: 11, color: armColor + "bb" }}>Trade open · monitoring</span>}
          {armState === "ARMED" && <span style={{ fontSize: 11, color: armColor + "bb" }}>{contractType} · {contracts} contract{contracts > 1 ? "s" : ""}</span>}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {!connected && <span style={{ fontSize: 10, color: C.muted }}>Engine disconnected</span>}
          <button
            onClick={toggleArm}
            disabled={!connected || syncing}
            style={{
              padding: "7px 16px", borderRadius: 8, border: `1px solid ${armColor}88`, fontWeight: 700, fontSize: 12, letterSpacing: 0.5, cursor: connected && !syncing ? "pointer" : "not-allowed",
              background: enabled ? `${armColor}22` : "transparent", color: connected ? armColor : C.muted, transition: "all .2s",
            }}
          >
            {syncing ? "…" : enabled ? "DISARM" : (connected ? "ARM" : "NOT CONNECTED")}
          </button>
        </div>
      </div>

      <Row label="Contract">
        <div style={{ display: "flex", gap: 8 }}>
          {(["MES", "ES"] as ContractType[]).map((t) => (
            <button key={t} className={"tt-profile" + (contractType === t ? " active" : "")} style={{ padding: "6px 16px", ...(contractType === t ? { borderColor: C.accent, background: C.accent + "1a", color: C.accent } : {}) }}
              onClick={() => { setContractType(t); save({ contractType: t, contracts, tp1Only, direction, intervals, enabled }); }}>
              <div className="tt-profile-label">{t}</div>
              <div className="tt-profile-sub">{t === "MES" ? "$5/pt" : "$50/pt"}</div>
            </button>
          ))}
        </div>
      </Row>
      <Row label="Contracts per trade">
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <button onClick={() => { const n = Math.max(1, contracts - 1); setContracts(n); save({ contractType, contracts: n, tp1Only, direction, intervals, enabled }); }} style={{ width: 28, height: 28, borderRadius: 6, border: `1px solid ${C.line}`, background: "transparent", color: C.accent, fontSize: 16, cursor: "pointer" }}>−</button>
          <span style={{ fontFamily: "var(--fm)", fontSize: 15, fontWeight: 700, minWidth: 28, textAlign: "center" }}>{contracts}</span>
          <button onClick={() => { const n = Math.min(10, contracts + 1); setContracts(n); save({ contractType, contracts: n, tp1Only, direction, intervals, enabled }); }} style={{ width: 28, height: 28, borderRadius: 6, border: `1px solid ${C.line}`, background: "transparent", color: C.accent, fontSize: 16, cursor: "pointer" }}>+</button>
        </div>
      </Row>
      <Row label="Direction">
        <div style={{ display: "flex", gap: 8 }}>
          {(["both", "long", "short"] as AutoDir[]).map((d) => {
            const col = d === "long" ? "#1fd98a" : d === "short" ? "#ff4d6d" : C.accent;
            return (
              <button key={d} style={{ padding: "5px 12px", borderRadius: 6, border: `1px solid ${direction === d ? col + "88" : C.line}`, background: direction === d ? col + "1a" : "transparent", color: direction === d ? col : C.muted, fontWeight: 600, fontSize: 12, cursor: "pointer", transition: "all .2s" }}
                onClick={() => { setDirection(d); save({ contractType, contracts, tp1Only, direction: d, intervals, enabled }); }}>
                {d === "both" ? "Both" : d === "long" ? "▲ Long" : "▼ Short"}
              </button>
            );
          })}
        </div>
      </Row>
      <Row label="Exit mode">
        <div style={{ display: "flex", gap: 8 }}>
          {[{ v: false, l: "TP1 + TP2" }, { v: true, l: "TP1 Only" }].map(({ v, l }) => (
            <button key={l} style={{ padding: "5px 12px", borderRadius: 6, border: `1px solid ${tp1Only === v ? C.accent + "88" : C.line}`, background: tp1Only === v ? C.accent + "1a" : "transparent", color: tp1Only === v ? C.accent : C.muted, fontWeight: 600, fontSize: 12, cursor: "pointer" }}
              onClick={() => { setTp1Only(v); save({ contractType, contracts, tp1Only: v, direction, intervals, enabled }); }}>
              {l}
            </button>
          ))}
        </div>
      </Row>
      <Row label="Intervals" hint="which interval signals auto-trade">
        <div style={{ display: "flex", gap: 6 }}>
          {ALL_INTERVALS.map((iv) => {
            const active = intervals.includes(iv);
            return (
              <button key={iv}
                onClick={() => {
                  const next = active
                    ? intervals.filter(i => i !== iv)
                    : [...intervals, iv];
                  if (next.length === 0) return; // keep at least one
                  setIntervals(next);
                  save({ intervals: next });
                }}
                style={{
                  padding: "5px 10px", borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: "pointer", transition: "all .2s",
                  border: `1px solid ${active ? C.accent + "88" : C.line}`,
                  background: active ? C.accent + "1a" : "transparent",
                  color: active ? C.accent : C.muted,
                }}
              >{iv}</button>
            );
          })}
        </div>
      </Row>

      {/* Test order button */}
      <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${C.line}` }}>
        <div style={{ fontSize: 10, color: C.muted, marginBottom: 6 }}>Send a dummy Long order to verify the MW connection</div>
        <button
          onClick={sendTestOrder}
          disabled={testState === "sending"}
          style={{
            padding: "6px 14px", borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: testState === "sending" ? "not-allowed" : "pointer",
            border: `1px solid ${testState === "ok" ? "#1fd98a88" : testState === "err" ? "#ef535088" : C.accent + "88"}`,
            background: testState === "ok" ? "#1fd98a1a" : testState === "err" ? "#ef53501a" : C.accent + "1a",
            color: testState === "ok" ? "#1fd98a" : testState === "err" ? "#ef5350" : C.accent,
            transition: "all .2s",
          }}
        >
          {testState === "sending" ? "Sending…" : testState === "ok" ? "✓ Sent" : testState === "err" ? "✕ Failed" : "Send Test Order"}
        </button>
        {(testState === "ok" || testState === "err") && (
          <div style={{ fontSize: 10, marginTop: 5, color: testState === "ok" ? "#1fd98a" : "#ef5350", lineHeight: 1.4 }}>
            {testMsg.current}
          </div>
        )}
      </div>

      {enabled && (
        <div style={{ marginTop: 10, fontSize: 11, color: "#ef5350", fontWeight: 700, letterSpacing: 0.5, textAlign: "center" }}>
          ⚠ AUTO TRADE ON — LIVE ORDERS WILL BE PLACED
        </div>
      )}
    </Card>
  );
}

function DiscordCard() {
  const [webhook, setWebhook] = useState<string>(() => {
    try { return localStorage.getItem("discord_webhook") ?? ""; } catch { return ""; }
  });
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");

  const save = async () => {
    setState("saving");
    try {
      const r = await fetch("/api/discord/settings", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ webhook }),
      });
      if (!r.ok) { setState("error"); return; }
      try { localStorage.setItem("discord_webhook", webhook); } catch { /* ignore */ }
      setState("saved");
      setTimeout(() => setState("idle"), 2000);
    } catch { setState("error"); }
  };

  return (
    <Card icon={Ico.signal()} title="Discord Bot" span>
      <div className="tt-discord">
        <input className="tt-discord-input" type="text" placeholder="https://discord.com/api/webhooks/…"
          value={webhook} onChange={(e) => setWebhook(e.target.value)} spellCheck={false} />
        <button className="tt-discord-save" onClick={save} disabled={state === "saving"}
          style={state === "saved" ? { borderColor: C.up, color: C.up } : undefined}>
          {state === "saving" ? "Linking…" : state === "saved" ? "✓ Linked" : state === "error" ? "Failed" : "Link Bot"}
        </button>
      </div>
      <div className="tt-discord-hint">Paste the Discord webhook URL — signals are relayed straight to your channel.</div>
    </Card>
  );
}

export function SettingsView({
  s, set,
}: {
  s: TerminalSettings;
  set: (updater: (prev: TerminalSettings) => TerminalSettings) => void;
}) {
  const u = <K extends keyof TerminalSettings>(k: K, v: TerminalSettings[K]) => set((p) => ({ ...p, [k]: v }));
  const dirLabel = s.direction === "both" ? "Both" : s.direction === "long" ? "Long" : "Short";

  return (
    <div className="tt-settings-grid">
      <Card icon={Ico.bars()} title="Contract">
        <Row label="Symbol"><Seg options={["MES", "ES", "MNQ"] as const} value={s.symbol as "MES" | "ES" | "MNQ"} onChange={(v) => u("symbol", v)} /></Row>
      </Card>

      <Card icon={Ico.signal()} title="Exit Strategy">
        <div className="tt-profiles">
          {PROFILES.map((p) => {
            const active = s.exitStrategy === p.key;
            return (
              <button key={p.key} className={"tt-profile" + (active ? " active" : "")}
                onClick={() => u("exitStrategy", p.key)}
                style={active ? { borderColor: p.color, background: p.color + "1a" } : undefined}>
                <div className="tt-profile-label" style={active ? { color: p.color } : undefined}>{p.label}</div>
                <div className="tt-profile-sub">{p.sub}</div>
              </button>
            );
          })}
        </div>
        <Row label="Direction"><Seg options={["Both", "Long", "Short"] as const} value={dirLabel} onChange={(v) => u("direction", v.toLowerCase() as TradeDirection)} /></Row>
        <Row label="Targets" hint="TP1 only, or TP1 + TP2"><Seg options={["TP1", "TP1+TP2"] as const} value={s.tp1Only ? "TP1" : "TP1+TP2"} onChange={(v) => u("tp1Only", v === "TP1")} /></Row>
        <Row label="Trailer Stop" hint={s.useTrailer ? `trails ${s.trailerOffset}pt after TP1` : "fixed TP1 + TP2 bracket"}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {s.useTrailer && <Stepper value={s.trailerOffset} step={0.25} min={0.25} max={10} onChange={(v) => u("trailerOffset", v)} fmt={(v) => v + "pt"} />}
            <Toggle on={s.useTrailer} onClick={() => u("useTrailer", !s.useTrailer)} />
          </div>
        </Row>
        <Row label="Zone Targets" hint="TP/SL snap to nearest zones"><Toggle on={s.useZoneTargets} onClick={() => u("useZoneTargets", !s.useZoneTargets)} /></Row>
        <Row label="Side-Entry Longs" hint="every vector side entry → Long"><Toggle on={s.takeSideEntries} onClick={() => u("takeSideEntries", !s.takeSideEntries)} /></Row>
      </Card>

      <Card icon={Ico.bars()} title="Signal Engine">
        <Row label="Fire on Closed Candles Only"><Toggle on={s.closed} onClick={() => u("closed", !s.closed)} /></Row>
        <Row label="Required Confirmations"><Seg options={["1", "2", "3", "4"] as const} value={s.confirms} onChange={(v) => u("confirms", v)} /></Row>
      </Card>

      <Card icon={Ico.signal()} title="Machine Learning">
        <Row label="Feedback Loop" hint="learn from closed trades"><Toggle on={s.ml} onClick={() => u("ml", !s.ml)} /></Row>
        <Row label="Retrain Frequency"><Seg options={["Daily", "Weekly", "Manual"] as const} value={s.retrain} onChange={(v) => u("retrain", v)} /></Row>
      </Card>

      <AutoTraderCard />
      <BackupCard />
      <DiscordCard />
    </div>
  );
}
