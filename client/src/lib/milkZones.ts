// milkZones.ts — milk zones are an UPLOAD-A-PICTURE feature (per the strategy rule that
// milk zones come ONLY from user-uploaded images, never synthetic/auto-fetched).
// Upload a chart screenshot (or .mwml/.xml/.pdf) → POST /api/zones/parse → store the parsed
// zones per-symbol in localStorage → the terminal chart draws them when MilkZone is on.

export interface MilkZone {
  top: number;
  bottom: number;
  label?: string;
  color: string; // band color assigned by the parser (fillColor)
  // Time bounds (unix seconds). A milk zone is valid for ONE RTH session only, so it is
  // charted from its session open → close and never farther. Stamped at upload time.
  fromTime?: number;
  toTime?: number;
}

const keyFor = (sym: string) => `baxter_milk_zones_${sym.toUpperCase()}`;

/**
 * The RTH session a freshly-uploaded zone belongs to: 9:30 AM → 4:00 PM ET (DST-safe).
 * Milk zones are valid for ONE RTH session only, so every uploaded zone is time-bounded to
 * this window — it charts at the correct time and never extends past a single session.
 * Outside a weekday session (weekend / after the close) it rolls forward to the next weekday.
 */
export function currentRthSession(nowMs: number = Date.now()): { fromTime: number; toTime: number } {
  const sessionFor = (ms: number) => {
    const dateStr = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(ms));
    const [y, mo, d] = dateStr.split("-").map(Number);
    const etToUtc = (h: number, min: number): number => {
      const edt = Date.UTC(y, mo - 1, d, h + 4, min, 0) / 1000;       // assume EDT (UTC-4)
      const wallH = Number(new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York", hour: "2-digit", hour12: false,
      }).format(new Date(edt * 1000)));
      return wallH === h ? edt : Date.UTC(y, mo - 1, d, h + 5, min, 0) / 1000; // else EST (UTC-5)
    };
    return { fromTime: etToUtc(9, 30), toTime: etToUtc(16, 0) };
  };
  const nowSec = Math.floor(nowMs / 1000);
  let probe = nowMs;
  for (let i = 0; i < 5; i++) {
    const s = sessionFor(probe);
    const dow = new Date(s.fromTime * 1000).getUTCDay(); // session date's day-of-week (ET morning)
    if (dow !== 0 && dow !== 6 && nowSec <= s.toTime) return s;
    probe += 24 * 3600 * 1000; // not a tradeable session yet → try the next day
  }
  return sessionFor(probe);
}

export function loadMilkZones(sym: string): MilkZone[] {
  try {
    const raw = localStorage.getItem(keyFor(sym));
    return raw ? (JSON.parse(raw) as MilkZone[]) : [];
  } catch {
    return [];
  }
}

export function saveMilkZones(sym: string, zones: MilkZone[]): void {
  try { localStorage.setItem(keyFor(sym), JSON.stringify(zones)); } catch { /* ignore */ }
}

export function clearMilkZones(sym: string): void {
  try { localStorage.removeItem(keyFor(sym)); } catch { /* ignore */ }
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export interface UploadResult { zones: MilkZone[]; count: number; error?: string; }

/**
 * Upload + parse a milk-zone image. `visibleHigh/Low` give the parser the current chart
 * price range as context (improves screenshot parsing). Returns the parsed zones (also
 * persisted to localStorage for `sym`).
 */
export async function uploadMilkZones(
  file: File, sym: string, visibleHigh?: number, visibleLow?: number,
): Promise<UploadResult> {
  try {
    const base64 = await fileToBase64(file);
    const body: Record<string, unknown> = { filename: file.name, data: base64 };
    if (Number.isFinite(visibleHigh) && Number.isFinite(visibleLow)) {
      body.visibleHigh = visibleHigh;
      body.visibleLow = visibleLow;
    }
    const r = await fetch("/api/zones/parse", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) return { zones: [], count: 0, error: data?.error ?? data?.message ?? `HTTP ${r.status}` };

    const raw = Array.isArray(data?.zones) ? data.zones : [];
    // Every zone from this upload is for the same single RTH session — stamp it once.
    const session = currentRthSession();
    const zones: MilkZone[] = raw
      .map((z: any) => ({
        top: Number(z.topPrice),
        bottom: Number(z.bottomPrice),
        label: typeof z.label === "string" ? z.label : undefined,
        color: typeof z.fillColor === "string" && z.fillColor ? z.fillColor : "#ffd700",
        fromTime: session.fromTime,
        toTime: session.toTime,
      }))
      .filter((z: MilkZone) => Number.isFinite(z.top) && Number.isFinite(z.bottom));

    saveMilkZones(sym, zones);
    return { zones, count: zones.length };
  } catch (err: any) {
    return { zones: [], count: 0, error: err?.message ?? "upload failed" };
  }
}
