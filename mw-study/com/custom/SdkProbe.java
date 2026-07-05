package com.custom;

import com.motivewave.platform.sdk.common.*;
import com.motivewave.platform.sdk.common.desc.*;
import com.motivewave.platform.sdk.study.*;

import java.io.File;
import java.io.FileWriter;
import java.io.PrintWriter;
import java.lang.reflect.Method;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * TEMPORARY verification study (v2). Writes a report to
 *   ~/MotiveWave Extensions/sdk_probe.txt
 * describing the SDK surface we rely on for the server-driven backfill upgrade.
 *
 * Round-2 changes (after probe v1 findings):
 *   - forEachBar proxy machinery DELETED — constructing a reflect.Proxy for the
 *     obfuscated BarOperation interface throws IllegalArgumentException ("methods
 *     with same signature b() but incompatible return types"). That path is dead.
 *   - P2/P3 now call Instrument.getBars(long, long, BarSize, boolean) via reflection
 *     (plain List return — no callback interface) which is the real replacement.
 *   - P1 additionally dumps the VALUES of getUnderlying/getExchangeSymbol/
 *     getSymbolDisplay/getKey so we can pick a continuous key.
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

      out.println("=== SDK PROBE v2 ===");
      out.println("generated: " + new java.util.Date());
      try { out.println("symbol: " + instrument.getSymbol()); } catch (Throwable t) { out.println("symbol: <err> " + t); }

      // ── P1: reflect classes + basic bar stats ─────────────────────────────
      out.println();
      out.println("--- P1: DataSeries methods ---");
      dumpMethods(out, ds);

      out.println();
      out.println("--- P1: Instrument methods ---");
      dumpMethods(out, instrument);

      // P1: instrument identity accessors — hunting for a continuous key.
      out.println();
      out.println("--- P1: Instrument identity values ---");
      for (String m : new String[]{ "getSymbol", "getUnderlying", "getExchangeSymbol", "getSymbolDisplay", "getKey" }) {
        try {
          Object v = tryCallOrThrow(instrument, m);
          out.println("instrument." + m + "() = " + v);
        } catch (Throwable t) {
          out.println("instrument." + m + "() ERROR: " + t);
        }
      }

      Object barSize = null;
      try {
        Method gbs = findMethod(ds.getClass(), "getBarSize");
        if (gbs != null) {
          barSize = gbs.invoke(ds);
          out.println();
          out.println("--- P1: BarSize methods (" + (barSize == null ? "null" : barSize.getClass().getName()) + ") ---");
          out.println("getBarSize().toString() = " + barSize);
          if (barSize != null) dumpMethods(out, barSize);
          // Probe the verified interval accessors on the BarSize object.
          for (String m : new String[]{ "getInterval", "getIntervalMinutes", "getIntervalSeconds", "getSize", "getMinutes" }) {
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

      // ── P2 + P3: getBars via reflection on a background thread ─────────────
      final Object bs = barSize;
      Thread bg = new Thread(() -> {
        PrintWriter bout = null;
        try {
          // Append to the same file after the main report is flushed.
          bout = new PrintWriter(new FileWriter(path, true));
          long now = System.currentTimeMillis();

          bout.println();
          bout.println("--- P2: getBars last 24h (chart range) ---");
          probeGetBars(bout, instrument, bs, now - 24L * 3600_000L, now);

          bout.println();
          bout.println("--- P3: getBars 7-day window ~2 years ago (deep history) ---");
          long twoYearsAgo = now - 2L * 365L * 24L * 3600_000L;
          int p3 = probeGetBars(bout, instrument, bs, twoYearsAgo, twoYearsAgo + 7L * 24L * 3600_000L);

          if (p3 == 0) {
            bout.println();
            bout.println("--- P3b: 2y window empty → retry 6 months ago (7-day window) ---");
            long sixMonthsAgo = now - 182L * 24L * 3600_000L;
            probeGetBars(bout, instrument, bs, sixMonthsAgo, sixMonthsAgo + 7L * 24L * 3600_000L);
          }

          bout.println();
          bout.println("=== PROBE COMPLETE ===");
        } catch (Throwable t) {
          if (bout != null) bout.println("P2/P3 background error: " + t);
        } finally {
          if (bout != null) bout.close();
        }
      }, "SdkProbe-getBars");
      bg.setDaemon(true);

      out.flush();
      out.close();
      w = null;
      bg.start();
    } catch (Throwable t) {
      if (w != null) { try { w.println("FATAL: " + t); w.close(); } catch (Throwable ignored) {} }
    }
  }

  // ── getBars reflection probe ──────────────────────────────────────────────
  /** Returns the number of bars returned (0 on empty/failure) so callers can retry. */
  private int probeGetBars(PrintWriter out, Instrument instrument, Object barSize, long fromMs, long toMs) {
    try {
      if (barSize == null) { out.println("getBars SKIPPED — barSize is null"); return 0; }
      Method gb = findGetBars(instrument.getClass(), barSize);
      if (gb == null) { out.println("getBars(long,long,BarSize,boolean) NOT FOUND"); return 0; }
      out.println("using: " + sig(gb));

      Object result = gb.invoke(instrument, fromMs, toMs, barSize, Boolean.FALSE);
      if (!(result instanceof List)) {
        out.println("getBars returned non-List: " + (result == null ? "null" : result.getClass().getName()));
        return 0;
      }
      List<?> list = (List<?>) result;
      out.println("returned list size = " + list.size());
      if (list.isEmpty()) return 0;

      Object first = list.get(0);
      Object last  = list.get(list.size() - 1);
      out.println("first element class = " + first.getClass().getName());
      out.println("--- element method dump ---");
      dumpMethods(out, first);

      long ft = extractTs(first);
      long lt = extractTs(last);
      out.println("first bar time = " + ft);
      out.println("last  bar time = " + lt);
      return list.size();
    } catch (Throwable t) {
      out.println("getBars error: " + t);
      return 0;
    }
  }

  /** Best-effort extraction of an epoch-ms timestamp from a bar element. */
  private static long extractTs(Object bar) {
    if (bar == null) return 0;
    for (String m : new String[]{ "getStartTime", "getTime", "getEndTime" }) {
      Object v = tryCall(bar, m);
      if (v instanceof Number) { long lv = ((Number) v).longValue(); if (lv > 1_000_000_000L) return lv; }
    }
    return 0;
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

  /** Like tryCall but surfaces the error so P1 can print it as text. */
  private static Object tryCallOrThrow(Object obj, String name) throws Throwable {
    if (obj == null) return null;
    Method m = obj.getClass().getMethod(name);
    return m.invoke(obj);
  }
}
