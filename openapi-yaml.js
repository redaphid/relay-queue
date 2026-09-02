'use strict';
/*
 * openapi-yaml — render `openapi.json` as YAML, with no dependency to do it.
 *
 *   node openapi-yaml.js          # rewrites openapi.yaml from openapi.json
 *
 * WHY THE JSON IS THE SOURCE OF TRUTH AND THE YAML IS GENERATED.
 *
 * This project has no YAML parser and does not want one: the core server has
 * zero runtime dependencies on purpose, and adding one so a document can be
 * pretty would be paying a real cost for a cosmetic gain. That settles the
 * direction, because the two directions are not equally cheap:
 *
 *   - YAML -> JSON needs a PARSER. Anchors, block scalars, flow style,
 *     implicit typing ("no" is a boolean, "1.0" is a number, `22:30` is a
 *     sexagesimal integer in YAML 1.1) - a hand-rolled one would be wrong in
 *     ways that silently corrupt the spec it is supposed to serve.
 *   - JSON -> YAML needs an EMITTER, which is this file: forty lines, no
 *     ambiguity, and every failure mode is visible in the output.
 *
 * So `openapi.json` is authored and reviewed, `openapi.yaml` is derived, and
 * `GET /openapi.yaml` renders it on every request rather than reading the file
 * — the two can never disagree. The checked-in .yaml exists for git diffs and
 * for tooling that wants a path; `tools/openapi-selftest.js` fails if it has
 * drifted from what this function produces.
 *
 * SAFETY RULES OF THE EMITTER. Every string is either a literal block scalar
 * (only when it is provably safe: multi-line, no leading/trailing whitespace,
 * no trailing whitespace on any line, no tabs, no empty-looking indentation) or
 * a JSON double-quoted scalar. A JSON string is always a valid YAML
 * double-quoted scalar — YAML 1.2 accepts every escape JSON produces — so the
 * fallback can never be wrong, only ugly.
 */
const fs = require('node:fs');
const path = require('node:path');

const SPEC_JSON = path.join(__dirname, 'openapi.json');
const SPEC_YAML = path.join(__dirname, 'openapi.yaml');

/** A key that needs no quoting. Deliberately conservative. */
const PLAIN_KEY = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

/*
 * ...except for the words YAML 1.1 parsers still type implicitly, which is
 * most of them (PyYAML, libyaml, and therefore most CI linters). A bare `on:`
 * key parses as the BOOLEAN TRUE, and `null:` as a null key — so the schema
 * property `on` on /checklist/tick and /tasks/{id}/checks silently became a
 * different key, and the example named `null` on the result route vanished.
 * Caught by round-tripping this file's output back through a real parser; kept
 * here because nothing in the emitter itself would ever have shown it.
 */
const YAML11_KEYWORD = /^(?:y|n|yes|no|true|false|on|off|null|~)$/i;
const NUMBERISH = /^[-+]?(?:\d[\d_]*(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/;
const plainKey = (k) => PLAIN_KEY.test(k) && !YAML11_KEYWORD.test(k) && !NUMBERISH.test(k);

/** Can this string be written as a `|-` literal block without changing it? */
function blockSafe(s) {
  if (!s.includes('\n')) return false;
  if (/^\s|\s$/.test(s)) return false;          // leading/trailing space is eaten
  if (s.includes('\t') || s.includes('\r')) return false;
  return s.split('\n').every((line) => line === '' || !/\s$/.test(line));
}

function scalar(v) {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : JSON.stringify(String(v));
  return JSON.stringify(String(v)); // valid YAML double-quoted, always
}

function emit(value, indent, out) {
  const pad = '  '.repeat(indent);

  if (Array.isArray(value)) {
    if (!value.length) return out.push(`${pad}[]`);
    for (const item of value) {
      if (item !== null && typeof item === 'object') {
        const inner = [];
        emit(item, indent + 1, inner);
        // Hoist the first line onto the dash, so a list of objects reads as one.
        inner[0] = `${pad}- ${inner[0].slice((indent + 1) * 2)}`;
        out.push(...inner);
      } else {
        out.push(`${pad}- ${scalar(item)}`);
      }
    }
    return undefined;
  }

  const keys = Object.keys(value);
  if (!keys.length) return out.push(`${pad}{}`);
  for (const k of keys) {
    const key = plainKey(k) ? k : JSON.stringify(k);
    const v = value[k];
    if (v !== null && typeof v === 'object') {
      const empty = Array.isArray(v) ? !v.length : !Object.keys(v).length;
      if (empty) { out.push(`${pad}${key}: ${Array.isArray(v) ? '[]' : '{}'}`); continue; }
      out.push(`${pad}${key}:`);
      emit(v, Array.isArray(v) ? indent : indent + 1, out);
    } else if (typeof v === 'string' && blockSafe(v)) {
      out.push(`${pad}${key}: |-`);
      for (const line of v.split('\n')) out.push(line === '' ? '' : `${pad}  ${line}`);
    } else {
      out.push(`${pad}${key}: ${scalar(v)}`);
    }
  }
  return undefined;
}

/** The document as YAML. Deterministic: same input, same bytes, every time. */
function toYaml(doc) {
  const out = [
    '# GENERATED FROM openapi.json BY openapi-yaml.js - DO NOT EDIT THIS FILE.',
    '# Edit openapi.json and run: node openapi-yaml.js',
  ];
  emit(doc, 0, out);
  return out.join('\n') + '\n';
}

/** Read the spec off disk. Throws with a readable message if it is not there. */
function readSpec(file = SPEC_JSON) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

module.exports = { toYaml, readSpec, SPEC_JSON, SPEC_YAML };

if (require.main === module) {
  const yaml = toYaml(readSpec());
  fs.writeFileSync(SPEC_YAML, yaml);
  console.log(`wrote ${SPEC_YAML} (${yaml.length} bytes)`);
}
