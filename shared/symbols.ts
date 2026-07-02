// Symbol normalization shared by server ingest paths.
// Uppercases and strips leading continuous-contract prefixes (@, !) so that
// "@ES", "!ES", "es" all collapse to "ES". Used to key sync/socket maps and
// to keep DB rows consistent with the rest of the app (which uppercases symbols).
export function normalizeSymbol(s: string): string {
  return (s ?? "").toUpperCase().replace(/^[@!]+/, "").trim();
}
