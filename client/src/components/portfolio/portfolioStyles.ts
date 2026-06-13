// ── Portfolio-specific CSS, layered on the MERIDIAN terminal base (terminalStyles CSS) ──
// Reuses the same fonts (Chakra Petch / IBM Plex Mono), teal accent, amber highlight,
// dark panels, corner brackets. Dark-mode only.
import { C } from "../terminal/terminalStyles";

export const PF_CSS = `
.pf-wrap{ max-width:1320px; margin:0 auto; padding:22px 26px 110px; }
.pf-head{ display:flex; align-items:center; gap:18px; margin-bottom:18px; flex-wrap:wrap; }
.pf-title{ font-size:18px; font-weight:700; letter-spacing:3px; color:${C.text}; }
.pf-title b{ color:${C.accent}; }
.pf-sub{ font-size:9px; letter-spacing:2px; color:${C.muted}; text-transform:uppercase; margin-top:3px; }
.pf-fresh{ margin-left:auto; font-family:var(--fm); font-size:10px; color:${C.dim}; letter-spacing:.5px; display:flex; align-items:center; gap:8px; }
.pf-stale{ color:${C.amber}; }
.pf-back{ font-family:var(--fd); font-size:11px; letter-spacing:1px; color:${C.muted}; background:rgba(255,255,255,0.03);
  border:1px solid ${C.line}; border-radius:8px; padding:7px 13px; cursor:pointer; text-transform:uppercase; }
.pf-back:hover{ color:${C.accent}; border-color:rgba(45,212,191,0.3); }

/* sub-view segmented control */
.pf-seg{ display:inline-flex; gap:4px; padding:4px; background:rgba(255,255,255,0.03); border:1px solid ${C.line};
  border-radius:11px; margin-bottom:20px; }
.pf-seg-btn{ display:flex; align-items:center; gap:7px; padding:9px 16px; border-radius:8px; border:none; cursor:pointer;
  background:none; color:${C.muted}; font-family:var(--fd); font-size:12px; font-weight:500; letter-spacing:1.2px;
  text-transform:uppercase; transition:all .18s; }
.pf-seg-btn:hover{ color:${C.text}; }
.pf-seg-btn.active{ color:${C.accent}; background:rgba(45,212,191,0.10); box-shadow:0 0 16px rgba(45,212,191,0.08) inset; }

/* generic panels + grids */
.pf-panel{ border:1px solid ${C.line}; border-radius:14px; background:rgba(10,12,18,0.85); backdrop-filter:blur(10px); padding:18px; }
.pf-panel-h{ display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:14px; }
.pf-panel-h b{ font-size:11px; font-weight:600; letter-spacing:2px; text-transform:uppercase; color:${C.text}; }
.pf-2col{ display:grid; grid-template-columns:1fr 1fr; gap:16px; }
.pf-row2{ display:grid; grid-template-columns:1.4fr 1fr; gap:16px; align-items:start; }
@media(max-width:900px){ .pf-2col,.pf-row2{ grid-template-columns:1fr; } }

/* score badge */
.pf-badge{ font-family:var(--fm); font-size:12px; font-weight:700; padding:3px 9px; border-radius:6px;
  border:1px solid; display:inline-flex; align-items:center; gap:5px; letter-spacing:.5px; }

/* pillar bars (transparency panel) */
.pf-pillar{ margin-bottom:11px; }
.pf-pillar-top{ display:flex; align-items:baseline; justify-content:space-between; margin-bottom:5px; }
.pf-pillar-l{ font-size:11px; letter-spacing:1px; color:${C.muted}; text-transform:uppercase; }
.pf-pillar-v{ font-family:var(--fm); font-size:12px; color:${C.text}; }
.pf-track{ height:7px; border-radius:5px; background:rgba(255,255,255,0.05); overflow:hidden; }
.pf-fill{ height:100%; border-radius:5px; background:linear-gradient(90deg, rgba(45,212,191,0.5), ${C.accent});
  box-shadow:0 0 10px rgba(45,212,191,0.3); transition:width .5s cubic-bezier(.2,.8,.2,1); }
.pf-metrics{ display:grid; grid-template-columns:1fr 1fr; gap:6px 18px; margin-top:14px; }
.pf-metric{ display:flex; align-items:baseline; justify-content:space-between; gap:10px; padding:5px 0; border-bottom:1px solid ${C.lineSoft}; }
.pf-metric span{ font-size:11px; color:${C.muted}; }
.pf-metric b{ font-family:var(--fm); font-size:12px; color:${C.text}; font-weight:500; }

/* flags */
.pf-flags{ display:flex; gap:6px; flex-wrap:wrap; }
.pf-flag{ font-family:var(--fm); font-size:9px; letter-spacing:.5px; padding:3px 7px; border-radius:5px;
  background:rgba(255,180,84,0.12); border:1px solid rgba(255,180,84,0.35); color:${C.amber}; }

/* donut (conic-gradient) */
.pf-donut{ width:170px; height:170px; border-radius:50%; position:relative; flex:0 0 auto; }
.pf-donut::after{ content:''; position:absolute; inset:26px; border-radius:50%; background:#0a0c12; }
.pf-legend{ display:flex; flex-direction:column; gap:7px; }
.pf-leg-row{ display:flex; align-items:center; gap:8px; font-size:12px; }
.pf-leg-dot{ width:9px; height:9px; border-radius:2px; flex:0 0 auto; }
.pf-leg-w{ font-family:var(--fm); color:${C.muted}; margin-left:auto; }

/* core / satellite bar */
.pf-cs-bar{ height:30px; border-radius:8px; overflow:hidden; display:flex; border:1px solid ${C.line}; }
.pf-cs-core{ background:linear-gradient(90deg, rgba(45,212,191,0.35), rgba(45,212,191,0.6)); display:flex; align-items:center; padding:0 10px;
  font-family:var(--fm); font-size:11px; color:#04201c; font-weight:700; }
.pf-cs-sat{ background:rgba(255,255,255,0.05); display:flex; align-items:center; justify-content:flex-end; padding:0 10px;
  font-family:var(--fm); font-size:11px; color:${C.text}; }
.pf-cs-bar.over .pf-cs-sat{ background:rgba(255,180,84,0.22); color:${C.amber}; }
.pf-cs-note{ display:flex; align-items:center; gap:7px; font-size:11px; margin-top:9px; color:${C.muted}; }
.pf-cs-warn{ color:${C.amber}; }

/* fund cards */
.pf-funds{ display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:14px; }
.pf-fund{ border:1px solid ${C.line}; border-radius:13px; background:rgba(10,12,18,0.85); padding:15px; cursor:pointer; transition:all .18s; }
.pf-fund:hover{ border-color:rgba(45,212,191,0.3); transform:translateY(-2px); box-shadow:0 10px 30px rgba(0,0,0,0.4); }
.pf-fund-mgr{ font-size:14px; font-weight:600; color:${C.text}; }
.pf-fund-name{ font-size:10px; letter-spacing:1px; color:${C.muted}; text-transform:uppercase; margin-top:2px; }
.pf-fund-val{ font-family:var(--fm); font-size:12px; color:${C.accent}; margin-top:8px; }
.pf-fund-hold{ display:flex; align-items:center; justify-content:space-between; padding:4px 0; font-size:12px; border-bottom:1px solid ${C.lineSoft}; }
.pf-fund-moves{ display:flex; gap:8px; margin-top:9px; font-family:var(--fm); font-size:10px; }
.pf-move-buy{ color:${C.accent}; }
.pf-move-exit{ color:${C.amber}; }

/* congress feed */
.pf-feed-row{ display:grid; grid-template-columns:1.4fr .6fr .5fr .9fr .9fr 40px; align-items:center; gap:10px;
  padding:11px 14px; border-bottom:1px solid ${C.lineSoft}; font-size:13px; }
.pf-pol{ display:flex; align-items:center; gap:8px; }
.pf-pol-dot{ width:8px; height:8px; border-radius:50%; flex:0 0 auto; }
.pf-side-buy{ color:${C.up}; font-weight:600; }
.pf-side-sell{ color:${C.down}; font-weight:600; }
.pf-star{ background:none; border:none; cursor:pointer; color:${C.dim}; font-size:15px; }
.pf-star.on{ color:${C.amber}; }
.pf-lag{ color:${C.amber}; }

/* banner */
.pf-banner{ display:flex; align-items:center; gap:12px; padding:11px 15px; border-radius:11px; margin-bottom:16px;
  background:rgba(255,180,84,0.08); border:1px solid rgba(255,180,84,0.28); color:${C.amber}; font-size:12px; }
.pf-banner button{ margin-left:auto; background:none; border:1px solid rgba(255,180,84,0.4); color:${C.amber};
  border-radius:7px; padding:5px 11px; cursor:pointer; font-size:11px; font-family:var(--fd); }

/* footer disclaimer */
.pf-footer{ position:fixed; left:0; right:0; bottom:0; z-index:5; padding:9px 26px; text-align:center;
  font-family:var(--fm); font-size:10px; letter-spacing:.5px; color:${C.dim};
  background:rgba(6,7,11,0.9); border-top:1px solid ${C.line}; backdrop-filter:blur(8px); }

/* modal (add/edit holding) */
.pf-modal-back{ position:fixed; inset:0; z-index:40; background:rgba(2,3,6,0.6); backdrop-filter:blur(2px); display:flex; align-items:center; justify-content:center; }
.pf-modal{ width:min(440px,92vw); padding:22px; background:rgba(11,13,20,0.97); border:1px solid ${C.line}; border-radius:16px;
  box-shadow:0 28px 70px rgba(0,0,0,0.7); }
.pf-field{ display:flex; flex-direction:column; gap:6px; margin-bottom:13px; }
.pf-field label{ font-size:10px; letter-spacing:1.2px; color:${C.muted}; text-transform:uppercase; }
.pf-input{ background:rgba(255,255,255,0.04); border:1px solid ${C.line}; border-radius:8px; padding:9px 11px;
  color:${C.text}; font-family:var(--fm); font-size:13px; outline:none; }
.pf-input:focus{ border-color:rgba(45,212,191,0.4); }
.pf-btn{ padding:9px 16px; border-radius:8px; font-family:var(--fd); font-size:12px; font-weight:600; letter-spacing:.5px; cursor:pointer; }
.pf-btn.primary{ background:rgba(45,212,191,0.14); border:1px solid rgba(45,212,191,0.4); color:${C.accent}; }
.pf-btn.ghost{ background:rgba(255,255,255,0.03); border:1px solid ${C.line}; color:${C.muted}; }

/* drawer (screener detail) */
.pf-drawer-back{ position:fixed; inset:0; z-index:40; background:rgba(2,3,6,0.55); }
.pf-drawer{ position:fixed; top:0; right:0; bottom:0; z-index:41; width:min(460px,94vw); overflow-y:auto; padding:24px;
  background:rgba(11,13,20,0.98); border-left:1px solid ${C.line}; box-shadow:-20px 0 60px rgba(0,0,0,0.6);
  animation:pfDrawerIn .28s cubic-bezier(.2,.85,.25,1); }
@keyframes pfDrawerIn{ from{ transform:translateX(40px); opacity:0; } to{ transform:none; opacity:1; } }

.pf-empty{ padding:40px; text-align:center; color:${C.muted}; font-size:13px; letter-spacing:1px; }
.pf-keyhint{ padding:14px 16px; border:1px dashed rgba(255,180,84,0.4); border-radius:11px; color:${C.amber}; font-size:12px; background:rgba(255,180,84,0.06); }
.pf-tbl-num{ font-family:var(--fm); text-align:right; font-variant-numeric:tabular-nums; }
`;
