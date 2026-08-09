'use strict';
/*
 * checklist-selftest — boot a real server and prove that a ticked box is real.
 *
 *   node tools/checklist-selftest.js
 *
 * The user's request was "I want to see checklists and itineraries and to check
 * them off and have Claude notice." Everything after the comma is server work,
 * and it has three properties that a browser test cannot check:
 *
 *   1. IT SURVIVES. The tick is an event in the append-only log, so it comes
 *      back after a restart. A checkbox that forgets is worse than a static one,
 *      because he will trust it once and then be wrong about what he packed.
 *   2. AN AGENT CAN READ IT. `GET /tasks/:entryId/checks` and `GET /checklists`
 *      answer "what is on his list and what is left" in one call, with no
 *      thread parsing and no guessing.
 *   3. AN AGENT IS WOKEN — BUT HIS THREAD IS NOT SPAMMED. A burst of taps
 *      settles into exactly one pending message, because a coordinator only
 *      wakes on pending work in its conversation, and because one message per
 *      tap is the thing we were explicitly told not to build.
 *
 * The indexing tests are the load-bearing ones. The index is the only link
 * between a checkbox and its record, and the page and the server each parse the
 * message text separately to work it out — so if they ever disagree about what
 * counts as a task line, every box after the disagreement writes to the wrong
 * item, silently. `ui-selftest.js` asserts the page's half against the same
 * cases.
 *
 * Nothing here touches the real data directory. Zero dependencies.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer } = require('./harness-lib');

/*
 * The port is whatever the OS hands out, and the server under test proves it is
 * the one that answered before a single assertion runs — see
 * tools/harness-lib.js. CHECKLIST_TEST_PORT still pins it for a deliberate run.
 */
const PORT = Number(process.env.CHECKLIST_TEST_PORT || 0);
const SETTLE_MS = 400; // the debounce window, shortened so the test is quick

/** The running server, set by boot(). Everything below reads srv.base. */
let srv = null;

let failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (p) => (await fetch(srv.base + p)).json();
async function post(p, body) {
  const res = await fetch(srv.base + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body === undefined ? {} : body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** Boot the server under test and adopt it as the one `get`/`post` talk to. */
async function boot(dir) {
  srv = await startServer({
    dir,
    port: PORT,
    label: 'checklist',
    env: { CHECK_SETTLE_MS: String(SETTLE_MS), PUSH: '0' },
  });
  return srv;
}

/** Post a question and answer it, so the checklist lives on the reply entry. */
async function listMessage(text, conversationId) {
  const made = await post('/tasks', { text: 'what is on the list?', conversationId });
  const id = made.body.id;
  await post(`/tasks/${id}/claim`, { agent: 'tester' });
  await post(`/tasks/${id}/result`, { result: text });
  return `${id}:r`;
}

const PACKING = [
  '# Packing',
  '',
  '- [ ] passport',
  '- [x] socks',
  '  - [ ] the good ones',
  '- [ ] adapters',
  '',
  '```',
  '- [ ] this is sample text, not a task',
  '```',
  '',
  '~~~',
  '- [ ] nor is this',
  '~~~',
  '',
  '- [ ] tickets',
].join('\n');

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-checklist-'));
  await boot(dir);

  try {
    // ------------------------------------------------------------- parsing
    console.log('\nparsing — what counts as an item, and in what order');
    const entryId = await listMessage(PACKING);
    let cl = await get(`/tasks/${entryId}/checks`);
    check('a task list is found on an agent\'s reply', cl && cl.total === 5,
      JSON.stringify(cl && cl.total));
    check('*** a checkbox inside a ``` fence is not an item ***',
      !JSON.stringify(cl.items).includes('sample text'));
    check('*** nor is one inside a ~~~ fence ***',
      !JSON.stringify(cl.items).includes('nor is this'));
    check('items come back in document order',
      cl.items.map((i) => i.label).join('|') === 'passport|socks|the good ones|adapters|tickets',
      cl.items.map((i) => i.label).join('|'));
    check('an [x] in the text reads as checked', cl.items[1].checked === true);
    check('...and is attributed to the text, not to a person', cl.items[1].source === 'text');
    check('an indented item records its depth, so nesting is legible to an agent',
      cl.items[2].depth === 1, String(cl.items[2].depth));
    check('the summary counts agree', cl.done === 1 && cl.remaining === 4,
      `${cl.done}/${cl.total}`);
    check('a message with no task list has no checklist at all',
      (await (await fetch(`${srv.base}/tasks/${entryId.replace(':r', '')}/checks`)).status) === 404);

    // ------------------------------------------------------------- writing
    console.log('\nwriting — a tick is an event, with a name on it');
    let r = await post(`/tasks/${entryId}/checks`, { index: 0, on: true, by: 'web/abc12345' });
    check('a tick is accepted', r.status === 200 && r.body.changed === true, JSON.stringify(r.body));
    check('...and the response carries the whole list back, so no second call is needed',
      r.body.checklist && r.body.checklist.total === 5);
    check('...with the item now checked', r.body.checklist.items[0].checked === true);
    check('*** who ticked it is recorded ***', r.body.checklist.items[0].by === 'web/abc12345',
      JSON.stringify(r.body.checklist.items[0].by));
    check('*** and when ***', !!Date.parse(r.body.checklist.items[0].at || ''),
      JSON.stringify(r.body.checklist.items[0].at));
    check('...and it is marked as a real tick rather than text',
      r.body.checklist.items[0].source === 'checked');

    r = await post(`/tasks/${entryId}/checks`, { index: 0, on: true, by: 'web/abc12345' });
    check('*** the same tick twice is idempotent, not two events ***', r.body.changed === false,
      JSON.stringify(r.body.changed));
    check('...and still answers with the truth', r.body.checklist.items[0].checked === true);

    r = await post(`/tasks/${entryId}/checks`, { index: 1, on: false, by: 'web/abc12345' });
    check('*** un-ticking beats an [x] written in the message ***',
      r.body.checklist.items[1].checked === false);

    // Nothing about the message itself is rewritten: the log is append-only.
    const taskAfter = await get(`/tasks/${entryId.replace(':r', '')}`);
    check('*** the message text is never edited to record a tick ***',
      taskAfter.result === PACKING, 'the result was rewritten');

    console.log('\nwriting — the ways it can be asked wrongly');
    check('an index past the end is refused',
      (await post(`/tasks/${entryId}/checks`, { index: 99, on: true })).status === 400);
    check('a negative index is refused',
      (await post(`/tasks/${entryId}/checks`, { index: -1, on: true })).status === 400);
    check('a non-integer index is refused',
      (await post(`/tasks/${entryId}/checks`, { index: 1.5, on: true })).status === 400);
    check('a missing `on` is refused rather than guessed',
      (await post(`/tasks/${entryId}/checks`, { index: 0 })).status === 400);
    check('a string `on` is refused rather than coerced',
      (await post(`/tasks/${entryId}/checks`, { index: 0, on: 'true' })).status === 400);
    check('an entry that does not exist is a 404',
      (await post('/tasks/nope-nope/checks', { index: 0, on: true })).status === 404);
    check('a message with no checklist is a 404, not an empty success',
      (await post(`/tasks/${entryId.replace(':r', '')}/checks`, { index: 0, on: true })).status === 404);

    // ------------------------------------------------------- the thread view
    console.log('\nthe thread carries the state, so a second device agrees');
    const thread = await get('/thread');
    const replyEntry = thread.entries.find((e) => e.id === entryId);
    check('the entry carries its checklist', !!(replyEntry && replyEntry.checklist));
    check('...with the tick in it', replyEntry.checklist.items[0].checked === true);
    check('*** and `rev` moved, or an incremental poll would never see the tick ***',
      Date.parse(replyEntry.rev) > Date.parse(replyEntry.ts),
      `rev ${replyEntry.rev} vs ts ${replyEntry.ts}`);
    const sincePoll = await get(`/thread?since=${Date.parse(replyEntry.ts)}`);
    check('...so a client polling since the message was written is told about it',
      sincePoll.entries.some((e) => e.id === entryId),
      JSON.stringify(sincePoll.entries.map((e) => e.id)));

    // ------------------------------------------------------ the query surface
    console.log('\nquerying — an agent can ask what is left without reading the thread');
    const all = await get('/checklists');
    check('every checklist is listable', all.count === 1 && all.checklists[0].entryId === entryId,
      JSON.stringify(all.count));
    check('...with its conversation named', all.checklists[0].conversationId === 'main');
    const open = await get('/checklists?open=1');
    check('open=1 keeps a list with items left', open.count === 1, JSON.stringify(open.count));

    // Tick everything, and it should drop out of the open view.
    for (let i = 0; i < 5; i++) await post(`/tasks/${entryId}/checks`, { index: i, on: true, by: 'web/abc12345' });
    check('*** a fully ticked list is no longer "open" ***',
      (await get('/checklists?open=1')).count === 0);
    check('...but is still listed, and reads 5 of 5',
      (await get('/checklists')).checklists[0].done === 5);

    const other = await post('/conversations', { title: 'Iceland' });
    const otherId = other.body.id;
    await listMessage('- [ ] rent the car', otherId);
    check('conversation= scopes the query',
      (await get(`/checklists?conversation=${otherId}`)).count === 1);
    check('...and excludes the other conversation\'s lists',
      (await get(`/checklists?conversation=${otherId}`)).checklists[0].conversationId === otherId);
    check('unscoped, both are listed', (await get('/checklists')).count === 2);

    // ------------------------------------------------------- the wake-up path
    console.log('\nnoticing — a burst of taps is ONE notification, not one per tap');
    const before = await get('/thread?conversation=main');
    const beforeCount = before.entries.length;
    const burstEntry = await listMessage('- [ ] one\n- [ ] two\n- [ ] three\n- [ ] four');
    // Four taps in quick succession, exactly as a thumb produces them.
    for (let i = 0; i < 4; i++) {
      await post(`/tasks/${burstEntry}/checks`, { index: i, on: true, by: 'web/abc12345' });
      await sleep(30);
    }
    const midway = await get('/thread?conversation=main');
    check('*** nothing is posted while he is still tapping ***',
      !midway.entries.some((e) => /Ticked off/.test(e.text || '')),
      JSON.stringify(midway.entries.filter((e) => /Ticked off/.test(e.text || '')).map((e) => e.text)));

    await sleep(SETTLE_MS + 500);
    const after = await get('/thread?conversation=main');
    const notices = after.entries.filter((e) => /Ticked off/.test(e.text || ''));
    check('*** four taps produce exactly one message in his thread ***', notices.length === 1,
      `${notices.length} messages: ` + JSON.stringify(notices.map((e) => e.text)));
    check('...naming everything he ticked, in one line',
      /one/.test(notices[0].text) && /two/.test(notices[0].text) &&
      /three/.test(notices[0].text) && /four/.test(notices[0].text), notices[0].text);
    check('...and saying where the list now stands', /4\/4 done/.test(notices[0].text), notices[0].text);
    check('*** it is PENDING, which is the only thing that wakes a coordinator ***',
      notices[0].status === 'pending', notices[0].status);
    check('...and attributed to him, because he is the one who did it',
      notices[0].role === 'user', notices[0].role);
    check('...in the conversation the list is in',
      notices[0].conversationId === 'main', notices[0].conversationId);
    check('the thread grew by the reply pair and one notice, and nothing else',
      after.entries.length === beforeCount + 3,
      `${after.entries.length - beforeCount} new entries`);

    console.log('\nnoticing — the agent channel gets the detail, his thread does not');
    const chan = await get('/messages?channel=checklist');
    check('a channel message was written too', chan.count >= 1, JSON.stringify(chan.count));
    const last = chan.messages[chan.messages.length - 1];
    check('...carrying the same detail', /Ticked off/.test(last.text), last.text);
    check('*** and it is NOT in his thread ***',
      !after.entries.some((e) => e.id === last.id));
    check('...nor in the queue depth an agent polls',
      !(await get('/tasks?status=pending')).tasks.some((t) => t.id === last.id));
    check('an agent can poll it incrementally',
      (await get(`/messages?channel=checklist&since=${Date.parse(last.ts)}`)).count === 0);

    console.log('\nnoticing — a tick and an immediate un-tick settles to nothing worth saying');
    const quiet = await listMessage('- [ ] mind changed');
    await post(`/tasks/${quiet}/checks`, { index: 0, on: true, by: 'web/abc12345' });
    await post(`/tasks/${quiet}/checks`, { index: 0, on: false, by: 'web/abc12345' });
    await sleep(SETTLE_MS + 500);
    const settled = await get('/thread?conversation=main');
    const mindChanged = settled.entries.filter((e) => /mind changed/.test(e.text || '') && /Un-ticked/.test(e.text || ''));
    check('the net change is reported once, not twice', mindChanged.length === 1,
      `${mindChanged.length}`);

    console.log('\nnoticing — a hostile item label cannot become markup in the summary');
    const nasty = await listMessage('- [ ] # not a heading\n- [ ] - not a bullet');
    await post(`/tasks/${nasty}/checks`, { index: 0, on: true, by: 'web/abc12345' });
    await post(`/tasks/${nasty}/checks`, { index: 1, on: true, by: 'web/abc12345' });
    await sleep(SETTLE_MS + 500);
    const summary = (await get('/thread?conversation=main')).entries
      .filter((e) => /not a heading/.test(e.text || ''))
      .pop();
    check('a summary was written', !!summary);
    check('*** a label that starts with # does not open a heading in the summary ***',
      !/^#/m.test(summary.text), JSON.stringify(summary.text));
    check('*** and one that starts with - does not open a list ***',
      !/^\s*-\s/m.test(summary.text), JSON.stringify(summary.text));

    // ------------------------------------------------------------ durability
    console.log('\ndurability — the tick outlives the process');
    const logBefore = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8');
    check('the tick is on disk as its own event', /"t":"check"/.test(logBefore));
    check('...recording the entry, index, who and when',
      /"entryId":"[^"]+","index":0,"on":true,"by":"web\/abc12345","at":"/.test(logBefore));

    // Same DATA_DIR, new process, new port — the handle carries the address so
    // `get` and `post` need no telling.
    await srv.restart();

    const revived = await get(`/tasks/${entryId}/checks`);
    check('*** every tick came back after a restart ***', revived.done === 5,
      `${revived.done}/${revived.total}`);
    check('...with who did it intact', revived.items[0].by === 'web/abc12345');
    check('...and when', !!Date.parse(revived.items[0].at || ''));
    check('...and the un-tick of a text [x] survived too, which is the harder case',
      revived.items[1].checked === true && revived.items[1].source === 'checked');
    check('the other conversation\'s list is still there',
      (await get('/checklists')).count >= 2);
    check('nothing was rewritten in the log, only appended',
      fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').startsWith(logBefore));

    console.log('\ndurability — a log from a build that never heard of checklists still loads');
    check('the server booted clean on replay', /events replayed/.test(srv.out),
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
