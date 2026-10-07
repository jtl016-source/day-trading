// scripts/safe-stdio.test.ts
// ─────────────────────────────────────────────────────────────────────────────
// Reproduces the 2026-09-18 outage and proves server/safe-stdio.ts prevents it.
// NO test framework — plain asserts, run with:
//   npx tsx scripts/safe-stdio.test.ts   (exit 0 = all pass; takes ~15 s)
//
// A child process logs heavily to a stdout PIPE that this parent NEVER reads (exactly what a
// dead launcher / ended preview session does) and beats a heartbeat file from a timer. On
// Windows a plain child wedges inside console.log within a second (pipe full, synchronous
// write) and its heartbeat stops; with safe-stdio the heartbeat keeps beating.
// ─────────────────────────────────────────────────────────────────────────────
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let pass = 0; const failures: string[] = [];
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { failures.push(name); console.error(`FAIL  ${name}`); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "safe-stdio-"));
const REPO = process.cwd().replace(/\\/g, "/");

function childSource(safe: boolean, beatFile: string): string {
  return `
    ${safe ? `process.env.BAXTER_ARTIFACTS_DIR = ${JSON.stringify(tmp)}; await import(${JSON.stringify("file:///" + REPO + "/server/safe-stdio.ts")});` : ""}
    const fs = await import("node:fs");
    let n = 0;
    setInterval(() => { fs.writeFileSync(${JSON.stringify(beatFile)}, String(Date.now())); }, 100);
    setInterval(() => { for (let i = 0; i < 200; i++) console.log("line " + (n++) + " " + "x".repeat(200)); }, 50);
  `;
}

async function run(safe: boolean): Promise<{ beatAgeMs: number; alive: boolean }> {
  const beatFile = path.join(tmp, `beat-${safe ? "safe" : "plain"}.txt`);
  const script = path.join(tmp, `child-${safe ? "safe" : "plain"}.mts`);
  fs.writeFileSync(script, childSource(safe, beatFile));
  // stdout/stderr are PIPES we deliberately never read (no 'data' listeners, streams paused).
  const child = spawn(process.execPath, [...process.execArgv, script], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  child.stdout?.pause(); child.stderr?.pause();
  await new Promise(r => setTimeout(r, 6000));
  let beatAgeMs = Infinity;
  try { beatAgeMs = Date.now() - Number(fs.readFileSync(beatFile, "utf8")); } catch { /* never beat */ }
  const alive = child.exitCode == null;
  try { child.kill(); } catch { /* gone */ }
  if (process.platform === "win32" && child.pid) { try { spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }); } catch { /* best-effort */ } }
  return { beatAgeMs, alive };
}

async function main() {
  console.log("── undrained stdout pipe: plain child (control) ──");
  const plain = await run(false);
  console.log(`     heartbeat age ${plain.beatAgeMs} ms (alive=${plain.alive})`);
  if (process.platform === "win32") {
    assert(plain.beatAgeMs > 2000, "CONTROL: without safe-stdio the event loop wedges once the pipe fills (the 2026-09-18 outage)");
  } else {
    console.log("     (non-Windows: pipe writes are async here — control not asserted)");
  }

  console.log("── undrained stdout pipe: child with server/safe-stdio ──");
  const safe = await run(true);
  console.log(`     heartbeat age ${safe.beatAgeMs} ms (alive=${safe.alive})`);
  assert(safe.alive, "process still running");
  assert(safe.beatAgeMs < 1500, "event loop keeps beating with nobody reading stdout");
  const logs = fs.existsSync(path.join(tmp, "logs")) ? fs.readdirSync(path.join(tmp, "logs")) : [];
  assert(logs.some(f => /^server-\d{8}\.log$/.test(f)), "a local file log was written");
  const logText = logs.length ? fs.readFileSync(path.join(tmp, "logs", logs[0]), "utf8") : "";
  assert(logText.includes("line 0 "), "the file log holds the output the pipe could not take");

  console.log(`\n${pass} passed, ${failures.length} failed`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp dir cleanup is best-effort */ }
  process.exit(failures.length ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
