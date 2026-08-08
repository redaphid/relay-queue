'use strict';

/*
 * icons.js — the app icons, drawn and PNG-encoded here rather than committed.
 *
 * Android will not offer "Add to Home Screen" without real PNG icons, and a
 * manifest that points at an SVG or a data: URI is refused by Chrome. So the
 * page finally needs binary assets, which this repo has never had.
 *
 * Rather than check opaque blobs into git, they are generated: a few hundred
 * bytes of deflate per icon, drawn once on first request and held in memory.
 * That keeps `public/` text-only, keeps the icons reviewable as *code* — the
 * colours below are the same ones the stylesheet uses, and can be seen to be —
 * and keeps the zero-dependency rule, since node's zlib is all an encoder needs.
 *
 * This mirrors push.js: implement the format by hand rather than take a
 * dependency for it. A PNG is a signature, an IHDR, one deflated IDAT and an
 * IEND, and nothing here needs more than that.
 */

const zlib = require('node:zlib');

// ---------------------------------------------------------------- PNG encoding

/*
 * CRC-32, the reflected IEEE polynomial every PNG chunk carries. node ≥20 has
 * zlib.crc32, but engines says >=18 and a wrong answer here is an unreadable
 * file rather than a soft failure, so it is computed rather than assumed.
 */
let CRC_TABLE = null;
function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  CRC_TABLE = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    CRC_TABLE[n] = c;
  }
  return CRC_TABLE;
}

function crc32(buf) {
  const t = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([len, typed, crc]);
}

/** 8-bit RGBA (colour type 6), no interlacing. `rgba` is width*height*4 bytes. */
function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type: truecolour with alpha
  ihdr[10] = 0; // compression: deflate, the only one defined
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // interlace: none

  /*
   * Every scanline is prefixed with its filter byte. 0 (None) is used
   * throughout: the image is a flat field and one smooth disc, which deflate
   * already compresses to a couple of kilobytes, so the usual Paeth filtering
   * would buy nothing worth the code.
   */
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const at = y * (stride + 1);
    raw[at] = 0;
    rgba.copy(raw, at + 1, y * stride, y * stride + stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- the drawing

/*
 * The palette is lifted from the stylesheet rather than re-picked, so the
 * installed icon is the same blue-to-violet the header rule and the send button
 * use: --accent-grad is `hsl(217 84% 54%)` to `hsl(267 76% 56%)`, over the dark
 * theme's --bg. Written as HSL for the same reason the CSS is: so the next
 * person can see that it matches, instead of comparing hex triples.
 */
const BG = [0x0e, 0x11, 0x16];        // --bg, dark theme
const FROM = [217, 0.84, 0.54];       // --accent-grad start
const TO = [267, 0.76, 0.56];         // --accent-grad end

function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const m = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) { r = c; g = x; } else if (hp < 2) { r = x; g = c; } else if (hp < 3) { g = c; b = x; } else if (hp < 4) { g = x; b = c; } else if (hp < 5) { r = x; b = c; } else { r = c; b = x; }
  return [
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255),
  ];
}

/*
 * One disc on a full-bleed field, which is the favicon the page already uses.
 *
 * `discRatio` is the disc's radius as a fraction of the icon's width, and it is
 * the whole reason there are two sizes of the same picture. A maskable icon is
 * cropped by the launcher to whatever shape the OS likes, and only the central
 * 80% — a circle of radius 0.4w — is guaranteed to survive. So the maskable
 * variant draws a smaller disc inside that safe zone, and the plain one draws a
 * larger disc that fills the tile properly when nothing is cropped.
 *
 * The field is opaque on purpose. A transparent icon gets a white plate behind
 * it on most Android launchers and a black one on iOS, and the disc is a mid
 * blue that reads badly against both.
 */
function drawIcon(size, discRatio) {
  const rgba = Buffer.alloc(size * size * 4);
  const from = hslToRgb(FROM[0], FROM[1], FROM[2]);
  const to = hslToRgb(TO[0], TO[1], TO[2]);
  const c = (size - 1) / 2;
  const radius = size * discRatio;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - c;
      const dy = y - c;
      const dist = Math.sqrt(dx * dx + dy * dy);
      /*
       * A one-pixel linear ramp at the edge. Without it the disc is visibly
       * jagged at 192px, which is the size that actually appears on his home
       * screen — 512 is mostly what the installer stores.
       */
      const cover = Math.max(0, Math.min(1, radius + 0.5 - dist));

      // The gradient runs corner to corner, matching the CSS's 135deg.
      const t = Math.max(0, Math.min(1, (x + y) / (2 * (size - 1))));
      const at = (y * size + x) * 4;
      for (let ch = 0; ch < 3; ch++) {
        const disc = from[ch] + (to[ch] - from[ch]) * t;
        rgba[at + ch] = Math.round(BG[ch] + (disc - BG[ch]) * cover);
      }
      rgba[at + 3] = 255;
    }
  }
  return encodePng(size, size, rgba);
}

// ---------------------------------------------------------------- the set

/*
 * Drawn on first request, not at boot: the server restarts on every source
 * change here, and paying for four icons on each restart to serve something a
 * browser fetches once per install would be a silly trade.
 */
const SPECS = {
  'icon-192.png': { size: 192, disc: 0.34 },
  'icon-512.png': { size: 512, disc: 0.34 },
  // Radius 0.28 keeps the whole disc inside the 0.4w safe circle a launcher
  // mask is allowed to crop to, with room to spare for the aggressive ones.
  'icon-maskable-512.png': { size: 512, disc: 0.28 },
  // iOS ignores the manifest and takes this one, at its own fixed size.
  'apple-touch-icon.png': { size: 180, disc: 0.34 },
};

const cache = new Map();

/** The PNG bytes for one of the names in SPECS, or null if it is not one. */
function icon(name) {
  const spec = SPECS[name];
  if (!spec) return null;
  let buf = cache.get(name);
  if (!buf) {
    buf = drawIcon(spec.size, spec.disc);
    cache.set(name, buf);
  }
  return buf;
}

function names() {
  return Object.keys(SPECS);
}

module.exports = { icon, names, encodePng, crc32, hslToRgb };
