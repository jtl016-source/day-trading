/**
 * TRADING JOURNAL ENDPOINTS (2026-08-07 — user directive: "make a journal section in the
 * program and record everything to note from every day's trading… i want to see how you think").
 *
 * Pure read-only adapters over the session-review ritual's artifacts (server/scheduler.ts
 * sessionReview job, 17:20 ET weekdays):
 *   • <artifacts>/session-reports/<date>.md        — the full narrative review (the "thinking")
 *   • <artifacts>/session-reports/<date>-facts.json — the deterministic facts file
 *   • <artifacts>/session-journal.md               — the distilled cross-session lessons
 *
 * Registration mirrors the registerLedger precedent: ONE line in routes.ts. Reads are OPEN
 * through the public edge by policy (2026-08-05: GET/HEAD/OPTIONS open, writes key-gated).
 * Dates are validated as strict YYYY-MM-DD before touching the filesystem — no traversal.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Express } from "express";
import { artifactsDir } from "@shared/artifacts-dir";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Same resolution as the scheduler (the writer of these artifacts): BAXTER_ARTIFACTS_DIR
// when set, else the repo root (= server cwd, guaranteed canonical by the boot guard).
const reportsDir = (): string => path.join(artifactsDir(process.cwd()), "session-reports");
const journalFile = (): string =>
  process.env.SESSION_JOURNAL_PATH ?? path.join(artifactsDir(process.cwd()), "session-journal.md");

export interface JournalDay {
  date: string;          // YYYY-MM-DD (ET session day)
  hasReport: boolean;    // <date>.md exists (the narrative review)
  hasFacts: boolean;     // <date>-facts.json exists (the deterministic collector output)
  reportMtime: string | null; // ISO mtime of the report (null when absent)
}

export interface JournalLesson {
  date: string;        // from the entry header
  tag: string;         // stable kebab-case lesson id (recurrence key)
  title: string;       // one-line lesson
  body: string;        // 2-3 line body incl. the **Recurrence:** line
}

/** Every session day that has a report and/or facts file, newest first. */
export function listJournalDays(): JournalDay[] {
  const dir = reportsDir();
  let files: string[] = [];
  try { files = fs.readdirSync(dir); } catch { return []; }
  const byDate = new Map<string, JournalDay>();
  for (const f of files) {
    const mReport = /^(\d{4}-\d{2}-\d{2})\.md$/.exec(f);
    const mFacts = /^(\d{4}-\d{2}-\d{2})-facts\.json$/.exec(f);
    const date = mReport?.[1] ?? mFacts?.[1];
    if (!date) continue;
    let d = byDate.get(date);
    if (!d) { d = { date, hasReport: false, hasFacts: false, reportMtime: null }; byDate.set(date, d); }
    if (mReport) {
      d.hasReport = true;
      try { d.reportMtime = fs.statSync(path.join(dir, f)).mtime.toISOString(); } catch { /* stat race */ }
    }
    if (mFacts) d.hasFacts = true;
  }
  return [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date));
}

/** Parse session-journal.md into entries (newest LAST in the file — callers reverse). */
export function parseJournalLessons(raw: string): JournalLesson[] {
  const out: JournalLesson[] = [];
  const re = /^## (\d{4}-\d{2}-\d{2}) \[([a-z0-9-]+)\] — (.+)$/gm;
  let m: RegExpExecArray | null;
  const marks: Array<{ idx: number; date: string; tag: string; title: string }> = [];
  while ((m = re.exec(raw)) !== null) marks.push({ idx: m.index, date: m[1], tag: m[2], title: m[3].trim() });
  for (let i = 0; i < marks.length; i++) {
    const start = raw.indexOf("\n", marks[i].idx) + 1;
    const end = i + 1 < marks.length ? marks[i + 1].idx : raw.length;
    out.push({ date: marks[i].date, tag: marks[i].tag, title: marks[i].title, body: raw.slice(start, end).trim() });
  }
  return out;
}

export function registerJournal(app: Express): void {
  // GET /api/journal/days — the session-day index (newest first).
  app.get("/api/journal/days", (_req, res) => {
    res.json({ days: listJournalDays(), reportsDir: reportsDir() });
  });

  // GET /api/journal/report/:date — one day's full narrative review markdown.
  app.get("/api/journal/report/:date", (req, res) => {
    const date = req.params.date;
    if (!DATE_RE.test(date)) { res.status(400).json({ error: "bad date (want YYYY-MM-DD)" }); return; }
    const file = path.join(reportsDir(), `${date}.md`);
    try {
      const markdown = fs.readFileSync(file, "utf8");
      res.json({ date, markdown });
    } catch {
      res.status(404).json({ error: `no report for ${date}` });
    }
  });

  // GET /api/journal/lessons — the distilled cross-session lessons, newest first.
  app.get("/api/journal/lessons", (_req, res) => {
    let raw = "";
    try { raw = fs.readFileSync(journalFile(), "utf8"); } catch { /* absent → empty list */ }
    res.json({ path: journalFile(), lessons: parseJournalLessons(raw).reverse() });
  });
}
