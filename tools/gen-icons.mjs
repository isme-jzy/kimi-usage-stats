import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

// rgba: Uint8Array，长度 width*height*4
export function encodePng(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8bit RGBA
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // filter: none
    Buffer.from(rgba.buffer, y * width * 4, width * 4).copy(raw, y * stride + 1);
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// 与 LOGO_SVG 同图形：深蓝渐变圆角方块 + 白色月牙（开口朝右上）+ 右上浅蓝星点。
// 配色与 lib/brand.js 的品牌常量保持一致（渐变 #1D4ED8→#0B1220 / 月 #F8FAFF / 星 #93C5FD）。
const BG_TOP = [29, 78, 216];       // #1D4ED8
const BG_BOTTOM = [11, 18, 32];     // #0B1220
const MOON = [248, 250, 255];       // #F8FAFF
const DOT = [147, 197, 253];        // #93C5FD

// 抗锯齿：SSAA。每个像素按 ss×ss 子采样，颜色按覆盖率混合，alpha = 覆盖率×255，
// 使圆角、月牙与点缀的边缘有平滑的过渡（避免 put(alpha=255) 的硬边锯齿）。
export function drawIcon(size, ss = 4) {
  const px = new Uint8Array(size * size * 4);
  const corner = size * 0.23;
  const cx = size / 2, cy = size / 2;
  const R = size * 0.31;
  const c2x = cx + size * 0.12, c2y = cy - size * 0.10, R2 = R * 0.82;
  const dotX = cx + size * 0.19, dotY = cy - size * 0.17, dotR = size * 0.06;
  // 斜向线性渐变底色：左上 #1D4ED8 → 右下 #0B1220
  const bgAt = (gx, gy) => {
    const t = Math.min(1, Math.max(0, (gx + gy) / (2 * size)));
    return [
      Math.round(BG_TOP[0] + (BG_BOTTOM[0] - BG_TOP[0]) * t),
      Math.round(BG_TOP[1] + (BG_BOTTOM[1] - BG_TOP[1]) * t),
      Math.round(BG_TOP[2] + (BG_BOTTOM[2] - BG_TOP[2]) * t),
    ];
  };
  const inRoundRect = (gx, gy) => {
    const qx = Math.min(gx, size - 1 - gx), qy = Math.min(gy, size - 1 - gy);
    return qx >= corner || qy >= corner || (qx - corner) ** 2 + (qy - corner) ** 2 <= corner ** 2;
  };
  const dist2 = (x, y, ax, ay) => (x - ax) ** 2 + (y - ay) ** 2;
  const inv = 1 / ss;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      const covered = ss * ss;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const gx = x + (sx + 0.5) * inv;
          const gy = y + (sy + 0.5) * inv;
          if (!inRoundRect(gx, gy)) continue;
          let c = bgAt(gx, gy);
          if (dist2(gx, gy, cx, cy) < R ** 2 && dist2(gx, gy, c2x, c2y) > R2 ** 2) c = MOON;
          if (dist2(gx, gy, dotX, dotY) < dotR ** 2) c = DOT;
          r += c[0]; g += c[1]; b += c[2]; a += 255;
        }
      }
      const i = (y * size + x) * 4;
      if (a === 0) { px[i + 3] = 0; continue; }
      px[i] = Math.round(r / covered);
      px[i + 1] = Math.round(g / covered);
      px[i + 2] = Math.round(b / covered);
      px[i + 3] = Math.round(a / covered);
    }
  }
  return px;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');
  mkdirSync(outDir, { recursive: true });
  for (const size of [16, 48, 128]) {
    writeFileSync(join(outDir, `icon-${size}.png`), encodePng(size, size, drawIcon(size)));
  }
  console.log('icons written to', outDir);
}
