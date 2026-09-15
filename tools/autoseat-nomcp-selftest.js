'use strict';
/*
 * autoseat-nomcp-selftest - prove the `--no-mcp` dispatch flag is wired, and
 * that it is OFF unless asked for.
 *
 *   node tools/autoseat-nomcp-selftest.js
 *
 * WHAT IT IS FOR, AND THE MEASUREMENT BEHIND IT.
 *
 * A dispatched coordinator's system prompt - tool definitions, skills listing,
 * settings - is re-fed on EVERY turn of its session, not once. Measured on this
 * box, 2026-09-01, by reading the `usage` that `claude -p --output-format json`
 * reports back:
 *
 *   default spawn ...................................... 23,323 boot tokens
 *   + --strict-mcp-config --mcp-config {"mcpServers":{}}  19,021 boot tokens
 *                                                        ------
 *                                              saving      4,302 tokens/turn
 *
 * Reproduce with:
 *   claude -p 'Reply with exactly: ok' --output-format json --max-turns 1
 *   claude -p 'Reply with exactly: ok' --output-format json --max-turns 1 \
 *     --strict-mcp-config --mcp-config '{"mcpServers":{}}'
 * and sum input_tokens + cache_read_input_tokens + cache_creation_input_tokens.
 *
 * Because the boot payload is per-TURN, a 60-turn coordinator pays roughly
 * 258,000 tokens purely to carry MCP tool definitions it never calls: relay
 * coordination is curl plus file edits, and brief() already forbids the two
 * MCP-shaped things a coordinator might reach for (speaking aloud, push
 * notifications).
 *
 * WHY IT DEFAULTS OFF. It removes capability, not merely cost. A tab that asks
 * a coordinator for something an MCP server provides would silently be unable
 * to do it, and a silent capability loss is a bad trade to take by stealth.
 * The saving is real and measured; the decision to take it is the operator's.
 *
 * WHAT IS DELIBERATELY NOT HERE. `--setting-sources user` / `''` saves a
 * further ~2,200 tokens/turn but drops the project `.claude/settings.json`,
 * which is what registers the coordinator guard - and Claude Code does not
 * inherit settings up the tree (see the cwd comment in parseArgs). That would
 * disable a safety check to save tokens, so it is not offered at any price.
 *
 * Zero dependencies. Node built-ins only. No spawn, no tokens spent.
 */
const { parseArgs, NO_MCP_ARGS } = require('./autoseat');

let failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? ' - ' + detail : ''}`);
}

console.log('\nthe flag defaults OFF - a capability change is never silent');
const plain = parseArgs([]);
check('parseArgs() with no flags leaves noMcp false', plain.noMcp === false, JSON.stringify(plain.noMcp));

console.log('\n--no-mcp turns it on');
const off = parseArgs(['--once']);
const on = parseArgs(['--no-mcp']);
check('--once alone does NOT enable it (no accidental coupling)', off.noMcp === false, JSON.stringify(off.noMcp));
check('--no-mcp sets noMcp true', on.noMcp === true, JSON.stringify(on.noMcp));
check('--no-mcp consumes no argument (it is a bare flag)',
  parseArgs(['--no-mcp', '--once']).once === true,
  'the flag after --no-mcp was swallowed');

console.log('\nthe flags appended are exactly the ones the saving was measured for');
check('NO_MCP_ARGS is exported', Array.isArray(NO_MCP_ARGS), typeof NO_MCP_ARGS);
check('NO_MCP_ARGS is exactly --strict-mcp-config --mcp-config {"mcpServers":{}}',
  JSON.stringify(NO_MCP_ARGS) === JSON.stringify(['--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}']),
  JSON.stringify(NO_MCP_ARGS));
check('--strict-mcp-config is present - without it --mcp-config MERGES instead of replacing, and saves nothing',
  NO_MCP_ARGS.includes('--strict-mcp-config'), JSON.stringify(NO_MCP_ARGS));
check('the mcp config is valid JSON declaring zero servers',
  (() => {
    const i = NO_MCP_ARGS.indexOf('--mcp-config');
    if (i < 0) return false;
    try { const j = JSON.parse(NO_MCP_ARGS[i + 1]); return j && j.mcpServers && Object.keys(j.mcpServers).length === 0; }
    catch { return false; }
  })(), JSON.stringify(NO_MCP_ARGS));

console.log('\nthe guard-disabling saving is NOT taken, at any price');
check('no --setting-sources anywhere in the appended flags (it would drop the coordinator guard)',
  !NO_MCP_ARGS.some((a) => String(a).includes('setting-sources')), JSON.stringify(NO_MCP_ARGS));
const cfg = parseArgs(['--no-mcp']);
check('--no-mcp does not touch cwd - the guard and skill are discovered from it',
  cfg.cwd === parseArgs([]).cwd, `${cfg.cwd} vs ${parseArgs([]).cwd}`);

console.log(failures ? `\n${failures} check(s) FAILED\n` : '\nall checks passed\n');
process.exit(failures ? 1 : 0);
