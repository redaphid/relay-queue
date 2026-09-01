#!/usr/bin/env node
'use strict';
/*
 * autoseat-doa-selftest - prove a dispatch that dies at birth becomes visible,
 * and prove it stays quiet about the failures that are not that.
 *
 * THE FAULT THIS COVERS. On 2026-09-01 autoseat was healthy and dispatching
 * correctly, and every coordinator it spawned died in ~2s with exit=1. Each
 * per-dispatch log held 73 bytes - "Failed to authenticate: OAuth session
 * expired and could not be refreshed" - and the exit handler logged only the
 * number. Tabs sat with a waiting human message and an empty seat for hours
 * while every component reported itself healthy.
 *
 * WHY THIS RUNS AGAINST A REAL SERVER. The alarm's whole job is to ARRIVE. A
 * unit test of the text would have passed on 2026-09-01 too. So this posts
 * through the real POST /messages, on a throwaway DATA_DIR and an OS-assigned
 * port (never the live instance), and then READS IT BACK - including the two
 * properties that make it different from the watchdog's permanently-unstaffable
 * alarm: it is not a task, and it cannot dispatch anything.
 *
 * WHY IT MUTATES. Half these assertions are "no alarm fired", and a suite full
 * of those is worthless on its own: "correctly silent" and "cannot alarm at
 * all" produce identical output. Each guard is removed in turn, in memory, and
 * the suite must go RED. The replacement count is asserted to be exactly 1
 * first, so a mutation that failed to apply is an error, not a pass.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { spawn } = require('node:child_process');
const { startServer } = require('./harness-lib.js');

const SRC = path.join(__dirname, 'autoseat.js');
const real = require('./autoseat.js');

/* The exact bytes that were on disk on 2026-09-01. */
const AUTH_LOG = 'Failed to authenticate: OAuth session expired and could not be refreshed\n';

function loadMutant(find, replace) {
  const src = fs.readFileSync(SRC, 'utf8');
  const hits = src.split(find).length - 1;
  if (hits !== 1) throw new Error(`mutation target ${JSON.stringify(find)} matched ${hits} times, expected exactly 1`);
  const m = new Module(SRC, null);
  m.filename = SRC;
  m.paths = Module._nodeModulePaths(path.dirname(SRC));
  m._compile(src.split(find).join(replace), SRC);
  return m.exports;
}

const post = (base, route, body) => fetch(base + route, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}).then(async (r) => {
  const t = await r.text();
  if (!r.ok) throw new Error(`POST ${route} -> ${r.status} ${t}`);
  return JSON.parse(t);
});
const get = (base, route) => fetch(base + route).then((r) => r.json());

/* A scratch log file holding whatever the dead child wrote. */
function childLog(dir, name, text) {
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `${name}.log`);
  fs.writeFileSync(f, text);
  return f;
}

/*
 * One full run of the suite against `mod` - the real module, or a mutant.
 * Returns the list of failures, so the mutation half can assert it is non-empty.
 */
async function check(mod, srv, dirs) {
  const base = srv.base;
  const failures = [];
  const no = (m) => failures.push(m);
  const stateFile = path.join(dirs.state, `state-${Math.random().toString(36).slice(2)}.json`);

  /* A fresh alarm tab per run, so one run's escalations cannot be read as the
   * next one's - and a fresh dispatch tab per case, so the cooldown assertions
   * are about the cooldown and not about tab reuse. */
  const mainTab = (await post(base, '/conversations', { title: 'Escalations' })).id;
  const mkTab = async (title) => {
    const c = await post(base, '/conversations', { title });
    await post(base, '/tasks', { conversationId: c.id, text: 'please look at this', from: 'web' });
    return c.id;
  };

  const cfg = { queue: base, stateFile, alarmConversation: mainTab };
  const runtime = { state: mod.loadState(stateFile), log: () => {} };
  const run = (o) => mod.reportDispatchExit(cfg, runtime, o);
  const msgsIn = async (cid) => (await get(base, `/messages?conversationId=${cid}`)).messages || [];

  // ---------------------------------------------------------------- 1. DOA
  const doaTab = await mkTab('Move relay to WSL');
  const doaLog = childLog(dirs.logs, 'auto-move-relay-1', AUTH_LOG);
  const v1 = await run({
    agent: 'auto-move-relay-09ih',
    conversationId: doaTab,
    title: 'Move relay to WSL',
    logFile: doaLog,
    code: 1,
    signal: null,
    ranMs: 2000,
  });
  if (!v1.alarm || v1.kind !== 'died-on-arrival') {
    no(`a coordinator that exited 1 in 2s having posted nothing did NOT alarm (kind=${v1.kind})`);
  }
  const doaMsgs = await msgsIn(doaTab);
  const alarm = doaMsgs.find((m) => m.author === 'autoseat');
  if (!alarm) {
    no('no alarm reached the stranded tab - this is the 2026-09-01 failure, unfixed');
  } else {
    // The point of the whole exercise: a human must be able to ACT on it.
    if (!/OAuth session expired/.test(alarm.text)) {
      no('the alarm does not carry the reason off the child log, so it says no more than exit=1 did');
    }
    if (!alarm.text.includes('auto-move-relay-09ih')) no('the alarm does not name the dead coordinator');
    if (!alarm.text.includes(doaLog)) no('the alarm does not point at the full child log');
    if (!/not be re-dispatched|by hand/i.test(alarm.text)) {
      no('the alarm does not say the message will not be retried - a human would wait forever for a retry that never comes');
    }
    // NOT the watchdog's dead path: a task from a non-human origin is
    // permanently unstaffable, so the alarm is deliberately a message.
    if (alarm.role !== 'agent') no(`the alarm is role=${alarm.role}; it must be role:agent so it cannot re-trigger a dispatch`);
    if (alarm.status !== 'done') no(`the alarm is status=${alarm.status}; it must not sit pending as an unstaffable task`);
  }
  // And prove the last one structurally rather than by inspection: feed the
  // alarm itself back through the selector.
  const asTask = { id: 'alarm-1', conversationId: doaTab, role: alarm ? alarm.role : 'agent', from: alarm ? alarm.from : 'agent', ts: new Date(Date.now() - 600000).toISOString() };
  const fed = mod.selectSeats({
    tasks: [asTask],
    conversations: [{ id: doaTab, title: 'x', agent: null, archived: false, stopAck: null }],
    now: Date.now(), graceMs: 20000, maxConcurrent: 3,
  });
  if (fed.chosen.length) no('the alarm itself would dispatch a coordinator - that is a loop');

  const esc = (await msgsIn(mainTab)).filter((m) => m.author === 'autoseat');
  if (!esc.length) no('nothing escalated to the alarm conversation');
  else if (!/OAuth session expired/.test(esc[0].text)) no('the escalation does not carry the reason');

  // ------------------------------------------------- 2. ran, then crashed
  const lateTab = await mkTab('Chores');
  await post(base, '/messages', { conversationId: lateTab, agent: 'auto-chores-x7qa', text: 'auto-chores-x7qa starting - on it.' });
  const v2 = await run({
    agent: 'auto-chores-x7qa',
    conversationId: lateTab,
    title: 'Chores',
    logFile: childLog(dirs.logs, 'auto-chores', 'Error: something blew up an hour in\n'),
    code: 1,
    signal: null,
    ranMs: 3600000,
  });
  if (v2.alarm) no('a coordinator that worked for an hour and THEN exited 1 raised a birth-failure alarm - crying wolf');
  if ((await msgsIn(lateTab)).filter((m) => m.author === 'autoseat').length) {
    no('an alarm was posted into the tab of a coordinator that had actually been working');
  }

  // ---------------------------------------------------- 3. a clean finish
  const okTab = await mkTab('Finished cleanly');
  const v3 = await run({
    agent: 'auto-fine-0001', conversationId: okTab, title: 'Finished cleanly',
    logFile: childLog(dirs.logs, 'auto-fine', 'all done\n'), code: 0, signal: null, ranMs: 90000,
  });
  if (v3.alarm) no('a coordinator that exited 0 raised an alarm');

  // ------------------------------------------ 4. the child never started
  const enoTab = await mkTab('Bad claude path');
  const v4 = await run({
    agent: 'auto-badpath-0002', conversationId: enoTab, title: 'Bad claude path',
    spawnError: "spawn C:\\nope\\claude.exe ENOENT", ranMs: 1,
  });
  if (!v4.alarm || v4.kind !== 'spawn-failed') no('a coordinator that could not be spawned at all did not alarm');
  const enoMsg = (await msgsIn(enoTab)).find((m) => m.author === 'autoseat');
  if (!enoMsg || !/ENOENT/.test(enoMsg.text)) no('the spawn-failure alarm does not carry the spawn error');

  // -------------------------------------- 5. dedupe: one alarm, not fifty
  const before = (await msgsIn(mainTab)).filter((m) => m.author === 'autoseat').length;
  const tabs = [];
  for (let i = 0; i < 4; i++) {
    const t = await mkTab(`Stranded ${i}`);
    tabs.push(t);
    await run({
      agent: `auto-stranded-${i}`, conversationId: t, title: `Stranded ${i}`,
      logFile: childLog(dirs.logs, `auto-stranded-${i}`, AUTH_LOG), code: 1, signal: null, ranMs: 2000,
    });
  }
  const after = (await msgsIn(mainTab)).filter((m) => m.author === 'autoseat').length;
  if (after !== before) {
    no(`4 more identical failures escalated ${after - before} extra time(s) to the alarm tab; the cooldown must suppress them`);
  }
  // ...but every stranded tab still gets its own, because each one holds a
  // different unanswered human message.
  for (const t of tabs) {
    if (!(await msgsIn(t)).some((m) => m.author === 'autoseat')) {
      no('a stranded tab got no alarm because an unrelated tab had already reported the same reason');
    }
  }

  // ------------------------- 6. a DIFFERENT reason is not suppressed by it
  const otherTab = await mkTab('Different fault');
  await run({
    agent: 'auto-other-0003', conversationId: otherTab, title: 'Different fault',
    logFile: childLog(dirs.logs, 'auto-other', 'Error: model not available for this account\n'),
    code: 1, signal: null, ranMs: 1500,
  });
  const escNow = (await msgsIn(mainTab)).filter((m) => m.author === 'autoseat');
  if (!escNow.some((m) => /model not available/.test(m.text))) {
    no('a different failure was swallowed by the cooldown for the first one');
  }

  // --------------------------------------------- 7. the body must be ASCII
  const dirty = mod.readableReason('\u001b[31mFailed \u2014 caf\u00e9 \u0000 boom\u001b[0m');
  if (/[^\x20-\x7E]/.test(dirty)) {
    no(`readableReason left non-ASCII in ${JSON.stringify(dirty)} - relay refuses the body and NOTHING is stored`);
  }
  const txt = mod.alarmText({ agent: 'a', kind: 'died-on-arrival', code: 1, ranMs: 2000, reason: dirty, logFile: 'x' });
  if (/[^\x20-\x7E\n]/.test(txt)) no('alarmText produced a non-ASCII body');

  // ------------------------------ 8. "cannot ask relay" is not "it spoke"
  const v8 = mod.classifyDispatchExit({ code: 1, ranMs: 2000, trace: null, reason: 'x' });
  if (!v8.alarm) no('an unverifiable death was treated as fine - unknown must not read as healthy');

  return failures;
}

// ------------------------------------------------------------------ main

const MUTATIONS = [
  /*
   * The gate itself. If a nonzero exit no longer alarms, the 2026-09-01
   * failure is back exactly as it was.
   */
  ['the nonzero-exit gate', 'if (!failed) return', 'if (true) return'],
  /*
   * The trace check, removed in BOTH directions, because it is the one
   * judgement call in the file and it can be wrong two ways.
   *
   * Treating every death as a birth failure cries wolf on the hour-long
   * coordinator that crashed at the end. Treating every death as a late crash
   * silences the real alarm.
   */
  ['the had-it-spoken check', 'if (trace === true) {', 'if (true) {'],
  ['the never-spoke alarm', 'const trace = o.spawnError ? false : await agentSpokeIn(cfg.queue, o.conversationId, o.agent);',
    'const trace = true;'],
  /* Without the cooldown, one auth outage is fifty identical posts in main. */
  ['the escalation cooldown', 'const dueAgain = !(now - escalatedAt < ALARM_REPEAT_MS);', 'const dueAgain = true;'],
  /* Without the signature, the cooldown swallows unrelated faults too. */
  ['the per-reason signature', 'const sig = failureSignature(verdict.reason);', "const sig = 'all';"],
  /* Without the ASCII squash, relay refuses the body and stores NOTHING - the
   * alarm fails in exactly the silent way it exists to prevent. */
  ['the ASCII squash', ".replace(/[^\\x20-\\x7E\\n\\r\\t]/g, ' ')", '.replace(/$^/g, %27 %27)'.replace(/%27/g, "'")],
  /* Without the reason, the alarm says no more than `exit=1` already did. */
  ['the reason from the child log', 'reason: o.logFile ? reasonFromLogFile(o.logFile) : \'\',', "reason: '',"],
  /* Without the never-verified branch, a relay it could not reach reads as healthy. */
  ['the unverified-is-still-an-alarm rule', "kind: trace === null ? 'died-unverified' : 'died-on-arrival',",
    "alarm: trace === null ? false : true, kind: 'died-on-arrival',"],
];

/*
 * THE WIRING, END TO END - and the only assertion here that could have caught
 * 2026-09-01 on its own.
 *
 * Everything above drives reportDispatchExit() directly, so all of it would
 * still pass if child.on('exit') never called it. That is precisely the shape
 * of the original bug: the reason was captured correctly and then surfaced
 * nowhere. So this runs the REAL autoseat, --once, against the scratch server,
 * with --claude pointed at a stand-in that exits nonzero immediately.
 *
 * The stand-in is `node` itself, invoked with the args autoseat always passes
 * (`-p <brief>`). `node -p <a brief>` is a syntax error: it writes to stderr -
 * which autoseat has already redirected into the per-dispatch log - and exits
 * 1, in milliseconds, with nothing posted into the tab. That is the 2026-09-01
 * shape reproduced with no Claude, no auth, and nothing platform-specific.
 *
 * --once returns after one pass but the process stays alive while the child
 * does, so waiting for autoseat to exit is the correct synchronisation: it
 * cannot exit until its own exit handler has finished.
 */
async function checkWiring(autoseatPath, root, label) {
  /*
   * Its own server, deliberately. Sharing the one above leaves several tabs
   * still holding unanswered human messages, and autoseat would spend its
   * concurrency cap on those before it ever reached this one - a green or red
   * decided by tab ordering rather than by the wiring. (That is not
   * hypothetical: it is how this check first came up red.)
   */
  const srv = await startServer({ dir: fs.mkdtempSync(path.join(root, `wiresrv-${label}-`)), label: `wire-${label}` });
  const base = srv.base;
  const failures = [];
  try {
  const tab = await post(base, '/conversations', { title: `Wiring ${label}` });
  await post(base, '/tasks', { conversationId: tab.id, text: 'please look at this', from: 'web' });
  const alarmTab = await post(base, '/conversations', { title: `Wiring escalations ${label}` });
  const dir = fs.mkdtempSync(path.join(root, `wire-${label}-`));

  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      autoseatPath, '--once',
      '--queue', base,
      '--state', path.join(dir, 'state.json'),
      '--heartbeat', path.join(dir, 'hb.json'),
      '--log-dir', path.join(dir, 'logs'),
      '--grace', '0',
      '--claude', process.execPath,
      '--cwd', path.join(__dirname, '..'),
      '--alarm-conversation', alarmTab.id,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    child.on('error', reject);
    child.on('exit', () => { failures.autoseatOut = out; resolve(); });
    setTimeout(() => { child.kill(); }, 30000).unref();
  });

  const msgs = (await get(base, `/messages?conversationId=${tab.id}`)).messages || [];
  if (!msgs.some((m) => m.author === 'autoseat')) {
    failures.push('a real autoseat pass dispatched a coordinator that died instantly, and NOTHING was posted '
      + 'into the stranded tab - the exit handler is not wired to the alarm');
  }
  const esc = (await get(base, `/messages?conversationId=${alarmTab.id}`)).messages || [];
  if (!esc.some((m) => m.author === 'autoseat')) failures.push('a real autoseat pass escalated nothing');
  return failures;
  } finally { await srv.stop(); }
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoseat-doa-'));
  const dirs = { logs: path.join(root, 'logs'), state: path.join(root, 'state') };
  fs.mkdirSync(dirs.state, { recursive: true });
  const srv = await startServer({ dir: path.join(root, 'data'), label: 'doa' });
  let bad = 0;
  try {
    const baseline = await check(real, srv, dirs);
    if (baseline.length) {
      console.log('FAIL  the suite is red against the real code:');
      for (const f of baseline) console.log(`        - ${f}`);
      bad += baseline.length;
    } else {
      console.log('ok    a dispatch that died at birth is reported into its tab and escalated once,');
      console.log('      a late crash and a clean exit are not, and the alarm cannot dispatch anything');
    }

    console.log('\nmutation - each guard is removed in turn; the suite MUST go red:');
    for (const [name, find, replace] of MUTATIONS) {
      let f;
      try {
        f = await check(loadMutant(find, replace), srv, dirs);
      } catch (e) {
        console.log(`FAIL  ${name}: mutant could not be built or run - ${e.message}`);
        bad++;
        continue;
      }
      if (f.length) console.log(`ok    ${name} removed -> ${f.length} assertion(s) failed (first: ${f[0]})`);
      else { console.log(`FAIL  ${name} removed -> the suite still passed. That guard is NOT tested.`); bad++; }
    }

    /* The wiring, for real, plus the one mutation that matters against it:
     * delete the call from the exit handler and the alarm must vanish. */
    const wire = await checkWiring(SRC, root, 'real');
    if (wire.length) {
      console.log('\nFAIL  the exit handler is not wired to the alarm:');
      for (const f of wire) console.log(`        - ${f}`);
      console.log(`--- autoseat said ---\n${wire.autoseatOut}\n---------------------`);
      bad += wire.length;
    } else {
      console.log('\nok    a real autoseat pass whose child dies instantly posts the alarm into the stranded tab');
    }

    const unwiredSrc = fs.readFileSync(SRC, 'utf8');
    const findCall = '      report({ code, signal });';
    if (unwiredSrc.split(findCall).length - 1 !== 1) {
      console.log('FAIL  could not build the unwired mutant - the exit-handler call site moved');
      bad++;
    } else {
      const mutantPath = path.join(__dirname, `autoseat-unwired-${process.pid}.js`);
      fs.writeFileSync(mutantPath, unwiredSrc.split(findCall).join('      /* mutated out */'));
      try {
        const f = await checkWiring(mutantPath, root, 'unwired');
        if (f.length) console.log(`ok    the exit-handler call removed -> ${f.length} assertion(s) failed (first: ${f[0]})`);
        else { console.log('FAIL  the exit-handler call removed -> still passed. The wiring is NOT tested.'); bad++; }
      } finally { fs.rmSync(mutantPath, { force: true }); }
    }
  } finally {
    await srv.stop();
  }
  console.log(bad ? `\n${bad} FAILURE(S)` : '\nall good');
  process.exit(bad ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
