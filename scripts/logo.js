// Draws Knot into assets/: knot.svg (README, GitHub), knot.png (social preview) and knot.ico
// (the Windows executable's icon), all from the pixels in src/knot.js.
//   node scripts/logo.js
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { PALETTE, knotPixels } from '../src/knot.js';

const BG = '#16201a';
// Trim the empty columns kept for the waving paw, so the face sits in the middle.
const full = knotPixels('idle');
const used = [...full[0]].map((_, x) => full.some((row) => row[x] !== '.'));
const first = used.indexOf(true);
const last = used.lastIndexOf(true);
const px = full.map((row) => row.slice(first, last + 1));
const W = px[0].length;
const H = px.length;

// Square canvas with the otter centred and a margin, as RGBA rows.
function canvas(size) {
  const cells = 20; // the drawing is 16 × 10; leave room around it
  const scale = size / cells;
  const ox = (cells - W) / 2;
  const oy = (cells - H) / 2;
  const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), 255];
  const bg = hex(BG);
  const radius = size * 0.18;
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = [];
    for (let x = 0; x < size; x++) {
      // Rounded square background, transparent outside the corners.
      const cx = Math.max(radius - x, x - (size - 1 - radius), 0);
      const cy = Math.max(radius - y, y - (size - 1 - radius), 0);
      if (cx * cx + cy * cy > radius * radius) {
        row.push(0, 0, 0, 0);
        continue;
      }
      const c = px[Math.floor(y / scale - oy)]?.[Math.floor(x / scale - ox)];
      row.push(...(PALETTE[c] ? hex(PALETTE[c]) : bg));
    }
    rows.push(row);
  }
  return rows;
}

function png(size) {
  const rows = canvas(size);
  const raw = Buffer.concat(rows.map((r) => Buffer.from([0, ...r])));
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ICO files may hold PNGs directly (Windows Vista and later).
function ico(sizes) {
  const images = sizes.map(png);
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const entries = images.map((img, i) => {
    const e = Buffer.alloc(16);
    e[0] = sizes[i] >= 256 ? 0 : sizes[i];
    e[1] = sizes[i] >= 256 ? 0 : sizes[i];
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(img.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += img.length;
    return e;
  });
  return Buffer.concat([header, ...entries, ...images]);
}

function svg() {
  const cells = 20;
  const ox = (cells - W) / 2;
  const oy = (cells - H) / 2;
  const rects = [];
  px.forEach((row, y) =>
    [...row].forEach((c, x) => {
      if (PALETTE[c]) rects.push(`<rect x="${x + ox}" y="${y + oy}" width="1.02" height="1.02" fill="${PALETTE[c]}"/>`);
    }),
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${cells} ${cells}" shape-rendering="crispEdges">
<title>Knot, the Tiller otter</title>
<rect width="${cells}" height="${cells}" rx="3.6" fill="${BG}"/>
${rects.join('\n')}
</svg>
`;
}

mkdirSync('assets', { recursive: true });
writeFileSync('assets/knot.svg', svg());
writeFileSync('assets/knot.png', png(512));
writeFileSync('assets/knot.ico', ico([16, 24, 32, 48, 64, 128, 256]));
console.log('assets/knot.svg, assets/knot.png, assets/knot.ico');
