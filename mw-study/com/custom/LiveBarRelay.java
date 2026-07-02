package com.custom;

import com.motivewave.platform.sdk.common.*;
import com.motivewave.platform.sdk.common.desc.*;
import com.motivewave.platform.sdk.study.*;

import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
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
 *  - `backfill` requests are serviced on the scheduler thread via Instrument.forEachBar
 *    (reflection); if that is unavailable/empty it degrades to the loaded DataSeries slice.
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

  /** Ground truth via DataSeries.getBarSize() interval accessors (reflection). */
  private String resolveViaBarSize(DataSeries ds) {
    try {
      Method gbs = ds.getClass().getMethod("getBarSize");
      Object bs  = gbs.invoke(ds);
      if (bs == null) return null;
      barSizeObj = bs; // cache for forEachBar backfills
      for (String name : new String[]{ "getIntervalMinutes", "getInterval", "getSize" }) {
        try {
          Method m = bs.getClass().getMethod(name);
          Object v = m.invoke(bs);
          if (v instanceof Number) {
            long raw = ((Number) v).longValue();
            String mapped = mapBarSizeValue(name, raw);
            if (mapped != null) {
              System.out.println("[LiveBarRelay] BarSize." + name + "() = " + raw);
              return mapped;
            }
          }
        } catch (Exception ignored) {}
      }
    } catch (Exception ignored) {}
    return null;
  }

  /** Interpret a BarSize accessor value: minutes for *Minutes methods; else detect seconds. */
  private static String mapBarSizeValue(String methodName, long v) {
    long minutes;
    if (methodName.toLowerCase().contains("minute")) minutes = v;
    else if (v == 60 || v == 300 || v == 900 || v == 3600) minutes = v / 60; // seconds
    else minutes = v; // assume minutes
    return mapMinutes(minutes);
  }

  private static String mapMinutes(long m) {
    if (m >= 50) return "60";
    if (m >= 12) return "15";
    if (m >= 3)  return "5";
    if (m >= 1)  return "1";
    return null;
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

    // 1. Try Instrument.forEachBar (deep history).
    try {
      FeResult r = tryForEachBar(inst, fromMs, toMs);
      if (r != null && r.count > 0) { bars = r.bars; earliestMs = r.earliestMs; source = "feed"; }
    } catch (Throwable t) {
      System.out.println("[LiveBarRelay] forEachBar failed: " + t);
    }

    // 2. Auto-degrade to the loaded DataSeries slice when forEachBar is unavailable/empty
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

  /** forEachBar via reflection; returns null if the method does not exist. */
  private FeResult tryForEachBar(Instrument inst, long fromMs, long toMs) throws Exception {
    Method fe = null;
    for (Method m : inst.getClass().getMethods()) {
      if (m.getName().equals("forEachBar")) { fe = m; break; }
    }
    if (fe == null) return null;

    Class<?>[] pts = fe.getParameterTypes();
    final FeResult res = new FeResult();
    Object[] args = new Object[pts.length];
    int longs = 0;
    for (int i = 0; i < pts.length; i++) {
      Class<?> p = pts[i];
      if (p == long.class || p == Long.class) {
        args[i] = (longs++ == 0) ? fromMs : toMs;
      } else if (p == boolean.class || p == Boolean.class) {
        args[i] = Boolean.FALSE;                 // rth flag → false (all bars)
      } else if (barSizeObj != null && p.isInstance(barSizeObj)) {
        args[i] = barSizeObj;
      } else if (p.isInterface()) {
        args[i] = Proxy.newProxyInstance(p.getClassLoader(), new Class<?>[]{ p }, new InvocationHandler() {
          @Override public Object invoke(Object proxy, Method method, Object[] callArgs) {
            Object bar = firstBarArg(callArgs);
            if (bar != null) {
              long   t = lng(bar, "getStartTime", "getTime", "getEndTime");
              double o = dbl(bar, "getOpen"), h = dbl(bar, "getHigh"),
                     l = dbl(bar, "getLow"),  c = dbl(bar, "getClose");
              double vv = dbl(bar, "getVolume");
              if (t > 1_000_000_000L && o > 0 && h >= l && !Double.isNaN(c)) {
                res.bars.add(barJson(t / 1000L, o, h, l, c, (long) vv));
                res.count++;
                if (res.earliestMs == 0 || t < res.earliestMs) res.earliestMs = t;
              }
            }
            Class<?> rt = method.getReturnType();
            if (rt == boolean.class || rt == Boolean.class) return Boolean.TRUE; // keep iterating
            if (rt == int.class)  return 0;
            if (rt == long.class) return 0L;
            return null;
          }
        });
      } else {
        args[i] = null; // unknown param — best effort
      }
    }
    fe.invoke(inst, args);
    return res;
  }

  private static class FeResult {
    final List<String> bars = new ArrayList<>();
    int  count = 0;
    long earliestMs = 0;
  }

  private static Object firstBarArg(Object[] args) {
    if (args == null) return null;
    for (Object a : args) {
      if (a != null && hasMethod(a, "getClose")) return a;
    }
    for (Object a : args) if (a != null) return a;
    return null;
  }

  private static boolean hasMethod(Object obj, String name) {
    try { obj.getClass().getMethod(name); return true; } catch (Exception e) { return false; }
  }

  private static double dbl(Object o, String... names) {
    for (String n : names) {
      try {
        Object v = o.getClass().getMethod(n).invoke(o);
        if (v instanceof Number) return ((Number) v).doubleValue();
      } catch (Exception ignored) {}
    }
    return Double.NaN;
  }

  private static long lng(Object o, String... names) {
    for (String n : names) {
      try {
        Object v = o.getClass().getMethod(n).invoke(o);
        if (v instanceof Number) return ((Number) v).longValue();
      } catch (Exception ignored) {}
    }
    return 0L;
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
