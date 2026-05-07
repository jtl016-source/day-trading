package com.custom;

import com.motivewave.platform.sdk.common.*;
import com.motivewave.platform.sdk.order_mgmt.*;
import com.motivewave.platform.sdk.study.*;
import java.lang.reflect.Array;
import java.lang.reflect.Method;
import java.net.URI;
import java.net.http.*;
import java.time.Duration;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;

@StudyHeader(
  namespace      = "com.custom",
  id             = "AUTO_TRADER",
  name           = "Auto Trader",
  label          = "AutoTrader",
  desc           = "Receives order commands from Milks Yellow Box app and places bracket orders via MotiveWave",
  overlay        = true,
  signals        = true,
  strategy       = true,
  requiresBarUpdates = true
)
public class AutoTrader extends Study {

  private static final class PendingTrade {
    final String direction;
    final double entry, tp1, tp2, sl;
    final int    contracts;
    final boolean tp1Only;    // when true, skip TP2 — full qty exits at TP1
    // Trailer mode: TP1 is the activation level (not a fixed limit exit).
    // Once price reaches tp1 (tp1Activation), a trailing stop is armed with trailingOffset pts.
    // TP2 is unused in trailer mode — Trailer takes priority (see submitBracket + onBarUpdate).
    final boolean useTrailer;
    final double  trailingOffset;  // pts to trail behind the peak after TP1 activation
    PendingTrade(String d, double e, double t1, double t2, double s, int c, boolean tp1Only,
                 boolean useTrailer, double trailingOffset) {
      direction=d; entry=e; tp1=t1; tp2=t2; sl=s; contracts=c; this.tp1Only=tp1Only;
      this.useTrailer=useTrailer; this.trailingOffset=trailingOffset;
    }
  }

  // pendingTrade is static — ensures only one trade queued at a time across all instances.
  // instanceOrderCtx is per-instance — the WS message handler uses THIS instance's own ctx,
  // so the instance that receives the order command places it with its own MotiveWave context.
  private static final AtomicReference<PendingTrade> pendingTrade = new AtomicReference<>();
  private volatile Object instanceOrderCtx = null; // set by this instance's own lifecycle callbacks
  private volatile WebSocket ws;
  private ScheduledExecutorService scheduler;

  // ── Trailer state (per-instance, reset on each new trade and on position close) ──
  // Thread safety: all trailer fields are read/written only from MotiveWave's bar callbacks
  // (onBarUpdate, onBarClose) which are called sequentially — no concurrent access.
  private volatile PendingTrade activeTrailerTrade = null;  // non-null while a trailer trade is live
  private volatile boolean      trailerArmed       = false; // true once price crossed tp1Activation
  private volatile double       trailPeak          = 0;     // highest (long) or lowest (short) since arming
  private volatile boolean      nativeTrailActive  = false; // true if MW trailing stop order was submitted

  private static void logFile(String msg) {
    try {
      java.nio.file.Files.writeString(
        java.nio.file.Path.of(System.getProperty("user.home") + "/autotrader_log.txt"),
        java.time.LocalDateTime.now() + " " + msg + "\n",
        java.nio.file.StandardOpenOption.CREATE, java.nio.file.StandardOpenOption.APPEND);
    } catch (Exception ignored) {}
  }

  @Override
  public void initialize(Defaults defaults) {
    logFile("=== AutoTrader v18 initialize() called ===");
    pendingTrade.set(null);
    resetTrailerState();
    createSD();
    connect();
    scheduler = Executors.newScheduledThreadPool(1, r -> {
      Thread t = new Thread(r, "AutoTrader-bg");
      t.setDaemon(true);
      return t;
    });
    scheduler.scheduleAtFixedRate(this::reconnectIfNeeded, 1, 1, TimeUnit.SECONDS);
  }

  // ── Strategy lifecycle callbacks — any that receive OrderContext are usable for orders ──

  @Override
  public void onActivate(OrderContext ctx) {
    logFile("onActivate(OrderContext) ctx=" + ctx.getClass().getName());
    instanceOrderCtx = ctx;
    // If a trade was queued before activation, place it now
    PendingTrade trade = pendingTrade.getAndSet(null);
    if (trade != null) { logFile("onActivate — placing queued order"); placeOrder(ctx, trade); }
  }

  @Override
  public void onBarOpen(OrderContext ctx) {
    logFile("onBarOpen(OrderContext)");
    instanceOrderCtx = ctx;
    PendingTrade trade = pendingTrade.getAndSet(null);
    if (trade != null) { logFile("onBarOpen — placing order"); placeOrder(ctx, trade); }
  }

  @Override
  public void onBarClose(OrderContext ctx) {
    logFile("onBarClose(OrderContext)");
    instanceOrderCtx = ctx;
    PendingTrade trade = pendingTrade.getAndSet(null);
    if (trade != null) { logFile("onBarClose — placing order"); placeOrder(ctx, trade); }
  }

  @Override
  public void onBarUpdate(OrderContext ctx) {
    instanceOrderCtx = ctx;
    PendingTrade trade = pendingTrade.getAndSet(null);
    if (trade != null) { logFile("onBarUpdate — placing order"); placeOrder(ctx, trade); }

    // ── Trailer monitoring: runs on every bar update while a trailer trade is active ──
    PendingTrade t = activeTrailerTrade;
    if (t != null && t.useTrailer && !nativeTrailActive) {
      double curPrice = getCurrentPriceFromCtx(ctx);
      if (curPrice <= 100) return; // no valid price yet
      boolean isLong = "Long".equals(t.direction);

      if (!trailerArmed) {
        // Phase 1: wait for price to reach the TP1 activation level
        boolean activated = isLong ? curPrice >= t.tp1 : curPrice <= t.tp1;
        if (activated) {
          trailerArmed = true;
          trailPeak    = curPrice;
          logFile(String.format("Trailer ARMED at %.2f (activation=%.2f trail=%.2f)",
            curPrice, t.tp1, t.trailingOffset));
          // Attempt to submit a native MW trailing stop order now that TP1 is hit
          nativeTrailActive = trySubmitTrailingStop(ctx, t, curPrice);
          if (nativeTrailActive) {
            logFile("Native MW trailing stop submitted — manual tracking disabled");
          } else {
            logFile("MW trailing stop unavailable — using manual trail tracking");
          }
        }
      } else {
        // Phase 2: trail the peak and exit when price retreats trailingOffset pts
        if (isLong) {
          if (curPrice > trailPeak) trailPeak = curPrice;
          double trailTrigger = trailPeak - t.trailingOffset;
          if (curPrice <= trailTrigger) {
            logFile(String.format("Trailer EXIT long: price=%.2f peak=%.2f trigger=%.2f",
              curPrice, trailPeak, trailTrigger));
            submitMarketExit(ctx, t);
            resetTrailerState();
          }
        } else {
          if (curPrice < trailPeak) trailPeak = curPrice;
          double trailTrigger = trailPeak + t.trailingOffset;
          if (curPrice >= trailTrigger) {
            logFile(String.format("Trailer EXIT short: price=%.2f peak=%.2f trigger=%.2f",
              curPrice, trailPeak, trailTrigger));
            submitMarketExit(ctx, t);
            resetTrailerState();
          }
        }
      }
    }
  }

  @Override
  public void onSignal(OrderContext ctx, Object signal) {
    logFile("onSignal() fired signal=" + signal);
    instanceOrderCtx = ctx;
    PendingTrade trade = (signal instanceof PendingTrade) ? (PendingTrade) signal : pendingTrade.get();
    pendingTrade.set(null);
    if (trade != null) { logFile("onSignal — placing order"); placeOrder(ctx, trade); }
  }

  @Override
  public void onPositionClosed(OrderContext ctx) {
    logFile("onPositionClosed — cancelling remaining orders, staying active for next signal");
    cancelAllOrders(ctx);   // cancel TP1/TP2 limits that may still be open after SL fills
    pendingTrade.set(null);
    resetTrailerState();
    sendMsg("{\"type\":\"position_closed\"}");
    // Do NOT deactivate — strategy stays live so it can receive the next order_command
    // without requiring a manual reload of the study in MotiveWave.
  }

  @Override
  public void calculate(int index, DataContext ctx) {
    // Nothing needed here — order placement uses OrderContext callbacks above
  }

  public void destroy() {
    if (scheduler != null) scheduler.shutdownNow();
    if (ws != null) { try { ws.abort(); } catch (Exception ignored) {} }
  }

  private void placeOrder(Object ctx, PendingTrade trade) {
    try {
      submitBracket(ctx, "Long".equals(trade.direction),
        trade.contracts, trade.entry, trade.tp1, trade.tp2, trade.sl, trade.tp1Only, trade.useTrailer);
      // Arm the trailer state so onBarUpdate starts monitoring price
      if (trade.useTrailer) {
        activeTrailerTrade = trade;
        trailerArmed       = false;
        trailPeak          = 0;
        nativeTrailActive  = false;
        logFile(String.format("Trailer mode armed: activation=%.2f trail=%.2f",
          trade.tp1, trade.trailingOffset));
      }
      logFile("order_ack dir=" + trade.direction + " entry=" + trade.entry
        + (trade.useTrailer ? " TRAILER trail=" + trade.trailingOffset : ""));
      sendMsg(String.format(
        "{\"type\":\"order_ack\",\"direction\":\"%s\",\"entry\":%.2f,\"tp1\":%.2f,\"tp2\":%.2f,\"sl\":%.2f,\"qty\":%d,\"useTrailer\":%b}",
        trade.direction, trade.entry, trade.tp1, trade.tp2, trade.sl, trade.contracts, trade.useTrailer));
    } catch (Exception e) {
      String err = e.getClass().getSimpleName() + ": " + e.getMessage();
      logFile("placeOrder FAILED: " + err);
      e.printStackTrace();
      sendMsg("{\"type\":\"order_error\",\"error\":" + jsonStr(err) + "}");
    }
  }

  /**
   * Attempts to deactivate the strategy via reflection so MotiveWave stops
   * sending bar/signal callbacks and the strategy shows as "inactive".
   * Tries FLAT, INACTIVE, DISABLED enum constants in order.
   */
  @SuppressWarnings({"unchecked","rawtypes"})
  private void deactivateStrategy(Object ctx) {
    try {
      // Find setState on this Study (StudyBase)
      java.lang.reflect.Method setStateMethod = null;
      for (java.lang.reflect.Method m : this.getClass().getMethods()) {
        if (m.getName().equals("setState") && m.getParameterCount() == 1) {
          setStateMethod = m; break;
        }
      }
      if (setStateMethod == null) {
        for (java.lang.reflect.Method m : this.getClass().getSuperclass().getMethods()) {
          if (m.getName().equals("setState") && m.getParameterCount() == 1) {
            setStateMethod = m; break;
          }
        }
      }
      if (setStateMethod == null) { logFile("deactivate: setState not found"); return; }

      Class<?> stateCls = setStateMethod.getParameterTypes()[0];
      logFile("deactivate: stateCls=" + stateCls.getName());
      // Try common enum constants for "inactive/flat" state
      for (String name : new String[]{"FLAT", "INACTIVE", "DISABLED", "IDLE", "STOPPED"}) {
        try {
          Object val = Enum.valueOf((Class<Enum>) stateCls, name);
          setStateMethod.invoke(this, val);
          logFile("deactivate: setState(" + name + ") OK");
          return;
        } catch (Exception ignored) {}
      }
      logFile("deactivate: no matching enum constant found in " + stateCls.getName());
    } catch (Exception e) {
      logFile("deactivate FAILED: " + e.getMessage());
    }
  }

  /**
   * Scans ctx for any no-arg method returning a double/float whose name
   * suggests a market price (close, last, bid, ask, price).
   * Returns the first plausible price (> 100 for ES/MES) found, or 0 if none.
   */
  private double getCurrentPriceFromCtx(Object ctx) {
    for (java.lang.reflect.Method m : ctx.getClass().getMethods()) {
      if (m.getParameterCount() != 0) continue;
      Class<?> ret = m.getReturnType();
      if (ret != double.class && ret != Double.class &&
          ret != float.class  && ret != Float.class)  continue;
      String n = m.getName().toLowerCase();
      if (!n.contains("price") && !n.contains("close") &&
          !n.contains("last")  && !n.contains("bid")   && !n.contains("ask")) continue;
      try {
        Object v = m.invoke(ctx);
        if (v instanceof Number) {
          double p = ((Number) v).doubleValue();
          if (p > 100) { // sanity: ES/MES always > 100
            logFile("getCurrentPrice=" + p + " via " + m.getName());
            return p;
          }
        }
      } catch (Exception ignored) {}
    }
    return 0;
  }

  /**
   * All reflection uses ctx's OWN class loader so enum/interface types match
   * exactly what bp.m (MotiveWave's internal class) expects — bypasses class
   * loader mismatch that causes instanceof OrderContext to return false.
   */
  @SuppressWarnings({"unchecked","rawtypes"})
  private void submitBracket(Object ctx, boolean isLong, int qty,
                              double entry, double tp1, double tp2, double sl,
                              boolean tp1Only, boolean useTrailer) throws Exception {
    Class<?> ctxCls = ctx.getClass();

    // Discover all needed methods by name — never load types by name since they
    // may be obfuscated at runtime even though the SDK JAR uses readable names.
    Method mkMkt = null, mkLimit = null, mkStop = null, mkStopLimit = null, submit = null;
    for (Method m : ctxCls.getMethods()) {
      switch (m.getName()) {
        case "createMarketOrder":    if (m.getParameterCount() == 2) mkMkt       = m; break;
        case "createLimitOrder":     if (m.getParameterCount() == 4) mkLimit     = m; break;
        case "createStopOrder":      if (m.getParameterCount() == 4) mkStop      = m; break;
        // 5-param stop-limit: (action, tif, qty, stopPrice, limitPrice)
        case "createStopLimitOrder": if (m.getParameterCount() == 5) mkStopLimit = m; break;
        case "submitOrders":
          // Prefer varargs/array overload (Order[]) over single-Order overload
          if (submit == null) { submit = m; break; }
          boolean newIsArray = m.getParameterCount() == 1 && m.getParameterTypes()[0].isArray();
          boolean curIsArray = submit.getParameterCount() == 1 && submit.getParameterTypes()[0].isArray();
          if (newIsArray && !curIsArray) submit = m;
          break;
      }
    }
    if (mkMkt   == null) throw new Exception("createMarketOrder(2) not found on " + ctxCls.getName());
    if (mkLimit == null) throw new Exception("createLimitOrder(4) not found on " + ctxCls.getName());
    if (mkStop  == null) throw new Exception("createStopOrder(4) not found on " + ctxCls.getName());
    if (submit  == null) throw new Exception("submitOrders not found on " + ctxCls.getName());
    logFile("createStopLimitOrder(5) " + (mkStopLimit != null ? "FOUND — will use stop-limit" : "not found — falling back to stop-market"));

    // Derive enum and order types from the methods themselves (handles obfuscation)
    Class<?> actualActionCls = mkMkt.getParameterTypes()[0];   // e.g. Enums$OrderAction or obfuscated
    Class<?> actualTifCls    = mkLimit.getParameterTypes()[1];  // e.g. Enums$TIF or obfuscated
    Class<?> orderCls        = mkMkt.getReturnType();           // e.g. Order or obfuscated

    logFile("actionCls=" + actualActionCls.getName() + " tifCls=" + actualTifCls.getName() + " orderCls=" + orderCls.getName());

    Object entryAction = Enum.valueOf((Class<Enum>) actualActionCls, isLong ? "BUY"  : "SELL");
    Object exitAction  = Enum.valueOf((Class<Enum>) actualActionCls, isLong ? "SELL" : "BUY");
    Object gtc         = Enum.valueOf((Class<Enum>) actualTifCls, "GTC");

    // Log ALL param types so we can see exactly what each method expects
    StringBuilder ptLog = new StringBuilder("param types — ");
    ptLog.append("mkMkt(");
    for (Class<?> p : mkMkt.getParameterTypes()) ptLog.append(p.getSimpleName()).append(",");
    ptLog.append(") mkStop(");
    for (Class<?> p : mkStop.getParameterTypes()) ptLog.append(p.getSimpleName()).append(",");
    if (mkStopLimit != null) {
      ptLog.append(") mkStopLimit(");
      for (Class<?> p : mkStopLimit.getParameterTypes()) ptLog.append(p.getSimpleName()).append(",");
    }
    ptLog.append(") mkLimit(");
    for (Class<?> p : mkLimit.getParameterTypes()) ptLog.append(p.getSimpleName()).append(",");
    ptLog.append(")");
    logFile(ptLog.toString());

    // Auto-convert each argument to the exact type the method expects
    Class<?>[] mktP   = mkMkt.getParameterTypes();
    Class<?>[] stopP  = mkStop.getParameterTypes();
    Class<?>[] limitP = mkLimit.getParameterTypes();

    // SL is used exactly as sent by the app — no adjustment.
    // The signal already places SL on the correct side of entry (Long: below, Short: above).
    logFile(String.format("SL as-received: %.2f (entry=%.2f, %s)", sl, entry, isLong ? "Long" : "Short"));

    Object mktQty = toNum(mktP[1], qty);
    Object tp1Arg = toNum(limitP[3], tp1);

    Object entryOrder = mkMkt.invoke(ctx, entryAction, mktQty);

    // Use stop-LIMIT order if available — caps fill slippage to STOP_SLIP_PTS beyond the SL.
    // Stop-market orders can fill several points past SL in fast markets; stop-limit prevents this.
    // If market gaps more than STOP_SLIP_PTS through SL, the limit will not fill — this is
    // acceptable for MES/ES where 2pt gaps at the SL are rare in normal RTH conditions.
    final double STOP_SLIP_PTS = 2.0;
    Object stopOrder;
    if (mkStopLimit != null) {
      Class<?>[] slP    = mkStopLimit.getParameterTypes();
      double limitPrice = isLong ? sl - STOP_SLIP_PTS : sl + STOP_SLIP_PTS;
      Object stopQtyArg = toNum(slP[2], qty);
      Object slStopArg  = toNum(slP[3], sl);
      Object slLimArg   = toNum(slP[4], limitPrice);
      stopOrder = mkStopLimit.invoke(ctx, exitAction, gtc, stopQtyArg, slStopArg, slLimArg);
      logFile(String.format("Stop-LIMIT order: stop=%.2f limit=%.2f (%s, slip=%.2f pts)",
        sl, limitPrice, isLong ? "Long" : "Short", STOP_SLIP_PTS));
    } else {
      Object stopQty = toNum(stopP[2], qty);
      Object slArg   = toNum(stopP[3], sl);
      stopOrder = mkStop.invoke(ctx, exitAction, gtc, stopQty, slArg);
      logFile(String.format("Stop-MARKET order (fallback): stop=%.2f — slippage not bounded", sl));
    }

    // Log which submitOrders we found
    Class<?>[] submitP = submit.getParameterTypes();
    StringBuilder sLog = new StringBuilder("submitOrders: paramCount=").append(submitP.length).append(" [");
    for (Class<?> p : submitP) sLog.append(p.getSimpleName()).append(",");
    sLog.append("] isVarArgs=").append(submit.isVarArgs());
    logFile(sLog.toString());

    // Build order list — useTrailer skips TP1/TP2 limits (trailing logic fires in onBarUpdate).
    // tp1Only puts all contracts at TP1; otherwise split half/half at TP1 and TP2.
    java.util.List<Object> orders = new java.util.ArrayList<>();
    orders.add(entryOrder);
    orders.add(stopOrder);
    if (useTrailer) {
      // Trailer mode: no TP1 or TP2 limit orders — onBarUpdate manages the trailing exit.
      // The fixed SL (stopOrder above) protects the trade before TP1 activation.
      logFile(String.format("submitOrders trailer: %s entry=%.2f tp1_activation=%.2f sl=%.2f qty=%d",
        isLong ? "LONG" : "SHORT", entry, tp1, sl, qty));
    } else if (tp1Only) {
      Object lmAll = toNum(limitP[2], qty);
      Object tp1OrderFull = mkLimit.invoke(ctx, exitAction, gtc, lmAll, tp1Arg);
      orders.add(tp1OrderFull);
      logFile(String.format("submitOrders tp1Only: %s entry=%.2f tp1=%.2f sl=%.2f qty=%d",
        isLong ? "LONG" : "SHORT", entry, tp1, sl, qty));
    } else {
      int half = Math.max(1, qty / 2);
      int rest = qty - half;
      Object lmHalf = toNum(limitP[2], half);
      Object lmRest = toNum(limitP[2], rest > 0 ? rest : half);
      Object tp2Arg = toNum(limitP[3], tp2);
      Object tp1Order = mkLimit.invoke(ctx, exitAction, gtc, lmHalf, tp1Arg);
      Object tp2Order = mkLimit.invoke(ctx, exitAction, gtc, lmRest, tp2Arg);
      orders.add(tp1Order);
      orders.add(tp2Order);
      logFile(String.format("submitOrders: %s entry=%.2f tp1=%.2f tp2=%.2f sl=%.2f qty=%d",
        isLong ? "LONG" : "SHORT", entry, tp1, tp2, sl, qty));
    }

    // Invoke submitOrders — handle varargs/array vs individual-arg overloads
    Object ordersArr = Array.newInstance(orderCls, orders.size());
    for (int i = 0; i < orders.size(); i++) Array.set(ordersArr, i, orders.get(i));

    if (submitP.length == 1 && submitP[0].isArray()) {
      // submitOrders(Order[]) or submitOrders(Order...) — pass array as single arg
      // new Object[]{ordersArr} prevents reflection from spreading Order[] as individual args
      submit.invoke(ctx, new Object[]{ordersArr});
    } else {
      // submitOrders(Order, Order, ...) — pass individually
      submit.invoke(ctx, orders.toArray());
    }
    logFile("submitOrders() OK");
  }

  /** Convert a numeric value to exactly the primitive type the method parameter expects. */
  private static Object toNum(Class<?> targetType, double val) {
    if (targetType == float.class  || targetType == Float.class)  return (float)  val;
    if (targetType == double.class || targetType == Double.class) return val;
    if (targetType == long.class   || targetType == Long.class)   return (long)   val;
    if (targetType == int.class    || targetType == Integer.class) return (int)   val;
    return val; // fallback
  }

  // ── Trailer helpers ───────────────────────────────────────────────────────

  private void resetTrailerState() {
    activeTrailerTrade = null;
    trailerArmed       = false;
    trailPeak          = 0;
    nativeTrailActive  = false;
  }

  /**
   * Cancels all remaining open orders via reflection.
   * Called on position close (SL or TP) so that surviving bracket legs
   * (e.g. the TP1/TP2 limit orders after SL fires) do not linger in MW.
   * Tries the most common cancel-all method names in order.
   */
  private void cancelAllOrders(Object ctx) {
    String[] candidates = { "cancelAllOrders", "cancelAll", "flattenAll", "cancelOpenOrders", "cancelOrders" };
    for (java.lang.reflect.Method m : ctx.getClass().getMethods()) {
      if (m.getParameterCount() != 0) continue;
      for (String name : candidates) {
        if (m.getName().equals(name)) {
          try {
            m.invoke(ctx);
            logFile("cancelAllOrders: called " + name + "() — bracket orders cancelled");
            sendMsg("{\"type\":\"orders_cancelled\",\"msg\":\"Remaining orders cancelled\"}");
          } catch (Exception e) {
            logFile("cancelAllOrders " + name + " FAILED: " + e.getMessage());
          }
          return;  // found and attempted — done regardless of success
        }
      }
    }
    logFile("cancelAllOrders: no cancel method found on " + ctx.getClass().getName());
  }

  /**
   * Submits a market exit order to close the full position.
   * Used by the manual trailer tracking path when price retreats past the trail trigger.
   */
  @SuppressWarnings({"unchecked","rawtypes"})
  private void submitMarketExit(Object ctx, PendingTrade trade) {
    try {
      Class<?> ctxCls = ctx.getClass();
      Method mkMkt = null, submit = null;
      for (Method m : ctxCls.getMethods()) {
        if ("createMarketOrder".equals(m.getName()) && m.getParameterCount() == 2) mkMkt = m;
        if ("submitOrders".equals(m.getName())) {
          if (submit == null) { submit = m; }
          else if (m.getParameterCount() == 1 && m.getParameterTypes()[0].isArray()) submit = m;
        }
      }
      if (mkMkt == null || submit == null) { logFile("submitMarketExit: methods not found"); return; }

      Class<?> actionCls = mkMkt.getParameterTypes()[0];
      boolean isLong = "Long".equals(trade.direction);
      Object exitAction = Enum.valueOf((Class<Enum>) actionCls, isLong ? "SELL" : "BUY");
      Object qtyArg     = toNum(mkMkt.getParameterTypes()[1], trade.contracts);
      Object exitOrder  = mkMkt.invoke(ctx, exitAction, qtyArg);

      Class<?> orderCls  = mkMkt.getReturnType();
      Object   ordersArr = Array.newInstance(orderCls, 1);
      Array.set(ordersArr, 0, exitOrder);
      Class<?>[] submitP = submit.getParameterTypes();
      if (submitP.length == 1 && submitP[0].isArray()) {
        submit.invoke(ctx, new Object[]{ordersArr});
      } else {
        submit.invoke(ctx, exitOrder);
      }
      logFile("submitMarketExit OK — trail triggered");
      sendMsg("{\"type\":\"trailer_exit\",\"msg\":\"Trailing stop triggered — market exit placed\"}");
    } catch (Exception e) {
      logFile("submitMarketExit FAILED: " + e.getMessage());
    }
  }

  /**
   * Attempts to submit a native MotiveWave trailing stop order via reflection.
   * Searches for createTrailingStopOrder with 4 or 5 parameters.
   *
   * 4-param form: (OrderAction, TIF, qty, trailAmount)           — trails from current price
   * 5-param form: (OrderAction, TIF, qty, trailAmount, activation) — activates at a trigger price
   *
   * Returns true if the order was successfully submitted, false if the method is not available.
   * If false, the caller falls back to manual trail tracking in onBarUpdate.
   */
  @SuppressWarnings({"unchecked","rawtypes"})
  private boolean trySubmitTrailingStop(Object ctx, PendingTrade trade, double currentPrice) {
    try {
      Class<?> ctxCls = ctx.getClass();
      Method mkTrail = null;
      for (Method m : ctxCls.getMethods()) {
        if (!"createTrailingStopOrder".equals(m.getName())) continue;
        int pc = m.getParameterCount();
        if (pc == 4 || pc == 5) { mkTrail = m; break; }
      }
      if (mkTrail == null) {
        logFile("createTrailingStopOrder not found on " + ctxCls.getName() + " — manual tracking");
        return false;
      }

      Class<?> actionCls = mkTrail.getParameterTypes()[0];
      Class<?> tifCls    = mkTrail.getParameterTypes()[1];
      boolean  isLong    = "Long".equals(trade.direction);
      Object exitAction  = Enum.valueOf((Class<Enum>) actionCls, isLong ? "SELL" : "BUY");
      Object gtc         = Enum.valueOf((Class<Enum>) tifCls, "GTC");
      Object qtyArg      = toNum(mkTrail.getParameterTypes()[2], trade.contracts);
      Object trailArg    = toNum(mkTrail.getParameterTypes()[3], trade.trailingOffset);

      Object trailOrder;
      if (mkTrail.getParameterCount() == 5) {
        // Pass currentPrice as the activation level — trail starts from where TP1 was hit
        Object activationArg = toNum(mkTrail.getParameterTypes()[4], currentPrice);
        trailOrder = mkTrail.invoke(ctx, exitAction, gtc, qtyArg, trailArg, activationArg);
      } else {
        trailOrder = mkTrail.invoke(ctx, exitAction, gtc, qtyArg, trailArg);
      }

      // Submit via submitOrders
      Method submit = null;
      for (Method m : ctxCls.getMethods()) {
        if (!"submitOrders".equals(m.getName())) continue;
        if (submit == null) { submit = m; }
        else if (m.getParameterCount() == 1 && m.getParameterTypes()[0].isArray()) submit = m;
      }
      if (submit == null) { logFile("submitOrders not found for trailing stop"); return false; }

      Class<?> orderCls  = mkTrail.getReturnType();
      Object   ordersArr = Array.newInstance(orderCls, 1);
      Array.set(ordersArr, 0, trailOrder);
      Class<?>[] submitP = submit.getParameterTypes();
      if (submitP.length == 1 && submitP[0].isArray()) {
        submit.invoke(ctx, new Object[]{ordersArr});
      } else {
        submit.invoke(ctx, trailOrder);
      }
      logFile(String.format("Native trailing stop submitted: trail=%.2f activation=%.2f",
        trade.trailingOffset, currentPrice));
      sendMsg(String.format(
        "{\"type\":\"trailer_armed\",\"activation\":%.2f,\"trail\":%.2f,\"native\":true}",
        currentPrice, trade.trailingOffset));
      return true;
    } catch (Exception e) {
      logFile("trySubmitTrailingStop FAILED: " + e.getMessage());
      return false;
    }
  }

  // ── WebSocket ──────────────────────────────────────────────────────────────

  private void connect() {
    try {
      ws = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3)).build()
        .newWebSocketBuilder().connectTimeout(Duration.ofSeconds(3))
        .buildAsync(URI.create("ws://localhost:5000/ws/order-commands"), new WebSocket.Listener() {
          public java.util.concurrent.CompletionStage<?> onText(WebSocket ws, CharSequence data, boolean last) {
            handleMessage(data.toString()); ws.request(1); return null;
          }
          public void onError(WebSocket ws, Throwable err) { AutoTrader.this.ws = null; }
          public java.util.concurrent.CompletionStage<?> onClose(WebSocket ws, int sc, String r) {
            AutoTrader.this.ws = null; return null;
          }
        }).join();
      ws.request(Long.MAX_VALUE);
      logFile("WS connected");
    } catch (Exception e) { ws = null; }
  }

  private void reconnectIfNeeded() { if (ws == null) connect(); }

  private void handleMessage(String json) {
    logFile("Recv: " + json.substring(0, Math.min(json.length(), 120)));
    if (json.contains("reset_flag")) {
      pendingTrade.set(null);
      logFile("pending trade cleared by app");
      sendMsg("{\"type\":\"flag_reset\"}");
      return;
    }
    if (!json.contains("order_command")) return;

    String direction      = json.contains("\"Long\"") ? "Long" : "Short";
    double entry          = extractDouble(json, "price");
    double sl             = extractDouble(json, "sl");
    double tp1            = extractDouble(json, "tp1");
    double tp2            = extractDouble(json, "tp2");
    int    contracts      = Math.max(1, (int) extractDouble(json, "contracts"));
    boolean tp1Only       = json.contains("\"tp1Only\":true");
    // Trailer fields: useTrailer=true means TP1 is activation level, not a fixed exit
    boolean useTrailer    = json.contains("\"useTrailer\":true");
    double trailingOffset = useTrailer ? extractDouble(json, "trailingOffset") : 0;
    if (useTrailer && trailingOffset <= 0) trailingOffset = 2.0; // default 2 pts if missing

    if (entry <= 0 || sl <= 0) {
      sendMsg("{\"type\":\"order_error\",\"error\":\"price or sl is 0\"}");
      return;
    }

    PendingTrade trade = new PendingTrade(direction, entry, tp1, tp2, sl, contracts, tp1Only,
                                          useTrailer, trailingOffset);
    // Always queue — never place directly from the WS handler thread.
    // OrderContext is only valid on MotiveWave's own callback threads (onBarUpdate, onBarClose,
    // onBarOpen, onActivate). Calling submitOrders from a cached ref on the WS thread causes
    // MotiveWave to reject with "Order can be placed by administrators only".
    pendingTrade.set(trade);
    logFile("Trade queued — waiting for OrderContext callback (onActivate/onBarClose/etc)");
    sendMsg(String.format("{\"type\":\"order_queued\",\"direction\":\"%s\",\"entry\":%.2f}", direction, entry));
  }

  private void sendMsg(String msg) {
    WebSocket s = ws;
    if (s == null || s.isInputClosed()) return;
    try { s.sendText(msg, true); } catch (Exception ignored) {}
  }

  private static String jsonStr(String s) {
    if (s == null) return "null";
    return "\"" + s.replace("\\","\\\\").replace("\"","\\\"") + "\"";
  }

  private double extractDouble(String json, String key) {
    int i = json.indexOf("\"" + key + "\":");
    if (i < 0) return 0;
    int start = i + key.length() + 3;
    while (start < json.length() && json.charAt(start) == ' ') start++;
    int end = start;
    while (end < json.length()) {
      char c = json.charAt(end);
      if (Character.isDigit(c) || c == '.' || c == '-') end++; else break;
    }
    if (start >= end) return 0;
    try { return Double.parseDouble(json.substring(start, end)); }
    catch (NumberFormatException e) { return 0; }
  }
}
