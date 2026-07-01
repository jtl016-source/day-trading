// ── Financial Modeling Prep client ───────────────────────────────────────────
// - API key from process.env.FMP_API_KEY (never hardcoded).
// - Retry with exponential backoff.
// - Daily call budget guard: warns at 200, hard-stops at 245 so the free-tier
//   250/day ceiling is never breached (callers degrade gracefully via swr()).

const BASE_V3 = "https://financialmodelingprep.com/api/v3";
const BASE_V4 = "https://financialmodelingprep.com/api/v4";
const BASE_STABLE = "https://financialmodelingprep.com/stable";

const WARN_AT = 200;
const HARD_CAP = 245;

let callCount = 0;
let budgetDay = utcDay();

function utcDay(): number {
  return Math.floor(Date.now() / 86_400_000);
}

function bump(): void {
  const d = utcDay();
  if (d !== budgetDay) { budgetDay = d; callCount = 0; } // reset at UTC midnight
  callCount++;
  if (callCount === WARN_AT) {
    console.warn(`[portfolio/fmp] ⚠ ${WARN_AT} FMP calls today — approaching the free-tier limit. Caching should keep this under ${HARD_CAP + 5}.`);
  }
}

export function fmpBudget(): { used: number; warnAt: number; hardCap: number; day: number } {
  if (utcDay() !== budgetDay) { budgetDay = utcDay(); callCount = 0; }
  return { used: callCount, warnAt: WARN_AT, hardCap: HARD_CAP, day: budgetDay };
}

export function hasApiKey(): boolean {
  return !!(process.env.FMP_API_KEY && process.env.FMP_API_KEY.trim());
}

type Base = "v3" | "v4" | "stable";
function baseUrl(b: Base): string {
  return b === "v4" ? BASE_V4 : b === "stable" ? BASE_STABLE : BASE_V3;
}

/**
 * GET an FMP endpoint and parse JSON. `path` is appended to the chosen base; `params`
 * are query params (the apikey is added automatically). Throws on budget/HTTP/parse
 * failure so the SWR layer can fall back to cache. Retries transient failures.
 */
export async function fmpGet<T = any>(
  path: string,
  params: Record<string, string | number | undefined> = {},
  opts: { base?: Base; retries?: number } = {},
): Promise<T> {
  if (!hasApiKey()) throw new Error("FMP_API_KEY not configured");
  if (utcDay() !== budgetDay) { budgetDay = utcDay(); callCount = 0; }
  if (callCount >= HARD_CAP) throw new Error(`FMP daily budget guard hit (${callCount}/${HARD_CAP}) — serving cache only`);

  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") qs.set(k, String(v));
  qs.set("apikey", process.env.FMP_API_KEY!.trim());
  const url = `${baseUrl(opts.base ?? "v3")}${path}?${qs.toString()}`;

  const retries = opts.retries ?? 3;
  let lastErr: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      bump();
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 12_000);
      const res = await fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(t));
      if (res.status === 429) throw new Error("FMP 429 rate limited");
      if (!res.ok) throw new Error(`FMP HTTP ${res.status}`);
      const json = (await res.json()) as any;
      if (json && json["Error Message"]) throw new Error(`FMP: ${json["Error Message"]}`);
      return json as T;
    } catch (e) {
      lastErr = e;
      if (attempt < retries - 1) {
        const backoff = 400 * Math.pow(2, attempt) + Math.random() * 200; // 0.4s, 0.8s, 1.6s + jitter
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
  }
  throw lastErr ?? new Error("FMP request failed");
}

// Small parsing helpers shared by the services.
export const num = (v: any): number | null => {
  const n = typeof v === "string" ? parseFloat(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};
export const arr = <T>(v: any): T[] => (Array.isArray(v) ? v : []);
