import { strategyGuard } from "./strategy-guard";

const STRATEGY_KEYWORDS: Record<string, string[]> = {
  "milks-zones": [
    "milk zone", "milkzone", "milk zones", "yellow box", "yellowbox",
    "milk ok", "milkok", "bullish zone", "bearish zone", "order flow zone",
    "mwml", "zone top", "zone bottom", "zone proximity", "zone downgrade",
  ],
  "vector": [
    "vector", "hl20", "highest lowest", "highest(lowest", "vector slope",
    "vector gate", "vector line", "vector value", "60m vector", "15m vector",
    "secondary vector", "vector confluence", "vector direction",
  ],
  "pattern-recognition": [
    "body confirmation", "bodyok", "body ok", "fractal", "fls",
    "fractal liquidity sweep", "delta imbalance", "sweep and close",
    "pattern bonus", "pattern recognition", "candle pattern",
  ],
  "data-analysis": [
    "exit strategy", "take profit", "tp1", "tp2", "stop loss", "sl",
    "monte carlo", "win rate", "expected value", "r:r", "risk reward",
    "hod suppression", "lod", "hod", "cme settlement", "cooldown",
    "rth window", "eth window", "calibration", "walk forward",
  ],
  "candle-behavior": [ // CANDLE-SPEC:
    "candle", "candles", "candlestick", // CANDLE-SPEC:
    "ohlc", "ohlcv", "open price", "close price", // CANDLE-SPEC:
    "wick", "wicks", "high low", // CANDLE-SPEC:
    "catch-up candle", "false candle", "fake candle", // CANDLE-SPEC:
    "forming bar", "in-progress bar", "live bar", // CANDLE-SPEC:
    "timestamp alignment", "bucket", "interval aligned", // CANDLE-SPEC:
    "livecandles", "basecandles", "candle merge", // CANDLE-SPEC:
    "gap fill", "gap candle", "missing candle", // CANDLE-SPEC:
    "cached_candles", "candle store", "candle db", // CANDLE-SPEC:
  ], // CANDLE-SPEC:
  "footprint": [ // FOOTPRINT-STRATEGY:
    "footprint", "foot print", // FOOTPRINT-STRATEGY:
    "bid ask", "bid/ask", "bid×ask", // FOOTPRINT-STRATEGY:
    "delta", "order aggression", // FOOTPRINT-STRATEGY:
    "absorption", "absorbing", // FOOTPRINT-STRATEGY:
    "imbalance", "stacked imbalance", // FOOTPRINT-STRATEGY:
    "delta divergence", "divergence", // FOOTPRINT-STRATEGY:
    "unfinished auction", // FOOTPRINT-STRATEGY:
    "trapped traders", "trapped longs", "trapped shorts", // FOOTPRINT-STRATEGY:
    "point of control", "poc", // FOOTPRINT-STRATEGY:
    "tick data", "bid volume", "ask volume", // FOOTPRINT-STRATEGY:
  ], // FOOTPRINT-STRATEGY:
};

export interface StrategyMentionResult {
  triggered: boolean;
  matchedStrategies: Array<{ id: string; name: string; matchedKeywords: string[] }>;
}

export function detectStrategyMention(prompt: string): StrategyMentionResult {
  const lower = prompt.toLowerCase();
  const matched: StrategyMentionResult["matchedStrategies"] = [];

  for (const [stratId, keywords] of Object.entries(STRATEGY_KEYWORDS)) {
    const hits = keywords.filter((kw) => lower.includes(kw));
    if (hits.length > 0) {
      const meta = strategyGuard.getById(stratId);
      matched.push({ id: stratId, name: meta?.name ?? stratId, matchedKeywords: hits });
    }
  }

  return { triggered: matched.length > 0, matchedStrategies: matched };
}
