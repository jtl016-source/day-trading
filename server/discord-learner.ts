/**
 * discord-learner.ts — tracks author and channel win rates from resolved
 * discord_signals rows, and gates auto-execution with shouldExecute().
 */

import { db } from "./db";
import { discordSignals } from "@shared/schema";
import { isNotNull } from "drizzle-orm";
import type { ParsedSignal } from "./discord-parser";

// ── Types ──────────────────────────────────────────────────────────────────

export interface AuthorStat {
  total:          number;
  wins:           number;
  losses:         number;
  winRate:        number;
  avgRR:          number;
  symbolAccuracy: Map<string, { wins: number; total: number }>;
}

export interface ChannelStat {
  wins:    number;
  total:   number;
  winRate: number;
}

// ── Outcome helpers ────────────────────────────────────────────────────────

function isWin(outcome: string): boolean {
  return outcome === "tp1_hit" || outcome === "tp2_hit" || outcome === "tp3_hit";
}

function isLoss(outcome: string): boolean {
  return outcome === "sl_hit";
}

// ── Class ──────────────────────────────────────────────────────────────────

export class DiscordLearner {
  authorStats  = new Map<string, AuthorStat>();
  channelStats = new Map<string, ChannelStat>();

  async load() {
    try {
      const rows = await db.select().from(discordSignals).where(isNotNull(discordSignals.outcome));
      this._recompute(rows as Array<{ author: string; channel: string; symbol: string; outcome: string | null }>);
      console.log(`[discord-learner] loaded ${rows.length} resolved signals`);
    } catch (e: any) {
      console.warn("[discord-learner] load error:", e.message);
    }
  }

  private _recompute(rows: Array<{ author: string; channel: string; symbol: string; outcome: string | null }>) {
    this.authorStats.clear();
    this.channelStats.clear();

    for (const row of rows) {
      if (!row.outcome) continue;
      const win  = isWin(row.outcome);
      const loss = isLoss(row.outcome);
      if (!win && !loss) continue; // manual_close etc — skip from stats

      // Author stats
      if (!this.authorStats.has(row.author)) {
        this.authorStats.set(row.author, {
          total: 0, wins: 0, losses: 0, winRate: 0, avgRR: 0,
          symbolAccuracy: new Map(),
        });
      }
      const as = this.authorStats.get(row.author)!;
      as.total++;
      if (win) as.wins++;
      if (loss) as.losses++;
      as.winRate = as.wins / as.total;

      // Per-symbol accuracy for this author
      if (!as.symbolAccuracy.has(row.symbol)) as.symbolAccuracy.set(row.symbol, { wins: 0, total: 0 });
      const sa = as.symbolAccuracy.get(row.symbol)!;
      sa.total++;
      if (win) sa.wins++;

      // Channel stats
      if (!this.channelStats.has(row.channel)) {
        this.channelStats.set(row.channel, { wins: 0, total: 0, winRate: 0 });
      }
      const cs = this.channelStats.get(row.channel)!;
      cs.total++;
      if (win) cs.wins++;
      cs.winRate = cs.wins / cs.total;
    }
  }

  /** Call after any outcome is written to DB — reloads from DB to stay consistent. */
  async onOutcome() {
    await this.load();
  }

  shouldExecute(signal: ParsedSignal): { execute: boolean; reason: string } {
    const author = this.authorStats.get(signal.author);

    // Rule a: author win rate < 40% with at least 10 resolved trades → veto
    if (author && author.total >= 10 && author.winRate < 0.40) {
      return { execute: false, reason: "author win rate too low" };
    }

    // Rule b: author win rate >= 65% with at least 5 trades → boost confidence
    if (author && author.total >= 5 && author.winRate >= 0.65) {
      signal.confidence = "high";
    }

    // Rule c: medium confidence + new/unproven author → veto
    if (signal.confidence === "medium" && (!author || author.total < 5)) {
      return { execute: false, reason: "new author, medium confidence only — waiting for track record" };
    }

    return { execute: true, reason: "ok" };
  }

  /** Summary for the /api/discord-reader/stats endpoint */
  summary() {
    const authors: Record<string, { total: number; wins: number; winRate: number }> = {};
    for (const [name, s] of this.authorStats) {
      authors[name] = { total: s.total, wins: s.wins, winRate: s.winRate };
    }
    const channels: Record<string, { total: number; wins: number; winRate: number }> = {};
    for (const [name, s] of this.channelStats) {
      channels[name] = { total: s.total, wins: s.wins, winRate: s.winRate };
    }
    return { authors, channels };
  }
}

export const learner = new DiscordLearner();
