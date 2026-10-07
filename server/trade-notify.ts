/**
 * Server-side TRADE-EVENT notifications (2026-08-04).
 *
 * Until now, real-time trade alerts were CLIENT-triggered (a browser tab had to be open,
 * foregrounded, and evaluating to POST /api/discord/send) — no tab meant no alert, and a
 * throttled background tab meant a late one. The server itself hears every AutoTrader study
 * event on /ws/order-commands (order_ack, bracket_flattened, stop_reduced, position_closed,
 * order_error), so the alerts now originate HERE: instant, tab-independent, delivered to BOTH
 * Expo push (persisted tokens) and Discord (retrying send). Fire-and-forget with error logs —
 * a notification failure must never affect order handling.
 *
 * Dedupe: multiple AutoTrader instances can echo the same event; identical messages within
 * 5s collapse to one send.
 */
import { sendPushNotifications } from "./trade-state";
import { sendDiscordMessage, discordConfigured } from "./discord-notify";

const recent = new Map<string, number>();

const fmt = (n: unknown): string => {
  const v = Number(n);
  return Number.isFinite(v) ? v.toFixed(2) : "?";
};

/** Format a study/order event into a human alert, or null for non-alert message types. */
export function tradeEventMessage(msg: any): { title: string; body: string } | null {
  switch (msg?.type) {
    case "order_ack":
      return {
        title: `🔫 Fired ${msg.direction ?? "?"} ${Number.isFinite(Number(msg.qty)) ? msg.qty + " " : ""}MES`,
        body: `entry ${fmt(msg.entry)} · TP1 ${fmt(msg.tp1)} · SL ${fmt(msg.sl)}${msg.useTrailer ? " · trailer" : ""}`,
      };
    case "bracket_flattened": {
      const why = msg.reason === "sl_filled" ? "SL hit"
        : msg.reason === "tp_filled" ? "TP hit"
        : msg.reason === "trailer_exit" ? "trailer exit"
        : String(msg.reason ?? "exit");
      const rem = Number(msg.remaining_brackets);
      return {
        title: `✅ Bracket closed — ${why}`,
        body: `${msg.entry != null ? `entry ${fmt(msg.entry)} · ` : ""}sibling orders cancelled${Number.isFinite(rem) ? ` · ${rem} bracket(s) still open` : ""}`,
      };
    }
    case "stop_reduced":
      return { title: "✂️ Stop resized", body: `stop now covers ${msg.qty ?? "?"} contract(s) after a partial take-profit` };
    case "position_closed":
      return { title: "🏁 Position closed", body: "remaining bracket orders cancelled" };
    case "order_error":
      return { title: "🚨 AutoTrader ORDER ERROR", body: String(msg.error ?? "unknown — check MotiveWave") };
    // CONTRACT GUARD (2026-09-17): MW chart on a different contract month than Yahoo's front month.
    case "contract_guard": {
      const d = typeof msg.delta === "number" ? `${msg.delta > 0 ? "+" : ""}${msg.delta.toFixed(2)} pts` : "?";
      return msg.offContract
        ? { title: "🚨 CONTRACT MISMATCH — orders blocked", body: `MotiveWave ${msg.mw ?? "?"} vs Yahoo front month ${msg.yahoo ?? "?"} (Δ ${d}). MW feed quarantined, Yahoo driving the chart. Roll the MotiveWave chart to the front month.` }
        : { title: "✅ Contract match restored", body: `MotiveWave back on the front month (Δ ${d}) — MW feed + auto-trade orders resumed` };
    }
    case "contract_guard_mixed":
      return msg.mixed
        ? { title: "🚨 MotiveWave charts on MIXED contract months — orders blocked", body: `Tick relays are on ${msg.codes ?? "two months"} at once. MW is ignored and the chart runs on Yahoo's 10-min-delayed feed. Roll EVERY MotiveWave chart (incl. the AutoTrader chart) to the same front month.` }
        : { title: "✅ MotiveWave charts agree again", body: `All tick relays are on ${msg.codes ?? "one month"} — mixed-month quarantine lifted.` };
    // WRONG-BASIS FREEZE (2026-09-18): tracked brackets that lived through a contract mismatch.
    case "basis_suspect":
      return { title: "⚠️ Tracked trade(s) frozen — contract mismatch", body: `${msg.count ?? "Some"} open tracked trade(s) were priced on a different contract month than the data feed; their TP/SL will NOT be inferred from price. They keep gating new orders until MotiveWave reports them closed — or clear them from Settings once you are flat.` };
    // IBKR BRIDGE (2026-09-23): gateway/contract-roll/market-data notices carry their own text.
    case "ibkr_bridge":
      return msg.title ? { title: String(msg.title), body: String(msg.body ?? "") } : null;
    default:
      return null;
  }
}

export function notifyTradeEvent(msg: any): void {
  const m = tradeEventMessage(msg);
  if (!m) return;
  const key = `${m.title}|${m.body}`;
  const now = Date.now();
  if (now - (recent.get(key) ?? 0) < 5000) return;
  recent.set(key, now);
  if (recent.size > 50) for (const [k, t] of recent) if (now - t > 60_000) recent.delete(k);

  void sendPushNotifications({ title: m.title, body: m.body, data: { type: String(msg?.type ?? "") } });
  if (discordConfigured()) {
    void sendDiscordMessage(`${m.title} — ${m.body}`).then(r => {
      if (!r.ok) console.error(`[trade-notify] discord send failed: ${r.error}`);
    });
  }
}
