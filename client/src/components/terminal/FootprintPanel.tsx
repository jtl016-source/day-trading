// FootprintPanel.tsx — the footprint LADDER: bid × ask volume-at-price for the latest
// candle, polled from /api/footprint/latest. POC row highlighted; imbalanced levels
// colored. Floats over the chart when Footprint is enabled.
import { useEffect, useState } from "react";
import { C } from "./terminalStyles";

interface PriceLevel { price: number; bidVol: number; askVol: number; delta: number; imbalance: "buy" | "sell" | "none"; }
interface FpCandle {
  time: number; levels: PriceLevel[]; poc: number; candleDelta: number;
  totalBidVol: number; totalAskVol: number;
}

const MAX_ROWS = 26;

function fmtEtHM(tsSec: number): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(tsSec * 1000));
}

export function FootprintPanel({ symbol, interval }: { symbol: string; interval: string }) {
  const [fc, setFc] = useState<FpCandle | null>(null);
  const base = interval === "15m" ? "5m" : interval;

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch(`/api/footprint/latest/${encodeURIComponent(symbol)}/${base}`)
        .then((r) => r.json())
        .then((d) => { if (!cancelled) setFc(d && Array.isArray(d.levels) ? d : null); })
        .catch(() => { /* ignore */ });
    };
    load();
    const t = setInterval(load, 4000);
    return () => { cancelled = true; clearInterval(t); };
  }, [symbol, base]);

  if (!fc || !fc.levels.length) {
    return (
      <div className="tt-fp">
        <div className="tt-fp-head"><b>FOOTPRINT</b><span>waiting for data…</span></div>
      </div>
    );
  }

  // Sort by price desc, window around POC.
  const sorted = [...fc.levels].sort((a, b) => b.price - a.price);
  let rows = sorted;
  if (sorted.length > MAX_ROWS) {
    const pocIdx = Math.max(0, sorted.findIndex((l) => l.price === fc.poc));
    const start = Math.min(Math.max(0, pocIdx - Math.floor(MAX_ROWS / 2)), sorted.length - MAX_ROWS);
    rows = sorted.slice(start, start + MAX_ROWS);
  }
  const maxVol = Math.max(1, ...rows.flatMap((l) => [l.bidVol, l.askVol]));
  const delta = fc.candleDelta ?? (fc.totalAskVol - fc.totalBidVol);

  return (
    <div className="tt-fp">
      <div className="tt-fp-head">
        <b>FOOTPRINT</b>
        <span>{fmtEtHM(fc.time)} · Δ <i style={{ color: delta >= 0 ? C.up : C.down, fontStyle: "normal" }}>{delta >= 0 ? "+" : ""}{Math.round(delta)}</i></span>
      </div>
      <div className="tt-fp-cols"><span>BID</span><span>PRICE</span><span>ASK</span></div>
      <div className="tt-fp-rows">
        {rows.map((l) => {
          const isPoc = l.price === fc.poc;
          return (
            <div key={l.price} className={"tt-fp-row" + (isPoc ? " poc" : "")}>
              <span className="tt-fp-bid">
                <span className="tt-fp-bar" style={{ width: (l.bidVol / maxVol) * 100 + "%" }} />
                <i style={l.imbalance === "sell" ? { color: C.down, fontStyle: "normal", fontWeight: 700 } : { fontStyle: "normal" }}>{l.bidVol || ""}</i>
              </span>
              <span className="tt-fp-price">{l.price.toFixed(2)}</span>
              <span className="tt-fp-ask">
                <span className="tt-fp-bar ask" style={{ width: (l.askVol / maxVol) * 100 + "%" }} />
                <i style={l.imbalance === "buy" ? { color: C.up, fontStyle: "normal", fontWeight: 700 } : { fontStyle: "normal" }}>{l.askVol || ""}</i>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
