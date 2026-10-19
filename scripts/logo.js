// Draws Knot into assets/: knot.svg (README, GitHub), knot.png (social preview), knot.ico
// (the Windows executable's icon), and knot-transparent.svg/.png/.ico (just the otter, no background),
// all from the pixels in src/knot.js, each with the Git logo as a badge in the bottom-right corner.
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

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), 255];

// The Git logo, in the 92 × 92 frame of its official SVG: an orange rounded diamond with a white
// branch (a line in from the top-left edge, a node, a stem down to a node and a branch to the right).
const GIT = '#f05032';
const WHITE = '#ffffff';
const DIAMOND = { half: 46 / Math.SQRT2, round: 4.2 };
const STROKE = 5.79 / 2;
const NODE = 7.04;
const TOP = [46.38, 27.5];
const RIGHT = [65.29, 46.54];
const BOTTOM = [46.2, 65.67];
const LINES = [[[20, 1], TOP], [TOP, BOTTOM], [TOP, RIGHT]];

// Where the badge goes, in drawing cells: on the dark square (20 cells), on the transparent square
// (16 cells), and on the otter cropped to its own W × H.
const BADGE = {
  square: { cx: 15, cy: 15, r: 4, gap: 0.6 },
  icon: { cx: 12.5, cy: 12.5, r: 3.3, gap: 0.5 },
  cropped: { cx: W - 2.8, cy: H - 2.8, r: 2.8, gap: 0.45 },
};
const scaled = ({ cx, cy, r, gap }, k) => ({ cx: cx * k, cy: cy * k, r: r * k, gap: gap * k });

/** Signed distance from the diamond's edge (negative inside). */
function diamondDistance(x, y) {
  const u = Math.abs((x - 46 + (y - 46)) / Math.SQRT2) - (DIAMOND.half - DIAMOND.round);
  const v = Math.abs((x - 46 - (y - 46)) / Math.SQRT2) - (DIAMOND.half - DIAMOND.round);
  return Math.hypot(Math.max(u, 0), Math.max(v, 0)) + Math.min(Math.max(u, v), 0) - DIAMOND.round;
}

function onBranch(x, y) {
  const near = ([ax, ay], [bx, by]) => {
    const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)));
    return Math.hypot(x - ax - t * (bx - ax), y - ay - t * (by - ay)) <= STROKE;
  };
  return [TOP, RIGHT, BOTTOM].some(([cx, cy]) => Math.hypot(x - cx, y - cy) <= NODE) || LINES.some(([a, b]) => near(a, b));
}

/**
 * Puts the Git badge on RGBA rows, centred at (cx, cy) with half-diagonal r, in image pixels,
 * cut out of the picture by a `gap`-wide ring of `gapColor` so it stands apart from Knot.
 * Each pixel averages 4 × 4 samples, so the badge's edges are smooth at any size.
 */
function withBadge(rows, { cx, cy, r, gap, gapColor }) {
  const unit = r / 46; // image pixels per logo unit
  const n = 4;
  for (let y = Math.floor(cy - r - gap); y <= Math.ceil(cy + r + gap); y++) {
    const row = rows[y];
    if (!row) continue;
    for (let x = Math.floor(cx - r - gap); x <= Math.ceil(cx + r + gap); x++) {
      if (x < 0 || x >= row.length / 4) continue;
      const under = row.slice(x * 4, x * 4 + 4);
      const sum = [0, 0, 0, 0];
      for (let sy = 0; sy < n; sy++) {
        for (let sx = 0; sx < n; sx++) {
          const bx = 46 + (x + (sx + 0.5) / n - cx) / unit;
          const by = 46 + (y + (sy + 0.5) / n - cy) / unit;
          const d = diamondDistance(bx, by);
          const c = d <= 0 ? hex(onBranch(bx, by) ? WHITE : GIT) : d * unit <= gap ? gapColor : under;
          // Premultiplied, so transparent samples don't darken the edge.
          for (let i = 0; i < 3; i++) sum[i] += (c[i] * c[3]) / 255;
          sum[3] += c[3];
        }
      }
      const a = sum[3] / (n * n);
      const px = a ? [...sum.slice(0, 3).map((v) => Math.round((v / (n * n)) * (255 / a))), Math.round(a)] : [0, 0, 0, 0];
      row.splice(x * 4, 4, ...px);
    }
  }
  return rows;
}

/** The same badge as SVG, plus a mask that cuts its gap out of whatever it sits on. */
function svgBadge({ cx, cy, r, gap }) {
  const k = (r / 46).toFixed(5);
  const at = `translate(${cx - r} ${cy - r}) scale(${k})`;
  const shape = (pad, fill) =>
    `<rect x="${-DIAMOND.half - pad}" y="${-DIAMOND.half - pad}" width="${2 * (DIAMOND.half + pad)}" height="${2 * (DIAMOND.half + pad)}" rx="${DIAMOND.round + pad}" fill="${fill}" transform="translate(46 46) rotate(45)"/>`;
  const p = (n) => n.toFixed(2);
  const lines = LINES.map(([[x1, y1], [x2, y2]]) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`).join('');
  const nodes = [TOP, RIGHT, BOTTOM].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="${NODE}"/>`).join('');
  return {
    defs: `<defs>
<clipPath id="git-diamond">${shape(0, '#000')}</clipPath>
<mask id="git-gap" maskUnits="userSpaceOnUse"><rect x="-1" y="-1" width="999" height="999" fill="#fff"/><g transform="${at}">${shape(gap / (r / 46), '#000')}</g></mask>
</defs>`,
    badge: `<g transform="${at}" shape-rendering="geometricPrecision">${shape(0, GIT)}<g clip-path="url(#git-diamond)" fill="${WHITE}" stroke="${WHITE}" stroke-width="${p(2 * STROKE)}" stroke-linecap="round">${lines}</g><g fill="${WHITE}">${nodes}</g></g>`,
  };
}

// Square canvas with the otter centred and a margin, as RGBA rows.
function canvas(size) {
  const cells = 20; // the drawing is 16 × 10; leave room around it
  const scale = size / cells;
  const ox = (cells - W) / 2;
  const oy = (cells - H) / 2;
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
  return withBadge(rows, { ...scaled(BADGE.square, scale), gapColor: bg });
}

// Just the otter on transparency, cropped to the drawing: `scale` image pixels per drawing pixel.
function bare(scale) {
  const rows = [];
  for (let y = 0; y < H * scale; y++) {
    const row = [];
    for (let x = 0; x < W * scale; x++) {
      const c = px[Math.floor(y / scale)][Math.floor(x / scale)];
      row.push(...(PALETTE[c] ? hex(PALETTE[c]) : [0, 0, 0, 0]));
    }
    rows.push(row);
  }
  return withBadge(rows, { ...scaled(BADGE.cropped, scale), gapColor: [0, 0, 0, 0] });
}

/** Encodes RGBA rows as a PNG; a number means the square background canvas of that size. */
function png(image) {
  const rows = typeof image === 'number' ? canvas(image) : image;
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
  ihdr.writeUInt32BE(rows[0].length / 4, 0);
  ihdr.writeUInt32BE(rows.length, 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ICO files may hold PNGs directly (Windows Vista and later).
// The otter centred on a transparent square, for icons. 16 cells across, so the usual icon
// sizes (16, 32, 48 … 256) are whole multiples and every pixel stays crisp.
function bareSquare(size) {
  const cells = 16;
  const scale = size / cells;
  const ox = Math.floor((cells - W) / 2);
  const oy = Math.floor((cells - H) / 2);
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = [];
    for (let x = 0; x < size; x++) {
      const c = px[Math.floor(y / scale) - oy]?.[Math.floor(x / scale) - ox];
      row.push(...(PALETTE[c] ? hex(PALETTE[c]) : [0, 0, 0, 0]));
    }
    rows.push(row);
  }
  return withBadge(rows, { ...scaled(BADGE.icon, scale), gapColor: [0, 0, 0, 0] });
}

// An uncompressed 32-bit icon image: BITMAPINFOHEADER, BGRA rows bottom-up, then the 1-bit
// transparency mask older readers use. Every program that reads .ico files reads these.
function dib(rows) {
  const w = rows[0].length / 4;
  const h = rows.length;
  const maskRow = Math.ceil(w / 32) * 4;
  const head = Buffer.alloc(40);
  head.writeUInt32LE(40, 0);
  head.writeInt32LE(w, 4);
  head.writeInt32LE(h * 2, 8); // colour rows plus mask rows
  head.writeUInt16LE(1, 12);
  head.writeUInt16LE(32, 14);
  head.writeUInt32LE(w * h * 4 + maskRow * h, 20);
  const pixels = Buffer.alloc(w * h * 4);
  const mask = Buffer.alloc(maskRow * h);
  for (let y = 0; y < h; y++) {
    const src = rows[h - 1 - y];
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = src.slice(x * 4, x * 4 + 4);
      pixels.set([b, g, r, a], (y * w + x) * 4);
      if (a === 0) mask[y * maskRow + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return Buffer.concat([head, pixels, mask]);
}

/**
 * An .ico with one image per size; `draw(size)` makes each (the dark square by default).
 * Bitmaps up to 128 px and a PNG at 256, the usual layout: some readers can't decode small PNGs.
 */
function ico(sizes, draw = canvas) {
  const images = sizes.map((s) => (s >= 256 ? png(draw(s)) : dib(draw(s))));
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

/** The logo as SVG: on its dark rounded square, or with `background: false` just the otter, cropped. */
function svg({ background = true } = {}) {
  const cells = background ? 20 : null;
  const ox = background ? (cells - W) / 2 : 0;
  const oy = background ? (cells - H) / 2 : 0;
  const rects = [];
  px.forEach((row, y) =>
    [...row].forEach((c, x) => {
      if (PALETTE[c]) rects.push(`<rect x="${x + ox}" y="${y + oy}" width="1.02" height="1.02" fill="${PALETTE[c]}"/>`);
    }),
  );
  const box = background ? `0 0 ${cells} ${cells}` : `0 0 ${W} ${H}`;
  const { defs, badge } = svgBadge(background ? BADGE.square : BADGE.cropped);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box}" shape-rendering="crispEdges">
<title>Knot, the Tiller otter</title>
${defs}
${background ? `<rect width="${cells}" height="${cells}" rx="3.6" fill="${BG}"/>\n` : ''}<g mask="url(#git-gap)">
${rects.join('\n')}
</g>
${badge}
</svg>
`;
}

mkdirSync('assets', { recursive: true });
writeFileSync('assets/knot.svg', svg());
writeFileSync('assets/knot.png', png(512));
writeFileSync('assets/knot.ico', ico([16, 24, 32, 48, 64, 128, 256]));
// Just the otter on transparency, for light pages, slides and stickers.
writeFileSync('assets/knot-transparent.svg', svg({ background: false }));
writeFileSync('assets/knot-transparent.png', png(bare(32)));
writeFileSync('assets/knot-transparent@4x.png', png(bare(128)));
writeFileSync('assets/knot-transparent.ico', ico([16, 32, 48, 64, 128, 256], bareSquare));
console.log('assets/knot.svg, knot.png, knot.ico, knot-transparent.svg, knot-transparent.png, knot-transparent@4x.png, knot-transparent.ico');
