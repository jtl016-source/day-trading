package com.custom;

import com.motivewave.platform.sdk.common.*;
import com.motivewave.platform.sdk.common.desc.*;
import com.motivewave.platform.sdk.study.*;
import com.motivewave.platform.sdk.study.DataContext;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.WebSocket;
import java.time.Duration;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

@StudyHeader(
  namespace      = "com.custom",
  id             = "TICK_RELAY",
  name           = "Tick Relay",
  label          = "TickRelay",
  desc           = "Relays live tick prices and OHLCV bars to local server on localhost:5000 via WebSocket",
  overlay        = true,
  requiresVolume = true,
  signals        = false
)
public class TickRelay extends Study {

  private static final String WS_ENDPOINT = "ws://localhost:5000/ws/mw-feed";

  private final HttpClient http = HttpClient.newBuilder()
    .connectTimeout(Duration.ofSeconds(3))
    .build();

  private final AtomicReference<WebSocket>             wsRef        = new AtomicReference<>();
  private final AtomicReference<Float>                 lastTickPrice = new AtomicReference<>(0f);
  private final AtomicReference<CompletableFuture<?>>  pendingSend  =
    new AtomicReference<>(CompletableFuture.completedFuture(null));

  private final ScheduledExecutorService scheduler =
    Executors.newSingleThreadScheduledExecutor(r -> {
      Thread t = new Thread(r, "TickRelay-reconnect");
      t.setDaemon(true);
      return t;
    });

  @Override
  public void initialize(Defaults defaults) {
    createSD();
    connect();
    // Reconnect every 3 seconds if the WebSocket drops
    scheduler.scheduleAtFixedRate(this::reconnectIfNeeded, 3, 3, TimeUnit.SECONDS);
  }

  // ── WebSocket lifecycle ────────────────────────────────────────────────────

  private void connect() {
    http.newWebSocketBuilder()
      .connectTimeout(Duration.ofSeconds(3))
      .buildAsync(URI.create(WS_ENDPOINT), new WebSocket.Listener() {
        @Override
        public void onOpen(WebSocket ws) {
          wsRef.set(ws);
          ws.request(Long.MAX_VALUE); // allow unlimited incoming messages (we don't read any)
        }

        @Override
        public CompletionStage<?> onClose(WebSocket ws, int statusCode, String reason) {
          wsRef.set(null);
          return null;
        }

        @Override
        public void onError(WebSocket ws, Throwable error) {
          wsRef.set(null);
        }
      })
      .exceptionally(e -> null); // failed connect — reconnect timer will retry
  }

  private void reconnectIfNeeded() {
    if (wsRef.get() == null) connect();
  }

  // ── Tick / bar callbacks ───────────────────────────────────────────────────

  /**
   * Called on every live tick from the broker feed.
   * Fastest possible path — fires before calculate().
   */
  @Override
  public void onTick(DataContext ctx, Tick tick) {
    float price = tick.getPrice();
    lastTickPrice.set(price);

    String symbol = ctx.getInstrument().getSymbol();
    long   now    = System.currentTimeMillis();

    sendWs(String.format(
      "{\"type\":\"tick\",\"symbol\":\"%s\",\"price\":%.4f,\"time\":%d}",
      symbol, price, now
    ));
  }

  /**
   * Called by MW every time a bar recalculates — includes every tick on the live bar.
   * Used as fallback when onTick() doesn't fire (e.g. ETH session).
   * Also sends completed OHLCV bars for persistence.
   */
  @Override
  protected void calculate(int index, DataContext ctx) {
    DataSeries ds = ctx.getDataSeries();
    if (index != ds.size() - 1) return; // only the live (last) bar

    String  symbol   = ctx.getInstrument().getSymbol();
    long    timeMs   = ds.getStartTime(index);
    float   open     = ds.getOpen(index);
    float   high     = ds.getHigh(index);
    float   low      = ds.getLow(index);
    float   close    = ds.getClose(index);
    long    volume   = (long) ds.getVolume(index);
    boolean complete = ds.isBarComplete(index);
    long    now      = System.currentTimeMillis();

    // Tick fallback: send if price changed since last onTick
    if (close != lastTickPrice.get()) {
      lastTickPrice.set(close);
      sendWs(String.format(
        "{\"type\":\"tick\",\"symbol\":\"%s\",\"price\":%.4f,\"time\":%d}",
        symbol, close, now
      ));
    }

    // Always send full bar (server persists completed bars to DB)
    sendWs(String.format(
      "{\"type\":\"bar\",\"symbol\":\"%s\",\"time\":%d,\"open\":%.4f,\"high\":%.4f,\"low\":%.4f,\"close\":%.4f,\"volume\":%d,\"complete\":%b}",
      symbol, timeMs / 1000L, open, high, low, close, volume, complete
    ));
  }

  // ── WebSocket send ─────────────────────────────────────────────────────────

  private void sendWs(String json) {
    WebSocket w = wsRef.get();
    if (w == null) return;
    // Java WebSocket throws IllegalStateException if sendText is called concurrently.
    // Drop the message if the previous send hasn't completed (on localhost this is rare).
    if (!pendingSend.get().isDone()) return;
    CompletableFuture<?> f = w.sendText(json, true).exceptionally(e -> {
      wsRef.set(null); // mark as disconnected so reconnect timer kicks in
      return null;
    });
    pendingSend.set(f);
  }
}
