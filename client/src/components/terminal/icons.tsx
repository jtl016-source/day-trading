// icons.tsx — inline HUD icons (preserved verbatim from the design source of truth).
import React from "react";

type IcoProps = React.SVGProps<SVGSVGElement>;

export const Ico = {
  chevron: (p?: IcoProps) => (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M6 9l6 6 6-6" /></svg>
  ),
  reload: (p?: IcoProps) => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" /></svg>
  ),
  bars: (p?: IcoProps) => (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" {...p}><path d="M4 14v5M9.3 8v11M14.6 11v8M20 5v14" /></svg>
  ),
  signal: (p?: IcoProps) => (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M3 12h3.5l2.2-6 4 13 2.3-7H21" /></svg>
  ),
  sliders: (p?: IcoProps) => (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" {...p}><path d="M4 6h16M4 12h16M4 18h16" /><circle cx="9" cy="6" r="2.1" fill="#06070b" /><circle cx="15.5" cy="12" r="2.1" fill="#06070b" /><circle cx="7" cy="18" r="2.1" fill="#06070b" /></svg>
  ),
  info: (p?: IcoProps) => (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><circle cx="12" cy="12" r="9" /><path d="M12 11v5" /><path d="M12 7.5h.01" /></svg>
  ),
  // LEDGER (2026-08-02): ruled account book — the forward-validation Ledger tab.
  ledger: (p?: IcoProps) => (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M5 4h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5z" /><path d="M5 4v16" /><path d="M9 9h6M9 12.5h6M9 16h4" /></svg>
  ),
  // JOURNAL (2026-08-07): open notebook — the daily trading-journal tab.
  journal: (p?: IcoProps) => (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M12 5c-1.6-1.2-3.6-1.8-6-1.8V19c2.4 0 4.4.6 6 1.8 1.6-1.2 3.6-1.8 6-1.8V3.2c-2.4 0-4.4.6-6 1.8z" /><path d="M12 5v15.8" /></svg>
  ),
};
