import fs from "fs";
import path from "path";
import crypto from "crypto";

const STRATEGIES_DIR = path.join(process.cwd(), "strategies");

export interface StrategyMeta {
  id: string;
  name: string;
  version: string;
  description: string;
  updatedAt: string;
  [key: string]: unknown;
}

interface GuardEntry {
  id: string;
  filePath: string;
  hash: string;
  meta: StrategyMeta;
}

class StrategyGuard {
  private entries: Map<string, GuardEntry> = new Map();
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private violations: string[] = [];

  async init(): Promise<void> {
    this.entries.clear();
    this.violations = [];

    if (!fs.existsSync(STRATEGIES_DIR)) {
      console.warn("[strategy-guard] strategies/ directory not found — guard inactive");
      return;
    }

    const stratDirs = fs.readdirSync(STRATEGIES_DIR).filter((d) =>
      fs.statSync(path.join(STRATEGIES_DIR, d)).isDirectory()
    );

    for (const dir of stratDirs) {
      // CANDLE-SPEC: widened from "strategy.json" only to all *.json files per subdirectory
      const dirPath = path.join(STRATEGIES_DIR, dir); // CANDLE-SPEC:
      const jsonFiles = fs.readdirSync(dirPath).filter((f) => f.endsWith(".json")); // CANDLE-SPEC:
      for (const jsonFile of jsonFiles) { // CANDLE-SPEC:
        const jsonPath = path.join(STRATEGIES_DIR, dir, jsonFile); // CANDLE-SPEC:
        try {
          const raw = fs.readFileSync(jsonPath, "utf8");
          const meta: StrategyMeta = JSON.parse(raw);
          const hash = this.hashContent(raw);
          this.entries.set(meta.id ?? dir, { id: meta.id ?? dir, filePath: jsonPath, hash, meta });
          console.log(`[strategy-guard] Loaded strategy: ${meta.id} v${meta.version}`);
        } catch (err) {
          console.error(`[strategy-guard] Failed to load ${jsonPath}:`, err);
        }
      } // CANDLE-SPEC:
    }

    console.log(`[strategy-guard] Guarding ${this.entries.size} strategies`);
    this.startIntegrityCheck();
  }

  private startIntegrityCheck(): void {
    if (this.intervalHandle) clearInterval(this.intervalHandle);
    this.intervalHandle = setInterval(() => this.verifyAll(), 60_000);
  }

  verifyAll(): { ok: boolean; violations: string[] } {
    const newViolations: string[] = [];
    for (const [id, entry] of this.entries) {
      try {
        const raw = fs.readFileSync(entry.filePath, "utf8");
        const currentHash = this.hashContent(raw);
        if (currentHash !== entry.hash) {
          newViolations.push(`Strategy "${id}" was modified outside of authorized update`);
          console.warn(`[strategy-guard] INTEGRITY VIOLATION: ${id}`);
        }
      } catch {
        newViolations.push(`Strategy "${id}" file is missing or unreadable`);
      }
    }
    this.violations = newViolations;
    return { ok: newViolations.length === 0, violations: newViolations };
  }

  getAll(): StrategyMeta[] {
    return Array.from(this.entries.values()).map((e) => e.meta);
  }

  getById(id: string): StrategyMeta | undefined {
    return this.entries.get(id)?.meta;
  }

  authorizedUpdate(id: string, newJson: unknown): { ok: boolean; error?: string } {
    const entry = this.entries.get(id);
    if (!entry) return { ok: false, error: `Unknown strategy id: ${id}` };

    let raw: string;
    try {
      raw = JSON.stringify(newJson, null, 2);
      JSON.parse(raw); // validate parseable
    } catch {
      return { ok: false, error: "Invalid JSON" };
    }

    try {
      fs.writeFileSync(entry.filePath, raw, "utf8");
      const meta: StrategyMeta = JSON.parse(raw);
      const hash = this.hashContent(raw);
      this.entries.set(id, { ...entry, hash, meta });
      console.log(`[strategy-guard] Authorized update applied to strategy: ${id}`);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  getStatus(): { guarding: number; violations: string[] } {
    return { guarding: this.entries.size, violations: this.violations };
  }

  private hashContent(content: string): string {
    return crypto.createHash("sha256").update(content, "utf8").digest("hex");
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }
}

export const strategyGuard = new StrategyGuard();
