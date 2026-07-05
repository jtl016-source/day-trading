package com.custom;

import com.motivewave.platform.sdk.common.*;
import com.motivewave.platform.sdk.common.desc.*;
import com.motivewave.platform.sdk.study.*;

import java.io.File;
import java.io.FileWriter;
import java.io.PrintWriter;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

/**
 * TEMPORARY verification study. Writes a report to
 *   ~/MotiveWave Extensions/sdk_probe.txt
 * describing the SDK surface we rely on for the server-driven backfill upgrade:
 *   P1 — reflect DataSeries / Instrument / BarSize public methods + basic bar stats.
 *   P2 — call Instrument.forEachBar for the last 24h via reflection (chart range).
 *   P3 — call Instrument.forEachBar for a 7-day window two years ago (deep history).
 *   P4 — locate Instrument.getBars signature(s) WITHOUT calling.
 * Every step is wrapped in try/catch so the study can never crash MotiveWave.
 * Add it to one chart, let it run once, then send sdk_probe.txt back.
 */
@StudyHeader(
  namespace      = "com.custom",
  id             = "SDK_PROBE",
  name           = "SDK Probe",
  label          = "SdkProbe",
  desc           = "One-shot SDK reflection probe. Writes ~/MotiveWave Extensions/sdk_probe.txt.",
  overlay        = true,
  requiresVolume = true,
  signals        = false
)
public class SdkProbe extends Study {

  private final AtomicBoolean done = new AtomicBoolean(false);

  @Override
  public void initialize(Defaults defaults) {
    // MW needs a settings descriptor to apply the study — without this the
    // add silently fails (same pattern as LiveBarRelay/TickRelay).
    createSD();
  }

  @Override
  protected void calculate(int index, DataContext ctx) {
    if (!done.compareAndSet(false, true)) return;

    final DataSeries ds = ctx.getDataSeries();
    final Instrument instrument = ctx.getInstrument();

    final String path = System.getProperty("user.home") + File.separator
      + "MotiveWave Extensions" + File.separator + "sdk_probe.txt";

    PrintWriter w = null;
    try {
      new File(System.getProperty("user.home") + File.separator + "MotiveWave Extensions").mkdirs();
      w = new PrintWriter(new FileWriter(path));
      final PrintWriter out = w;

      out.println("=== SDK PROBE ===");
      out.println("generated: " + new java.util.Date());
      try { out.println("symbol: " + instrument.getSymbol()); } catch (Throwable t) { out.println("symbol: <err> " + t); }

      // ── P1: reflect classes + basic bar stats ─────────────────────────────
      out.println();
      out.println("--- P1: DataSeries methods ---");
      dumpMethods(out, ds);

      out.println();
      out.println("--- P1: Instrument methods ---");
      dumpMethods(out, instrument);

      Object barSize = null;
      try {
        Method gbs = findMethod(ds.getClass(), "getBarSize");
        if (gbs != null) {
          barSize = gbs.invoke(ds);
          out.println();
          out.println("--- P1: BarSize methods (" + (barSize == null ? "null" : barSize.getClass().getName()) + ") ---");
          out.println("getBarSize().toString() = " + barSize);
          if (barSize != null) dumpMethods(out, barSize);
          // Probe likely interval accessors on the BarSize object.
          for (String m : new String[]{ "getInterval", "getIntervalMinutes", "getSize", "getIntervalSeconds", "getMinutes" }) {
            Object v = tryCall(barSize, m);
            if (v != null) out.println("BarSize." + m + "() = " + v);
          }
        } else {
          out.println();
          out.println("--- P1: getBarSize() NOT FOUND on DataSeries ---");
        }
      } catch (Throwable t) {
        out.println("P1 barSize error: " + t);
      }

      try {
        int size = ds.size();
        out.println();
        out.println("ds.size() = " + size);
        out.print("first 3 startTimes: ");
        for (int i = 0; i < 3 && i < size; i++) out.print(ds.getStartTime(i) + " ");
        out.println();
        out.print("last 3 startTimes:  ");
        for (int i = Math.max(0, size - 3); i < size; i++) out.print(ds.getStartTime(i) + " ");
        out.println();
      } catch (Throwable t) {
        out.println("P1 bar stats error: " + t);
      }

      // ── P4: locate getBars signature(s) WITHOUT calling ───────────────────
      out.println();
      out.println("--- P4: Instrument.getBars signatures (not called) ---");
      try {
        boolean any = false;
        for (Method m : instrument.getClass().getMethods()) {
          if (m.getName().equals("getBars")) { out.println(sig(m)); any = true; }
        }
        if (!any) out.println("(no getBars method found)");
      } catch (Throwable t) {
        out.println("P4 error: " + t);
      }

      // ── P2 + P3: forEachBar via reflection on a background thread ──────────
      final Object bs = barSize;
      Thread bg = new Thread(() -> {
        PrintWriter bout = null;
        try {
          // Append to the same file after the main report is flushed.
          bout = new PrintWriter(new FileWriter(path, true));
          long now = System.currentTimeMillis();
          out.flush();
          bout.println();
          bout.println("--- P2: forEachBar last 24h (chart range) ---");
          probeForEachBar(bout, instrument, bs, now - 24L * 3600_000L, now);

          bout.println();
          bout.println("--- P3: forEachBar 7-day window ~2 years ago (deep history) ---");
          long twoYearsAgo = now - 2L * 365L * 24L * 3600_000L;
          probeForEachBar(bout, instrument, bs, twoYearsAgo, twoYearsAgo + 7L * 24L * 3600_000L);

          bout.println();
          bout.println("=== PROBE COMPLETE ===");
        } catch (Throwable t) {
          if (bout != null) bout.println("P2/P3 background error: " + t);
        } finally {
          if (bout != null) bout.close();
        }
      }, "SdkProbe-forEachBar");
      bg.setDaemon(true);

      out.flush();
      out.close();
      w = null;
      bg.start();
    } catch (Throwable t) {
      if (w != null) { try { w.println("FATAL: " + t); w.close(); } catch (Throwable ignored) {} }
    }
  }

  // ── forEachBar reflection probe ───────────────────────────────────────────
  private void probeForEachBar(PrintWriter out, Instrument instrument, Object barSize, long start, long end) {
    try {
      Method fe = null;
      for (Method m : instrument.getClass().getMethods()) {
        if (m.getName().equals("forEachBar")) { fe = m; break; }
      }
      if (fe == null) { out.println("forEachBar NOT FOUND on Instrument"); return; }
      out.println("using: " + sig(fe));

      Class<?>[] pts = fe.getParameterTypes();
      final AtomicLong count = new AtomicLong(0);
      final AtomicLong first = new AtomicLong(0);
      final AtomicLong last  = new AtomicLong(0);

      Object[] args = new Object[pts.length];
      int longsSeen = 0;
      for (int i = 0; i < pts.length; i++) {
        Class<?> p = pts[i];
        if (p == long.class || p == Long.class) {
          args[i] = (longsSeen++ == 0) ? start : end;
        } else if (p == boolean.class || p == Boolean.class) {
          args[i] = Boolean.FALSE;                       // rth flag → false (all bars)
        } else if (barSize != null && p.isInstance(barSize)) {
          args[i] = barSize;
        } else if (p.isInterface()) {
          args[i] = Proxy.newProxyInstance(p.getClassLoader(), new Class<?>[]{ p }, new InvocationHandler() {
            @Override public Object invoke(Object proxy, Method method, Object[] callArgs) {
              // Any callback invocation is treated as one bar. Try to pull a timestamp.
              long ts = extractTs(callArgs);
              if (ts > 0) {
                if (first.get() == 0) first.set(ts);
                last.set(ts);
              }
              count.incrementAndGet();
              Class<?> rt = method.getReturnType();
              if (rt == boolean.class || rt == Boolean.class) return Boolean.TRUE; // continue iterating
              if (rt == int.class)     return 0;
              if (rt == long.class)    return 0L;
              return null;
            }
          });
        } else {
          args[i] = null; // unknown param — best effort
        }
      }

      fe.invoke(instrument, args);
      out.println("count=" + count.get() + " first=" + first.get() + " last=" + last.get());
    } catch (Throwable t) {
      out.println("forEachBar error: " + t);
    }
  }

  /** Best-effort extraction of an epoch-ms timestamp from a callback argument. */
  private static long extractTs(Object[] callArgs) {
    if (callArgs == null) return 0;
    for (Object a : callArgs) {
      if (a == null) continue;
      if (a instanceof Number) { long v = ((Number) a).longValue(); if (v > 1_000_000_000L) return v; }
      for (String m : new String[]{ "getStartTime", "getTime", "getEndTime", "getStart" }) {
        Object v = tryCall(a, m);
        if (v instanceof Number) { long lv = ((Number) v).longValue(); if (lv > 1_000_000_000L) return lv; }
      }
    }
    return 0;
  }

  // ── reflection helpers ────────────────────────────────────────────────────
  private static void dumpMethods(PrintWriter out, Object obj) {
    try {
      Method[] ms = obj.getClass().getMethods();
      java.util.Arrays.sort(ms, (a, b) -> a.getName().compareTo(b.getName()));
      for (Method m : ms) {
        if (m.getDeclaringClass() == Object.class) continue;
        out.println("  " + sig(m));
      }
    } catch (Throwable t) {
      out.println("  dumpMethods error: " + t);
    }
  }

  private static String sig(Method m) {
    StringBuilder sb = new StringBuilder();
    sb.append(m.getReturnType().getSimpleName()).append(" ").append(m.getName()).append("(");
    Class<?>[] pts = m.getParameterTypes();
    for (int i = 0; i < pts.length; i++) {
      if (i > 0) sb.append(", ");
      sb.append(pts[i].getSimpleName());
    }
    sb.append(")");
    return sb.toString();
  }

  private static Method findMethod(Class<?> cls, String name) {
    for (Method m : cls.getMethods()) if (m.getName().equals(name) && m.getParameterCount() == 0) return m;
    return null;
  }

  private static Object tryCall(Object obj, String name) {
    if (obj == null) return null;
    try {
      Method m = obj.getClass().getMethod(name);
      return m.invoke(obj);
    } catch (Throwable t) {
      return null;
    }
  }
}
