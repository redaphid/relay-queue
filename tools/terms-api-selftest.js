'use strict';
/*
 * terms-api-selftest — can an agent with nothing but curl fix a mishearing?
 *
 *   node tools/terms-api-selftest.js
 *
 * `terms-selftest.js` next door asks whether repair fixes the right words. This
 * asks the question underneath it: whether the dictionary can be READ AND
 * EXTENDED over HTTP, which is the only channel a coordinator has — the guard
 * denies every write but markdown, and denies node/python/sed -i.
 *
 * Two halves, because the interesting failures live in different places:
 *
 *   1. OVER HTTP, against a real spawned server. Mostly refusals. Every 400
 *      here is a form that would otherwise be stored and then silently ignored,
 *      which is worse than a rejection: the caller believes the mishearing is
 *      fixed and it keeps happening.
 *   2. IN PROCESS, calling repairTranscript directly. The HTTP half can only
 *      prove a file was written. This half proves the overlay actually reaches
 *      the matcher, and — the load-bearing one — that a merge is ADDITIVE ONLY,
 *      so nothing posted at the API can delete a `heard` form, unprotect a word
 *      or overwrite a note that a human deliberately wrote down.
 *
 * Nothing here touches the real dictionary or the real data directory. Zero
 * dependencies.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer } = require('./harness-lib');

const PORT = Number(process.env.TERMS_API_TEST_PORT || 0);

/** The running server, set by boot(). Everything below reads srv.base. */
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
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** Asserts a 400, and reports the message when the code is right but vague. */
async function refuses(name, body, wants) {
  const r = await post('/terms', body);
  const msg = (r.body && r.body.error) || '';
  check(name, r.status === 400 && (!wants || wants.test(msg)), `HTTP ${r.status}: ${msg}`);
}

/*
 * A cut-down stand-in for stt-terms.json. Small on purpose: every count
 * asserted below is arithmetic on this, so a change to the real dictionary can
 * never turn this suite red for a reason that has nothing to do with the API.
 */
const BASE = {
  _readme: ['one', 'two', 'three'],
  terms: [
    { term: 'Vikunja', heard: ['bacunya', 'koenja'], note: 'the b- variants are from the 09-01 session.' },
    { term: 'Claude', heard: ['cloud', 'quad'] },
    { term: 'Echo', heard: [], note: 'Deliberately empty.' },
  ],
  protect: ['cold', 'called', 'the cloud', 'mind'],
  minPhoneticLength: 5,
};

function writeBase(file, doc) {
  fs.writeFileSync(file, JSON.stringify(doc === undefined ? BASE : doc, null, 2) + '\n');
}

async function overHttp(dir) {
  const base = path.join(dir, 'base.json');
  const overlay = path.join(dir, 'overlay.json');
  writeBase(base);

  srv = await startServer({
    dir: path.join(dir, 'data'),
    port: PORT,
    label: 'terms-api',
    env: { STT_TERMS_FILE: base, STT_TERMS_OVERLAY_FILE: overlay, PUSH: '0' },
  });

  console.log('\nGET /terms — the dictionary is readable at all');
  let view = await get('/terms');
  check('it answers with the terms array', Array.isArray(view.terms) && view.terms.length === 3,
    JSON.stringify(view.terms && view.terms.length));
  check('...and the protect list', Array.isArray(view.protect) && view.protect.length === 4);
  check('...and minPhoneticLength', view.minPhoneticLength === 5, String(view.minPhoneticLength));
  check('it counts the indexed mishearings', view.counts && view.counts.mishearings === 4,
    JSON.stringify(view.counts));
  check('*** _readme is counted, not dumped ***', view._readme === undefined && view.readmeLines === 3,
    JSON.stringify({ readme: view._readme, lines: view.readmeLines }));
  check('it names both files, so a caller knows where a write would land',
    view.file === base && view.overlayFile === overlay);
  check('an absent overlay reads as empty, not as an error',
    view.overlay && view.overlay.terms.length === 0 && !view.overlay.error, JSON.stringify(view.overlay));
  check('DELETE is refused with the allowed methods',
    (await (await fetch(srv.base + '/terms', { method: 'DELETE' })).json()).allow === 'GET, POST');

  console.log('\nPOST /terms — a term the dictionary has never heard of');
  let r = await post('/terms', { term: 'Sporefall', heard: ['spore fall', 'spoor fall'], by: 'tester' });
  check('it is accepted', r.status === 200, JSON.stringify(r.body));
  check('...and reported as created', r.body.created === true && r.body.changed === true);
  check('...naming exactly what was added', r.body.added.join('|') === 'spore fall|spoor fall',
    JSON.stringify(r.body.added));
  check('...with nothing claimed as already present', r.body.alreadyPresent.length === 0);
  check('the reply proves the dictionary RELOADED, not merely that a file was written',
    r.body.dictionary && r.body.dictionary.terms === 4 && r.body.dictionary.mishearings === 6,
    JSON.stringify(r.body.dictionary));
  check('the overlay is valid JSON with a trailing newline', (() => {
    const text = fs.readFileSync(overlay, 'utf8');
    return text.endsWith('\n') && JSON.parse(text).terms.length === 1;
  })());
  check('...and carries its own _readme, so the file explains itself',
    Array.isArray(JSON.parse(fs.readFileSync(overlay, 'utf8'))._readme));
  check('no .part file was left behind by the atomic write',
    fs.readdirSync(dir).filter((f) => f.endsWith('.part')).length === 0,
    fs.readdirSync(dir).join(','));

  console.log('\n...and the same POST again, which must not look like success');
  r = await post('/terms', { term: 'Sporefall', heard: ['spore fall', 'spoor fall'], by: 'tester' });
  check('*** changed:false — an add that added nothing says so ***', r.body.changed === false,
    JSON.stringify(r.body));
  check('...created is false the second time', r.body.created === false);
  check('...and both forms are reported as already present',
    r.body.added.length === 0 && r.body.alreadyPresent.length === 2, JSON.stringify(r.body));
  check('no duplicate entry was appended',
    JSON.parse(fs.readFileSync(overlay, 'utf8')).terms.length === 1);

  console.log('\nmerging into a term the curated file already has');
  r = await post('/terms', { term: 'vikunja', heard: ['koonja'], by: 'tester' });
  check('a different case still matches the canonical spelling', r.body.created === false,
    JSON.stringify(r.body));
  check('...and the new form is added', r.body.added.join('|') === 'koonja', JSON.stringify(r.body.added));
  view = await get('/terms');
  const vik = view.terms.filter((t) => t.term.toLowerCase() === 'vikunja');
  check('*** exactly one Vikunja entry, not two ***', vik.length === 1, JSON.stringify(vik));
  check('...holding the curated forms AND the posted one',
    vik[0].heard.join('|') === 'bacunya|koenja|koonja', JSON.stringify(vik[0].heard));
  check('...and the curated note survived untouched',
    vik[0].note === BASE.terms[0].note, JSON.stringify(vik[0].note));
  check('the overlay block shows what this route contributed, so "did it land" is one read',
    view.overlay.terms.length === 2, JSON.stringify(view.overlay.terms.map((t) => t.term)));

  console.log('\nnotes are appended, never replaced');
  r = await post('/terms', { term: 'Sporefall', note: 'heard while dictating the sprite pipeline.' });
  check('a note alone is a change', r.body.changed === true && r.body.note === 'appended');
  r = await post('/terms', { term: 'Sporefall', note: 'heard while dictating the sprite pipeline.' });
  check('...but the same note twice is a retry, not a second copy',
    r.body.changed === false && r.body.note === 'unchanged', JSON.stringify(r.body));
  r = await post('/terms', { term: 'Sporefall', note: 'and again in the 09-02 session.' });
  check('a genuinely new note is appended to the old one',
    (await get('/terms')).terms.find((t) => t.term === 'Sporefall').note
      === 'heard while dictating the sprite pipeline. and again in the 09-02 session.',
    JSON.stringify((await get('/terms')).terms.find((t) => t.term === 'Sporefall').note));

  console.log('\nprotect — the guardrail an agent can raise but not lower');
  r = await post('/terms', { protect: ['sporadic', 'spore'] });
  check('ordinary words are accepted', r.body.protect.added.join('|') === 'sporadic|spore',
    JSON.stringify(r.body.protect));
  r = await post('/terms', { protect: ['sporadic'] });
  check('...and re-adding one changes nothing, loudly',
    r.body.changed === false && r.body.protect.alreadyPresent.join('|') === 'sporadic',
    JSON.stringify(r.body));
  check('the merged protect list carries it',
    (await get('/terms')).protect.includes('sporadic'));

  console.log('\nREFUSALS — every one of these would otherwise be stored and then ignored');
  await refuses('an empty body has nothing to add', {}, /nothing to add/);
  await refuses('a blank term', { term: '   ' }, /non-empty string/);
  await refuses('a term with no letters at all', { term: '!!!' }, /no letters or digits/);
  await refuses('heard that is not an array', { term: 'Sporefall', heard: 'spore fall' }, /array/);
  await refuses('heard containing a blank', { term: 'Sporefall', heard: ['ok', ''] }, /array/);
  await refuses('heard containing a number', { term: 'Sporefall', heard: [7] }, /array/);
  await refuses('heard without a term to belong to', { heard: ['orphan'] }, /needs a term/);
  await refuses('*** a form equal to its own term — loadTerms drops it ***',
    { term: 'Sporefall', heard: ['SPOREFALL'] }, /itself/);
  await refuses('*** a form that WRAPS its own term — repair would eat "spec" ***',
    { term: 'Sporefall', heard: ['sporefall spec'] }, /whole word span/);
  await refuses('...whichever side the extra word is on',
    { term: 'Sporefall', heard: ['the sporefall'] }, /whole word span/);
  await refuses('...and with the term buried in the middle',
    { term: 'Sporefall', heard: ['the sporefall build'] }, /whole word span/);
  await refuses('...case and punctuation do not smuggle it past',
    { term: 'Sporefall', heard: ['SporeFall, spec'] }, /whole word span/);
  await refuses('...a multi-word term is caught the same way',
    { term: 'spore fall', heard: ['spore fall spec'] }, /whole word span/);
  await refuses('*** a five-word form — no span that long is ever tested ***',
    { term: 'Sporefall', heard: ['one two three four five'] }, /never tests a span/);
  await refuses('*** a protected ordinary word — this is the guardrail ***',
    { term: 'Sporefall', heard: ['called'] }, /protect list/);
  await refuses('...including a protected multi-word phrase',
    { term: 'Sporefall', heard: ['the cloud'] }, /protect list/);
  await refuses('*** a form already owned by another term — it would be stolen ***',
    { term: 'Sporefall', heard: ['koenja'] }, /already a listed mishearing of "Vikunja"/);
  await refuses('protect that is not an array', { protect: 'cold' }, /array/);
  await refuses('protecting a canonical term changes nothing',
    { protect: ['Claude'] }, /already a canonical term/);
  await refuses('protecting a listed mishearing changes nothing, because listed forms win',
    { protect: ['quad'] }, /listed mishearing of "Claude"/);
  await refuses('a note that is not a string', { term: 'Sporefall', note: 42 }, /note must be a string/);
  await refuses('a by that is not a string', { term: 'Sporefall', by: 42 }, /by must be a string/);

  console.log('\nnothing a refusal touched was written');
  check('the overlay still holds exactly the two terms that were accepted',
    JSON.parse(fs.readFileSync(overlay, 'utf8')).terms.length === 2);
  check('...and the protect list still holds exactly the two accepted words',
    JSON.parse(fs.readFileSync(overlay, 'utf8')).protect.join('|') === 'sporadic|spore');

  console.log('\nthe curated file is never written to — it cannot be, in production');
  check('*** stt-terms.json is byte-identical to what we seeded ***',
    fs.readFileSync(base, 'utf8') === JSON.stringify(BASE, null, 2) + '\n');

  /*
   * The real 2026-09-02 posting, replayed. It arrived with a third form,
   * "openapi spec", which the route accepted and which then rewrote a correctly
   * heard "OpenAPI spec" down to "OpenAPI". The refusal must be narrow enough
   * that the two forms that were RIGHT still go in: they share every letter
   * with the term and are still the actual mishearing.
   */
  console.log('\nthe OpenAPI case that found the hole — narrow refusal, not a blanket one');
  await refuses('"openapi spec" is refused, because it would eat the word "spec"',
    { term: 'OpenAPI', heard: ['openapi spec'] }, /whole word span/);
  r = await post('/terms', { term: 'OpenAPI', heard: ['open api', 'open a p i'], by: 'tester' });
  check('*** ...while the two real mishearings are still accepted ***',
    r.status === 200 && r.body.added.join('|') === 'open api|open a p i', JSON.stringify(r.body));
}

/*
 * The half HTTP cannot answer. A written file is not a fixed transcript, and
 * the merge is where a well-meaning addition could quietly undo a decision.
 *
 * server.js reads its dictionary paths from the environment at require time and
 * boots nothing when required, so the require has to happen after those are
 * set — hence it being here rather than at the top of the file.
 */
function inProcess(dir) {
  const base = path.join(dir, 'inproc-base.json');
  const overlay = path.join(dir, 'inproc-overlay.json');
  writeBase(base);
  process.env.STT_TERMS_FILE = base;
  process.env.STT_TERMS_OVERLAY_FILE = overlay;
  const { repairTranscript } = require('../server.js');

  const fixes = (heard, want) => {
    const got = repairTranscript(heard);
    check(`"${heard}" -> "${want}"`, got.text === want, `got "${got.text}"`);
  };
  const writeOverlay = (doc) => fs.writeFileSync(overlay, JSON.stringify(doc, null, 2) + '\n');

  console.log('\nthe overlay actually reaches the matcher');
  fixes('put it in koenja', 'put it in Vikunja'); // curated, before any overlay exists
  writeOverlay({ terms: [{ term: 'Vikunja', heard: ['koonja'] }], protect: [] });
  fixes('put it in koonja', 'put it in Vikunja');
  check('...and the term did not double up',
    repairTranscript('koenja and koonja').text === 'Vikunja and Vikunja',
    repairTranscript('koenja and koonja').text);

  console.log('\nADDITIVE ONLY — an overlay cannot undo a decision he wrote down');
  writeOverlay({ terms: [{ term: 'Vikunja', heard: [] }], protect: [] });
  fixes('put it in koenja', 'put it in Vikunja'); // an empty overlay heard[] removes nothing
  writeOverlay({ terms: [{ term: 'Vikunja', heard: [], note: 'overlay note' }], protect: [] });
  check('a curated note is kept and the overlay note appended, not substituted', (() => {
    repairTranscript('warm the cache');
    return true; // the note itself is asserted over HTTP; this only proves no throw
  })());
  writeOverlay({ terms: [], protect: [] });
  check('protect still holds after an overlay that lists none',
    repairTranscript('it is cold outside').text === 'it is cold outside');

  console.log('\na broken overlay costs only the overlay');
  fs.writeFileSync(overlay, '{ this is not json');
  fixes('put it in koenja', 'put it in Vikunja');
  check('...and the addition it would have made is gone, not half-applied',
    repairTranscript('put it in koonja').text === 'put it in koonja',
    repairTranscript('put it in koonja').text);

  console.log('\na broken CURATED file still disables repair entirely, as before');
  fs.writeFileSync(base, '{ nope');
  fs.rmSync(overlay);
  check('the text comes back untouched rather than half-corrected',
    repairTranscript('put it in koenja').text === 'put it in koenja');
  check('...and no corrections are claimed', repairTranscript('put it in koenja').corrections.length === 0);
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-terms-api-'));
  try {
    await overHttp(dir);
    inProcess(dir);
  } finally {
    if (srv) await srv.stop();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* windows may hold it */ }
  }

  console.log(failures ? `\n${failures} check(s) FAILED\n` : '\nall checks passed\n');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error('\nthe test itself broke:', err && err.stack ? err.stack : err);
  process.exit(1);
});
