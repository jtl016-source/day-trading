// Symbol normalization shared by server ingest paths.
// Uppercases and strips leading continuous-contract prefixes (@, !) so that
// "@ES", "!ES", "es" all collapse to "ES". Used to key sync/socket maps and
// to keep DB rows consistent with the rest of the app (which uppercases symbols).
//
// It ALSO folds a specific futures CONTRACT code down to its continuous ROOT so
// MW-ingested history (which arrives keyed by contract, e.g. getSymbol()="MESU6")
// lands in the same bucket the web client queries by root:
//   "MESU6" -> "MES"   "ESM6" -> "ES"   "MNQZ5" -> "MNQ"
// Root alternation MUST list longer roots before their prefixes (MES before ES,
// MNQ before NQ, MYM before YM, MCL before CL, MGC before GC, SIL before SI) so
// a contract like "MESU6" matches root "MES", not "ES" + leftover.
const CONTRACT_RE =
  /^(MES|ES|MNQ|NQ|MYM|YM|M2K|RTY|MCL|CL|MGC|GC|SIL|SI|NG|ZB|ZN)([FGHJKMNQUVXZ])(\d{1,2})$/;

export function normalizeSymbol(s: string): string {
  const base = (s ?? "").toUpperCase().replace(/^[@!]+/, "").trim();
  const m = CONTRACT_RE.exec(base);
  return m ? m[1] : base;
}
