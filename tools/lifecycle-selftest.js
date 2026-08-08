'use strict';
/*
 * lifecycle-selftest — prove that asking a coordinator to stop never pretends to
 * have stopped it.
 *
 *   node tools/lifecycle-selftest.js
 *
 * The feature this covers exists because a coordinator is TWO things: a row in
 * this queue, and a Claude agent running in a session somewhere. The UI can only
 * reach the row. So the one bug worth testing for is a UI action that *looks*
 * like a kill: archive the conversation, watch it go quiet, and never learn that
 * the agent is still running and still holding a git worktree.
 *
 * Accordingly this checks, over real HTTP against a real server:
 *
 *   - the five lifecycle states stay distinct, and in particular that a cleanly
 *     stopped agent never renders the same as one that was never assigned —
 *     the agent unassigns itself on the way out, so a naive reading collapses
 *     the two into "unassigned" and loses the only good news in the system;
 *   - ARCHIVING DOES NOT REPORT THE AGENT AS STOPPED, and says so in the reply;
 *   - a stop request survives a restart through the ordinary event replay, so a
 *     server that reboots (which this one does on every source change) does not
 *     quietly forget that someone asked;
 *   - a stop request nobody can read is labelled as such rather than sitting on
 *     "any moment now" forever;
 *   - the activity feed keeps subagent lifecycle across a restart and drops tool
 *     calls, which is the durability split it was designed around.
 *
 * Scratch DATA_DIR, own port, zero dependencies. Touches nothing real.
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SERVER = path.join(__dirname, '..', 'server.js');
// 3931, not 3919: checklist-selftest landed on 3919 independently, and two
// suites sharing a default is a race waiting for someone to run them together.
// (The real fix is an ephemeral port plus a nonce proving the server is ours —
// a harness that binds a fixed port can silently interrogate a stranger's.)
const PORT = Number(process.env.LIFECYCLE_TEST_PORT || 3931);
const BASE = `http://127.0.0.1:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
}

const get = async (p) => (await fetch(BASE + p)).json();
async function post(p, body) {
  const res = await fetch(BASE + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body === undefined ? {} : body),
  });
  return { status: res.status, body: await res.json() };
}

function stop(proc) {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  const gone = new Promise((r) => proc.once('exit', r));
  proc.kill('SIGTERM');
  return gone;
}

async function waitForBoot(proc) {
  for (let i = 0; i < 100; i++) {
    if (proc.exitCode !== null) throw new Error(`server exited early with code ${proc.exitCode}`);
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return;
    } catch { /* not listening yet */ }
    await sleep(100);
  }
  throw new Error('server did not start listening');
}

function boot(dir) {
  const proc = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      DATA_DIR: dir,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      WATCH_SOURCE: '0',
      // Squeezed so the stalled-work transitions are reachable in seconds
      // instead of minutes. Same knobs the status page ships with.
      WAITING_GRACE_MS: '1',
      WAITING_ALARM_MS: '600000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', () => {});
  return proc;
}

const lifecycleOf = async (id) => (await get(`/conversations/${id}`)).agentState.lifecycle;
const stateOf = async (id) => (await get(`/conversations/${id}`)).agentState;

async function newConv(title, agent) {
  const r = await post('/conversations', agent === undefined ? { title } : { title, agent });
  return r.body.id;
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-lifecycle-'));
  console.log(`\nbooting server.js on a scratch DATA_DIR (${dir})`);
  let proc = boot(dir);

  try {
    await waitForBoot(proc);

    // ---------------------------------------------------------------- states
    console.log('\nthe lifecycle states are distinct');

    const idle = await newConv('nobody is assigned here');
    check('a conversation with no agent is "unassigned"', await lifecycleOf(idle) === 'unassigned',
      await lifecycleOf(idle));

    const fresh = await newConv('assigned, never acted', 'coord-fresh');
    check('assigned but never heard from is "never", not "idle"',
      await lifecycleOf(fresh) === 'never', await lifecycleOf(fresh));

    const busy = await newConv('assigned and working', 'coord-busy');
    const t1 = await post('/tasks', { instruction: 'do a thing', conversationId: busy });
    await post(`/tasks/${t1.body.id}/claim`, { by: 'coord-busy' });
    check('an agent that just claimed work is "watching"', await lifecycleOf(busy) === 'watching',
      await lifecycleOf(busy));
    const busyState = await stateOf(busy);
    check('...and its liveness comes from last ACTED, not from a heartbeat',
      busyState.actedAgoSec !== null && busyState.seenAgoSec === null,
      `acted=${busyState.actedAgoSec} seen=${busyState.seenAgoSec}`);

    // Stale: it acted once, then work piled up behind it and nothing happened.
    await post(`/tasks/${t1.body.id}/result`, { result: 'done that' });
    await post('/tasks', { instruction: 'and now this one waits', conversationId: busy });
    await sleep(1400);
    const staleState = await stateOf(busy);
    check('assigned but stalled on waiting work is "stale"', staleState.lifecycle === 'stale',
      `${staleState.lifecycle} (waiting=${staleState.waitingSec}s acted=${staleState.actedAgoSec}s)`);
    check('"stale" is a liveness verdict, with no stop request attached',
      staleState.stop.phase === null && staleState.stop.requested === false);

    // ------------------------------------------------------------ requesting
    console.log('\nasking is not stopping');

    const req = await post(`/conversations/${busy}`, { stopRequested: true, stopRequestedBy: 'human' });
    check('the stop request is accepted', req.status === 200, `HTTP ${req.status}`);
    check('*** the reply says plainly that this is not a kill ***',
      req.body.stopRequestEffect && req.body.stopRequestEffect.stopped === false
      && /request, not a kill/i.test(req.body.stopRequestEffect.detail));
    check('the reply names where a real kill has to come from',
      req.body.stopRequestEffect.forceKill.availableHere === false
      && /top-level Claude session/.test(req.body.stopRequestEffect.forceKill.how));

    let s = await stateOf(busy);
    check('the badge becomes "stop-requested", not "stopped"', s.lifecycle === 'stop-requested', s.lifecycle);
    check('...and it is explicitly unacknowledged', s.stop.ack === null && s.stop.unacknowledgedForSec !== null,
      JSON.stringify(s.stop.ack));
    check('the requester is recorded', s.stop.requestedBy === 'human', s.stop.requestedBy);
    check('the agent is still assigned, because it has not gone anywhere',
      (await get(`/conversations/${busy}`)).agent === 'coord-busy');

    // The honesty signal: it kept working after being asked.
    const after = await post('/tasks', { instruction: 'more work', conversationId: busy });
    await post(`/tasks/${after.body.id}/claim`, { by: 'coord-busy' });
    s = await stateOf(busy);
    check('an agent that keeps acting after the request is flagged as still going',
      s.stop.actedSinceRequest === true);

    console.log('\na request nobody can read is labelled, not left hopeful');
    const orphan = await newConv('asked to stop, nobody home');
    await post(`/conversations/${orphan}`, { stopRequested: true });
    const os_ = await stateOf(orphan);
    check('a stop request with no agent assigned says it will never be seen',
      os_.stop.willNeverBeSeen === true, JSON.stringify(os_.stop.willNeverBeSeen));

    // ---------------------------------------------------------- acknowledging
    console.log('\nonly the agent may say it stopped');

    const ack1 = await post(`/conversations/${busy}/stop-ack`, {
      agent: 'coord-busy', phase: 'stopping', worktrees: ['D:/Projects/relay-busy'], note: 'releasing claims',
    });
    check('an agent can acknowledge with "stopping"', ack1.status === 200, `HTTP ${ack1.status}`);
    s = await stateOf(busy);
    check('the badge becomes "stopping" — winding down, not gone', s.lifecycle === 'stopping', s.lifecycle);
    check('the worktrees it reported are visible', Array.isArray(s.stop.worktrees) && s.stop.worktrees.length === 1,
      JSON.stringify(s.stop.worktrees));
    check('...and are marked self-reported, because nothing here checked them',
      s.stop.worktreesAreSelfReported === true);
    check('the agent is STILL assigned while stopping', (await get(`/conversations/${busy}`)).agent === 'coord-busy');

    const ack2 = await post(`/conversations/${busy}/stop-ack`, {
      agent: 'coord-busy', phase: 'stopped', worktrees: [], note: 'all released',
    });
    check('an agent can acknowledge with "stopped"', ack2.status === 200, `HTTP ${ack2.status}`);
    s = await stateOf(busy);
    check('the badge becomes "stopped"', s.lifecycle === 'stopped', s.lifecycle);
    check('the agent unassigns itself as its last act',
      (await get(`/conversations/${busy}`)).agent === null);
    check('*** "stopped cleanly" never collapses into "unassigned" ***',
      s.state === 'unassigned' && s.lifecycle === 'stopped',
      `state=${s.state} lifecycle=${s.lifecycle}`);
    check('a stopped agent cannot go back to stopping',
      (await post(`/conversations/${busy}/stop-ack`, { phase: 'stopping' })).status === 409);
    check('a nonsense phase is refused',
      (await post(`/conversations/${busy}/stop-ack`, { phase: 'dead' })).status === 400);

    // ------------------------------------------------------------- archiving
    console.log('\narchiving is not stopping');

    const ghost = await newConv('archived while its agent runs on', 'coord-ghost');
    const arch = await post(`/conversations/${ghost}`, { archived: true });
    check('archiving is accepted', arch.status === 200, `HTTP ${arch.status}`);
    check('*** the reply warns that the agent was never confirmed stopped ***',
      arch.body.ghost && arch.body.ghost.stopped === false
      && arch.body.ghost.agentStillAssigned === 'coord-ghost',
      JSON.stringify(arch.body.ghost));
    check('...and points at the only thing that can really kill it',
      /top-level Claude session/.test(arch.body.ghost.forceKill.how));

    const gs = await stateOf(ghost);
    check('*** an archived conversation does NOT report its agent as stopped ***',
      gs.lifecycle !== 'stopped' && gs.stop.ack === null && gs.stop.phase === null,
      `lifecycle=${gs.lifecycle} ack=${gs.stop.ack}`);
    check('the archived conversation still names its agent',
      (await get(`/conversations/${ghost}`)).agent === 'coord-ghost');
    check('archiving sets no stop timestamps at all',
      gs.stop.requestedAt === null && gs.stop.stoppedAt === null);

    console.log('\nthe roster on /status shows what the list hides');
    const roster = (await get('/status?engines=0')).coordinators;
    check('/status carries a coordinator roster', roster && Array.isArray(roster.rows));
    check('the archived-but-running one is counted as a ghost', roster.ghosts >= 1, `ghosts=${roster.ghosts}`);
    check('the ghost is present even though /conversations hides it',
      roster.rows.some((r) => r.id === ghost)
      && !(await get('/conversations')).conversations.some((c) => c.id === ghost));
    check('/status states that a force kill is not available here',
      (await get('/status?engines=0')).forceKill.availableHere === false);
    check('every conversation row carries the force-kill note for the UI to quote',
      (await get(`/conversations/${ghost}`)).agentState.forceKill.availableHere === false);

    // -------------------------------------------------------- activity feed
    console.log('\nthe activity feed separates evidence from colour');

    const work = await newConv('a coordinator that reports', 'coord-report');
    const empty = await get(`/conversations/${work}/activity`);
    check('an empty feed says whether anything reported at all',
      empty.reporting === false && empty.count === 0);

    const sp = await post(`/conversations/${work}/activity`, {
      agent: 'coord-report', kind: 'spawned', subagent: 'agent-one', task: 'build the thing',
    });
    check('a spawn is durable', sp.status === 201 && sp.body.durable === true);
    await post(`/conversations/${work}/activity`, {
      agent: 'coord-report', kind: 'spawned', subagent: 'agent-two', task: 'the other thing',
    });
    const tl = await post(`/conversations/${work}/activity`, {
      agent: 'coord-report', kind: 'tool', tool: 'Bash', text: 'git worktree add',
    });
    check('a tool call is NOT durable', tl.status === 201 && tl.body.durable === false);
    await post(`/conversations/${work}/activity`, {
      agent: 'coord-report', kind: 'finished', subagent: 'agent-two', ok: true,
    });
    check('a spawn with no subagent name is refused',
      (await post(`/conversations/${work}/activity`, { kind: 'spawned' })).status === 400);

    const feed = await get(`/conversations/${work}/activity`);
    check('the feed pairs spawned with finished', feed.subagents.length === 2 && feed.running === 1,
      `subagents=${feed.subagents.length} running=${feed.running}`);
    check('an unfinished subagent stays visible as running',
      feed.subagents.find((x) => x.name === 'agent-one').running === true);
    check('a finished one carries its outcome',
      feed.subagents.find((x) => x.name === 'agent-two').ok === true);
    check('tool calls are counted', feed.toolCalls === 1, `toolCalls=${feed.toolCalls}`);
    check('the feed is newest-first', Date.parse(feed.entries[0].at) >= Date.parse(feed.entries[1].at));
    check('a summary rides along on /conversations, so no extra round-trip',
      (await get('/conversations')).conversations.find((c) => c.id === work).activity.running === 1);
    check('activity does NOT touch liveness — a tool call is not proof of work',
      (await stateOf(work)).lifecycle === 'never',
      (await stateOf(work)).lifecycle);

    // ---------------------------------------------------------------- replay
    console.log('\nrestarting the server (the real test: does any of it survive?)');
    await stop(proc);
    proc = boot(dir);
    await waitForBoot(proc);

    const afterStop = await stateOf(busy);
    check('*** a completed stop survives a restart ***', afterStop.lifecycle === 'stopped', afterStop.lifecycle);
    check('...with the requester intact', afterStop.stop.requestedBy === 'human');
    check('...and the acknowledgement intact',
      afterStop.stop.ack === 'stopped' && afterStop.stop.stoppedAt !== null);

    const afterOrphan = await stateOf(orphan);
    check('*** an UNacknowledged stop request survives a restart ***',
      afterOrphan.lifecycle === 'stop-requested' && afterOrphan.stop.ack === null,
      afterOrphan.lifecycle);
    check('...and is still flagged as unreadable by anyone',
      afterOrphan.stop.willNeverBeSeen === true);

    const afterGhost = await stateOf(ghost);
    check('*** an archived conversation STILL does not claim its agent stopped ***',
      afterGhost.lifecycle !== 'stopped' && afterGhost.stop.ack === null, afterGhost.lifecycle);
    check('the ghost is still counted on /status after a restart',
      (await get('/status?engines=0')).coordinators.ghosts >= 1);

    const afterFeed = await get(`/conversations/${work}/activity`);
    check('subagent lifecycle survives a restart', afterFeed.subagents.length === 2,
      `subagents=${afterFeed.subagents.length}`);
    check('...including which one is still running', afterFeed.running === 1, `running=${afterFeed.running}`);
    check('ephemeral tool calls are gone, as designed', afterFeed.toolCalls === 0,
      `toolCalls=${afterFeed.toolCalls}`);

    console.log('\nwithdrawing a request');
    const back = await newConv('changed my mind', 'coord-mind');
    await post(`/conversations/${back}`, { stopRequested: true });
    check('a request can be withdrawn',
      (await post(`/conversations/${back}`, { stopRequested: false })).status === 200);
    check('...and the badge goes back to a liveness verdict',
      (await stateOf(back)).lifecycle === 'never', await lifecycleOf(back));
    check('a non-boolean stopRequested is refused',
      (await post(`/conversations/${back}`, { stopRequested: 'yes' })).status === 400);
  } finally {
    await stop(proc);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* windows */ }
  }

  console.log(failures ? `\n${failures} FAILED\n` : '\nall checks passed\n');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error('FAIL —', err); process.exit(1); });
