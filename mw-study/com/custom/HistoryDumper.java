package com.custom;

import com.motivewave.platform.sdk.common.*;
import com.motivewave.platform.sdk.study.*;

import java.io.File;
import java.io.FileWriter;
import java.io.PrintWriter;
import java.util.concurrent.atomic.AtomicBoolean;

@StudyHeader(
  namespace      = "com.custom",
  id             = "HISTORY_DUMPER",
  name           = "History Dumper",
  label          = "HistoryDumper",
  desc           = "Writes full OHLCV history to CSV on disk for bulk import into the web app.",
  overlay        = true,
  requiresVolume = true,
  signals        = false
)
public class HistoryDumper extends Study {

  private final AtomicBoolean dumped = new AtomicBoolean(false);

  @Override
  protected void calculate(int index, DataContext ctx) {
    if (!dumped.compareAndSet(false, true)) return;

    DataSeries ds     = ctx.getDataSeries();
    String     symbol = ctx.getInstrument().getSymbol();
    int        total  = ds.size();
    int        end    = total - 1;

    System.out.println("[HistoryDumper] Starting dump: symbol=" + symbol + " bars=" + total);

    if (end <= 0) {
      System.out.println("[HistoryDumper] No completed bars, skipping.");
      return;
    }

    // Infer resolution from timestamp delta between first two bars (milliseconds → seconds)
    String res = "1";
    if (end > 1) {
      long deltaMs = ds.getStartTime(1) - ds.getStartTime(0);
      long deltaSec = deltaMs / 1000L;
      if (deltaSec <= 65)       res = "1";
      else if (deltaSec <= 310) res = "5";
      else if (deltaSec <= 920) res = "15";
      else                      res = "60";
    }

    // Try writing to ~/MotiveWave Extensions/ first, fall back to temp dir
    String home    = System.getProperty("user.home", "C:\\Users\\jacks");
    String mwExt   = home + File.separator + "MotiveWave Extensions";
    String tmpDir  = System.getProperty("java.io.tmpdir", "C:\\Temp");
    String fname   = "dump_" + symbol + "_" + res + ".csv";

    File outDir  = new File(mwExt);
    if (!outDir.exists()) outDir.mkdirs();
    File outFile = outDir.exists() ? new File(outDir, fname) : new File(tmpDir, fname);

    System.out.println("[HistoryDumper] Writing to: " + outFile.getAbsolutePath());

    try (PrintWriter pw = new PrintWriter(new FileWriter(outFile))) {
      pw.println("timestamp,open,high,low,close,volume");
      int written = 0;
      for (int i = 0; i < end; i++) {
        long  t = ds.getStartTime(i) / 1000L;
        float o = ds.getOpen(i);
        float h = ds.getHigh(i);
        float l = ds.getLow(i);
        float c = ds.getClose(i);
        long  v = (long) ds.getVolume(i);
        if (h < l || o <= 0) continue;
        pw.printf("%d,%.4f,%.4f,%.4f,%.4f,%d%n", t, o, h, l, c, v);
        written++;
      }
      System.out.println("[HistoryDumper] Done — wrote " + written + " bars to " + outFile.getAbsolutePath());
    } catch (Exception e) {
      System.err.println("[HistoryDumper] ERROR writing file: " + e.getMessage());
      e.printStackTrace();
    }
  }
}
