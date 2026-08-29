#!/usr/bin/env node
'use strict';
/*
 * validate-routing.js - keep SKILL.md's routing table and references/ in sync.
 *
 * A stale pointer in a progressive-disclosure skill yields NOTHING with NO
 * ERROR: the model reads a row, tries to open a file that is not there, and
 * either silently proceeds without the protocol or burns a turn on a failed
 * Read. A reference file with no row is worse - it is simply never read, which
 * is indistinguishable from having deleted it.
 *
 * Three checks, each of which can independently fail:
 *   1. ORPHAN   - a references/*.md on disk with no row in the routing table.
 *   2. DANGLING - a references/... path named in SKILL.md that does not exist.
 *   3. BROKEN   - a *.md cross-reference inside a reference file that does not
 *                 resolve (references/ point at each other by bare filename).
 *
 * Run:  node D:/projects/relay-queue/.claude/skills/relay-coordinator/validate-routing.js
 * Exit: 0 = green, 1 = red (with every failure named), 2 = cannot run.
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const SKILL = path.join(ROOT, 'SKILL.md');
const REFDIR = path.join(ROOT, 'references');

function die(msg) {
  console.error('CANNOT RUN: ' + msg);
  process.exit(2);
}

if (!fs.existsSync(SKILL)) die('no SKILL.md at ' + SKILL);
if (!fs.existsSync(REFDIR)) die('no references/ at ' + REFDIR);

const skill = fs.readFileSync(SKILL, 'utf8');

// The routing table is the block of markdown table rows under the Routing
// heading. Anchor on the heading so ordinary prose pointers elsewhere in
// SKILL.md are NOT mistaken for routing rows (they are checked separately).
const headingIdx = skill.search(/^##\s+Routing\b/m);
if (headingIdx < 0) die('SKILL.md has no "## Routing" heading - the routing table cannot be located');

const afterHeading = skill.slice(headingIdx);
const nextHeading = afterHeading.slice(1).search(/^##\s/m);
const tableBlock = nextHeading < 0 ? afterHeading : afterHeading.slice(0, nextHeading + 1);

const rows = tableBlock.split('\n').filter((l) => l.trim().startsWith('|') && !/^\|\s*-+/.test(l.trim()));
if (rows.length < 2) die('the Routing section contains no table rows');

const REF_RE = /references\/([A-Za-z0-9._-]+\.md)/g;

function grab(text) {
  const out = new Set();
  let m;
  REF_RE.lastIndex = 0;
  while ((m = REF_RE.exec(text)) !== null) out.add(m[1]);
  return out;
}

const routed = grab(rows.join('\n'));
const mentionedAnywhere = grab(skill);
const onDisk = new Set(fs.readdirSync(REFDIR).filter((f) => f.endsWith('.md')));

const failures = [];

// 1. Every reference file must have a routing row.
for (const f of [...onDisk].sort()) {
  if (!routed.has(f)) {
    failures.push('ORPHAN    references/' + f + ' exists but no routing-table row points at it. It will never be read.');
  }
}

// 2. Every references/ path named in SKILL.md must exist.
for (const f of [...mentionedAnywhere].sort()) {
  if (!onDisk.has(f)) {
    const where = routed.has(f) ? 'the routing table' : 'SKILL.md prose';
    failures.push('DANGLING  ' + where + ' points at references/' + f + ', which does not exist.');
  }
}

// 3. Cross-references between reference files must resolve.
for (const f of [...onDisk].sort()) {
  const body = fs.readFileSync(path.join(REFDIR, f), 'utf8');
  const targets = new Set();
  const bare = /`([A-Za-z0-9._-]+\.md)`/g;
  let m;
  while ((m = bare.exec(body)) !== null) targets.add(m[1]);
  for (const t of grab(body)) targets.add(t);
  for (const t of [...targets].sort()) {
    if (t === 'SKILL.md' || t === 'CLAUDE.md' || t === 'COORDINATOR.md') continue;
    if (!onDisk.has(t)) {
      failures.push('BROKEN    references/' + f + ' cross-references ' + t + ', which does not exist.');
    }
  }
}

console.log('routing rows: ' + rows.length + ' (' + routed.size + ' distinct reference targets)');
console.log('reference files on disk: ' + onDisk.size);

if (failures.length) {
  console.error('');
  console.error('FAIL - ' + failures.length + ' problem(s):');
  for (const f of failures) console.error('  ' + f);
  process.exit(1);
}

console.log('OK - routing table and references/ agree.');
process.exit(0);
