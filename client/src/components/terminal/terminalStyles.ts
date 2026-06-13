// terminalStyles.ts — MERIDIAN palette + full CSS (preserved verbatim from the design
// source of truth). Fonts: Chakra Petch (labels) + IBM Plex Mono (numbers).

export const C = {
  bg: "#06070b",
  text: "#e9ebf1",
  muted: "#7c8190",
  dim: "#565b69",
  line: "rgba(255,255,255,0.08)",
  lineSoft: "rgba(255,255,255,0.045)",
  panel: "rgba(255,255,255,0.022)",
  panel2: "rgba(255,255,255,0.04)",
  accent: "#2dd4bf",
  amber: "#ffb454",
  up: "#1fd98a",
  down: "#ff4d6d",
} as const;

// SINGLE-TIER: every signal is "SAFE". Kept the palette entry so styling matches the
// design exactly; the RISKY / RISKIEST / SAFE+ filters are removed elsewhere.
export const TIER: Record<string, { c: string; bg: string; bd: string }> = {
  SAFE: { c: "#1fd98a", bg: "rgba(31,217,138,0.13)", bd: "rgba(31,217,138,0.38)" },
};

export const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600;700&display=swap');

.tt-root{
  --fd:'Chakra Petch', ui-sans-serif, system-ui, sans-serif;
  --fm:'IBM Plex Mono', ui-monospace, 'SF Mono', monospace;
  position:relative; width:100%; height:100vh; min-height:100vh; overflow:hidden;
  color:${C.text}; background:radial-gradient(120% 90% at 50% 0%, #0a0c14 0%, ${C.bg} 70%);
  font-family:var(--fd); -webkit-font-smoothing:antialiased;
}
.tt-root *{ box-sizing:border-box; }
.tt-canvas{ position:fixed; inset:0; width:100%; height:100%; z-index:0; display:block; }
.tt-overlay{ position:fixed; inset:0; z-index:1; pointer-events:none;
  background:linear-gradient(180deg, rgba(4,5,9,0.55) 0%, rgba(4,5,9,0) 16%, rgba(4,5,9,0) 78%, rgba(4,5,9,0.55) 100%);
}
.tt-app{ position:relative; z-index:2; display:flex; flex-direction:column; height:100vh; }

/* corner brackets */
.tt-corner{ position:absolute; width:9px; height:9px; border:1.5px solid rgba(45,212,191,0.45); pointer-events:none; }
.tt-corner.tl{ top:-1px; left:-1px; border-right:none; border-bottom:none; }
.tt-corner.tr{ top:-1px; right:-1px; border-left:none; border-bottom:none; }
.tt-corner.bl{ bottom:-1px; left:-1px; border-right:none; border-top:none; }
.tt-corner.br{ bottom:-1px; right:-1px; border-left:none; border-top:none; }

/* header */
.tt-header{ display:flex; align-items:center; gap:18px; padding:16px 28px;
  border-bottom:1px solid ${C.line}; background:linear-gradient(180deg, rgba(8,10,16,0.78), rgba(8,10,16,0.35));
  backdrop-filter:blur(10px); }
.tt-brand{ display:flex; align-items:center; gap:11px; background:none; border:none; cursor:pointer; padding:0; }
.tt-brand-txt{ display:flex; flex-direction:column; align-items:flex-start; line-height:1; }
.tt-brand-name{ font-size:17px; font-weight:700; letter-spacing:3px; color:${C.text}; }
.tt-brand-sub{ font-size:9px; letter-spacing:2.5px; color:${C.muted}; text-transform:uppercase; margin-top:3px; }

.tt-tabs{ flex:1; display:flex; justify-content:center; gap:6px; }
.tt-tab{ display:flex; align-items:center; gap:8px; padding:9px 16px; background:none; border:1px solid transparent;
  border-radius:9px; color:${C.muted}; font-family:var(--fd); font-size:13px; font-weight:500; letter-spacing:1px;
  text-transform:uppercase; cursor:pointer; transition:all .2s; }
.tt-tab:hover{ color:${C.text}; background:rgba(255,255,255,0.03); }
.tt-tab.active{ color:${C.accent}; background:rgba(45,212,191,0.08); border-color:rgba(45,212,191,0.28);
  box-shadow:0 0 18px rgba(45,212,191,0.10) inset; }
.tt-tab-ico{ display:inline-flex; opacity:.9; }

.tt-strat-wrap{ position:relative; }
.tt-strat-btn{ display:flex; align-items:center; gap:8px; padding:9px 16px; border-radius:9px;
  background:rgba(45,212,191,0.10); border:1px solid rgba(45,212,191,0.30); color:${C.accent};
  font-family:var(--fd); font-size:13px; font-weight:600; letter-spacing:1px; text-transform:uppercase;
  cursor:pointer; transition:all .2s; }
.tt-strat-btn:hover{ background:rgba(45,212,191,0.16); box-shadow:0 0 22px rgba(45,212,191,0.18); }
.tt-strat-btn.open{ background:rgba(45,212,191,0.18); }

.tt-backdrop{ position:fixed; inset:0; z-index:20; }
.tt-dropdown{ position:absolute; top:calc(100% + 12px); right:0; z-index:30; width:340px;
  background:rgba(11,13,20,0.96); border:1px solid ${C.line}; border-radius:14px; padding:8px;
  box-shadow:0 24px 60px rgba(0,0,0,0.6), 0 0 30px rgba(45,212,191,0.06);
  transform-origin:top right; animation:ddIn .32s cubic-bezier(.2,.85,.25,1); backdrop-filter:blur(16px); }
@keyframes ddIn{ from{ opacity:0; transform:translateY(-10px) scale(.97); } to{ opacity:1; transform:none; } }
.tt-dd-head{ font-size:10px; letter-spacing:2px; color:${C.muted}; text-transform:uppercase; padding:8px 10px 10px; }
.tt-dd-row{ display:flex; align-items:center; justify-content:space-between; gap:12px; padding:11px 10px;
  border-radius:10px; transition:background .18s; opacity:0; animation:rowDrop .4s ease forwards; }
.tt-dd-row:hover{ background:rgba(255,255,255,0.03); }
@keyframes rowDrop{ from{ opacity:0; transform:translateY(-8px); } to{ opacity:1; transform:none; } }
.tt-dd-name{ font-size:14px; font-weight:600; color:${C.text}; display:flex; align-items:center; gap:8px; }
.tt-dd-stat{ font-family:var(--fm); font-size:10px; color:${C.accent}; background:rgba(45,212,191,0.10);
  padding:2px 7px; border-radius:5px; font-weight:500; }
.tt-dd-desc{ font-size:11px; color:${C.muted}; margin-top:3px; }

/* main */
.tt-main{ flex:1; overflow-y:auto; overflow-x:hidden; }
.tt-main::-webkit-scrollbar{ width:9px; }
.tt-main::-webkit-scrollbar-thumb{ background:rgba(255,255,255,0.08); border-radius:9px; }
.tt-container{ max-width:1260px; margin:0 auto; padding:26px 28px 90px; }
.tt-view{ animation:viewIn .42s cubic-bezier(.2,.8,.2,1); }
@keyframes viewIn{ from{ opacity:0; transform:translateY(16px) scale(.992); filter:blur(7px); } to{ opacity:1; transform:none; filter:none; } }

/* market head */
.tt-mkt-head{ display:flex; align-items:center; gap:26px; flex-wrap:wrap; margin-bottom:16px; }
.tt-mkt-id{ display:flex; flex-direction:column; gap:7px; }
.tt-mkt-sym{ font-size:24px; font-weight:700; letter-spacing:2px; display:flex; align-items:baseline; gap:10px; }
.tt-mkt-tag{ font-size:10px; letter-spacing:1.5px; color:${C.muted}; font-weight:500; }
.tt-live{ display:flex; align-items:center; gap:7px; font-size:10px; letter-spacing:1.5px; color:${C.up}; }
.tt-live.closed{ color:${C.muted}; }
.tt-live-dot{ width:7px; height:7px; border-radius:50%; background:${C.up}; box-shadow:0 0 8px ${C.up}; animation:pulse 1.8s infinite; }
.tt-live.closed .tt-live-dot{ background:${C.muted}; box-shadow:none; animation:none; }
@keyframes pulse{ 0%,100%{ opacity:1; transform:scale(1); } 50%{ opacity:.35; transform:scale(.7); } }
.tt-mkt-price{ display:flex; flex-direction:column; }
.tt-mkt-last{ font-family:var(--fm); font-size:30px; font-weight:600; line-height:1; font-variant-numeric:tabular-nums; }
.tt-mkt-chg{ font-family:var(--fm); font-size:13px; margin-top:6px; font-variant-numeric:tabular-nums; }
.tt-mkt-stats{ display:flex; gap:24px; margin-left:auto; }
.tt-mkt-stats div{ display:flex; flex-direction:column; gap:5px; }
.tt-mkt-stats span{ font-size:9px; letter-spacing:1.5px; color:${C.muted}; }
.tt-mkt-stats b{ font-family:var(--fm); font-size:15px; font-weight:500; color:${C.text}; font-variant-numeric:tabular-nums; }
.tt-reload{ width:38px; height:38px; display:flex; align-items:center; justify-content:center; border-radius:9px;
  background:rgba(255,255,255,0.03); border:1px solid ${C.line}; color:${C.muted}; cursor:pointer; transition:all .2s; }
.tt-reload:hover{ color:${C.accent}; border-color:rgba(45,212,191,0.35); background:rgba(45,212,191,0.08); transform:rotate(-45deg); }

.tt-active-strip{ display:flex; align-items:center; gap:9px; margin-bottom:14px; flex-wrap:wrap; }
.tt-active-label{ font-size:9px; letter-spacing:1.8px; color:${C.dim}; }
.tt-active-none{ font-size:11px; color:${C.dim}; font-style:italic; }
.tt-active-chip{ display:flex; align-items:center; gap:7px; font-size:11px; letter-spacing:.5px; color:${C.text};
  background:rgba(255,255,255,0.03); border:1px solid ${C.line}; padding:5px 11px; border-radius:7px; }
.tt-active-cdot{ width:6px; height:6px; border-radius:50%; background:${C.accent}; box-shadow:0 0 6px ${C.accent}; }

/* chart */
.tt-chart{ position:relative; height:380px; border:1px solid ${C.line}; border-radius:14px;
  background:linear-gradient(180deg, rgba(255,255,255,0.018), rgba(255,255,255,0)); padding:0; }
.tt-chart-empty{ position:absolute; inset:0; display:flex; align-items:center; justify-content:center;
  font-size:12px; letter-spacing:1.5px; color:${C.muted}; text-transform:uppercase; }
.tt-plot{ position:absolute; left:0; top:0; bottom:24px; right:62px; overflow:hidden; border-radius:14px 0 0 0; }
.tt-grid-line{ position:absolute; left:0; right:0; height:1px; background:${C.lineSoft}; }
.tt-sweep{ position:absolute; top:0; bottom:0; width:12%; left:-15%; pointer-events:none;
  background:linear-gradient(90deg, transparent, rgba(45,212,191,0.10), transparent); animation:sweep 1.15s ease-out forwards; }
@keyframes sweep{ from{ left:-15%; opacity:0; } 12%{ opacity:1; } 88%{ opacity:1; } to{ left:115%; opacity:0; } }
.tt-candle-last{ animation:candleGlow 1.6s ease-in-out infinite; }
@keyframes candleGlow{ 0%,100%{ box-shadow:0 0 8px var(--glow); } 50%{ box-shadow:0 0 16px var(--glow); } }
.tt-price-line{ position:absolute; left:0; right:0; height:0; border-top:1px dashed rgba(45,212,191,0.45); }
.tt-price-tag{ position:absolute; right:-60px; top:-9px; font-family:var(--fm); font-size:11px; font-weight:600;
  color:${C.bg}; background:${C.accent}; padding:2px 6px; border-radius:4px; width:56px; text-align:center;
  box-shadow:0 0 10px rgba(45,212,191,0.4); }
.tt-yaxis{ position:absolute; right:0; top:0; bottom:24px; width:62px; }
.tt-ylabel{ position:absolute; right:8px; transform:translateY(-50%); font-family:var(--fm); font-size:10px;
  color:${C.muted}; font-variant-numeric:tabular-nums; }
.tt-xaxis{ position:absolute; left:0; right:62px; bottom:0; height:22px; }
.tt-xlabel{ position:absolute; transform:translateX(-50%); top:5px; font-family:var(--fm); font-size:10px; color:${C.muted}; }

/* stat grid (signals) */
.tt-stat-grid{ display:grid; grid-template-columns:repeat(4,1fr); gap:14px; margin-bottom:18px; }
.tt-stat{ position:relative; padding:16px 18px; border:1px solid ${C.line}; border-radius:12px;
  background:rgba(10,12,18,0.82); backdrop-filter:blur(10px); opacity:0; animation:statIn .5s ease forwards; }
@keyframes statIn{ from{ opacity:0; transform:translateY(12px); } to{ opacity:1; transform:none; } }
.tt-stat-l{ font-size:9px; letter-spacing:1.8px; color:${C.muted}; }
.tt-stat-v{ font-family:var(--fm); font-size:26px; font-weight:600; margin-top:8px; font-variant-numeric:tabular-nums; }

.tt-filters{ display:flex; gap:8px; margin-bottom:14px; flex-wrap:wrap; }
.tt-filter{ padding:7px 14px; border-radius:8px; background:rgba(255,255,255,0.03); border:1px solid ${C.line};
  color:${C.muted}; font-family:var(--fd); font-size:11px; letter-spacing:1px; font-weight:500; cursor:pointer; transition:all .18s; }
.tt-filter:hover{ color:${C.text}; }

/* table */
.tt-table-wrap{ overflow-x:auto; border:1px solid ${C.line}; border-radius:12px;
  background:rgba(10,12,18,0.85); backdrop-filter:blur(10px); }
.tt-table{ min-width:880px; }
.tt-thead, .tt-trow{ display:grid; grid-template-columns:0.85fr 0.7fr 0.6fr 0.95fr 0.7fr 0.7fr 0.7fr 0.7fr 0.7fr 0.9fr 0.6fr; align-items:center; }
.tt-thead{ padding:13px 18px; border-bottom:1px solid ${C.line}; }
.tt-thead span{ font-size:9px; letter-spacing:1.5px; color:${C.muted}; }
.tt-thead .r, .tt-trow .r{ text-align:right; }
.tt-tbody{ }
.tt-empty-row{ padding:34px 18px; text-align:center; font-size:12px; letter-spacing:1px; color:${C.muted}; text-transform:uppercase; }
.tt-trow{ padding:13px 18px; border-bottom:1px solid ${C.lineSoft}; font-size:13px; transition:background .15s;
  opacity:0; animation:trowIn .35s ease forwards; }
.tt-trow:last-child{ border-bottom:none; }
.tt-trow:hover{ background:rgba(255,255,255,0.025); }
@keyframes trowIn{ from{ opacity:0; transform:translateX(-10px); } to{ opacity:1; transform:none; } }
.mono{ font-family:var(--fm); font-variant-numeric:tabular-nums; }
.dim{ color:${C.muted}; }
.down-t{ color:#c98a96; }
.tt-side{ font-weight:600; font-size:12px; letter-spacing:.5px; }
.tt-status{ font-size:11px; font-weight:500; letter-spacing:.5px; display:flex; align-items:center; gap:6px; }
.tt-st-dot{ width:6px; height:6px; border-radius:50%; background:${C.accent}; box-shadow:0 0 6px ${C.accent}; animation:pulse 1.8s infinite; }
.tt-tier{ font-family:var(--fm); font-size:10px; font-weight:600; padding:3px 8px; border-radius:5px; border:1px solid; letter-spacing:.5px; }

/* settings */
.tt-settings-grid{ display:grid; grid-template-columns:repeat(2,1fr); gap:16px; }
.tt-card{ position:relative; border:1px solid ${C.line}; border-radius:14px; padding:18px;
  background:rgba(10,12,18,0.85); backdrop-filter:blur(10px); }
.tt-card-head{ display:flex; align-items:center; gap:10px; padding-bottom:14px; margin-bottom:6px; border-bottom:1px solid ${C.lineSoft}; }
.tt-card-ico{ display:inline-flex; color:${C.accent}; }
.tt-card-head h3{ margin:0; font-size:12px; font-weight:600; letter-spacing:2px; text-transform:uppercase; color:${C.text}; }
.tt-row{ display:flex; align-items:center; justify-content:space-between; gap:16px; padding:11px 0; }
.tt-row-label{ display:flex; flex-direction:column; gap:3px; }
.tt-row-label > span:first-child{ font-size:13px; color:${C.text}; }
.tt-hint{ font-size:10px; color:${C.muted}; letter-spacing:.3px; }
.tt-row-ctrl{ flex-shrink:0; }

.tt-toggle{ width:40px; height:22px; border-radius:999px; border:none; cursor:pointer; position:relative; padding:2px; transition:background .2s; }
.tt-knob{ display:block; width:18px; height:18px; border-radius:50%; background:#fff; transition:transform .22s cubic-bezier(.2,.85,.25,1); box-shadow:0 1px 3px rgba(0,0,0,0.4); }
.tt-seg{ display:inline-flex; gap:3px; padding:3px; background:rgba(255,255,255,0.04); border:1px solid ${C.line}; border-radius:10px; }
.tt-seg-btn{ padding:5px 11px; border-radius:7px; border:none; cursor:pointer; font-family:var(--fm); font-size:11px; transition:all .18s; }
.tt-slider-row{ display:flex; align-items:center; gap:13px; min-width:180px; }
.tt-range{ width:130px; height:4px; cursor:pointer; }
.tt-slider-val{ font-family:var(--fm); font-size:13px; color:${C.text}; min-width:46px; text-align:right; font-variant-numeric:tabular-nums; }
.tt-stepper{ display:inline-flex; align-items:center; gap:2px; background:rgba(255,255,255,0.04); border:1px solid ${C.line}; border-radius:8px; padding:2px; }
.tt-step-btn{ width:24px; height:24px; border-radius:6px; border:none; background:transparent; color:${C.accent}; font-size:16px; cursor:pointer; transition:background .15s; }
.tt-step-btn:hover{ background:rgba(45,212,191,0.12); }
.tt-step-val{ font-family:var(--fm); font-size:12px; color:${C.text}; min-width:48px; text-align:center; font-variant-numeric:tabular-nums; }
.tt-feed{ display:grid; grid-template-columns:repeat(3,1fr); gap:8px 24px; }
.tt-host{ font-family:var(--fm); font-size:13px; color:${C.accent}; background:rgba(45,212,191,0.08); padding:5px 11px; border-radius:7px; border:1px solid rgba(45,212,191,0.2); }
.tt-conn{ display:flex; align-items:center; gap:7px; font-family:var(--fm); font-size:11px; letter-spacing:1px; color:${C.up}; }
.tt-conn.off{ color:${C.down}; }
.tt-conn-dot{ width:7px; height:7px; border-radius:50%; background:${C.up}; box-shadow:0 0 8px ${C.up}; animation:pulse 1.8s infinite; }
.tt-conn.off .tt-conn-dot{ background:${C.down}; box-shadow:0 0 8px ${C.down}; }

/* clock (compact) */
.tt-clock{ position:fixed; right:20px; bottom:18px; z-index:5; padding:9px 14px; border:1px solid ${C.line};
  border-radius:11px; background:rgba(8,10,16,0.78); backdrop-filter:blur(14px);
  box-shadow:0 12px 30px rgba(0,0,0,0.5), 0 0 20px rgba(45,212,191,0.05); text-align:right; }
.tt-clock-time{ font-family:var(--fm); font-size:21px; font-weight:600; letter-spacing:1.5px; line-height:1; color:${C.text};
  font-variant-numeric:tabular-nums; text-shadow:0 0 12px rgba(45,212,191,0.22); }
.tt-clock-meta{ display:flex; flex-direction:column; align-items:flex-end; gap:3px; margin-top:6px; }
.tt-clock-date{ font-size:9px; letter-spacing:1.2px; color:${C.muted}; text-transform:uppercase; }
.tt-clock-mkt{ display:flex; align-items:center; gap:5px; font-size:9px; font-weight:600; letter-spacing:1px; }
.tt-clock-dot{ width:6px; height:6px; border-radius:50%; animation:pulse 1.8s infinite; }

/* ── floating layout: the market chart is the full-screen background ──────── */
.tt-livechart{ position:fixed; inset:0; z-index:0; }
.tt-livechart-host{ position:absolute; inset:0; width:100%; height:100%; }
.tt-livechart .tt-sweep{ position:absolute; top:0; bottom:0; z-index:1; }
/* Floating: the app container must NOT capture pointer events, or the full-screen chart
   behind it (z-index:0) can never be dragged/zoomed. We make the whole app transparent to
   events and re-enable only the interactive pieces (header, HUD, and the Signals/Settings
   panels). On the Market tab the empty center then falls through to the chart. */
.tt-floating .tt-app{ pointer-events:none; }
.tt-floating .tt-header{ pointer-events:auto; }
.tt-floating .tt-ticker{ pointer-events:auto; }          /* news ticker links clickable (was inheriting none from .tt-app) */
.tt-floating .tt-main{ pointer-events:auto; }            /* Signals / Settings panels interactive */
.tt-floating .tt-main.passthrough{ pointer-events:none; } /* Market tab: pass clicks to the chart */
.tt-floating .tt-main.passthrough .tt-hud{ pointer-events:auto; }
.tt-floating .tt-clock{ pointer-events:auto; }
.tt-floating .tt-overlay{ background:radial-gradient(120% 100% at 50% 38%, rgba(6,7,11,0) 52%, rgba(6,7,11,0.5) 100%); }

/* floating market-head HUD panel */
.tt-hud{ display:inline-flex; flex-direction:column; gap:11px; max-width:min(760px,94vw);
  background:rgba(8,10,16,0.6); border:1px solid ${C.line}; border-radius:14px; padding:14px 18px;
  backdrop-filter:blur(12px); box-shadow:0 16px 40px rgba(0,0,0,0.45); }
.tt-hud .tt-mkt-head{ margin-bottom:0; gap:22px; }
.tt-hud .tt-active-strip{ margin-bottom:0; }

/* signals toolbar: side filters + author / learn */
.tt-sig-toolbar{ display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:14px; flex-wrap:wrap; }
.tt-sig-toolbar .tt-filters{ margin-bottom:0; }
.tt-sig-actions{ display:flex; gap:8px; }
.tt-author-btn,.tt-learn-btn{ padding:7px 14px; border-radius:8px; font-family:var(--fd); font-size:11px;
  letter-spacing:.5px; cursor:pointer; background:rgba(255,255,255,0.03); border:1px solid ${C.line}; color:${C.muted}; transition:all .18s; }
.tt-author-btn:hover,.tt-learn-btn:hover{ color:${C.text}; }
.tt-author-btn.on{ color:#c4b5fd; background:rgba(167,139,250,0.16); border-color:rgba(167,139,250,0.5); }
.tt-learn-btn:disabled{ opacity:.6; cursor:not-allowed; }
.tt-bad-btn{ padding:3px 9px; border-radius:6px; font-family:var(--fm); font-size:10px; cursor:pointer;
  background:transparent; border:1px solid ${C.line}; color:${C.muted}; transition:all .15s; }
.tt-bad-btn.on{ color:${C.down}; background:rgba(255,77,109,0.14); border-color:rgba(255,77,109,0.45); }
.tt-trow.bad{ opacity:.48; }

/* learn toast */
.tt-toast{ position:fixed; left:50%; bottom:92px; transform:translateX(-50%); z-index:10;
  background:rgba(11,13,20,0.95); border:1px solid rgba(45,212,191,0.4); color:${C.text};
  padding:10px 18px; border-radius:10px; font-size:12px; letter-spacing:.5px;
  box-shadow:0 16px 40px rgba(0,0,0,0.5); animation:statIn .3s ease; }

/* exit-strategy profile selector (Tight / Standard / Wide) */
.tt-profiles{ display:flex; gap:6px; margin-bottom:6px; }
.tt-profile{ flex:1; padding:9px 4px; border-radius:8px; cursor:pointer; text-align:center;
  background:rgba(255,255,255,0.03); border:1px solid ${C.line}; transition:all .15s; }
.tt-profile:hover{ background:rgba(255,255,255,0.05); }
.tt-profile-label{ font-size:12px; font-weight:600; color:${C.text}; }
.tt-profile-sub{ font-size:9px; color:${C.muted}; margin-top:3px; font-family:var(--fm); }

/* milk-zone upload button in the Strategies dropdown */
.tt-dd-upload{ display:flex; align-items:center; gap:6px; width:100%; margin-top:2px; padding:8px 10px;
  border-radius:8px; cursor:pointer; background:rgba(45,212,191,0.06); border:1px dashed rgba(45,212,191,0.35);
  color:${C.accent}; font-family:var(--fd); font-size:11px; letter-spacing:.5px; transition:all .18s; }
.tt-dd-upload:hover{ background:rgba(45,212,191,0.12); }
.tt-dd-upload.busy{ opacity:.6; cursor:wait; }
.tt-dd-upload-note{ font-size:10px; color:${C.muted}; padding:2px 10px 4px; }

/* footprint ladder panel (floats left, over the chart) */
.tt-floating .tt-fp{ pointer-events:auto; }
.tt-fp{ position:fixed; left:14px; top:88px; bottom:128px; z-index:5; width:206px; display:flex; flex-direction:column;
  background:rgba(8,10,16,0.86); border:1px solid ${C.line}; border-radius:12px; padding:10px 10px 6px;
  backdrop-filter:blur(12px); box-shadow:0 16px 40px rgba(0,0,0,0.45); }
.tt-fp-head{ display:flex; align-items:baseline; justify-content:space-between; gap:8px; padding-bottom:8px; margin-bottom:6px; border-bottom:1px solid ${C.lineSoft}; }
.tt-fp-head b{ font-size:10px; letter-spacing:2px; color:${C.text}; }
.tt-fp-head span{ font-family:var(--fm); font-size:9px; color:${C.muted}; }
.tt-fp-cols{ display:grid; grid-template-columns:1fr 1fr 1fr; font-size:8px; letter-spacing:1px; color:${C.dim}; padding:0 2px 4px; }
.tt-fp-cols span:nth-child(2){ text-align:center; }
.tt-fp-cols span:nth-child(3){ text-align:right; }
.tt-fp-rows{ flex:1; overflow-y:auto; }
.tt-fp-rows::-webkit-scrollbar{ width:5px; }
.tt-fp-rows::-webkit-scrollbar-thumb{ background:rgba(255,255,255,0.08); border-radius:5px; }
.tt-fp-row{ display:grid; grid-template-columns:1fr 1fr 1fr; align-items:center; height:16px;
  font-family:var(--fm); font-size:10px; border-radius:3px; }
.tt-fp-row.poc{ background:rgba(255,180,84,0.14); outline:1px solid rgba(255,180,84,0.3); }
.tt-fp-bid{ position:relative; text-align:left; color:${C.muted}; padding-left:3px; overflow:hidden; }
.tt-fp-ask{ position:relative; text-align:right; color:${C.muted}; padding-right:3px; overflow:hidden; }
.tt-fp-price{ text-align:center; color:${C.text}; font-variant-numeric:tabular-nums; }
.tt-fp-bid i, .tt-fp-ask i{ position:relative; z-index:1; }
.tt-fp-bar{ position:absolute; top:1px; bottom:1px; right:0; background:rgba(255,77,109,0.22); border-radius:2px; }
.tt-fp-bar.ask{ left:0; right:auto; background:rgba(31,217,138,0.22); }

/* clickable signal rows + detail modal */
.tt-trow.clickable{ cursor:pointer; }
.tt-detail-backdrop{ position:fixed; inset:0; z-index:40; background:rgba(2,3,6,0.55); backdrop-filter:blur(2px); }
.tt-detail{ position:fixed; z-index:41; left:50%; top:50%; transform:translate(-50%,-50%);
  width:min(560px,92vw); max-height:86vh; overflow-y:auto; padding:22px;
  background:rgba(11,13,20,0.97); border:1px solid ${C.line}; border-radius:16px;
  box-shadow:0 28px 70px rgba(0,0,0,0.7), 0 0 36px rgba(45,212,191,0.07);
  animation:ddIn .26s cubic-bezier(.2,.85,.25,1); }
.tt-detail-close{ position:absolute; top:12px; right:12px; width:28px; height:28px; border-radius:8px;
  background:rgba(255,255,255,0.04); border:1px solid ${C.line}; color:${C.muted}; cursor:pointer; font-size:13px; }
.tt-detail-close:hover{ color:${C.text}; }
.tt-detail-head{ display:flex; align-items:center; gap:11px; padding-bottom:14px; margin-bottom:14px; border-bottom:1px solid ${C.lineSoft}; }
.tt-detail-strat{ font-size:14px; color:${C.text}; }
.tt-detail-levels{ display:grid; grid-template-columns:repeat(4,1fr); gap:10px; margin-bottom:14px; }
.tt-detail-level{ padding:11px 12px; border:1px solid ${C.line}; border-radius:10px; background:rgba(255,255,255,0.02); }
.tt-detail-level-l{ font-size:9px; letter-spacing:1.5px; color:${C.muted}; }
.tt-detail-level-v{ font-size:17px; font-weight:600; margin-top:6px; font-variant-numeric:tabular-nums; }
.tt-detail-level-d{ font-size:10px; color:${C.muted}; margin-top:3px; }
.tt-detail-meta{ display:flex; gap:26px; flex-wrap:wrap; padding:12px 0; border-top:1px solid ${C.lineSoft}; border-bottom:1px solid ${C.lineSoft}; }
.tt-detail-meta > div{ display:flex; flex-direction:column; gap:4px; }
.tt-detail-meta span{ font-size:9px; letter-spacing:1.5px; color:${C.muted}; }
.tt-detail-meta b{ font-size:14px; color:${C.text}; }
.tt-detail-sec{ margin-top:16px; }
.tt-detail-sec-h{ font-size:9px; letter-spacing:2px; color:${C.muted}; margin-bottom:10px; }
.tt-detail-chips{ display:flex; gap:8px; flex-wrap:wrap; }
.tt-detail-chip{ font-family:var(--fm); font-size:11px; padding:5px 10px; border-radius:7px; border:1px solid ${C.line}; background:rgba(255,255,255,0.02); }
.tt-detail-kv{ display:grid; grid-template-columns:repeat(2,1fr); gap:8px 18px; }
.tt-detail-kv > div{ display:flex; align-items:baseline; justify-content:space-between; gap:10px; padding:5px 0; border-bottom:1px solid ${C.lineSoft}; }
.tt-detail-kv span{ font-size:11px; color:${C.muted}; }
.tt-detail-kv b{ font-size:12px; color:${C.text}; font-weight:500; }

/* discord-bot card */
.tt-discord{ display:flex; gap:8px; }
.tt-discord-input{ flex:1; min-width:0; background:rgba(255,255,255,0.04); border:1px solid ${C.line};
  border-radius:8px; padding:9px 11px; color:${C.text}; font-family:var(--fm); font-size:12px; outline:none; }
.tt-discord-input:focus{ border-color:rgba(45,212,191,0.4); }
.tt-discord-save{ padding:9px 16px; border-radius:8px; background:rgba(45,212,191,0.12);
  border:1px solid rgba(45,212,191,0.4); color:${C.accent}; font-family:var(--fd); font-size:12px;
  font-weight:600; letter-spacing:.5px; cursor:pointer; white-space:nowrap; transition:all .18s; }
.tt-discord-save:disabled{ opacity:.6; cursor:not-allowed; }
.tt-discord-hint{ font-size:10px; color:${C.muted}; margin-top:9px; letter-spacing:.3px; }

/* ── News ticker ─────────────────────────────────────────────────────────── */
.tt-ticker{ display:flex; align-items:center; gap:10px; height:30px; padding:0 14px;
  background:rgba(6,7,11,0.86); border-bottom:1px solid ${C.line}; backdrop-filter:blur(8px);
  position:relative; z-index:3; overflow:hidden; }
.tt-ticker-label{ flex:0 0 auto; font-size:9px; font-weight:700; letter-spacing:1.5px; color:${C.accent}; }
.tt-ticker-mask{ flex:1; overflow:hidden; position:relative; }
.tt-ticker-track{ display:inline-flex; align-items:center; white-space:nowrap;
  animation:tt-ticker-scroll 90s linear infinite; will-change:transform; }
.tt-ticker:hover .tt-ticker-track{ animation-play-state:paused; }
.tt-ticker-item{ display:inline-flex; align-items:center; gap:8px; text-decoration:none; padding:0 2px; }
.tt-ticker-src{ font-size:9px; font-weight:700; letter-spacing:.4px; color:${C.accent};
  background:rgba(45,212,191,0.12); border:1px solid rgba(45,212,191,0.28); padding:1px 6px; border-radius:4px; }
.tt-ticker-title{ font-size:12px; color:${C.text}; }
.tt-ticker-item:hover .tt-ticker-title{ color:${C.accent}; text-decoration:underline; }
.tt-ticker-sep{ color:${C.muted}; font-size:7px; margin:0 12px; }
@keyframes tt-ticker-scroll{ from{ transform:translateX(0); } to{ transform:translateX(-50%); } }

@media (max-width:760px){
  .tt-settings-grid, .tt-stat-grid{ grid-template-columns:1fr; }
  .tt-tabs{ gap:2px; }
  .tt-tab{ padding:9px 11px; font-size:11px; }
  .tt-brand-sub{ display:none; }
}
`;
