// 生成 assets/icon.png —— 无外部依赖（node:zlib 手写 PNG）。
// 信封 + 折角，深蓝底金字，与插件界面的黑金/深蓝调性一致。
// 一次性工具：图标只在需要换图时重跑。
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const S = 512;
const px = new Uint8Array(S * S * 4);

function set(x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= S || y >= S) return;
  const i = (y * S + x) * 4;
  px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
}

// 圆角矩形填充（带 1px 软边，避免锯齿太硬）
const R = 96;
function inRounded(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

const BG = [22, 27, 42];        // 深蓝底
const GOLD = [201, 162, 77];    // 金字
const PAPER = [238, 232, 216];  // 信封纸色

for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    if (inRounded(x, y, 0, 0, S - 1, S - 1, R)) set(x, y, BG[0], BG[1], BG[2]);
  }
}

// 信封主体
const ex0 = 96, ey0 = 148, ex1 = S - 96, ey1 = S - 148;
for (let y = ey0; y <= ey1; y++) {
  for (let x = ex0; x <= ex1; x++) {
    if (inRounded(x, y, ex0, ey0, ex1, ey1, 18)) set(x, y, PAPER[0], PAPER[1], PAPER[2]);
  }
}

// 信封折线（V 形）
function line(x0, y0, x1, y1, color, w = 12) {
  const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0)) * 2;
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const cx = Math.round(x0 + (x1 - x0) * t);
    const cy = Math.round(y0 + (y1 - y0) * t);
    for (let dy = -w; dy <= w; dy++) {
      for (let dx = -w; dx <= w; dx++) {
        if (dx * dx + dy * dy > w * w) continue;
        set(cx + dx, cy + dy, color[0], color[1], color[2]);
      }
    }
  }
}
const midX = Math.round((ex0 + ex1) / 2);
line(ex0 + 14, ey0 + 12, midX, ey0 + 96, GOLD, 10);
line(midX, ey0 + 96, ex1 - 14, ey0 + 12, GOLD, 10);

// 编码 PNG
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}
let T = null;
function crc32(buf) {
  if (!T) {
    T = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      T[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const b of buf) c = T[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const raw = Buffer.alloc((S * 4 + 1) * S);
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0; // filter: none
  Buffer.from(px.buffer, y * S * 4, S * 4).copy(raw, y * (S * 4 + 1) + 1);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

const out = path.join(__dirname, "..", "assets", "icon.png");
fs.writeFileSync(out, png);
console.log(`icon written: ${out} (${png.length} bytes, ${S}x${S})`);
