/**
 * Canonical symbol normalization used by BOTH server and client.
 * Futures:  MESM6 -> MES, MESM6.CME -> MES, MES=F -> MES
 * Stocks/ETFs/indices are upper-cased and returned unchanged (AAPL, SPY, ^VIX).
 *
 * This MUST be the single source of truth for symbol identity everywhere — the bug
 * it fixes is that each layer used its own ad-hoc .replace(...) and a 2-char prefix
 * match, which let one instrument's data leak onto another's chart.
 */
export function normalizeSymbol(raw: string | undefined | null): string {
  if (!raw) return "";
  let s = raw.toUpperCase().trim();
  s = s.replace(/\.[A-Z]+$/, "");                 // strip exchange suffix: .CME, .CBOT, ...
  s = s.replace(/=F$/, "");                        // strip Yahoo futures suffix: MES=F -> MES
  s = s.replace(/[FGHJKMNQUVXZ]\d{1,2}$/, "");     // strip futures month-code + year: MESM6 -> MES
  return s;
}
