// Generates the planner's PNG app icons with no external dependencies.
// Shapes are described in a 0-100 unit space and supersampled 4x for antialiasing.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = process.argv[2] || '.';

// ---------- PNG encoding (truecolor, no alpha) ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePNG(size, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // color type: truecolor
  const raw = Buffer.alloc(size * (size * 3 + 1));
  let p = 0;
  for (let y = 0; y < size; y++) {
    raw[p++] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 3;
      raw[p++] = rgb[i]; raw[p++] = rgb[i + 1]; raw[p++] = rgb[i + 2];
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- geometry ----------
const hex = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const C = {
  pink: hex('#f9c9cb'), cream: hex('#fffdf9'), ink: hex('#3a3a3a'),
  teal: hex('#b3ddd1'), purple: hex('#cdb9ea'), lime: hex('#d7df75'),
  green: hex('#6fbf82'), line: hex('#e4e0d8'),
};

// Signed-distance style test for a rounded rectangle.
function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= r * r + 1e-9;
}

// Paints one sample point in 0-100 space; later shapes win (painter's algorithm).
// `inset` shrinks the artwork toward the centre for maskable safe-zone icons:
// the point is inverse-mapped, so anything outside falls through to background.
function sample(u, v, inset) {
  const x = 50 + (u - 50) / inset, y = 50 + (v - 50) / inset;

  let col = C.pink; // full-bleed background

  const cardX0 = 16, cardY0 = 12, cardX1 = 84, cardY1 = 88, cardR = 9;
  if (inRoundRect(x, y, cardX0, cardY0, cardX1, cardY1, cardR)) {
    col = C.ink; // border
    const b = 3.2;
    if (inRoundRect(x, y, cardX0 + b, cardY0 + b, cardX1 - b, cardY1 - b, cardR - b)) {
      col = C.cream;
      // teal header band, clipped to the card's inner rounded top
      if (y < cardY0 + b + 13) col = C.teal;

      // three checklist rows
      const rows = [
        { y0: 36, done: true,  bar: 70, barCol: C.line },
        { y0: 53, done: false, bar: 72, barCol: C.purple },
        { y0: 70, done: false, bar: 64, barCol: C.lime },
      ];
      for (const r of rows) {
        // checkbox
        if (inRoundRect(x, y, 24, r.y0, 33, r.y0 + 9, 2.4)) {
          col = C.ink;
          if (inRoundRect(x, y, 25.4, r.y0 + 1.4, 31.6, r.y0 + 7.6, 1.4)) {
            col = r.done ? C.green : C.cream;
          }
        }
        // bar
        if (inRoundRect(x, y, 38, r.y0 + 2.6, r.bar, r.y0 + 6.4, 1.9)) col = r.barCol;
      }
    }
  }
  return col;
}

function render(size, inset) {
  const SS = 4; // supersample factor
  const rgb = Buffer.alloc(size * size * 3);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = ((px + (sx + 0.5) / SS) / size) * 100;
          const v = ((py + (sy + 0.5) / SS) / size) * 100;
          const c = sample(u, v, inset);
          r += c[0]; g += c[1]; b += c[2];
        }
      }
      const n = SS * SS, i = (py * size + px) * 3;
      rgb[i] = Math.round(r / n); rgb[i + 1] = Math.round(g / n); rgb[i + 2] = Math.round(b / n);
    }
  }
  return encodePNG(size, rgb);
}

const targets = [
  { file: 'icon-180.png', size: 180, inset: 1 },     // apple-touch-icon
  { file: 'icon-192.png', size: 192, inset: 1 },
  { file: 'icon-512.png', size: 512, inset: 1 },
  { file: 'icon-maskable-512.png', size: 512, inset: 0.72 }, // content inside the safe zone
];

fs.mkdirSync(OUT, { recursive: true });
for (const t of targets) {
  const buf = render(t.size, t.inset);
  fs.writeFileSync(path.join(OUT, t.file), buf);
  console.log(t.file + '  ' + t.size + 'x' + t.size + '  ' + buf.length + ' bytes');
}
