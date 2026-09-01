'use strict';
/*
 * api-ergonomics-selftest — the three API defects that cost real time on
 * 2026-08-31, each pinned, each proven to go red when its fix is removed.
 *
 *   node tools/api-ergonomics-selftest.js
 *
 * WHAT IS UNDER TEST.
 *
 * 1. THE ENVELOPE. Collection routes answered `{count, tasks}`; single-resource
 *    routes answered the record BARE. A caller could not write one accessor,
 *    and on 2026-08-31 one did not: a guard reading `body.task.claimedBy` got
 *    `undefined` on four SUCCESSFUL claims, decided they had failed, and never
 *    posted the results — stranding four tasks `claimed` with `result:null`.
 *    Every single-resource route now ALSO carries its canonical key, and the
 *    bare fields are still there beside it, which is the half that keeps
 *    tools/*-selftest.js, public/, autoseat, push, share and the external
 *    relay-watchdog working.
 *
 * 2. THE CLAIM SPELLING. `POST /tasks/<id>/claim {"agent":"X"}` once returned
 *    200 with `claimedBy:null` — a seat that reads occupied with nobody in it.
 *    tools/claim-identity-selftest.js already owns `by`/`agent`/`author` and is
 *    the authority on that; this suite adds only `claimedBy`, the spelling the
 *    route itself ANSWERS with, and re-pins that `by` still wins.
 *
 * 3. WHY A PENDING TASK IS UNSTAFFABLE. Seven tasks sat pending for up to eight
 *    days while tools/autoseat.js refused every one of them BY DESIGN. Nothing
 *    said so, so a permanent backlog was indistinguishable from a broken
 *    dispatcher and the obvious remedy — restart autoseat — would have been
 *    wrong every time. `GET /tasks` rows and `/health` now carry the reason.
 *
 * HOW RED IS PROVEN, AND WHY IT IS DONE THIS WAY. A green suite is not evidence
 * of anything on its own — this repo's own history says so repeatedly, and a
 * test that is green BY CONSTRUCTION is worse than no test, because it also
 * spends the reviewer's attention. So every claim above is also run against a
 * MUTANT server: the fix is cut out of a copy of server.js and the same
 * assertions must fail. `mutate()` refuses a pattern that does not match
 * exactly once, which is the check that keeps a mutation from silently
 * becoming a no-op that "passes" against unmodified code — exactly the trap
 * tools/autoseat-selftest.js was built around, and exactly the trap that fired
 * for real while this branch was being written (moving HUMAN_ORIGINS into
 * staffability.js quietly stopped two of autoseat's mutants from matching).
 *
 * The mutant is written into the repo root, not a temp dir: server.js resolves
 * ./icons.js, ./share.js, ./push.js, ./staffability.js and public/ relative to
 * itself, so it has to run from where those are. It is removed on the way out,
 * including on failure.
 *
 * Ports and DATA_DIRs come from the OS (see tools/harness-lib.js). Never run
 * against the live instance. Zero dependencies.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer, SERVER } = require('./harness-lib');

let failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`  ok   ${name}`); return true; }
  failures++;
  console.log(`  FAIL ${name}${detail ? ' - ' + detail : ''}`);
  return false;
}

// ------------------------------------------------------------------ mutation

/*
 * The honesty check, lifted from tools/autoseat-selftest.js for the same
 * reason it exists there: a mutation that matched nothing runs the ORIGINAL
 * code, every assertion passes, and the report reads "the fix is proven" when
 * nothing was tested at all.
 */
function mutate(text, find, replace) {
  const hits = text.split(find).length - 1;
  if (hits !== 1) {
    throw new Error(`mutation target ${JSON.stringify(find.slice(0, 60))} matched ${hits} times, expected exactly 1`);
  }
  return text.split(find).join(replace);
}

/** Writes a mutated server.js beside the real one so its relative requires resolve. */
function writeMutant(muts) {
  let src = fs.readFileSync(SERVER, 'utf8');
  for (const [find, replace] of muts) src = mutate(src, find, replace);
  const file = path.join(path.dirname(SERVER), `server.mutant-${process.pid}-${Math.random().toString(36).slice(2, 8)}.js`);
  fs.writeFileSync(file, src);
  return file;
}

// -------------------------------------------------------------------- harness

async function withServer(fn, opts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-apierg-'));
  const srv = await startServer({ dir, label: (opts && opts.label) || 'api-ergonomics', server: opts && opts.server });
  const call = async (method, p, body) => {
    const r = await fetch(srv.base + p, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try { json = await r.json(); } catch { /* some routes answer empty */ }
    return { status: r.status, body: json };
  };
  try { return await fn(call); } finally {
    await srv.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- assertions

/*
 * Every assertion in the suite, in one function, taking the `check` to use.
 *
 * That shape is the whole point: the real run and each mutant run execute the
 * SAME assertions, so "this mutant went red" means the very checks printed
 * above are what caught it, not a separate weaker copy of them that drifted.
 */
async function assertAll(call, ck) {
  // --- fixtures -----------------------------------------------------------
  const conv = await call('POST', '/conversations', { title: 'ergonomics probe' });
  const cid = conv.body && (conv.body.id || (conv.body.conversation && conv.body.conversation.id));

  // --- 1. the envelope ----------------------------------------------------
  ck('POST /conversations carries `conversation`',
    !!(conv.body && conv.body.conversation && conv.body.conversation.id === conv.body.id),
    JSON.stringify(Object.keys(conv.body || {})));
  ck('...and still carries the bare fields beside it',
    !!(conv.body && typeof conv.body.id === 'string' && 'archived' in conv.body));

  const got = await call('GET', `/conversations/${cid}`);
  ck('GET /conversations/<id> carries `conversation`',
    !!(got.body && got.body.conversation && got.body.conversation.id === cid));

  const patched = await call('POST', `/conversations/${cid}`, { agent: 'Ergo' });
  ck('POST /conversations/<id> carries `conversation`',
    !!(patched.body && patched.body.conversation && patched.body.conversation.agent === 'Ergo'));

  const msg = await call('POST', '/messages', { conversationId: cid, agent: 'Ergo', text: 'hello' });
  ck('POST /messages carries `message`',
    !!(msg.body && msg.body.message && msg.body.message.id === msg.body.id),
    JSON.stringify(Object.keys(msg.body || {})));

  const made = await call('POST', '/tasks', { conversationId: cid, instruction: 'do a thing', from: 'web', role: 'user' });
  const tid = made.body && (made.body.id || (made.body.task && made.body.task.id));
  ck('POST /tasks carries `task`', !!(made.body && made.body.task && made.body.task.id === tid));

  const read = await call('GET', `/tasks/${tid}`);
  ck('GET /tasks/<id> carries `task`', !!(read.body && read.body.task && read.body.task.id === tid));

  /*
   * THE EXACT READ THAT STRANDED FOUR TASKS. Not a paraphrase of it: this is
   * `body.task.claimedBy` on a successful claim, which is what returned
   * `undefined` and convinced a healthy guard its claims had all failed.
   */
  const claimed = await call('POST', `/tasks/${tid}/claim`, { by: 'Ergo' });
  ck('POST /tasks/<id>/claim answers body.task.claimedBy',
    !!(claimed.body && claimed.body.task && claimed.body.task.claimedBy === 'Ergo'),
    JSON.stringify(claimed.body && claimed.body.task));
  ck('...and body.claimedBy still works, unchanged',
    !!(claimed.body && claimed.body.claimedBy === 'Ergo'));

  const done = await call('POST', `/tasks/${tid}/result`, { result: 'the thing', by: 'Ergo' });
  ck('POST /tasks/<id>/result carries `task`',
    !!(done.body && done.body.task && done.body.task.result === 'the thing'));
  const rel = await call('POST', `/tasks/${tid}/relayed`, { by: 'Ergo' });
  ck('POST /tasks/<id>/relayed carries `task`',
    !!(rel.body && rel.body.task && rel.body.task.relayed === true));

  // --- 2. the claim spelling ---------------------------------------------
  const t2 = await call('POST', '/tasks', { conversationId: cid, instruction: 'spelling probe', from: 'web', role: 'user' });
  const c2 = await call('POST', `/tasks/${t2.body.id}/claim`, { claimedBy: 'Echoed' });
  ck('a claim spelled `claimedBy` names its holder',
    c2.status === 200 && c2.body && c2.body.claimedBy === 'Echoed',
    `${c2.status} ${JSON.stringify(c2.body && c2.body.claimedBy)}`);

  const t3 = await call('POST', '/tasks', { conversationId: cid, instruction: 'precedence probe', from: 'web', role: 'user' });
  const c3 = await call('POST', `/tasks/${t3.body.id}/claim`, { claimedBy: 'Loser', by: 'Winner' });
  ck('...and `by` still wins when both are sent',
    c3.body && c3.body.claimedBy === 'Winner', JSON.stringify(c3.body && c3.body.claimedBy));

  const t4 = await call('POST', '/tasks', { conversationId: cid, instruction: 'anonymous probe', from: 'web', role: 'user' });
  const c4 = await call('POST', `/tasks/${t4.body.id}/claim`);
  ck('...and a bodyless claim is still accepted, still anonymous',
    c4.status === 200 && c4.body && c4.body.claimedBy === null,
    `${c4.status} ${JSON.stringify(c4.body && c4.body.claimedBy)}`);

  // --- 3. why a pending task is unstaffable -------------------------------
  /*
   * One tab per reason, because the reasons are ordered and a single tab could
   * only ever demonstrate the first one that fires.
   */
  const reasonOf = async (id) => {
    const r = await call('GET', `/tasks/${id}`);
    return r.body && r.body.unstaffable;
  };

  // (a) a genuinely staffable message: pending, human, live tab. Must be null.
  const live = await call('POST', '/conversations', { title: 'live tab' });
  const okTask = await call('POST', '/tasks', { conversationId: live.body.id, instruction: 'a real question', from: 'web', role: 'user' });
  ck('a staffable pending task reports no reason',
    (await reasonOf(okTask.body.id)) === null, JSON.stringify(await reasonOf(okTask.body.id)));

  // (b) THE WATCHDOG'S OWN ALARM. `from:"relay-watchdog"` is refused by the
  //     origin allowlist, which is why two "AUTOSEAT IS NOT SEATING" alarms sat
  //     unread for two days in a tab nothing would ever pick up.
  const wd = await call('POST', '/tasks', { conversationId: live.body.id, instruction: 'AUTOSEAT IS NOT SEATING', from: 'relay-watchdog', role: 'user' });
  const wdWhy = await reasonOf(wd.body.id);
  ck('a relay-watchdog alarm says it is not a human client',
    !!(wdWhy && wdWhy.code === 'not-human-origin' && /relay-watchdog/.test(wdWhy.why)),
    JSON.stringify(wdWhy));

  // (c) a checklist settle: the same allowlist, a different origin.
  const cl = await call('POST', '/tasks', { conversationId: live.body.id, instruction: 'box ticked', from: 'checklist', role: 'user' });
  ck('a checklist post says the same',
    ((await reasonOf(cl.body.id)) || {}).code === 'not-human-origin');

  /*
   * (d) `role:"agent"` is NOT tested over HTTP, deliberately, and this comment
   * is the finding rather than a shrug. Both write paths set the role
   * server-side and ignore the client's: POST /tasks always writes `user`,
   * POST /messages always writes `agent` AND `status:"done"`. So no live route
   * can produce a PENDING agent-role task, and an assertion that pretended to
   * would have been green by construction - passing because the fixture it
   * described could not exist, not because the code works.
   *
   * The branch is still real and still needed: the replay path can carry
   * `role:"agent"` on a task record (see the `ev.task.role !== 'agent'` guard
   * in the event log reader), and autoseat checks it first for exactly that
   * reason. It is asserted directly against the pure function instead, below.
   */

  // (e) THE ARCHIVED CASE, which is also the whole of defect 3: a pending task
  //     whose conversation is missing from GET /conversations is in an ARCHIVED
  //     tab, not a deleted one, and the absence used to be the only signal.
  const arch = await call('POST', '/conversations', { title: 'archived tab' });
  const archTask = await call('POST', '/tasks', { conversationId: arch.body.id, instruction: 'stranded in an archived tab', from: 'web', role: 'user' });
  await call('POST', `/conversations/${arch.body.id}`, { archived: true });
  const archWhy = await reasonOf(archTask.body.id);
  ck('a task in an archived tab says the tab is archived',
    !!(archWhy && archWhy.code === 'archived' && /archived/.test(archWhy.why)), JSON.stringify(archWhy));

  const hidden = await call('GET', '/conversations');
  ck('...and that tab is indeed absent from the default list, as before',
    !(hidden.body.conversations || []).some((c) => c.id === arch.body.id));

  // (f) a deliberately stopped tab.
  const st = await call('POST', '/conversations', { title: 'stopped tab', agent: 'Gone' });
  const stTask = await call('POST', '/tasks', { conversationId: st.body.id, instruction: 'after the stop', from: 'web', role: 'user' });
  await call('POST', `/conversations/${st.body.id}/stop-ack`, { agent: 'Gone', phase: 'stopped' });
  ck('a task in a stopped tab says the tab was stopped',
    ((await reasonOf(stTask.body.id)) || {}).code === 'stopped',
    JSON.stringify(await reasonOf(stTask.body.id)));

  // (g) the listing carries it too — that is the route anyone diagnosing a
  //     backlog actually calls.
  const listing = await call('GET', '/tasks?status=pending');
  const rows = (listing.body && listing.body.tasks) || [];
  ck('GET /tasks rows carry `unstaffable`',
    rows.length > 0 && rows.every((t) => 'unstaffable' in t), `${rows.length} rows`);
  ck('...and it separates the stranded ones from the ones merely waiting',
    rows.some((t) => t.unstaffable === null) && rows.some((t) => t.unstaffable !== null));

  // --- 4. /health: two numbers called "conversations" ---------------------
  const health = (await call('GET', '/health')).body;
  const listed = (await call('GET', '/conversations')).body;
  ck('/health explains its conversation count',
    !!(health && health.conversationCounts
      && health.conversationCounts.total === health.conversations),
    JSON.stringify(health && health.conversationCounts));
  /*
   * Read through a local before dereferencing. A mutant that removes the field
   * entirely must make these go RED, not throw - a harness that crashes on a
   * mutant reports "could not be run", which is indistinguishable from a
   * mutation that never applied.
   */
  const cc = (health && health.conversationCounts) || null;
  ck('...and its `live` is the number GET /conversations shows',
    !!cc && cc.live === listed.count, cc ? `${cc.live} vs ${listed.count}` : 'no conversationCounts');
  ck('...and the archived tab is counted as archived, not lost',
    !!cc && cc.archived >= 1 && cc.live + cc.archived === cc.total);
  ck('/health says how much of the backlog is never moving',
    !!(health.unstaffable && health.unstaffable.count >= 4
      && health.unstaffable.byReason['not-human-origin'] >= 2
      && health.unstaffable.byReason.archived >= 1),
    JSON.stringify(health && health.unstaffable));
}

/*
 * The branches no HTTP route can reach, asserted against the module directly.
 *
 * These do not need a server and do not get mutated: server.js delegates to
 * this function outright, so the mutation that stubs `unstaffableOf` to `null`
 * already proves the HTTP surface depends on it, and the ordering below is
 * proven by the archived mutant. What is left is the arithmetic of the function
 * itself, which is cheapest and clearest checked in-process.
 */
function assertPureCore() {
  const S = require('../staffability');
  const pending = (over) => ({ status: 'pending', role: 'user', from: 'web', ...over });

  check('the role check catches a replayed agent-role task',
    (S.unstaffable(pending({ role: 'agent' }), { archived: false }) || {}).code === 'not-user-role');
  check('a task that is not pending is never called unstaffable',
    S.unstaffable(pending({ status: 'claimed', role: 'agent' }), { archived: false }) === null);
  check('...including one already answered in an archived tab',
    S.unstaffable(pending({ status: 'done' }), { archived: true }) === null);
  check('a missing conversation is its own reason, not a crash',
    (S.unstaffable(pending(), null) || {}).code === 'no-conversation');
  check('every reason it can return is a declared code',
    [
      S.unstaffable(pending({ role: 'agent' }), {}),
      S.unstaffable(pending({ from: 'relay-watchdog' }), {}),
      S.unstaffable(pending(), null),
      S.unstaffable(pending(), { archived: true }),
      S.unstaffable(pending(), { stopAck: 'stopped' }),
    ].every((u) => u && S.CODES.includes(u.code)));
  check('the three machine origins are all outside the allowlist',
    !S.HUMAN_ORIGINS.has('relay-watchdog') && !S.HUMAN_ORIGINS.has('checklist')
      && !S.HUMAN_ORIGINS.has('agent'));
  check('...and all three of his own clients are inside it',
    ['web', 'voice', 'voice-conversation'].every((o) => S.HUMAN_ORIGINS.has(o)));
}

// -------------------------------------------------------------------- main

/*
 * Each entry cuts out ONE fix. `expect` names an assertion that must fail as a
 * result — checked by name, so a mutant that goes red for some unrelated reason
 * (a crash, a 500, a fixture that stopped building) does not get counted as
 * proof that the assertion it was aimed at is doing any work.
 */
const MUTATIONS = [
  {
    name: 'the canonical key is dropped from every resource route',
    expect: 'POST /tasks/<id>/claim answers body.task.claimedBy',
    muts: [['  if (!(key in out)) out[key] = obj;\n', '']],
  },
  {
    name: '`claimedBy` drops back out of the accepted claim spellings',
    expect: 'a claim spelled `claimedBy` names its holder',
    muts: [['[body.by, body.agent, body.author, body.claimedBy]', '[body.by, body.agent, body.author]']],
  },
  {
    name: 'the unstaffable reason is not computed',
    expect: 'a relay-watchdog alarm says it is not a human client',
    muts: [['  return staffability.unstaffable(t, conversations.get(convIdOf(t)) || null);',
      '  return null;']],
  },
  {
    name: 'the archived reason specifically is not reported',
    expect: 'a task in an archived tab says the tab is archived',
    muts: [["  if (conv.archived) return { code: 'archived', why: REASON.archived() };\n", '',
    ]],
    file: 'staffability',
  },
  {
    name: '/health stops explaining its conversation count',
    expect: '/health explains its conversation count',
    muts: [['      conversationCounts: conversationCounts(),\n', '']],
  },
  {
    name: '/health stops reporting the unstaffable backlog',
    expect: '/health says how much of the backlog is never moving',
    muts: [['      unstaffable: unstaffableSummary(),\n', '']],
  },
];

/*
 * A staffability.js mutation cannot go through writeMutant(), which only
 * rewrites server.js. The dependency is swapped in place and restored in a
 * finally — the same trade autoseat-selftest makes, for the same reason: the
 * module is resolved by path, so there is nowhere else to put it.
 */
const DEP = path.join(path.dirname(SERVER), 'staffability.js');

async function runMutant(m) {
  const depOriginal = fs.readFileSync(DEP, 'utf8');
  let mutantFile = null;
  const seen = [];
  const quiet = (name, cond) => { if (!cond) seen.push(name); };
  try {
    if (m.file === 'staffability') {
      fs.writeFileSync(DEP, m.muts.reduce((acc, [f, r]) => mutate(acc, f, r), depOriginal));
      mutantFile = SERVER;
    } else {
      mutantFile = writeMutant(m.muts);
    }
    await withServer((call) => assertAll(call, quiet), { label: 'mutant', server: mutantFile });
  } finally {
    fs.writeFileSync(DEP, depOriginal);
    if (mutantFile && mutantFile !== SERVER) fs.rmSync(mutantFile, { force: true });
  }
  return seen;
}

async function main() {
  console.log('staffability, in process - the branches no HTTP route can reach');
  assertPureCore();

  console.log('\nthe real server - every fix, asserted');
  await withServer((call) => assertAll(call, check));

  console.log('\nmutation - each fix is cut out in turn; the assertion it serves MUST fail:');
  for (const m of MUTATIONS) {
    let broke;
    try {
      broke = await runMutant(m);
    } catch (e) {
      console.log(`  FAIL ${m.name}: mutant could not be built or run - ${e.message}`);
      failures++;
      continue;
    }
    if (broke.includes(m.expect)) {
      console.log(`  ok   ${m.name} -> "${m.expect}" went red (${broke.length} assertion(s) failed)`);
    } else {
      console.log(`  FAIL ${m.name} -> "${m.expect}" still PASSED. That fix is not tested.`);
      if (broke.length) console.log(`        (what did fail instead: ${broke.join('; ')})`);
      failures++;
    }
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nall passed');
  process.exitCode = failures ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
