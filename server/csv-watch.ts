/**
 * CSV fallback ingest (feature-off unless MW_EXPORT_DIR is set).
 *
 * Watches a directory of MotiveWave "Data Export" CSV files named
 * `<SYMBOL>_<RES>.csv` (RES ∈ {1,5,15,60} or {1min,5min,15min,60min}) and
 * upserts their bars into cached_candles — the same validated + roll-healed
 * path the WebSocket bulk_bars ingest uses. This exists so history can be
 * seeded even on machines where the study's forEachBar backfill is unavailable.
 *
 * Timestamp assumption (to be confirmed by the user's P5 dry run): a plain
 * "yyyy-MM-dd HH:mm" column is interpreted as UTC. Epoch seconds and epoch
 * milliseconds are auto-detected by magnitude.
 */
import fs from "fs";
import path from "path";
import { normalizeSymbol } from "@shared/symbols";
import { persistBulk } from "./live-bars";
import { detectAndHeal } from "./roll-heal";

type Bar = { t: number; o: number; h: number; l: number; c: number; v: number };

const RES_ALIASES: Record<string, string> = {
  "1": "1", "1min": "1", "5": "5", "5min": "5",
  "15": "15", "15min": "15", "60": "60", "60min": "60",
};

function parseTimestamp(raw: string): number | null {
  const s = raw.trim();
  if (/^\d+$/.test(s)) {
    const n = parseInt(s, 10);
    if (n > 1e12) return Math.floor(n / 1000); // epoch ms
    if (n > 1e9) return n;                      // epoch seconds
    return null;
  }
  // "yyyy-MM-dd HH:mm[:ss]" — interpreted as UTC
  const iso = s.replace(" ", "T");
  const ms = Date.parse(iso.endsWith("Z") ? iso : iso + "Z");
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/** Locate column indices from a header line; falls back to t,o,h,l,c,v order. */
function resolveColumns(header: string[]): { ti: number; oi: number; hi: number; li: number; ci: number; vi: number } {
  const h = header.map(x => x.trim().toLowerCase());
  const idx = (names: string[], dflt: number) => {
    for (const n of names) {
      const i = h.indexOf(n);
      if (i >= 0) return i;
    }
    return dflt;
  };
  return {
    ti: idx(["time", "timestamp", "date", "datetime"], 0),
    oi: idx(["open", "o"], 1),
    hi: idx(["high", "h"], 2),
    li: idx(["low", "l"], 3),
    ci: idx(["close", "c"], 4),
    vi: idx(["volume", "vol", "v"], 5),
  };
}

function parseFile(fullPath: string): { symbol: string; resolution: string; bars: Bar[] } | null {
  const base = path.basename(fullPath).replace(/\.csv$/i, "");
  const us = base.lastIndexOf("_");
  if (us < 0) return null;
  const symbol = normalizeSymbol(base.slice(0, us));
  const resToken = base.slice(us + 1).toLowerCase();
  const resolution = RES_ALIASES[resToken];
  if (!symbol || !resolution) return null;

  let text: string;
  try { text = fs.readFileSync(fullPath, "utf8"); } catch { return null; }
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length < 2) return null;

  const headerCells = lines[0].split(",");
  const hasHeader = /[a-zA-Z]/.test(headerCells[0]) && !/^\d/.test(headerCells[0].trim());
  const cols = resolveColumns(hasHeader ? headerCells : ["time", "open", "high", "low", "close", "volume"]);

  const intervalSec = parseInt(resolution, 10) * 60;
  const bars: Bar[] = [];
  for (let i = hasHeader ? 1 : 0; i < lines.length; i++) {
    const f = lines[i].split(",");
    const t = parseTimestamp(f[cols.ti] ?? "");
    const o = parseFloat(f[cols.oi]); const h = parseFloat(f[cols.hi]);
    const l = parseFloat(f[cols.li]); const c = parseFloat(f[cols.ci]);
    const v = parseInt(f[cols.vi] ?? "0", 10) || 0;
    if (t === null) continue;
    if (![o, h, l, c].every(Number.isFinite)) continue;
    if (h < l || o <= 0 || c <= 0) continue;
    if (t % intervalSec !== 0) continue; // must be interval-aligned
    bars.push({ t, o, h, l, c, v });
  }
  return bars.length ? { symbol, resolution, bars } : null;
}

async function ingest(fullPath: string) {
  const parsed = parseFile(fullPath);
  if (!parsed) return;
  const { symbol, resolution, bars } = parsed;
  try {
    await detectAndHeal(symbol, resolution, bars).catch(() => null);
    await persistBulk(symbol, resolution, bars);
    console.log(`[csv-watch] ingested ${bars.length} bars from ${path.basename(fullPath)} (${symbol} res=${resolution})`);
  } catch (e: any) {
    console.error(`[csv-watch] ingest failed for ${fullPath}:`, e?.message ?? e);
  }
}

export function setupCsvWatch() {
  const dir = process.env.MW_EXPORT_DIR;
  if (!dir) return; // feature off
  if (!fs.existsSync(dir)) {
    console.warn(`[csv-watch] MW_EXPORT_DIR does not exist: ${dir}`);
    return;
  }
  console.log(`[csv-watch] watching ${dir} for *_<res>.csv exports`);

  const debounce = new Map<string, NodeJS.Timeout>();
  const schedule = (file: string) => {
    if (!file.toLowerCase().endsWith(".csv")) return;
    const full = path.join(dir, file);
    const prev = debounce.get(full);
    if (prev) clearTimeout(prev);
    debounce.set(full, setTimeout(() => { debounce.delete(full); void ingest(full); }, 2000));
  };

  // Ingest any files already present at startup.
  try { for (const f of fs.readdirSync(dir)) schedule(f); } catch {}

  try {
    fs.watch(dir, (_event, filename) => { if (filename) schedule(filename.toString()); });
  } catch (e: any) {
    console.error(`[csv-watch] fs.watch failed:`, e?.message ?? e);
  }
}
