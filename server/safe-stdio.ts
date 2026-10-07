/**
 * SAFE STDIO (2026-09-18 outage — "the server froze at 0 % CPU and answered nothing").
 *
 * WHAT HAPPENED: on Windows, process.stdout / process.stderr writes to a PIPE (or a console)
 * are SYNCHRONOUS. The trading server is normally launched by something that captures its
 * output through a pipe (`npm run dev` under a preview harness / a Claude session, a wrapper
 * script…). The moment that reader stops draining — its session ended, its window closed, a
 * console in QuickEdit selection mode — the pipe fills (~80 KB, under a minute of logs) and the
 * next console.log blocks FOREVER inside WriteFile: the whole event loop wedges, no tick is
 * relayed, no order gate runs, no HTTP request is answered, CPU reads 0 %. On 2026-09-18 the
 * 11:56 server (its launcher gone) was found exactly like that after the laptop came back from
 * Modern Standby, with the digest's integrity-check child blocked on ITS pipe to us. Measured on
 * this machine (Node 24): `process.stdout._handle.setBlocking(false)` returns 0 and does NOT
 * help; scripts/safe-stdio.test.ts reproduces the wedge and proves the fix.
 *
 * THE FIX: the main thread never performs a console write again. process.stdout.write /
 * process.stderr.write are replaced by a function that
 *   (1) appends the text to a local log FILE through an async stream (libuv threadpool — it
 *       cannot block the loop; skipped while its own backlog is large), so there is finally a
 *       durable server log that does not depend on who launched the process, and
 *   (2) hands the text to a tiny WORKER THREAD that does the blocking fs.writeSync(fd). If the
 *       reader goes away only that thread blocks; the main thread keeps a bounded backlog and
 *       DROPS console output beyond it (counted, reported in the file log) instead of waiting.
 * A live reader sees exactly the same output as before.
 *
 * Details that matter:
 *   • SECRETS: the request logger echoes small JSON bodies (the Discord webhook URL, keys in
 *     query strings). A durable file makes that a stored secret, so every chunk is REDACTED
 *     (webhook URLs, Discord tokens, ?key=… params) before it goes anywhere.
 *   • LAST WORDS: a fatal line printed right before process.exit() (wrong-cwd guard,
 *     EADDRINUSE) used to be lost ~10 % of the time because the writer thread never got to it.
 *     An 'exit' hook appends the still-pending chunks to the file synchronously (a local file
 *     cannot block for long) and, only while the reader is provably draining, to the console.
 *   • The file rolls over at local midnight and stops at MAX_FILE_BYTES per day.
 *
 * Caveat: while the writer thread is stuck in a blocked write, process.exit() cannot complete
 * (Node joins its workers) — such a process must be killed from outside. That is strictly
 * better than the alternative, which was the same stuck process NOT serving anything.
 *
 * Opt out with SAFE_STDIO=false. Imported for its side effect as the FIRST project import of
 * server/index.ts so every later module logs through it.
 */
import { Worker } from "worker_threads";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const MAX_BACKLOG = 4000;                       // chunks queued to the writer thread before console output is dropped
const MAX_FILE_BACKLOG_BYTES = 8 * 1024 * 1024; // async file stream backlog beyond which file lines are skipped
const MAX_FILE_BYTES = 200 * 1024 * 1024;       // per day — a runaway log must not fill the disk
const KEEP_LOG_FILES = 7;
const EXIT_CONSOLE_MAX_PENDING = 200;           // exit flush to the console only while the reader is clearly draining
const EXIT_CONSOLE_ACK_FRESH_MS = 2_000;

const WRITER_SRC = `
  const { parentPort } = require("worker_threads");
  const fs = require("fs");
  parentPort.on("message", (m) => {
    try { fs.writeSync(m.fd, m.s); } catch (e) { /* EPIPE / closed handle — nothing to do */ }
    parentPort.postMessage(0);
  });
`;

/** Strip credentials from a log chunk (exported for the unit harness). */
export function redactSecrets(s: string): string {
  return s
    .replace(/https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+/g, "https://discord.com/api/webhooks/<redacted>")
    .replace(/\b[\w-]{24,28}\.[\w-]{6}\.[\w-]{27,45}\b/g, "<redacted-token>")
    .replace(/([?&]key=)[^&\s"'\\]+/g, "$1<redacted>");
}

interface SafeStdioStats { installed: boolean; outstanding: number; dropped: number; writerDead: boolean; logFile: string | null; fileBytes: number }
const stats: SafeStdioStats = { installed: false, outstanding: 0, dropped: 0, writerDead: false, logFile: null, fileBytes: 0 };
export function safeStdioStats(): SafeStdioStats { return { ...stats }; }

function dayStamp(d = new Date()): string {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}
function nextMidnightMs(): number {
  const d = new Date(); d.setHours(24, 0, 0, 0); return d.getTime();
}

function logDir(): string | null {
  try {
    // Never inside the OneDrive-synced repo: an ever-growing log under a cloud filter driver is
    // its own hazard. BAXTER_ARTIFACTS_DIR / C:\BaxterData is the established local data root.
    const roots = [process.env.BAXTER_ARTIFACTS_DIR, "C:\\BaxterData", os.tmpdir()].filter((d): d is string => !!d && fs.existsSync(d));
    if (!roots.length) return null;
    const dir = path.join(roots[0], "logs");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch { return null; }
}

function openLogFile(): fs.WriteStream | null {
  try {
    const dir = logDir();
    if (!dir) return null;
    try {
      const old = fs.readdirSync(dir).filter(f => /^server-\d{8}\.log$/.test(f)).sort();
      for (const f of old.slice(0, Math.max(0, old.length - (KEEP_LOG_FILES - 1)))) { try { fs.unlinkSync(path.join(dir, f)); } catch { /* in use */ } }
    } catch { /* listing is best-effort */ }
    const file = path.join(dir, `server-${dayStamp()}.log`);
    try { stats.fileBytes = fs.existsSync(file) ? fs.statSync(file).size : 0; } catch { stats.fileBytes = 0; }
    const stream = fs.createWriteStream(file, { flags: "a" });
    stream.on("error", () => { /* a failing log file must never take the server down */ });
    stats.logFile = file;
    return stream;
  } catch { return null; }
}

export function installSafeStdio(): void {
  if (stats.installed || process.env.SAFE_STDIO === "false") return;
  stats.installed = true;

  let file = openLogFile();
  let rollAt = nextMidnightMs();
  let capNoted = false;

  let worker: Worker | null = null;
  const pending: Array<{ fd: 1 | 2; s: string }> = []; // posted to the writer thread, not yet acknowledged (FIFO)
  let lastAckAt = Date.now();
  try {
    worker = new Worker(WRITER_SRC, { eval: true });
    worker.unref(); // must never keep the process alive on its own
    worker.on("message", () => { pending.shift(); stats.outstanding = pending.length; lastAckAt = Date.now(); });
    worker.on("error", () => { stats.writerDead = true; });
    worker.on("exit", () => { stats.writerDead = true; });
  } catch { stats.writerDead = true; }

  const toFile = (s: string): void => {
    if (Date.now() >= rollAt) { // local midnight → a new day's file
      try { file?.end(); } catch { /* ignore */ }
      file = openLogFile(); rollAt = nextMidnightMs(); capNoted = false;
    }
    if (!file) return;
    if (stats.fileBytes >= MAX_FILE_BYTES) {
      if (!capNoted) { capNoted = true; file.write(`[safe-stdio] daily log cap (${MAX_FILE_BYTES / 1048576} MB) reached — file logging paused until midnight\n`); }
      return;
    }
    if (file.writableLength >= MAX_FILE_BACKLOG_BYTES) return;
    stats.fileBytes += Buffer.byteLength(s);
    file.write(s);
  };

  let lastDropNoteAt = 0;
  const patch = (stream: NodeJS.WriteStream, fd: 1 | 2): void => {
    (stream as any).write = (chunk: unknown, encOrCb?: unknown, cb?: unknown): boolean => {
      let s: string;
      try { s = typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk); }
      catch { s = ""; }
      if (s) {
        s = redactSecrets(s);
        toFile(s);
        if (worker && !stats.writerDead && pending.length < MAX_BACKLOG) {
          pending.push({ fd, s });
          stats.outstanding = pending.length;
          try { worker.postMessage({ fd, s }); } catch { pending.pop(); stats.writerDead = true; }
        } else {
          stats.dropped++;
          const now = Date.now();
          if (now - lastDropNoteAt > 60_000) {
            lastDropNoteAt = now;
            toFile(`[safe-stdio] console reader is not draining — ${stats.dropped} console chunk(s) dropped so far (this file keeps the full log; the server keeps running)\n`);
          }
        }
      }
      const done = typeof encOrCb === "function" ? encOrCb : typeof cb === "function" ? cb : null;
      if (done) { try { (done as () => void)(); } catch { /* caller's callback */ } }
      return true;
    };
  };
  patch(process.stdout, 1);
  patch(process.stderr, 2);

  // LAST WORDS — see header. Synchronous on purpose: 'exit' handlers cannot await.
  process.on("exit", (code) => {
    try {
      if (!pending.length) return;
      const text = pending.map(p => p.s).join("");
      if (stats.logFile) { try { fs.appendFileSync(stats.logFile, `[safe-stdio] exit(${code}) — ${pending.length} chunk(s) the console writer had not confirmed:\n${text}`); } catch { /* best-effort */ } }
      const readerAlive = pending.length <= EXIT_CONSOLE_MAX_PENDING && Date.now() - lastAckAt < EXIT_CONSOLE_ACK_FRESH_MS;
      if (readerAlive) { for (const p of pending) { try { fs.writeSync(p.fd, p.s); } catch { break; } } }
    } catch { /* never throw from an exit hook */ }
  });

  console.log(`[safe-stdio] console writes moved off the main thread (writer thread + ${stats.logFile ? `file log ${stats.logFile}` : "no file log"}) — an undrained launcher pipe can no longer freeze the server`);
}

installSafeStdio();
