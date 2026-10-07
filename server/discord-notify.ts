/**
 * Server-originated Discord messages (SCHEDULER 2026-08-02).
 *
 * The existing POST /api/discord/send route is a client-triggered signal-alert formatter with a
 * module-private webhook cache inside routes.ts. Server-side jobs (daily health digest, weekly
 * regen report) need a plain "send this text" primitive — this module reads the SAME stored
 * webhook (app_settings key 'discord_webhook', the one the Settings UI saves) on every send, so
 * a webhook change through the UI is picked up without a restart.
 *
 * Discord hard-limits messages to 2000 chars — long content is split on line boundaries into
 * sequential webhook posts (digests stay compact by design; the split is a safety net).
 */
import { db } from "./db";

function storedWebhook(): string {
  try {
    const row = db.$client
      .prepare(`SELECT value FROM app_settings WHERE key='discord_webhook'`)
      .get() as { value?: string } | undefined;
    return (row?.value ?? "").trim();
  } catch {
    return "";
  }
}

export function discordConfigured(): boolean {
  return storedWebhook().length > 0;
}

export async function sendDiscordMessage(content: string): Promise<{ ok: boolean; error?: string }> {
  const webhook = storedWebhook();
  if (!webhook) return { ok: false, error: "no discord_webhook configured in app_settings" };

  // Chunk on line boundaries under the 2000-char limit (1900 leaves headroom for safety).
  const chunks: string[] = [];
  let cur = "";
  for (const line of content.split("\n")) {
    if (cur && (cur.length + 1 + line.length) > 1900) { chunks.push(cur); cur = line; }
    else cur = cur ? `${cur}\n${line}` : line;
  }
  if (cur) chunks.push(cur);

  // RETRY (2026-08-04): a single transient 429/5xx or network blip used to silently drop the
  // message ("notifications sometimes don't show"). 3 attempts per chunk; 429 honors
  // retry_after when Discord provides it, otherwise 1s→3s backoff.
  const sleep = (ms: number) => new Promise<void>(res => setTimeout(res, ms));
  try {
    for (const c of chunks) {
      let lastErr = "";
      let sent = false;
      for (let attempt = 0; attempt < 3 && !sent; attempt++) {
        try {
          const r = await fetch(webhook, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: c }),
          });
          if (r.ok) { sent = true; break; }
          lastErr = `Discord returned ${r.status}`;
          if (r.status === 429) {
            const j: any = await r.json().catch(() => null);
            const waitMs = Number(j?.retry_after) * 1000;
            await sleep(Number.isFinite(waitMs) && waitMs > 0 ? Math.min(waitMs, 10_000) : 1000 * (attempt + 1));
          } else if (r.status >= 500) {
            await sleep(1000 * (2 * attempt + 1));
          } else {
            break; // 4xx other than 429 — retrying won't help (bad webhook, too long, etc.)
          }
        } catch (err: any) {
          lastErr = err?.message ?? String(err);
          await sleep(1000 * (2 * attempt + 1));
        }
      }
      if (!sent) return { ok: false, error: lastErr || "send failed after retries" };
    }
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}
