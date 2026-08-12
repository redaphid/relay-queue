'use strict';
/*
 * gallery-selftest — boot a real server and prove that a picture reaches him.
 *
 *   node tools/gallery-selftest.js
 *
 * The failure this feature exists to fix: 198 sprites were generated in one
 * night and not one of them reached him, because every file sat in a temp
 * directory on a desktop he was thousands of miles from. So the assertions here
 * are about the whole path — bytes in, bytes out, byte-for-byte — and about the
 * two ways that path could be worse than useless:
 *
 *   1. IT MUST NOT BECOME A FILE-DISCLOSURE HOLE. This server has no
 *      authentication and answers anything that can reach the port. The tests
 *      below try to read server.js through it several ways. They must all fail,
 *      and they fail because a filename here can only ever be 64 hex digits the
 *      server computed itself — not because a filter caught them.
 *
 *   2. IT MUST NOT LIE ABOUT WHAT IT IS SERVING. The format is read from the
 *      bytes, never from the caller's content-type, so a caller cannot name the
 *      type a browser will apply to their upload.
 *
 * Everything else is durability: an image he was shown yesterday has to still
 * be there after the server restarts itself, which it does constantly.
 *
 * Nothing here touches the real data directory. Zero dependencies.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { startServer } = require('./harness-lib');
const icons = require('../icons.js');

const PORT = Number(process.env.GALLERY_TEST_PORT || 0);
// Small enough that one oversize post proves the cap without moving megabytes.
const MAX_IMAGE = 65536;

let srv = null;
let failures = 0;

function check(name, cond, detail) {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
}

const get = async (p) => (await fetch(srv.base + p)).json();

async function post(p, body) {
  const res = await fetch(srv.base + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body === undefined ? {} : body),
  });
  return { status: res.status, body: await res.json() };
}

/** Upload raw bytes, the way an agent actually does it. */
async function postImage(query, buf, contentType) {
  const res = await fetch(srv.base + '/images' + (query || ''), {
    method: 'POST',
    headers: { 'content-type': contentType || 'application/octet-stream' },
    body: buf,
  });
  return { status: res.status, body: await res.json() };
}

// ------------------------------------------------------------------ fixtures
/*
 * A real PNG, encoded by the app's own encoder — the one that already draws the
 * home-screen icons. Using it rather than a committed test asset keeps `public/`
 * and the repo free of binaries, which is the property the icons exist to hold.
 */
function pngFixture(w, h, seed) {
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    rgba[i * 4] = (i * 7 + seed) & 0xff;
    rgba[i * 4 + 1] = (i * 13 + seed) & 0xff;
    rgba[i * 4 + 2] = (i * 29 + seed) & 0xff;
    rgba[i * 4 + 3] = 0xff;
  }
  return icons.encodePng(w, h, rgba);
}

/** 'GIF89a', then the logical screen size as two little-endian shorts. */
function gifFixture(w, h) {
  const b = Buffer.alloc(13);
  b.write('GIF89a', 0, 'latin1');
  b.writeUInt16LE(w, 6);
  b.writeUInt16LE(h, 8);
  return b;
}

/*
 * SOI, a JFIF APP0 block, then SOF0 carrying the size. The APP0 is not padding:
 * it is there so the test proves the sniffer WALKS the marker segments instead
 * of reading a fixed offset, which is the only way a real photo's EXIF header
 * does not break it.
 */
function jpegFixture(w, h) {
  const head = Buffer.from([
    0xff, 0xd8,                                     // SOI
    0xff, 0xe0, 0x00, 0x10,                         // APP0, length 16
    0x4a, 0x46, 0x49, 0x46, 0x00,                   // "JFIF\0"
    0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  ]);
  const sof = Buffer.alloc(19);
  sof[0] = 0xff; sof[1] = 0xc0;
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(h, 5);
  sof.writeUInt16BE(w, 7);
  sof[9] = 3;
  return Buffer.concat([head, sof, Buffer.from([0xff, 0xd9])]);
}

/** A RIFF/WEBP container in its extended (VP8X) form, which stores size as LE24. */
function webpFixture(w, h) {
  const b = Buffer.alloc(30);
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(22, 4);
  b.write('WEBP', 8, 'latin1');
  b.write('VP8X', 12, 'latin1');
  b.writeUInt32LE(10, 16);
  b[24] = (w - 1) & 0xff; b[25] = ((w - 1) >> 8) & 0xff; b[26] = ((w - 1) >> 16) & 0xff;
  b[27] = (h - 1) & 0xff; b[28] = ((h - 1) >> 8) & 0xff; b[29] = ((h - 1) >> 16) & 0xff;
  return b;
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-gallery-'));
  srv = await startServer({ dir, port: PORT, env: { MAX_IMAGE: String(MAX_IMAGE) } });
  console.log(`gallery-selftest — server on ${srv.base}, data in ${dir}\n`);

  try {
    console.log('the round trip — bytes in, the same bytes out');
    const png = pngFixture(7, 3, 1);
    const up = await postImage('?conversationId=main&alt=seven%20by%20three&agent=rune', png, 'image/png');
    check('a PNG is accepted', up.status === 201, `HTTP ${up.status} ${JSON.stringify(up.body).slice(0, 200)}`);
    const im = up.body.image || {};
    check('...and named by the sha256 of its own bytes', im.blob === sha256(png), im.blob);
    check('...with the format read off the bytes', im.type === 'image/png', im.type);
    check('...and the size read out of the header', im.width === 7 && im.height === 3,
      `${im.width}x${im.height}`);
    check('...its byte count reported', im.bytes === png.length, `${im.bytes} vs ${png.length}`);
    check('...the alt text kept', im.alt === 'seven by three', im.alt);
    check('...who posted it kept', im.agent === 'rune', im.agent);
    check('...and a ready-made markdown line handed back',
      typeof up.body.markdown === 'string' && up.body.markdown.indexOf(im.blob) > 0, up.body.markdown);

    const raw = await fetch(srv.base + im.url);
    const got = Buffer.from(await raw.arrayBuffer());
    check('*** the image comes back byte for byte identical ***', got.equals(png),
      `${got.length} bytes vs ${png.length}`);
    check('...served as the type that was sniffed',
      (raw.headers.get('content-type') || '').indexOf('image/png') === 0,
      raw.headers.get('content-type'));
    check('...with nosniff, so the browser cannot second-guess that',
      raw.headers.get('x-content-type-options') === 'nosniff');
    check('...cached immutably, because the name IS the content hash',
      /immutable/.test(raw.headers.get('cache-control') || ''), raw.headers.get('cache-control'));

    console.log('\nevery format, and the dimensions that let the page reserve the box');
    const gif = await postImage('?alt=gif', gifFixture(64, 48));
    check('a GIF is recognised', gif.body.image && gif.body.image.type === 'image/gif');
    check('...at the right size', gif.body.image.width === 64 && gif.body.image.height === 48,
      `${gif.body.image.width}x${gif.body.image.height}`);
    const jpg = await postImage('?alt=jpeg', jpegFixture(300, 200));
    check('a JPEG is recognised', jpg.body.image && jpg.body.image.type === 'image/jpeg');
    check('...at the right size, past its APP0 header', jpg.body.image.width === 300 && jpg.body.image.height === 200,
      `${jpg.body.image.width}x${jpg.body.image.height}`);
    const webp = await postImage('?alt=webp', webpFixture(1024, 768));
    check('a WebP is recognised', webp.body.image && webp.body.image.type === 'image/webp');
    check('...at the right size', webp.body.image.width === 1024 && webp.body.image.height === 768,
      `${webp.body.image.width}x${webp.body.image.height}`);

    console.log('\nthe security properties — this server has no authentication');
    /*
     * The whole point of content-addressing. A filename here is 64 hex digits
     * the server computed; there is no code path that joins a caller's string
     * to a directory, so these are not blocked by a filter that could be
     * outwitted — the shape they would need is not expressible.
     */
    const traversals = [
      '/images/..%2F..%2Fserver.js',
      '/images/' + encodeURIComponent('../server.js'),
      '/images/server.js',
      '/images/' + encodeURIComponent('..\\server.js'),
      '/images/' + sha256(png).toUpperCase(), // the regex is lower-case hex only
      '/images/' + sha256(png).slice(0, 63),
      '/images/' + sha256(png) + 'a',
    ];
    let leaked = null;
    for (const p of traversals) {
      const r = await fetch(srv.base + p);
      const text = await r.text();
      if (r.status === 200 || /require\(|use strict/.test(text)) leaked = `${p} -> HTTP ${r.status}`;
    }
    check('*** no path, encoded or otherwise, reads a file off the disk ***', leaked === null, leaked);

    const html = Buffer.from('<html><script>alert(1)</script></html>', 'utf8');
    const lying = await postImage('?alt=nope', html, 'image/png');
    check('*** bytes that are not an image are refused even when labelled image/png ***',
      lying.status === 415, `HTTP ${lying.status}`);
    check('...and the refusal says the header was ignored',
      /content-type header is ignored/.test(JSON.stringify(lying.body)));

    const mislabelled = await postImage('?alt=truth', pngFixture(4, 4, 9), 'text/html');
    check('...while a real PNG labelled text/html is still served as a PNG',
      mislabelled.status === 201 && mislabelled.body.image.type === 'image/png',
      `${mislabelled.status} ${mislabelled.body.image && mislabelled.body.image.type}`);

    const big = await postImage('?alt=huge', Buffer.alloc(MAX_IMAGE + 1024, 0x89));
    check('an upload over the cap is refused', big.status === 413, `HTTP ${big.status}`);

    const empty = await postImage('?alt=nothing', Buffer.alloc(0));
    check('an empty body is refused with an explanation', empty.status === 400, `HTTP ${empty.status}`);

    const noConv = await postImage('?conversationId=does-not-exist', pngFixture(2, 2, 3));
    check('posting into a conversation that does not exist is refused', noConv.status === 400,
      `HTTP ${noConv.status}`);

    console.log('\ndeduplication — the same bytes are one file and two postings');
    const again = await postImage('?conversationId=main&alt=the%20same%20picture', png);
    check('the same bytes hash to the same id', again.body.image.blob === im.blob);
    check('...but it is a separate posting', again.body.image.id !== im.id);
    const onDisk = fs.readdirSync(path.join(dir, 'images')).filter((f) => !f.endsWith('.part'));
    check('...and only one copy is on disk', onDisk.filter((f) => f === im.blob).length === 1,
      onDisk.join(','));

    console.log('\nattaching pictures to what he actually reads');
    const msg = await post('/messages', {
      text: 'here are the crates',
      agent: 'rune',
      images: [im.blob, '/images/' + gif.body.image.blob], // a bare id and a pasted url
    });
    check('a message can carry images', msg.status === 201, `HTTP ${msg.status}`);
    check('...and a pasted /images/ url is accepted as an id',
      Array.isArray(msg.body.images) && msg.body.images.length === 2, JSON.stringify(msg.body.images));

    const bad = await post('/messages', { text: 'broken', images: ['not-an-id'] });
    check('an id that is not an id is refused', bad.status === 400, `HTTP ${bad.status}`);
    const missing = await post('/messages', { text: 'broken', images: [sha256(Buffer.from('never uploaded'))] });
    check('*** an id naming an image nobody uploaded is refused, not rendered broken ***',
      missing.status === 400, `HTTP ${missing.status}`);

    const task = await post('/tasks', { text: 'draw me a crate' });
    const answered = await post(`/tasks/${task.body.id}/result`, {
      result: 'here it is',
      images: [mislabelled.body.image.blob],
    });
    check('a result can carry images', answered.status === 200, `HTTP ${answered.status}`);

    const thread = await get('/thread');
    const byId = (id) => thread.entries.find((e) => e.id === id);
    check('the message entry carries its images',
      (byId(msg.body.id) || {}).images && byId(msg.body.id).images.length === 2);
    check('the ANSWER carries its own images, separately from the question',
      (byId(task.body.id + ':r') || {}).images &&
      byId(task.body.id + ':r').images[0] === mislabelled.body.image.blob);
    check('...and the question itself has none, so the two sets never merged',
      (byId(task.body.id) || {}).images === undefined);

    /*
     * The additive guarantee, asserted rather than asserted-in-a-commit-message.
     * A message with no pictures must project to exactly the shape every client
     * written before this feature — and the service worker's saved copy — was
     * built against. An extra key here is a silently changed contract.
     */
    const plain = await post('/messages', { text: 'no pictures here', agent: 'rune' });
    const plainEntry = (await get('/thread')).entries.find((e) => e.id === plain.body.id);
    check('*** a message without images has no images key at all ***',
      plainEntry && !('images' in plainEntry), JSON.stringify(plainEntry));

    console.log('\nthe gallery listing');
    const other = await post('/conversations', { title: 'Elsewhere' });
    await postImage(`?conversationId=${other.body.id}&alt=far%20away`, pngFixture(5, 5, 4));
    const all = await get('/images');
    const mainOnly = await get('/images?conversationId=main');
    const elsewhere = await get('/images?conversationId=' + other.body.id);
    check('every posting is listed', all.total >= 7, String(all.total));
    check('...filtered to one conversation', mainOnly.images.every((x) => x.conversationId === 'main'));
    check('...and the other conversation has its own', elsewhere.total === 1, String(elsewhere.total));
    check('...newest first', all.images.length < 2 ||
      Date.parse(all.images[0].ts) >= Date.parse(all.images[1].ts));
    check('...each with a url that works',
      all.images.every((x) => x.url === '/images/' + x.blob));
    check('*** a picture posted to two conversations appears in both ***',
      mainOnly.images.filter((x) => x.blob === im.blob).length === 2,
      JSON.stringify(mainOnly.images.map((x) => x.blob.slice(0, 8))));

    console.log('\nit survives the restart it will certainly get');
    const logBefore = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8');
    await srv.restart({ MAX_IMAGE: String(MAX_IMAGE) });
    const after = await fetch(srv.base + im.url);
    const afterBytes = Buffer.from(await after.arrayBuffer());
    check('*** the image is still served after a restart ***', afterBytes.equals(png),
      `HTTP ${after.status}, ${afterBytes.length} bytes`);
    check('...the listing came back too', (await get('/images')).total === all.total);
    check('...and the thread still has its attachments',
      ((await get('/thread')).entries.find((e) => e.id === msg.body.id) || {}).images.length === 2);
    check('nothing was rewritten in the log, only appended',
      fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').startsWith(logBefore));
    check('the server booted clean on replay', /events replayed/.test(srv.out),
      srv.out.split('\n').find((l) => /replayed/.test(l)));
    check('...with nothing skipped', /0 skipped/.test(srv.out),
      srv.out.split('\n').find((l) => /replayed/.test(l)));

    /*
     * The log remembers an image whose bytes are gone — a DATA_DIR restored
     * without its images directory. It must say so, in a way a page can tell
     * from a bug in itself. A 404 would be indistinguishable from a typo and a
     * 200 with nothing in it would be a lie.
     */
    console.log('\nwhen the bytes go missing under it');
    fs.unlinkSync(path.join(dir, 'images', im.blob));
    const gone = await fetch(srv.base + im.url);
    check('a record with no bytes answers 410, not 404 and not silence', gone.status === 410,
      `HTTP ${gone.status}`);
    check('...and says exactly what happened', /no longer on disk/.test(JSON.stringify(await gone.json())));
  } finally {
    await srv.stop();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* windows may hold it */ }
  }

  console.log(failures ? `\n${failures} check(s) FAILED\n` : '\nall checks passed\n');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error('\nthe test itself broke:', err && err.stack ? err.stack : err);
  process.exit(1);
});
