package com.custom;

import com.motivewave.platform.sdk.common.*;
import com.motivewave.platform.sdk.common.desc.*;
import com.motivewave.platform.sdk.study.*;

import java.lang.reflect.Method;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.WebSocket;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/**
 * LiveBarRelay v2 — server-driven backfill.
 *
 * Changes from v1:
 *  - Resolution is resolved ONCE (ground truth via DataSeries.getBarSize reflection,
 *    else the MEDIAN of the first 50 consecutive bar deltas). Never re-inferred per bar.
 *  - On WS open + resolution known, sends a `hello` handshake; the server then drives
 *    all history backfill via `backfill` requests (no more connect-time auto-dump).
 *  - Outgoing messages go through a single daemon sender thread (outbox). Ticks and
 *    forming bars use one-slot latest-wins references so they can never flood or block
 *    protocol/complete-bar traffic. Java WebSocket forbids concurrent sendText(), so
 *    ALL sends (including backfill bulk batches) are serialized through this one thread.
 *  - `backfill` requests are serviced on the scheduler thread via Instrument.getBars
 *    (reflection — plain List return; the forEachBar callback proxy is unusable because
 *    the obfuscated BarOperation interface can't be reflect.Proxy'd). If getBars is
 *    unavailable/empty it degrades to the loaded DataSeries slice.
 *
 * onTick + footprint accumulation are unchanged from v1.
 */
@StudyHeader(
  namespace      = "com.custom",
  id             = "LIVE_BAR_RELAY",
  name           = "Live Bar Relay",
  label          = "LiveBarRelay",
  desc           = "Relays live bars + services server-driven history backfills to localhost:5000.",
  overlay        = true,
  requiresVolume = true,
  signals        = false
)
public class LiveBarRelay extends Study {

  private static final String WS_ENDPOINT = "ws://localhost:5000/ws/mw-feed";
  private static final int    BATCH_SIZE  = 500;   // bars per bulk_bars message

  private final HttpClient http = HttpClient.newBuilder()
    .connectTimeout(Duration.ofSeconds(4))
    .build();

  private final AtomicReference<WebSocket> wsRef = new AtomicReference<>();

  // ── Outbox / sender ──────────────────────────────────────────────────────────
  // Protocol + complete-bar messages are queued (never dropped). Ticks and forming
  // bars use latest-wins single slots so they self-throttle and never starve the queue.
  private final ConcurrentLinkedQueue<String> outbox        = new ConcurrentLinkedQueue<>();
  private final AtomicReference<String>       latestTick    = new AtomicReference<>();
  private final AtomicReference<String>       latestForming = new AtomicReference<>();
  private final Object                        senderSignal  = new Object();

  // ── Resolution ground truth (resolved once) ──────────────────────────────────
  private volatile String  resolution   = null;
  private volatile Object  barSizeObj   = null;
  private final AtomicBoolean pendingHello = new AtomicBoolean(false);

  // ── getBars reflection cache ──────────────────────────────────────────────────
  // The getBars(long,long,BarSize,boolean) Method is resolved once; the per-bar
  // accessors are resolved once from the first element's class and reused.
  private volatile Method getBarsMethod  = null;
  private volatile boolean getBarsLookedUp = false;
  private volatile Class<?> barAccessorClass = null;
  private volatile Method aTime, aTimeAlt, aOpen, aHigh, aLow, aClose, aVol, aVolAlt;

  // Latest chart context (set in calculate, read by backfill servicer)
  private volatile String     symbol     = "";
  private volatile DataSeries dataSeries = null;
  private volatile Instrument instrument = null;

  // Incoming-text accumulator for the WS listener
  private final StringBuilder textBuf = new StringBuilder();

  // ── Footprint accumulator — per-price bid/ask volume for the current 5m bucket ──
  private final TreeMap<Float, long[]> footprintLevels = new TreeMap<>(); // price → [bidVol, askVol]
  private volatile long   footprintBucketMs  = 0;   // current 5-min bucket start (epoch ms)
  private volatile String footprintSymbol    = "";   // symbol of current bucket

  private final ScheduledExecutorService scheduler =
    Executors.newSingleThreadScheduledExecutor(r -> {
      Thread t = new Thread(r, "LiveBarRelay-scheduler");
      t.setDaemon(true);
      return t;
    });

  @Override
  public void initialize(Defaults defaults) {
    createSD();
    Thread sender = new Thread(this::senderLoop, "LiveBarRelay-sender");
    sender.setDaemon(true);
    sender.start();
    connect();
    // Reconnect every 5 seconds if the WebSocket drops
    scheduler.scheduleAtFixedRate(this::reconnectIfNeeded, 5, 5, TimeUnit.SECONDS);
  }

  // ── WebSocket lifecycle ───────────────────────────────────────────────────────

  private void connect() {
    http.newWebSocketBuilder()
      .connectTimeout(Duration.ofSeconds(4))
      .buildAsync(URI.create(WS_ENDPOINT), new WebSocket.Listener() {

        @Override
        public void onOpen(WebSocket ws) {
          wsRef.set(ws);
          ws.request(Long.MAX_VALUE);
          synchronized (textBuf) { textBuf.setLength(0); }
          // (Re)send hello once resolution is known — calculate() fires it.
          pendingHello.set(true);
          System.out.println("[LiveBarRelay] Connected to " + WS_ENDPOINT);
        }

        @Override
        public CompletionStage<?> onText(WebSocket ws, CharSequence data, boolean last) {
          synchronized (textBuf) {
            textBuf.append(data);
            if (last) {
              String s = textBuf.toString();
              textBuf.setLength(0);
              handleIncoming(s);
            }
          }
          return null;
        }

        @Override
        public CompletionStage<?> onClose(WebSocket ws, int statusCode, String reason) {
          wsRef.set(null);
          System.out.println("[LiveBarRelay] WebSocket closed: " + statusCode + " " + reason);
          return null;
        }

        @Override
        public void onError(WebSocket ws, Throwable error) {
          wsRef.set(null);
          System.out.println("[LiveBarRelay] WebSocket error: " + error.getMessage());
        }
      })
      .exceptionally(e -> {
        System.out.println("[LiveBarRelay] Connect failed: " + e.getMessage());
        return null;
      });
  }

  private void reconnectIfNeeded() {
    if (wsRef.get() == null) {
      System.out.println("[LiveBarRelay] Attempting reconnect...");
      connect();
    }
  }

  // ── Sender thread ───────────────────────────────────────────────────────────
  // Single writer: drains outbox first (protocol + complete bars), then the latest
  // forming bar, then the latest tick. Each send is awaited so we never call
  // sendText concurrently (Java WebSocket forbids it).
  private void senderLoop() {
    while (!Thread.currentThread().isInterrupted()) {
      String msg = outbox.poll();
      if (msg == null) msg = latestForming.getAndSet(null);
      if (msg == null) msg = latestTick.getAndSet(null);
      if (msg == null) {
        synchronized (senderSignal) {
          try { senderSignal.wait(200); } catch (InterruptedException e) { return; }
        }
        continue;
      }
      WebSocket w = wsRef.get();
      if (w == null) continue; // disconnected — drop; server re-audits on reconnect
      try {
        w.sendText(msg, true).get(10, TimeUnit.SECONDS);
      } catch (Exception e) {
        wsRef.set(null);
      }
    }
  }

  private void wakeSender() {
    synchronized (senderSignal) { senderSignal.notifyAll(); }
  }

  private void enqueue(String json)   { outbox.add(json);      wakeSender(); }
  private void setForming(String json){ latestForming.set(json); wakeSender(); }

  // ── Tick callback (UNCHANGED from v1) ─────────────────────────────────────────

  @Override
  public void onTick(DataContext ctx, Tick tick) {
    float  price  = tick.getPrice();
    String symbol = ctx.getInstrument().getSymbol();
    long   now    = System.currentTimeMillis();

    // Existing price-only tick message (unchanged)
    sendWs(String.format(
      "{\"type\":\"tick\",\"symbol\":\"%s\",\"price\":%.4f,\"time\":%d}",
      symbol, price, now));

    // ── Footprint accumulation ────────────────────────────────────────────
    long intervalMs = 5L * 60L * 1000L;                         // 5-minute buckets
    long bucketMs   = (now / intervalMs) * intervalMs;

    // On bucket boundary: flush previous footprint bar then start fresh
    synchronized (footprintLevels) {
      if (footprintBucketMs != 0 && bucketMs != footprintBucketMs) {
        flushFootprintBar(footprintSymbol, footprintBucketMs);
        footprintLevels.clear();
      }
      footprintBucketMs = bucketMs;
      footprintSymbol   = symbol;

      // Extract volume and direction from the Tick object via reflection
      long    vol   = extractLong(tick, "getVolume", "getSize", "getQuantity", "getLastSize");
      boolean isAsk = extractBool(tick, "isAsk", "askTick", "isBuyTick");
      if (vol <= 0) vol = 1; // treat unknown as 1 contract

      long[] arr = footprintLevels.computeIfAbsent(price, k -> new long[]{0L, 0L});
      if (isAsk) arr[1] += vol; // ask volume (aggressive buy)
      else       arr[0] += vol; // bid volume (aggressive sell)
    }
  }

  /** Serializes the current footprintLevels into a footprint_bar WS message. */
  private void flushFootprintBar(String symbol, long bucketMs) {
    if (footprintLevels.isEmpty()) return;
    StringBuilder levels = new StringBuilder("[");
    boolean first = true;
    for (Map.Entry<Float, long[]> e : footprintLevels.entrySet()) {
      if (!first) levels.append(",");
      first = false;
      levels.append(String.format("{\"price\":%.4f,\"b\":%d,\"a\":%d}",
        e.getKey(), e.getValue()[0], e.getValue()[1]));
    }
    levels.append("]");
    sendWs(String.format(
      "{\"type\":\"footprint_bar\",\"symbol\":\"%s\",\"resolution\":\"5\",\"time\":%d,\"levels\":%s}",
      symbol, bucketMs / 1000L, levels));
  }

  /** Extracts a long value from an object by trying method names in order (reflection). */
  private static long extractLong(Object obj, String... methodNames) {
    for (String name : methodNames) {
      try {
        java.lang.reflect.Method m = obj.getClass().getMethod(name);
        Object v = m.invoke(obj);
        if (v instanceof Number) return ((Number) v).longValue();
      } catch (Exception ignored) {}
    }
    return 0L;
  }

  /** Extracts a boolean from an object by trying method names in order (reflection). */
  private static boolean extractBool(Object obj, String... methodNames) {
    for (String name : methodNames) {
      try {
        java.lang.reflect.Method m = obj.getClass().getMethod(name);
        Object v = m.invoke(obj);
        if (v instanceof Boolean) return (Boolean) v;
      } catch (Exception ignored) {}
    }
    return false; // default: treat as bid (sell aggression) if direction unknown
  }

  // ── Bar callback ──────────────────────────────────────────────────────────────

  @Override
  protected void calculate(int index, DataContext ctx) {
    DataSeries ds     = ctx.getDataSeries();
    int        total  = ds.size();
    String     sym    = ctx.getInstrument().getSymbol();

    // Stash context for the backfill servicer (runs off the calc thread)
    this.dataSeries = ds;
    this.instrument = ctx.getInstrument();
    this.symbol     = sym;

    // Resolve resolution ONCE (ground truth) before anything is sent.
    if (resolution == null) resolveResolution(ds);

    // Fire the hello handshake once resolution is known AND the socket is open.
    if (resolution != null && pendingHello.compareAndSet(true, false)) {
      long seriesStart = total > 0 ? ds.getStartTime(0)         : System.currentTimeMillis();
      long seriesEnd   = total > 0 ? ds.getStartTime(total - 1) : System.currentTimeMillis();
      enqueue(String.format(
        "{\"type\":\"hello\",\"symbol\":\"%s\",\"resolution\":\"%s\",\"seriesStartMs\":%d,\"seriesEndMs\":%d,\"ver\":2}",
        sym, resolution, seriesStart, seriesEnd));
      System.out.println("[LiveBarRelay] hello sent res=" + resolution);
    }

    // ── Live bar update (last bar only) ──────────────────────────────────────────
    if (index != total - 1) return;

    long    timeMs   = ds.getStartTime(index);
    float   open     = ds.getOpen(index);
    float   high     = ds.getHigh(index);
    float   low      = ds.getLow(index);
    float   close    = ds.getClose(index);
    long    volume   = (long) ds.getVolume(index);
    boolean complete = ds.isBarComplete(index);

    String barJson = String.format(
      "{\"type\":\"bar\",\"symbol\":\"%s\",\"resolution\":\"%s\"" +
      ",\"time\":%d,\"open\":%.4f,\"high\":%.4f,\"low\":%.4f,\"close\":%.4f" +
      ",\"volume\":%d,\"complete\":%b}",
      sym, resolution, timeMs / 1000L, open, high, low, close, volume, complete);

    // Complete bars must never be dropped → outbox. Forming bars are latest-wins.
    if (complete) enqueue(barJson);
    else          setForming(barJson);
  }

  // ── Resolution resolution ─────────────────────────────────────────────────────

  private void resolveResolution(DataSeries ds) {
    String r = resolveViaBarSize(ds);
    if (r == null) r = resolveViaMedianDelta(ds);
    if (r == null) r = "1";
    resolution = r;
    System.out.println("[LiveBarRelay] resolution resolved = " + r);
  }

  /**
   * Ground truth via DataSeries.getBarSize() interval accessors (reflection).
   * Verified on the real object: getIntervalMinutes()=5, getIntervalSeconds()=300,
   * getInterval()=5 for a 5-min chart. Try in that order.
   */
  private String resolveViaBarSize(DataSeries ds) {
    try {
      Method gbs = ds.getClass().getMethod("getBarSize");
      Object bs  = gbs.invoke(ds);
      if (bs == null) return null;
      barSizeObj = bs; // cache for getBars backfills
      long minutes = -1;
      Object v;
      if ((v = tryCall(bs, "getIntervalMinutes")) instanceof Number) {
        minutes = ((Number) v).longValue();
      } else if ((v = tryCall(bs, "getIntervalSeconds")) instanceof Number) {
        minutes = ((Number) v).longValue() / 60L;
      } else if ((v = tryCall(bs, "getInterval")) instanceof Number) {
        minutes = ((Number) v).longValue(); // verified: getInterval() is in minutes
      }
      if (minutes >= 1) {
        System.out.println("[LiveBarRelay] BarSize minutes = " + minutes);
        return mapMinutes(minutes);
      }
    } catch (Exception ignored) {}
    return null;
  }

  /** Map minutes → wire resolution. Known intervals get canonical strings; the server
   *  parses any other "N" as N minutes, so pass unknown minutes through verbatim. */
  private static String mapMinutes(long m) {
    if (m < 1) return null; // sub-minute / bad median → let caller default to "1"
    if (m == 1)  return "1";
    if (m == 5)  return "5";
    if (m == 15) return "15";
    if (m == 60) return "60";
    return String.valueOf(m);
  }

  /** Zero-arg reflection call returning the value or null on any failure. */
  private static Object tryCall(Object obj, String name) {
    if (obj == null) return null;
    try { return obj.getClass().getMethod(name).invoke(obj); }
    catch (Throwable t) { return null; }
  }

  /** Fallback: median of the first 50 consecutive bar deltas (robust across session gaps). */
  private String resolveViaMedianDelta(DataSeries ds) {
    int size = ds.size();
    if (size < 2) return null;
    int n = Math.min(50, size - 1);
    long[] deltas = new long[n];
    int cnt = 0;
    for (int i = 1; i <= n; i++) {
      long d = ds.getStartTime(i) - ds.getStartTime(i - 1);
      if (d > 0) deltas[cnt++] = d;
    }
    if (cnt == 0) return null;
    long[] valid = java.util.Arrays.copyOf(deltas, cnt);
    java.util.Arrays.sort(valid);
    long median = valid[cnt / 2];
    return mapMinutes(median / 60_000L);
  }

  // ── Incoming protocol handling ────────────────────────────────────────────────

  /** Extracts a string field value ("field":"value") from a JSON message. */
  private static String extractString(String json, String field) {
    String key = "\"" + field + "\":\"";
    int i = json.indexOf(key);
    if (i < 0) return null;
    int start = i + key.length();
    int end = json.indexOf('"', start);
    if (end < 0) return null;
    return json.substring(start, end);
  }

  /** Extracts a numeric field value ("field":12345) from a JSON message; -1 if absent. */
  private static long extractLongField(String json, String field) {
    String key = "\"" + field + "\":";
    int i = json.indexOf(key);
    if (i < 0) return -1;
    int p = i + key.length();
    boolean neg = false;
    if (p < json.length() && json.charAt(p) == '-') { neg = true; p++; }
    long v = 0;
    boolean any = false;
    while (p < json.length() && Character.isDigit(json.charAt(p))) {
      v = v * 10 + (json.charAt(p) - '0');
      p++;
      any = true;
    }
    if (!any) return -1;
    return neg ? -v : v;
  }

  private void handleIncoming(String s) {
    try {
      if (s.contains("\"backfill\"") && s.contains("\"fromMs\"")) {
        final String id = extractString(s, "id");
        final long fromMs = extractLongField(s, "fromMs");
        final long toMs   = extractLongField(s, "toMs");
        if (id != null && fromMs >= 0 && toMs > 0) {
          scheduler.execute(() -> serviceBackfill(id, fromMs, toMs));
        }
      }
      // bulk_report messages are informational — no action needed.
    } catch (Exception ignored) {}
  }

  // ── Backfill servicing ────────────────────────────────────────────────────────

  private void serviceBackfill(String id, long fromMs, long toMs) {
    DataSeries ds   = dataSeries;
    Instrument inst = instrument;
    if (ds == null || inst == null) { sendBackfillDone(id, 0, 0, "feed"); return; }

    String source = "feed";
    long   earliestMs = 0;
    List<String> bars = null;

    // 1. Try Instrument.getBars (deep history).
    try {
      BarsResult r = tryGetBars(inst, fromMs, toMs);
      if (r != null && r.count > 0) { bars = r.bars; earliestMs = r.earliestMs; source = "feed"; }
    } catch (Throwable t) {
      System.out.println("[LiveBarRelay] getBars failed: " + t);
    }

    // 2. Auto-degrade to the loaded DataSeries slice when getBars is unavailable/empty
    //    and the requested range overlaps what the chart already has.
    if (bars == null || bars.isEmpty()) {
      int size = ds.size();
      if (size > 1) {
        long chartStart = ds.getStartTime(0);
        long chartEnd   = ds.getStartTime(size - 1);
        if (fromMs <= chartEnd && toMs >= chartStart) {
          bars = new ArrayList<>();
          earliestMs = 0;
          for (int i = 0; i < size - 1; i++) { // skip forming last bar
            long t = ds.getStartTime(i);
            if (t < fromMs || t > toMs) continue;
            float o = ds.getOpen(i), h = ds.getHigh(i), l = ds.getLow(i), c = ds.getClose(i);
            long  v = (long) ds.getVolume(i);
            if (h < l || o <= 0) continue;
            bars.add(barJson(t / 1000L, o, h, l, c, v));
            if (earliestMs == 0 || t < earliestMs) earliestMs = t;
          }
          source = "chart";
        }
      }
    }

    if (bars == null) bars = new ArrayList<>();

    int total = bars.size();
    int seq = 0;
    for (int i = 0; i < total; i += BATCH_SIZE) {
      List<String> chunk = new ArrayList<>(bars.subList(i, Math.min(total, i + BATCH_SIZE)));
      boolean fin = (i + BATCH_SIZE) >= total;
      enqueue(String.format(
        "{\"type\":\"bulk_bars\",\"id\":\"%s\",\"symbol\":\"%s\",\"resolution\":\"%s\",\"seq\":%d,\"final\":%b,\"bars\":[%s]}",
        id, symbol, resolution, seq++, fin, String.join(",", chunk)));
    }
    sendBackfillDone(id, total, earliestMs, source);
    System.out.printf("[LiveBarRelay] backfill %s done: %d bars source=%s%n", id, total, source);
  }

  private void sendBackfillDone(String id, int count, long earliestMs, String source) {
    enqueue(String.format(
      "{\"type\":\"backfill_done\",\"id\":\"%s\",\"count\":%d,\"earliestAvailableMs\":%d,\"source\":\"%s\"}",
      id, count, earliestMs, source));
  }

  /**
   * getBars(long, long, BarSize, boolean) via reflection — the verified replacement for
   * the (unusable) forEachBar callback path. Returns null when barSize is unknown or the
   * method can't be found, so the caller degrades to the DataSeries slice.
   */
  private BarsResult tryGetBars(Instrument inst, long fromMs, long toMs) throws Exception {
    Object bs = barSizeObj;
    if (bs == null) return null; // no BarSize captured yet → fall back to DataSeries slice

    if (!getBarsLookedUp) {
      getBarsMethod   = findGetBars(inst.getClass(), bs);
      getBarsLookedUp = true;
    }
    Method gb = getBarsMethod;
    if (gb == null) return null;

    Object result = gb.invoke(inst, fromMs, toMs, bs, Boolean.FALSE);
    if (!(result instanceof List)) return null;

    List<?> list = (List<?>) result;
    final BarsResult res = new BarsResult();
    for (Object bar : list) {
      if (bar == null) continue;
      resolveAccessors(bar.getClass());
      long t = invLong(aTime, bar);
      if (t <= 0) t = invLong(aTimeAlt, bar);               // getStartTime → getTime fallback
      double o = invDbl(aOpen, bar), h = invDbl(aHigh, bar),
             l = invDbl(aLow, bar),  c = invDbl(aClose, bar);
      double v = (aVol != null) ? invDbl(aVol, bar)
               : (aVolAlt != null) ? invDbl(aVolAlt, bar) : 0.0;
      if (Double.isNaN(o) || Double.isNaN(h) || Double.isNaN(l) || Double.isNaN(c)) continue;
      if (t <= 1_000_000_000L || o <= 0 || h < l) continue; // same validity rules as before
      res.bars.add(barJson(t / 1000L, o, h, l, c, (long) v));
      res.count++;
      if (res.earliestMs == 0 || t < res.earliestMs) res.earliestMs = t;
    }
    return res;
  }

  /** Locate getBars(long, long, <BarSize-assignable>, boolean). */
  private static Method findGetBars(Class<?> cls, Object barSize) {
    for (Method m : cls.getMethods()) {
      if (!m.getName().equals("getBars")) continue;
      Class<?>[] p = m.getParameterTypes();
      if (p.length != 4) continue;
      boolean p0 = (p[0] == long.class || p[0] == Long.class);
      boolean p1 = (p[1] == long.class || p[1] == Long.class);
      boolean p2 = p[2].isInstance(barSize);
      boolean p3 = (p[3] == boolean.class || p[3] == Boolean.class);
      if (p0 && p1 && p2 && p3) return m;
    }
    return null;
  }

  /** Resolve the per-bar accessor Methods once from the first element's class; reuse after. */
  private void resolveAccessors(Class<?> cls) {
    if (barAccessorClass == cls) return;
    aTime    = findAccessor(cls, "getStartTime");
    aTimeAlt = findAccessor(cls, "getTime");
    aOpen    = findAccessor(cls, "getOpen");
    aHigh    = findAccessor(cls, "getHigh");
    aLow     = findAccessor(cls, "getLow");
    aClose   = findAccessor(cls, "getClose");
    aVol     = findAccessor(cls, "getVolume");
    aVolAlt  = findAccessor(cls, "getVolumeAsFloat");
    barAccessorClass = cls;
  }

  private static Method findAccessor(Class<?> cls, String name) {
    try { return cls.getMethod(name); } catch (Exception e) { return null; }
  }

  private static long invLong(Method m, Object o) {
    if (m == null) return 0L;
    try { Object v = m.invoke(o); return (v instanceof Number) ? ((Number) v).longValue() : 0L; }
    catch (Exception e) { return 0L; }
  }

  private static double invDbl(Method m, Object o) {
    if (m == null) return Double.NaN;
    try { Object v = m.invoke(o); return (v instanceof Number) ? ((Number) v).doubleValue() : Double.NaN; }
    catch (Exception e) { return Double.NaN; }
  }

  private static class BarsResult {
    final List<String> bars = new ArrayList<>();
    int  count = 0;
    long earliestMs = 0;
  }

  private static String barJson(long tSec, double o, double h, double l, double c, long v) {
    return String.format("{\"t\":%d,\"o\":%.4f,\"h\":%.4f,\"l\":%.4f,\"c\":%.4f,\"v\":%d}", tSec, o, h, l, c, v);
  }

  // ── WebSocket send (routes by message type into the outbox / tick slot) ────────

  private void sendWs(String json) {
    // Ticks are latest-wins (fast path, never queued); everything else is queued.
    if (json.startsWith("{\"type\":\"tick\"")) {
      latestTick.set(json);
      wakeSender();
    } else {
      enqueue(json);
    }
  }

  @Override
  public void destroy() {
    scheduler.shutdownNow();
    WebSocket w = wsRef.getAndSet(null);
    if (w != null) {
      try { w.sendClose(WebSocket.NORMAL_CLOSURE, "study removed").join(); } catch (Exception ignored) {}
    }
  }
}
