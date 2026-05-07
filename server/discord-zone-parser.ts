/**
 * discord-zone-parser.ts — extracts Milk zone levels from Discord message text.
 * Looks for zone-type keywords paired with a nearby price range.
 * Examples: "IV WALL 7150-7175", "BUYER POSITIONING at 7100/7120"
 */

export interface DiscordZone {
  messageId:   string;
  channelName: string;
  authorName:  string;
  postedAt:    number;
  zoneType:    string;
  labelRaw:    string;
  top:         number;
  bottom:      number;
  isBull:      boolean;
  symbol:      string;
  raw:         string;
}

// Sorted longest-first to avoid partial matches
const ZONE_PATTERNS: Array<{ text: string; type: string; isBull: boolean }> = [
  { text: "BUYERS WILL ABSORB SELLERS ON TEST", type: "buyer_absorb",              isBull: true  },
  { text: "BUYERS WILL VALUE ADD ON TEST",      type: "buyer_value_add",           isBull: true  },
  { text: "BUYERS WILL ABSORB",                 type: "buyer_absorb",              isBull: true  },
  { text: "BUYERS WILL VALUE ADD",              type: "buyer_value_add",           isBull: true  },
  { text: "BUYERS ULTIMATE TARGET",             type: "buyer_ultimate_target",     isBull: true  },
  { text: "SELLERS ULTIMATE TARGET",            type: "seller_ultimate_target",    isBull: false },
  { text: "SELLERS WILL ABSORB",                type: "seller_absorb",             isBull: false },
  { text: "SELLERS SOFT TARGET",                type: "seller_soft_target",        isBull: false },
  { text: "STRONG BUYER POSITIONING",           type: "buyer_positioning_strong",  isBull: true  },
  { text: "STRONG SELLER POSITIONING",          type: "seller_positioning_strong", isBull: false },
  { text: "LTF BUYER POSITIONING",              type: "buyer_positioning_ltf",     isBull: true  },
  { text: "LTF SELLER POSITIONING",             type: "seller_positioning_ltf",    isBull: false },
  { text: "LTF BUYER OBJECTIVE",                type: "buyer_objective_ltf",       isBull: true  },
  { text: "LTF SELLER OBJECTIVE",               type: "seller_objective_ltf",      isBull: false },
  { text: "LTF BUYERS OBJECTIVE",               type: "buyer_objective_ltf",       isBull: true  },
  { text: "LTF SELLERS OBJECTIVE",              type: "seller_objective_ltf",      isBull: false },
  { text: "BUYER POSITIONING",                  type: "buyer_positioning",         isBull: true  },
  { text: "SELLER POSITIONING",                 type: "seller_positioning",        isBull: false },
  { text: "BUYERS OBJECTIVE",                   type: "buyer_objective",           isBull: true  },
  { text: "SELLERS OBJECTIVE",                  type: "seller_objective",          isBull: false },
  { text: "BUYER OBJECTIVE",                    type: "buyer_objective",           isBull: true  },
  { text: "SELLER OBJECTIVE",                   type: "seller_objective",          isBull: false },
  { text: "POTENTIAL TO CAP SESSION",           type: "session_cap",               isBull: false },
  { text: "NON FAIR VALUE",                     type: "non_fair_value",            isBull: false },
  { text: "MACRO PIVOT",                        type: "pivot_macro",               isBull: false },
  { text: "SECONDARY PIVOT",                    type: "pivot_secondary",           isBull: false },
  { text: "REVERSION SETUP",                    type: "reversion",                 isBull: false },
  { text: "OVN SPY CEILING",                    type: "ovn_spy_ceiling",           isBull: false },
  { text: "OVN SPY FLOOR",                      type: "ovn_spy_floor",             isBull: true  },
  { text: "SPY CEILING",                        type: "spy_ceiling",               isBull: false },
  { text: "SPY FLOOR",                          type: "spy_floor",                 isBull: true  },
  { text: "BOTTOM AVE RANGE",                   type: "avg_range_low",             isBull: true  },
  { text: "TOP AVE RANGE",                      type: "avg_range_high",            isBull: false },
  { text: "MAX RANGE DAYS",                     type: "max_range",                 isBull: false },
  { text: "MAX TREND DAYS",                     type: "max_trend",                 isBull: false },
  { text: "NORMAL RANGE DAYS",                  type: "normal_range",              isBull: false },
  { text: "SINGLE PRINT",                       type: "single_print",              isBull: false },
  { text: "OPTIONS LEDGE",                      type: "options_ledge",             isBull: false },
  { text: "SPREAD MONSTER",                     type: "gex_spread",                isBull: false },
  { text: "GEX FLIP",                           type: "gex_flip",                  isBull: false },
  { text: "WALL LONG",                          type: "gex_wall_long",             isBull: true  },
  { text: "WALL SHORT",                         type: "gex_wall_short",            isBull: false },
  { text: "LONG MEDIAN",                        type: "gex_median_long",           isBull: true  },
  { text: "SHORT MEDIAN",                       type: "gex_median_short",          isBull: false },
  { text: "IV OVERFLOW",                        type: "iv_overflow",               isBull: false },
  { text: "IV WALL",                            type: "iv_wall",                   isBull: false },
  { text: "IV GAP",                             type: "iv_gap",                    isBull: false },
  { text: "RTH GAP",                            type: "rth_gap",                   isBull: false },
  { text: "SUPPORTIVE",                         type: "supportive",                isBull: true  },
  { text: "RESISTIVE",                          type: "resistive",                 isBull: false },
  { text: "SUPPORT",                            type: "support",                   isBull: true  },
  { text: "CEILING",                            type: "ceiling",                   isBull: false },
  { text: "FLOOR",                              type: "floor",                     isBull: true  },
  { text: "PIVOT",                              type: "pivot",                     isBull: false },
  { text: "E VECTOR",                           type: "e_vector",                  isBull: false },
  { text: "S VECTOR",                           type: "s_vector",                  isBull: false },
  { text: "APEX",                               type: "apex",                      isBull: false },
  { text: "SPLICE",                             type: "splice_band",               isBull: false },
];

// Matches e.g. "7150.25-7175", "7150/7175", "7150 - 7175", "7150 to 7175"
const RANGE_RE = /(\d{3,6}(?:\.\d{1,2})?)\s*(?:[-–\/]|to)\s*(\d{3,6}(?:\.\d{1,2})?)/gi;

const KNOWN_SYMS = ["MES", "ES", "MNQ", "NQ", "MYM", "YM", "M2K", "RTY", "CL", "GC", "SPY", "QQQ"];

function findNearestRange(text: string, idx: number): { top: number; bottom: number } | null {
  const WINDOW = 160;
  const lo = Math.max(0, idx - WINDOW);
  const hi = Math.min(text.length, idx + WINDOW);
  const sub = text.slice(lo, hi);

  RANGE_RE.lastIndex = 0;
  let best: { top: number; bottom: number; dist: number } | null = null;
  let m: RegExpExecArray | null;
  while ((m = RANGE_RE.exec(sub)) !== null) {
    const a = parseFloat(m[1]);
    const b = parseFloat(m[2]);
    if (!isFinite(a) || !isFinite(b)) continue;
    const top = Math.max(a, b);
    const bot = Math.min(a, b);
    const spread = top - bot;
    // Zone must be at least 0.25 pts wide and at most 200 pts (ES sanity check)
    if (spread < 0.25 || spread > 200) continue;
    const matchCenter = lo + m.index + m[0].length / 2;
    const dist = Math.abs(matchCenter - idx);
    if (!best || dist < best.dist) best = { top, bottom: bot, dist };
  }
  return best;
}

function inferSymbol(text: string, channel: string): string {
  const combined = (text + " " + channel).toUpperCase();
  for (const sym of KNOWN_SYMS) {
    if (new RegExp(`\\b${sym}\\b`).test(combined)) return sym;
  }
  return "MES";
}

export function parseZonesFromMessage(msg: {
  messageId:   string;
  text:        string;
  authorName:  string;
  channelName: string;
  postedAt:    number;
}): DiscordZone[] {
  const upper  = msg.text.toUpperCase();
  const zones: DiscordZone[] = [];
  const seen   = new Set<string>();

  for (const pattern of ZONE_PATTERNS) {
    let searchFrom = 0;
    while (true) {
      const idx = upper.indexOf(pattern.text, searchFrom);
      if (idx === -1) break;
      searchFrom = idx + 1;

      const range = findNearestRange(msg.text, idx);
      if (!range) continue;

      const key = `${pattern.type}:${range.top}:${range.bottom}`;
      if (seen.has(key)) continue;
      seen.add(key);

      zones.push({
        messageId:   msg.messageId,
        channelName: msg.channelName,
        authorName:  msg.authorName,
        postedAt:    msg.postedAt,
        zoneType:    pattern.type,
        labelRaw:    pattern.text,
        top:         range.top,
        bottom:      range.bottom,
        isBull:      pattern.isBull,
        symbol:      inferSymbol(msg.text, msg.channelName),
        raw:         msg.text.slice(0, 500),
      });
    }
  }
  return zones;
}
