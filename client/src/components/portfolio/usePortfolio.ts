// ── Portfolio data hooks + formatters ────────────────────────────────────────
// Plain useState/useEffect/fetch — matches the app's existing pattern (useTerminalData).
// No new global-state libraries. All requests hit the same-origin :PORT server.
import { useCallback, useEffect, useRef, useState } from "react";

export interface ApiState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  dataStale: boolean;
  refetch: () => void;
}

export function useApi<T>(url: string, pollMs = 0): ApiState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const aliveRef = useRef(true);

  const refetch = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    aliveRef.current = true;
    let timer: ReturnType<typeof setInterval> | null = null;
    const run = async (silent: boolean) => {
      if (!silent) setLoading(true);
      try {
        const r = await fetch(url);
        const j = await r.json();
        if (aliveRef.current) { setData(j); setError(j?.error ?? null); }
      } catch (e) {
        if (aliveRef.current) setError((e as Error).message);
      } finally {
        if (aliveRef.current && !silent) setLoading(false);
      }
    };
    run(false);
    if (pollMs > 0) timer = setInterval(() => run(true), pollMs);
    return () => { aliveRef.current = false; if (timer) clearInterval(timer); };
  }, [url, pollMs, tick]);

  const dataStale = !!(data as any)?.dataStale;
  return { data, loading, error, dataStale, refetch };
}

export async function apiPost(url: string, body: unknown): Promise<any> {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return r.json();
}
export async function apiDelete(url: string): Promise<any> {
  const r = await fetch(url, { method: "DELETE" });
  return r.json();
}

// ── formatters (IBM Plex Mono, right-aligned in tables) ──────────────────────
export const fmtNum = (n: number | null | undefined, d = 2): string =>
  n === null || n === undefined || !Number.isFinite(n) ? "—" : n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
export const fmtMoney = (n: number | null | undefined): string =>
  n === null || n === undefined || !Number.isFinite(n) ? "—" : "$" + Math.round(n).toLocaleString("en-US");
export const fmtCompact = (n: number | null | undefined): string => {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const a = Math.abs(n);
  if (a >= 1e12) return "$" + (n / 1e12).toFixed(2) + "T";
  if (a >= 1e9) return "$" + (n / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return "$" + (n / 1e6).toFixed(1) + "M";
  if (a >= 1e3) return "$" + (n / 1e3).toFixed(0) + "K";
  return "$" + n.toFixed(0);
};
export const fmtPct = (n: number | null | undefined, d = 1): string =>
  n === null || n === undefined || !Number.isFinite(n) ? "—" : (n >= 0 ? "+" : "") + n.toFixed(d) + "%";
export const fmtDate = (s: string): string => {
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "2-digit" }) : "—";
};
export const freshness = (asOf: number | null | undefined): string => {
  if (!asOf) return "—";
  const mins = Math.round((Date.now() - asOf) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const h = Math.round(mins / 60);
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
};

export const GRADE_COLOR: Record<string, string> = {
  A: "#1fd98a", B: "#2dd4bf", C: "#ffb454", D: "#ff8a5b", F: "#ff4d6d",
};
export const partyColor = (party: string): string => {
  const p = party.toLowerCase();
  return p.includes("repub") ? "#ff4d6d" : p.includes("democ") ? "#4d9bff" : "#7c8190";
};
