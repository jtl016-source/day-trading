/**
 * discord-parser.ts — natural language signal parser for Discord messages.
 * Converts free-text trading commentary into structured ParsedSignal objects.
 */

export interface ParsedSignal {
  raw:         string;
  author:      string;
  channel:     string;
  timestamp:   number;
  symbol:      string;
  direction:   "Long" | "Short";
  entryPrice:  number | null;
  tp1:         number | null;
  tp2:         number | null;
  tp3:         number | null;
  sl:          number | null;
  confidence:  "high" | "medium";
  historical:  boolean;
  rawContext:  string[];
}

// ── Context ring-buffer (last 3 messages per channel) ─────────────────────
const _ctx = new Map<string, string[]>();

export function updateContext(channel: string, text: string) {
  const q = _ctx.get(channel) ?? [];
  q.push(text);
  if (q.length > 3) q.shift();
  _ctx.set(channel, q);
}

function getContext(channel: string): string[] {
  return [...(_ctx.get(channel) ?? [])];
}

// ── Recent-signal dedup cache ─────────────────────────────────────────────
interface RecentSig { author: string; symbol: string; direction: string; entry: number | null; ts: number }
const _recent: RecentSig[] = [];

const TICK: Record<string, number> = {
  MES: 0.25, ES: 0.25, MNQ: 0.25, NQ: 0.25,
  MYM: 1,    YM: 1,    M2K: 0.1,  RTY: 0.1,
  CL: 0.01,  GC: 0.10, SI: 0.005, NG: 0.001,
  SPY: 0.01, QQQ: 0.01, IWM: 0.01, DIA: 0.01,
};

function isDuplicate(sig: ParsedSignal): boolean {
  const cutoff = sig.timestamp - 600; // 10 minutes
  // prune old
  while (_recent.length && _recent[0].ts < cutoff) _recent.shift();
  const tick5 = (TICK[sig.symbol] ?? 0.25) * 5;
  return _recent.some(r =>
    r.author    === sig.author    &&
    r.symbol    === sig.symbol    &&
    r.direction === sig.direction &&
    (sig.entryPrice === null || r.entry === null ||
     Math.abs((sig.entryPrice) - (r.entry)) <= tick5)
  );
}

function registerRecent(sig: ParsedSignal) {
  _recent.push({ author: sig.author, symbol: sig.symbol, direction: sig.direction, entry: sig.entryPrice, ts: sig.timestamp });
}

// ── Known symbols ─────────────────────────────────────────────────────────
const KNOWN = ["MES","ES","MNQ","NQ","MYM","YM","M2K","RTY","CL","GC","SI","NG",
               "SPY","QQQ","IWM","DIA","AAPL","TSLA","NVDA","AMZN","MSFT","META"];

// ── Direction keywords ─────────────────────────────────────────────────────
const LONG_KW  = ["long","buy","bull","calls","upside","going up","looking long","long here",
                  "getting long","add long","long bias","bid it","buying","entry long"];
const SHORT_KW = ["short","sell","bear","puts","downside","going down","looking short","short here",
                  "getting short","add short","short bias","offer it","selling","entry short"];

// ── Filters ───────────────────────────────────────────────────────────────
const PAST_TERMS  = ["was filled","stopped out","hit tp","closed","exit","out of","got stopped","took profit"];
const VAGUE_TERMS = ["maybe","might","could","not sure","watching","waiting","not yet","unsure","idk","tbh"];

// ── Price extraction ──────────────────────────────────────────────────────
const P = `\\d{2,6}(?:\\.\\d{1,2})?`; // price number regex fragment

function g1(re: RegExp, text: string): number | null {
  const m = re.exec(text);
  return m?.[1] ? parseFloat(m[1]) : null;
}

function extractPrices(text: string): {
  entryPrice: number | null; tp1: number | null; tp2: number | null; tp3: number | null; sl: number | null;
} {
  const t = text.replace(/,\s*/g, " ");

  // Entry: keyword-before-number  OR  number-after-direction-word
  const entryPrice =
    g1(new RegExp(`(?:@|at|around|near|entry|enter|from)\\s*:?\\s*(${P})`, "i"), t) ??
    g1(new RegExp(`(?:long|short)\\s+(${P})`, "i"), t) ??
    g1(new RegExp(`(?:if|when)\\s+(?:we\\s+)?(?:get|reach|touch|hit)\\s+(?:to\\s+)?(${P})`, "i"), t);

  // TP — handle up to 3 consecutive numbers after the keyword
  const tpFwd = new RegExp(
    `\\b(?:target|tp[123]?|t[123]|pt[123]?|profit)\\s*:?\\s*(${P})(?:\\s+(${P}))?(?:\\s+(${P}))?`, "i"
  ).exec(t);
  const tpRev = new RegExp(`(${P})\\s+(?:target|tp)\\b`, "i").exec(t);
  const tp1   = tpFwd ? parseFloat(tpFwd[1]) : (tpRev ? parseFloat(tpRev[1]) : null);
  const tp2   = tpFwd?.[2] ? parseFloat(tpFwd[2]) : null;
  const tp3   = tpFwd?.[3] ? parseFloat(tpFwd[3]) : null;

  // SL — various patterns including "stop below/above N", "risk to N", "invalidate at N"
  const sl =
    g1(new RegExp(`\\b(?:sl|stop\\s*(?:loss)?)\\s*:?\\s*(${P})`, "i"), t) ??
    g1(new RegExp(`\\b(?:stop|sl)\\s+(?:below|above|under|over|at|around)?\\s*(${P})`, "i"), t) ??
    g1(new RegExp(`(?:below|under)\\s+(${P})`, "i"), t) ??
    g1(new RegExp(`risk\\s+(?:to\\s+|at\\s+)?(${P})`, "i"), t) ??
    g1(new RegExp(`invalidat\\w*\\s+(?:at|above|below|over|under)?\\s*(${P})`, "i"), t);

  return { entryPrice, tp1, tp2, tp3, sl };
}

// ── Main export ───────────────────────────────────────────────────────────

export function parseDiscordMessage(msg: {
  text:       string;
  author:     string;
  channel:    string;
  timestamp:  number;
  historical: boolean;
}): ParsedSignal | null {

  const text  = msg.text.trim();
  const lower = text.toLowerCase();

  // ── Hard filters ──────────────────────────────────────────────────────
  if (text.endsWith("?"))                                       return null; // question
  if (text.split(/\s+/).length < 8)                            return null; // too short
  if (PAST_TERMS.some(t => lower.includes(t)))                 return null; // past trade discussion
  if (VAGUE_TERMS.some(t => lower.includes(t)))                return null; // vague/speculative
  if (/^(bot|webhook)/i.test(msg.author))                      return null; // bots
  if (msg.author.endsWith("#0000"))                            return null; // bot legacy tag

  // ── Direction ─────────────────────────────────────────────────────────
  const isLong  = LONG_KW.some(k  => lower.includes(k));
  const isShort = SHORT_KW.some(k => lower.includes(k));
  if (!isLong && !isShort) return null;
  if (isLong  && isShort)  return null; // ambiguous — skip
  const direction: "Long" | "Short" = isLong ? "Long" : "Short";

  // ── Symbol ────────────────────────────────────────────────────────────
  let symbol: string | null = null;
  for (const sym of KNOWN) {
    if (new RegExp(`\\b${sym}\\b`, "i").test(text)) { symbol = sym; break; }
  }
  // Fallback: any 2-5 char ALL-CAPS word
  if (!symbol) {
    const m = text.match(/\b([A-Z]{2,5})\b/);
    if (m) symbol = m[1];
  }
  // Fallback: infer from channel name
  if (!symbol) {
    const ch = msg.channel.toLowerCase().replace(/[-_#]/g, " ");
    for (const sym of KNOWN) {
      if (ch.includes(sym.toLowerCase())) { symbol = sym; break; }
    }
  }
  if (!symbol) return null;

  // ── Prices ────────────────────────────────────────────────────────────
  const { entryPrice, tp1, tp2, tp3, sl } = extractPrices(text);

  // ── Confidence ────────────────────────────────────────────────────────
  const hasEntry  = entryPrice !== null;
  const hasTarget = tp1 !== null;
  const hasSL     = sl !== null;

  let confidence: "high" | "medium" | "low";
  if (hasEntry && (hasTarget || hasSL)) confidence = "high";
  else if (hasTarget || hasSL)          confidence = "medium";
  else                                  confidence = "low";

  if (confidence === "low") return null;

  // ── Build signal ──────────────────────────────────────────────────────
  const sig: ParsedSignal = {
    raw:        text,
    author:     msg.author,
    channel:    msg.channel,
    timestamp:  msg.timestamp,
    symbol,
    direction,
    entryPrice,
    tp1,
    tp2,
    tp3,
    sl,
    confidence,
    historical: msg.historical,
    rawContext: getContext(msg.channel),
  };

  // ── Dedup ─────────────────────────────────────────────────────────────
  if (isDuplicate(sig)) return null;
  registerRecent(sig);

  return sig;
}
