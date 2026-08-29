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
 * THE FOUR EXCEPTIONS to default-deny:
 *   1. Write/Edit/MultiEdit/NotebookEdit whose target path ends .md/.markdown.
 *   2. curl/wget aimed exclusively at the relay (http://127.0.0.1:3901, also
 *      localhost and [::1]) — the coordinator's ONLY channel to the human —
 *      plus writing the JSON payload file it POSTs, restricted to temp paths.
 *   3. Inert inspection commands (echo/cat/ls/grep/head/... see INERT).
 *   4. Nothing else.
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
    'This guard is DEFAULT DENY: only markdown edits via your own tools, relay traffic to ' + RELAY + ', and inert inspection commands are permitted. Everything else is refused mechanically, not as a judgement call — "it is only a small one" is precisely the reasoning this guard exists to override.',
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
  // read-only path / filesystem queries
  'basename', 'dirname', 'realpath', 'readlink', 'file', 'du', 'df', 'tree',
  // read-only identity queries
  'which', 'type', 'whoami', 'hostname', 'uname',
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
 * anything absent from INERT/NET is denied regardless. `python` is here because
 * its absence from the old blocklist is the specific hole that, by falling
 * through to the harness permission prompt, froze the machine.
 */
const NAMED = new Map(Object.entries({
  python: 'python', python3: 'python', py: 'python', pypy: 'python',
  perl: 'perl', ruby: 'ruby', rb: 'ruby', osascript: 'osascript',
  rscript: 'Rscript', r: 'Rscript', php: 'php', lua: 'lua',
  git: 'git', gh: 'gh', hub: 'gh', svn: 'svn', hg: 'hg',
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
  ln: 'ln', touch: 'touch', sed: 'sed', awk: 'awk', tee: 'tee', xargs: 'xargs', dd: 'dd',
  claude: 'claude', eval: 'eval', iex: 'invoke-expression', 'invoke-expression': 'invoke-expression',
  bash: 'shell', sh: 'shell', zsh: 'shell', cmd: 'shell', pwsh: 'shell', powershell: 'shell',
  sudo: 'sudo', su: 'sudo', env: 'env', start: 'start', nohup: 'nohup', exec: 'exec',
  'invoke-webrequest': 'invoke-webrequest', iwr: 'invoke-webrequest',
  'invoke-restmethod': 'invoke-restmethod', irm: 'invoke-restmethod',
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
  if (/^&\d+$/.test(raw)) return true;                 // 2>&1
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
 * Split into command segments on UNQUOTED separators only, and report any
 * command substitution seen outside single quotes.
 * Note what is deliberately NOT a separator any more: ( ) { } and backticks
 * inside quotes. Rewriting those was what turned prose into commands.
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

    // command substitution is execution by another name — flag it wherever it
    // is not inside single quotes (inside double quotes bash still runs it).
    if (c === '$' && src[i + 1] === '(') { subs.push('$(...)'); cur += c; continue; }
    if (c === '`') { subs.push('`...`'); cur += c; continue; }
    if (c === '<' && src[i + 1] === '(' && !d) { subs.push('<(...)'); cur += c; continue; }

    if (d) { cur += c; continue; }

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

/** Head command word of a segment, with leading FOO=bar assignments skipped. */
function headOf(words) {
  let i = 0;
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++;
  return words[i] === undefined ? '' : baseName(words[i]);
}

function ruleNameFor(head) {
  return NAMED.get(head) || (head ? 'not-allowlisted' : 'unparseable-segment');
}

/* ---------- the command policy ------------------------------------------- */

function analyzeCommand(rawCmd) {
  const stripped = stripHeredocBodies(rawCmd);
  if (stripped.unterminated) {
    return {
      rule: 'unterminated-heredoc',
      what: 'It opens a heredoc (or here-string) that is never closed, so the guard cannot tell where the data ends and the commands resume.',
    };
  }
  const { segments, subs } = scan(stripped.text);

  if (subs.length) {
    return {
      rule: 'command-substitution',
      what: 'It uses ' + subs[0] + ', which executes a nested command the guard cannot vet.',
    };
  }

  let sawSomething = false;

  for (const seg of segments) {
    const words = wordsOf(seg);
    if (!words.length) continue;

    // A segment that is only variable assignments is inert.
    if (words.every((w) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w))) continue;

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
    const verdict = analyzeCommand(cmd);
    if (verdict && verdict.ok) {
      allow('Permitted by the coordinator guard: relay traffic to ' + RELAY + ', temp-file payload staging, and/or inert inspection only.');
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
