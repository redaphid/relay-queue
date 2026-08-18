'use strict';
/*
 * text-selftest — prove the queue cannot quietly corrupt what it is given.
 *
 *   node tools/text-selftest.js
 *
 * THE DEFECT THIS FIXES, and it was in his permanent archive.
 *
 * An agent posted two messages minutes apart from the same shell. The one
 * containing an em-dash is stored, for ever, with a replacement character; the
 * ASCII-only one is byte-perfect. 26 of the 3060 events in the live log are
 * damaged this way, by ten different authors — so it was the shared write path,
 * not one bad shell.
 *
 * The cause was one line: `Buffer.concat(chunks).toString('utf8')` SILENTLY
 * substitutes U+FFFD for anything it cannot decode. A shell that re-encoded an
 * em-dash into a lone CP1252 0x97 got a cheerful 201 and permanent damage. A
 * malformed write that SUCCEEDS is the worst of the three outcomes, because
 * nobody learns anything and the loss is unrecoverable.
 *
 * THE CONSTRAINT THAT DECIDES THE DESIGN, and the reason half the assertions
 * below are about writes that must still be ACCEPTED: his own typed and
 * dictated messages come through POST /tasks. Refusing an agent is good — it
 * retries. Refusing him drops what he said, which is far worse than the bug.
 * So the strict check lives where a browser physically cannot trip it, and the
 * shared route warns instead of refusing.
 *
 * Nothing here touches the real data directory. Zero dependencies.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer } = require('./harness-lib');

const PORT = Number(process.env.TEXT_TEST_PORT || 0);
const FFFD = '�';

let srv = null;
let failures = 0;

function check(name, cond, detail) {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
}

const get = async (p) => (await fetch(srv.base + p)).json();

/** Post raw bytes, exactly as a shell would. */
async function postBytes(p, buf) {
  const res = await fetch(srv.base + p, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: buf,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/*
 * Post the way HIS PAGE does — JSON.stringify, then let the platform encode it.
 * This is the path that must never be refused, so the test drives the same one
 * rather than a hand-rolled buffer that could accidentally be kinder.
 */
async function postAsPage(p, obj) {
  const res = await fetch(srv.base + p, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-text-'));

  /*
   * A record damaged by the OLD code, written straight into the log before boot.
   * The `damaged` flag is derived rather than stored precisely so that history
   * like this lights up without anything rewriting an append-only archive.
   */
  const legacyTs = new Date(Date.now() - 3600000).toISOString();
  fs.writeFileSync(path.join(dir, 'events.jsonl'), JSON.stringify({
    t: 'create',
    task: {
      id: 'legacy-damaged', role: 'user', conversationId: 'main',
      instruction: `hub exposure ${FFFD} ready for you`,
      from: 'communicator', ts: legacyTs, status: 'done',
      claimedBy: null, claimedAt: null,
      result: `done ${FFFD} all of it`, resultTs: legacyTs,
      relayed: true, relayedAt: legacyTs,
    },
  }) + '\n');

  srv = await startServer({ dir, port: PORT });
  console.log(`text-selftest — server on ${srv.base}, data in ${dir}\n`);

  try {
    console.log('the exact defect: a shell re-encoding an em-dash');
    /*
     * 0x97 is the CP1252 em-dash. On its own it is not valid UTF-8. This is the
     * byte the reported message actually arrived as.
     */
    const mangled = Buffer.concat([
      Buffer.from('{"text":"deploy is live '), Buffer.from([0x97]), Buffer.from(' try your mic"}'),
    ]);
    const before = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8');
    const bad = await postBytes('/tasks', mangled);
    check('*** a body with a mangled byte is REFUSED, not stored ***', bad.status === 400,
      `HTTP ${bad.status} — it used to answer 201 and keep the damage for ever`);
    check('...and nothing at all was written',
      fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8') === before);
    check('...the refusal says what actually happened',
      /not valid UTF-8/.test((bad.body || {}).error || ''), (bad.body || {}).error);
    check('*** ...and tells the caller how to send it properly ***',
      Array.isArray((bad.body || {}).fix) && bad.body.fix.some((f) => /--data-binary|UTF8\.GetBytes/.test(f)),
      JSON.stringify((bad.body || {}).fix));
    check('...and points at the character that broke',
      !!((bad.body || {}).near || {}).context && /<<HERE>>/.test(bad.body.near.context),
      JSON.stringify((bad.body || {}).near));
    check('...and admits what the old behaviour was, since that is why anyone is reading it',
      /accepted with a 201/.test((bad.body || {}).wasPreviously || ''));

    console.log('\ntext that is FINE must stay fine — this is not an ASCII queue');
    const good = [
      ['an em-dash, sent properly', 'deploy is live — try your mic'],
      ['accented letters', 'café, naïve, Reykjavík, Ævar'],
      ['CJK', '日本語のメッセージ'],
      ['emoji, which are four-byte sequences', 'shipped 🚀 and it works 🎉'],
      ['a right single quote, which is what most editors emit', 'it’s done'],
    ];
    for (const [label, text] of good) {
      const r = await postAsPage('/tasks', { text, from: 'web' });
      const stored = r.status === 201 ? (await get(`/tasks/${r.body.id}`)).instruction : null;
      check(`${label} round-trips byte for byte`, stored === text,
        `HTTP ${r.status} stored=${JSON.stringify(stored)}`);
    }

    console.log('\n*** his own messages can NEVER be refused ***');
    /*
     * The page posts through fetch with a JSON.stringify body, and that path
     * encodes JS strings to UTF-8 itself — it cannot emit a malformed sequence.
     * A LONE SURROGATE is the nastiest thing a browser can hand it, and it
     * comes out as a well-formed U+FFFD rather than as broken bytes.
     */
    const loneSurrogate = 'a broken paste \uD800 and more words';
    const his = await postAsPage('/tasks', { text: loneSurrogate, from: 'voice' });
    check('*** a dictated message containing a lone surrogate is still ACCEPTED ***',
      his.status === 201, `HTTP ${his.status} — refusing this would drop what he said`);
    /*
     * Better than expected, and worth pinning down because the design was
     * argued from it: `JSON.stringify` escapes a lone surrogate as \\uD800
     * rather than emitting broken bytes, so the body stays well-formed UTF-8
     * and the character survives the round trip intact. It is not damaged at
     * all, so it is correctly NOT flagged — the flag means "characters were
     * lost", and nothing was.
     */
    check('...and it survives intact rather than being replaced',
      (await get(`/tasks/${his.body.id}`)).instruction === loneSurrogate);
    check('...so it is not flagged, because nothing was actually lost',
      !(his.body || {}).warning, JSON.stringify((his.body || {}).warning || null).slice(0, 120));
    const warned = await postAsPage('/tasks', { text: `typed ${FFFD} here`, from: 'web' });
    check('...while text that IS already lost is stored AND announced',
      warned.status === 201 && !!(warned.body || {}).warning,
      `HTTP ${warned.status} ${JSON.stringify((warned.body || {}).warning || null).slice(0, 80)}`);
    for (const from of ['web', 'voice', 'voice-conversation', 'checklist', null]) {
      const r = await postAsPage('/tasks', { text: `hello ${FFFD} there`, from });
      check(`...from "${from}" too, damaged text and all`, r.status === 201, `HTTP ${r.status}`);
    }

    console.log('\nalready-lost text, on the routes the page never calls');
    const msg = await postAsPage('/messages', { text: `status ${FFFD} ready`, agent: 'rune' });
    check('*** POST /messages refuses text that is already damaged ***', msg.status === 400,
      `HTTP ${msg.status}`);
    check('...saying part of it is already lost',
      /already lost/.test((msg.body || {}).error || ''), (msg.body || {}).error);
    const clean = await postAsPage('/messages', { text: 'status — ready', agent: 'rune' });
    check('...while an undamaged message is untouched', clean.status === 201, `HTTP ${clean.status}`);

    const q = await postAsPage('/tasks', { text: 'what is the status' });
    const res1 = await postAsPage(`/tasks/${q.body.id}/result`, { result: `done ${FFFD} all of it` });
    check('*** POST /tasks/:id/result refuses it too ***', res1.status === 400, `HTTP ${res1.status}`);
    check('...and the task is still answerable afterwards',
      (await postAsPage(`/tasks/${q.body.id}/result`, { result: 'done — all of it' })).status === 200);

    console.log('\nseeing the damage that is already there');
    const thread = await get('/thread');
    const legacy = thread.entries.find((e) => e.id === 'legacy-damaged');
    check('*** a record damaged by the OLD code is flagged, with no migration ***',
      legacy && legacy.damaged === true, JSON.stringify(legacy && legacy.damaged));
    const legacyReply = thread.entries.find((e) => e.id === 'legacy-damaged:r');
    check('...and so is a damaged ANSWER, separately from the question',
      legacyReply && legacyReply.damaged === true);
    const okEntry = thread.entries.find((e) => e.text === 'deploy is live — try your mic');
    check('...while undamaged entries carry no flag at all, so nothing new is implied',
      okEntry && !('damaged' in okEntry), JSON.stringify(okEntry && okEntry.damaged));

    const dmg = await get('/damaged');
    check('the survey finds the damaged records', dmg.count >= 2, String(dmg.count));
    check('...and says how many it looked at', dmg.scanned >= dmg.count);
    check('...broken down by author, which is how the extent was measured by hand',
      Array.isArray(dmg.byAuthor) && dmg.byAuthor.some((a) => a.author === 'communicator'),
      JSON.stringify(dmg.byAuthor));
    check('*** ...and states plainly that it will not repair them ***',
      dmg.repairable === false && /invisible fabrication/.test(dmg.note || ''), dmg.note);
    check('...with a preview, so a message can be recognised',
      dmg.messages.every((m) => typeof m.preview === 'string'));
    const logNow = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8');
    check('*** the survey rewrote nothing ***', logNow.startsWith(before), 'an archive is not a draft');

    console.log('\nwhat must NOT have been caught by this net');
    /*
     * Image bytes are binary and are emphatically not valid UTF-8. Applying the
     * strict decode to raw bodies as well would have broken the gallery
     * completely — the check belongs to the JSON path only.
     */
    const icons = require('../icons.js');
    const rgba = Buffer.alloc(4 * 4 * 4, 0xcc);
    const pngBytes = icons.encodePng(4, 4, rgba);
    const up = await fetch(srv.base + '/images?alt=binary', {
      method: 'POST', headers: { 'content-type': 'image/png' }, body: pngBytes,
    });
    check('*** binary uploads still work — the check is on the JSON path only ***',
      up.status === 201, `HTTP ${up.status}`);
    check('an empty body is still a valid "no fields" request',
      (await postBytes('/conversations', Buffer.alloc(0))).status === 400); // 400 = missing title, not a decode error
    check('...and malformed JSON still says malformed JSON, not "not valid UTF-8"',
      /malformed JSON/.test(((await postBytes('/tasks', Buffer.from('{"text":'))).body || {}).error || ''));

    console.log('\nit survives the restart this server gives itself constantly');
    await srv.restart();
    check('the damaged history is still flagged after replay',
      ((await get('/thread')).entries.find((e) => e.id === 'legacy-damaged') || {}).damaged === true);
    check('...and the good text is still intact',
      (await get('/thread')).entries.some((e) => e.text === '日本語のメッセージ'));
    check('the server booted clean', /events replayed/.test(srv.out),
      srv.out.split('\n').find((l) => /replayed/.test(l)));
    check('...with nothing skipped', /0 skipped/.test(srv.out),
      srv.out.split('\n').find((l) => /replayed/.test(l)));
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
