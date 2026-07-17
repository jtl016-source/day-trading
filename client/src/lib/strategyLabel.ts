// strategyLabel — turns a signal's confirmations into the SPECIFIC strategy name(s) used,
// never the generic "confluence". Used for the Signals display, the chart marker detail, and
// the alerts/notifications (which now name the strategies instead of the risk tier).
//
// confirmations / footprint may be a raw JSON string (DB rows) or an already-parsed object
// (the live engine). Returns e.g. "Milk Zone + Vector + Footprint", "Vector Side-Entry",
// "Zone-to-Zone Pattern", "Daily Vector".

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
  // Named strategies that aren't a multi-factor confluence bundle.
  if (st === "optimized")         return "ICT Zone + Body"; // THE program strategy (optimized 2026-07)
  if (st === "vector-side-entry") return "Vector Side-Entry";
  if (st === "zone-pattern")      return "Zone-to-Zone Pattern";
  if (st === "mean-reversion")    return "Mean-Reversion";
  if (st === "manual")            return "Manual";
  if (st === "daily-vector")      return "Daily Vector";

  // Confluence / unlabeled → name the actual factors that fired.
  const conf = asObj(confirmations);
  const fp   = asObj(footprint);
  const names: string[] = [];
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
  return names.length ? names.join(" + ") : "Vector";
}
