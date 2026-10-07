// JournalView.tsx — TRADING JOURNAL tab (2026-08-07, user directive: "record everything to
// note from every day's trading… i want to see how you think").
//
// Pure consumer of the session-review ritual's artifacts via three read-only endpoints:
//   GET /api/journal/days          — session-day index (every reviewed day, green or red)
//   GET /api/journal/report/:date  — that day's full narrative review markdown
//   GET /api/journal/lessons       — the distilled cross-session lessons (session-journal.md)
//
// Self-contained (LedgerView precedent): own fetches, no useTerminalData coupling.
// Honesty rules baked in (Learnings 2026-08-02): a server that predates these routes HANGS
// unknown /api GETs — every fetch carries an AbortController timeout + a JSON content-type
// guard, and the miss renders an explicit "activates on the next server restart" panel.
import { useEffect, useState, type CSSProperties } from "react";
import { C } from "./terminalStyles";

interface JournalDay { date: string; hasReport: boolean; hasFacts: boolean; reportMtime: string | null }
interface JournalLesson { date: string; tag: string; title: string; body: string }

const FETCH_TIMEOUT_MS = 10_000;

async function getJson<T>(url: string): Promise<T | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok) return null;
    if (!(res.headers.get("content-type") ?? "").includes("application/json")) return null; // vite catch-all
    return await res.json() as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── Minimal markdown renderer (headers / bullets / bold / inline code) ──
// The reports are trusted first-party output of our own reviewer; this renders structure,
// it does not aim to be a full markdown implementation.
function inline(text: string): JSX.Element {
  const parts: Array<JSX.Element | string> = [];
  // **bold** and `code` — non-greedy, no nesting.
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0; let m: RegExpExecArray | null; let k = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("**")) parts.push(<strong key={k++} style={{ color: C.text }}>{tok.slice(2, -2)}</strong>);
    else parts.push(<code key={k++} style={{ background: C.panel2, padding: "0 4px", borderRadius: 3, fontSize: "0.92em" }}>{tok.slice(1, -1)}</code>);
    last = m.index + tok.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

function Markdown({ md }: { md: string }) {
  const blocks: JSX.Element[] = [];
  const lines = md.split(/\r?\n/);
  let k = 0;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (!ln.trim()) continue;
    if (ln.startsWith("### ")) blocks.push(<div key={k++} style={{ color: C.accent, fontWeight: 700, marginTop: 14, marginBottom: 4 }}>{inline(ln.slice(4))}</div>);
    else if (ln.startsWith("## ")) blocks.push(<div key={k++} style={{ color: C.accent, fontWeight: 800, fontSize: 13, letterSpacing: 0.4, marginTop: 18, marginBottom: 6, textTransform: "uppercase" }}>{inline(ln.slice(3))}</div>);
    else if (ln.startsWith("# ")) blocks.push(<div key={k++} style={{ color: C.text, fontWeight: 800, fontSize: 15, marginBottom: 8 }}>{inline(ln.slice(2))}</div>);
    else if (/^\s*- /.test(ln)) {
      blocks.push(
        <div key={k++} style={{ display: "flex", gap: 8, margin: "3px 0 3px 6px" }}>
          <span style={{ color: C.dim }}>•</span>
          <span style={{ flex: 1 }}>{inline(ln.replace(/^\s*- /, ""))}</span>
        </div>,
      );
    } else if (ln.startsWith("|")) blocks.push(<div key={k++} style={{ fontFamily: "ui-monospace, monospace", fontSize: 11, whiteSpace: "pre", overflowX: "auto", color: C.muted }}>{ln}</div>);
    else blocks.push(<div key={k++} style={{ margin: "4px 0" }}>{inline(ln)}</div>);
  }
  return <div style={{ color: C.muted, fontSize: 12.5, lineHeight: 1.55 }}>{blocks}</div>;
}

// READABILITY (2026-08-07 user report): the terminal's live chart IS the page background and
// .tt-view adds no backdrop — translucent C.panel fills left the notes unreadable over
// candles. The whole view now sits on an opaque dark card (the .tt-hud idiom, more opaque
// for long-form text), with solid panels inside it.
const PANEL_BG = "rgba(10, 12, 18, 0.97)";
const S: Record<string, CSSProperties> = {
  wrap: {
    display: "flex", gap: 14, height: "100%", minHeight: 0,
    background: "rgba(8,10,16,0.92)", border: `1px solid ${C.line}`, borderRadius: 14,
    padding: 14, backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)",
  },
  left: { width: 210, flexShrink: 0, overflowY: "auto", borderRight: `1px solid ${C.line}`, paddingRight: 10 },
  right: { flex: 1, minWidth: 0, overflowY: "auto", paddingRight: 6 },
  dayBtn: { display: "block", width: "100%", textAlign: "left", background: "none", border: `1px solid ${C.lineSoft}`, borderRadius: 8, padding: "8px 10px", marginBottom: 6, cursor: "pointer", color: C.text },
  panel: { background: PANEL_BG, border: `1px solid ${C.line}`, borderRadius: 10, padding: 14, marginBottom: 14 },
  tag: { display: "inline-block", background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 999, padding: "1px 8px", fontSize: 10.5, color: C.accent, marginRight: 8 },
};

export function JournalView() {
  const [days, setDays] = useState<JournalDay[] | null>(null);
  const [lessons, setLessons] = useState<JournalLesson[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [report, setReport] = useState<{ date: string; markdown: string } | null>(null);
  const [reportBusy, setReportBusy] = useState(false);
  const [endpointLive, setEndpointLive] = useState<boolean | null>(null); // null = probing
  const [view, setView] = useState<"reports" | "lessons">("reports");

  useEffect(() => {
    let gone = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // RETRY LOOP (not a one-shot probe): a fetch can time out on a transient event-loop
    // stall (boot slab / catch-up pass starving the server for >10s — documented server
    // behavior), which is indistinguishable from "route missing" in one sample. Keep
    // re-probing so the honest fallback panel self-heals once the server breathes.
    const probe = async (): Promise<void> => {
      const [d, l] = await Promise.all([
        getJson<{ days: JournalDay[] }>("/api/journal/days"),
        getJson<{ lessons: JournalLesson[] }>("/api/journal/lessons"),
      ]);
      if (gone) return;
      if (!d && !l) {
        setEndpointLive(false);
        timer = setTimeout(() => { void probe(); }, 20_000);
        return;
      }
      setEndpointLive(true);
      const dayList = d?.days ?? [];
      setDays(dayList);
      setLessons(l?.lessons ?? []);
      setSelected(prev => prev ?? (dayList.find(x => x.hasReport)?.date ?? dayList[0]?.date ?? null));
    };
    void probe();
    return () => { gone = true; if (timer) clearTimeout(timer); };
  }, []);

  useEffect(() => {
    if (!selected) { setReport(null); return; }
    let gone = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    setReportBusy(true);
    // One delayed retry: a null can be a transient event-loop stall, not a missing report.
    const load = (attempt: number): void => {
      void getJson<{ date: string; markdown: string }>(`/api/journal/report/${selected}`).then(r => {
        if (gone) return;
        if (!r && attempt === 0) { timer = setTimeout(() => load(1), 4_000); return; }
        setReport(r);
        setReportBusy(false);
      });
    };
    load(0);
    return () => { gone = true; if (timer) clearTimeout(timer); };
  }, [selected]);

  if (endpointLive === null) {
    return <div style={{ ...S.panel, color: C.muted, maxWidth: 320 }}>Loading journal…</div>;
  }
  if (endpointLive === false) {
    return (
      <div style={{ ...S.panel, color: C.muted, maxWidth: 560 }}>
        <div style={{ color: C.amber, fontWeight: 700, marginBottom: 6 }}>Journal endpoints not live yet</div>
        The trading journal activates on the next server restart (the running server predates
        the /api/journal routes). The daily review itself still runs at 17:20 ET — reports land
        in the session-reports folder either way.
      </div>
    );
  }

  return (
    <div style={S.wrap}>
      <div style={S.left}>
        <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
          {(["reports", "lessons"] as const).map(v => (
            <button
              key={v}
              onClick={() => setView(v)}
              style={{
                flex: 1, background: view === v ? C.panel2 : "none", color: view === v ? C.text : C.muted,
                border: `1px solid ${view === v ? C.line : C.lineSoft}`, borderRadius: 8, padding: "6px 0",
                cursor: "pointer", fontSize: 11.5, fontWeight: 700, letterSpacing: 0.3, textTransform: "uppercase",
              }}
            >
              {v === "reports" ? "Daily" : "Lessons"}
            </button>
          ))}
        </div>
        {view === "reports" && (days ?? []).map(d => (
          <button
            key={d.date}
            onClick={() => setSelected(d.date)}
            style={{ ...S.dayBtn, background: selected === d.date ? C.panel2 : "none", borderColor: selected === d.date ? C.line : C.lineSoft }}
          >
            <div style={{ fontWeight: 700, fontSize: 12.5 }}>{d.date}</div>
            <div style={{ color: C.dim, fontSize: 10.5, marginTop: 2 }}>
              {d.hasReport ? "review" : "facts only"}{d.hasFacts && d.hasReport ? " + facts" : ""}
            </div>
          </button>
        ))}
        {view === "reports" && (days ?? []).length === 0 && (
          <div style={{ color: C.dim, fontSize: 11.5 }}>
            No reviewed days yet — the first report lands after the next 17:20 ET session review.
          </div>
        )}
        {view === "lessons" && (
          <div style={{ color: C.dim, fontSize: 11.5, lineHeight: 1.5 }}>
            Distilled lessons the reviewer carries between sessions. Recurring tags mean the
            same failure (or edge) keeps showing up.
          </div>
        )}
      </div>

      <div style={S.right}>
        {view === "reports" && (
          <>
            {reportBusy && <div style={{ color: C.dim, padding: 8 }}>Loading {selected}…</div>}
            {!reportBusy && report && (
              <div style={S.panel}>
                <Markdown md={report.markdown} />
              </div>
            )}
            {!reportBusy && !report && selected && (
              <div style={{ ...S.panel, color: C.muted }}>
                No narrative review for {selected} — the facts file exists, but the reviewer
                didn't produce a report for this day (a MECHANICAL fallback may have posted to
                Discord instead).
              </div>
            )}
          </>
        )}
        {view === "lessons" && (
          <>
            {(lessons ?? []).map((l, i) => (
              <div key={`${l.date}-${l.tag}-${i}`} style={S.panel}>
                <div style={{ marginBottom: 6 }}>
                  <span style={S.tag}>{l.tag}</span>
                  <span style={{ color: C.dim, fontSize: 11 }}>{l.date}</span>
                </div>
                <div style={{ color: C.text, fontWeight: 700, fontSize: 13, marginBottom: 6 }}>{l.title}</div>
                <Markdown md={l.body} />
              </div>
            ))}
            {(lessons ?? []).length === 0 && (
              <div style={{ ...S.panel, color: C.muted }}>No lessons recorded yet.</div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
