import { useState, useEffect, useRef } from "react";
import { Link } from "wouter";
import { ArrowLeft, MessageSquare, Eye, EyeOff, Hash, Download, FileText, Film } from "lucide-react";

// Trading vocabulary — highlighted gold in messages
const TRADING_KEYWORDS = [
  "IV WALL", "BUYER POSITIONING", "SELLER POSITIONING", "NON FAIR VALUE",
  "FAIR VALUE GAP", "FVG", "ORDER BLOCK", "STRUCTURAL", "IMBALANCE",
  "YELLOW BOX", "VECTOR", "CONFLUENCE", "KEY LEVEL", "DEMAND", "SUPPLY",
  "LIQUIDITY", "GAP FILL", "BREAKOUT", "BREAKDOWN", "REJECTION",
  "BULLISH", "BEARISH", "PIVOT", "SUPPORT", "RESISTANCE", "BIAS",
  "INVALIDATE", "SCALP", "SWING", "LONG", "SHORT",
];
const KW_RE = new RegExp(
  `(${TRADING_KEYWORDS.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`,
  "gi",
);
const URL_RE = /https?:\/\/[^\s<>"']+/g;

// ── Types ──────────────────────────────────────────────────────────────────

interface Channel {
  id: string; name: string; position: number;
  categoryId: string | null; categoryName: string | null; categoryPosition: number;
}
interface ServerStatus {
  running: boolean; guildId: string; guildName: string; channels: Channel[];
}
interface DiscordMsg {
  messageId: string; channelId: string; channelName: string | null;
  authorName: string; content: string; postedAt: number;
  attachments: string | null; embeds: string | null;
}
interface AttachmentObj {
  url: string; filename?: string; contentType?: string;
  size?: number; width?: number; height?: number;
}
interface EmbedObj {
  type?: string; title?: string; description?: string; url?: string; color?: number;
  image?: { url: string; width?: number; height?: number };
  thumbnail?: { url: string; width?: number; height?: number };
  video?: { url?: string; proxy_url?: string; width?: number; height?: number };
  provider?: { name?: string; url?: string };
  author?: { name?: string };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function parseAttachments(raw: string | null): AttachmentObj[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(item => typeof item === "string" ? { url: item } : item as AttachmentObj);
  } catch { return []; }
}

function parseEmbeds(raw: string | null): EmbedObj[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch { return []; }
}

function isImage(a: AttachmentObj): boolean {
  if (a.contentType?.startsWith("image/")) return true;
  return /\.(png|jpe?g|gif|webp|svg|avif)(\?|$)/i.test(a.url);
}
function isVideo(a: AttachmentObj): boolean {
  if (a.contentType?.startsWith("video/")) return true;
  return /\.(mp4|webm|mov|mkv)(\?|$)/i.test(a.url);
}

function fmtSize(bytes?: number): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// Renders text with URLs as clickable links and trading keywords highlighted
function renderContent(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let lastIndex = 0;
  URL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = URL_RE.exec(text)) !== null) {
    const before = text.slice(lastIndex, match.index);
    if (before) {
      before.split(KW_RE).forEach((part, i) => {
        nodes.push(
          TRADING_KEYWORDS.some(kw => kw.toLowerCase() === part.toLowerCase())
            ? <strong key={`kw-${key++}-${i}`} style={{ color: "#fbbf24", fontWeight: 700 }}>{part}</strong>
            : <span key={`t-${key++}-${i}`}>{part}</span>
        );
      });
    }
    const url = match[0];
    nodes.push(
      <a key={`url-${key++}`} href={url} target="_blank" rel="noopener noreferrer"
        style={{ color: "#00aff4", textDecoration: "none", wordBreak: "break-all" }}
        onMouseOver={e => (e.currentTarget.style.textDecoration = "underline")}
        onMouseOut={e => (e.currentTarget.style.textDecoration = "none")}>
        {url}
      </a>
    );
    lastIndex = match.index + url.length;
  }

  const tail = text.slice(lastIndex);
  if (tail) {
    tail.split(KW_RE).forEach((part, i) => {
      nodes.push(
        TRADING_KEYWORDS.some(kw => kw.toLowerCase() === part.toLowerCase())
          ? <strong key={`kw-${key++}-${i}`} style={{ color: "#fbbf24", fontWeight: 700 }}>{part}</strong>
          : <span key={`t-${key++}-${i}`}>{part}</span>
      );
    });
  }
  return nodes;
}

function relTime(ts: number): string {
  const d = Math.floor(Date.now() / 1000) - ts;
  if (d < 60) return `${d}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return new Date(ts * 1000).toLocaleDateString();
}

function groupByCategory(channels: Channel[]): Array<{ name: string | null; channels: Channel[] }> {
  const map = new Map<string, { name: string | null; pos: number; channels: Channel[] }>();
  for (const ch of channels) {
    const key = ch.categoryId ?? "__none__";
    if (!map.has(key)) map.set(key, { name: ch.categoryName, pos: ch.categoryPosition, channels: [] });
    map.get(key)!.channels.push(ch);
  }
  return [...map.values()]
    .sort((a, b) => a.pos - b.pos)
    .map(g => ({ name: g.name, channels: g.channels }));
}

// ── Theme ──────────────────────────────────────────────────────────────────

const T = {
  bg:       "#0f1117",
  sidebar:  "#16181f",
  panel:    "#1a1d27",
  bdr:      "#2a2d3a",
  text:     "#e2e8f0",
  muted:    "#64748b",
  accent:   "#3b82f6",
  dblue:    "#7289da",
  catText:  "#8e9297",
  chText:   "#96989d",
  chHover:  "#ffffff14",
  chActive: "#ffffff22",
};

// ── Main component ─────────────────────────────────────────────────────────

export default function DiscordFeedPage() {
  const [messages, setMessages]         = useState<DiscordMsg[]>([]);
  const [status, setStatus]             = useState<ServerStatus | null>(null);
  const [selectedCh, setSelectedCh]     = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [guildInput, setGuildInput]     = useState("");
  const [tokenInput, setTokenInput]     = useState("");
  const [showToken, setShowToken]       = useState(false);
  const [saving, setSaving]             = useState(false);
  const [testing, setTesting]           = useState(false);
  const [lastUpdate, setLastUpdate]     = useState<number | null>(null);
  const [newMsgCount, setNewMsgCount]   = useState(0);
  const [unread, setUnread]             = useState<Record<string, number>>({});
  const [hasMore, setHasMore]           = useState(true);
  const [loadingMore, setLoadingMore]   = useState(false);
  const [deepReading, setDeepReading]   = useState(false);
  const [deepReadCount, setDeepReadCount] = useState<number | null>(null);
  const [reparsingZones, setReparsingZones] = useState(false);

  const listRef        = useRef<HTMLDivElement>(null);
  const wsRef          = useRef<WebSocket | null>(null);
  const atBottomRef    = useRef(true);
  const selRef         = useRef<string | null>(null);
  const messagesRef    = useRef<DiscordMsg[]>([]);
  const loadingMoreRef = useRef(false);
  const hasMoreRef     = useRef(true);
  const deepPollRef    = useRef<ReturnType<typeof setInterval> | null>(null);
  selRef.current     = selectedCh;
  messagesRef.current = messages;

  function scrollToBottom(smooth = false) {
    const el = listRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "instant" });
  }

  useEffect(() => {
    loadStatus();
    loadMessages();
    connectWS();
    return () => { wsRef.current?.close(); if (deepPollRef.current) clearInterval(deepPollRef.current); };
  }, []);

  useEffect(() => {
    // Reset "has more" and reload when channel changes
    hasMoreRef.current = true;
    setHasMore(true);
    loadMessages();
    setTimeout(() => scrollToBottom(), 30);
    setNewMsgCount(0);
  }, [selectedCh]);

  function connectWS() {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${window.location.host}/ws/live-bars`);
    wsRef.current = ws;
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === "discord_message") {
          const dm = msg.message as DiscordMsg;
          setMessages(prev => {
            if (prev.some(m => m.messageId === dm.messageId)) return prev;
            return [...prev, dm];
          });
          setLastUpdate(Date.now());
          if (selRef.current !== dm.channelId && selRef.current !== null) {
            setUnread(u => ({ ...u, [dm.channelId]: (u[dm.channelId] ?? 0) + 1 }));
          }
          const isVisible = selRef.current === null || selRef.current === dm.channelId;
          if (isVisible && atBottomRef.current) {
            setTimeout(() => scrollToBottom(), 30);
          } else if (isVisible && !atBottomRef.current) {
            setNewMsgCount(n => n + 1);
          }
        }
      } catch {}
    };
    ws.onclose = () => { setTimeout(connectWS, 3000); };
  }

  async function loadStatus() {
    const r = await fetch("/api/discord-reader/settings").catch(() => null);
    if (!r?.ok) return;
    const data: ServerStatus = await r.json();
    setStatus(data);
    if (data.guildId) setGuildInput(data.guildId);
  }

  async function loadMessages() {
    const chParam = selRef.current ? `&channel_id=${selRef.current}` : "";
    const r = await fetch(`/api/discord-reader/messages?limit=100${chParam}`).catch(() => null);
    if (!r?.ok) return;
    const data = await r.json();
    const msgs = (data.messages ?? []).slice().reverse() as DiscordMsg[];
    setMessages(msgs);
    const more = data.hasMore ?? msgs.length >= 100;
    hasMoreRef.current = more;
    setHasMore(more);
    setTimeout(() => scrollToBottom(), 50);
  }

  // Infinite scroll: load older messages when user scrolls near the top
  async function loadOlderMessages() {
    if (loadingMoreRef.current || !hasMoreRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);

    const el = listRef.current;
    const prevScrollHeight = el?.scrollHeight ?? 0;

    const current = messagesRef.current;
    const displayed = selRef.current ? current.filter(m => m.channelId === selRef.current) : current;
    if (!displayed.length) { loadingMoreRef.current = false; setLoadingMore(false); return; }

    const oldestTs = displayed[0].postedAt;
    const chParam  = selRef.current ? `&channel_id=${selRef.current}` : "";

    try {
      const r = await fetch(`/api/discord-reader/messages?limit=100&before=${oldestTs}${chParam}`);
      if (!r.ok) throw new Error("fetch failed");
      const data = await r.json();
      const older = (data.messages ?? []).slice().reverse() as DiscordMsg[];

      if (older.length === 0) {
        hasMoreRef.current = false;
        setHasMore(false);
      } else {
        setMessages(prev => {
          const existingIds = new Set(prev.map(m => m.messageId));
          const fresh = older.filter(m => !existingIds.has(m.messageId));
          return [...fresh, ...prev];
        });
        // Restore scroll position so prepending doesn't jump the user
        requestAnimationFrame(() => {
          if (el) el.scrollTop = el.scrollHeight - prevScrollHeight;
        });
        const more = (data.hasMore ?? older.length >= 100);
        hasMoreRef.current = more;
        setHasMore(more);
      }
    } catch {}

    loadingMoreRef.current = false;
    setLoadingMore(false);
  }

  async function saveSettings() {
    if (!guildInput.trim()) { alert("Paste your Discord server ID first."); return; }
    setSaving(true);
    try {
      const body: any = { guildId: guildInput.trim() };
      if (tokenInput.trim()) body.token = tokenInput.trim();
      let r: Response, data: any;
      try {
        r = await fetch("/api/discord-reader/settings", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        data = await r.json();
      } catch (e: any) { alert(`Network error: ${e.message}`); return; }
      if (r.ok) {
        setTokenInput("");
        await loadStatus();
        setSettingsOpen(false);
      } else {
        alert(data.error ?? "Save failed");
      }
    } finally { setSaving(false); }
  }

  async function testConnection() {
    if (!guildInput.trim()) { alert("Enter a server ID first."); return; }
    setTesting(true);
    try {
      const body: any = { guildId: guildInput.trim() };
      if (tokenInput.trim()) body.token = tokenInput.trim();
      let r: Response, data: any;
      try {
        r = await fetch("/api/discord-reader/test", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        data = await r.json();
      } catch (e: any) { alert(`Network error: ${e.message}`); return; }
      alert(r.ok ? `Connected! Server: "${data.guildName}"` : `Test failed: ${data.error}`);
    } finally { setTesting(false); }
  }

  async function loadFullHistory() {
    if (deepReading) return;
    setDeepReading(true);

    // Snapshot baseline count
    const baseR = await fetch("/api/discord-reader/message-count").catch(() => null);
    const baseCount = baseR?.ok ? (await baseR.json()).total as number : 0;
    setDeepReadCount(baseCount);

    await fetch("/api/discord-reader/full-history", { method: "POST" }).catch(() => {});

    // Poll every 4 seconds to show progress; stop if count stalls for 3 polls
    let stalePolls = 0;
    let lastCount  = baseCount;
    if (deepPollRef.current) clearInterval(deepPollRef.current);
    deepPollRef.current = setInterval(async () => {
      const cr = await fetch("/api/discord-reader/message-count").catch(() => null);
      if (!cr?.ok) return;
      const n = (await cr.json()).total as number;
      setDeepReadCount(n);
      // Reload feed to show newly stored messages (reset to newest and scroll up)
      hasMoreRef.current = true;
      setHasMore(true);
      await loadMessages();

      if (n === lastCount) stalePolls++;
      else { stalePolls = 0; lastCount = n; }

      if (stalePolls >= 3) {
        clearInterval(deepPollRef.current!);
        deepPollRef.current = null;
        setDeepReading(false);
        setDeepReadCount(null);
      }
    }, 4000);
  }

  async function reparseZones() {
    setReparsingZones(true);
    try {
      const r = await fetch("/api/discord-reader/reparse-zones", { method: "POST" });
      const data = await r.json();
      if (data.zonesWritten !== undefined) alert(`Done — ${data.zonesWritten} zones written to DB`);
    } catch { alert("Zone re-parse failed"); }
    finally { setReparsingZones(false); }
  }

  async function clearSettings() {
    if (!confirm("Stop the Discord reader and clear all settings?")) return;
    await fetch("/api/discord-reader/settings", { method: "DELETE" });
    setStatus(null); setGuildInput("");
  }

  function handleScroll() {
    const el = listRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    atBottomRef.current = distFromBottom < 60;
    if (atBottomRef.current) setNewMsgCount(0);
    // Infinite scroll: load older messages when near the top
    if (el.scrollTop < 200 && !loadingMoreRef.current && hasMoreRef.current) {
      loadOlderMessages();
    }
  }

  function selectChannel(id: string | null) {
    setSelectedCh(id);
    if (id) setUnread(u => { const n = { ...u }; delete n[id]; return n; });
    else setUnread({});
  }

  const running    = status?.running ?? false;
  const groups     = status?.channels ? groupByCategory(status.channels) : [];
  const displayed  = selectedCh ? messages.filter(m => m.channelId === selectedCh) : messages;
  const selChannel = status?.channels.find(c => c.id === selectedCh);

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", background: T.bg, color: T.text, fontFamily: "sans-serif" }}>

      {/* ── Top bar ── */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", borderBottom: `1px solid ${T.bdr}`, background: T.panel, flexShrink: 0, zIndex: 10 }}>
        <Link href="/">
          <button style={{ display: "flex", alignItems: "center", background: "transparent", border: "none", color: T.muted, cursor: "pointer", padding: "4px 6px", borderRadius: 4 }}>
            <ArrowLeft style={{ width: 14, height: 14 }} />
          </button>
        </Link>
        <MessageSquare style={{ width: 15, height: 15, color: T.dblue }} />
        <span style={{ fontSize: 13, fontWeight: 700 }}>{status?.guildName ?? "Discord Feed"}</span>
        {selChannel && (
          <>
            <span style={{ color: T.muted, fontSize: 13 }}>/</span>
            <Hash style={{ width: 13, height: 13, color: T.muted }} />
            <span style={{ fontSize: 13, color: T.muted }}>{selChannel.name}</span>
          </>
        )}
        <div style={{ flex: 1 }} />
        {running ? (
          <span style={{ fontSize: 11, color: "#22c55e" }}>
            Live · {status?.channels.length} ch{lastUpdate ? ` · ${Math.floor((Date.now() - lastUpdate) / 1000)}s ago` : ""}
          </span>
        ) : (
          <span style={{ fontSize: 11, color: T.muted }}>Not running</span>
        )}
        <button
          onClick={() => setSettingsOpen(v => !v)}
          style={{ background: settingsOpen ? `${T.accent}22` : "transparent", border: `1px solid ${settingsOpen ? T.accent : T.bdr}`, color: settingsOpen ? T.accent : T.muted, cursor: "pointer", padding: "3px 10px", borderRadius: 4, fontSize: 11 }}>
          Settings
        </button>
      </div>

      {/* ── Settings panel ── */}
      {settingsOpen && (
        <div style={{ background: T.panel, borderBottom: `1px solid ${T.bdr}`, padding: 16, display: "flex", flexDirection: "column", gap: 12, flexShrink: 0 }}>
          <div style={{ display: "flex", gap: 12 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 11, color: T.muted, marginBottom: 4 }}>Discord Server ID</div>
              <input value={guildInput} onChange={e => setGuildInput(e.target.value)}
                placeholder="Paste server ID…"
                style={{ width: "100%", background: T.bg, border: `1px solid ${T.bdr}`, borderRadius: 4, color: T.text, fontSize: 12, padding: "5px 8px", boxSizing: "border-box" }} />
              <div style={{ fontSize: 10, color: T.muted, marginTop: 2 }}>
                Discord Settings → Advanced → Developer Mode → right-click server icon → Copy Server ID
              </div>
            </div>
            <div style={{ flex: 2 }}>
              <div style={{ fontSize: 11, color: T.muted, marginBottom: 4 }}>
                User Token {running && <span style={{ color: "#22c55e" }}>(saved)</span>}
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <input type={showToken ? "text" : "password"} value={tokenInput}
                  onChange={e => setTokenInput(e.target.value)}
                  placeholder={running ? "Leave blank to keep saved token…" : "Paste token…"}
                  style={{ flex: 1, background: T.bg, border: `1px solid ${T.bdr}`, borderRadius: 4, color: T.text, fontSize: 12, padding: "5px 8px" }} />
                <button onClick={() => setShowToken(v => !v)}
                  style={{ background: "transparent", border: `1px solid ${T.bdr}`, borderRadius: 4, color: T.muted, cursor: "pointer", padding: "4px 8px" }}>
                  {showToken ? <EyeOff style={{ width: 13, height: 13 }} /> : <Eye style={{ width: 13, height: 13 }} />}
                </button>
              </div>
              <div style={{ fontSize: 10, color: T.muted, marginTop: 2 }}>
                Discord web/desktop → F12 → Network → any request → Authorization header value
              </div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={saveSettings} disabled={saving}
              style={{ background: T.accent, border: "none", borderRadius: 4, color: "#fff", cursor: saving ? "default" : "pointer", padding: "5px 16px", fontSize: 12, opacity: saving ? 0.7 : 1 }}>
              {saving ? "Connecting…" : "Save & Start"}
            </button>
            <button onClick={testConnection} disabled={testing}
              style={{ background: "transparent", border: `1px solid ${T.bdr}`, borderRadius: 4, color: T.muted, cursor: testing ? "default" : "pointer", padding: "5px 14px", fontSize: 12 }}>
              {testing ? "Testing…" : "Test"}
            </button>
            <button onClick={clearSettings}
              style={{ background: "transparent", border: `1px solid #ef444455`, borderRadius: 4, color: "#ef4444", cursor: "pointer", padding: "5px 14px", fontSize: 12 }}>
              Clear
            </button>
            {running && (
              <button onClick={loadFullHistory} disabled={deepReading}
                style={{ background: deepReading ? "rgba(59,130,246,0.1)" : "transparent", border: `1px solid ${deepReading ? T.accent : T.bdr}`, borderRadius: 4, color: deepReading ? T.accent : T.muted, cursor: deepReading ? "default" : "pointer", padding: "5px 14px", fontSize: 12 }}>
                <Download style={{ width: 11, height: 11, display: "inline", marginRight: 4 }} />
                {deepReading ? `Fetching… ${deepReadCount != null ? deepReadCount + " msgs" : ""}` : "Load Full History"}
              </button>
            )}
            {running && (
              <button onClick={reparseZones} disabled={reparsingZones}
                style={{ background: "transparent", border: `1px solid ${T.bdr}`, borderRadius: 4, color: T.muted, cursor: reparsingZones ? "default" : "pointer", padding: "5px 14px", fontSize: 12, opacity: reparsingZones ? 0.6 : 1 }}>
                <FileText style={{ width: 11, height: 11, display: "inline", marginRight: 4 }} />
                {reparsingZones ? "Parsing…" : "Re-parse Zones"}
              </button>
            )}
          </div>
        </div>
      )}

      {/* ── Two-panel body ── */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>

        {/* ── Left sidebar ── */}
        <div style={{ width: 220, flexShrink: 0, background: T.sidebar, borderRight: `1px solid ${T.bdr}`, display: "flex", flexDirection: "column", overflowY: "auto" }}>
          <div style={{ padding: "8px 8px 4px" }}>
            <ChannelRow
              name="All messages"
              active={selectedCh === null}
              unread={Object.values(unread).reduce((a, b) => a + b, 0)}
              onClick={() => selectChannel(null)}
              isAll
            />
          </div>
          {groups.length === 0 && !running && (
            <div style={{ padding: "12px 12px", fontSize: 11, color: T.muted }}>
              Start the reader to see channels.
            </div>
          )}
          {groups.map((g, gi) => (
            <div key={gi} style={{ padding: "12px 0 4px" }}>
              {g.name && (
                <div style={{ padding: "0 8px 2px", fontSize: 10, fontWeight: 700, color: T.catText, textTransform: "uppercase", letterSpacing: "0.06em", display: "flex", alignItems: "center", gap: 4 }}>
                  <span style={{ fontSize: 10 }}>›</span> {g.name}
                </div>
              )}
              {g.channels.map(ch => (
                <ChannelRow
                  key={ch.id} name={ch.name}
                  active={selectedCh === ch.id}
                  unread={unread[ch.id] ?? 0}
                  onClick={() => selectChannel(ch.id)}
                />
              ))}
            </div>
          ))}
        </div>

        {/* ── Right panel ── */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <div ref={listRef} onScroll={handleScroll}
            style={{ flex: 1, overflowY: "auto", padding: "10px 16px", display: "flex", flexDirection: "column", gap: 2 }}>
            {/* Top loader / end-of-history indicator */}
            {displayed.length > 0 && (
              <div style={{ textAlign: "center", padding: "6px 0 10px", fontSize: 11, color: T.muted }}>
                {loadingMore
                  ? "Loading older messages…"
                  : hasMore
                    ? "↑ Scroll up to load older messages"
                    : "— Beginning of history —"}
              </div>
            )}
            {displayed.length === 0 ? (
              <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: T.muted, fontSize: 13, gap: 8 }}>
                <Hash style={{ width: 36, height: 36, opacity: 0.2 }} />
                {running
                  ? selectedCh ? `No messages yet in #${selChannel?.name}` : "Waiting for messages…"
                  : "Configure settings to start the feed."}
              </div>
            ) : (
              displayed.map((m, i) => {
                const prev = displayed[i - 1];
                const grouped = prev && prev.authorName === m.authorName && m.postedAt - prev.postedAt < 300;
                return <MsgCard key={m.messageId} m={m} grouped={grouped} showChannel={selectedCh === null} />;
              })
            )}
          </div>
          {newMsgCount > 0 && (
            <div
              onClick={() => { scrollToBottom(true); setNewMsgCount(0); }}
              style={{ background: T.accent, color: "#fff", textAlign: "center", fontSize: 11, padding: 5, cursor: "pointer", flexShrink: 0 }}>
              ↓ {newMsgCount} new message{newMsgCount !== 1 ? "s" : ""} — click to scroll down
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────

function ChannelRow({ name, active, unread, onClick, isAll }: {
  name: string; active: boolean; unread: number; onClick: () => void; isAll?: boolean;
}) {
  const [hov, setHov] = useState(false);
  return (
    <div onClick={onClick} onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{
        display: "flex", alignItems: "center", gap: 6,
        padding: "3px 8px", margin: "0 4px", borderRadius: 4,
        cursor: "pointer",
        background: active ? T.chActive : hov ? T.chHover : "transparent",
        color: active ? "#fff" : unread > 0 ? "#dcddde" : T.chText,
        fontWeight: unread > 0 && !active ? 600 : 400,
      }}>
      {isAll
        ? <MessageSquare style={{ width: 14, height: 14, flexShrink: 0, opacity: 0.7 }} />
        : <Hash style={{ width: 14, height: 14, flexShrink: 0, opacity: 0.7 }} />}
      <span style={{ fontSize: 13, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {name}
      </span>
      {unread > 0 && (
        <span style={{ background: "#ed4245", color: "#fff", fontSize: 10, fontWeight: 700, borderRadius: 8, padding: "0 5px", minWidth: 16, textAlign: "center" }}>
          {unread > 99 ? "99+" : unread}
        </span>
      )}
    </div>
  );
}

function AttachmentRenderer({ attachments }: { attachments: AttachmentObj[] }) {
  if (!attachments.length) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 6 }}>
      {attachments.map((a, i) => {
        if (isImage(a)) {
          return (
            <a key={i} href={a.url} target="_blank" rel="noopener noreferrer">
              <img
                src={a.url} alt={a.filename ?? "image"}
                style={{ maxWidth: 400, maxHeight: 300, borderRadius: 6, display: "block", cursor: "pointer", border: `1px solid ${T.bdr}` }}
                onError={e => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
              />
            </a>
          );
        }
        if (isVideo(a)) {
          return (
            <video key={i} controls
              style={{ maxWidth: 400, maxHeight: 280, borderRadius: 6, display: "block", border: `1px solid ${T.bdr}` }}>
              <source src={a.url} type={a.contentType ?? "video/mp4"} />
              <a href={a.url} target="_blank" rel="noopener noreferrer" style={{ color: "#00aff4" }}>
                <Film style={{ width: 12, height: 12, display: "inline", marginRight: 4 }} />
                {a.filename ?? "video"}
              </a>
            </video>
          );
        }
        // Generic file download
        return (
          <a key={i} href={a.url} target="_blank" rel="noopener noreferrer" download={a.filename}
            style={{
              display: "inline-flex", alignItems: "center", gap: 8,
              background: T.panel, border: `1px solid ${T.bdr}`, borderRadius: 6,
              padding: "8px 12px", textDecoration: "none", maxWidth: 360,
            }}>
            <FileText style={{ width: 20, height: 20, color: T.muted, flexShrink: 0 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, color: "#00aff4", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {a.filename ?? "attachment"}
              </div>
              {a.size && <div style={{ fontSize: 10, color: T.muted }}>{fmtSize(a.size)}</div>}
            </div>
            <Download style={{ width: 14, height: 14, color: T.muted, flexShrink: 0 }} />
          </a>
        );
      })}
    </div>
  );
}

function EmbedRenderer({ embeds }: { embeds: EmbedObj[] }) {
  if (!embeds.length) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 6 }}>
      {embeds.map((e, i) => {
        // Pure image embed
        if (e.type === "image" && e.thumbnail?.url) {
          return (
            <a key={i} href={e.url ?? e.thumbnail.url} target="_blank" rel="noopener noreferrer">
              <img src={e.thumbnail.url} alt="embed image"
                style={{ maxWidth: 400, maxHeight: 300, borderRadius: 6, display: "block", border: `1px solid ${T.bdr}` }}
                onError={ev => { (ev.currentTarget as HTMLImageElement).style.display = "none"; }} />
            </a>
          );
        }
        // Video embed with thumbnail
        if (e.type === "video") {
          const thumb = e.thumbnail?.url ?? e.image?.url;
          const vidUrl = e.video?.proxy_url ?? e.video?.url ?? e.url;
          return (
            <a key={i} href={vidUrl ?? e.url ?? "#"} target="_blank" rel="noopener noreferrer"
              style={{ display: "block", position: "relative", maxWidth: 400 }}>
              {thumb && (
                <img src={thumb} alt="video thumbnail"
                  style={{ maxWidth: 400, maxHeight: 225, borderRadius: 6, display: "block", border: `1px solid ${T.bdr}` }}
                  onError={ev => { (ev.currentTarget as HTMLImageElement).style.display = "none"; }} />
              )}
              <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
                <Film style={{ width: 36, height: 36, color: "#fff", opacity: 0.85, filter: "drop-shadow(0 1px 3px rgba(0,0,0,0.8))" }} />
              </div>
            </a>
          );
        }
        // Link preview / rich card
        const hasContent = e.title || e.description || e.image?.url || e.thumbnail?.url;
        if (!hasContent) return null;
        const accentColor = e.color ? `#${e.color.toString(16).padStart(6, "0")}` : T.accent;
        return (
          <div key={i} style={{ borderLeft: `4px solid ${accentColor}`, background: T.panel, borderRadius: "0 6px 6px 0", padding: "10px 12px", maxWidth: 440, display: "flex", gap: 12 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              {e.provider?.name && (
                <div style={{ fontSize: 10, color: T.muted, marginBottom: 2 }}>{e.provider.name}</div>
              )}
              {e.author?.name && (
                <div style={{ fontSize: 11, color: T.muted, marginBottom: 4 }}>{e.author.name}</div>
              )}
              {e.title && (
                <a href={e.url ?? "#"} target="_blank" rel="noopener noreferrer"
                  style={{ fontSize: 13, fontWeight: 600, color: "#00aff4", textDecoration: "none", display: "block", marginBottom: 4 }}>
                  {e.title}
                </a>
              )}
              {e.description && (
                <div style={{ fontSize: 12, color: "#b9bbbe", lineHeight: 1.5, display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                  {e.description}
                </div>
              )}
              {e.image?.url && (
                <img src={e.image.url} alt="embed"
                  style={{ maxWidth: "100%", maxHeight: 200, borderRadius: 4, marginTop: 8, display: "block" }}
                  onError={ev => { (ev.currentTarget as HTMLImageElement).style.display = "none"; }} />
              )}
            </div>
            {e.thumbnail?.url && !e.image?.url && (
              <img src={e.thumbnail.url} alt="thumbnail"
                style={{ width: 64, height: 64, objectFit: "cover", borderRadius: 4, flexShrink: 0 }}
                onError={ev => { (ev.currentTarget as HTMLImageElement).style.display = "none"; }} />
            )}
          </div>
        );
      })}
    </div>
  );
}

function MsgCard({ m, grouped, showChannel }: { m: DiscordMsg; grouped: boolean; showChannel: boolean }) {
  const initial    = (m.authorName[0] ?? "?").toUpperCase();
  const attachments = parseAttachments(m.attachments);
  const embeds      = parseEmbeds(m.embeds);
  const hasMedia    = attachments.length > 0 || embeds.length > 0;

  const body = (
    <>
      {m.content && (
        <div style={{ fontSize: 13, color: "#dcddde", lineHeight: 1.6, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
          {renderContent(m.content)}
        </div>
      )}
      {hasMedia && (
        <>
          <AttachmentRenderer attachments={attachments} />
          <EmbedRenderer embeds={embeds} />
        </>
      )}
    </>
  );

  if (grouped) {
    return (
      <div style={{ paddingLeft: 46, paddingRight: 4 }}>{body}</div>
    );
  }

  return (
    <div style={{ display: "flex", gap: 12, paddingTop: 12 }}>
      <div style={{ width: 34, height: 34, borderRadius: "50%", background: "#7289da22", border: "1px solid #7289da44", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 700, color: T.dblue, flexShrink: 0, marginTop: 1 }}>
        {initial}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 2 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: "#93c5fd" }}>{m.authorName}</span>
          {showChannel && m.channelName && (
            <span style={{ fontSize: 10, color: T.muted, display: "flex", alignItems: "center", gap: 2 }}>
              <Hash style={{ width: 10, height: 10 }} />{m.channelName}
            </span>
          )}
          <span style={{ fontSize: 10, color: T.muted }}>{relTime(m.postedAt)}</span>
        </div>
        {body}
      </div>
    </div>
  );
}
