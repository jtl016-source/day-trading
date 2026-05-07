/**
 * Discord reader — polls an entire guild via Discord REST API (user token).
 * Integrates with discord-parser.ts for NLP signal extraction and
 * discord-learner.ts for author track-record gating before auto-execution.
 */

import { db } from "./db";
import { discordMessages, discordSignals } from "@shared/schema";
import { eq, desc } from "drizzle-orm";
import { broadcast, broadcastOrderCommand } from "./live-bars";
import { parseDiscordMessage, updateContext, type ParsedSignal } from "./discord-parser";
import { learner } from "./discord-learner";
import { parseZonesFromMessage } from "./discord-zone-parser";

export interface ChannelConfig {
  id:               string;
  name:             string;
  position:         number;
  categoryId:       string | null;
  categoryName:     string | null;
  categoryPosition: number;
}

let _token      = "";
let _guildId    = "";
let _guildName  = "";
let _channels:  ChannelConfig[] = [];
let _running    = false;
let _timer:     ReturnType<typeof setTimeout> | null = null;
const _lastSeen: Record<string, string> = {};

// Auto-execution toggle — off by default, enabled via /api/discord-reader/auto-trade
let _autoTrade = false;
export function setAutoTrade(v: boolean) { _autoTrade = v; }
export function getAutoTrade()           { return _autoTrade; }

const POLL_MS = 30_000;
const DISCORD = "https://discord.com/api/v9";

// ── Discord API ───────────────────────────────────────────────────────────

async function discordGet(path: string): Promise<any> {
  const resp = await fetch(`${DISCORD}${path}`, { headers: { Authorization: _token } });
  if (!resp.ok) throw new Error(`Discord ${path}: HTTP ${resp.status}`);
  return resp.json();
}

async function fetchGuildInfo(guildId: string): Promise<{ name: string }> {
  return discordGet(`/guilds/${guildId}`);
}

async function fetchGuildChannels(guildId: string): Promise<ChannelConfig[]> {
  const all: any[] = await discordGet(`/guilds/${guildId}/channels`);
  const cats = new Map<string, { name: string; position: number }>();
  for (const ch of all) {
    if (ch.type === 4) cats.set(ch.id as string, { name: ch.name as string, position: ch.position ?? 0 });
  }
  return all
    .filter(ch => ch.type === 0 || ch.type === 5)
    .map(ch => {
      const cat = ch.parent_id ? cats.get(ch.parent_id) : undefined;
      return {
        id:               ch.id   as string,
        name:             ch.name as string,
        position:         ch.position ?? 0,
        categoryId:       ch.parent_id ?? null,
        categoryName:     cat?.name ?? null,
        categoryPosition: cat?.position ?? 999,
      };
    })
    .sort((a, b) =>
      a.categoryPosition !== b.categoryPosition
        ? a.categoryPosition - b.categoryPosition
        : a.position - b.position
    );
}

// ── Signal persistence ────────────────────────────────────────────────────

async function saveSignal(messageId: string, sig: ParsedSignal): Promise<number | null> {
  try {
    const result = db.$client.prepare(`
      INSERT INTO discord_signals
        (message_id, author, channel, symbol, direction, entry_price, tp1, tp2, tp3, sl,
         confidence, executed, raw_text, historical)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?,?)
    `).run(
      messageId, sig.author, sig.channel, sig.symbol, sig.direction,
      sig.entryPrice, sig.tp1, sig.tp2, sig.tp3, sig.sl,
      sig.confidence, sig.raw, sig.historical ? 1 : 0,
    );
    return result.lastInsertRowid as number;
  } catch { return null; }
}

function saveZones(messageId: string, channelName: string, authorName: string, postedAt: number, content: string) {
  const zones = parseZonesFromMessage({ messageId, text: content, authorName, channelName, postedAt });
  for (const z of zones) {
    try {
      db.$client.prepare(`
        INSERT OR IGNORE INTO discord_zones
          (message_id, channel_name, author_name, posted_at, zone_type, label_raw, top, bottom, is_bull, symbol, raw)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        z.messageId, z.channelName, z.authorName, z.postedAt,
        z.zoneType, z.labelRaw, z.top, z.bottom, z.isBull ? 1 : 0, z.symbol, z.raw,
      );
    } catch {}
  }
}

async function checkOpenTrade(symbol: string): Promise<boolean> {
  try {
    const rows = db.$client.prepare(
      `SELECT id FROM discord_signals WHERE symbol=? AND executed=1 AND outcome IS NULL LIMIT 1`
    ).all(symbol) as any[];
    return rows.length > 0;
  } catch { return false; }
}

// ── Auto-execution ────────────────────────────────────────────────────────

async function maybeExecute(sig: ParsedSignal, signalId: number) {
  if (!_autoTrade || sig.historical) return;
  if (!sig.sl && !sig.tp1) return; // need at least TP or SL to risk-manage

  // Rule d: already in a trade on this symbol
  if (await checkOpenTrade(sig.symbol)) {
    console.log(`[discord-parser] veto — already in open trade on ${sig.symbol}`);
    return;
  }

  const veto = learner.shouldExecute(sig);
  if (!veto.execute) {
    console.log(`[discord-parser] veto — ${veto.reason}`);
    return;
  }

  const sent = broadcastOrderCommand({
    type:           "order_command",
    symbol:         sig.symbol,
    direction:      sig.direction,
    interval:       "discord",
    riskLevel:      sig.confidence,
    price:          sig.entryPrice ?? 0,
    tp1:            sig.tp1   ?? (sig.sl ? Math.abs((sig.entryPrice ?? 0) - sig.sl) * 2 + (sig.entryPrice ?? 0) : 0),
    tp2:            sig.tp2   ?? 0,
    sl:             sig.sl    ?? 0,
    contracts:      1,
    tp1Only:        !sig.tp2,
    useTrailer:     false,
    trailingOffset: 2,
    discordSignalId: signalId,
  });

  if (sent) {
    db.$client.prepare(`UPDATE discord_signals SET executed=1 WHERE id=?`).run(signalId);
    console.log(`[discord-parser] executed ${sig.direction} ${sig.symbol} from @${sig.author} (${sig.confidence})`);
  }
}

// ── Message processing ────────────────────────────────────────────────────

async function processMessage(
  m: { id: string; author?: any; content?: string; timestamp: string; attachments?: any[]; embeds?: any[] },
  ch: ChannelConfig,
  historical: boolean,
) {
  const content = (m.content ?? "").trim();
  if (!content) return;

  const postedAt = Math.floor(new Date(m.timestamp).getTime() / 1000);

  // Update context BEFORE parsing (so rawContext = messages before this one)
  const ctx = content; // will be added after parse to not self-include

  // Parse signal attempt
  const sig = parseDiscordMessage({
    text:       content,
    author:     m.author?.username ?? "unknown",
    channel:    ch.name,
    timestamp:  postedAt,
    historical,
  });

  // Now update context (after parse, so it's available for the NEXT message)
  updateContext(ch.name, content);

  // Persist raw message
  const row = {
    messageId:   m.id,
    channelId:   ch.id,
    channelName: ch.name,
    authorName:  (m.author?.username ?? "unknown") as string,
    authorId:    (m.author?.id ?? "0") as string,
    content,
    postedAt,
    attachments: m.attachments?.length
      ? JSON.stringify(m.attachments.map((a: any) => ({
          url:         a.url         ?? a,
          filename:    a.filename,
          contentType: a.content_type,
          size:        a.size,
          width:       a.width,
          height:      a.height,
        })))
      : null,
    embeds: m.embeds?.length ? JSON.stringify(m.embeds) : null,
    savedAt:    new Date().toISOString(),
    hasSignal:  sig ? 1 : 0,
    historical: historical ? 1 : 0,
  };
  try { await db.insert(discordMessages).values(row).onConflictDoNothing(); } catch {}

  // Parse + persist zone levels from every message (professional Discord zones)
  saveZones(m.id, ch.name, (m.author?.username ?? "unknown"), postedAt, content);

  // Persist signal + maybe execute
  if (sig) {
    const sigId = await saveSignal(m.id, sig);
    if (sigId !== null && !historical) {
      broadcast({ type: "discord_signal", signal: { ...sig, id: sigId } });
      await maybeExecute(sig, sigId);
    }
  }

  // Broadcast raw message to feed UI
  if (!historical) broadcast({ type: "discord_message", message: row });
}

// ── Live polling ──────────────────────────────────────────────────────────

async function pollChannel(ch: ChannelConfig) {
  const after = _lastSeen[ch.id];
  let msgs: any[];
  try {
    msgs = await discordGet(`/channels/${ch.id}/messages?limit=50${after ? `&after=${after}` : ""}`);
  } catch (e: any) {
    if (!e.message.includes("403")) console.warn(`[discord-reader] ${ch.name}: ${e.message}`);
    return;
  }
  if (!msgs.length) return;
  msgs.sort((a, b) => (a.id > b.id ? 1 : -1));
  for (const m of msgs) await processMessage(m, ch, false);
  _lastSeen[ch.id] = msgs[msgs.length - 1].id;
}

async function pollOnce() {
  if (!_token || !_channels.length) return;
  for (const ch of _channels) {
    await pollChannel(ch).catch(() => {});
    await new Promise(r => setTimeout(r, 150));
  }
}

// ── Historical back-read ──────────────────────────────────────────────────

// Lightweight startup backread: fetch the newest 200 messages and stop.
// This ensures the feed is populated quickly on server start.
async function backReadChannel(ch: ChannelConfig) {
  const msgs: any[] = [];
  try {
    const b1: any[] = await discordGet(`/channels/${ch.id}/messages?limit=100`);
    if (!Array.isArray(b1)) return;
    msgs.push(...b1);
    if (b1.length === 100) {
      const oldest = b1[b1.length - 1].id;
      const b2: any[] = await discordGet(`/channels/${ch.id}/messages?limit=100&before=${oldest}`);
      if (Array.isArray(b2)) msgs.push(...b2);
    }
  } catch { return; }

  msgs.sort((a, b) => (a.id < b.id ? -1 : 1));
  for (const m of msgs) {
    await processMessage(m, ch, true);
    await new Promise(r => setTimeout(r, 50));
  }
}

async function backReadAll() {
  console.log(`[discord-reader] back-reading last 200 msgs from ${_channels.length} channels…`);
  for (const ch of _channels) {
    await backReadChannel(ch).catch(() => {});
    await new Promise(r => setTimeout(r, 300));
  }
  console.log("[discord-reader] back-read complete");
}

// Deep full history: starts from the oldest message already in DB and paginates further back.
// Called from /api/discord-reader/full-history endpoint. Runs in the background.
export async function deepBackReadAll(): Promise<{ channels: number; messagesProcessed: number }> {
  if (!_running || !_channels.length) {
    console.warn("[discord-reader] deepBackReadAll: reader not running");
    return { channels: 0, messagesProcessed: 0 };
  }
  let total = 0;
  for (const ch of _channels) {
    try {
      // Start before the oldest message we already have — this fetches strictly older content
      const oldestRow = db.$client.prepare(
        `SELECT message_id FROM discord_messages WHERE channel_id = ? ORDER BY posted_at ASC LIMIT 1`,
      ).get(ch.id) as any;
      let before: string | null = oldestRow?.message_id ?? null;
      let pages = 0;

      while (true) {
        const qs = before ? `?limit=100&before=${before}` : `?limit=100`;
        let page: any[];
        try {
          page = await discordGet(`/channels/${ch.id}/messages${qs}`);
        } catch { break; }
        if (!Array.isArray(page) || page.length === 0) break;

        // Deduplicate just in case (first fetch without `before` may overlap)
        const ids: string[] = page.map((m: any) => m.id);
        const existingSet = new Set<string>(
          (db.$client.prepare(
            `SELECT message_id FROM discord_messages WHERE message_id IN (${ids.map(() => "?").join(",")})`,
          ).all(...ids) as any[]).map((r: any) => r.message_id),
        );
        const newMsgs = page.filter((m: any) => !existingSet.has(m.id));
        newMsgs.sort((a: any, b: any) => (a.id < b.id ? -1 : 1)); // oldest → newest
        for (const m of newMsgs) {
          await processMessage(m, ch, true);
          await new Promise(r => setTimeout(r, 30));
        }
        total += newMsgs.length;
        if (newMsgs.length > 0) pages++;

        if (page.length < 100) break; // reached channel beginning

        // Oldest message in this page becomes the new `before` cursor
        const sorted = [...page].sort((a: any, b: any) => (a.id < b.id ? -1 : 1));
        before = sorted[0].id;
        await new Promise(r => setTimeout(r, 400)); // rate-limit guard
      }

      console.log(`[discord-reader] deep backread ${ch.name}: ${pages} pages, ${total} total new msgs`);
      await new Promise(r => setTimeout(r, 500));
    } catch (e: any) {
      console.error(`[discord-reader] deep backread error in ${ch.name}:`, e.message);
    }
  }
  console.log(`[discord-reader] deep backread complete — ${total} new messages`);
  return { channels: _channels.length, messagesProcessed: total };
}

// Re-parse zones from ALL stored Discord messages (idempotent — uses INSERT OR IGNORE).
export function reparseAllZones(): number {
  const rows = db.$client.prepare(
    `SELECT message_id, channel_name, author_name, posted_at, content FROM discord_messages ORDER BY posted_at ASC`,
  ).all() as any[];
  let count = 0;
  for (const row of rows) {
    const zones = parseZonesFromMessage({
      messageId:   row.message_id,
      text:        row.content,
      authorName:  row.author_name,
      channelName: row.channel_name ?? "",
      postedAt:    row.posted_at,
    });
    for (const z of zones) {
      try {
        db.$client.prepare(`
          INSERT OR IGNORE INTO discord_zones
            (message_id, channel_name, author_name, posted_at, zone_type, label_raw, top, bottom, is_bull, symbol, raw)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)
        `).run(
          z.messageId, z.channelName, z.authorName, z.postedAt,
          z.zoneType, z.labelRaw, z.top, z.bottom, z.isBull ? 1 : 0, z.symbol, z.raw,
        );
        count++;
      } catch {}
    }
  }
  return count;
}

// ── Init ──────────────────────────────────────────────────────────────────

async function initLastSeen() {
  for (const ch of _channels) {
    try {
      const [row] = await db
        .select({ messageId: discordMessages.messageId })
        .from(discordMessages)
        .where(eq(discordMessages.channelId, ch.id))
        .orderBy(desc(discordMessages.postedAt))
        .limit(1);
      if (row) _lastSeen[ch.id] = row.messageId;
    } catch {}
  }
}

function schedulePoll() {
  if (_timer) clearTimeout(_timer);
  _timer = setTimeout(async () => {
    await pollOnce().catch(() => {});
    if (_running) schedulePoll();
  }, POLL_MS);
}

// ── Public API ─────────────────────────────────────────────────────────────

export async function startDiscordReader(token: string, guildId: string) {
  stopDiscordReader();
  _token   = token;
  _guildId = guildId;
  _running = true;

  try {
    const info = await fetchGuildInfo(guildId);
    _guildName = info.name ?? guildId;
  } catch { _guildName = guildId; }

  try {
    _channels = await fetchGuildChannels(guildId);
    console.log(`[discord-reader] "${_guildName}" — found ${_channels.length} text channels`);
  } catch (e: any) {
    console.error(`[discord-reader] failed to fetch channels: ${e.message}`);
    _running = false;
    throw e;
  }

  await initLastSeen();
  await learner.load();

  // Fire background tasks — don't block caller
  pollOnce().catch(() => {});
  backReadAll().catch(() => {});
  schedulePoll();
}

export function stopDiscordReader() {
  _running   = false;
  _token     = "";
  _guildId   = "";
  _guildName = "";
  _channels  = [];
  if (_timer) { clearTimeout(_timer); _timer = null; }
}

export function getDiscordReaderStatus(): {
  running:   boolean;
  guildId:   string;
  guildName: string;
  channels:  ChannelConfig[];
} {
  return { running: _running, guildId: _guildId, guildName: _guildName, channels: [..._channels] };
}
