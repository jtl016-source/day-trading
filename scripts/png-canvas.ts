/**
 * png-canvas.ts — pure-JS PNG raster canvas + encoder + 5x7 bitmap font.
 *
 * Extracted VERBATIM from scripts/yellowbox.ts (which keeps its own private copy because it
 * is a CLI script that executes at module load and therefore cannot be imported). Zero native
 * deps: PNG is encoded with node:zlib and text is drawn with the hand-rolled 5x7 bitmap font.
 * Used by scripts/fact-engine-backtest.ts to render the Monte-Carlo signal-envelope charts
 * embedded into the Excel workbook via exceljs addImage.
 */

import * as zlib from "node:zlib";

// ====================== 5x7 BITMAP FONT ======================

export const FONT: Record<string, string[]> = {
  "A": [".XXX.", "X...X", "X...X", "XXXXX", "X...X", "X...X", "X...X"],
  "B": ["XXXX.", "X...X", "X...X", "XXXX.", "X...X", "X...X", "XXXX."],
  "C": [".XXX.", "X...X", "X....", "X....", "X....", "X...X", ".XXX."],
  "D": ["XXXX.", "X...X", "X...X", "X...X", "X...X", "X...X", "XXXX."],
  "E": ["XXXXX", "X....", "X....", "XXXX.", "X....", "X....", "XXXXX"],
  "F": ["XXXXX", "X....", "X....", "XXXX.", "X....", "X....", "X...."],
  "G": [".XXX.", "X...X", "X....", "X.XXX", "X...X", "X...X", ".XXX."],
  "H": ["X...X", "X...X", "X...X", "XXXXX", "X...X", "X...X", "X...X"],
  "I": ["XXXXX", "..X..", "..X..", "..X..", "..X..", "..X..", "XXXXX"],
  "J": ["..XXX", "...X.", "...X.", "...X.", "...X.", "X..X.", ".XX.."],
  "K": ["X...X", "X..X.", "X.X..", "XX...", "X.X..", "X..X.", "X...X"],
  "L": ["X....", "X....", "X....", "X....", "X....", "X....", "XXXXX"],
  "M": ["X...X", "XX.XX", "X.X.X", "X.X.X", "X...X", "X...X", "X...X"],
  "N": ["X...X", "XX..X", "X.X.X", "X..XX", "X...X", "X...X", "X...X"],
  "O": [".XXX.", "X...X", "X...X", "X...X", "X...X", "X...X", ".XXX."],
  "P": ["XXXX.", "X...X", "X...X", "XXXX.", "X....", "X....", "X...."],
  "Q": [".XXX.", "X...X", "X...X", "X...X", "X.X.X", "X..X.", ".XX.X"],
  "R": ["XXXX.", "X...X", "X...X", "XXXX.", "X.X..", "X..X.", "X...X"],
  "S": [".XXXX", "X....", "X....", ".XXX.", "....X", "....X", "XXXX."],
  "T": ["XXXXX", "..X..", "..X..", "..X..", "..X..", "..X..", "..X.."],
  "U": ["X...X", "X...X", "X...X", "X...X", "X...X", "X...X", ".XXX."],
  "V": ["X...X", "X...X", "X...X", "X...X", ".X.X.", ".X.X.", "..X.."],
  "W": ["X...X", "X...X", "X...X", "X.X.X", "X.X.X", "XX.XX", "X...X"],
  "X": ["X...X", "X...X", ".X.X.", "..X..", ".X.X.", "X...X", "X...X"],
  "Y": ["X...X", "X...X", ".X.X.", "..X..", "..X..", "..X..", "..X.."],
  "Z": ["XXXXX", "....X", "...X.", "..X..", ".X...", "X....", "XXXXX"],
  "0": [".XXX.", "X...X", "X..XX", "X.X.X", "XX..X", "X...X", ".XXX."],
  "1": ["..X..", ".XX..", "..X..", "..X..", "..X..", "..X..", "XXXXX"],
  "2": [".XXX.", "X...X", "....X", "...X.", "..X..", ".X...", "XXXXX"],
  "3": [".XXX.", "X...X", "....X", "..XX.", "....X", "X...X", ".XXX."],
  "4": ["...X.", "..XX.", ".X.X.", "X..X.", "XXXXX", "...X.", "...X."],
  "5": ["XXXXX", "X....", "XXXX.", "....X", "....X", "X...X", ".XXX."],
  "6": [".XXX.", "X....", "X....", "XXXX.", "X...X", "X...X", ".XXX."],
  "7": ["XXXXX", "....X", "...X.", "..X..", ".X...", ".X...", ".X..."],
  "8": [".XXX.", "X...X", "X...X", ".XXX.", "X...X", "X...X", ".XXX."],
  "9": [".XXX.", "X...X", "X...X", ".XXXX", "....X", "....X", ".XXX."],
  " ": [".....", ".....", ".....", ".....", ".....", ".....", "....."],
  ".": [".....", ".....", ".....", ".....", ".....", ".XX..", ".XX.."],
  ",": [".....", ".....", ".....", ".....", "..X..", "..X..", ".X..."],
  "-": [".....", ".....", ".....", ".XXX.", ".....", ".....", "....."],
  ":": [".....", ".XX..", ".XX..", ".....", ".XX..", ".XX..", "....."],
  "(": ["...X.", "..X..", ".X...", ".X...", ".X...", "..X..", "...X."],
  ")": [".X...", "..X..", "...X.", "...X.", "...X.", "..X..", ".X..."],
  "/": ["....X", "....X", "...X.", "..X..", ".X...", "X....", "X...."],
  "%": ["XX..X", "XX..X", "...X.", "..X..", ".X...", "X..XX", "X..XX"],
  "+": [".....", "..X..", "..X..", "XXXXX", "..X..", "..X..", "....."],
  "<": ["...X.", "..X..", ".X...", "X....", ".X...", "..X..", "...X."],
  ">": [".X...", "..X..", "...X.", "....X", "...X.", "..X..", ".X..."],
  "=": [".....", "XXXXX", ".....", "XXXXX", ".....", ".....", "....."],
  "|": ["..X..", "..X..", "..X..", "..X..", "..X..", "..X..", "..X.."],
  "'": ["..X..", "..X..", ".....", ".....", ".....", ".....", "....."],
  "_": [".....", ".....", ".....", ".....", ".....", ".....", "XXXXX"],
  "?": [".XXX.", "X...X", "....X", "...X.", "..X..", ".....", "..X.."],
  "!": ["..X..", "..X..", "..X..", "..X..", "..X..", ".....", "..X.."],
  "[": [".XXX.", ".X...", ".X...", ".X...", ".X...", ".X...", ".XXX."],
  "]": [".XXX.", "...X.", "...X.", "...X.", "...X.", "...X.", ".XXX."],
  "~": [".....", ".....", ".X...", "X.X.X", "...X.", ".....", "....."],
  "*": [".....", "X.X.X", ".XXX.", "XXXXX", ".XXX.", "X.X.X", "....."],
};

// ========================= RASTER CANVAS =========================

export type RGB = [number, number, number];

export class Raster {
  readonly w: number;
  readonly h: number;
  readonly px: Uint8Array; // RGB, opaque

  constructor(w: number, h: number, bg: RGB) {
    this.w = w; this.h = h;
    this.px = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) {
      this.px[i * 3] = bg[0]; this.px[i * 3 + 1] = bg[1]; this.px[i * 3 + 2] = bg[2];
    }
  }

  set(x: number, y: number, c: RGB, alpha = 1): void {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 3;
    if (alpha >= 1) {
      this.px[i] = c[0]; this.px[i + 1] = c[1]; this.px[i + 2] = c[2];
    } else {
      this.px[i] = Math.round(c[0] * alpha + this.px[i] * (1 - alpha));
      this.px[i + 1] = Math.round(c[1] * alpha + this.px[i + 1] * (1 - alpha));
      this.px[i + 2] = Math.round(c[2] * alpha + this.px[i + 2] * (1 - alpha));
    }
  }

  fillRect(x: number, y: number, w: number, h: number, c: RGB, alpha = 1): void {
    const x0 = Math.max(0, Math.round(x)), y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(this.w, Math.round(x + w)), y1 = Math.min(this.h, Math.round(y + h));
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) this.set(xx, yy, c, alpha);
  }

  hLine(x0: number, x1: number, y: number, c: RGB, alpha = 1, dash = 0, gap = 0): void {
    const a = Math.min(x0, x1), b = Math.max(x0, x1);
    for (let x = a; x <= b; x++) {
      if (dash > 0 && ((x - a) % (dash + gap)) >= dash) continue;
      this.set(x, y, c, alpha);
    }
  }

  vLine(x: number, y0: number, y1: number, c: RGB, alpha = 1, dash = 0, gap = 0): void {
    const a = Math.min(y0, y1), b = Math.max(y0, y1);
    for (let y = a; y <= b; y++) {
      if (dash > 0 && ((y - a) % (dash + gap)) >= dash) continue;
      this.set(x, y, c, alpha);
    }
  }

  rectOutline(x: number, y: number, w: number, h: number, c: RGB, alpha = 1): void {
    this.hLine(x, x + w - 1, y, c, alpha);
    this.hLine(x, x + w - 1, y + h - 1, c, alpha);
    this.vLine(x, y, y + h - 1, c, alpha);
    this.vLine(x + w - 1, y, y + h - 1, c, alpha);
  }

  text(x: number, y: number, s: string, c: RGB, scale = 1, alpha = 1): void {
    let cx = Math.round(x);
    for (const chRaw of s.toUpperCase()) {
      const glyph = FONT[chRaw] ?? FONT[" "];
      for (let ry = 0; ry < 7; ry++) {
        const row = glyph[ry];
        for (let rx = 0; rx < 5; rx++) {
          if (row[rx] === "X") {
            for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) {
              this.set(cx + rx * scale + sx, y + ry * scale + sy, c, alpha);
            }
          }
        }
      }
      cx += 6 * scale;
    }
  }

  textRight(xRight: number, y: number, s: string, c: RGB, scale = 1, alpha = 1): void {
    this.text(xRight - (s.length * 6 - 1) * scale, y, s, c, scale, alpha);
  }
}

export function textWidth(s: string, scale = 1): number { return (s.length * 6 - 1) * scale; }

// ========================= PNG ENCODER =========================

const CRC_TABLE = ((): Uint32Array => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  Buffer.from(data).copy(out, 8);
  const crcBuf = Buffer.alloc(4 + data.length);
  crcBuf.write(type, 0, "ascii");
  Buffer.from(data).copy(crcBuf, 4);
  out.writeUInt32BE(crc32(crcBuf), 8 + data.length);
  return out;
}

export function encodePNG(r: Raster): Buffer {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(r.w, 0);
  ihdr.writeUInt32BE(r.h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // color type: truecolor RGB
  const raw = Buffer.alloc((r.w * 3 + 1) * r.h);
  for (let y = 0; y < r.h; y++) {
    const rowStart = y * (r.w * 3 + 1);
    raw[rowStart] = 0; // filter: none
    Buffer.from(r.px.subarray(y * r.w * 3, (y + 1) * r.w * 3)).copy(raw, rowStart + 1);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, pngChunk("IHDR", ihdr), pngChunk("IDAT", idat), pngChunk("IEND", new Uint8Array(0))]);
}
