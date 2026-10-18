// Draw the extension icon (a white bookmark ribbon on a blue rounded square) at the sizes Chrome
// needs, as plain PNGs with no image library. Run: node scripts/make-icons.js
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";

const BLUE = [51, 112, 255];
const WHITE = [255, 255, 255];

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

// Coverage of one pixel by the shape, sampled 4x4 for smooth edges.
function coverage(x, y, inside) {
  let hits = 0;
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) if (inside(x + (i + 0.5) / 4, y + (j + 0.5) / 4)) hits++;
  return hits / 16;
}

function icon(size) {
  const s = size;
  const r = s * 0.22;
  const inSquare = (x, y) => {
    const dx = Math.max(r - x, 0, x - (s - r));
    const dy = Math.max(r - y, 0, y - (s - r));
    return dx * dx + dy * dy <= r * r;
  };
  // Ribbon: a rectangle with a V notch cut from the bottom.
  const left = s * 0.32, right = s * 0.68, top = s * 0.2, bottom = s * 0.8, notch = s * 0.16;
  const inRibbon = (x, y) => {
    if (x < left || x > right || y < top || y > bottom) return false;
    const mid = (left + right) / 2;
    const depth = notch * (1 - Math.abs(x - mid) / ((right - left) / 2));
    return y <= bottom - depth;
  };

  const raw = Buffer.alloc(s * (s * 4 + 1));
  for (let y = 0; y < s; y++) {
    raw[y * (s * 4 + 1)] = 0; // filter: none
    for (let x = 0; x < s; x++) {
      const a = coverage(x, y, inSquare);
      const w = coverage(x, y, inRibbon);
      const px = BLUE.map((c, i) => Math.round(c * (1 - w) + WHITE[i] * w));
      raw.set([...px, Math.round(a * 255)], y * (s * 4 + 1) + 1 + x * 4);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(s, 0);
  ihdr.writeUInt32BE(s, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync(new URL("../icons/", import.meta.url), { recursive: true });
for (const size of [16, 32, 48, 128]) writeFileSync(new URL(`../icons/icon-${size}.png`, import.meta.url), icon(size));
