// controls.tsx — reusable MERIDIAN UI controls (preserved verbatim, typed).
import React from "react";
import { C, TIER } from "./terminalStyles";

export function Toggle({ on, onClick, disabled }: { on: boolean; onClick: () => void; disabled?: boolean }) {
  return (
    <button onClick={disabled ? undefined : onClick} className="tt-toggle" disabled={disabled} aria-pressed={on}
      style={{ background: on ? C.accent : "rgba(255,255,255,0.12)", opacity: disabled ? 0.4 : 1, cursor: disabled ? "not-allowed" : "pointer" }}>
      <span className="tt-knob" style={{ transform: on ? "translateX(18px)" : "translateX(0)" }} />
    </button>
  );
}

export function Seg<T extends string>({ options, value, onChange }: { options: readonly T[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="tt-seg">
      {options.map((o) => (
        <button key={o} onClick={() => onChange(o)} className="tt-seg-btn"
          style={{ color: value === o ? C.bg : C.muted, background: value === o ? C.accent : "transparent", fontWeight: value === o ? 600 : 500 }}>
          {o}
        </button>
      ))}
    </div>
  );
}

export function Slider({ value, min, max, step, onChange, fmt }: {
  value: number; min: number; max: number; step: number; onChange: (v: number) => void; fmt?: (v: number) => string;
}) {
  return (
    <div className="tt-slider-row">
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))} className="tt-range" style={{ accentColor: C.accent }} />
      <span className="tt-slider-val">{fmt ? fmt(value) : value}</span>
    </div>
  );
}

export function Stepper({ value, onChange, step, min, max, fmt }: {
  value: number; onChange: (v: number) => void; step: number; min: number; max: number; fmt?: (v: number) => string;
}) {
  const dec = () => onChange(Math.max(min, +(value - step).toFixed(2)));
  const inc = () => onChange(Math.min(max, +(value + step).toFixed(2)));
  return (
    <div className="tt-stepper">
      <button onClick={dec} className="tt-step-btn">–</button>
      <span className="tt-step-val">{fmt ? fmt(value) : value}</span>
      <button onClick={inc} className="tt-step-btn">+</button>
    </div>
  );
}

export function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="tt-row">
      <div className="tt-row-label">
        <span>{label}</span>
        {hint && <span className="tt-hint">{hint}</span>}
      </div>
      <div className="tt-row-ctrl">{children}</div>
    </div>
  );
}

export function Card({ icon, title, children, span }: { icon: React.ReactNode; title: string; children: React.ReactNode; span?: boolean }) {
  return (
    <section className="tt-card" style={span ? { gridColumn: "1 / -1" } : undefined}>
      <span className="tt-corner tl" /><span className="tt-corner tr" />
      <span className="tt-corner bl" /><span className="tt-corner br" />
      <div className="tt-card-head"><span className="tt-card-ico">{icon}</span><h3>{title}</h3></div>
      <div className="tt-card-body">{children}</div>
    </section>
  );
}

export function TierPill({ tier }: { tier: string }) {
  const t = TIER[tier] ?? TIER.SAFE;
  return <span className="tt-tier" style={{ color: t.c, background: t.bg, borderColor: t.bd }}>{tier}</span>;
}

export function Brand({ onClick }: { onClick: () => void }) {
  return (
    <button className="tt-brand" onClick={onClick}>
      <svg width="30" height="30" viewBox="0 0 32 32" fill="none">
        <rect x="2.5" y="2.5" width="27" height="27" rx="8" stroke={C.accent} strokeWidth="1.5" opacity="0.5" />
        <path d="M9 20 L13 12 L18 18 L23 9" stroke={C.accent} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="23" cy="9" r="2.4" fill={C.accent} />
      </svg>
      <div className="tt-brand-txt">
        <span className="tt-brand-name">BAXTER</span>
        <span className="tt-brand-sub">trading platform</span>
      </div>
    </button>
  );
}
