package com.custom;

import com.motivewave.platform.sdk.common.*;
import com.motivewave.platform.sdk.common.desc.*;
import com.motivewave.platform.sdk.study.*;

import java.io.File;
import java.io.FileWriter;
import java.io.PrintWriter;
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

@StudyHeader(
  namespace      = "com.custom",
  id             = "LIVE_BAR_RELAY",
  name           = "Live Bar Relay",
  label          = "LiveBarRelay",
  desc           = "Dumps full OHLCV history + relays live bars to localhost:5000. Use Data page to download.",
  overlay        = true,
  requiresVolume = true,
  signals        = false
)
public class LiveBarRelay extends Study {

  private static final String WS_ENDPOINT   = "ws://localhost:5000/ws/mw-feed";
  private static final int    BATCH_SIZE    = 500;   // bars per bulk_bars message
  private static final int    MAX_HISTORY   = Integer.MAX_VALUE; // no cap — dump everything MW has loaded

  private final HttpClient http = HttpClient.newBuilder()
    .connectTimeout(Duration.ofSeconds(4))
    .build();

  private final AtomicReference<WebSocket>            wsRef         = new AtomicReference<>();
  private final AtomicReference<CompletableFuture<?>> pendingSend   =
    new AtomicReference<>(CompletableFuture.completedFuture(null));

  // Set to true when WS connects — next calculate() call triggers a full history dump
  private final AtomicBoolean pendingHistoryDump = new AtomicBoolean(false);
  // Set to true once history has been dumped for the current connection
  private final AtomicBoolean historyDumped      = new AtomicBoolean(false);

  // ── Footprint accumulator — per-price bid/ask volume for the current 5m bucket ──
  private final TreeMap<Float, long[]> footprintLevels = new TreeMap<>(); // price → [bidVol, askVol]
  private volatile long   footprintBucketMs  = 0;   // current 5-min bucket start (epoch ms)
  private volatile String footprintSymbol    = "";   // symbol of current bucket
  // Fix 8 diagnostics: warn ONCE if SDK reflection misses the real method name
  private static final AtomicBoolean warnedNoVol  = new AtomicBoolean(false);
  private static final AtomicBoolean warnedNoSide = new AtomicBoolean(false);

  private final ScheduledExecutorService scheduler =
    Executors.newSingleThreadScheduledExecutor(r -> {
      Thread t = new Thread(r, "LiveBarRelay-reconnect");
      t.setDaemon(true);
      return t;
    });

  @Override
  public void initialize(Defaults defaults) {
    createSD();
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
          // Reset dump flag so history is re-sent for the new connection
          historyDumped.set(false);
          pendingHistoryDump.set(true);
          System.out.println("[LiveBarRelay] Connected to " + WS_ENDPOINT);
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

  // ── Tick callback ─────────────────────────────────────────────────────────────

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
      boolean bucketRolled  = footprintBucketMs != 0 && bucketMs != footprintBucketMs;
      boolean symbolChanged = !footprintSymbol.isEmpty() && !symbol.equals(footprintSymbol);
      if (bucketRolled || symbolChanged) {
        flushFootprintBar(footprintSymbol, footprintBucketMs);
        footprintLevels.clear();
      }
      footprintBucketMs = bucketMs;
      footprintSymbol   = symbol;

      // Extract volume and direction from the Tick object via reflection
      long    vol   = extractLong(tick, "getVolume", "getSize", "getQuantity", "getLastSize");
      boolean isAsk = extractBool(tick, "isAsk", "askTick", "isBuyTick");
      if (vol == 0 && warnedNoVol.compareAndSet(false, true))
        System.out.println("[LiveBarRelay] WARNING: no volume method matched on Tick — footprint volume is tick-count only. Fix extractLong() method names.");
      if (!isAsk && warnedNoSide.compareAndSet(false, true))
        System.out.println("[LiveBarRelay] WARNING: side method not matched on Tick (defaulting to bid). Fix extractBool() method names if all footprint delta is negative.");
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
    String     symbol = ctx.getInstrument().getSymbol();

    // ── History dump: fires once per WS connection, on the very first calculate() ──
    // Run in background so MW's calculation thread is never blocked by WS I/O.
    if (pendingHistoryDump.compareAndSet(true, false) && !historyDumped.get()) {
      historyDumped.set(true);
      final DataSeries snap = ds;
      final String    sym   = symbol;
      final int       tot   = total;
      scheduler.execute(() -> dumpHistory(snap, sym, tot));
    }

    // ── Live bar update (last bar only) ──────────────────────────────────────────
    if (index != total - 1) return;

    long    timeMs     = ds.getStartTime(index);
    float   open       = ds.getOpen(index);
    float   high       = ds.getHigh(index);
    float   low        = ds.getLow(index);
    float   close      = ds.getClose(index);
    long    volume     = (long) ds.getVolume(index);
    boolean complete   = ds.isBarComplete(index);
    String  resolution = inferResolution(ds, index);

    sendWs(String.format(
      "{\"type\":\"bar\",\"symbol\":\"%s\",\"resolution\":\"%s\"" +
      ",\"time\":%d,\"open\":%.4f,\"high\":%.4f,\"low\":%.4f,\"close\":%.4f" +
      ",\"volume\":%d,\"complete\":%b}",
      symbol, resolution,
      timeMs / 1000L, open, high, low, close, volume, complete));
  }

  // ── History dump ─────────────────────────────────────────────────────────────

  /**
   * Sends all historical bars (complete bars only) to the server in batches.
   * Skips the last bar (live/forming). Uses bulk_bars messages so the server
   * can batch-insert into cached_candles efficiently.
   */
  private void dumpHistory(DataSeries ds, String symbol, int total) {
    // Skip the very last bar (it's the forming live bar — sent via calculate())
    int end   = total - 1;
    int start = Math.max(0, end - MAX_HISTORY);

    // Robust resolution inference: the true bar interval is the SMALLEST positive gap between
    // consecutive bars. Sampling only the first pair can land on a session/weekend gap and
    // mis-infer (e.g. tag 1m bars as 60m), after which the server's alignment filter discards
    // 4 of every 5 genuine bars — leaving huge holes in the chart.
    String resolution = "1";
    long minDelta = Long.MAX_VALUE;
    for (int i = start + 1; i < end && i < start + 500; i++) {
      long d = ds.getStartTime(i) - ds.getStartTime(i - 1);
      if (d > 0 && d < minDelta) minDelta = d;
    }
    if (minDelta != Long.MAX_VALUE) resolution = inferResolutionFromDelta(minDelta);

    int barCount = end - start;
    System.out.printf("[LiveBarRelay] Dumping history: %d bars (%s) for %s%n",
      barCount, resolution, symbol);

    // Write CSV to disk so the web app can import bulk history without WS size limits
    String dumpPath = System.getProperty("user.home") + File.separator
      + "MotiveWave Extensions" + File.separator
      + "dump_" + symbol + "_" + resolution + ".csv";
    PrintWriter csvWriter = null;
    try {
      new File(System.getProperty("user.home") + File.separator + "MotiveWave Extensions").mkdirs();
      csvWriter = new PrintWriter(new FileWriter(dumpPath));
      csvWriter.println("timestamp,open,high,low,close,volume");
    } catch (Exception e) {
      System.out.println("[LiveBarRelay] CSV write failed: " + e.getMessage());
    }

    List<String> batch = new ArrayList<>(BATCH_SIZE);

    for (int i = start; i < end; i++) {
      long  timeMs = ds.getStartTime(i);
      float open   = ds.getOpen(i);
      float high   = ds.getHigh(i);
      float low    = ds.getLow(i);
      float close  = ds.getClose(i);
      long  volume = (long) ds.getVolume(i);

      if (high < low || open <= 0) continue;

      batch.add(String.format(
        "{\"t\":%d,\"o\":%.4f,\"h\":%.4f,\"l\":%.4f,\"c\":%.4f,\"v\":%d}",
        timeMs / 1000L, open, high, low, close, volume));

      if (csvWriter != null) {
        csvWriter.printf("%d,%.4f,%.4f,%.4f,%.4f,%d%n",
          timeMs / 1000L, open, high, low, close, volume);
      }

      if (batch.size() >= BATCH_SIZE) {
        flushBatch(symbol, resolution, batch);
        batch = new ArrayList<>(BATCH_SIZE);
      }
    }

    if (!batch.isEmpty()) {
      flushBatch(symbol, resolution, batch);
    }

    if (csvWriter != null) {
      csvWriter.close();
      System.out.printf("[LiveBarRelay] CSV written → %s%n", dumpPath);
    }

    System.out.printf("[LiveBarRelay] History dump complete (%d bars sent)%n", barCount);
  }

  private void flushBatch(String symbol, String resolution, List<String> bars) {
    WebSocket w = wsRef.get();
    if (w == null) return;
    String json = String.format(
      "{\"type\":\"bulk_bars\",\"symbol\":\"%s\",\"resolution\":\"%s\",\"bars\":[%s]}",
      symbol, resolution, String.join(",", bars));
    try {
      // Block until this batch is fully sent — sendWs() drops when previous is in-flight,
      // which causes all but the first batch to be silently lost during a history dump.
      w.sendText(json, true).get(10, TimeUnit.SECONDS);
    } catch (Exception e) {
      System.out.println("[LiveBarRelay] flushBatch error: " + e.getMessage());
      wsRef.set(null);
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  private String inferResolution(DataSeries ds, int index) {
    long minDelta = Long.MAX_VALUE;
    int from = Math.max(1, index - 50);
    for (int i = from; i <= index; i++) {
      long d = ds.getStartTime(i) - ds.getStartTime(i - 1);
      if (d > 0 && d < minDelta) minDelta = d;
    }
    return minDelta == Long.MAX_VALUE ? "1" : inferResolutionFromDelta(minDelta);
  }

  private static String inferResolutionFromDelta(long deltaMs) {
    long minutes = deltaMs / 60_000L;
    if (minutes >= 50) return "60";
    if (minutes >= 12) return "15";
    if (minutes >= 3)  return "5";
    return "1";
  }

  // ── WebSocket send ────────────────────────────────────────────────────────────

  private final java.util.concurrent.ConcurrentLinkedQueue<String> sendQueue =
      new java.util.concurrent.ConcurrentLinkedQueue<>();
  private static final int MAX_QUEUE = 1000;

  private void sendWs(String json) {
    WebSocket w = wsRef.get();
    if (w == null) return;
    if (sendQueue.size() >= MAX_QUEUE) sendQueue.poll(); // bound memory: drop OLDEST under pressure
    sendQueue.offer(json);
    pump(w);
  }

  private void pump(WebSocket w) {
    if (!pendingSend.get().isDone()) return; // a send is in flight; it will re-pump on completion
    String next = sendQueue.poll();
    if (next == null) return;
    CompletableFuture<?> f = w.sendText(next, true).whenComplete((r, e) -> {
      if (e != null) { wsRef.set(null); return; }
      WebSocket ww = wsRef.get();
      if (ww != null) pump(ww);
    });
    pendingSend.set(f);
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
