#!/usr/bin/env node
'use strict';
/*
 * autoseat - seat a coordinator in a tab that has a human message and nobody in it.
 *
 * WHY THIS IS A HOST PROCESS AND NOT A CONTAINER.
 *
 * relay-queue is a passive queue: it records routing that something else
 * decides, and it deliberately never spawns anything. `relay-watchdog` already
 * finds unstaffed tabs correctly and says so - but it is a container, and so is
 * the server, and neither can start a Claude process. The thing that actually
 * dispatched coordinators was a Claude session seated as agent `Router` in
 * `main`, running a self-paced loop. Its own design note records the flaw:
 * "the router is a single point of failure and nothing restarts it but the
 * human." When it dies the watchdog reports `router unreachable, N tabs need
 * dispatch` into a channel nobody is reading, and the human has to ask for a
 * reseat by hand. That ask is what this file removes.
 *
 * So this is the last mile and nothing else: detection already worked, and the
 * remedy needs to run somewhere that can execute `claude`. That is the host.
 *
 * WHAT IT WILL NOT DO, AND WHY EACH GUARD EXISTS.
 *
 *   - It never seats a tab that has an agent WHO IS ACTUALLY THERE. `conv.agent`
 *     must be null, OR the server's own `agentState.seatUnwatched` must be true
 *     - re-read in the instant before the spawn either way, because the
 *     interesting race is a human or a router seating the tab while this
 *     process was deciding. `seatUnwatched` is the server noticing nobody is
 *     subscribed to that conversation's SSE stream, combined with a grace
 *     window and every other signal of life (heartbeat, lastActedAt,
 *     lastProgressAt) - see seatWatchInfo() in server.js. It exists because
 *     `conv.agent` alone cannot tell a live coordinator from one whose PROCESS
 *     exited while its name stayed on the seat ("FluxPrep": answered a few
 *     messages, finished, exited - and 12 messages queued for 9 minutes behind
 *     a seat that still read as staffed, because nothing ever unseated it).
 *
 *   - It never dispatches twice for the same human message. State is keyed on
 *     TASK ID and written BEFORE the spawn, so a crash mid-dispatch loses the
 *     coordinator, not the memory that one was already sent. This is
 *     repetition-bounding, not rate-limiting, and the distinction is the whole
 *     point: a rate limit bounds volume per window and then resets, so against
 *     a fault that does not clear it refires forever. This system has already
 *     been buried once by exactly that shape - 215 of 220 pending items were a
 *     watchdog nagging about its own dead agents. A cap of "one dispatch per
 *     thing the human actually said" cannot produce a backlog no matter how
 *     long the fault lasts, because the human only says a finite number of
 *     things.
 *
 *   - It never dispatches on anything but a human message. The test is
 *     `role === 'user' && HUMAN_ORIGINS.has(from)`, which is structural rather
 *     than a heuristic: agent posts carry `role: 'agent'`, the watchdog's own
 *     pokes carry `from: 'relay-watchdog'`, and checklist settles carry
 *     `from: 'checklist'`. None of those are in the allowlist, so none of them
 *     can dispatch. This is what stops the obvious infinite loop, where a
 *     dispatched agent's own writes look like new work and dispatch another.
 *
 *   - It never dispatches into a thread that was closed on purpose - archived,
 *     or `stopAck === 'stopped'`. Those are finished, not forgotten, and there
 *     is by definition nobody left in them to answer.
 *
 * The grace period is not politeness either: it is the window in which a human
 * who is already opening the tab gets to seat it himself without a race.
 *
 * ONE LONG-LIVED COORDINATOR PER TAB, AND AUTOSEAT IS ITS REVIVER (2026-09-17).
 *
 * Until this date every human message into an empty tab cold-started a
 * ONE-SHOT `claude -p <brief>`: it re-read COORDINATOR.md, rebuilt its context
 * from nothing, answered, released the seat and exited. The Nanoleaf tab was
 * seated 7 times in 67 minutes on 2026-09-02 that way, each seat paying the full
 * boot. The 2026-08-07 design had been the opposite - one coordinator per tab
 * that stayed - and on 08-08 a dedicated coordinator with its own watcher
 * answered in a 44s median against 1m27s for a router. It was abandoned for one
 * reason only: nothing revived a coordinator that died. This file is now that
 * reviver, so the long-lived shape comes back:
 *
 *   - The coordinator is `claude -p --input-format stream-json` with stdin held
 *     OPEN. Each later human message in its tab is written to stdin as a new
 *     user turn. Waiting costs zero tokens, and context plus prompt cache
 *     survive between messages.
 *   - AUTOSEAT HOLDS THE SSE WATCH, not the coordinator. A headless `-p`
 *     session cannot sit on a stream between turns, so without this the server
 *     would read a busy-but-quiet coordinator as dead (seatUnwatched). Autoseat
 *     subscribes to /events?conversation=<id> for exactly as long as that
 *     process lives, which makes `listeners > 0` a true statement again, and it
 *     doubles as the prompt-delivery path instead of waiting on the 10s poll.
 *   - The session id is chosen HERE (`--session-id <uuid>`) and persisted per
 *     tab with the pid BEFORE the spawn. A dead process, or a restarted
 *     autoseat, is revived with `--resume <sessionId>` on the next human
 *     message - falling back, logged, to a fresh session if resume fails.
 *   - The persisted record plus a pid-alive check is the per-tab dedupe. The
 *     old in-memory `inFlight` Set died with the process, and on 2026-09-17 an
 *     autoseat restart put a second coordinator into the Sporefall tab.
 *   - Idle coordinators are released after `--idle` minutes, and are the ones
 *     evicted (least recently active first, never one mid-turn) when the cap
 *     is reached. Their session id is kept, so eviction costs a resume, not a
 *     cold start.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');

const DEFAULT_QUEUE = 'http://127.0.0.1:3901';
const DEFAULT_STATE = path.join(os.homedir(), '.relay-autoseat', 'state.json');

/*
 * PROOF OF LIFE, written every completed poll.
 *
 * The supervisor (tools/autoseat-start.ps1) used to decide "is autoseat up?"
 * by asking whether a node.exe with autoseat.js in its command line exists.
 * That check cannot fail for a process that is running but no longer working,
 * which is the failure it most needs to catch.
 *
 * Nothing else here could stand in for it, which is the point:
 *
 *   - THE LOG CANNOT. `nothing to seat` is deliberately printed only when the
 *     text CHANGES (see the note at the quiet branch below), so a healthy
 *     autoseat with a steady queue writes nothing for hours by design. On
 *     2026-08-29 that produced a 16.7-hour silence that was investigated as a
 *     hang and was not one - the process was polling correctly the whole time,
 *     and settling that took TCP-socket forensics because no artifact on disk
 *     could tell "idle and fine" from "wedged". Log silence is not evidence.
 *
 *   - state.json CANNOT. It is written only when a coordinator is dispatched,
 *     so it is untouched for days at a time during normal operation.
 *
 * So the heartbeat is a separate file that means one specific thing: a poll
 * ran to completion this recently. It is deliberately NOT written at the top
 * of a tick. setInterval keeps firing even while an earlier tick is stuck
 * awaiting a hung fetch, so a heartbeat stamped on entry would keep reading
 * fresh while no poll ever finished - a green light for the exact fault it is
 * meant to expose. It is written when a tick RESOLVES, so a wedged fetch
 * starves it and the supervisor sees the staleness.
 */
const DEFAULT_HEARTBEAT = path.join(os.homedir(), '.relay-autoseat', 'heartbeat.json');

/*
 * WHAT EVERY SEAT CARRIES, WHATEVER FOLDER IT RUNS IN (folder scopes, 2026-09-19).
 *
 * A seat's cwd is its conversation's folder (see seatCwd), so the coordinator
 * protocol and the guard can no longer be found by being rooted in this repo.
 * They are handed to every spawn explicitly instead, both derived from where
 * this file lives rather than from any hardcoded checkout:
 *
 *   --settings=<REPO>/src/claude-config/settings.json
 *       relay's OWN settings and nothing else: the PreToolUse registration of
 *       the default-deny guard (src/claude-config/hooks/coordinator-guard.js).
 *       It layers on top of the folder's own .claude/settings.json, which loads
 *       normally and which relay never reads, writes or knows about.
 *   --add-dir=<REPO>
 *       makes <REPO>/.claude/skills/relay-coordinator discoverable.
 *
 * Both use the `--flag=value` form on purpose: both flags are variadic in the
 * claude CLI, and the spaced form swallows following positional arguments. The
 * prompt travels on stdin (stream-json) today, so nothing positional follows
 * them - the `=` form keeps that true if one ever does.
 *
 * verifySeatConfig() checks both at startup and autoseat REFUSES TO RUN if
 * either is wrong. A seat without the guard must be impossible, not unlikely:
 * a missing or unregistered guard fails silently, default-deny becoming
 * default-allow with no error anywhere.
 */
const REPO = path.resolve(__dirname, '..');
const SEAT_SETTINGS = path.join(REPO, 'src', 'claude-config', 'settings.json');
const SEAT_SKILL = path.join(REPO, '.claude', 'skills', 'relay-coordinator', 'SKILL.md');
const GUARD_NAME = 'coordinator-guard.js';

function seatArgs(cfg) {
  return [`--settings=${(cfg && cfg.seatSettings) || SEAT_SETTINGS}`, `--add-dir=${REPO}`];
}

/*
 * Returns a list of problems; empty means every seat will be guarded and will
 * find its protocol. `strict` additionally requires the executables the
 * registration names to exist: a hook whose command cannot run is a
 * NON-BLOCKING hook error, which fails open exactly like a missing one. The
 * checked-in registration names the LIVE checkout's absolute guard path, so
 * strict mode is for the real daemon; the selftest (which may run in a
 * worktree before that path exists) checks the rest.
 */
function verifySeatConfig(opts) {
  const strict = !!(opts && opts.strict);
  const file = (opts && opts.settings) || SEAT_SETTINGS;
  const problems = [];
  if (!fs.existsSync(SEAT_SKILL)) problems.push(`coordinator skill missing: ${SEAT_SKILL}`);
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    problems.push(`seat settings unreadable: ${file} (${e.message})`);
    return problems;
  }
  /*
   * A project's own .claude/settings(.local).json with `"disableAllHooks": true`
   * switches off EVERY hook, the --settings guard included - silently
   * (verified 2026-09-19). A scalar key takes the highest-precedence source,
   * and --settings outranks project and local, so relay's file must say
   * `false` explicitly. Without it the guard is off in exactly the folders
   * whose owners turned their own hooks off.
   */
  if (!settings || settings.disableAllHooks !== false) {
    problems.push(`${file} must set "disableAllHooks": false - otherwise a folder's own settings can switch the guard off`);
  }
  const pre = (settings && settings.hooks && settings.hooks.PreToolUse) || [];
  const guards = [];
  for (const m of Array.isArray(pre) ? pre : []) {
    if (!m || !/\bBash\b/.test(String(m.matcher || '')) || !/\bWrite\b/.test(String(m.matcher || ''))) continue;
    for (const h of Array.isArray(m.hooks) ? m.hooks : []) {
      const words = [String(h.command || ''), ...(Array.isArray(h.args) ? h.args.map(String) : [])];
      const script = words.find((w) => w.endsWith(GUARD_NAME));
      if (h.type === 'command' && script) guards.push({ command: String(h.command || ''), script });
    }
  }
  if (!guards.length) {
    problems.push(`${file} does not register ${GUARD_NAME} as a PreToolUse command hook matching Bash and Write`);
    return problems;
  }
  if (strict) {
    for (const g of guards) {
      if (!fs.existsSync(g.script)) problems.push(`the registered guard does not exist: ${g.script}`);
      if (g.command !== g.script && !fs.existsSync(g.command)) problems.push(`the registered hook command does not exist: ${g.command}`);
    }
  }
  return problems;
}

/*
 * A conversation's `path` is a folder relative to the home directory; '' (or
 * none) is home itself. The server normalizes it, and this checks again anyway:
 * a seat is a coordinator with hands, and where it stands is not something to
 * take on trust from a queue with no auth. Lexical containment only - a
 * symlink under home that points elsewhere is the owner's own arrangement.
 * Returns { cwd } or { error }.
 */
function seatCwd(home, relPath) {
  const base = path.resolve(home);
  const rel = relPath == null ? '' : String(relPath);
  if (rel.includes('\0')) return { error: 'the path contains a NUL byte' };
  const cwd = path.resolve(base, rel.replace(/^[\\/]+/, ''));
  if (cwd !== base && !cwd.startsWith(base + path.sep)) return { error: `the path resolves to ${cwd}, outside ${base}` };
  return { cwd };
}

/* A missing folder, or one that is not a directory, is not a place to seat. */
function folderProblem(cwd) {
  try {
    return fs.statSync(cwd).isDirectory() ? null : `${cwd} exists but is not a directory`;
  } catch (e) {
    return e.code === 'ENOENT' ? `${cwd} does not exist` : `${cwd} cannot be read (${e.code || e.message})`;
  }
}

/*
 * EVERY TAB STARTS IN ITS OWN GIT WORKTREE (owner, 2026-09-19).
 *
 * If a tab's folder is inside a git repo, its seat does not stand in that
 * checkout. It stands in a worktree made for the tab:
 *
 *   <home>/Worktrees/<repo>/<slug>   on branch <slug>
 *
 * <repo> is the basename of the MAIN working tree (a folder inside a linked
 * worktree resolves to its main repo, so worktrees never nest), <slug> is the
 * tab title in kebab-case. The seat cwd is that worktree plus the folder's
 * subpath inside the repo, so a tab at Projects/foo/sub runs in
 * Worktrees/foo/<slug>/sub. Two reasons: parallel tabs in one repo stop
 * trampling each other's working tree, and nobody's edits land in a checkout
 * that something else serves (relay's own live checkout IS its deployment).
 *
 * A worktree that already exists is brought up to date first: <origin/main>
 * (fetched) is MERGED into it - never rebase, never reset, never discard. A
 * dirty tree or a conflicting merge is left exactly as it was (the merge is
 * aborted) and the tab is still seated there, with a note in the tab.
 *
 * The chosen worktree and branch are stored in the tab record, so renaming the
 * tab does not move its seat. Nothing here may crash autoseat: every git call is
 * an argument array (no shell), bounded by a timeout, and non-interactive; any
 * failure to make a worktree seats the tab in the plain folder with a note.
 * Only run when a coordinator is (re)spawned, never per tick - and
 * asynchronously, so a slow fetch never freezes the SSE watches or tails.
 */
const GIT_TIMEOUT_MS = 30000;
const GIT_FETCH_TIMEOUT_MS = 60000;
const GIT_ADD_TIMEOUT_MS = 120000;
const GIT_MERGE_TIMEOUT_MS = 120000;
/* The operations that check files out run with the repo's own hooks off:
 * autoseat is preparing a seat, not doing the owner's git work, and a
 * post-checkout hook (or an LFS smudge, see GIT_ENV) can take any time at all. */
const NO_HOOKS = ['-c', 'core.hooksPath=/dev/null'];
const GIT_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o ConnectTimeout=10',
  GIT_MERGE_AUTOEDIT: 'no',
  GIT_LFS_SKIP_SMUDGE: '1',
  LC_ALL: 'C',
};

function git(cwd, args, timeout) {
  return new Promise((resolve) => {
    try {
      execFile('git', ['-C', cwd, ...args], {
        timeout: timeout || GIT_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024, windowsHide: true,
        env: { ...process.env, ...GIT_ENV },
      }, (err, stdout, stderr) => {
        const out = String(stdout || '').trim();
        const lastLine = (s) => String(s || '').trim().split('\n').filter(Boolean).pop() || '';
        const why = err ? (err.killed ? `timed out after ${(timeout || GIT_TIMEOUT_MS) / 1000}s` : (lastLine(stderr) || lastLine(stdout) || err.message)) : '';
        resolve({ ok: !err, out, err: why });
      });
    } catch (e) {
      resolve({ ok: false, out: '', err: e.message });
    }
  });
}

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 40).replace(/-+$/, '');
}

function parseWorktrees(out) {
  return String(out || '').split(/\n\s*\n/).map((block) => {
    const t = {};
    for (const line of block.split('\n')) {
      const sp = line.indexOf(' ');
      const k = sp < 0 ? line : line.slice(0, sp);
      const v = sp < 0 ? true : line.slice(sp + 1);
      if (k === 'worktree') t.path = v; else if (k === 'branch') t.branch = v; else if (k === 'bare') t.bare = true;
    }
    return t;
  }).filter((t) => t.path);
}

/*
 * folder: an existing directory under home. conv: { id, title }. rec: the
 * tab's stored record, if any. Returns
 *   { cwd, folder, repo, worktree, branch, base, created, note }
 * where worktree/branch/repo are null for a folder that is not in a repo.
 */
async function prepareSeatDir(home, folder, conv, rec) {
  const notes = [];
  const plain = (note) => ({
    cwd: folder, folder, repo: null, worktree: null, branch: null, base: null, created: false,
    note: [...notes, ...(note ? [note] : [])].join('; ') || null,
  });
  const inside = await git(folder, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || inside.out !== 'true') return plain();
  const prefix = (await git(folder, ['rev-parse', '--show-prefix'])).out.replace(/\/+$/, '');
  await git(folder, ['worktree', 'prune']);
  const listed = await git(folder, ['worktree', 'list', '--porcelain']);
  if (!listed.ok) return plain(`no worktree: git worktree list failed (${listed.err}); seated in the folder itself`);
  const trees = parseWorktrees(listed.out);
  const main = trees[0];
  if (!main || main.bare) return plain();
  const top = main.path;
  /* A repo AT or ABOVE home (a dotfiles repo in ~) would put every tab in a
   * worktree of it. Only a repo strictly under home is a project. */
  const homeAbs = path.resolve(home);
  if (!path.resolve(top).startsWith(homeAbs + path.sep)) return plain();

  const verify = async (ref) => (await git(top, ['rev-parse', '--verify', '-q', ref])).ok;
  const hasOrigin = (await git(top, ['remote'])).out.split('\n').includes('origin');
  let def = null;
  if (hasOrigin) {
    const h = await git(top, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
    if (h.ok && h.out.startsWith('origin/')) def = h.out.slice('origin/'.length);
  }
  if (!def) {
    for (const b of ['main', 'master']) {
      if (await verify(`refs/heads/${b}`) || (hasOrigin && await verify(`refs/remotes/origin/${b}`))) { def = b; break; }
    }
  }
  if (!def) def = 'main';
  if (hasOrigin) {
    const f = await git(top, ['fetch', 'origin', def], GIT_FETCH_TIMEOUT_MS);
    if (!f.ok) notes.push(`could not fetch origin/${def} (${f.err}), so the local copy was used`);
  }
  let base = null;
  if (hasOrigin && await verify(`refs/remotes/origin/${def}`)) base = `origin/${def}`;
  else if (await verify(`refs/heads/${def}`)) base = def;

  /* The stored choice wins, so a renamed tab keeps its seat. */
  /*
   * WHICH BRANCH. Only the tab's OWN record may pin an existing branch or
   * worktree. A name that merely matches is somebody else's: a tab titled
   * "folder scopes" under Projects/relay-queue must not adopt the owner's own
   * ~/Projects/relay-queue-folder-scopes and merge main into it. So an unpinned
   * tab takes the first of <slug>, <slug>-2, ... that has no branch, no
   * worktree and no directory yet - and a worktree outside
   * <home>/Worktrees/<repo>/ is never adopted, pinned or not.
   */
  const root = path.join(homeAbs, 'Worktrees', path.basename(top));
  const under = (p) => path.resolve(p).startsWith(root + path.sep);
  const treeOf = (b) => trees.find((t) => t.branch === `refs/heads/${b}`);
  let branch = null;
  let preferred = null;
  if (rec && rec.repo === top && rec.branch) {
    const pinnedTree = treeOf(rec.branch);
    if (pinnedTree === main) return plain(`branch ${rec.branch} is checked out in the main working tree ${top}; seated in the folder itself, no worktree`);
    if (!pinnedTree || under(pinnedTree.path)) { branch = rec.branch; preferred = rec.worktree || null; }
    else notes.push(`this tab's branch ${rec.branch} is now checked out at ${pinnedTree.path}, outside ${root}, so it was not adopted`);
  }
  if (!branch) {
    let stem = slugify(conv.title) || slugify(conv.id) || 'tab';
    if (new Set([def, 'main', 'master', 'head']).has(stem)) stem = `tab-${stem}`;
    if (!(await git(top, ['check-ref-format', '--branch', stem])).ok) stem = `tab-${slugify(conv.id) || 'x'}`;
    for (let n = 1; !branch; n++) {
      if (n > 50) return plain(`no worktree: ${stem} and 49 numbered alternatives are all taken; seated in the folder itself`);
      const cand = n === 1 ? stem : `${stem}-${n}`;
      if (treeOf(cand) || await verify(`refs/heads/${cand}`) || fs.existsSync(path.join(root, cand))) continue;
      branch = cand;
    }
  }

  const tree = treeOf(branch);
  let wt;
  let created = null;
  if (tree) {
    wt = tree.path; /* pinned and under root, checked above */
  } else {
    const wanted = preferred && under(preferred) ? preferred : path.join(root, branch);
    let dir = wanted;
    /* Something already there that is not this branch's worktree is never
     * clobbered: take the next free numbered name instead. */
    for (let n = 2; fs.existsSync(dir); n++) {
      if (n > 50) return plain(`no worktree: ${wanted} and 49 numbered alternatives are all taken; seated in the folder itself`);
      dir = `${wanted}-${n}`;
    }
    try { fs.mkdirSync(path.dirname(dir), { recursive: true }); } catch (e) {
      return plain(`could not create ${path.dirname(dir)} (${e.message}); seated in the folder itself`);
    }
    const hasBranch = await verify(`refs/heads/${branch}`);
    let add;
    if (hasBranch) add = await git(top, [...NO_HOOKS, 'worktree', 'add', dir, branch], GIT_ADD_TIMEOUT_MS);
    else if (base) add = await git(top, [...NO_HOOKS, 'worktree', 'add', '-b', branch, dir, base], GIT_ADD_TIMEOUT_MS);
    else return plain(`no worktree: found no ${def} branch to start one from; seated in the folder itself`);
    if (!add.ok) {
      const left = fs.existsSync(dir) ? ` (it left ${dir} behind; check \`git worktree list\` before removing it)` : '';
      return plain(`could not create a worktree at ${dir} (${add.err})${left}; seated in the folder itself`);
    }
    wt = dir;
    created = hasBranch ? 'existing-branch' : 'new-branch';
  }

  /* Bring it up to date - unless it was branched from base a moment ago. */
  if (created !== 'new-branch' && base) {
    const st = await git(wt, ['status', '--porcelain', '--untracked-files=no']);
    if (!st.ok) {
      notes.push(`could not read its status (${st.err}), so ${base} was NOT merged in`);
    } else if (st.out) {
      notes.push(`it has uncommitted changes, so ${base} was NOT merged into ${branch}; it is as it was`);
    } else {
      const lock = (await git(wt, ['rev-parse', '--path-format=absolute', '--git-path', 'index.lock'])).out;
      if (lock && fs.existsSync(lock)) {
        notes.push(`${lock} exists (another git running, or one that died), so ${base} was NOT merged in`);
      } else {
        const m = await git(wt, [...NO_HOOKS, 'merge', '--no-edit', base], GIT_MERGE_TIMEOUT_MS);
        if (!m.ok) {
          if ((await git(wt, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).ok) await git(wt, ['merge', '--abort']);
          /* A lock the killed merge left is reported, never deleted blindly:
           * something else may legitimately hold it by now. */
          const stale = lock && fs.existsSync(lock) ? `; it left ${lock} behind - remove it once no git is running there` : '';
          notes.push(`merging ${base} into ${branch} failed (${m.err}); aborted, the worktree is as it was${stale}`);
        }
      }
    }
  }

  let cwd = prefix ? path.join(wt, prefix) : wt;
  if (!fs.existsSync(cwd)) {
    try {
      fs.mkdirSync(cwd, { recursive: true });
      notes.push(`${prefix} is not on ${branch}, so it was created empty in the worktree`);
    } catch (e) {
      notes.push(`${prefix} is not on ${branch} and could not be created (${e.message}); seated at the worktree top`);
      cwd = wt;
    }
  }
  return { cwd, folder, repo: top, worktree: wt, branch, base, created: !!created, note: notes.join('; ') || null };
}

/*
 * The human's own clients - the surfaces HE posts from, and nothing else.
 *
 * THIS IS AN ALLOWLIST ON PURPOSE. KEEP IT ONE. The loop-safety property of
 * this whole file rests on it: a dispatched coordinator, the watchdog, and a
 * checklist settle cannot name themselves onto a list they are not on, so a
 * dispatch feeding on agent writes is impossible rather than merely unlikely.
 * A blocklist ("anything that is not a known agent") or a heuristic would
 * invert that - the default would become "dispatch", and every posting surface
 * nobody remembered to exclude would become a loop. server.js makes exactly
 * this argument about PAGE_ORIGINS, and records a surface slipping through it
 * once already.
 *
 * It was a single string, `'web'`, and that was a bug with teeth: he talks to
 * relay by VOICE at least as often as by keyboard, and those posts arrive as
 * `voice` (dictation through the ordinary send path) and `voice-conversation`
 * (the two-way voice mode). Neither matched, so an empty tab holding a spoken
 * message was a silent black hole - no coordinator, no error, and nothing to
 * alarm on, because refusing on `from` is not a failure. One of his messages
 * sat unanswered for 23 minutes that way.
 *
 * Adding them costs nothing structurally, because they are human-origin: no
 * agent emits them. `checklist` is deliberately absent even though it is a page
 * origin too - a ticked box is not an instruction, and the server's own
 * PAGE_ORIGINS set is therefore NOT the right list to borrow here.
 *
 * ADDING A UI SURFACE HE CAN SPEAK OR TYPE FROM? ADD IT HERE, IN THE SAME
 * COMMIT. The failure is silent in the safe direction: he gets ignored.
 */
const HUMAN_ORIGINS = new Set(['web', 'voice', 'voice-conversation']);

/* How long a dispatch record is kept. Long enough that a message from last week
 * cannot be re-dispatched by a restart; short enough that the file stays small. */
const STATE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// --------------------------------------------------------------- pure core

/*
 * The whole decision, as a function of data. Separated from the IO so it can be
 * driven by fixtures - including fixtures that SHOULD be refused, which is the
 * only way to know the refusals are real and not merely untested.
 *
 * Returns every task considered and why, not just the winners. A selector that
 * only reports what it accepted cannot be audited: "it picked nothing" and "it
 * looked at nothing" produce identical output.
 */
/*
 * `coordinators` is every coordinator PROCESS this autoseat knows to be alive,
 * keyed by conversation id: { agent, pid, attached, busy, closing, lastActiveAt }.
 *
 *   attached  we hold its stdin, so a new message can be handed to it as a turn.
 *             A survivor adopted from an earlier autoseat is alive but NOT
 *             attached - its stdin pipe died with its parent, so it is finishing
 *             its last turn and will exit by itself.
 *   busy      a turn has been written and its `result` has not come back.
 *   closing   stdin has been closed on purpose (idle, evicted, seat taken); it
 *             is on its way out and no longer counts against the cap.
 *
 * `records` is state.json's per-tab memory ({ agent, sessionId, pid }) for tabs
 * whose process is NOT alive - what makes a revive a resume rather than a cold
 * start, and what lets autoseat recognise its own dead coordinator's name still
 * sitting on a seat.
 *
 * Returns `deliveries` alongside `chosen`: a message in a tab whose coordinator
 * is live does not need a seat, it needs a turn.
 */
function selectSeats(opts) {
  const tasks = opts.tasks || [];
  const conversations = opts.conversations || [];
  const dispatched = opts.dispatched || new Set();
  const coordinators = opts.coordinators || new Map();
  const records = opts.records || {};
  const ignore = opts.ignore || new Set();
  /* cid -> why: tabs whose folder is missing, already reported in the tab.
   * Refused here rather than after choosing, so a tab that cannot be seated
   * never holds one of this pass's cap slots against a tab that can. */
  const unseatable = opts.unseatable || new Map();
  const now = opts.now;
  const graceMs = opts.graceMs;
  const maxConcurrent = opts.maxConcurrent == null ? 3 : opts.maxConcurrent;

  const byId = new Map(conversations.map((c) => [c.id, c]));
  const chosen = [];
  const deliveries = [];
  const considered = [];
  const takenThisPass = new Set();
  const evicting = new Set();
  /* A closing coordinator is leaving on its own; counting it would make the
   * cap refuse the very tab its departure was meant to make room for. */
  const occupied = () => [...coordinators.values()].filter((c) => !c.closing).length - evicting.size;

  /* Oldest first. If the cap bites, the message that has waited longest is the
   * one that gets answered - the opposite order would starve exactly the tab
   * the human is most annoyed about. */
  const ordered = tasks.slice().sort((a, b) => Date.parse(a.ts || 0) - Date.parse(b.ts || 0));

  for (const t of ordered) {
    const cid = t.conversationId || 'main';
    const conv = byId.get(cid);
    const row = { taskId: t.id, conversationId: cid, title: (conv && conv.title) || cid };
    const no = (why, code) => { row.seat = false; row.why = why; row.code = code || 'other'; considered.push(row); };

    if (dispatched.has(t.id)) { no('a coordinator was already dispatched for this message'); continue; }
    if (t.role !== 'user') { no(`role is ${JSON.stringify(t.role)}, so this is not the human speaking`); continue; }
    if (!HUMAN_ORIGINS.has(t.from)) { no(`from is ${JSON.stringify(t.from)}, not a human client; he posts from ${[...HUMAN_ORIGINS].join(', ')}`); continue; }
    if (ignore.has(cid)) { no('conversation is on the ignore list'); continue; }
    if (!conv) { no('conversation is not in the conversation list'); continue; }
    if (conv.archived) { no('conversation is archived, which IS the answer'); continue; }
    if (conv.stopAck === 'stopped') { no('conversation was deliberately stopped'); continue; }
    if (unseatable.has(cid)) { no(unseatable.get(cid), 'folder'); continue; }
    /*
     * SEAT-UNWATCHED: the server's own answer to "is anyone actually reading
     * this conversation's SSE stream right now", combined server-side with a
     * grace window and every other signal of life (see seatWatchInfo() /
     * evidenceOfLifeMs() in server.js). `conv.agent` being non-null no longer
     * refuses on its own — that was exactly the "FluxPrep" gap: a coordinator's
     * process exited, its name stayed on the seat, and this exact check kept
     * refusing forever because it only ever looked at the name.
     *
     * Deliberately trusting the server's verdict rather than recomputing it
     * from raw fields here: it already folds in heartbeat/lastActedAt/
     * lastProgressAt/listener-count with the right grace window, and duplicating
     * that logic client-side is how the two drift apart. This also costs
     * nothing extra to check — `agentState` already rides on the same
     * GET /conversations poll this file was already making.
     */
    const unwatched = !!(conv.agentState && conv.agentState.seatUnwatched);

    /*
     * A LIVE COORDINATOR ALREADY OWNS THIS TAB. The message becomes its next
     * turn: no second seat, no grace window (the grace exists so a human can
     * seat the tab himself, and it is already seated by ours), and no cap slot
     * (the slot is already spent). Busy means the message waits for the turn
     * in progress to end - writing a second turn into a running one would make
     * "mid-turn" unknowable here, and eviction depends on knowing it.
     */
    const coord = coordinators.get(cid);
    if (coord && coord.attached && !coord.closing) {
      if (conv.agent && conv.agent !== coord.agent && !unwatched) {
        no(`the seat was taken by ${conv.agent} from our live ${coord.agent}`, 'seat-taken');
        continue;
      }
      if (coord.busy) { no(`${coord.agent} (pid ${coord.pid}) is mid-turn; this is its next turn`, 'busy'); continue; }
      row.seat = false;
      row.deliver = true;
      row.code = 'deliver';
      row.agent = coord.agent;
      row.why = `${coord.agent} (pid ${coord.pid}) is live and idle in this tab; delivered as its next turn`;
      considered.push(row);
      deliveries.push(row);
      continue;
    }
    /*
     * THE PERSISTED DEDUPE. Alive but not attached (a survivor of an earlier
     * autoseat, finishing its last turn) or closing: its process still holds
     * the tab, so seating now is the double coordinator. It exits on its own;
     * the next tick after that resumes its session.
     */
    if (coord) {
      no(`${coord.agent} (pid ${coord.pid}) still holds this tab and is finishing its last turn`, 'in-flight');
      continue;
    }

    /*
     * OUR OWN DEAD COORDINATOR'S NAME IS NOT AN OCCUPANT. The record says this
     * name is ours and no process of ours is alive behind it, which is a
     * stronger answer than seatUnwatched can give, and a faster one: the
     * server needs 2 minutes of silence to say it, this file knows at once.
     */
    const rec = records[cid];
    const ownDeadSeat = !!(conv.agent && rec && rec.agent === conv.agent);
    if (conv.agent && !unwatched && !ownDeadSeat) { no(`the seat is filled by ${conv.agent}`); continue; }

    const ageMs = now - Date.parse(t.ts);
    if (!(ageMs >= graceMs)) {
      no(`only ${Math.round(ageMs / 1000)}s old; grace is ${Math.round(graceMs / 1000)}s`);
      continue;
    }
    if (takenThisPass.has(cid)) { no('another message in this same tab was already chosen this pass'); continue; }
    /*
     * THE CAP, WITH EVICTION. At the cap, the least recently active IDLE
     * coordinator in some other tab is closed to make room - it costs that tab
     * a resume later, not an answer now. Never one mid-turn: killing a turn
     * loses an answer he is already waiting on. If every slot is mid-turn, the
     * message waits, exactly as before, and the tick logs SATURATED.
     */
    if (occupied() + chosen.length >= maxConcurrent) {
      const victim = [...coordinators.entries()]
        .filter(([id, c]) => id !== cid && c.attached && !c.busy && !c.closing && !evicting.has(id))
        .sort((a, b) => (a[1].lastActiveAt || 0) - (b[1].lastActiveAt || 0))[0];
      if (!victim) { no(`at the concurrency cap of ${maxConcurrent}, every coordinator mid-turn`, 'cap'); continue; }
      evicting.add(victim[0]);
      row.evict = victim[0];
      row.evictAgent = victim[1].agent;
    }

    takenThisPass.add(cid);
    row.seat = true;
    row.staleSeat = (unwatched || ownDeadSeat) ? conv.agent : null;
    row.resumeSessionId = rec && rec.sessionId ? rec.sessionId : null;
    row.why = ownDeadSeat
      ? `our own ${conv.agent} still sits on the seat but its process is gone, while a message waited ${Math.round(ageMs / 1000)}s`
      : unwatched
        ? `${conv.agent} is seated but unwatched ${conv.agentState.unwatchedForSec}s (no live SSE subscriber) `
          + `while a message waited ${Math.round(ageMs / 1000)}s`
        : `human message waiting ${Math.round(ageMs / 1000)}s in an empty seat`;
    if (row.evict) row.why += `; evicting idle ${row.evictAgent} to make room`;
    row.ageSec = Math.round(ageMs / 1000);
    considered.push(row);
    chosen.push(row);
  }
  return { chosen, deliveries, considered };
}

/*
 * Every pending human message ALREADY in the tab we are about to seat.
 *
 * All of them are recorded as dispatched, not just the one that triggered it,
 * because one coordinator answers the whole tab. Without this, a tab holding
 * three unanswered messages would be a standing order for three coordinators -
 * the live-coordinator guard hides it while that process lives, and its exit
 * would uncover it as two more turns nobody needs.
 */
function coveredBy(tasks, conversationId) {
  return tasks
    .filter((t) => (t.conversationId || 'main') === conversationId
      && t.role === 'user' && HUMAN_ORIGINS.has(t.from))
    .map((t) => t.id);
}

/* A name a human can read in the tab list and match to a log file. */
function agentName(title, conversationId) {
  const slug = String(title || '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 18)
    .replace(/-+$/, '');
  return `auto-${slug || conversationId.slice(0, 8)}-${conversationId.slice(-4)}`;
}

// ------------------------------------------------------------------ brief

function brief(o) {
  return [
    `You are the coordinator for relay tab "${o.title}", conversationId \`${o.conversationId}\`.`,
    `Relay is at ${o.queue}. Your name is \`${o.agent}\` - use it everywhere.`,
    '',
    'You were dispatched AUTOMATICALLY because a message arrived in this tab and nobody was seated in it.',
    'The human did not ask for you by hand and is not watching a terminal. The tab is your only channel.',
    '',
    'YOU ARE LONG-LIVED. You are this tab\'s coordinator for as long as the tab is active, not for one message.',
    'Your process stays up between messages. When a new message arrives in this tab, autoseat hands it to you',
    'as a NEW USER TURN in this same session - treat every later user turn as new messages arriving in the tab.',
    'Waiting between turns costs nothing, and you keep everything you have already read.',
    'Autoseat holds the SSE watch on this tab for you, so do NOT arm a Monitor, an SSE watcher, a poll loop or',
    'a sleep to wait for messages. Ending your turn IS how you wait.',
    '',
    ...(o.cwd ? [
      `Your working directory is \`${o.cwd}\`: the folder this tab is scoped to. Work there.`,
      ...(o.worktree ? [`It is inside this tab's own git worktree \`${o.worktree}\` on branch \`${o.branch}\`, made for this tab.`,
        'Changes for this tab belong on that branch. Never merge it into the default branch yourself - that is the human\'s call.'] : []),
      `The relay-queue repo \`${REPO}\` is loaded alongside (--add-dir) only so the relay-coordinator skill is available.`,
      '',
    ] : []),
    `FIRST, read \`${path.join(REPO, 'COORDINATOR.md')}\`. It is the mechanical reference for this API`,
    'and it documents several traps that fail silently. Then, in this order:',
    '',
    `1. Take the seat ONCE: POST /conversations/${o.conversationId} with {"agent":"${o.agent}"}. Keep that same`,
    '   name for the life of the tab. If that returns 409, someone else took it while you were starting - say',
    '   nothing more and END YOUR TURN. Do not race.',
    '2. Post an ack into the tab straight away: POST /messages with',
    `   {"conversationId":"${o.conversationId}","agent":"${o.agent}","text":"..."}.`,
    '   A silent agent is indistinguishable from a dead one.',
    `3. GET /tasks?conversation=${o.conversationId}&status=pending and answer each one:`,
    `   claim with {"by":"${o.agent}"} - the field is \`by\`, NOT \`agent\`, and getting it wrong`,
    '   returns 200 while claiming for nobody - then do the work, then',
    `   POST /tasks/<id>/result {"result":"...","by":"${o.agent}"}, then POST /tasks/<id>/relayed.`,
    '   Post the RESULT on the task, not just a message. A message alone leaves the task open.',
    `4. Before concluding the tab is clear, also check GET /checklist?conversation=${o.conversationId}`,
    `   and GET /checklists?conversation=${o.conversationId}. A tab with no pending task can still`,
    '   have real outstanding work sitting in a checklist.',
    '5. When the messages in hand are answered, END YOUR TURN. Do NOT release the seat and do NOT exit:',
    '   autoseat keeps you seated while you are alive, releases the seat itself when it retires you after',
    '   an idle spell, and resumes this same session when the tab gets a message after that.',
    '',
    'On every LATER turn: confirm you still hold the seat (GET /conversations/<id>; if `agent` is not your',
    'name, take it back with the same POST as step 1 - on 409 end the turn), then repeat steps 2-4 for the',
    'new messages, then end the turn.',
    '',
    'Rules:',
    `- Work ONLY conversation ${o.conversationId}. Claiming a task in another conversation silently`,
    '  steals another agent message - the queue accepts one result per task.',
    '- Every message you post is read on a phone by someone with ADHD. SHORT, bulleted, bold-keyed.',
    '  Lead with the answer, never with the investigation.',
    '- PURE ASCII in any JSON body. An em-dash makes the POST fail outright.',
    '- Build bodies with a heredoc and `curl --data-binary @-`, never `-d` with a shell-quoted string.',
    '  A Windows path or an apostrophe inside a `-d` body kills the request with no output and exit 0.',
    '- Keep posting progress while you work. Work longer than ~10 minutes with no result or progress',
    '  note and relay treats you as dead. Re-claiming does not reset that clock.',
    '- Do NOT speak aloud, and do not send push notifications.',
    '- Do NOT archive, share or publish any conversation. Sharing is the decision of the human, from the UI.',
    '- If the work needs a decision only the human can make, ask ONE short question, then END YOUR TURN and',
    '  wait. His answer arrives as a later user turn.',
    '- If you conclude the message needs no action, say so in the tab, close the task, end your turn.',
    '- Never release the seat, exit, or stop yourself. Autoseat owns your lifecycle.',
  ].join('\n');
}

/*
 * The text of one delivered turn. The message bodies ride along so a turn can
 * start answering without a round-trip, but the coordinator is still told to
 * re-read pending: the bodies are a snapshot, and claiming is what makes an
 * answer count. Deliberately repeats the seat check and "end the turn, do not
 * release" on every turn - a resumed session may have lost the seat while no
 * process was holding it, and the one-shot habit of releasing at the end is
 * exactly the behavior this design must not regress to.
 */
const TURN_TEXT_MAX = 4000;
function turnText(o) {
  const lines = [
    `[autoseat] ${o.messages.length} new message(s) from the human in tab "${o.title}" (conversationId \`${o.conversationId}\`).`,
  ];
  for (const m of o.messages) {
    const body = String(m.instruction == null ? '' : m.instruction);
    lines.push(`- task ${m.id} (from ${m.from}, ${m.ts}):`);
    lines.push(body.length > TURN_TEXT_MAX ? `${body.slice(0, TURN_TEXT_MAX)} [...truncated; read the task]` : body);
  }
  lines.push('');
  lines.push(`Handle them now under your standing instructions as \`${o.agent}\`: confirm you still hold the seat`
    + ` (retake it with the same name if not; on 409 end the turn), ack, claim with "by", answer, POST the result,`
    + ` mark relayed. Re-check GET /tasks?conversation=${o.conversationId}&status=pending first - more may be waiting.`);
  lines.push('Then END YOUR TURN. Do not release the seat and do not exit - autoseat does both.');
  return lines.join('\n');
}

// --------------------------------------------------------------------- io

/*
 * EVERY POLL IS BOUNDED. `fetch` has no default overall timeout - undici's
 * headers/body timeouts are 300s each, so a relay that accepts a connection
 * and then goes quiet parks a tick for five minutes, and a proxy or a
 * half-open socket can park it far longer. setInterval keeps firing behind it,
 * so the visible symptom is not an error but an autoseat that is alive,
 * responding, and quietly doing nothing.
 *
 * 8s is chosen against the observed workload, not by feel: both routes are
 * local (127.0.0.1) reads that normally answer in single-digit milliseconds,
 * so 8s is ~1000x the expected cost - it cannot fire on a slow-but-working
 * relay, and it converts an indefinite hang into an ordinary handled error
 * that the next tick retries 10s later.
 *
 * This is belt AND braces with the heartbeat, deliberately. The timeout stops
 * the most likely hang from happening; the heartbeat catches the hangs nobody
 * predicted. Neither replaces the other - a timeout only bounds the waits it
 * was wrapped around, and the failure worth guarding is the one not thought of.
 */
const FETCH_TIMEOUT_MS = 8000;

async function getJson(base, route) {
  const r = await fetch(base + route, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`GET ${route} -> ${r.status}`);
  return r.json();
}

function loadState(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const out = {};
    const cutoff = Date.now() - STATE_TTL_MS;
    for (const [k, v] of Object.entries(raw.dispatched || {})) {
      if (Date.parse(v && v.at) >= cutoff) out[k] = v;
    }
    /* Per-tab coordinator memory: { agent, sessionId, pid, title, lastActiveAt }.
     * Same TTL as the message memory - a session untouched for a month is not
     * worth resuming, and keeping it would only grow the file. */
    const tabs = {};
    for (const [k, v] of Object.entries(raw.tabs || {})) {
      if (v && v.sessionId && Date.parse(v.lastActiveAt || v.startedAt) >= cutoff) tabs[k] = v;
    }
    /* Missing-folder reports already posted, { [cid]: { path, cwd, at } }.
     * Persisted so an autoseat restart does not post the same complaint into
     * the tab again. */
    const missing = {};
    for (const [k, v] of Object.entries(raw.missing || {})) {
      if (v && Date.parse(v.at) >= cutoff) missing[k] = v;
    }
    return { dispatched: out, tabs, missing };
  } catch {
    return { dispatched: {}, tabs: {}, missing: {} };
  }
}

/*
 * IS THIS PID STILL OUR COORDINATOR? `kill -0` alone answers "is some process
 * using this number", and pids are recycled - a record surviving a reboot
 * would otherwise hold a tab hostage to whatever unrelated process inherited
 * the number. The session id is on the coordinator's own command line
 * (`--session-id` or `--resume`), so /proc/<pid>/cmdline proves identity, not
 * just occupancy. Where /proc cannot be read, fall back to kill -0: refusing
 * to seat for one extra tick is the safe direction; a double seat is not.
 */
function pidAlive(pid, sessionId) {
  if (!pid) return false;
  try { process.kill(pid, 0); } catch (e) { if (e.code !== 'EPERM') return false; }
  let cmd;
  try { cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'); } catch { return true; }
  /* A zombie has an empty cmdline: exited, not yet reaped. Not alive. */
  if (!cmd) return false;
  return sessionId ? cmd.includes(sessionId) : true;
}

/*
 * Written with a temp file and a rename, because the failure this file guards
 * against is a crash - and a state file torn in half by the very crash it is
 * meant to survive would let every message in it dispatch a second time.
 */
function saveState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
  fs.renameSync(tmp, file);
}

/*
 * Same tmp-and-rename as saveState, for the same reason: the supervisor reads
 * this file on a timer, and a half-written one would parse as "no heartbeat",
 * which is the restart signal. A torn read must never be able to order a kill.
 *
 * The pid is part of the record, not decoration. Without it a `--once` run
 * (mine, a selftest's, anyone debugging by hand) would refresh the file and
 * vouch for a daemon that had actually died - so the supervisor cross-checks
 * that the heartbeat was written by a process that is still alive. `--once`
 * does not write one at all, which closes the same hole from the other side.
 */
function writeHeartbeat(file, outcome) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({
      pid: process.pid,
      ts: new Date().toISOString(),
      outcome: outcome || 'ok',
    }, null, 1));
    fs.renameSync(tmp, file);
  } catch {
    /* A heartbeat that cannot be written must not take the dispatcher down
     * with it. The supervisor will read it as stale and restart, which is a
     * survivable outcome; throwing here would turn a full disk into a dead
     * dispatcher, which is not. */
  }
}

function stamp() { return new Date().toISOString().replace('T', ' ').slice(0, 19); }

// -------------------------------------------------------------------- run

async function postJson(base, route, body) {
  const r = await fetch(base + route, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`POST ${route} -> ${r.status}`);
  return r.json().catch(() => ({}));
}

const delay = (ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); if (t.unref) t.unref(); });

/*
 * THE CLOCKS OF A LONG-LIVED COORDINATOR, each chosen against a named cost.
 *
 *   TAIL_MS            how often a coordinator's stream-json log is read. Its
 *                      `result` event is the only way to know a turn ended, and
 *                      "ended" is what makes a message deliverable and a
 *                      coordinator evictable. Half a second is invisible next to
 *                      a turn that takes tens of seconds, and a stat per tick.
 *   WATCH_STALE_MS     the server pings every 25s (SSE_PING_MS). 70s with no
 *                      byte is almost three missed pings: a half-open socket,
 *                      not a quiet tab. Without this the watch can look held
 *                      while the server counts zero listeners.
 *   WATCH_RETRY_MS     a relay restart drops every stream on purpose; 2s is the
 *                      same reconnect cadence SKILL.md tells coordinators to use.
 *   POKE_DEBOUNCE_MS   one human message produces several SSE frames (create,
 *                      then the coordinator's own claim/progress/result). One
 *                      tick per burst is enough.
 *   CLOSE_GRACE_MS     an IDLE coordinator whose stdin was closed exits in about
 *                      a second. One still there after 60s is wedged, and it is
 *                      idle by construction, so SIGTERM costs no answer.
 *   MAX_ATTEMPTS       a message whose coordinator died mid-turn is handed out
 *                      once more (by resume). Twice is the bound: a message that
 *                      reliably kills its coordinator must not respawn forever -
 *                      the same repetition-bounding argument as the header.
 */
const TAIL_MS = 500;
const WATCH_STALE_MS = 70000;
const WATCH_RETRY_MS = 2000;
const POKE_DEBOUNCE_MS = 1000;
const CLOSE_GRACE_MS = 60000;
const PID_POLL_MS = 5000;
const SHUTDOWN_WAIT_MS = 8000;
const MAX_ATTEMPTS = 2;

function createRuntime(cfg, log) {
  return {
    cfg,
    log,
    state: loadState(cfg.stateFile),
    coords: new Map(),
    lastOutcome: 'starting',
    lastQuiet: null,
    ticking: false,
    again: false,
    pokeTimer: null,
    pokeFn: null,
    stopping: false,
  };
}

function save(runtime) { saveState(runtime.cfg.stateFile, runtime.state); }

/* The shape selectSeats() reads - data only, no handles. */
function coordView(runtime) {
  return new Map([...runtime.coords].map(([cid, c]) => [cid, {
    agent: c.agent, pid: c.pid, attached: c.attached, busy: c.busy, closing: c.closing, lastActiveAt: c.lastActiveAt,
  }]));
}

/* Remembered tabs with no live process behind them: the resumable ones. */
function deadRecords(runtime) {
  const out = {};
  for (const [cid, rec] of Object.entries(runtime.state.tabs)) if (!runtime.coords.has(cid)) out[cid] = rec;
  return out;
}

function poke(runtime) {
  if (!runtime.pokeFn || runtime.pokeTimer || runtime.stopping) return;
  runtime.pokeTimer = setTimeout(() => { runtime.pokeTimer = null; runtime.pokeFn(); }, POKE_DEBOUNCE_MS);
}

/*
 * Recorded BEFORE the turn is written, for the same reason a dispatch is: a
 * crash in between loses a turn (visible, bounded), never repeats one forever.
 * `attempts` survives a requeue so MAX_ATTEMPTS can bound it.
 */
function recordDelivered(runtime, messages, cid, agent) {
  const at = new Date().toISOString();
  for (const m of messages) {
    const prev = runtime.state.dispatched[m.id];
    runtime.state.dispatched[m.id] = { at, conversationId: cid, agent, attempts: ((prev && prev.attempts) || 0) + 1 };
  }
}

function writeTurn(coord, text, messages) {
  coord.busy = true;
  coord.turnStartedAt = Date.now();
  coord.lastActiveAt = Date.now();
  coord.lastTurn = { messages };
  try {
    coord.child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`);
  } catch { /* the exit handler reports a dead pipe; nothing useful to add here */ }
}

/*
 * AUTOSEAT SPEAKING IN A TAB. Used only for what the human must know and no
 * coordinator can tell him - its folder is missing, or which worktree it runs
 * in. POST /messages stores it `role: 'agent'`, so it can never dispatch
 * anything (see HUMAN_ORIGINS). Returns whether it landed; callers remember
 * what they said only when it did, so a relay outage retries instead of
 * silently dropping it.
 */
async function tellTab(runtime, cid, text) {
  try {
    await postJson(runtime.cfg.queue, '/messages', { conversationId: cid, agent: 'autoseat', from: 'autoseat', text });
    return true;
  } catch (e) {
    runtime.log(`TELL FAILED (${cid}): ${e.message}`);
    return false;
  }
}

/*
 * Says where a freshly placed seat stands: always when a worktree was just
 * made for the tab, and otherwise only a note that differs from the last one
 * posted in this tab (a fetch that keeps failing is said once, not on every
 * revive). A clean, fast update says nothing.
 */
async function reportSeatDir(runtime, cid, title, prep) {
  const rec = runtime.state.tabs[cid];
  const note = prep.note || null;
  let text = null;
  if (prep.created) {
    text = `[autoseat] This tab works in its own git worktree: \`${prep.worktree}\` on branch \`${prep.branch}\``
      + `${prep.base ? `, from ${prep.base}` : ''}. The folder you filed it under is untouched.${note ? ` Note: ${note}.` : ''}`;
  } else if (note && (!rec || rec.seatNote !== note)) {
    text = `[autoseat] ${prep.worktree ? `Worktree \`${prep.worktree}\`: ` : ''}${note}.`;
  }
  if (!note && rec && rec.seatNote) { rec.seatNote = null; save(runtime); }
  if (!text) return;
  if (await tellTab(runtime, cid, text)) {
    runtime.log(`TOLD ${title} (${cid}): ${text}`);
    if (rec) { rec.seatNote = note; save(runtime); }
  }
}

async function releaseIfOurs(runtime, cid, agent, reason) {
  const { cfg, log } = runtime;
  try {
    const live = await getJson(cfg.queue, `/conversations/${cid}`);
    if (live.agent !== agent) return false;
    await postJson(cfg.queue, `/conversations/${cid}`, { agent: null, agentLeftReason: reason });
    log(`RELEASED ${agent} from ${live.title || cid} (${cid}): ${reason}`);
    return true;
  } catch (e) {
    log(`RELEASE FAILED ${agent} (${cid}): ${e.message}`);
    return false;
  }
}

/*
 * THE COORDINATOR'S OUTPUT GOES TO A FILE, AND AUTOSEAT TAILS THE FILE.
 *
 * Piping stdout back into this process would be simpler and wrong: when
 * autoseat restarts (deploy, supervisor kill, crash), a pipe's read end dies
 * with it, and the coordinator's next write mid-turn is EPIPE - the turn the
 * human is waiting on dies because the DISPATCHER restarted. A file has no
 * reader to lose. stdin is still a pipe, deliberately: its EOF when autoseat
 * dies is exactly the signal that makes a coordinator finish the turn in
 * progress and exit, instead of idling forever with nobody able to feed it.
 */
function readTail(runtime, coord) {
  let fd;
  try { fd = fs.openSync(coord.logFile, 'r'); } catch { return; }
  try {
    const size = fs.fstatSync(fd).size;
    if (size <= coord.offset) return;
    const buf = Buffer.alloc(size - coord.offset);
    fs.readSync(fd, buf, 0, buf.length, coord.offset);
    /* Consume whole lines only, so a multi-byte character or a JSON event
     * split across two reads is never parsed in halves. */
    const end = buf.lastIndexOf(0x0a);
    if (end < 0) return;
    coord.offset += end + 1;
    for (const line of buf.subarray(0, end).toString('utf8').split('\n')) {
      if (!line.startsWith('{')) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      onEvent(runtime, coord, e);
    }
  } finally {
    fs.closeSync(fd);
  }
}

function onEvent(runtime, coord, e) {
  const { log } = runtime;
  if (e.type === 'system' && e.subtype === 'init' && !coord.sawInit) {
    coord.sawInit = true;
    if (e.session_id && e.session_id !== coord.sessionId) {
      log(`SESSION ${coord.agent} pid ${coord.pid} reports session ${e.session_id}, expected ${coord.sessionId}; recording the reported one`);
      coord.sessionId = e.session_id;
      const rec = runtime.state.tabs[coord.cid];
      if (rec) { rec.sessionId = e.session_id; save(runtime); }
    }
    return;
  }
  if (e.type !== 'result') return;
  coord.busy = false;
  coord.turns++;
  if (!e.is_error) coord.okTurns++;
  coord.lastActiveAt = Date.now();
  const rec = runtime.state.tabs[coord.cid];
  if (rec) { rec.lastActiveAt = new Date().toISOString(); save(runtime); }
  const secs = coord.turnStartedAt ? Math.round((Date.now() - coord.turnStartedAt) / 1000) : '?';
  log(`TURN DONE ${coord.agent} pid ${coord.pid} turn #${coord.turns} ${e.subtype || ''}${e.is_error ? ' ERROR' : ''} `
    + `in ${secs}s, session ${e.session_id || coord.sessionId} (${coord.cid})`);
  poke(runtime);
}

/*
 * AUTOSEAT HOLDS THE WATCH. One scoped SSE subscription per live coordinator,
 * reconnecting, for exactly as long as that process lives. Two jobs:
 *
 *   - It is what the server counts. seatWatchInfo() calls a seat unwatched when
 *     work is pending and nobody is subscribed; a headless coordinator mid-way
 *     through a long quiet turn subscribes to nothing, so without this it reads
 *     as dead and gets a second coordinator seated on top of it. Held here, the
 *     count is true: listener present iff process alive.
 *   - It is the doorbell. Any frame on the tab pokes a tick, so a new message
 *     becomes a turn in about a second instead of on the next 10s poll. The
 *     frame's content is NOT trusted to decide anything - the tick re-reads
 *     /tasks and applies the same human-origin allowlist, so an agent,
 *     watchdog or checklist frame costs one idle tick and can never be a turn.
 */
function startWatch(runtime, coord) {
  const { cfg, log } = runtime;
  const w = { stop: false, ctl: null, connected: false, everConnected: false, lostLogged: false };
  coord.watch = w;
  (async () => {
    while (!w.stop) {
      w.ctl = new AbortController();
      let lastByte = Date.now();
      const stale = setInterval(() => { if (Date.now() - lastByte > WATCH_STALE_MS) w.ctl.abort(new Error('no bytes for 70s')); }, 5000);
      if (stale.unref) stale.unref();
      try {
        const r = await fetch(`${cfg.queue}/events?conversation=${encodeURIComponent(coord.cid)}`, {
          headers: { accept: 'text/event-stream' }, signal: w.ctl.signal,
        });
        if (!r.ok) throw new Error(`GET /events -> ${r.status}`);
        if (w.lostLogged) log(`WATCH restored for ${coord.agent} (${coord.cid})`);
        w.connected = true; w.everConnected = true; w.lostLogged = false;
        const dec = new TextDecoder();
        let buf = '';
        for await (const chunk of r.body) {
          lastByte = Date.now();
          buf += dec.decode(chunk, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, i);
            buf = buf.slice(i + 2);
            if (/^data:/m.test(frame)) poke(runtime);
          }
        }
        throw new Error('stream ended');
      } catch (e) {
        if (w.stop) break;
        /* Logged on the transition only; a relay outage must not write a line
         * every 2 seconds for every coordinator. */
        if (!w.lostLogged) { log(`WATCH lost for ${coord.agent} (${coord.cid}): ${e.message}; reconnecting every ${WATCH_RETRY_MS / 1000}s`); w.lostLogged = true; }
        w.connected = false;
      } finally {
        clearInterval(stale);
      }
      if (!w.stop) await delay(WATCH_RETRY_MS);
    }
  })();
}

function stopWatch(coord) {
  if (!coord.watch) return;
  coord.watch.stop = true;
  try { if (coord.watch.ctl) coord.watch.ctl.abort(); } catch { /* already closed */ }
}

function spawnCoordinator(runtime, o) {
  const { cfg, log } = runtime;
  const cid = o.conversationId;
  const resume = !!o.resumeSessionId;
  const sessionId = o.resumeSessionId || crypto.randomUUID();
  const nowIso = new Date().toISOString();
  /* Never a default: a seat with no folder decided for it is refused, not
   * rooted wherever this process happens to be. */
  if (!o.cwd) { log(`DISPATCH REFUSED ${o.agent} -> ${cid}: no seat folder was resolved`); return null; }

  /*
   * RECORD BEFORE SPAWNING. If this process dies between the write and the
   * spawn, the outcome is a message nobody was sent to answer - which the
   * watchdog already alarms on. If it were the other way round, the outcome
   * would be a message that dispatches a coordinator on every restart,
   * forever. The first failure is visible and bounded; the second is the
   * backlog this system has already drowned in once.
   *
   * The tab record (session id first, pid right after the spawn) is the other
   * half of that write: it is what the next autoseat reads to know a process
   * of ours still holds this tab, and which session to resume when none does.
   */
  /* `cwd` is stored so a later revive can tell whether the tab's folder moved
   * since this session started; a moved tab gets a fresh session there. */
  runtime.state.tabs[cid] = {
    ...(runtime.state.tabs[cid] || {}),
    agent: o.agent, sessionId, title: o.title, cwd: o.cwd, pid: null, startedAt: nowIso, lastActiveAt: nowIso,
  };
  /* Where the seat came from. `folder` is what a move is detected against
   * every tick; repo/worktree/branch pin the tab's worktree across renames.
   * Only a fresh placement writes them - the resume-failed respawn keeps the
   * record's. */
  if (o.folder !== undefined) runtime.state.tabs[cid].folder = o.folder;
  /* The pin is only ever REPLACED by a real worktree. A placement that fell
   * back to the plain folder (a failed fetch, a git timeout) leaves it alone,
   * so the tab returns to the same worktree and branch once git recovers
   * instead of being handed <slug>-2. */
  if (o.worktree) {
    Object.assign(runtime.state.tabs[cid], { repo: o.repo, worktree: o.worktree, branch: o.branch });
  }
  if (!o.skipRecord) recordDelivered(runtime, o.messages, cid, o.agent);
  save(runtime);

  fs.mkdirSync(cfg.logDir, { recursive: true });
  const logFile = path.join(cfg.logDir, `${o.agent}-${nowIso.replace(/[:.]/g, '-')}.log`);
  const fd = fs.openSync(logFile, 'a');
  const offset = fs.fstatSync(fd).size;

  /* The guard and the skill ride on every spawn - see SEAT_SETTINGS. There is
   * no argument list without them. */
  const args = [...seatArgs(cfg), '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];
  if (resume) args.push('--resume', sessionId); else args.push('--session-id', sessionId);
  if (cfg.model) args.push('--model', cfg.model);

  let child;
  try {
    /*
     * detached: its own process group, so a signal aimed at autoseat's group
     * (a Ctrl-C, a supervisor teardown) does not kill a turn in progress. It
     * still cannot outlive autoseat by more than one turn - see shutdown().
     */
    child = spawn(cfg.claude, args, { cwd: o.cwd, stdio: ['pipe', fd, fd], detached: true, windowsHide: true });
  } catch (e) {
    fs.closeSync(fd);
    log(`DISPATCH FAILED ${o.agent} -> ${o.conversationId}: ${e.message}`);
    return null;
  }
  fs.closeSync(fd); /* the child holds its own copy */

  const coord = {
    cid, agent: o.agent, title: o.title, cwd: o.cwd, folder: o.folder || runtime.state.tabs[cid].folder || null, sessionId, child, pid: child.pid,
    attached: true, busy: false, closing: null, lastActiveAt: Date.now(),
    logFile, offset, resumed: resume, sawInit: false, turns: 0, okTurns: 0, lastTurn: null,
  };
  runtime.state.tabs[cid].pid = child.pid;
  save(runtime);
  runtime.coords.set(cid, coord);

  child.stdin.on('error', () => { /* EPIPE after the child died; the exit handler reports it */ });
  child.on('exit', (code, signal) => { onExit(runtime, coord, code, signal); });
  child.on('error', (e) => {
    log(`DISPATCH ERROR ${o.agent}: ${e.message}`);
    onExit(runtime, coord, null, null);
  });

  coord.tailTimer = setInterval(() => readTail(runtime, coord), TAIL_MS);
  startWatch(runtime, coord);

  log(`DISPATCH ${o.agent} -> ${o.title} (${cid}) pid ${child.pid} session ${sessionId} `
    + `${resume ? 'RESUMED' : 'fresh'}, covering ${o.messages.length} message(s), cwd ${o.cwd}, log ${path.basename(logFile)}`);

  const turn = turnText({ ...o, conversationId: cid });
  writeTurn(coord, resume ? turn : `${brief({ ...o, queue: cfg.queue })}\n\n---\n\n${turn}`, o.messages);
  return coord;
}

function deliverTurn(runtime, coord, messages) {
  recordDelivered(runtime, messages, coord.cid, coord.agent);
  save(runtime);
  writeTurn(coord, turnText({ conversationId: coord.cid, title: coord.title, agent: coord.agent, messages }), messages);
  runtime.log(`TURN ${coord.agent} pid ${coord.pid} <- ${coord.title} (${coord.cid}) covering ${messages.length} message(s), `
    + `turn #${coord.turns + 1} of session ${coord.sessionId}`);
}

function closeCoordinator(runtime, coord, kind, detail) {
  coord.closing = kind;
  runtime.log(`CLOSING ${coord.agent} pid ${coord.pid} (${coord.cid}): ${detail}; stdin closed, session ${coord.sessionId} kept for resume`);
  try { coord.child.stdin.end(); } catch { /* already gone */ }
  coord.killTimer = setTimeout(() => {
    if (coord.exited) return;
    runtime.log(`KILL ${coord.agent} pid ${coord.pid}: still running ${CLOSE_GRACE_MS / 1000}s after stdin closed while idle`);
    try { coord.child.kill('SIGTERM'); } catch { /* gone */ }
  }, CLOSE_GRACE_MS);
  if (coord.killTimer.unref) coord.killTimer.unref();
}

const LEFT_REASONS = {
  idle: 'autoseat: idle, retired; session kept for resume',
  evicted: 'autoseat: idle, evicted to free a slot; session kept for resume',
  shutdown: 'autoseat: stopping; session kept for resume',
  moved: 'autoseat: the tab moved to another folder; the next message starts a fresh session there',
};

async function onExit(runtime, coord, code, signal) {
  if (coord.exited) return;
  coord.exited = true;
  const { log } = runtime;
  clearInterval(coord.tailTimer);
  clearInterval(coord.pidTimer);
  clearTimeout(coord.killTimer);
  if (coord.logFile) readTail(runtime, coord);
  stopWatch(coord);
  if (runtime.coords.get(coord.cid) === coord) runtime.coords.delete(coord.cid);

  const how = signal ? `signal=${signal}` : `exit=${code}`;
  const rec = runtime.state.tabs[coord.cid];
  if (rec && rec.sessionId === coord.sessionId) { rec.pid = null; rec.lastExitAt = new Date().toISOString(); }
  log(`FINISHED ${coord.agent} pid ${coord.pid} ${how} after ${coord.turns} turn(s)`
    + `${coord.closing ? ` (${coord.closing})` : ''}, session ${coord.sessionId} kept (${coord.cid})`);

  /*
   * RESUME FELL THROUGH. A resumed process that never finished a turn cleanly
   * did not get its session back (deleted transcript, a different project
   * dir, a CLI that no longer knows the id: "No conversation found with
   * session ID"). The message still needs answering, so start a FRESH session
   * and hand it the same messages - once. A fresh session is not a resume, so
   * this cannot recurse.
   */
  if (coord.resumed && coord.okTurns === 0 && !coord.closing && !runtime.stopping && coord.lastTurn) {
    let why = how;
    try {
      const m = /No conversation found[^\n"]*/.exec(fs.readFileSync(coord.logFile, 'utf8').slice(-20000));
      if (m) why = m[0];
    } catch { /* keep `how` */ }
    log(`RESUME FAILED ${coord.agent} session ${coord.sessionId} (${why}); starting a FRESH session for ${coord.title} (${coord.cid})`);
    save(runtime);
    spawnCoordinator(runtime, {
      conversationId: coord.cid, title: coord.title, agent: coord.agent, cwd: coord.cwd,
      messages: coord.lastTurn.messages, resumeSessionId: null, skipRecord: true,
    });
    coord.finalized = true;
    return;
  }

  /*
   * DIED MID-TURN (killed, crashed, OOM). The messages of that turn were
   * recorded as delivered, and left that way they would never be answered.
   * Mark them for one more delivery; the tick re-checks they are still
   * pending, so anything the coordinator did finish is not repeated.
   */
  if (coord.busy && coord.lastTurn && !runtime.stopping) {
    const again = coord.lastTurn.messages
      .filter((m) => runtime.state.dispatched[m.id] && runtime.state.dispatched[m.id].attempts < MAX_ATTEMPTS);
    for (const m of again) runtime.state.dispatched[m.id].requeue = true;
    if (again.length) log(`REQUEUE ${again.length} message(s) from ${coord.agent}, which died mid-turn; next delivery resumes session ${coord.sessionId}`);
  }
  save(runtime);

  if (coord.closing !== 'seat-taken') {
    await releaseIfOurs(runtime, coord.cid, coord.agent,
      LEFT_REASONS[coord.closing] || `autoseat: coordinator process ended (${how}); session kept for resume`);
  }
  coord.finalized = true;
  poke(runtime);
}

/*
 * SURVIVORS OF AN EARLIER AUTOSEAT. A record whose pid is still our
 * coordinator (identity-checked, see pidAlive) is a process that lost its
 * stdin when the previous autoseat died: it is finishing its last turn and
 * will exit by itself. Seating the tab now is the Sporefall double seat, so it
 * is adopted instead - counted, watched (so the server keeps seeing a
 * listener), polled until it exits, and its seat released after. A record
 * whose pid is gone gets its seat released now, so the tab reads honestly
 * empty rather than falsely staffed; the session id stays for resume.
 */
async function adoptSurvivors(runtime) {
  const { log } = runtime;
  let changed = false;
  for (const [cid, rec] of Object.entries(runtime.state.tabs)) {
    if (!rec.pid) continue;
    if (pidAlive(rec.pid, rec.sessionId)) {
      const coord = {
        cid, agent: rec.agent, title: rec.title || cid, sessionId: rec.sessionId, child: null, pid: rec.pid,
        attached: false, busy: true, closing: null, lastActiveAt: Date.parse(rec.lastActiveAt) || Date.now(),
        adopted: true, turns: 0, okTurns: 0, lastTurn: null,
      };
      runtime.coords.set(cid, coord);
      startWatch(runtime, coord);
      coord.pidTimer = setInterval(() => {
        if (!pidAlive(coord.pid, coord.sessionId)) onExit(runtime, coord, null, null);
      }, PID_POLL_MS);
      log(`ADOPTED ${rec.agent} pid ${rec.pid} session ${rec.sessionId} (${cid}): alive from an earlier autoseat, `
        + 'finishing its last turn; this tab gets no second coordinator until it exits');
    } else {
      rec.pid = null;
      changed = true;
      await releaseIfOurs(runtime, cid, rec.agent, 'autoseat: coordinator process gone after an autoseat restart; session kept for resume');
    }
  }
  if (changed) save(runtime);
}

async function tick(cfg, runtime) {
  const log = runtime.log;
  /* A stopping autoseat must never seat anything: a debounced poke armed just
   * before SIGTERM would otherwise dispatch a coordinator that nobody will
   * ever feed. Found by the lifecycle selftest, not by reasoning. */
  if (runtime.stopping) return;
  let tasks; let convs;
  try {
    tasks = (await getJson(cfg.queue, '/tasks?status=pending')).tasks || [];
    convs = (await getJson(cfg.queue, '/conversations?archived=1')).conversations || [];
  } catch (e) {
    log(`queue unreachable: ${e.message}`);
    /*
     * This still counts as a completed poll. autoseat asked, got a definite
     * answer, and reported it - the loop is turning and the code is working.
     * Withholding the heartbeat here would make a relay outage look like an
     * autoseat wedge and restart this process every 5 minutes for as long as
     * relay stayed down, which cannot fix relay and would destroy the run
     * history that a relay outage most needs. The outcome is recorded so the
     * distinction is legible in the file itself.
     */
    runtime.lastOutcome = `queue unreachable: ${e.message}`;
    return;
  }
  const convById = new Map(convs.map((c) => [c.id, c]));

  /*
   * RETIRE BEFORE DECIDING. An idle coordinator past --idle is closed here,
   * and one whose seat somebody else now holds is closed too (never released:
   * the seat is not ours any more). Both only ever touch IDLE coordinators - a
   * turn in progress is never cut short by housekeeping.
   */
  for (const coord of [...runtime.coords.values()]) {
    if (!coord.attached || coord.busy || coord.closing || cfg.dry) continue;
    const conv = convById.get(coord.cid);
    if (conv && coord.turns > 0 && conv.agent && conv.agent !== coord.agent) {
      closeCoordinator(runtime, coord, 'seat-taken', `the seat now belongs to ${conv.agent}`);
    } else if (conv && (conv.archived || conv.stopAck === 'stopped')) {
      closeCoordinator(runtime, coord, 'idle', 'the tab was archived or stopped');
    } else if (conv && coord.folder && seatCwd(cfg.home, conv.path).cwd !== coord.folder) {
      /* The tab was moved to another folder. This process stands in the old
       * one, so it is retired; the next message seats a FRESH session in the
       * new folder (see the resume decision below). */
      closeCoordinator(runtime, coord, 'moved', `the tab moved to /${conv.path || ''}, away from ${coord.folder}`);
    } else if (Date.now() - coord.lastActiveAt >= cfg.idleMs) {
      closeCoordinator(runtime, coord, 'idle', `idle ${Math.round((Date.now() - coord.lastActiveAt) / 60000)}m (limit ${cfg.idleMs / 60000}m)`);
    }
  }

  /*
   * TABS WHOSE FOLDER IS MISSING AND ALREADY SAID SO. Still missing under the
   * same path: refused quietly, every tick, until the folder appears or the
   * tab moves. Resolved either way: the memory is dropped, so the waiting
   * message is seated on this very tick and a later loss is reported afresh.
   */
  const unseatable = new Map();
  for (const [cid, r] of Object.entries(runtime.state.missing)) {
    const conv = convById.get(cid);
    const target = conv ? seatCwd(cfg.home, conv.path) : null;
    const problem = target && (target.error || folderProblem(target.cwd));
    if (conv && problem && String(conv.path || '') === r.path) {
      unseatable.set(cid, `its folder is unusable (${problem}); already reported in the tab`);
    } else if (conv) {
      delete runtime.state.missing[cid];
      save(runtime);
    }
  }

  const { chosen, deliveries, considered } = selectSeats({
    unseatable,
    tasks,
    conversations: convs,
    dispatched: new Set(Object.entries(runtime.state.dispatched).filter(([, v]) => !(v && v.requeue)).map(([k]) => k)),
    coordinators: coordView(runtime),
    records: deadRecords(runtime),
    ignore: cfg.ignore,
    now: Date.now(),
    graceMs: cfg.graceMs,
    maxConcurrent: cfg.maxConcurrent,
  });

  if (cfg.explain) {
    for (const row of considered) {
      const tag = row.seat ? 'SEAT  ' : row.deliver ? 'TURN  ' : 'skip  ';
      log(`${tag}${row.title} (${row.conversationId}) task ${row.taskId}: ${row.why}`);
    }
    if (!considered.length) log('nothing pending to consider');
  }

  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const byConv = new Map();
  for (const row of deliveries) {
    if (!byConv.has(row.conversationId)) byConv.set(row.conversationId, []);
    byConv.get(row.conversationId).push(taskById.get(row.taskId));
  }
  for (const [cid, messages] of byConv) {
    const coord = runtime.coords.get(cid);
    if (!coord || !coord.attached || coord.busy || coord.closing) continue;
    if (cfg.dry) { log(`DRY-RUN would hand ${messages.length} message(s) to ${coord.agent} as a turn (${cid})`); continue; }
    deliverTurn(runtime, coord, messages);
  }

  if (!chosen.length) {
    /*
     * Say "nothing to seat" only when that is NEWS.
     *
     * This runs every few seconds forever, so an unconditional line here is
     * ~8600 entries a day saying nothing happened, and the one line that
     * mattered is buried in them. That is the same failure this whole file is
     * built to avoid, just aimed at a log file instead of his phone: volume
     * that makes a real signal unfindable. Repeating only on CHANGE keeps the
     * log a record of events rather than of time passing.
     */
    /*
     * SATURATION IS NOT IDLENESS, AND SAYING SO COST ~14 MINUTES ON 2026-09-02.
     *
     * `nothing to seat` used to be printed for both "no message was eligible"
     * and "eligible messages exist and the concurrency cap refused every one
     * of them" - a starved tab and an empty queue produced byte-identical
     * output. Meanwhile relay-watchdog, which can only infer this process's
     * health from whether tabs get staffed, was correctly alarming
     * `AUTOSEAT IS NOT SEATING` and reporting `autoseat still down` about a
     * process that was up, beating, and deliberately refusing. Two observers
     * disagreeing about a dispatcher is worse than either one being wrong.
     *
     * The cap itself is working as designed. What was broken was that its
     * decision was invisible in the only log anyone reads.
     */
    const blocked = considered.filter((r) => r.code === 'cap');
    const live = [...runtime.coords.values()].map((c) => `${c.agent}${c.busy ? '*' : ''}`);
    const quiet = blocked.length
      ? `SATURATED - ${blocked.length} eligible message(s) refused; `
        + `${runtime.coords.size}/${cfg.maxConcurrent} coordinators live, all mid-turn `
        + `[${live.join(', ')}]. Nothing is wrong with autoseat; it has no free slot.`
      : `nothing to seat (${considered.length} pending message(s) considered, ${runtime.coords.size} coordinator(s) live)`;
    if (!cfg.explain && quiet !== runtime.lastQuiet) { log(quiet); runtime.lastQuiet = quiet; }
    runtime.lastOutcome = blocked.length
      ? `saturated, ${blocked.length} waiting on ${runtime.coords.size}/${cfg.maxConcurrent} slots`
      : `idle, ${considered.length} considered, ${runtime.coords.size} live${deliveries.length ? `, ${byConv.size} turn(s) delivered` : ''}`;
    return;
  }
  runtime.lastQuiet = null;

  let seated = 0;
  for (const pick of chosen) {
    if (runtime.stopping) return;
    /*
     * RE-READ THE SEAT. The list above is a snapshot, and the gap between
     * reading it and acting on it is exactly where a human or a router seats
     * the tab. Two agents in one tab is the worst outcome this file can
     * produce, so it is checked twice against live state rather than once.
     */
    let live;
    try {
      live = await getJson(cfg.queue, `/conversations/${pick.conversationId}`);
    } catch (e) {
      log(`SKIP ${pick.conversationId}: could not re-read the seat (${e.message})`);
      continue;
    }
    /*
     * The re-read must ask the SAME question selectSeats() did, not just
     * "is agent non-null" — otherwise every seat-unwatched pick would be
     * skipped here unconditionally, since live.agent is expected to be
     * non-null on exactly that path. Recomputed fresh from this GET rather
     * than trusted from `pick`, because a NEW occupant sitting down in the
     * gap (even one seated to genuinely watch it) immediately resets the
     * server's own clock via agentSince, so seatUnwatched already reads false
     * for them without any special-casing here.
     */
    const rec = runtime.state.tabs[pick.conversationId];
    const liveUnwatched = !!(live.agentState && live.agentState.seatUnwatched);
    const liveOwnDead = !!(live.agent && rec && rec.agent === live.agent && !runtime.coords.has(pick.conversationId));
    if (runtime.coords.has(pick.conversationId)) { log(`SKIP ${pick.conversationId}: a coordinator of ours appeared while we were deciding`); continue; }
    if (live.agent && !liveUnwatched && !liveOwnDead) { log(`SKIP ${pick.conversationId}: ${live.agent} took the seat while we were deciding`); continue; }
    if (live.archived || live.stopAck === 'stopped') { log(`SKIP ${pick.conversationId}: closed while we were deciding`); continue; }

    /*
     * WHERE THE SEAT STANDS: the conversation's folder under home, read from
     * this same live record. A folder that is missing (or a path that escapes
     * home) is refused outright - NEVER a fallback to another cwd, because a
     * coordinator standing in the wrong project is worse than none. The tab is
     * told once per path (persisted), and the message waits until the folder
     * exists or the tab moves.
     */
    const livePath = String(live.path || '');
    const target = seatCwd(cfg.home, livePath);
    const folderIssue = target.error || folderProblem(target.cwd);
    if (folderIssue) {
      const seen = runtime.state.missing[pick.conversationId];
      if (seen && seen.path === livePath) continue;
      if (cfg.dry) { log(`DRY-RUN would report an unusable folder for ${pick.title} (${pick.conversationId}): ${folderIssue}`); continue; }
      const text = `[autoseat] No coordinator was started in this tab: its folder \`~/${livePath}\` is unusable - `
        + `${folderIssue}. Nothing runs anywhere else instead. Create the folder, or move this conversation to one that `
        + 'exists; the waiting message is picked up automatically once it resolves.';
      if (await tellTab(runtime, pick.conversationId, text)) {
        runtime.state.missing[pick.conversationId] = { path: livePath, cwd: target.cwd || null, at: new Date().toISOString() };
        save(runtime);
        log(`FOLDER MISSING ${pick.title} (${pick.conversationId}): ${folderIssue}; told the tab, not seating`);
      } else {
        log(`FOLDER MISSING ${pick.title} (${pick.conversationId}): ${folderIssue}; could not tell the tab, will retry`);
      }
      continue;
    }
    /* The same name for the life of the tab: a resumed coordinator keeps the
     * name its own transcript already uses everywhere. */
    const title = live.title || pick.title;
    const agent = rec && rec.agent ? rec.agent : agentName(title, pick.conversationId);
    const coveredIds = new Set(coveredBy(tasks, pick.conversationId));
    const messages = tasks.filter((t) => coveredIds.has(t.id));

    if (cfg.dry) {
      log(`DRY-RUN would dispatch ${agent} into ${pick.title} (${pick.conversationId}) from folder ${target.cwd}, covering ${messages.length} message(s)`
        + `${pick.resumeSessionId ? `, resuming ${pick.resumeSessionId} if its cwd is unchanged` : ''}${pick.evict ? `, evicting ${pick.evictAgent}` : ''}`);
      continue;
    }

    /* The tab's own worktree, when its folder is in a git repo (see
     * prepareSeatDir). Only here, on a (re)spawn - never per tick. */
    let prep;
    try {
      prep = await prepareSeatDir(cfg.home, target.cwd, { id: pick.conversationId, title }, rec);
    } catch (e) {
      prep = { cwd: target.cwd, folder: target.cwd, repo: null, worktree: null, branch: null, base: null, created: false,
        note: `worktree preparation failed (${e.message}); seated in the folder itself` };
    }
    if (runtime.stopping) return;
    /* Git can take a while; ask the seat question once more before acting. */
    if (runtime.coords.has(pick.conversationId)) { log(`SKIP ${pick.conversationId}: a coordinator of ours appeared while preparing its folder`); continue; }
    try {
      const again = await getJson(cfg.queue, `/conversations/${pick.conversationId}`);
      const againUnwatched = !!(again.agentState && again.agentState.seatUnwatched);
      const againOwnDead = !!(again.agent && rec && rec.agent === again.agent);
      if (again.agent && !againUnwatched && !againOwnDead) { log(`SKIP ${pick.conversationId}: ${again.agent} took the seat while its folder was prepared`); continue; }
      if (again.archived || again.stopAck === 'stopped') { log(`SKIP ${pick.conversationId}: closed while its folder was prepared`); continue; }
    } catch (e) {
      log(`SKIP ${pick.conversationId}: could not re-read the seat after preparing its folder (${e.message})`);
      continue;
    }
    const cwd = prep.cwd;

    /*
     * RESUME ONLY WHERE THE SESSION WAS BORN. A tab moved to another folder
     * since its session started gets a fresh session: the old transcript is
     * about another project, and its early reads were of files that are not
     * here. Compared on the tab's LOGICAL place (`folder`, the conversation's
     * folder), not the resolved cwd: a worktree that fails once and falls
     * back to the plain folder - or recovers - is the same tab in the same
     * project, and must not cost it its context. A record with no stored
     * folder predates folder scopes (it ran in the relay repo); it is resumed
     * - --resume works from any cwd, and keeping the tab's context across the
     * deploy is worth more than a clean start - and gets its folder recorded,
     * so from now on a move is detectable.
     */
    let resumeSessionId = pick.resumeSessionId;
    if (resumeSessionId && rec && rec.folder && rec.folder !== target.cwd) {
      log(`MOVED ${pick.title} (${pick.conversationId}): session ${resumeSessionId} belongs to ${rec.folder}, the tab is now ${target.cwd}; starting FRESH`);
      resumeSessionId = null;
    }

    if (pick.evict) {
      const victim = runtime.coords.get(pick.evict);
      if (!victim || !victim.attached || victim.busy || victim.closing) {
        log(`SKIP ${pick.conversationId}: the idle coordinator chosen for eviction is no longer idle`);
        continue;
      }
      /* The victim is idle, so it exits within a second of EOF. Spawning
       * before it has gone means one tick of cap+1 processes, of which one is
       * idle and leaving - cheaper than a whole extra poll of waiting. */
      closeCoordinator(runtime, victim, 'evicted',
        `least recently active idle coordinator (${Math.round((Date.now() - victim.lastActiveAt) / 1000)}s), evicted at the cap to seat ${title}`);
    }

    const coord = spawnCoordinator(runtime, {
      conversationId: pick.conversationId, title, agent, messages, resumeSessionId, cwd,
      folder: prep.folder, repo: prep.repo, worktree: prep.worktree, branch: prep.branch,
    });
    if (coord) seated++;
    await reportSeatDir(runtime, pick.conversationId, title, prep);
  }
  runtime.lastOutcome = `seated ${seated} of ${chosen.length} chosen, ${runtime.coords.size} live`;
}

/*
 * GRACEFUL SHUTDOWN - WHAT HAPPENS TO THE COORDINATORS WHEN AUTOSEAT STOPS.
 *
 * Two bad options bracket the choice. Killing them kills a turn in progress,
 * and that turn is an answer the human is already waiting on. Leaving them
 * running with nobody feeding stdin would park a process on a seat forever.
 *
 * The chosen shape costs nothing extra because of how stdin works: every
 * coordinator's stdin is closed. An IDLE one reads EOF and exits at once, and
 * its seat is released here before autoseat exits (bounded by
 * SHUTDOWN_WAIT_MS). A coordinator MID-TURN also reads EOF, but only after its
 * current turn: Claude finishes the turn, writes its result to its own log
 * file (a file, so no broken pipe - see readTail), and exits. So nothing is
 * orphaned for longer than one turn. The same holds if autoseat dies without
 * this handler (SIGKILL, crash): the pipe closes all the same.
 *
 * Whoever starts next - the flock'd supervisor restarts autoseat in 5s - finds
 * that still-finishing process through state.json and pidAlive(), adopts it
 * instead of seating a second coordinator, and releases its seat after it
 * exits. The session id stays, so the tab's next message resumes it.
 */
function serialTicker(cfg, runtime, beat) {
  /* A caller arriving mid-tick gets the promise of the run that will include
   * its request, so `await safeTick()` always means "a tick has seen the
   * world as of now" - not "a tick was already going, good luck". */
  const safeTick = () => {
    if (runtime.ticking) { runtime.again = true; return runtime.tickPromise; }
    runtime.ticking = true;
    runtime.tickPromise = (async () => {
      try {
        do {
          runtime.again = false;
          await tick(cfg, runtime).then(beat, (e) => runtime.log(`tick failed: ${e.message}`));
        } while (runtime.again && !runtime.stopping);
      } finally {
        runtime.ticking = false;
      }
    })();
    return runtime.tickPromise;
  };
  runtime.pokeFn = safeTick;
  return safeTick;
}

async function shutdown(runtime, sig, opts) {
  if (runtime.stopping) return;
  runtime.stopping = true;
  clearTimeout(runtime.pokeTimer);
  const { log } = runtime;
  const mine = [...runtime.coords.values()].filter((c) => c.attached);
  const idle = mine.filter((c) => !c.busy && !c.closing);
  const busy = mine.filter((c) => c.busy);
  log(`${sig}: closing stdin on ${mine.length} coordinator(s); ${idle.length} idle exit now `
    + `[${idle.map((c) => `${c.agent} pid ${c.pid}`).join(', ')}], ${busy.length} mid-turn finish their turn then exit `
    + `[${busy.map((c) => `${c.agent} pid ${c.pid}`).join(', ')}]`);
  for (const c of idle) c.closing = 'shutdown';
  for (const c of mine) { try { c.child.stdin.end(); } catch { /* gone */ } }
  const until = Date.now() + SHUTDOWN_WAIT_MS;
  while (Date.now() < until && idle.some((c) => !c.finalized)) await delay(100);
  for (const c of runtime.coords.values()) { stopWatch(c); clearInterval(c.tailTimer); clearInterval(c.pidTimer); }
  if (!(opts && opts.noExit)) process.exit(0);
}

function parseArgs(argv) {
  const cfg = {
    queue: DEFAULT_QUEUE,
    intervalMs: 10000,
    graceMs: 20000,
    /*
     * WAS 3 UNTIL 2026-09-02, AND THREE WAS THE STALL.
     *
     * The supervisor passes no --max-concurrent, so this default is the live
     * value. It was chosen when a coordinator answered a tab in a couple of
     * minutes. It no longer does: under the default-deny guard an auto-seated
     * coordinator usually cannot do the machine work it was sent for, so it
     * spends 20-30 minutes writing a spec and then releases. Three such tabs
     * hold every slot, and every other tab is starved for as long as they run
     * - not slowly served, NOT SERVED AT ALL. Observed: tab "Relay" empty
     * seat, five human messages, 10+ minutes, autoseat healthy and beating.
     *
     * Raising this is a mitigation, not the cure. The cure is that a
     * coordinator which cannot act should not burn a slot for half an hour.
     *
     * Since 2026-09-17 a slot is held by a long-lived coordinator, so the cap
     * counts live processes, and an IDLE one is evicted to make room rather
     * than starving the new tab (see selectSeats).
     */
    maxConcurrent: 6,
    /*
     * 30 minutes idle, then retire. Long enough to cover a conversation's
     * natural pauses - he reads a reply, walks away, answers ten minutes later
     * - so the follow-up lands in a warm session. Short enough to stay under
     * the server's 45-minute vacant-chair sweep, so autoseat releases its own
     * seats with a reason before the sweep has to presume anyone gone.
     */
    idleMs: 30 * 60 * 1000,
    stateFile: DEFAULT_STATE,
    heartbeatFile: DEFAULT_HEARTBEAT,
    logDir: path.join(path.dirname(DEFAULT_STATE), 'logs'),
    claude: process.env.AUTOSEAT_CLAUDE || path.join(os.homedir(), '.local', 'bin', 'claude'),
    // SECURITY-COUPLED - read before touching how a seat is spawned.
    //
    // Until 2026-09-19 this was `cwd: /home/hypnodroid/Projects/relay-queue`,
    // and the guard's safety rested on it: Claude Code loads .claude/settings.json
    // only for the directory a session is rooted in, so rooting every seat in
    // this repo was what registered the guard. Folder scopes ended that. A seat
    // now stands in its conversation's folder, `home` + conversation.path (see
    // seatCwd), and the guard is INJECTED PER SEAT, independent of cwd:
    //
    //   --settings=<REPO>/src/claude-config/settings.json  registers
    //       <REPO>/src/claude-config/hooks/coordinator-guard.js (PreToolUse)
    //   --add-dir=<REPO>  loads <REPO>/.claude/skills/relay-coordinator
    //
    // REPO is derived from this file's location (see SEAT_SETTINGS), and
    // main() refuses to start unless verifySeatConfig() passes, so a seat
    // without the guard cannot be spawned. The repo's own .claude/settings.json
    // no longer registers the guard at all - by the owner's choice, a session
    // started by hand in the repo is NOT guarded; coordinator mode is a session
    // started by relay. Verified on Claude Code 2.1.278: a --settings hook fires
    // and can deny in a -p session rooted in an unrelated folder, and --add-dir
    // loads that dir's .claude/skills.
    //
    // --resume works from any cwd (2.1.223+, verified), so a tab's session
    // survives a revive wherever it stands; a tab MOVED to another folder is
    // deliberately given a fresh session instead (see the resume decision in
    // tick()).
    //
    // `home` is only the base the conversation paths are relative to.
    home: os.homedir(),
    legacyCwd: null,
    /* Only for tests (a worktree whose registered guard path is not live yet).
     * Whatever it names is held to the same startup check as the default. */
    seatSettings: SEAT_SETTINGS,
    model: '',
    ignore: new Set(),
    once: false,
    dry: false,
    explain: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--queue') cfg.queue = next();
    else if (a === '--interval') cfg.intervalMs = Number(next()) * 1000;
    else if (a === '--grace') cfg.graceMs = Number(next()) * 1000;
    else if (a === '--max-concurrent') cfg.maxConcurrent = Number(next());
    else if (a === '--idle') cfg.idleMs = Number(next()) * 60000;
    else if (a === '--state') cfg.stateFile = next();
    else if (a === '--heartbeat') cfg.heartbeatFile = next();
    else if (a === '--log-dir') cfg.logDir = next();
    else if (a === '--claude') cfg.claude = next();
    else if (a === '--home') cfg.home = path.resolve(next());
    else if (a === '--seat-settings') cfg.seatSettings = path.resolve(next());
    /* Accepted and IGNORED: the seat cwd now comes from each conversation's
     * path. The live supervisor still passes it, and must keep starting. */
    else if (a === '--cwd') cfg.legacyCwd = next();
    else if (a === '--model') cfg.model = next();
    else if (a === '--ignore') String(next()).split(',').forEach((x) => x && cfg.ignore.add(x.trim()));
    else if (a === '--once') cfg.once = true;
    else if (a === '--dry') cfg.dry = true;
    else if (a === '--explain') cfg.explain = true;
    else if (a === '--help' || a === '-h') cfg.help = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!(cfg.idleMs > 0)) throw new Error('--idle must be a positive number of minutes');
  return cfg;
}

const USAGE = `autoseat - keep one long-lived coordinator per tab that has a human message.

  node tools/autoseat.js [--once] [--dry] [--explain]

  --queue URL          relay base (default ${DEFAULT_QUEUE})
  --interval SEC       seconds between polls (default 10; a live coordinator's tab is also watched over SSE)
  --grace SEC          seconds a message must wait before seating (default 20)
  --max-concurrent N   most live coordinators at once; an idle one is evicted for a new tab (default 6)
  --idle MIN           minutes without a turn before a coordinator is retired and its seat released (default 30)
  --state FILE         dispatch memory and per-tab session ids (default ${DEFAULT_STATE})
  --heartbeat FILE     proof-of-life for the supervisor (default ${DEFAULT_HEARTBEAT})
  --log-dir DIR        per-coordinator stream-json logs
  --claude PATH        the claude executable
  --home DIR           the folder conversation paths are relative to; a seat runs in HOME/<path>, or in its
                       own worktree under HOME/Worktrees when that folder is in a git repo (default ${os.homedir()})
  --seat-settings FILE for tests: another guard registration, held to the same startup check (default ${SEAT_SETTINGS})
  --cwd DIR            ignored (logged). A seat's cwd is its conversation's folder; the guard and the skill
                       are injected per seat with --settings/--add-dir - see the note in parseArgs
  --model NAME         model for the coordinator (default: whatever claude is configured with)
  --ignore A,B         conversation ids never to seat
  --once               run a single pass and exit; a coordinator it started answers that one turn and exits
  --dry                decide, log, spawn nothing
  --explain            print every message considered and why it was or was not seated
`;

async function main() {
  let cfg;
  try { cfg = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
  if (cfg.help) { console.log(USAGE); return; }

  const log = (m) => console.log(`${stamp()}  ${m}`);

  /* A seat without the guard must be impossible: refuse to run at all. */
  const problems = verifySeatConfig({ strict: true, settings: cfg.seatSettings });
  if (problems.length) {
    for (const p of problems) log(`REFUSING TO START: ${p}`);
    log('Every seat is spawned with --settings=' + cfg.seatSettings + ' and --add-dir=' + REPO
      + '; without a working guard registration a coordinator runs unguarded, silently.');
    process.exit(2);
  }
  if (cfg.seatSettings !== SEAT_SETTINGS) log(`SEAT SETTINGS OVERRIDDEN: ${cfg.seatSettings} instead of ${SEAT_SETTINGS} (--seat-settings is for tests)`);
  if (cfg.legacyCwd) log(`--cwd ${cfg.legacyCwd} is ignored: each seat runs in its conversation's folder under ${cfg.home}`);

  const runtime = createRuntime(cfg, log);

  log(`autoseat watching ${cfg.queue} every ${cfg.intervalMs / 1000}s; grace ${cfg.graceMs / 1000}s, `
    + `cap ${cfg.maxConcurrent}, idle ${cfg.idleMs / 60000}m, ${Object.keys(runtime.state.dispatched).length} message(s) already dispatched, `
    + `${Object.keys(runtime.state.tabs).length} tab session(s) remembered; seats run under ${cfg.home} `
    + `with --settings=${cfg.seatSettings} --add-dir=${REPO}`
    + (cfg.dry ? ' [DRY-RUN]' : ''));

  if (!cfg.dry) await adoptSurvivors(runtime);

  /*
   * Nothing a single tick can throw is worth taking the watcher down for. An
   * unhandled rejection here would end the process, and a dispatcher that
   * exits on one bad poll is a dispatcher that is not running the next time it
   * is needed - the exact failure mode of the router it replaces.
   */
  /*
   * A tick that THREW deliberately does not beat. The catch keeps the watcher
   * alive (see above), but an unexpected fault every poll is not a working
   * dispatcher, and letting the heartbeat go stale hands the supervisor the
   * one remedy that might clear it: a fresh process. Only a tick that RAN TO
   * COMPLETION - seated, idle, or cleanly reporting relay unreachable - is
   * allowed to vouch for this process.
   */
  const beat = () => { if (!cfg.once) writeHeartbeat(cfg.heartbeatFile, runtime.lastOutcome); };
  /*
   * ONE TICK AT A TIME. Two overlapping ticks can both read the same empty tab
   * and both seat it - the double coordinator by another route. With the SSE
   * doorbell poking ticks between polls, overlap is the normal case, not a
   * corner, so a tick that arrives mid-tick is folded into one re-run after it.
   * A hung tick still starves the heartbeat, as intended above.
   */
  const safeTick = serialTicker(cfg, runtime, beat);

  process.on('SIGTERM', () => { shutdown(runtime, 'SIGTERM'); });
  process.on('SIGINT', () => { shutdown(runtime, 'SIGINT'); });

  /* Stamp one before the first poll, so a just-started autoseat is never
   * mistaken for a wedged one during the seconds its first tick takes. */
  beat();

  await safeTick();
  if (cfg.once) {
    /* --once hands out one turn and stops deciding. Closing stdin makes any
     * coordinator it started answer that turn and exit - the old one-shot
     * behavior, which is what a single manual pass should mean. */
    await shutdown(runtime, 'once');
    return;
  }
  setInterval(safeTick, cfg.intervalMs);
}

// seatArgs/verifySeatConfig/SEAT_SETTINGS/REPO are exported for
// autoseat-selftest.js, which asserts that every spawn carries a --settings
// file that registers the guard and an --add-dir holding the coordinator skill.
// That coupling has no runtime symptom when broken, so it needs a test rather
// than a comment. The runtime pieces are exported so the selftest can drive the
// real lifecycle against a fake relay and a fake claude.
module.exports = {
  selectSeats, coveredBy, agentName, brief, turnText, writeHeartbeat, parseArgs, HUMAN_ORIGINS,
  createRuntime, tick, serialTicker, adoptSurvivors, shutdown, pidAlive, loadState,
  seatArgs, verifySeatConfig, seatCwd, folderProblem, prepareSeatDir, slugify, REPO, SEAT_SETTINGS, SEAT_SKILL,
};

if (require.main === module) main();
