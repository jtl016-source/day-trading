import { useRef, useEffect, useState, useMemo, useCallback } from 'react';
import { View, StyleSheet, ActivityIndicator, Text, Pressable } from 'react-native';
import { WebView } from 'react-native-webview';
import { useApp, Timeframe } from '@/context/app-context';
import { Trading } from '@/constants/theme';

const FETCH_INTERVAL: Record<Timeframe, string> = {
  '1m': '1m', '5m': '5m', '15m': '5m', '60m': '60m',
};
const DISPLAY_MIN: Record<Timeframe, number> = {
  '1m': 1, '5m': 5, '15m': 15, '60m': 60,
};

const LW_CDN = 'https://unpkg.com/lightweight-charts@4.2.0/dist/lightweight-charts.standalone.production.js';
function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Request timed out')), timeoutMs);
    fetch(url).then(r => { clearTimeout(timer); resolve(r); }, e => { clearTimeout(timer); reject(e); });
  });
}

let _lwCache: Promise<string> | null = null;
function getLwScript(): Promise<string> {
  if (!_lwCache) {
    _lwCache = fetchWithTimeout(LW_CDN, 15000)
      .then(r => { if (!r.ok) throw new Error('CDN HTTP ' + r.status); return r.text(); })
      .catch(e => { _lwCache = null; throw e; });
  }
  return _lwCache;
}

function buildHtml(lwScript: string): string {
  return `<!DOCTYPE html>
<html><head>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{background:#000;overflow:hidden;width:100%;height:100%}
#chart{position:absolute;top:0;left:0;right:0;bottom:0;overflow:hidden}
#status{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;
  background:#000;color:#6b7280;font-family:-apple-system,sans-serif;font-size:14px;z-index:20;text-align:center;padding:16px}
</style>
</head><body>
<div id="status">Loading chart…</div>
<div id="chart"></div>
<div id="live-badge" style="display:none;position:fixed;bottom:8px;left:10px;font-family:-apple-system,sans-serif;font-size:11px;z-index:30;pointer-events:none;"></div>
<script>${lwScript}</script>
<script>
var chart, candleSeries;
var vecSeries = {};
var zoneCanvas, currentZones = [], zonesVisible = false;
var yboxCanvas, yboxVisible = false, yboxLevels = [], yboxSessionStart = 0, yboxSessionEnd = 0;
var storedCandles = [];
var fpCanvas, fpDataMap = {}, fpVisible = false, fpBarSec = 300;
var sessZoneCanvas, sessZoneData = [], sessLastCandleT = 0;

function withAlpha(c, a) {
  var m = c.match(/rgba?\\s*\\(\\s*([\\d.]+)\\s*,\\s*([\\d.]+)\\s*,\\s*([\\d.]+)/);
  if (m) return 'rgba('+m[1]+','+m[2]+','+m[3]+','+a+')';
  var hex = c.replace(/^#/,'');
  if (hex.length===6) {
    var r=parseInt(hex.slice(0,2),16),g=parseInt(hex.slice(2,4),16),b=parseInt(hex.slice(4,6),16);
    return 'rgba('+r+','+g+','+b+','+a+')';
  }
  return c;
}

// ── Zone band canvas — full-width horizontal bands, no x-time clipping ────────
// Matches Milk Yellow Box PC display where zones span the entire chart width.
function drawZoneBands() {
  if (!zoneCanvas || !candleSeries || !chart) return;
  var ctx = zoneCanvas.getContext('2d');
  var w = window.innerWidth, h = window.innerHeight;
  if (zoneCanvas.width !== w) zoneCanvas.width = w;
  if (zoneCanvas.height !== h) zoneCanvas.height = h;
  ctx.clearRect(0, 0, w, h);
  if (!zonesVisible || !currentZones.length) return;
  for (var i = 0; i < currentZones.length; i++) {
    try {
      var z = currentZones[i];
      var color = z.fillColor || z.color || '#26c87a';
      var ty = candleSeries.priceToCoordinate(z.topPrice);
      var by = candleSeries.priceToCoordinate(z.bottomPrice);
      if (ty === null || by === null) continue;
      var top = Math.min(ty, by);
      var bh = Math.abs(by - ty);
      if (bh < 1) bh = 1;
      // Full width — no x time clipping, matches PC screenshot
      ctx.fillStyle = withAlpha(color, 0.15);
      ctx.fillRect(0, top, w, bh);
      ctx.strokeStyle = withAlpha(color, 0.85);
      ctx.lineWidth = 1.5; ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(0, ty); ctx.lineTo(w, ty); ctx.stroke();
      ctx.strokeStyle = withAlpha(color, 0.5);
      ctx.lineWidth = 1; ctx.setLineDash([4,3]);
      ctx.beginPath(); ctx.moveTo(0, by); ctx.lineTo(w, by); ctx.stroke();
      ctx.setLineDash([]);
      // Zone label on right edge
      if (z.label) {
        ctx.font = 'bold 9px -apple-system,sans-serif';
        ctx.fillStyle = withAlpha(color, 0.9);
        ctx.textAlign = 'right';
        ctx.fillText(z.label, w - 4, ty - 3);
        ctx.textAlign = 'left';
      }
    } catch(ze) {}
  }
}

// ── Per-candle footprint — bid bar left / ask bar right, stacked highlights ────
function drawFootprint() {
  if (!fpCanvas || !chart || !candleSeries || !fpVisible) return;
  var ctx = fpCanvas.getContext('2d');
  var w = window.innerWidth, h = window.innerHeight;
  if (fpCanvas.width !== w) fpCanvas.width = w;
  if (fpCanvas.height !== h) fpCanvas.height = h;
  ctx.clearRect(0, 0, w, h);
  var ts = chart.timeScale();
  var keys = Object.keys(fpDataMap);
  if (!keys.length) return;
  var t0 = parseInt(keys[0]);
  var x0 = ts.timeToCoordinate(t0);
  var x1 = ts.timeToCoordinate(t0 + fpBarSec);
  if (x0 === null || x1 === null) return;
  var barPx = Math.abs(x1 - x0);
  if (barPx < 18) return;
  var halfW = Math.max(4, Math.floor(barPx / 2) - 1);
  for (var ki = 0; ki < keys.length; ki++) {
    var t = parseInt(keys[ki]);
    var fp = fpDataMap[t];
    if (!fp || !fp.levels || !fp.levels.length) continue;
    var cx = ts.timeToCoordinate(t);
    if (cx === null || cx < -(halfW * 2) || cx > w + halfW * 2) continue;
    var levels = fp.levels;
    var maxVol = 1;
    for (var j = 0; j < levels.length; j++) {
      var tot = levels[j].bidVol + levels[j].askVol;
      if (tot > maxVol) maxVol = tot;
    }
    for (var j = 0; j < levels.length; j++) {
      var lv = levels[j];
      var cTop = candleSeries.priceToCoordinate(lv.price + 0.5);
      var cBot = candleSeries.priceToCoordinate(lv.price - 0.5);
      if (cTop === null || cBot === null) continue;
      var cellTop = Math.min(cTop, cBot);
      var cellHt  = Math.max(1, Math.abs(cBot - cTop));
      // Stacked: adjacent cell has same imbalance direction
      var prevLv = j > 0 ? levels[j - 1] : null;
      var nextLv = j < levels.length - 1 ? levels[j + 1] : null;
      var isStacked = lv.imbalance !== 'none' && (
        (prevLv && prevLv.imbalance === lv.imbalance) ||
        (nextLv && nextLv.imbalance === lv.imbalance)
      );
      var isBuyIm = lv.imbalance === 'buy';
      var isSellIm = lv.imbalance === 'sell';
      // POC amber tint across full row
      if (fp.poc != null && lv.price === fp.poc) {
        ctx.fillStyle = 'rgba(146,64,14,0.22)';
        ctx.fillRect(cx - halfW, cellTop, halfW * 2, cellHt);
      }
      // Imbalance cell bg: bid left-half red for sell, ask right-half green for buy
      if (isSellIm) {
        ctx.fillStyle = isStacked ? 'rgba(200,40,40,0.28)' : 'rgba(180,40,40,0.14)';
        ctx.fillRect(cx - halfW, cellTop, halfW, cellHt);
      }
      if (isBuyIm) {
        ctx.fillStyle = isStacked ? 'rgba(30,190,70,0.28)' : 'rgba(30,160,60,0.14)';
        ctx.fillRect(cx, cellTop, halfW, cellHt);
      }
      // Bid bar (left half, red shades)
      if (lv.bidVol > 0) {
        var bW = Math.max(1, Math.round(lv.bidVol / maxVol * halfW));
        ctx.fillStyle = (isStacked && isSellIm) ? 'rgba(240,60,60,0.90)' :
                        isSellIm ? 'rgba(180,55,55,0.80)' : 'rgba(120,45,45,0.65)';
        ctx.fillRect(cx - bW, cellTop, bW, Math.max(1, cellHt - 1));
      }
      // Ask bar (right half, green shades)
      if (lv.askVol > 0) {
        var aW = Math.max(1, Math.round(lv.askVol / maxVol * halfW));
        ctx.fillStyle = (isStacked && isBuyIm) ? 'rgba(50,220,90,0.90)' :
                        isBuyIm ? 'rgba(40,170,65,0.80)' : 'rgba(25,110,45,0.65)';
        ctx.fillRect(cx, cellTop, aW, Math.max(1, cellHt - 1));
      }
      // POC amber border
      if (fp.poc != null && lv.price === fp.poc) {
        ctx.strokeStyle = 'rgba(251,191,36,0.95)';
        ctx.lineWidth = 1.5; ctx.setLineDash([]);
        ctx.strokeRect(cx - halfW, cellTop, halfW * 2, cellHt);
      }
      // Numbers when zoomed in enough
      if (cellHt >= 9 && barPx >= 40) {
        var fs = Math.min(9, Math.max(6, cellHt * 0.65));
        ctx.font = fs + 'px -apple-system,monospace';
        ctx.textBaseline = 'middle';
        var tY = cellTop + cellHt / 2;
        if (lv.bidVol > 0) {
          ctx.fillStyle = (isStacked && isSellIm) ? 'rgba(255,130,130,1)' : 'rgba(210,110,110,0.9)';
          ctx.textAlign = 'right';
          ctx.fillText(Math.round(lv.bidVol), cx - 1, tY);
        }
        if (lv.askVol > 0) {
          ctx.fillStyle = (isStacked && isBuyIm) ? 'rgba(80,240,140,1)' : 'rgba(55,190,90,0.9)';
          ctx.textAlign = 'left';
          ctx.fillText(Math.round(lv.askVol), cx + 1, tY);
        }
      }
    }
    // Center divider
    ctx.strokeStyle = 'rgba(80,100,140,0.35)';
    ctx.lineWidth = 1; ctx.setLineDash([]);
    var topY2 = candleSeries.priceToCoordinate((fp.high || 0) + 0.5);
    var botY2 = candleSeries.priceToCoordinate((fp.low  || 0) - 0.5);
    if (topY2 !== null && botY2 !== null) {
      ctx.beginPath();
      ctx.moveTo(cx - 0.5, Math.min(topY2, botY2));
      ctx.lineTo(cx - 0.5, Math.max(topY2, botY2));
      ctx.stroke();
    }
    // Delta label
    if (fp.candleDelta != null) {
      var dTopY = candleSeries.priceToCoordinate((fp.high || 0) + 0.5);
      var dBotY = candleSeries.priceToCoordinate((fp.low  || 0) - 0.5);
      if (dTopY !== null && dBotY !== null) {
        var dSign = fp.candleDelta > 0 ? '+' : '';
        ctx.font = 'bold 8px -apple-system,sans-serif';
        ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.fillStyle = fp.candleDelta > 0 ? '#26c87a' : fp.candleDelta < 0 ? '#ef5350' : '#9ca3af';
        ctx.fillText(dSign + Math.round(fp.candleDelta), cx + halfW + 3, (dTopY + dBotY) / 2);
      }
    }
  }
}

// ── Session aggregate footprint zones — diagonal 3:1 imbalance, stacked, mitigated ──
function drawSessionZones() {
  if (!sessZoneCanvas || !chart || !candleSeries || !fpVisible) return;
  var ctx = sessZoneCanvas.getContext('2d');
  var w = window.innerWidth, h = window.innerHeight;
  if (sessZoneCanvas.width !== w) sessZoneCanvas.width = w;
  if (sessZoneCanvas.height !== h) sessZoneCanvas.height = h;
  ctx.clearRect(0, 0, w, h);
  if (!sessZoneData.length) return;
  var ts = chart.timeScale();
  var lastT = sessLastCandleT || Math.floor(Date.now() / 1000);
  var xMax = w - 62;
  ctx.save();
  ctx.beginPath(); ctx.rect(0, 0, xMax, h); ctx.clip();
  for (var i = 0; i < sessZoneData.length; i++) {
    var z = sessZoneData[i];
    var xSR = ts.timeToCoordinate(z.nextSessT);
    var xER = ts.timeToCoordinate(lastT);
    var xS = xSR !== null ? xSR : -200;
    var xE = xER !== null ? xER : w + 200;
    if (xE < 0 || xS > xMax) continue;
    var xL = Math.max(0, xS), xR = Math.min(xMax, xE), zW = xR - xL;
    if (zW <= 0) continue;
    var yTopR = candleSeries.priceToCoordinate(z.bp + 2);
    var yBotR = candleSeries.priceToCoordinate(z.bp);
    if (yTopR === null || yBotR === null) continue;
    var zt = Math.min(yTopR, yBotR);
    var zh = Math.max(2, Math.abs(yBotR - yTopR));
    var fillA = z.stacked ? 0.42 : 0.18;
    var lineA = z.stacked ? 0.95 : 0.48;
    ctx.fillStyle = z.dir === 'buy' ? 'rgba(34,197,94,' + fillA + ')' : 'rgba(239,68,68,' + fillA + ')';
    ctx.fillRect(xL, zt, zW, zh);
    ctx.strokeStyle = z.dir === 'buy' ? 'rgba(74,222,128,' + lineA + ')' : 'rgba(248,113,113,' + lineA + ')';
    ctx.lineWidth = z.stacked ? 1.5 : 1;
    ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(xL, zt);      ctx.lineTo(xR, zt);      ctx.stroke();
    ctx.beginPath(); ctx.moveTo(xL, zt + zh); ctx.lineTo(xR, zt + zh); ctx.stroke();
  }
  ctx.restore();
}

// ── Yellow Box overlay ─────────────────────────────────────────────────────────
function drawYellowBox() {
  if (!yboxCanvas || !candleSeries || !chart) return;
  var ctx = yboxCanvas.getContext('2d');
  var w = window.innerWidth, h = window.innerHeight;
  if (yboxCanvas.width !== w) yboxCanvas.width = w;
  if (yboxCanvas.height !== h) yboxCanvas.height = h;
  ctx.clearRect(0, 0, w, h);
  if (!yboxVisible || !yboxLevels.length) return;
  var ts = chart.timeScale();
  var xStart = 0, xEnd = w;
  if (yboxSessionStart) {
    var xS = ts.timeToCoordinate(yboxSessionStart);
    if (xS !== null) xStart = Math.max(0, xS);
  }
  if (yboxSessionEnd) {
    var xE = ts.timeToCoordinate(yboxSessionEnd);
    if (xE !== null) xEnd = Math.min(w, xE);
  }
  if (xStart >= xEnd || xEnd <= 0 || xStart >= w) { xStart = 0; xEnd = w; }
  ctx.fillStyle = 'rgba(50,70,15,0.18)';
  ctx.fillRect(xStart, 0, xEnd - xStart, h);
  if (yboxSessionStart) {
    var xs = ts.timeToCoordinate(yboxSessionStart);
    if (xs !== null) {
      ctx.strokeStyle='rgba(160,190,30,0.45)';ctx.lineWidth=1;ctx.setLineDash([3,4]);
      ctx.beginPath();ctx.moveTo(xs,0);ctx.lineTo(xs,h);ctx.stroke();ctx.setLineDash([]);
    }
  }
  ctx.font = 'bold 9px -apple-system, sans-serif';
  for (var i = 0; i < yboxLevels.length; i++) {
    var lv = yboxLevels[i];
    var y = candleSeries.priceToCoordinate(lv.price);
    if (y === null || y < -2 || y > h + 2) continue;
    var col = lv.color || '#ffd700';
    var isKey = (lv.label === 'RESISTANCE' || lv.label === 'SUPPORT');
    ctx.strokeStyle = withAlpha(col, isKey ? 0.95 : 0.75);
    ctx.lineWidth = isKey ? 2 : 1;
    ctx.setLineDash(lv.label === 'Pivot' ? [6,3] : isKey ? [] : [4,3]);
    ctx.beginPath();ctx.moveTo(xStart,y);ctx.lineTo(xEnd,y);ctx.stroke();ctx.setLineDash([]);
    var labelX = Math.min(xEnd - 4, w - 4);
    var labelText = lv.label + '  ' + lv.price.toFixed(2);
    var tw = ctx.measureText(labelText).width + 6;
    ctx.fillStyle='rgba(0,0,0,0.65)';ctx.fillRect(labelX-tw,y-10,tw,12);
    ctx.fillStyle=col;ctx.textAlign='right';ctx.fillText(labelText,labelX,y-1);ctx.textAlign='left';
  }
}

// ── Chart init ─────────────────────────────────────────────────────────────────
function init() {
  var el = document.getElementById('chart');
  var w = window.innerWidth||375, h = window.innerHeight||600;
  chart = LightweightCharts.createChart(el, {
    width: w, height: h,
    layout: { background: { color: '#000000' }, textColor: '#e8eaf0' },
    grid: { vertLines: { color: '#1c2030' }, horzLines: { color: '#1c2030' } },
    timeScale: { timeVisible: true, secondsVisible: false, borderColor: '#1c2030' },
    rightPriceScale: { borderColor: '#1c2030' },
    crosshair: { mode: 1 },
  });

  candleSeries = chart.addCandlestickSeries({
    upColor: '#26c87a', downColor: '#ef5350',
    borderUpColor: '#26c87a', borderDownColor: '#ef5350',
    wickUpColor: '#26c87a', wickDownColor: '#ef5350',
  });

  var tfs = ['1m','5m','15m','60m'];
  var colors = { '1m':'#60a5fa', '5m':'#9ca3af', '15m':'#fbbf24', '60m':'#a855f7' };
  for (var i = 0; i < tfs.length; i++) {
    var tf = tfs[i];
    vecSeries[tf] = chart.addLineSeries({
      color: colors[tf], lineWidth: 1.5,
      priceLineVisible: false, lastValueVisible: false,
      autoscaleInfoProvider: function() { return null; },
    });
  }

  fpCanvas = document.createElement('canvas');
  fpCanvas.style.cssText = 'position:fixed;top:0;left:0;pointer-events:none;z-index:7;';
  document.body.appendChild(fpCanvas);

  sessZoneCanvas = document.createElement('canvas');
  sessZoneCanvas.style.cssText = 'position:fixed;top:0;left:0;pointer-events:none;z-index:6;';
  document.body.appendChild(sessZoneCanvas);

  yboxCanvas = document.createElement('canvas');
  yboxCanvas.style.cssText = 'position:fixed;top:0;left:0;pointer-events:none;z-index:9;';
  document.body.appendChild(yboxCanvas);

  zoneCanvas = document.createElement('canvas');
  zoneCanvas.style.cssText = 'position:fixed;top:0;left:0;pointer-events:none;z-index:10;';
  document.body.appendChild(zoneCanvas);

  function redrawAll() {
    requestAnimationFrame(function() { drawFootprint(); drawSessionZones(); drawYellowBox(); drawZoneBands(); });
  }
  chart.timeScale().subscribeVisibleTimeRangeChange(redrawAll);
  chart.subscribeCrosshairMove(redrawAll);
  window.addEventListener('resize', function() {
    chart.resize(window.innerWidth, window.innerHeight); redrawAll();
  });
  try { window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ready' })); } catch(e) {}
}

// ── Public API ─────────────────────────────────────────────────────────────────

window.setChartData = function(candles, vec1m, vec5m, vec15m, vec60m, activeTf) {
  try {
    var tfs = ['1m','5m','15m','60m'];
    for (var i = 0; i < tfs.length; i++) vecSeries[tfs[i]].setData([]);
    candleSeries.setData([]);
    storedCandles = candles || [];

    // ── Build active-vector map for per-candle coloring ────────────────────────
    var activeVecArr = activeTf==='1m'?vec1m : activeTf==='5m'?vec5m : activeTf==='15m'?vec15m : vec60m;
    var vecValMap = {};
    if (activeVecArr) for (var vi = 0; vi < activeVecArr.length; vi++) vecValMap[activeVecArr[vi].time] = activeVecArr[vi].value;

    // ── Candle data with real timestamps + vector-relative colors ─────────────
    // Matches PC theme: above vec → bright (vecAboveUp/Down), below → dim (vecBelowUp/Down)
    var remapped = [];
    for (var ci = 0; ci < candles.length; ci++) {
      var c = candles[ci];
      var isUp = c.close >= c.open;
      var lb = vecValMap[c.time];
      var above = lb == null || c.close >= lb;
      var color, wickColor;
      if (lb != null) {
        if (above) { color = isUp ? '#4caf50' : '#f44336'; wickColor = isUp ? '#1a7a72' : '#9a1a1a'; }
        else        { color = isUp ? '#2e6640' : '#8c2828'; wickColor = color; }
      } else {
        color = isUp ? '#26c87a' : '#ef5350'; wickColor = color;
      }
      remapped.push({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close,
                      color: color, borderColor: color, wickColor: wickColor });
    }
    candleSeries.setData(remapped);

    // ── Vector data ────────────────────────────────────────────────────────────
    var vecColors = { '1m':'#60a5fa', '5m':'#9ca3af', '15m':'#fbbf24', '60m':'#a855f7' };
    var vecArrays = { '1m': vec1m||[], '5m': vec5m||[], '15m': vec15m||[], '60m': vec60m||[] };
    for (var j = 0; j < tfs.length; j++) {
      var tf = tfs[j];
      vecSeries[tf].setData(vecArrays[tf]);
      vecSeries[tf].applyOptions({
        color: tf === activeTf ? '#e8e8e8' : vecColors[tf],
        lineWidth: tf === activeTf ? 2 : 1.5,
      });
    }

    chart.timeScale().fitContent();
    requestAnimationFrame(function() { drawYellowBox(); drawZoneBands(); });
    document.getElementById('status').style.display = 'none';
  } catch(e) {
    window.setStatus('Chart error: ' + (e && e.message ? e.message : String(e)));
  }
};

// Prepend older candles + vectors to the front of the chart without resetting view
window.prependChartData = function(olderCandles, olderVec1m, olderVec5m, olderVec15m, olderVec60m, activeTf) {
  try {
    if (!olderCandles || !olderCandles.length) return;

    // Combine older candles with current stored candles (both use real timestamps)
    var allReal = olderCandles.concat(storedCandles);
    storedCandles = allReal;

    // Recolor + remap all candles
    var activeVecArr = activeTf==='1m'?olderVec1m:activeTf==='5m'?olderVec5m:activeTf==='15m'?olderVec15m:olderVec60m;
    var vecValMap = {};
    if (activeVecArr) for (var vi = 0; vi < activeVecArr.length; vi++) vecValMap[activeVecArr[vi].time] = activeVecArr[vi].value;

    var remapped = [];
    for (var ci = 0; ci < allReal.length; ci++) {
      var c = allReal[ci];
      var isUp = c.close >= c.open;
      var lb = vecValMap[c.time];
      var above = lb == null || c.close >= lb;
      var color, wickColor;
      if (lb != null) {
        if (above) { color = isUp ? '#4caf50' : '#f44336'; wickColor = isUp ? '#1a7a72' : '#9a1a1a'; }
        else        { color = isUp ? '#2e6640' : '#8c2828'; wickColor = color; }
      } else { color = isUp ? '#26c87a' : '#ef5350'; wickColor = color; }
      remapped.push({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close,
                      color: color, borderColor: color, wickColor: wickColor });
    }
    candleSeries.setData(remapped);

    // Update all vector series
    var vecArrays = {'1m':olderVec1m||[],'5m':olderVec5m||[],'15m':olderVec15m||[],'60m':olderVec60m||[]};
    var tfs = ['1m','5m','15m','60m'];
    for (var j = 0; j < tfs.length; j++) {
      vecSeries[tfs[j]].setData(vecArrays[tfs[j]]);
    }

    // Keep view at the right edge
    requestAnimationFrame(function() { drawYellowBox(); drawZoneBands(); });
  } catch(ex) {}
};

window.setZones = function(zones, visible) {
  currentZones = zones || [];
  zonesVisible = !!visible;
  requestAnimationFrame(drawZoneBands);
};

window.setFootprintData = function(candles, barSec, visible) {
  fpDataMap = {};
  fpBarSec = barSec || 300;
  fpVisible = !!visible;
  if (candles) {
    for (var fi = 0; fi < candles.length; fi++) {
      if (candles[fi] && candles[fi].time) fpDataMap[candles[fi].time] = candles[fi];
    }
  }
  requestAnimationFrame(drawFootprint);
};

window.setFootprintVisible = function(v) {
  fpVisible = !!v;
  requestAnimationFrame(function() { drawFootprint(); drawSessionZones(); });
};

window.setSessionZones = function(zones, lastT) {
  sessZoneData = zones || [];
  sessLastCandleT = lastT || 0;
  requestAnimationFrame(drawSessionZones);
};

window.setVectorVisible = function(v) {
  var tfs = ['1m','5m','15m','60m'];
  for (var i = 0; i < tfs.length; i++) vecSeries[tfs[i]].applyOptions({ visible: !!v });
};

window.setYellowBoxData = function(levels, sessionStart, sessionEnd, visible) {
  yboxLevels = levels || [];
  yboxSessionStart = sessionStart || 0;
  yboxSessionEnd = sessionEnd || 0;
  yboxVisible = !!visible;
  requestAnimationFrame(drawYellowBox);
};

// Signal markers — color-coded by risk level (safeplus=purple, safe=green/red, risky=blue/orange, riskiest=red)
window.setSignals = function(signals) {
  if (!candleSeries || !signals || !signals.length) return;
  try {
    var markers = [];
    for (var i = 0; i < signals.length; i++) {
      var s = signals[i];
      var isLong = s.direction === 'Long';
      var rl = s.riskLevel;
      var color, sz;
      if (rl === 'safeplus') {
        color = '#a78bfa'; sz = 3;
      } else if (rl === 'safe') {
        color = isLong ? '#26c87a' : '#ef5350'; sz = 2;
      } else if (rl === 'risky') {
        color = isLong ? '#60a5fa' : '#f97316'; sz = 1;
      } else {
        color = isLong ? '#f97316' : '#ef4444'; sz = 1;
      }
      markers.push({
        time: s.time,
        position: isLong ? 'belowBar' : 'aboveBar',
        color: color,
        shape: isLong ? 'arrowUp' : 'arrowDown',
        text: (rl === 'safeplus' || rl === 'safe') ? '●' : '○',
        size: sz,
      });
    }
    markers.sort(function(a, b) { return a.time - b.time; });
    candleSeries.setMarkers(markers);
  } catch(e) {}
};

// Scroll chart to show a specific candle by unix timestamp
window.scrollToTime = function(t, barSec) {
  if (!chart) return;
  var bSec = barSec || 900;
  try { chart.timeScale().setVisibleRange({ from: t - 50 * bSec, to: t + 30 * bSec }); } catch(e) {}
};

// Live tick feed
var liveWs = null, liveSym = '', liveRes = '', liveResMin = 5, liveDisplaySec = 300, liveLastBar = null;

function setLiveBadge(connected) {
  var el = document.getElementById('live-badge');
  if (!el) return;
  el.style.display = 'block';
  el.textContent = connected ? '● Live' : '○ Reconnecting…';
  el.style.color = connected ? '#26c87a' : '#f59e0b';
}

// displaySeconds = the display-interval in seconds (300 for 5m/15m fetch on 15m display, 3600 for 60m).
// Ticks and bars are bucketed to this display interval so new candles appear exactly on interval rollover.
window.connectLive = function(wsUrl, sym, resolution, displaySeconds) {
  liveSym = (sym || '').toUpperCase();
  liveRes = resolution || '';
  liveResMin = parseInt((liveRes || '5').replace('m','')) || 5;
  liveDisplaySec = displaySeconds || (liveResMin * 60);
  if (liveWs) { try { liveWs.close(); } catch(ex) {} liveWs = null; }
  if (storedCandles.length) {
    var lc = storedCandles[storedCandles.length - 1];
    liveLastBar = { time: lc.time, open: lc.open, high: lc.high, low: lc.low, close: lc.close, volume: lc.volume || 0 };
  }
  try {
    liveWs = new WebSocket(wsUrl);
    liveWs.onopen = function() { setLiveBadge(true); };
    liveWs.onmessage = function(ev) {
      try {
        var msg = JSON.parse(ev.data);

        // ── TICK ──────────────────────────────────────────────────────────────
        if (msg.type === 'tick' && msg.symbol && msg.symbol.startsWith(liveSym)) {
          if (!candleSeries) return;
          var p = msg.price;
          // Bucket the tick to the display interval so a new candle appears the
          // instant the interval rolls over, without waiting for the next bar msg.
          var tickMs = msg.time || Date.now();
          var bucketSec = Math.floor(tickMs / 1000 / liveDisplaySec) * liveDisplaySec;
          if (!liveLastBar || bucketSec > liveLastBar.time) {
            liveLastBar = { time: bucketSec, open: p, high: p, low: p, close: p, volume: 0 };
          } else {
            liveLastBar.close = p;
            if (p > liveLastBar.high) liveLastBar.high = p;
            if (p < liveLastBar.low)  liveLastBar.low  = p;
          }
          var tickUp = liveLastBar.close >= liveLastBar.open;
          candleSeries.update({ time: liveLastBar.time, open: liveLastBar.open, high: liveLastBar.high, low: liveLastBar.low, close: liveLastBar.close,
            color: tickUp ? '#26c87a' : '#ef5350', borderColor: tickUp ? '#26c87a' : '#ef5350', wickColor: tickUp ? '#26c87a' : '#ef5350' });

        // ── BAR ───────────────────────────────────────────────────────────────
        } else if (msg.type === 'bar' && msg.bar &&
                   (msg.resolution === liveRes || (msg.resolution && msg.resolution.replace('m','') === liveRes.replace('m','')))) {
          var bar = msg.bar;
          if (!bar.symbol || !bar.symbol.startsWith(liveSym)) return;

          // Map the fetch-resolution bar onto the display-resolution bucket.
          // For a 15m display chart receiving 5m bars, three 5m bars share one 15m bucket.
          var dispBucket = Math.floor(bar.time / liveDisplaySec) * liveDisplaySec;

          if (!liveLastBar || dispBucket > liveLastBar.time) {
            // New display bucket — start fresh
            liveLastBar = { time: dispBucket, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume || 0 };
          } else {
            // Same display bucket — aggregate OHLCV into the running display bar
            liveLastBar.high  = Math.max(liveLastBar.high, bar.high);
            liveLastBar.low   = Math.min(liveLastBar.low,  bar.low);
            liveLastBar.close = bar.close;
            liveLastBar.volume = (liveLastBar.volume || 0) + (bar.volume || 0);
          }

          // The display bar completes when the last fetch-bar of this bucket closes.
          // bar.time + fetchIntervalSec reaches the next display bucket boundary.
          var fetchBarEndSec = bar.time + liveResMin * 60;
          var displayBarComplete = bar.complete && (fetchBarEndSec >= dispBucket + liveDisplaySec);
          if (displayBarComplete) {
            var stored = { time: dispBucket, open: liveLastBar.open, high: liveLastBar.high, low: liveLastBar.low, close: liveLastBar.close, volume: liveLastBar.volume, complete: true };
            var found = false;
            for (var ii = 0; ii < storedCandles.length; ii++) {
              if (storedCandles[ii].time === dispBucket) { storedCandles[ii] = stored; found = true; break; }
            }
            if (!found) storedCandles.push(stored);
            // Tell React Native so it can refresh signals from the server
            try { window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'bar_complete', time: dispBucket })); } catch(pe) {}
          }

          var barUp = liveLastBar.close >= liveLastBar.open;
          candleSeries.update({ time: liveLastBar.time, open: liveLastBar.open, high: liveLastBar.high, low: liveLastBar.low, close: liveLastBar.close,
            color: barUp ? '#26c87a' : '#ef5350', borderColor: barUp ? '#26c87a' : '#ef5350', wickColor: barUp ? '#26c87a' : '#ef5350' });
        }
      } catch(ex) {}
    };
    liveWs.onerror = function() { setLiveBadge(false); };
    liveWs.onclose = function() {
      setLiveBadge(false);
      liveWs = null;
      var u = wsUrl, s = sym, r = resolution, d = displaySeconds;
      setTimeout(function() { if (liveSym) window.connectLive(u, s, r, d); }, 5000);
    };
  } catch(ex) { setLiveBadge(false); }
};

window.setStatus = function(msg) {
  var el = document.getElementById('status');
  el.textContent = msg; el.style.display = 'flex';
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else { init(); }
</script>
</body></html>`;
}

// ── Data helpers ───────────────────────────────────────────────────────────────

function aggToInterval(bars: any[], intervalMin: number): any[] {
  if (intervalMin <= 1) return bars;
  const out: any[] = [];
  let bucket: any = null;
  for (const b of bars) {
    const bt = Math.floor(b.time / (intervalMin * 60)) * (intervalMin * 60);
    if (!bucket || bucket.time !== bt) {
      if (bucket) out.push(bucket);
      bucket = { time: bt, open: b.open, high: b.high, low: b.low, close: b.close, volume: (b.volume || 0) };
    } else {
      bucket.high = Math.max(bucket.high, b.high);
      bucket.low = Math.min(bucket.low, b.low);
      bucket.close = b.close;
      bucket.volume = (bucket.volume || 0) + (b.volume || 0);
    }
  }
  if (bucket) out.push(bucket);
  return out;
}

// Validate a bar from MotiveWave — rejects corrupted/zero-price bars that
// appear as "little candles at the bottom" when charted.
function isValidBar(b: any): boolean {
  if (!b || !b.time) return false;
  const { open: o, high: h, low: l, close: c } = b;
  if (!o || !h || !l || !c) return false;
  if (h < l || l <= 0 || o <= 0 || c <= 0) return false;
  if (!Number.isFinite(o) || !Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(c)) return false;
  // ES/MES price sanity: should be between 500 and 200,000
  if (l < 500 || h > 200_000) return false;
  // H-L spread > 15% of close = corrupt bar (catch-up candles from MW reconnect)
  if ((h - l) / c > 0.15) return false;
  return true;
}

// Sliding-window Highest(Lowest(low, 20), 20) — matches PC computeVectorLine
function computeVector(candles: any[]): { time: number; value: number }[] {
  const period = 20;
  if (candles.length < period * 2) return [];
  const n = candles.length;
  const lb = new Float64Array(n);
  // Pass 1: Lowest(low, period) — monotonic min deque
  const dq1 = new Int32Array(n); let d1f = 0, d1b = 0;
  for (let i = 0; i < n; i++) {
    while (d1f < d1b && dq1[d1f] <= i - period) d1f++;
    while (d1f < d1b && candles[dq1[d1b - 1]].low >= candles[i].low) d1b--;
    dq1[d1b++] = i; lb[i] = candles[dq1[d1f]].low;
  }
  // Pass 2: Highest(lb, period) — monotonic max deque
  const result: { time: number; value: number }[] = [];
  const dq2 = new Int32Array(n); let d2f = 0, d2b = 0;
  for (let i = 0; i < n; i++) {
    while (d2f < d2b && dq2[d2f] <= i - period) d2f++;
    while (d2f < d2b && lb[dq2[d2b - 1]] <= lb[i]) d2b--;
    dq2[d2b++] = i;
    result.push({ time: candles[i].time, value: lb[dq2[d2f]] });
  }
  return result;
}

function rthSettleOfDay(ts: number): number {
  return Math.floor(ts / 86400) * 86400 + 20 * 3600 + 30 * 60;
}

function forwardFill(
  vec: { time: number; value: number }[],
  chartTimes: number[],
): { time: number; value: number }[] {
  const result: { time: number; value: number }[] = [];
  let lastVal: number | null = null;
  let vi = 0;
  for (const t of chartTimes) {
    while (vi < vec.length && vec[vi].time <= t) { lastVal = vec[vi].value; vi++; }
    if (lastVal !== null) result.push({ time: t, value: lastVal });
  }
  return result;
}

function dedupByTime(arr: any[]): any[] {
  const seen = new Set<number>();
  return arr.filter(b => { if (seen.has(b.time)) return false; seen.add(b.time); return true; });
}

// ── Signal detection — full port of SignalsPanel.tsx computeSignals ────────────
// Three strategies: Vector (tabletop + side entry) + Footprint (proxy) + Milk Zone (graduated)
// Risk tiers: safeplus ≥8pts, safe ≥4pts, risky ≥3pts, riskiest ≥1pt
const COOLDOWN_BARS = 10;   // RTH bars between same-direction signals
const ETH_COOLDOWN  = 20;   // ETH bars between same-direction signals
const TP_FIXED_1    = 10.0;
const TP_FIXED_2    = 20.0;
const SL_FIXED      = 5.0;

// ── Inline proxy footprint types ──────────────────────────────────────────────
interface FpPriceLevel { price: number; bidVol: number; askVol: number; delta: number; imbalance: 'buy'|'sell'|'none' }
interface FpCluster    { direction: 'buy'|'sell'; levelCount: number; stacked: boolean }
interface FpCandle     { time: number; levels: FpPriceLevel[]; totalBidVol: number; totalAskVol: number; candleDelta: number; poc: number; high: number; low: number; imbalances: FpCluster[] }

const FP_THRESH = 1.5; // proxy-mode imbalance threshold

// Port of buildProxyFootprintCandle from footprint-analysis.ts
function buildProxyFp(c: any): FpCandle {
  const vol = c.volume ?? 100;
  const isUp = c.close >= c.open;
  const bodyBot = Math.min(c.open, c.close);
  const bodyTop = Math.max(c.open, c.close);
  const wLow = Math.floor(c.low), wHigh = Math.ceil(c.high);
  const prices: number[] = [];
  for (let p = wLow; p <= wHigh; p++) prices.push(p);
  if (!prices.length) prices.push(Math.round(c.low));

  const bodyTicks = Math.max(1, prices.filter(p => p >= bodyBot - 0.5 && p <= bodyTop + 0.5).length);
  const wickTicks = Math.max(1, prices.length - bodyTicks);
  const vBody = (vol * 0.70) / bodyTicks;
  const vWick = (vol * 0.30) / wickTicks;

  const levels: FpPriceLevel[] = [];
  let poc = prices[0], maxVol = 0;
  for (const price of prices) {
    const inBody = price >= bodyBot - 0.5 && price <= bodyTop + 0.5;
    const lv = inBody ? vBody : vWick;
    let bid: number, ask: number;
    if (inBody) {
      const bodyRange = bodyTop - bodyBot;
      const rel = bodyRange > 0.5 ? (price - bodyBot) / bodyRange : 0.5;
      if (isUp) { const r = 0.75 - rel * 0.20; ask = lv * r; bid = lv * (1 - r); }
      else       { const r = 0.75 - (1 - rel) * 0.20; bid = lv * r; ask = lv * (1 - r); }
    } else if (price < bodyBot) {
      if (isUp) { ask = lv * 0.60; bid = lv * 0.40; } else { bid = lv * 0.70; ask = lv * 0.30; }
    } else {
      if (isUp) { bid = lv * 0.70; ask = lv * 0.30; } else { ask = lv * 0.60; bid = lv * 0.40; }
    }
    const buyR  = bid > 0 ? ask / bid : ask > 0 ? 999 : 1;
    const sellR = ask > 0 ? bid / ask : bid > 0 ? 999 : 1;
    const imbalance: 'buy'|'sell'|'none' = buyR >= FP_THRESH ? 'buy' : sellR >= FP_THRESH ? 'sell' : 'none';
    levels.push({ price, bidVol: bid, askVol: ask, delta: ask - bid, imbalance });
    if (bid + ask > maxVol) { maxVol = bid + ask; poc = price; }
  }

  const imbalances: FpCluster[] = [];
  let csIdx = -1, csDir: 'buy'|'sell'|null = null;
  const flushCluster = (end: number) => {
    if (csIdx < 0 || !csDir) return;
    imbalances.push({ direction: csDir, levelCount: end - csIdx, stacked: end - csIdx >= 3 });
    csIdx = -1; csDir = null;
  };
  for (let i = 0; i < levels.length; i++) {
    const lev = levels[i];
    if (lev.imbalance !== 'none') {
      if (lev.imbalance === csDir) { /* extend cluster */ }
      else { flushCluster(i); csIdx = i; csDir = lev.imbalance; }
    } else flushCluster(i);
  }
  flushCluster(levels.length);

  const totalBidVol = levels.reduce((s, l) => s + l.bidVol, 0);
  const totalAskVol = levels.reduce((s, l) => s + l.askVol, 0);
  return { time: c.time, levels, totalBidVol, totalAskVol,
           candleDelta: totalAskVol - totalBidVol, poc, high: c.high, low: c.low, imbalances };
}

// Always proxy mode on mobile — no veto, confirmed=false, partial = deltaAgrees
function analyzeFp(fp: FpCandle, dir: 'Long'|'Short'): { partial: boolean; vetoed: false; isProxyData: true } {
  const deltaAgrees = dir === 'Long' ? fp.candleDelta > 0 : fp.candleDelta < 0;
  return { partial: deltaAgrees, vetoed: false, isProxyData: true };
}

// Exit strategy profiles — mirrors PC SignalsPanel.tsx EXIT_VIEW_PROFILES (RTH tiers)
const EXIT_STRAT: Record<string, Record<string, { tp1: number; tp2: number; sl: number }>> = {
  tight:    {
    safeplus: { tp1: 14.0, tp2: 28.0, sl:  3.5 }, safe:     { tp1: 12.5, tp2: 25.0, sl:  4.0 },
    risky:    { tp1:  9.0, tp2: 20.0, sl:  5.5 }, riskiest: { tp1:  7.0, tp2: 16.0, sl:  8.0 },
  },
  standard: {
    safeplus: { tp1: 12.0, tp2: 22.0, sl:  4.0 }, safe:     { tp1: 10.0, tp2: 20.0, sl:  5.0 },
    risky:    { tp1:  7.5, tp2: 17.0, sl:  6.5 }, riskiest: { tp1:  5.5, tp2: 13.0, sl:  9.0 },
  },
  wide:     {
    safeplus: { tp1: 18.0, tp2: 35.0, sl:  8.0 }, safe:     { tp1: 16.0, tp2: 30.0, sl: 10.0 },
    risky:    { tp1: 12.0, tp2: 25.0, sl: 12.0 }, riskiest: { tp1: 10.0, tp2: 20.0, sl: 15.0 },
  },
};

export type OutcomeResult = { outcome: 'Win' | 'Loss' | 'Open'; tpHit: 1 | 2 | null; points: number | null };

export interface MobileSignal {
  time: number;
  direction: 'Long' | 'Short';
  riskLevel: 'safeplus' | 'safe' | 'risky' | 'riskiest';
  price: number;
  tp1: number;
  tp2: number;
  sl: number;
  outcome: 'Win' | 'Loss' | 'Open';
  tpHit: 1 | 2 | null;
  points: number | null;
  rth: boolean;
  /** Pre-computed outcomes for each exit strategy (avoids needing candle data later). */
  exitOutcomes: Record<string, OutcomeResult & { tp1: number; tp2: number; sl: number }>;
  /** Which strategies contributed points to this signal. */
  strategies: { fp: boolean; milk: boolean; vec: boolean; milkPts: number };
}

function isBullZone(z: any): boolean {
  // Label-text is the primary classifier — matches PC market.tsx isBullZone()
  const lbl = ((z.label || z.label_raw || '') as string).toLowerCase();
  if (/sell|resist|ceiling|supply|bear|short/.test(lbl)) return false;
  if (/buy|demand|floor|support|bull|long/.test(lbl))    return true;
  // Fall back to color
  const c = (z.fillColor || z.color || '').toLowerCase().trim();
  if (c === '#22c55e' || c === '#3b82f6' || c === '#14b8a6') return true;
  const m = c.match(/rgba?\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (m) { const r = +m[1], g = +m[2], b = +m[3]; return g > r || (b > r && b > g); }
  return false;
}

function computeOutcome(
  sorted: any[], sigIdx: number,
  tp1: number, tp2: number, sl: number, isLong: boolean, sigPrice: number,
): { outcome: 'Win' | 'Loss' | 'Open'; tpHit: 1 | 2 | null; points: number | null } {
  for (let j = sigIdx + 1; j < sorted.length; j++) {
    const f = sorted[j];
    if (isLong) {
      if (f.high >= tp2) return { outcome: 'Win',  tpHit: 2,    points: +(tp2 - sigPrice).toFixed(2) };
      if (f.high >= tp1) return { outcome: 'Win',  tpHit: 1,    points: +(tp1 - sigPrice).toFixed(2) };
      if (f.low  <= sl)  return { outcome: 'Loss', tpHit: null, points: +(sl  - sigPrice).toFixed(2) };
    } else {
      if (f.low  <= tp2) return { outcome: 'Win',  tpHit: 2,    points: +(sigPrice - tp2).toFixed(2) };
      if (f.low  <= tp1) return { outcome: 'Win',  tpHit: 1,    points: +(sigPrice - tp1).toFixed(2) };
      if (f.high >= sl)  return { outcome: 'Loss', tpHit: null, points: +(sigPrice - sl ).toFixed(2) };
    }
  }
  return { outcome: 'Open', tpHit: null, points: null };
}

function computeSignals(candles: any[], vecMap: Map<number, number>, milkZones: any[]): MobileSignal[] {
  if (candles.length < 22) return [];
  const sorted = [...candles].sort((a: any, b: any) => a.time - b.time);
  const results: MobileSignal[] = [];
  let lastLongBar = -COOLDOWN_BARS, lastLongEthBar = -ETH_COOLDOWN;
  let lastShortBar = -COOLDOWN_BARS, lastShortEthBar = -ETH_COOLDOWN;

  // Pre-build proxy footprint for all bars
  const fpByTime = new Map<number, FpCandle>();
  for (const c of sorted) fpByTime.set(c.time, buildProxyFp(c));

  for (let i = 1; i < sorted.length; i++) {
    const c = sorted[i];
    // Skip the forming bar — its close oscillates with live ticks, causing signals
    // to flicker. Only completed bars (complete !== false) produce permanent signals.
    if ((c as any).complete === false) continue;
    const lb = vecMap.get(c.time);
    if (lb == null) continue;

    const d = new Date(c.time * 1000);
    const dow = d.getUTCDay();
    const utcH = d.getUTCHours();
    const minsUtc = utcH * 60 + d.getUTCMinutes();

    // Skip CME settlement/market break (4:30–6pm ET) — DST-aware, matches PC isMarketBreak()
    if (dow >= 1 && dow <= 5) {
      const etStr = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
      const etParts = etStr.split(':').map(Number);
      const etMins = etParts[0] * 60 + etParts[1];
      if (etMins >= 16 * 60 + 30 && etMins < 18 * 60) continue;
    }

    const rthFlag      = dow >= 1 && dow <= 5 && minsUtc >= 13 * 60 + 30 && minsUtc < 20 * 60;
    const isRthForMilk = rthFlag;

    // Graduated milk zone scoring (milkPtsL/S = best zone pts found)
    let milkBullOk = false, milkBearOk = false;
    let milkPtsL = 0, milkPtsS = 0;
    if (isRthForMilk && milkZones.length) {
      for (const z of milkZones) {
        if (!(z.fromTime ?? 0) || c.time < z.fromTime || (z.toTime != null && c.time > z.toTime)) continue;
        const bull = isBullZone(z);
        if (bull) {
          if (c.low <= z.topPrice + 0.5) {
            const below = z.bottomPrice - c.close;
            const pts = below <= 0.5 ? 3 : below <= 1.5 ? 1 : 0;
            if (pts > milkPtsL) { milkPtsL = pts; if (pts > 0) milkBullOk = true; }
          }
        } else {
          if (c.high >= z.bottomPrice - 0.5) {
            const above = c.close - z.topPrice;
            const pts = above <= 0.5 ? 3 : above <= 1.5 ? 1 : 0;
            if (pts > milkPtsS) { milkPtsS = pts; if (pts > 0) milkBearOk = true; }
          }
        }
      }
    }

    const fpCandle = fpByTime.get(c.time)!;
    const prevBarLb  = i > 0 ? vecMap.get(sorted[i - 1].time) : undefined;
    const prevBarLb2 = i > 1 ? vecMap.get(sorted[i - 2].time) : undefined;

    // ── Long ──────────────────────────────────────────────────────────────────
    if (c.close > lb) {
      const fpR = analyzeFp(fpCandle, 'Long');
      if (!fpR.vetoed) {
        // Vector Strategy: side-entry or tabletop retest
        const sideEntry    = prevBarLb != null && sorted[i - 1].close <= prevBarLb && c.close > lb;
        const tabletopTest = prevBarLb != null && prevBarLb2 != null
          && Math.abs(lb - prevBarLb) < 0.5 && Math.abs(prevBarLb - prevBarLb2) < 0.5
          && c.close > lb && c.close >= c.open;
        const vecTestedL = sideEntry || tabletopTest;

        // Footprint Strategy: proxy always partial (max 2pts), never strong (never 4pts)
        const fpFires = fpR.partial; // deltaAgrees
        const fpPts   = fpFires ? 2 : 0;
        const totalPts = fpPts + milkPtsL + (vecTestedL ? 2 : 0);

        if (totalPts >= 1) {
          const level: MobileSignal['riskLevel'] =
            totalPts >= 8 ? 'safeplus' : totalPts >= 4 ? 'safe' : totalPts >= 3 ? 'risky' : 'riskiest';
          if (!(rthFlag && utcH >= 20 && level !== 'safe' && level !== 'safeplus')) {
            const cd = rthFlag ? COOLDOWN_BARS : ETH_COOLDOWN;
            const lastBar = rthFlag ? lastLongBar : lastLongEthBar;
            if (i - lastBar >= cd) {
              if (rthFlag) lastLongBar = i; else lastLongEthBar = i;
              const entry = c.close;
              const tp1 = entry + TP_FIXED_1, tp2 = entry + TP_FIXED_2, sl = entry - SL_FIXED;
              const { outcome, tpHit, points } = computeOutcome(sorted, i, tp1, tp2, sl, true, entry);
              const exitOutcomes: MobileSignal['exitOutcomes'] = {};
              for (const [stratKey, tiers] of Object.entries(EXIT_STRAT)) {
                const e = tiers[level] ?? tiers['safe'];
                const etp1 = entry + e.tp1, etp2 = entry + e.tp2, esl = entry - e.sl;
                exitOutcomes[stratKey] = { ...computeOutcome(sorted, i, etp1, etp2, esl, true, entry), tp1: etp1, tp2: etp2, sl: esl };
              }
              results.push({ time: c.time, direction: 'Long', price: entry, tp1, tp2, sl,
                riskLevel: level, outcome, tpHit, points, rth: rthFlag, exitOutcomes,
                strategies: { fp: fpFires, milk: milkPtsL > 0, vec: vecTestedL, milkPts: milkPtsL } });
            }
          }
        }
      }
    }

    // ── Short ─────────────────────────────────────────────────────────────────
    if (c.close < lb) {
      const fpR = analyzeFp(fpCandle, 'Short');
      if (!fpR.vetoed) {
        const sideEntry    = prevBarLb != null && sorted[i - 1].close >= prevBarLb && c.close < lb;
        const tabletopTest = prevBarLb != null && prevBarLb2 != null
          && Math.abs(lb - prevBarLb) < 0.5 && Math.abs(prevBarLb - prevBarLb2) < 0.5
          && c.close < lb && c.close <= c.open;
        const vecTestedS = sideEntry || tabletopTest;

        const fpFires = fpR.partial;
        const fpPts   = fpFires ? 2 : 0;
        const totalPts = fpPts + milkPtsS + (vecTestedS ? 2 : 0);

        if (totalPts >= 1) {
          const level: MobileSignal['riskLevel'] =
            totalPts >= 8 ? 'safeplus' : totalPts >= 4 ? 'safe' : totalPts >= 3 ? 'risky' : 'riskiest';
          if (!(rthFlag && utcH >= 20 && level !== 'safe' && level !== 'safeplus')) {
            const cd = rthFlag ? COOLDOWN_BARS : ETH_COOLDOWN;
            const lastBar = rthFlag ? lastShortBar : lastShortEthBar;
            if (i - lastBar >= cd) {
              if (rthFlag) lastShortBar = i; else lastShortEthBar = i;
              const entry = c.close;
              const tp1 = entry - TP_FIXED_1, tp2 = entry - TP_FIXED_2, sl = entry + SL_FIXED;
              const { outcome, tpHit, points } = computeOutcome(sorted, i, tp1, tp2, sl, false, entry);
              const exitOutcomes: MobileSignal['exitOutcomes'] = {};
              for (const [stratKey, tiers] of Object.entries(EXIT_STRAT)) {
                const e = tiers[level] ?? tiers['safe'];
                const etp1 = entry - e.tp1, etp2 = entry - e.tp2, esl = entry + e.sl;
                exitOutcomes[stratKey] = { ...computeOutcome(sorted, i, etp1, etp2, esl, false, entry), tp1: etp1, tp2: etp2, sl: esl };
              }
              results.push({ time: c.time, direction: 'Short', price: entry, tp1, tp2, sl,
                riskLevel: level, outcome, tpHit, points, rth: rthFlag, exitOutcomes,
                strategies: { fp: fpFires, milk: milkPtsS > 0, vec: vecTestedS, milkPts: milkPtsS } });
            }
          }
        }
      }
    }
  }
  return results;
}

// ── Yellow Box pivot levels from yesterday's RTH session ──────────────────────

function isRTH(ts: number): boolean {
  const d = new Date(ts * 1000);
  const dow = d.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  return mins >= 13 * 60 + 30 && mins < 20 * 60;
}

function computeYellowBoxLevels(rawBars: any[]): {
  levels: { price: number; label: string; color: string }[];
  sessionStart: number;
  sessionEnd: number;
} | null {
  const nowSec = Math.floor(Date.now() / 1000);
  const dow = new Date(nowSec * 1000).getUTCDay();
  const rollback = dow === 0 ? 2 : dow === 6 ? 1 : 0;
  const tradingDay = (Math.floor(nowSec / 86400) - rollback) * 86400;
  const rthOpen  = tradingDay + 13 * 3600 + 30 * 60;
  const rthClose = tradingDay + 20 * 3600;

  const prevOpen  = rthOpen  - 86400;
  const prevClose = rthClose - 86400;
  const prevBars = rawBars
    .filter((b: any) => isRTH(b.time) && b.time >= prevOpen && b.time <= prevClose)
    .sort((a: any, b: any) => a.time - b.time);
  if (prevBars.length < 5) return null;

  const pH = Math.max(...prevBars.map((b: any) => b.high));
  const pL = Math.min(...prevBars.map((b: any) => b.low));
  const pC = prevBars[prevBars.length - 1].close;
  const range = pH - pL;
  if (range <= 0) return null;

  const P  = +((pH + pL + pC) / 3).toFixed(2);
  const R1 = +(2 * P - pL).toFixed(2);
  const S1 = +(2 * P - pH).toFixed(2);
  const R2 = +(P + range).toFixed(2);
  const S2 = +(P - range).toFixed(2);
  const ivWall  = +(P + (R1 - P) * 0.5).toFixed(2);
  const sellObj = +(P + (R1 - P) * 0.38).toFixed(2);
  const buyObj  = +(P - (P - S1) * 0.38).toFixed(2);
  const wkStart = rthOpen - 5 * 86400;
  const wkBars  = rawBars.filter((b: any) => isRTH(b.time) && b.time >= wkStart && b.time < rthOpen);
  const wkHigh  = wkBars.length ? Math.max(...wkBars.map((b: any) => b.high)) : pH;
  const maxRange = +(P + range).toFixed(2);
  const maxTrend = +(P + range * 1.5).toFixed(2);

  const allLevels = [
    { price: R1,       label: 'RESISTANCE',           color: '#ef4444' },
    { price: S1,       label: 'SUPPORT',              color: '#22c55e' },
    { price: P,        label: 'Pivot',                color: '#ffd700' },
    { price: R2,       label: 'Non Fair Value Upper', color: '#f97316' },
    { price: S2,       label: 'Non Fair Value Lower', color: '#60a5fa' },
    { price: ivWall,   label: 'IV Wall',              color: '#a855f7' },
    { price: sellObj,  label: 'Seller Objective',     color: '#fca5a5' },
    { price: buyObj,   label: 'Buyer Objective',      color: '#86efac' },
    { price: wkHigh,   label: 'Weekly Ceiling',       color: '#fbbf24' },
    { price: maxRange, label: 'Max Range Day',        color: '#cbd5e1' },
    { price: maxTrend, label: 'Max Trend Day',        color: '#94a3b8' },
  ].filter(l => Number.isFinite(l.price) && l.price > 0);

  const seen = new Set<number>();
  const levels = allLevels.filter(l => {
    const k = Math.round(l.price * 4);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  return { levels, sessionStart: rthOpen, sessionEnd: rthClose };
}

// ── Session aggregate zone helpers ────────────────────────────────────────────

interface SessLevel { price: number; bidVol: number; askVol: number; }
interface SessAgg   { time: number; symbol: string; levels: SessLevel[]; }
interface SessZone  { nextSessT: number; bp: number; dir: 'buy' | 'sell'; stacked: boolean; }

function getSessionAnchor(t: number): { key: number; symbol: 'RTH' | 'ETH' } {
  const d = new Date(t * 1000);
  const dow = d.getUTCDay();
  const dayBase = Math.floor(t / 86400) * 86400;
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  if (dow >= 1 && dow <= 5 && mins >= 13 * 60 + 30 && mins < 20 * 60)
    return { key: dayBase + 13 * 3600 + 30 * 60, symbol: 'RTH' };
  const ethAnchor = dayBase + 20 * 3600 + 30 * 60;
  if (t >= ethAnchor) return { key: ethAnchor, symbol: 'ETH' };
  return { key: dayBase - 86400 + 20 * 3600 + 30 * 60, symbol: 'ETH' };
}

function buildSessAggregates(candles: any[]): SessAgg[] {
  const sessMap = new Map<number, { symbol: string; levelMap: Map<number, { bid: number; ask: number }> }>();
  for (const c of candles) {
    const { key, symbol } = getSessionAnchor(c.time);
    if (!sessMap.has(key)) sessMap.set(key, { symbol, levelMap: new Map() });
    const sess = sessMap.get(key)!;
    const fp = buildProxyFp(c);
    for (const lv of fp.levels) {
      const p = Math.round(lv.price);
      const ex = sess.levelMap.get(p) ?? { bid: 0, ask: 0 };
      ex.bid += lv.bidVol; ex.ask += lv.askVol;
      sess.levelMap.set(p, ex);
    }
  }
  const result: SessAgg[] = [];
  for (const [key, { symbol, levelMap }] of sessMap.entries()) {
    const levels: SessLevel[] = [];
    for (const [price, { bid, ask }] of levelMap.entries())
      levels.push({ price, bidVol: bid, askVol: ask });
    result.push({ time: key, symbol, levels });
  }
  return result.sort((a, b) => a.time - b.time);
}

function detectSessZones(sessAggs: SessAgg[], candles: any[]): SessZone[] {
  const DIAG = 3.0;
  const sortedCans = [...candles].sort((a, b) => a.time - b.time);
  const zones: SessZone[] = [];
  for (let si = 0; si < sessAggs.length - 1; si++) {
    const sfp = sessAggs[si];
    if (!sfp.levels.length) continue;
    const nextSessT = sessAggs[si + 1].time;
    let lo = 0, hi = sortedCans.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (sortedCans[mid].time < nextSessT) lo = mid + 1; else hi = mid; }
    const postStart = lo;
    const prices = sfp.levels.map(l => l.price);
    const minP = Math.min(...prices), maxP = Math.max(...prices);
    const bktStart = Math.floor(minP / 2) * 2;
    const bktMap = new Map<number, { bid: number; ask: number }>();
    for (let bp = bktStart - 2; bp <= maxP + 4; bp += 2) {
      const inB = sfp.levels.filter(l => l.price >= bp && l.price < bp + 2);
      bktMap.set(bp, { bid: inB.reduce((s, l) => s + l.bidVol, 0), ask: inB.reduce((s, l) => s + l.askVol, 0) });
    }
    const imbalDir = new Map<number, 'buy' | 'sell'>();
    for (let bp = bktStart; bp <= maxP; bp += 2) {
      const cur   = bktMap.get(bp)     ?? { bid: 0, ask: 0 };
      const below = bktMap.get(bp - 2) ?? { bid: 0, ask: 0 };
      const above = bktMap.get(bp + 2) ?? { bid: 0, ask: 0 };
      const buyR  = below.bid > 0 ? cur.ask / below.bid : cur.ask > 0 ? 999 : 0;
      const sellR = above.ask > 0 ? cur.bid / above.ask : cur.bid > 0 ? 999 : 0;
      if (buyR  >= DIAG && cur.ask >= cur.bid) imbalDir.set(bp, 'buy');
      else if (sellR >= DIAG && cur.bid >= cur.ask) imbalDir.set(bp, 'sell');
    }
    if (!imbalDir.size) continue;
    const stackedSet = new Set<number>();
    for (const [bp, dir] of imbalDir) {
      if (imbalDir.get(bp - 2) === dir || imbalDir.get(bp + 2) === dir) {
        stackedSet.add(bp);
        if (imbalDir.get(bp - 2) === dir) stackedSet.add(bp - 2);
        if (imbalDir.get(bp + 2) === dir) stackedSet.add(bp + 2);
      }
    }
    for (const [bp, dir] of imbalDir) {
      let mitigated = false;
      for (let mi = postStart; mi < sortedCans.length; mi++) {
        const mc = sortedCans[mi];
        if (dir === 'buy' ? mc.close < bp : mc.close > bp + 2) { mitigated = true; break; }
      }
      if (!mitigated) zones.push({ nextSessT, bp, dir, stacked: stackedSet.has(bp) });
    }
  }
  return zones;
}

// ── Component ──────────────────────────────────────────────────────────────────

interface ChartViewProps {
  onPriceRange?: (high: number, low: number) => void;
  onSignals?: (signals: MobileSignal[]) => void;
  scrollToTime?: number | null;
}

export function ChartView({ onPriceRange, onSignals, scrollToTime }: ChartViewProps) {
  const { instrument, timeframe, apiBaseUrl, strategies, zones } = useApp();
  const webViewRef = useRef<WebView>(null);
  const [chartReady, setChartReady] = useState(false);
  const [lwScript, setLwScript] = useState<string | null>(null);
  const [lwError, setLwError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  // Keep latest zones in a ref so the signal effect can reference them
  const zonesRef = useRef(zones);
  useEffect(() => { zonesRef.current = zones; }, [zones]);

  // scrollToTime ref — updated every render so the async load closure reads latest value
  const scrollToTimeRef = useRef<number | null>(null);
  scrollToTimeRef.current = scrollToTime ?? null;

  const retryCountRef = useRef(0);

  const sym = instrument.replace(/[^A-Za-z0-9]/g, '').replace(/\d+$/, '');
  const fetchInterval = FETCH_INTERVAL[timeframe];
  const displayMin = DISPLAY_MIN[timeframe];

  useEffect(() => {
    getLwScript().then(setLwScript).catch(e => setLwError(String(e)));
  }, []);

  const html = useMemo(() => (lwScript ? buildHtml(lwScript) : null), [lwScript]);

  // Load candle data + compute vectors + signals
  useEffect(() => {
    if (!chartReady) return;
    let cancelled = false;

    async function load() {
      try {
        webViewRef.current?.injectJavaScript(`window.setStatus('Loading data…');true;`);

        // ── Fetch display candles — 90-day window matches PC view ────────────
        const nowSec  = Math.floor(Date.now() / 1000);
        const fromSec = nowSec - 90 * 86400;
        const toSec   = nowSec + 86400;
        const url = `${apiBaseUrl}/api/data/cached-continuous/${sym}/${fetchInterval}?from=${fromSec}&to=${toSec}`;
        const resp = await fetchWithTimeout(url, 15000);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const raw = await resp.json();
        if (cancelled) return;

        const rawBars: any[] = Array.isArray(raw) ? raw : (raw.candles ?? raw.bars ?? []);
        const source: string = (raw as any).source ?? 'unknown';

        if (!rawBars.length || source === 'none') {
          webViewRef.current?.injectJavaScript(`window.setStatus('Not connected to MotiveWave');true;`);
          return;
        }
        retryCountRef.current = 0;

        // ── Fetch 1m bars for vector computation ──────────────────────────────
        let rawBars1m: any[] = fetchInterval === '1m' ? rawBars : [];
        if (fetchInterval !== '1m') {
          try {
            const r1m = await fetch(`${apiBaseUrl}/api/data/cached-continuous/${sym}/1m?from=${fromSec}&to=${toSec}`);
            if (r1m.ok) {
              const d1m = await r1m.json();
              rawBars1m = Array.isArray(d1m) ? d1m : (d1m.candles ?? d1m.bars ?? []);
            }
          } catch { /* non-fatal */ }
        }
        if (cancelled) return;

        // ── Validate + sort — removes corrupted "little candles" from MW ──────
        const valid1m = dedupByTime(
          (rawBars1m.length ? rawBars1m : rawBars)
            .filter(isValidBar)
            .sort((a: any, b: any) => a.time - b.time)
        );
        const validDisplay = dedupByTime(
          rawBars.filter(isValidBar).sort((a: any, b: any) => a.time - b.time)
        );

        // ── Display candles for current timeframe ─────────────────────────────
        // Shows ALL historical data from MotiveWave (no RTH filter).
        // Weekend/overnight gaps appear naturally on the time axis.
        const candles = dedupByTime(aggToInterval(validDisplay, displayMin))
          .sort((a: any, b: any) => a.time - b.time);
        const chartTimes = candles.map((c: any) => c.time);

        if (!candles.length) {
          webViewRef.current?.injectJavaScript(`window.setStatus('No data available');true;`);
          return;
        }

        // ── Vectors — 4 intervals, computed on validated 1m base bars ─────────
        const base5m  = dedupByTime(aggToInterval(valid1m, 5)).sort((a: any, b: any) => a.time - b.time);
        const base15m = dedupByTime(aggToInterval(base5m, 15)).sort((a: any, b: any) => a.time - b.time);
        const base60m = dedupByTime(aggToInterval(base5m, 60)).sort((a: any, b: any) => a.time - b.time);

        const makeVec = (base: any[]) =>
          base.length >= 40 ? forwardFill(computeVector(base), chartTimes) : [];

        const vec1m  = makeVec(valid1m);
        const vec5m  = makeVec(base5m);
        const vec15m = makeVec(base15m);
        const vec60m = makeVec(base60m);

        // Trim to last 600 bars before sending to WebView — injectJavaScript silently
        // drops payloads over ~1MB on iOS WKWebView, causing the chart to never appear.
        // Send last 1000 bars immediately so chart appears fast, then stream older data
        const INITIAL_BARS = 1000;
        const CHUNK_SIZE   = 800;
        const chartCandles = candles.length > INITIAL_BARS ? candles.slice(-INITIAL_BARS) : candles;
        const trimFrom = chartCandles.length > 0 ? chartCandles[0].time : 0;
        const trimVec = (v: any[]) => v.filter((p: any) => p.time >= trimFrom);

        webViewRef.current?.injectJavaScript(
          `window.setChartData(${JSON.stringify(chartCandles)},${JSON.stringify(trimVec(vec1m))},${JSON.stringify(trimVec(vec5m))},${JSON.stringify(trimVec(vec15m))},${JSON.stringify(trimVec(vec60m))},'${timeframe}');true;`
        );

        // Stream older history in chunks so the chart has full depth
        if (candles.length > INITIAL_BARS) {
          const olderCandles = candles.slice(0, -INITIAL_BARS);
          for (let ci = olderCandles.length; ci > 0 && !cancelled; ci -= CHUNK_SIZE) {
            const chunk = olderCandles.slice(Math.max(0, ci - CHUNK_SIZE), ci);
            const chunkFrom = chunk[0].time;
            const cv = (v: any[]) => v.filter((p: any) => p.time >= chunkFrom);
            await new Promise(r => setTimeout(r, 120));
            if (cancelled) break;
            webViewRef.current?.injectJavaScript(
              `window.prependChartData(${JSON.stringify(chunk)},${JSON.stringify(cv(vec1m))},${JSON.stringify(cv(vec5m))},${JSON.stringify(cv(vec15m))},${JSON.stringify(cv(vec60m))},'${timeframe}');true;`
            );
          }
        }

        // Connect live WebSocket
        const wsBase = apiBaseUrl.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
        webViewRef.current?.injectJavaScript(
          `window.connectLive('${wsBase}/ws/live-bars','${sym}','${fetchInterval}',${displayMin * 60});true;`
        );

        // Report visible price range
        if (onPriceRange && candles.length > 0) {
          const recent = candles.slice(-100);
          onPriceRange(
            Math.max(...recent.map((b: any) => b.high)),
            Math.min(...recent.map((b: any) => b.low)),
          );
        }

        // ── Pull signals directly from the PC's saved DB — exact parity ────────
        let signals: MobileSignal[] = [];
        try {
          const sr = await fetchWithTimeout(
            `${apiBaseUrl}/api/signals/history/${encodeURIComponent(sym.toUpperCase())}/${timeframe}`, 8000
          );
          if (sr.ok) {
            const sd = await sr.json();
            const cutoff = Math.floor(Date.now() / 1000) - 90 * 86400;
            signals = (sd.signals ?? [])
              .filter((s: any) => s.timestamp >= cutoff)
              .map((s: any) => {
                const isLong = s.direction === 'Long';
                // DB stores outcomes as 'win_tp2'/'win_tp1'/'win_trailer'/'loss' (PC format)
                const isTp2  = s.outcome === 'win_tp2'  || s.outcome === 'tp2';
                const isTp1  = s.outcome === 'win_tp1'  || s.outcome === 'win_trailer' || s.outcome === 'tp1';
                const isLoss = s.outcome === 'loss'     || s.outcome === 'sl';
                const pts = isTp2  ? (isLong ? s.tp2 - s.entry : s.entry - s.tp2)
                          : isTp1  ? (isLong ? s.tp1 - s.entry : s.entry - s.tp1)
                          : isLoss ? (isLong ? s.sl  - s.entry : s.entry - s.sl)
                          : null;
                const oc: MobileSignal['outcome'] = (isTp2 || isTp1) ? 'Win' : isLoss ? 'Loss' : 'Open';
                return {
                  time:         s.timestamp,
                  direction:    s.direction,
                  riskLevel:    s.riskLevel,
                  price:        s.entry,
                  tp1:          s.tp1,
                  tp2:          s.tp2,
                  sl:           s.sl,
                  outcome:      oc,
                  tpHit:        isTp2 ? 2 : isTp1 ? 1 : null,
                  points:       pts !== null ? +pts.toFixed(2) : null,
                  rth:          isRTH(s.timestamp),
                  exitOutcomes: {},
                  strategies:   { fp: false, milk: false, vec: false, milkPts: 0 },
                } as MobileSignal;
              });
          }
        } catch { /* non-fatal */ }
        if (cancelled) return;

        // ── Fetch zones from server for visual display ────────────────────────
        // Today-only: zones posted after midnight UTC today (no yesterday carry-over)
        const todayMidnightUtc = Math.floor(Date.now() / 1000 / 86400) * 86400;
        const fromTs = todayMidnightUtc;
        const toTs   = Math.floor(Date.now() / 1000) + 86400;
        try {
          const zr = await fetchWithTimeout(
            `${apiBaseUrl}/api/discord-zones?from_ts=${fromTs}&to_ts=${toTs}&symbol=${sym}`, 8000
          );
          if (zr.ok) {
            const zd = await zr.json();
            // RTH settle for today — zones are scoped to end-of-RTH (4:30 PM ET = 20:30 UTC)
            const todaySettle = todayMidnightUtc + 20 * 3600 + 30 * 60;
            const serverZones = (zd.zones ?? []).map((z: any) => ({
              topPrice:    z.top,
              bottomPrice: z.bottom,
              // Support zones = green, resistance zones = red — match MotiveWave colors
              fillColor:   z.is_bull ? 'rgba(34,197,94,0.25)' : 'rgba(239,68,68,0.25)',
              fromTime:    z.posted_at,
              toTime:      todaySettle,
              label:       z.label_raw,
            }));
            const allZones = [...serverZones, ...zonesRef.current];
            if (allZones.length) {
              webViewRef.current?.injectJavaScript(
                `window.setZones(${JSON.stringify(allZones)},${strategies.milkZones});true;`
              );
            }
          }
        } catch { /* non-fatal */ }
        if (cancelled) return;

        const fullFrom = candles.length > 0 ? candles[0].time : 0;
        const chartSignals = signals.filter(s => s.time >= fullFrom);
        if (chartSignals.length) {
          webViewRef.current?.injectJavaScript(
            `window.setSignals(${JSON.stringify(chartSignals)});true;`
          );
        }
        if (signals.length) onSignals?.(signals);

        // Scroll to requested candle after data is loaded
        if (scrollToTimeRef.current != null) {
          webViewRef.current?.injectJavaScript(
            `window.scrollToTime(${scrollToTimeRef.current},${displayMin * 60});true;`
          );
        }

        // ── Footprint chart — real DX Feed data if available, proxy from OHLCV otherwise ─
        if (strategies.footprint && !cancelled) {
          try {
            // Session boundary: RTH = 13:30–20:30 UTC weekdays; ETH = everything else
            const fpNow = Math.floor(Date.now() / 1000);
            const fpMidnight = Math.floor(fpNow / 86400) * 86400;
            const fpRthStart = fpMidnight + 13 * 3600 + 30 * 60;
            const fpRthEnd   = fpMidnight + 20 * 3600 + 30 * 60;
            const fpDow = new Date(fpNow * 1000).getUTCDay();
            const fpWeekday = fpDow >= 1 && fpDow <= 5;
            let sessionFrom: number;
            if (fpWeekday && fpNow >= fpRthStart && fpNow < fpRthEnd) {
              sessionFrom = fpRthStart;           // inside RTH — show from today's open
            } else if (fpWeekday && fpNow >= fpRthEnd) {
              sessionFrom = fpRthEnd;             // post-RTH ETH — show from today's close
            } else {
              // Pre-market or weekend — ETH from previous RTH close (last weekday 20:30 UTC)
              const daysBack = fpDow === 0 ? 2 : fpDow === 1 ? 3 : 1;
              sessionFrom = fpMidnight - daysBack * 86400 + 20 * 3600 + 30 * 60;
            }

            let fpCandles: any[] = [];
            // Try server real footprint data (populated by MotiveWave DX Feed tick relay)
            const fpResp = await fetchWithTimeout(
              `${apiBaseUrl}/api/footprint/history/${sym}/${fetchInterval}`, 6000
            );
            if (fpResp.ok) {
              const fpData = await fpResp.json();
              if (Array.isArray(fpData) && fpData.length > 0) fpCandles = fpData;
            }
            // Scope to current session only — do not show prior sessions' imbalances
            if (!fpCandles.length) {
              fpCandles = candles
                .filter((c: any) => c.time >= sessionFrom)
                .map((c: any) => buildProxyFp(c));
            } else {
              fpCandles = fpCandles.filter((c: any) => c.time >= sessionFrom);
            }
            // Minimize payload: last 100 candles, only fields needed for rendering
            const fpPayload = fpCandles.slice(-100).map((c: any) => ({
              time: c.time,
              levels: (c.levels ?? []).map((l: any) => ({
                price:     l.price,
                bidVol:    Math.round((l.bidVol  ?? 0) * 10) / 10,
                askVol:    Math.round((l.askVol  ?? 0) * 10) / 10,
                imbalance: l.imbalance ?? 'none',
              })),
              candleDelta: Math.round((c.candleDelta ?? 0) * 10) / 10,
              poc:  c.poc  ?? 0,
              high: c.high ?? 0,
              low:  c.low  ?? 0,
            }));
            if (!cancelled && fpPayload.length) {
              webViewRef.current?.injectJavaScript(
                `window.setFootprintData(${JSON.stringify(fpPayload)},${displayMin * 60},true);true;`
              );
            }

            // ── Session aggregate zones (diagonal 3:1, stacked, mitigated) ────
            if (!cancelled) {
              try {
                const sessAggs = buildSessAggregates(candles);
                const sessZones = detectSessZones(sessAggs, candles);
                const lastCandleT = candles.length > 0 ? candles[candles.length - 1].time : Math.floor(Date.now() / 1000);
                if (sessZones.length) {
                  webViewRef.current?.injectJavaScript(
                    `window.setSessionZones(${JSON.stringify(sessZones)},${lastCandleT});true;`
                  );
                }
              } catch { /* non-fatal */ }
            }
          } catch { /* non-fatal */ }
        }

        // ── Yellow Box pivot levels ───────────────────────────────────────────
        if (strategies.milkZones) {
          const ybox = computeYellowBoxLevels(valid1m.length ? valid1m : validDisplay);
          if (ybox) {
            webViewRef.current?.injectJavaScript(
              `window.setYellowBoxData(${JSON.stringify(ybox.levels)},${ybox.sessionStart},${ybox.sessionEnd},true);true;`
            );
          }
        }

      } catch (e) {
        if (!cancelled) {
          console.warn('[ChartView]', e);
          retryCountRef.current++;
          const attempt = retryCountRef.current;
          const delay = Math.min(2000 * attempt, 15000);
          const errStr = e instanceof Error ? e.message : String(e);
          const shortErr = errStr.length > 80 ? errStr.slice(0, 77) + '…' : errStr;
          const safeErr = shortErr.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, ' ');
          const safeUrl = apiBaseUrl.replace(/'/g, "\\'");
          webViewRef.current?.injectJavaScript(
            `window.setStatus('${safeErr}\\n\\nURL: ${safeUrl}\\nRetrying in ${Math.round(delay/1000)}s… (attempt ${attempt})');true;`
          );
          setTimeout(() => { if (!cancelled) setRefreshTick(t => t + 1); }, delay);
        }
      }
    }

    load();
    return () => { cancelled = true; };
  }, [chartReady, sym, fetchInterval, displayMin, apiBaseUrl, instrument, timeframe, refreshTick, strategies.milkZones, strategies.footprint]);

  // Sync vector visibility
  useEffect(() => {
    if (!chartReady) return;
    webViewRef.current?.injectJavaScript(`window.setVectorVisible(${strategies.vector});true;`);
  }, [chartReady, strategies.vector]);

  // Sync footprint visibility without reloading data
  useEffect(() => {
    if (!chartReady) return;
    webViewRef.current?.injectJavaScript(`window.setFootprintVisible(${strategies.footprint});true;`);
  }, [chartReady, strategies.footprint]);

  // Sync screenshot-imported zones — drawn as full-width horizontal bands
  useEffect(() => {
    if (!chartReady) return;
    webViewRef.current?.injectJavaScript(
      `window.setZones(${JSON.stringify(zones)},${strategies.milkZones && zones.length > 0});true;`
    );
    // Also toggle yellow box when milkZones switch changes
    webViewRef.current?.injectJavaScript(
      `if(typeof yboxLevels!=='undefined'&&yboxLevels.length){yboxVisible=${strategies.milkZones};requestAnimationFrame(drawYellowBox);}true;`
    );
  }, [chartReady, strategies.milkZones, zones]);

  const handleRefresh = useCallback(() => setRefreshTick(t => t + 1), []);

  if (lwError) {
    return (
      <View style={[styles.container, styles.center]}>
        <Text style={{ color: Trading.red, fontWeight: '600', marginBottom: 6 }}>Failed to load chart library</Text>
        <Text style={{ color: Trading.muted, fontSize: 12, textAlign: 'center', paddingHorizontal: 32 }}>{lwError}</Text>
      </View>
    );
  }
  if (!html) {
    return (
      <View style={[styles.container, styles.center]}>
        <ActivityIndicator color={Trading.accent} size="large" />
        <Text style={{ color: Trading.muted, marginTop: 14, fontSize: 13 }}>Loading chart library…</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <WebView
        ref={webViewRef}
        originWhitelist={['*']}
        source={{ html }}
        style={styles.webview}
        scrollEnabled={false}
        bounces={false}
        overScrollMode="never"
        javaScriptEnabled
        domStorageEnabled
        mixedContentMode="always"
        onLoadEnd={() => setChartReady(true)}
        onMessage={(e) => {
          try {
            const msg = JSON.parse(e.nativeEvent.data);
            if (msg.type === 'ready') {
              setChartReady(true);
            } else if (msg.type === 'bar_complete') {
              // A display-interval candle just closed — re-fetch signals so any new
              // ones the PC computed in the last bar become visible immediately.
              fetchWithTimeout(
                `${apiBaseUrl}/api/signals/history/${encodeURIComponent(sym.toUpperCase())}/${timeframe}`, 6000
              ).then(async (sr) => {
                if (!sr.ok) return;
                const sd = await sr.json();
                const cutoff = Math.floor(Date.now() / 1000) - 90 * 86400;
                const fresh: MobileSignal[] = (sd.signals ?? [])
                  .filter((s: any) => s.timestamp >= cutoff)
                  .map((s: any) => {
                    const isLong = s.direction === 'Long';
                    const isTp2  = s.outcome === 'win_tp2'  || s.outcome === 'tp2';
                    const isTp1  = s.outcome === 'win_tp1'  || s.outcome === 'win_trailer' || s.outcome === 'tp1';
                    const isLoss = s.outcome === 'loss'     || s.outcome === 'sl';
                    const pts = isTp2  ? (isLong ? s.tp2 - s.entry : s.entry - s.tp2)
                              : isTp1  ? (isLong ? s.tp1 - s.entry : s.entry - s.tp1)
                              : isLoss ? (isLong ? s.sl  - s.entry : s.entry - s.sl)
                              : null;
                    return {
                      time:         s.timestamp,
                      direction:    s.direction,
                      riskLevel:    s.riskLevel,
                      price:        s.entry,
                      tp1:          s.tp1,
                      tp2:          s.tp2,
                      sl:           s.sl,
                      outcome:      ((isTp2 || isTp1) ? 'Win' : isLoss ? 'Loss' : 'Open') as MobileSignal['outcome'],
                      tpHit:        isTp2 ? 2 : isTp1 ? 1 : null,
                      points:       pts !== null ? +pts.toFixed(2) : null,
                      rth:          isRTH(s.timestamp),
                      exitOutcomes: {},
                      strategies:   { fp: false, milk: false, vec: false, milkPts: 0 },
                    } as MobileSignal;
                  });
                webViewRef.current?.injectJavaScript(
                  `window.setSignals(${JSON.stringify(fresh)});true;`
                );
                if (fresh.length) onSignals?.(fresh);
              }).catch(() => {});
            }
          } catch {}
        }}
        onError={(e) => console.warn('[ChartView] error', e.nativeEvent)}
      />
      <Pressable
        style={({ pressed }) => [styles.refreshBtn, pressed && { opacity: 0.6 }]}
        onPress={handleRefresh}
        hitSlop={12}
      >
        <Text style={styles.refreshIcon}>↻</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Trading.bg },
  webview: { flex: 1, backgroundColor: Trading.bg },
  center: { alignItems: 'center', justifyContent: 'center' },
  refreshBtn: {
    position: 'absolute', top: 10, right: 10,
    width: 34, height: 34, borderRadius: 17,
    backgroundColor: Trading.surface + 'cc',
    borderWidth: 1, borderColor: Trading.border,
    alignItems: 'center', justifyContent: 'center',
  },
  refreshIcon: { color: Trading.muted, fontSize: 18, lineHeight: 20 },
});
