// strategyLabel — turns a signal's confirmations into the SPECIFIC strategy name(s) used,
// never the generic "confluence" and never an internal identifier (user rule 2026-07-14: no
// jargon like "fact-engine" anywhere he reads). Display names come from the single shared map
// in shared/signal-display.ts — the same one the backtest workbook uses.
//
// confirmations / footprint may be a raw JSON string (DB rows) or an already-parsed object
// (the live engine). Returns e.g. "Milk Zone + Vector + Footprint", "Vector Side-Entry",
// "Zone-to-Zone Pattern", "Daily Vector".

import { displaySignalType, displayStrategy } from "@shared/signal-display";

function asObj(x: unknown): Record<string, any> | null {
  if (!x) return null;
  if (typeof x === "object") return x as Record<string, any>;
  if (typeof x === "string") { try { const o = JSON.parse(x); return o && typeof o === "object" ? o : null; } catch { return null; } }
  return null;
}

export function strategyLabel(
  signalType?: string | null,
  confirmations?: string | Record<string, any> | null,
  footprint?: string | Record<string, any> | null,
): string {
  const st = (signalType ?? "").toLowerCase();
  // Named strategies that aren't a multi-factor confluence bundle — shared display map first.
  if (st === "vector-side-entry" || st === "zone-reaction" || st === "yellowbox-break") return displaySignalType(st);
  if (st === "zone-pattern")      return "Zone-to-Zone Pattern";
  if (st === "mean-reversion")    return "Mean-Reversion";
  if (st === "manual")            return "Manual";
  if (st === "daily-vector")      return "Daily Vector";

  // Confluence ("fact-engine") / unlabeled → name the actual strategies that agreed.
  const conf = asObj(confirmations);
  const fp   = asObj(footprint);
  const names: string[] = [];
  if (conf && Array.isArray(conf.facts)) {
    // Fact-engine format: {facts:[{s,d,k,lvl}],anchor,session} — unique strategy keys, in order.
    for (const f of conf.facts) {
      if (!f || typeof f.s !== "string") continue;
      const name = displayStrategy(f.s);
      if (!names.includes(name)) names.push(name);
    }
  }
  if (conf) {
    if (conf.milkOk || (conf.milkPts ?? 0) > 0) names.push("Milk Zone");
    if (conf.vecOk)                              names.push("Vector");
    if (conf.secondaryVecOk)                     names.push("Secondary Vector");
  }
  if (fp) {
    if (fp.confirmed)    names.push("Footprint");
    else if (fp.partial) names.push("Footprint (partial)");
  }
  if (conf?.mom === "up" || conf?.mom === "down") names.push("Momentum");
  if (names.length) return names.join(" + ");
  // A confluence signal with unparseable confirmations still gets the shared display name.
  return st === "fact-engine" ? displaySignalType(st) : "Vector";
}
