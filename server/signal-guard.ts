// server/signal-guard.ts
// ─────────────────────────────────────────────────────────────────────────────
// SERVER-SIDE SIGNAL-RULE ENFORCEMENT (C1/C2 — the backstop). The actual rule set lives in
// shared/signal-rules.ts (single source, also imported by the client consumers); this module
// is the server's entry point so routes.ts has one obvious guard to apply at:
//   • POST /api/signals/history   — reject invalid rows at write time (skip + count)
//   • GET  /api/signals/history   — filter rows at read time (covers every consumer:
//     terminal chart, Signals tab, date-browse, iPhone)
//   • POST /api/data/import-full  — reject invalid imported rows (skip + count)
// ─────────────────────────────────────────────────────────────────────────────
export {
  validateSignalRow,
  isSessionLegalSignal,
  isWeekendClosed,
  VALID_SIGNAL_TYPES,
  SIGNAL_INTERVAL_SEC,
  type SignalRowLike,
} from "@shared/signal-rules";
