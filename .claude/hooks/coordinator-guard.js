#!/usr/bin/env node
'use strict';
/*
 * coordinator-guard.js — PreToolUse guard for the coordinator session
 * (project D:\projects\relay-queue — the directory autoseat starts coordinators in).
 *
 * POLICY: DEFAULT DENY.
 *
 * The coordinator routes and delegates. It must not perform ACTIONS on the
 * machine itself. Previously this was a blocklist (default-allow), which meant
 * every new binary was a fresh hole — `python` fell through to the harness
 * permission prompt, and an unanswered prompt froze the machine for hours.
 * It is now an allowlist: anything not explicitly permitted is DENIED.
 *
 * THE POLICY BAR, which is what makes the conditional allowances below safe:
 * READ-ONLY AND FAST = ALLOW; MUTATING, LONG-RUNNING OR INTERACTIVE = DENY.
 * This is not an adversarial sandbox. The coordinator is trusted; it is fenced
 * against drifting from routing into doing, and against parking the session on
 * something slow. A command that only looks at state, and returns immediately,
 * is coordination — it is how the coordinator checks what its agents claim.
 * A command that changes state, blocks on a TTY, or takes network time is not,
 * however small it is.
 *
 * Wired from D:\projects\relay-queue\.claude\settings.json, PreToolUse,
 *   matcher: Bash|PowerShell|Write|Edit|NotebookEdit
 *
 * REGISTRATION IS LOCATION-COUPLED — the single worst way to break this guard.
 * Claude Code loads project settings only for the directory the session is
 * rooted in. Coordinators are started by tools/autoseat.js with
 * `cwd: D:\projects\relay-queue`, so the registration MUST live in that
 * directory's .claude/settings.json. If the two ever diverge the hook simply
 * never fires: no error, no log line, and default-deny silently becomes
 * default-allow. Move one, move the other, in the same commit.
 *
 * The matcher is deliberately UNANCHORED, matching the pattern already proven
 * to fire in this harness. It therefore over-matches slightly (BashOutput,
 * MultiEdit, TodoWrite), and the real dispatch is the anchored tool tests in
 * main() below. That asymmetry is chosen: an over-matching matcher fails
 * visibly (something gets refused and says so), whereas an anchored matcher
 * the harness did not honour would fail silently and never fire at all.
 *
 * NOT matched, therefore completely unrestricted, deliberately:
 *   Agent, SendMessage, Monitor, ScheduleWakeup, Task tools  -> delegation is
 *   the coordinator's whole job and must never be impeded.
 *   Read, Grep, Glob                                          -> inspection.
 * Do not add those to the matcher.
 *
 * THE EXCEPTIONS to default-deny:
 *   1. Write/Edit/MultiEdit/NotebookEdit whose target path ends .md/.markdown.
 *   2. curl/wget aimed exclusively at the relay (http://127.0.0.1:3901, also
 *      localhost and [::1]) — the coordinator's ONLY channel to the human —
 *      plus writing the JSON payload file it POSTs, restricted to temp paths.
 *   3. Inert inspection commands (echo/cat/ls/grep/head/... see INERT).
 *   4. Four otherwise-dangerous tools, vetted per call for a read-only use and
 *      denied on any other (see CONDITIONAL):
 *        sed  — unless an in-place flag is present
 *        awk  — unless the program has a side effect (system/pipe/redirect)
 *        tee  — unless a target is outside the temp directories
 *        git  — read-only subcommands only, listed in READONLY_GIT
 *   5. Command substitutions — `$(...)` and backticks — whose inner command is
 *      itself permitted by everything above, checked recursively.
 *   6. Nothing else.
 *
 * Decisions: every path resolves to "allow" or "deny".
 * NEVER "ask", and never silent-fallthrough to the harness prompt:
 * an unanswered prompt parks the session, and did exactly that on 2026-08-17.
 * Malformed input, internal error, unrecognised command => deny.
 *
 * SUBAGENT EXEMPTION: hook input carries `agent_id`, set for subagent tool
 * calls and absent on the session main thread. Subagents are the hands; they
 * are allowed through immediately, before any other logic runs, so a bug below
 * can only ever over-restrict the coordinator, never the agents it spawns.
 *
 * PARSER NOTE (the bug this rewrite fixes): the old parser rewrote `(`, `)`,
 * `{`, `}` and backticks into command separators and split on `&&`/`|`/`;`
 * without tracking quotes or heredocs. So the *prose body* of
 *     cat > /tmp/msg.json <<'JSON' ... JSON
 * was parsed as shell. A relay message containing the markdown
 * "`git checkout foo && git reset --hard bar`" was read as an actual git
 * invocation and blocked. 14 of the 24 entries in coordinator-violations.log
 * are that false positive — every one of them a message to the human that
 * never arrived. This parser is quote-aware and strips heredoc bodies and
 * PowerShell here-string bodies before looking for commands.
 */

const fs = require('fs');
const path = require('path');

/*
 * Runtime state lives beside this file, resolved from __dirname rather than an
 * absolute path. This guard moved from D:\projects\.claude to
 * D:\projects\relay-queue\.claude on 2026-08-29; a hardcoded path would have
 * kept appending the audit log to the OLD directory, where nobody would look
 * for it, while the guard itself ran from the new one.
 */
const GUARD_HOME = path.resolve(__dirname, '..');
const LOG_FILE = path.join(GUARD_HOME, 'coordinator-violations.log');
const RELAY = 'http://127.0.0.1:3901';

/* ---------- output helpers ---------------------------------------------- */

/*
 * Exit with no output: the harness's ordinary permission flow then decides.
 * This is NOT "ask" — the guard itself never prompts. It is used only for
 * subagent calls and harness bookkeeping tools, whose handling is therefore
 * unchanged by this rewrite. Every COORDINATOR path ends in allow or deny.
 */
function silent() {
  process.exit(0);
}

function emit(decision, reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: decision,
        permissionDecisionReason: reason,
      },
    })
  );
  process.exit(0);
}

function allow(reason) {
  emit('allow', reason);
}

/** Append one audit line. Best effort: a logging failure must never rescue a blocked command. */
function logViolation(rule, tool, subject) {
  try {
    const line =
      new Date().toISOString() +
      ' | rule=' + rule +
      ' | tool=' + tool +
      ' | ' + String(subject).replace(/[\r\n]+/g, ' \\n ') +
      '\n';
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, line, 'utf8');
  } catch (_) { /* swallowed on purpose */ }
}

function deny(rule, tool, subject, what) {
  // The decision is already made at this point. Log first, then emit.
  logViolation(rule, tool, subject);

  const short = String(subject).replace(/[\r\n]+/g, ' ').slice(0, 200);
  const safe = short.replace(/["\\']/g, '');
  const reason = [
    'COORDINATOR GUARD BLOCKED THIS (rule: ' + rule + ').',
    '',
    'You are the coordinator. You route work; you do not perform it. ' + what,
    'This guard is DEFAULT DENY: markdown edits via your own tools, relay traffic to ' + RELAY + ', inert inspection commands, and read-only uses of sed/awk/tee/git are permitted. Everything else is refused mechanically, not as a judgement call — "it is only a small one" is precisely the reasoning this guard exists to override.',
    '',
    'Do this instead, in order:',
    '1. DELEGATE IT. Spawn a subagent with the Agent tool and give it this exact command. Subagents are exempt from this guard and can run it.',
    '2. If it truly cannot be delegated, hand the command to the user and let him run it.',
    '3. REPORT THIS VIOLATION NOW, in this same turn, into relay conversation "main". Run exactly:',
    "   curl -s -X POST " + RELAY + "/messages -H 'content-type: application/json' -d '{\"conversationId\":\"main\",\"agent\":\"coordinator\",\"text\":\"GUARD BLOCKED: " + safe + " — rule " + rule + ". I tried to act instead of delegating.\"}'",
    '   That curl is permitted (it targets 127.0.0.1:3901). Reporting is mandatory, not optional.',
    '',
    'Do not retry this command, do not reword it, and do not reach for a different tool that does the same thing.',
  ].join('\n');

  emit('deny', reason);
}

/* ---------- policy tables ------------------------------------------------ */

/*
 * INERT: inspection, not action. The coordinator uses these to verify what its
 * agents claim rather than taking reports on faith. None of them mutate state:
 * anything that writes must do so through a redirect, and redirects are
 * separately restricted to temp paths (see TEMP_TARGET).
 */
const INERT = new Set([
  // the owner's explicit list
  'echo', 'printf', 'cat', 'head', 'tail', 'wc', 'grep', 'ls', 'stat', 'date', 'find',
  // navigation / trivially inert companions of the above
  'cd', 'pwd', 'true', 'false',
  // read-only text filters, so pipelines of the above still work
  'egrep', 'fgrep', 'rg', 'sort', 'uniq', 'cut', 'tr', 'nl', 'rev', 'diff', 'cmp',
  'jq', 'base64', 'md5sum', 'sha256sum',
  // more of the same, added when the fence proved tighter than intended: every
  // one of these reads its input and writes stdout, and none takes measurable
  // time on the inputs a coordinator looks at.
  'tac', 'paste', 'join', 'comm', 'column', 'fold', 'expand', 'unexpand', 'seq',
  'strings', 'od', 'xxd', 'hexdump', 'cksum', 'sha1sum', 'sha512sum',
  // shell built-in predicates — `test -f x` decides, it does not act
  'test', '[',
  // read-only path / filesystem queries
  'basename', 'dirname', 'realpath', 'readlink', 'file', 'du', 'df', 'tree',
  // read-only identity / environment queries
  'which', 'type', 'whoami', 'hostname', 'uname',
  'printenv', 'id', 'groups', 'tty', 'locale',
  // process inspection. `ps`/`pgrep` REPORT; `kill`/`pkill` act and stay denied,
  // and the interactive monitors (`top`, `htop`, `watch`) are denied because
  // they never return, not because they mutate.
  'ps', 'pgrep',
]);

/** Network fetchers — permitted ONLY when every URL in the segment is the relay. */
const NET = new Set(['curl', 'wget']);

/**
 * `find` is inert only as a search. These predicates make it an executor or a
 * mutator, so a segment containing any of them is denied even though the head
 * word is allowed.
 */
const FIND_ACTIONS = /(^|\s)-(exec|execdir|ok|okdir|delete|fprintf|fls|fprint|fprint0)(\s|$)/i;

/**
 * Named rules, used ONLY to give a denial a meaningful name in the log and in
 * the message back to the model. The DECISION does not depend on this table —
 * anything absent from INERT/NET/CONDITIONAL is denied regardless. `python` is
 * here because its absence from the old blocklist is the specific hole that, by
 * falling through to the harness permission prompt, froze the machine.
 *
 * sed / awk / tee / git are NOT here any more: they have conditional handlers
 * in CONDITIONAL that decide per call and name their own rules.
 */
const NAMED = new Map(Object.entries({
  python: 'python', python3: 'python', py: 'python', pypy: 'python',
  perl: 'perl', ruby: 'ruby', rb: 'ruby', osascript: 'osascript',
  rscript: 'Rscript', r: 'Rscript', php: 'php', lua: 'lua',
  gh: 'gh', hub: 'gh', svn: 'svn', hg: 'hg',
  docker: 'docker', 'docker-compose': 'docker', podman: 'docker',
  kubectl: 'kubectl', helm: 'helm', nerdctl: 'docker',
  npm: 'npm', pnpm: 'pnpm', yarn: 'yarn', npx: 'npx', bun: 'bun', bunx: 'bun',
  node: 'node', deno: 'deno', 'ts-node': 'node', tsx: 'node',
  make: 'make', cargo: 'cargo', gradle: 'gradle', mvn: 'mvn', dotnet: 'dotnet', go: 'go',
  pip: 'pip', pip3: 'pip', pipx: 'pip', uv: 'uv', gem: 'gem', composer: 'composer',
  winget: 'winget', choco: 'choco', scoop: 'scoop', msiexec: 'msiexec',
  apt: 'apt', 'apt-get': 'apt', brew: 'brew',
  systemctl: 'systemctl', service: 'service', pm2: 'pm2', supervisorctl: 'supervisorctl', nssm: 'nssm',
  shutdown: 'shutdown', kill: 'kill', pkill: 'kill', killall: 'kill', taskkill: 'taskkill',
  sc: 'sc', net: 'net', schtasks: 'schtasks', reg: 'reg', netsh: 'netsh',
  bcdedit: 'bcdedit', diskpart: 'diskpart', powercfg: 'powercfg', setx: 'setx', wsl: 'wsl',
  ssh: 'ssh', scp: 'ssh', sftp: 'ssh', rsync: 'rsync',
  rm: 'rm', mv: 'mv', cp: 'cp', mkdir: 'mkdir', rmdir: 'rm', chmod: 'chmod', chown: 'chown',
  ln: 'ln', touch: 'touch', dd: 'dd',
  // xargs builds and runs an arbitrary command line out of its stdin. There is
  // no read-only form of it, so there is nothing here to loosen.
  xargs: 'xargs',
  // sleep is the literal "makes this session unresponsive" case: it does
  // nothing at all, slowly, which is the one thing the coordinator must not do.
  sleep: 'sleep',
  claude: 'claude', eval: 'eval', iex: 'invoke-expression', 'invoke-expression': 'invoke-expression',
  bash: 'shell', sh: 'shell', zsh: 'shell', cmd: 'shell', pwsh: 'shell', powershell: 'shell',
  sudo: 'sudo', su: 'sudo', env: 'env', start: 'start', nohup: 'nohup', exec: 'exec',
  'invoke-webrequest': 'invoke-webrequest', iwr: 'invoke-webrequest',
  'invoke-restmethod': 'invoke-restmethod', irm: 'invoke-restmethod',
  // Interactive or unbounded. A pager blocking on a TTY that will never arrive
  // is exactly the hang this guard exists to prevent — and it is invisible from
  // the outside, which is worse. Named so the refusal reads as `interactive`
  // rather than as an anonymous `not-allowlisted`.
  less: 'interactive', more: 'interactive', man: 'interactive', watch: 'interactive',
  top: 'interactive', htop: 'interactive', vi: 'interactive', vim: 'interactive',
  nano: 'interactive', emacs: 'interactive',
}));

const RELAY_URL = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]):3901(?:[\/?#]|$)/i;

/**
 * Where a redirect (or curl -o) may write. This is what keeps exception 2 from
 * becoming "the coordinator may write any file it likes": it may only stage the
 * relay payload in a temp directory.
 */
function isTempTarget(t) {
  const raw = String(t).replace(/^["'`]+|["'`]+$/g, '');
  if (!raw) return false;
  // 2>&1, >&2, 2>&- : a file DESCRIPTOR, not a path. Nothing new is written.
  // See redirectTargets() for why this branch was unreachable dead code until
  // 2026-09-02, and `-` for the close form.
  if (/^&(\d+|-)$/.test(raw)) return true;
  if (raw.includes('..')) return false;                // no climbing out
  if (/^\/dev\/null$/i.test(raw)) return true;
  if (/^\/tmp\//.test(raw)) return true;
  if (/^\/var\/tmp\//.test(raw)) return true;
  if (/^\$\{?(TMPDIR|TEMP|TMP)\}?[\\/]/i.test(raw)) return true;
  if (/^%(TEMP|TMP)%[\\/]/i.test(raw)) return true;
  if (/[\\/]AppData[\\/]Local[\\/]Temp[\\/]/i.test(raw)) return true;
  if (/^[A-Za-z]:[\\/]Windows[\\/]Temp[\\/]/i.test(raw)) return true;
  if (/^\$env:(TEMP|TMP)[\\/]/i.test(raw)) return true;
  return false;
}

const MARKDOWN_PATH = /\.(md|markdown)$/i;

/* ---------- quote-aware shell scanning ----------------------------------- */

/**
 * Remove heredoc bodies and PowerShell here-string bodies.
 *
 * This is the core fix. `cat > /tmp/msg.json <<'JSON' ... JSON` carries
 * arbitrary human prose — markdown containing backticks, braces, `&&` and
 * words like "git" — and that prose is DATA, not commands. The line that opens
 * the heredoc is kept (it is a real command); the body is dropped.
 */
function stripHeredocBodies(cmd) {
  const lines = String(cmd).split(/\r?\n/);
  const kept = [];
  let unterminated = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    kept.push(line);
    i++;

    // PowerShell here-string: a line ending in @" or @' runs to a line that is
    // exactly "@ or '@ .
    const ps = /@("|')\s*$/.exec(line);
    if (ps) {
      const close = ps[1] === '"' ? '"@' : "'@";
      while (i < lines.length && lines[i].trim() !== close) i++;
      if (i >= lines.length) unterminated = true; else i++;
      continue;
    }

    for (const tag of heredocTags(line)) {
      while (i < lines.length && lines[i].replace(/^[\t ]+/, '').trim() !== tag) i++;
      // An unterminated heredoc swallows the rest of the input as body. Real
      // bash agrees, but a guard that silently stops reading is a guard that
      // can be talked past, so this is refused rather than trusted.
      if (i >= lines.length) { unterminated = true; break; }
      i++; // consume the terminator line itself
    }
  }
  return { text: kept.join('\n'), unterminated };
}

/** Delimiters opened by `<<TAG` / `<<-TAG` / `<<'TAG'` / `<<"TAG"` on one line, in order. */
function heredocTags(line) {
  const tags = [];
  let s = 0, d = 0; // single / double quote state
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\' && !s) { i++; continue; }
    if (c === "'" && !d) { s = !s; continue; }
    if (c === '"' && !s) { d = !d; continue; }
    if (s || d) continue;
    if (c === '<' && line[i + 1] === '<') {
      if (line[i + 2] === '<') { i += 2; continue; } // <<< here-string, not a heredoc
      let j = i + 2;
      if (line[j] === '-') j++;
      while (line[j] === ' ' || line[j] === '\t') j++;
      let tag = '';
      if (line[j] === "'" || line[j] === '"') {
        const q = line[j++];
        while (j < line.length && line[j] !== q) tag += line[j++];
        j++;
      } else {
        while (j < line.length && /[A-Za-z0-9_\-.]/.test(line[j])) tag += line[j++];
      }
      if (tag) tags.push(tag);
      i = j - 1;
    }
  }
  return tags;
}

/**
 * Body of a `$(...)` beginning at the `$`, with the closing paren found by
 * balancing — quote-aware, so a stray `)` inside a string does not end it
 * early, and a nested `$(` is carried out whole for the recursive check.
 * Returns { inner, end } or null if it is never closed.
 */
function readParenSub(src, start) {
  let depth = 0;
  let s = 0, d = 0;
  for (let i = start + 1; i < src.length; i++) {
    const c = src[i];
    if (s) { if (c === "'") s = 0; continue; }
    if (c === '\\') { i++; continue; }
    if (c === "'" && !d) { s = 1; continue; }
    if (c === '"') { d = d ? 0 : 1; continue; }
    if (d) continue;
    if (c === '(') { depth++; continue; }
    if (c === ')') {
      depth--;
      if (depth === 0) return { inner: src.slice(start + 2, i), end: i };
    }
  }
  return null;
}

/** Body of a backtick substitution beginning at the opening backtick. */
function readBacktickSub(src, start) {
  for (let i = start + 1; i < src.length; i++) {
    if (src[i] === '\\') { i++; continue; }
    if (src[i] === '`') return { inner: src.slice(start + 1, i), end: i };
  }
  return null;
}

/**
 * Split into command segments on UNQUOTED separators only, and collect any
 * command substitution seen outside single quotes.
 * Note what is deliberately NOT a separator any more: ( ) { } and backticks
 * inside quotes. Rewriting those was what turned prose into commands.
 *
 * A substitution is consumed WHOLE — its own `;`, `|` and `&&` do not split the
 * enclosing segment — and its body is handed back for recursive vetting rather
 * than being refused on sight. `<(...)` is the exception: it is collected with
 * a null body and always denied.
 */
function scan(cmd) {
  const segments = [];
  const subs = [];
  let cur = '';
  let s = 0, d = 0;
  const src = String(cmd);

  const push = () => { if (cur.trim()) segments.push(cur); cur = ''; };

  for (let i = 0; i < src.length; i++) {
    const c = src[i];

    if (s) { if (c === "'") s = 0; cur += c; continue; }

    if (c === '\\') { cur += c; if (i + 1 < src.length) cur += src[++i]; continue; }
    if (c === "'" && !d) { s = 1; cur += c; continue; }
    if (c === '"') { d = d ? 0 : 1; cur += c; continue; }

    // command substitution is execution by another name — capture it wherever
    // it is not inside single quotes (inside double quotes bash still runs it).
    if (c === '$' && src[i + 1] === '(') {
      const sub = readParenSub(src, i);
      if (!sub) { subs.push({ kind: '$(...)', inner: null }); cur += c; continue; }
      subs.push({ kind: '$(...)', inner: sub.inner });
      cur += src.slice(i, sub.end + 1);
      i = sub.end;
      continue;
    }
    if (c === '`') {
      const sub = readBacktickSub(src, i);
      if (!sub) { subs.push({ kind: '`...`', inner: null }); cur += c; continue; }
      subs.push({ kind: '`...`', inner: sub.inner });
      cur += src.slice(i, sub.end + 1);
      i = sub.end;
      continue;
    }
    if (c === '<' && src[i + 1] === '(' && !d) { subs.push({ kind: '<(...)', inner: null }); cur += c; continue; }

    if (d) { cur += c; continue; }

    // `2>&1`, `>&2`, `2>&-` — this `&` belongs to the redirection, not to job
    // control. Splitting the segment here stranded a bare `1` as its own
    // "command"; see redirectTargets() for the other half of the same bug.
    if (c === '&' && /[<>][ \t]*$/.test(cur)) {
      cur += c;
      let j = i + 1;
      while (j < src.length && /[\d-]/.test(src[j])) cur += src[j++];
      i = j - 1;
      continue;
    }

    if (c === '\n' || c === ';') { push(); continue; }
    if (c === '&' && src[i + 1] === '&') { push(); i++; continue; }
    if (c === '|' && src[i + 1] === '|') { push(); i++; continue; }
    if (c === '|') { push(); continue; }
    if (c === '&') { push(); continue; }

    cur += c;
  }
  push();
  return { segments, subs };
}

/** Split a segment into words, honouring quotes. Quotes are kept on the word. */
function wordsOf(seg) {
  const out = [];
  let cur = '';
  let s = 0, d = 0;
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (s) { cur += c; if (c === "'") s = 0; continue; }
    if (c === '\\') { cur += c; if (i + 1 < seg.length) cur += seg[++i]; continue; }
    if (c === "'" && !d) { s = 1; cur += c; continue; }
    if (c === '"') { d = d ? 0 : 1; cur += c; continue; }
    if (!d && /\s/.test(c)) { if (cur) out.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

/** Targets of unquoted output redirections (`>`, `>>`, `2>`, `&>`) in a segment. */
function redirectTargets(seg) {
  const out = [];
  let s = 0, d = 0;
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (s) { if (c === "'") s = 0; continue; }
    if (c === '\\') { i++; continue; }
    if (c === "'" && !d) { s = 1; continue; }
    if (c === '"') { d = d ? 0 : 1; continue; }
    if (d) continue;
    if (c === '>') {
      let j = i + 1;
      while (seg[j] === '>') j++;
      /*
       * THE 2>&1 BUG, fixed 2026-09-02. The collector below skips spaces and
       * then reads until [\s;|&] — so for `2>&1` it stopped dead on the `&`
       * and pushed an EMPTY target, which isTempTarget rejects. Every command
       * containing `2>&1` was therefore refused, with the nonsensical message
       * "It redirects output to ` `", and the fd-dup branch in isTempTarget
       * was unreachable dead code. Consume the `&` and its digits (or `-`,
       * meaning close) so the target reaches that branch and is recognised.
       */
      if (seg[j] === '&') {
        let t = '&';
        j++;
        while (j < seg.length && /[\d-]/.test(seg[j])) t += seg[j++];
        out.push(t);
        i = j - 1;
        continue;
      }
      while (seg[j] === ' ' || seg[j] === '\t') j++;
      let t = '';
      let ss = 0, dd = 0;
      while (j < seg.length) {
        const k = seg[j];
        if (ss) { t += k; if (k === "'") ss = 0; j++; continue; }
        if (k === "'" && !dd) { ss = 1; t += k; j++; continue; }
        if (k === '"') { dd = dd ? 0 : 1; t += k; j++; continue; }
        if (!dd && /[\s;|&]/.test(k)) break;
        t += k; j++;
      }
      out.push(t);
      i = j - 1;
    }
  }
  return out;
}

/** Bare command name: strip quotes, directory, and .exe/.cmd/.bat/.ps1. */
function baseName(w) {
  let x = String(w).replace(/^["'`]+/, '').replace(/["'`]+$/, '');
  x = x.split(/[\\/]/).pop();
  x = x.replace(/\.(exe|cmd|bat|ps1|com|sh)$/i, '');
  return x.toLowerCase();
}

/** Index of the head command word, with leading FOO=bar assignments skipped. */
function headIndexOf(words) {
  let i = 0;
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++;
  return i;
}

/** Head command word of a segment, with leading FOO=bar assignments skipped. */
function headOf(words) {
  const i = headIndexOf(words);
  return words[i] === undefined ? '' : baseName(words[i]);
}

function ruleNameFor(head) {
  return NAMED.get(head) || (head ? 'not-allowlisted' : 'unparseable-segment');
}

/** Strip surrounding quotes from one argument word. */
function unquote(w) {
  return String(w).replace(/^["'`]+/, '').replace(/["'`]+$/, '');
}

/* ---------- conditionally permitted tools -------------------------------- */
/*
 * Each handler returns null to ALLOW the segment, or a { rule, what } verdict
 * to deny it. They exist because these four tools have a genuinely read-only
 * mode which is the coordinator's normal use, and a mutating mode which is not.
 * Refusing the whole binary was over-refusal; permitting it wholesale would be
 * a hole. So the call itself is inspected.
 */

/** `sed -i`, `-i.bak`, `-ni`, `-Ei`, `--in-place`, `--in-place=SUFFIX`. */
const SED_IN_PLACE = /^-[A-Za-z]*i/;

/*
 * sed is a stream filter: it reads, and writes stdout. In-place is the one form
 * that edits a file, so that is the only form refused.
 *
 * RESIDUAL ACCEPTED RISK: the exotic write forms — the `w file` command inside
 * a script, and the `e` command, which executes a shell — are not detected.
 * Every heuristic for them false-positives on ordinary `s///` scripts, and this
 * guard fences accidental action, not an adversary. Nobody reaches for
 * `sed -e '1w /etc/passwd'` by accident.
 */
function checkSed(args) {
  for (const a of args) {
    const w = unquote(a);
    if (w === '--in-place' || w.startsWith('--in-place=') || SED_IN_PLACE.test(w)) {
      return {
        rule: 'sed-in-place',
        what: '`sed` is permitted as a read-only stream filter, but `' + w.slice(0, 40) + '` edits the file in place, which is an action on this machine.',
      };
    }
  }
  return null;
}

/**
 * The awk constructs that reach outside the program: `system()`, a gawk
 * coprocess `|&`, `close()` on a pipe, and any `>` — a redirect inside the
 * program, or a shell redirect the caller quoted.
 */
const AWK_SIDE_EFFECT = /system\s*\(|\|&|\bclose\s*\(|>/;

/*
 * awk, like sed, is read-only in the shape a coordinator actually uses:
 * `awk '{print $2}' file`.
 *
 * This DELIBERATELY false-positives on numeric comparison — `awk '$1 > 5'` is
 * refused because of the `>`. A visible over-refusal is this guard's stated
 * preference over a silent hole, and the workaround (`$1 >= 6`, or delegate)
 * costs nothing. It does NOT catch a plain `print | "cmd"`, because a bare `|`
 * cannot be told apart from the `||` in an ordinary condition; that is the same
 * residual-risk bargain as sed's `w`.
 */
function checkAwk(args) {
  const program = args.join(' ');
  if (AWK_SIDE_EFFECT.test(program)) {
    return {
      rule: 'awk-side-effect',
      what: '`awk` is permitted as a read-only filter, but this program can reach outside itself (system(), a pipe to a command, or a redirect). If it is only a `>` comparison, invert it — `$1 >= 6` for `$1 > 5`.',
    };
  }
  return null;
}

/** tee flags that are not filenames. Everything else in the args is a target. */
const TEE_FLAGS = /^-(-append|-ignore-interrupts|-output-error(=.*)?|-help|-version|[aip]+)$/;

/*
 * tee with no file at all is just `cat`. With files it writes, so the same
 * temp-only restriction as a `>` redirect applies — it IS a `>` redirect,
 * spelled differently, and denying it under the same rule says so.
 */
function checkTee(args) {
  for (const a of args) {
    const w = unquote(a);
    if (TEE_FLAGS.test(w)) continue;
    if (!isTempTarget(w)) {
      return {
        rule: 'write-outside-temp',
        what: '`tee` would write to `' + w.slice(0, 80) + '`. Staging the relay payload in a temp file is allowed; writing anywhere else is an action, and non-markdown files are not yours to write.',
      };
    }
  }
  return null;
}

/*
 * Read-only git. The INERT comment above says the coordinator uses inspection
 * "to verify what its agents claim rather than taking reports on faith" —
 * read-only git is the single most useful instance of that, and it changes
 * nothing on disk. Everything that commits, moves refs, or talks to a remote
 * stays denied; `gh`, `hub`, `svn` and `hg` stay denied entirely.
 */
const READONLY_GIT = new Set([
  'status', 'log', 'show', 'diff', 'blame', 'branch', 'tag', 'rev-parse', 'rev-list',
  'ls-files', 'ls-tree', 'cat-file', 'describe', 'shortlog', 'show-ref', 'for-each-ref',
  'count-objects', 'reflog', 'whatchanged', 'grep', 'stash', 'worktree', 'remote', 'config',
]);

/*
 * Pre-subcommand globals that inject configuration or an executable into git
 * itself. `git -c core.pager=sh log` runs sh. These are a real execution
 * vector, so they are refused before the subcommand is even considered.
 * `-C <dir>`, `--git-dir=`, `--work-tree=`, `--no-pager` and `-P` are fine.
 */
const GIT_EXEC_GLOBALS = /^(-c|--exec-path(=.*)?|--upload-pack(=.*)?|--receive-pack(=.*)?)$/;

/** Globals that consume the NEXT word as their value. */
const GIT_VALUE_GLOBALS = new Set(['-C', '--git-dir', '--work-tree', '--namespace']);

/** The only arguments `git branch` / `git tag` may carry: listing, nothing else. */
const GIT_LIST_FLAGS = new Set([
  '-l', '--list', '-a', '-r', '-v', '-vv', '--show-current', '--contains',
  '--merged', '--no-merged', '--sort', '--format', '--color', '--no-color',
]);

/**
 * Named only to make the refusal specific. The decision does not depend on this
 * set: anything not in GIT_LIST_FLAGS is denied anyway, because "a flag this
 * guard has not heard of" and "a flag that deletes a branch" are the same thing
 * from here.
 */
const GIT_BRANCH_MUTATORS = new Set([
  '-d', '-D', '-m', '-M', '-c', '-C', '-f', '--force', '--delete', '--move', '--copy',
  '--edit-description', '--set-upstream-to', '--unset-upstream',
]);

const GIT_CONFIG_READS = new Set(['--get', '--get-all', '--get-regexp', '--list', '-l']);
const GIT_CONFIG_MUTATORS = new Set([
  '--add', '--unset', '--unset-all', '--replace-all', '--rename-section',
  '--remove-section', '--edit', '-e',
]);

function gitDeny(what) {
  return { rule: 'git', what: what };
}

function checkGit(args) {
  let i = 0;
  while (i < args.length) {
    const w = unquote(args[i]);
    if (w[0] !== '-') break;
    if (GIT_EXEC_GLOBALS.test(w)) {
      return gitDeny('Read-only git is permitted, but `' + w.slice(0, 40) + '` injects configuration or an executable into git itself — `git -c core.pager=sh log` runs sh. That is refused before the subcommand is even considered.');
    }
    if (GIT_VALUE_GLOBALS.has(w)) { i += 2; continue; }
    i++;
  }

  const sub = unquote(args[i] || '');
  if (!sub) {
    return gitDeny('`git` was called without a subcommand the guard could read, so it cannot confirm the call is read-only.');
  }
  if (!READONLY_GIT.has(sub)) {
    return gitDeny('Read-only git is permitted — status, log, show, diff, blame and friends. `git ' + sub + '` either mutates state or takes network time, so it is delegation work.');
  }

  const rest = args.slice(i + 1).map(unquote);

  /*
   * The read-only subcommands that have a mutating mode reached through their
   * arguments. Each is restricted to its listing form.
   */
  if (sub === 'branch' || sub === 'tag') {
    for (const a of rest) {
      const name = a.split('=')[0];
      if (GIT_BRANCH_MUTATORS.has(name)) {
        return gitDeny('`git ' + sub + ' ' + name + '` creates, moves or deletes a ref. `git ' + sub + '` is permitted only as a listing.');
      }
      if (!GIT_LIST_FLAGS.has(name)) {
        return gitDeny('`git ' + sub + '` is permitted only as a listing — no arguments, or list flags such as --list, -a, -v. `' + a.slice(0, 40) + '` is neither.');
      }
    }
    return null;
  }

  if (sub === 'stash') {
    if (rest[0] !== 'list' && rest[0] !== 'show') {
      return gitDeny('`git stash` is permitted only as `stash list` or `stash show`; every other form moves the working tree.');
    }
    for (const a of rest.slice(1)) {
      if (a[0] !== '-') return gitDeny('`git stash ' + rest[0] + '` is permitted, but `' + a.slice(0, 40) + '` is not a flag the guard can vet.');
    }
    return null;
  }

  if (sub === 'worktree') {
    if (rest[0] !== 'list') {
      return gitDeny('`git worktree` is permitted only as `worktree list`; add/remove/prune change the filesystem.');
    }
    for (const a of rest.slice(1)) {
      if (a[0] !== '-') return gitDeny('`git worktree list` is permitted, but `' + a.slice(0, 40) + '` is not a flag the guard can vet.');
    }
    return null;
  }

  if (sub === 'remote') {
    if (!rest.length) return null;
    if (['-v', '--verbose', 'show', 'get-url'].includes(rest[0])) return null;
    return gitDeny('`git remote` is permitted only as a query — no arguments, -v, show, or get-url. `' + rest[0].slice(0, 40) + '` changes the remote configuration.');
  }

  if (sub === 'config') {
    const names = rest.map((a) => a.split('=')[0]);
    const mutator = names.find((n) => GIT_CONFIG_MUTATORS.has(n));
    if (mutator) {
      return gitDeny('`git config ' + mutator + '` writes configuration. Only the reading forms are permitted.');
    }
    /*
     * The operation flag must be one of the reading forms. Checked by presence
     * rather than by position, so `git config --global --get user.name` — which
     * reads — is not refused for putting the scope first.
     */
    if (!names.some((n) => GIT_CONFIG_READS.has(n))) {
      return gitDeny('`git config` is permitted only for reading: --get, --get-all, --get-regexp, --list or -l. Without one of those it may be setting a value.');
    }
    return null;
  }

  return null;
}

/** head word -> handler(argsAfterHead) returning null to allow, or a verdict to deny. */
const CONDITIONAL = new Map([
  ['sed', checkSed],
  ['awk', checkAwk],
  ['gawk', checkAwk],
  ['mawk', checkAwk],
  ['tee', checkTee],
  ['git', checkGit],
]);

/* ---------- the command policy ------------------------------------------- */

/*
 * How deep a `$(...)` may nest before the guard stops reasoning about it.
 * Three is far past anything a coordinator writes by hand; past that the honest
 * answer is that the guard cannot vet it, and what it cannot vet it denies.
 */
const SUB_DEPTH_LIMIT = 3;

function analyzeCommand(rawCmd, depth) {
  const level = depth || 0;
  const stripped = stripHeredocBodies(rawCmd);
  if (stripped.unterminated) {
    return {
      rule: 'unterminated-heredoc',
      what: 'It opens a heredoc (or here-string) that is never closed, so the guard cannot tell where the data ends and the commands resume.',
    };
  }
  const { segments, subs } = scan(stripped.text);

  /*
   * Command substitution used to be denied on sight, which refused ordinary
   * things like `echo "$(date)"`. It is now vetted under this same policy,
   * recursively: the inner command must itself be permitted, and the denial
   * reports the INNER command's rule so the message stays specific —
   * `echo "$(mv a b)"` is refused under `mv`, not under `command-substitution`.
   */
  for (const sub of subs) {
    if (sub.inner === null) {
      return {
        rule: 'command-substitution',
        what: 'It uses ' + sub.kind + ', which the guard cannot vet — process substitution, or a substitution that is never closed.',
      };
    }
    if (level + 1 > SUB_DEPTH_LIMIT) {
      return {
        rule: 'command-substitution-depth',
        what: 'It nests command substitutions more than ' + SUB_DEPTH_LIMIT + ' deep. The guard stops unwrapping there, and what it cannot read it does not permit.',
      };
    }
    const inner = analyzeCommand(sub.inner, level + 1);
    if (!inner.ok) {
      return { rule: inner.rule, what: 'Inside ' + sub.kind + ': ' + inner.what };
    }
  }

  let sawSomething = false;

  for (const seg of segments) {
    const words = wordsOf(seg);
    if (!words.length) continue;

    // A segment that is only variable assignments is inert.
    if (words.every((w) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w))) continue;

    const headIndex = headIndexOf(words);
    const head = headOf(words);
    if (!head) {
      return { rule: 'unparseable-segment', what: 'A part of it (`' + seg.trim().slice(0, 60) + '`) could not be resolved to a command, so it cannot be vetted.' };
    }

    // Every redirect must land in a temp path (or /dev/null).
    for (const t of redirectTargets(seg)) {
      if (!isTempTarget(t)) {
        return {
          rule: 'write-outside-temp',
          what: 'It redirects output to `' + String(t).slice(0, 80) + '`. Staging the relay payload in a temp file is allowed; writing anywhere else is an action, and non-markdown files are not yours to write.',
        };
      }
    }

    if (INERT.has(head)) {
      if (head === 'find' && FIND_ACTIONS.test(seg)) {
        return { rule: 'find-exec', what: '`find` is permitted as a search only; -exec/-delete make it an executor.' };
      }
      sawSomething = true;
      continue;
    }

    if (CONDITIONAL.has(head)) {
      const verdict = CONDITIONAL.get(head)(words.slice(headIndex + 1), seg);
      if (verdict) return verdict;
      sawSomething = true;
      continue;
    }

    if (NET.has(head)) {
      // The optional bracket group keeps IPv6 hosts intact: http://[::1]:3901
      const urls = String(seg).match(/\bhttps?:\/\/(?:\[[0-9A-Fa-f:.]+\])?[^\s'"`,;)\]]*/gi) || [];
      if (!urls.length) {
        return { rule: 'net-no-url', what: '`' + head + '` was called without a URL the guard could read, so it cannot confirm the target is the relay.' };
      }
      const bad = urls.find((u) => !RELAY_URL.test(u));
      if (bad) {
        return { rule: 'net-offrelay', what: '`' + head + '` targets ' + bad.slice(0, 80) + '. Only the relay at ' + RELAY + ' is permitted.' };
      }
      // curl -o / --output writes a file: same temp restriction.
      for (let i = 0; i < words.length; i++) {
        if (/^(-o|--output|-O|--remote-name|--output-dir)$/i.test(words[i])) {
          const t = words[i + 1] || '';
          if (!isTempTarget(t)) {
            return { rule: 'write-outside-temp', what: '`' + head + ' ' + words[i] + '` would write to `' + String(t).slice(0, 60) + '`, outside the temp directory.' };
          }
        }
      }
      sawSomething = true;
      continue;
    }

    return {
      rule: ruleNameFor(head),
      what: 'Running `' + head + '` is an action on this machine, not coordination.',
    };
  }

  if (!sawSomething) {
    return { rule: 'nothing-recognised', what: 'Nothing in it resolved to a permitted command.' };
  }
  return { ok: true };
}

/* ---------- main ---------------------------------------------------------- */

let input = null;
try {
  input = JSON.parse(fs.readFileSync(0, 'utf8'));
} catch (_) {
  input = null;
}

if (!input || typeof input !== 'object') {
  deny('unparseable-hook-input', 'unknown', '(no readable hook input)',
    'The guard could not read the tool call, so it cannot confirm this is coordination.');
}

// Subagents are the hands. Let them through first, unconditionally.
// Subagent call: exempt by design, handled exactly as before this rewrite.
if (typeof input.agent_id === 'string' && input.agent_id.trim() !== '') silent();

/*
 * One-time proof marker. The guard's whole correctness rests on `agent_id` being
 * absent on the session main thread. If that assumption were wrong the guard
 * would silently never fire — the one failure mode that yields false confidence.
 * The first time a main-thread call is seen, record it once. Bounded: one line, ever.
 */
try {
  const MARK = path.join(GUARD_HOME, '.guard-mainthread-seen');
  if (!fs.existsSync(MARK)) {
    fs.writeFileSync(MARK,
      'Coordinator main thread first observed by the guard (agent_id absent => restrictions apply).\n' +
      new Date().toISOString() +
      ' | agent_id=' + JSON.stringify(input.agent_id) +
      ' | agent_type=' + JSON.stringify(input.agent_type) +
      ' | tool=' + String(input.tool_name) +
      ' | cmd=' + String((input.tool_input || {}).command || '').slice(0, 200) + '\n', 'utf8');
  }
} catch (_) {}

try {
  const tool = String(input.tool_name || '');
  const ti = (input.tool_input && typeof input.tool_input === 'object') ? input.tool_input : {};

  /* --- file mutation tools: markdown only ------------------------------- */
  if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(tool)) {
    const p = String(ti.file_path || ti.notebook_path || ti.path || '').trim();
    if (!p) {
      deny('no-path', tool, JSON.stringify(ti).slice(0, 200),
        'The guard could not read a target path, so it cannot confirm the file is markdown.');
    }
    if (MARKDOWN_PATH.test(p)) {
      allow('Markdown file (' + p + ') — the coordinator may write its own notes and reports.');
    }
    deny('non-markdown-write', tool, p,
      'You may create, edit and delete MARKDOWN files (.md / .markdown) with your own tools. `' + p + '` is not one, so writing it is code work.');
  }

  /* --- shell tools: default deny ---------------------------------------- */
  if (/^(Bash|PowerShell)$/.test(tool)) {
    const cmd = String(ti.command || '');
    if (!cmd.trim()) {
      deny('empty-command', tool, '(empty)', 'The guard saw no command text to vet.');
    }
    const verdict = analyzeCommand(cmd, 0);
    if (verdict && verdict.ok) {
      allow('Permitted by the coordinator guard: relay traffic to ' + RELAY + ', temp-file payload staging, inert inspection, and read-only sed/awk/tee/git only.');
    }
    deny(verdict.rule, tool, cmd, verdict.what);
  }

  /*
   * Anything else that reaches this hook means the settings.json matcher
   * over-matched. Two harness companions of Bash are inert by construction and
   * pass; everything else is denied, because default-deny.
   */
  if (/^(BashOutput|KillShell|KillBash|TaskOutput|TodoWrite|TodoRead)$/.test(tool)) silent();
  deny('unexpected-tool', tool || 'unknown', JSON.stringify(ti).slice(0, 200),
    'This tool reached the coordinator guard unexpectedly and there is no rule permitting it.');
} catch (err) {
  deny('guard-internal-error', String(input.tool_name || 'unknown'),
    String((input.tool_input && input.tool_input.command) || ''),
    'The guard hit an internal error (' + String(err && err.message) + ') and fails closed.');
}
