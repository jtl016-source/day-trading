/**
 * Roll re-adjustment healing.
 *
 * Continuous futures contracts (@ES) periodically re-adjust their whole history
 * by a constant offset when the front month rolls. When that happens, the bars
 * we already persisted differ from freshly-fetched bars by a single constant δ
 * across the overlap. This detects that signature and shifts the older stored
 * bars by δ so history stays continuous, rather than leaving a price cliff at
 * the roll boundary.
 */
import { db } from "./db";
import { broadcast } from "./live-bars";

const ES_HALF_TICK = 0.125; // half of one ES tick (0.25) — diffs within this are "equal"

export async function detectAndHeal(
  symbol: string,
  resolution: string,
  incoming: { t: number; o: number; h: number; l: number; c: number; v: number }[],
): Promise<{ delta: number } | null> {
  if (!incoming.length) return null;

  let minT = Infinity, maxT = -Infinity;
  for (const b of incoming) { if (b.t < minT) minT = b.t; if (b.t > maxT) maxT = b.t; }

  const rows = db.$client.prepare(
    `SELECT timestamp, close FROM cached_candles
       WHERE symbol=? AND resolution=? AND timestamp>=? AND timestamp<=?`,
  ).all(symbol, resolution, minT, maxT) as { timestamp: number; close: number }[];
  if (rows.length === 0) return null;

  const storedByTs = new Map<number, number>();
  for (const r of rows) storedByTs.set(r.timestamp, r.close);

  const diffs: number[] = [];
  for (const b of incoming) {
    const sc = storedByTs.get(b.t);
    if (sc !== undefined) diffs.push(b.c - sc); // amount to add to stored bars
  }
  if (diffs.length < 20) return null; // not enough overlap to be confident

  let dmin = Infinity, dmax = -Infinity;
  for (const d of diffs) { if (d < dmin) dmin = d; if (d > dmax) dmax = d; }
  const constant = (dmax - dmin) <= ES_HALF_TICK;
  const delta = (dmin + dmax) / 2;

  if (constant && Math.abs(delta) > ES_HALF_TICK) {
    // Roll re-adjustment: shift every older bar (before the incoming window) by δ.
    // The overlap region itself is overwritten by the subsequent upsert.
    const tx = db.$client.transaction(() => {
      db.$client.prepare(
        `UPDATE cached_candles
            SET open=open+?, high=high+?, low=low+?, close=close+?
          WHERE symbol=? AND resolution=? AND timestamp < ?`,
      ).run(delta, delta, delta, delta, symbol, resolution, minT);
      db.$client.prepare(
        `INSERT INTO adjustment_log (symbol, resolution, detected_at, delta, pivot_ts)
         VALUES (?,?,?,?,?)`,
      ).run(symbol, resolution, Date.now(), delta, minT);
    });
    tx();
    console.warn(`[roll-heal] roll re-adjustment δ=${delta.toFixed(2)} applied to ${symbol} res=${resolution} (bars before ${minT})`);
    return { delta };
  }

  if (!constant) {
    // Overlap disagrees non-uniformly — not a clean roll, likely data corruption.
    console.warn(`[roll-heal] non-constant close diffs for ${symbol} res=${resolution} spread=${(dmax - dmin).toFixed(3)} — not healing`);
    broadcast({ type: "mw_sync_warning", symbol, resolution, reason: "nonconstant_overlap", spread: dmax - dmin });
    return null;
  }

  return null;
}
