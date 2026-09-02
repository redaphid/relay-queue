'use strict';
/*
 * coordinator-guard-selftest - prove the coordinator guard still refuses to
 * ACT, and no longer refuses to LOOK.
 *
 *   node tools/coordinator-guard-selftest.js
 *
 * WHY THIS SUITE EXISTS. The guard shipped on 2026-08-29 with no test at all,
 * in a repo carrying thirty of them. It is a DEFAULT DENY policy that runs on
 * every tool call a coordinator makes, and both of its failure directions are
 * silent from the inside:
 *
 *   too tight - the coordinator is refused something harmless, and its only
 *     recourse (delegate) is itself refused by the harness classifier. On
 *     2026-09-02 that combination left an auto-seated coordinator with no path
 *     to any action at all, not even a one-word `sed`. It could not even edit
 *     the guard to fix the guard.
 *   too loose - the hook stops firing, or a rule stops matching, and nothing
 *     says so. Default-deny becomes default-allow with no error and no log
 *     line. That is the failure mode that produces false confidence.
 *
 * So every assertion below names the RULE the denial came under, not just the
 * fact of it. A command refused for an accidental reason is not a passing test;
 * it is a hole that happens to be plugged by the wrong thing today.
 *
 * WHAT MUST NOT CHANGE - these carry the risk, because they pass on the OLD
 * guard too and so are genuine regression guards rather than green-by-
 * construction:
 *   - mv/node/python/curl-off-relay/find -exec/non-markdown Write stay denied;
 *   - the heredoc false positive stays fixed. A relay message whose BODY reads
 *     "run `git checkout foo && git reset --hard abc`" is prose, not a command.
 *     Fourteen of the twenty-four entries in coordinator-violations.log were
 *     that one bug, every one of them a message to the human that never
 *     arrived. It must still pass now that read-only `git` is permitted, and
 *     for the same reason as before: the body is never parsed at all;
 *   - an unterminated heredoc is still refused rather than trusted;
 *   - a subagent (agent_id present) is still exempt, unconditionally;
 *   - nothing, ever, decides "ask". An unanswered harness prompt parked the
 *     session on 2026-08-17, and a guard that prompts has reintroduced it.
 *
 * PROVING THIS SUITE CAN FAIL. A green nobody has watched go red is not
 * evidence. Point it at the guard as it was before the loosening and it must
 * report failures - the allow half is precisely what that version refused:
 *
 *   git show HEAD:.claude/hooks/coordinator-guard.js > /tmp/old-guard.js
 *   COORDINATOR_GUARD=/tmp/old-guard.js node tools/coordinator-guard-selftest.js
 *
 * The guard is run from a THROWAWAY COPY. It appends every denial to
 * <guard>/../coordinator-violations.log, and this suite denies about thirty
 * times per run. That log is evidence - the 14-of-24 count above was read off
 * it - so a test must not write into it. The suite asserts at the end that the
 * real log was untouched, because "isolated" is another thing that fails
 * silently.
 *
 * Zero dependencies, no server, no network.
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const SOURCE = process.env.COORDINATOR_GUARD
  || path.join(REPO, '.claude', 'hooks', 'coordinator-guard.js');
const REAL_LOG = path.join(REPO, '.claude', 'coordinator-violations.log');

if (!fs.existsSync(SOURCE)) {
  console.error(`guard not found: ${SOURCE}`);
  process.exit(1);
}

// GUARD_HOME is resolved from the guard's own __dirname, so a copy one level
// deep in a temp tree relocates the log and the main-thread marker with it.
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'coordinator-guard-selftest-'));
fs.mkdirSync(path.join(SANDBOX, 'hooks'));
const GUARD = path.join(SANDBOX, 'hooks', 'coordinator-guard.js');
fs.copyFileSync(SOURCE, GUARD);
const SANDBOX_LOG = path.join(SANDBOX, 'coordinator-violations.log');
const realLogBefore = fs.existsSync(REAL_LOG) ? fs.statSync(REAL_LOG).size : null;

let failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? ' - ' + detail : ''}`);
}

/* Every decision the guard handed back, so the "never ask" invariant can be
 * asserted over the whole run rather than one case at a time. */
const decisions = [];

function decide(payload, raw) {
  const r = spawnSync(process.execPath, [GUARD], {
    input: raw === undefined ? JSON.stringify(payload) : raw,
    encoding: 'utf8',
  });
  if (r.error) throw r.error;
  const out = String(r.stdout || '').trim();
  // No output is the guard's `silent()`: subagents and harness bookkeeping.
  if (!out) {
    const quiet = { decision: null, reason: '', status: r.status };
    decisions.push(quiet);
    return quiet;
  }
  let parsed = null;
  try { parsed = JSON.parse(out); } catch (_) { /* reported as UNPARSEABLE below */ }
  const hook = (parsed && parsed.hookSpecificOutput) || {};
  const d = {
    decision: hook.permissionDecision || 'UNPARSEABLE',
    reason: String(hook.permissionDecisionReason || out),
    status: r.status,
  };
  decisions.push(d);
  return d;
}

const bash = (command, extra) =>
  Object.assign({ tool_name: 'Bash', tool_input: { command } }, extra || {});

/** The rule name the guard puts in the first line of every denial. */
const ruleOf = (reason) => {
  const m = /\(rule: ([^)]+)\)/.exec(String(reason));
  return m ? m[1] : null;
};

function allows(cmd, label) {
  const d = decide(bash(cmd));
  check(label || cmd, d.decision === 'allow',
    d.decision === 'deny' ? `denied under rule ${ruleOf(d.reason)}` : `decision was ${d.decision}`);
  return d;
}

/* The rule name is asserted, not just the refusal. `git push` denied under
 * `not-allowlisted` would mean the git handler never ran. */
function denies(cmd, rule, label) {
  const d = decide(bash(cmd));
  const got = ruleOf(d.reason);
  check(`${label || cmd}  [${rule}]`, d.decision === 'deny' && got === rule,
    d.decision !== 'deny' ? `decision was ${d.decision}` : `rule was ${got}`);
  return d;
}

/** n levels of `echo "$(...)"` around a bare `date`. */
const nest = (n) => {
  let s = 'date';
  for (let i = 0; i < n; i++) s = `echo "$(${s})"`;
  return s;
};

console.log(`guard under test: ${SOURCE}`);

// --------------------------------------------------- the loosening: read-only
console.log('\nthe loosening - read-only inspection the coordinator used to be refused');

allows("sed -n '1,20p' notes.txt");
allows("sed 's/a/b/' notes.txt");
allows("awk '{print $1}' notes.txt");
allows('git status');
allows('git log --oneline -5');
allows('git diff HEAD~1');
allows('git show HEAD');
allows('git branch');
allows('git branch -a');
allows('git branch --sort=committerdate');
allows('git tag --list');
allows('git stash list');
allows('git worktree list');
allows('git remote -v');
allows('git config --get user.name');
allows('git config --global --get user.name', 'git config --global --get (scope first still reads)');
allows('git -C /tmp status', 'git -C <dir> (a safe global)');
allows('git --no-pager log -1');
allows('cat a | tee /tmp/b');
allows('cat a | tee', 'tee with no file is just cat');
allows('ps aux');
allows('test -f /tmp/x');
allows('seq 1 5');
allows('printenv PATH');
allows('id');
allows('xxd /tmp/x');
allows('curl -s http://127.0.0.1:3901/tasks');

// The 2>&1 defect. `ls .claude/ 2>&1; echo ---; ls tools/` was refused live on
// 2026-09-02 under `write-outside-temp`, reporting that it "redirects output to
// ` `" - an empty target, because the collector stopped on the `&`.
console.log('\nthe 2>&1 defect - two bugs, one symptom');
allows('ls -la 2>&1');
allows('ls .claude/ 2>&1; echo ---; ls tools/', 'the exact command refused on 2026-09-02');
allows('echo hi >&2');
allows('cat f 2>>/tmp/x');
allows('cat f 2>/dev/null');
allows('ls > /tmp/x', 'an ordinary temp redirect still works');

// Command substitution: vetted recursively rather than refused on sight.
console.log('\ncommand substitution - vetted, not refused on sight');
allows('echo "$(date)"');
allows('echo $(date)', 'unquoted substitution');
allows(nest(3), `${'echo "$(...)"'} nested to the depth limit`);

// ----------------------------------------------- what must NOT change: action
console.log('\nwhat must NOT change - acting on the machine is still refused');

denies("sed -i 's/a/b/' notes.txt", 'sed-in-place');
denies("sed --in-place=bak 's/a/b/' notes.txt", 'sed-in-place');
denies("sed -ni 's/a/b/' notes.txt", 'sed-in-place', 'sed -ni (bundled in-place flag)');
denies("awk 'BEGIN{system(\"id\")}'", 'awk-side-effect');
denies("awk '$1 > 5' notes.txt", 'awk-side-effect', "awk '$1 > 5' - the DELIBERATE over-refusal");
denies('git commit -m x', 'git');
denies('git push', 'git');
denies('git -c core.pager=sh log', 'git', 'git -c ... (config injection runs sh)');
denies('git branch -d feature', 'git');
denies('git branch feature', 'git', 'git branch <name> (creates a ref)');
denies('git tag -d v1', 'git');
denies('git stash pop', 'git');
denies('git worktree add /tmp/wt', 'git');
denies('git remote add origin x', 'git');
denies('git config --unset user.name', 'git');
denies('git config user.name x', 'git', 'git config <key> <value> (a write with no read flag)');
denies('gh pr list', 'gh', 'gh stays denied entirely');
denies('node server.js', 'node');
denies('python x.py', 'python');
denies('sleep 30', 'sleep', 'sleep - the literal "makes this session unresponsive" case');
denies('less notes.txt', 'interactive');
denies('watch -n1 ls', 'interactive');
denies('xargs rm', 'xargs');
denies('mv a b', 'mv');
denies('rm -rf /tmp/x', 'rm');
denies('curl https://example.com', 'net-offrelay');
denies('tee /etc/hosts', 'write-outside-temp');
denies('tee -a /etc/hosts', 'write-outside-temp');
denies('ls > /etc/passwd', 'write-outside-temp');
denies('find . -exec grep x {} ;', 'find-exec');
denies('echo "$(mv a b)"', 'mv', 'the recursion must catch the inner command');
denies('echo "$(echo "$(mv a b)")"', 'mv', 'and catch it two levels down');
denies(nest(4), 'command-substitution-depth', 'nesting past the depth limit');
denies('diff <(cat a) b', 'command-substitution', 'process substitution stays opaque and denied');

// ------------------------------------------------ the historical false positive
console.log('\nwhat must NOT change - a relay message BODY is prose, not commands');

const HEREDOC_OK = [
  "cat > /tmp/msg.json <<'JSON'",
  '{"text":"to undo, run `git checkout foo && git reset --hard abc` - do not do it yourself"}',
  'JSON',
].join('\n');
const okDoc = decide(bash(HEREDOC_OK));
check('a heredoc body containing `git reset --hard abc` is allowed',
  okDoc.decision === 'allow',
  okDoc.decision === 'deny' ? `denied under rule ${ruleOf(okDoc.reason)}` : String(okDoc.decision));

const HEREDOC_BAD = ["cat > /tmp/msg.json <<'JSON'", '{"text":"never closed"}'].join('\n');
denies(HEREDOC_BAD, 'unterminated-heredoc', 'an unterminated heredoc is refused, not trusted');

// ------------------------------------------------------------ the write tools
console.log('\nwhat must NOT change - the coordinator writes markdown and nothing else');

const mdWrite = decide({ tool_name: 'Write', tool_input: { file_path: '/home/x/notes.md' } });
check('Write to a .md path', mdWrite.decision === 'allow', String(mdWrite.decision));
const mdEdit = decide({ tool_name: 'Edit', tool_input: { file_path: '/home/x/notes.markdown' } });
check('Edit a .markdown path', mdEdit.decision === 'allow', String(mdEdit.decision));
const jsWrite = decide({ tool_name: 'Write', tool_input: { file_path: '/home/x/tool.js' } });
check('Write to a .js path  [non-markdown-write]',
  jsWrite.decision === 'deny' && ruleOf(jsWrite.reason) === 'non-markdown-write',
  jsWrite.decision !== 'deny' ? String(jsWrite.decision) : `rule was ${ruleOf(jsWrite.reason)}`);

// -------------------------------------------------------- the subagent exemption
console.log('\nwhat must NOT change - subagents are the hands and are exempt');

/*
 * The exemption is checked BEFORE any other logic, so it must hold for a
 * command the coordinator itself could never run. If this ever starts denying,
 * the guard has stopped over-restricting only the coordinator and started
 * restricting the agents it spawns - which is the one thing it must not do.
 */
const sub = decide(bash('mv a b && rm -rf /tmp/x', { agent_id: 'agent_01ABC' }));
check('a subagent Bash call passes through silently',
  sub.decision === null && sub.status === 0, `decision ${sub.decision}, exit ${sub.status}`);
const subWrite = decide({
  tool_name: 'Write',
  tool_input: { file_path: '/home/x/tool.js' },
  agent_id: 'agent_01ABC',
});
check('...and so does a subagent Write to a .js path', subWrite.decision === null,
  String(subWrite.decision));

// ------------------------------------------------------------------ invariants
console.log('\nthe invariants - fail closed, never prompt');

const badInput = decide(null, 'this is not json');
check('unreadable hook input is denied  [unparseable-hook-input]',
  badInput.decision === 'deny' && ruleOf(badInput.reason) === 'unparseable-hook-input',
  `${badInput.decision} / ${ruleOf(badInput.reason)}`);

const empty = decide(bash('   '));
check('an empty command is denied  [empty-command]',
  empty.decision === 'deny' && ruleOf(empty.reason) === 'empty-command',
  `${empty.decision} / ${ruleOf(empty.reason)}`);

const odd = decide({ tool_name: 'Frobnicate', tool_input: {} });
check('an unexpected tool is denied  [unexpected-tool]',
  odd.decision === 'deny' && ruleOf(odd.reason) === 'unexpected-tool',
  `${odd.decision} / ${ruleOf(odd.reason)}`);

const todo = decide({ tool_name: 'TodoWrite', tool_input: {} });
check('harness bookkeeping passes through silently', todo.decision === null, String(todo.decision));

/*
 * THE ONE THAT PARKED THE MACHINE. "ask" hands the decision to the harness
 * permission prompt; an unanswered prompt froze the session for hours on
 * 2026-08-17. No input may ever produce it.
 */
const asked = decisions.filter((d) => d.decision === 'ask' || d.decision === 'UNPARSEABLE');
check('*** no input produced "ask" or unparseable output ***', asked.length === 0,
  `${asked.length} of ${decisions.length} decisions`);

// ------------------------------------------------------------------- the audit
console.log('\nthe audit trail');

const logged = fs.existsSync(SANDBOX_LOG)
  ? fs.readFileSync(SANDBOX_LOG, 'utf8').split('\n').filter(Boolean)
  : [];
check('every denial was written to the violations log',
  logged.length === decisions.filter((d) => d.decision === 'deny').length,
  `${logged.length} lines for ${decisions.filter((d) => d.decision === 'deny').length} denials`);
check('...and the lines carry a rule name', logged.every((l) => / \| rule=\S+ \| /.test(l)),
  logged[0]);
check('the main-thread marker was written once',
  fs.existsSync(path.join(SANDBOX, '.guard-mainthread-seen')));

/*
 * The sandbox is the point: if this ever fails, the suite has been appending
 * test noise to the real audit log, and the log stops being evidence.
 */
const realLogAfter = fs.existsSync(REAL_LOG) ? fs.statSync(REAL_LOG).size : null;
check("*** the repo's real violations log was not touched ***", realLogAfter === realLogBefore,
  `${realLogBefore} -> ${realLogAfter}`);

fs.rmSync(SANDBOX, { recursive: true, force: true });

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
