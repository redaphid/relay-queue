'use strict';

/**
 * share.js — publish one conversation as a public, self-contained snapshot.
 *
 * THE CONSTRAINT THAT DECIDES THE WHOLE DESIGN.
 *
 * He asked for "a public URL that shows this conversation, including links,
 * even when my computer is offline". The obvious implementation — a share URL
 * pointing at this server, exempted from Cloudflare Access — fails that last
 * clause completely. Every byte would still come off his desktop, so the link
 * would be a 502 the moment the machine sleeps, which is exactly when someone
 * he sent it to would be reading it.
 *
 * A tunnel cannot fix this, because the problem is not reachability. It is that
 * the data lives on a computer that turns off. So sharing here does not proxy;
 * it COPIES. This module renders a conversation into one HTML file with the
 * pictures embedded in it, and PUTs that file to a Cloudflare Pages Function
 * (see share-site/) which serves it from Cloudflare's edge forever after. This
 * machine is then entirely out of the path.
 *
 * THIS MAKES A SNAPSHOT, NOT A LIVE VIEW. The published page is frozen at the
 * instant it was shared and will never update itself; every page says so, in
 * words, above the first message. Re-sharing the same conversation overwrites
 * it in place — same URL, fresh content — so "refresh the link" is one tap
 * while the machine is up.
 *
 * WHY THE SERVER UPLOADS RATHER THAN SHELLING OUT TO WRANGLER: the relay runs
 * in a node:22-alpine container with the repo bind-mounted READ-ONLY and no
 * Docker socket. It cannot run wrangler, write files into the checkout, or
 * deploy anything. It can make an outbound HTTPS request. So publishing is one
 * authenticated PUT, which needs nothing installed and works identically from
 * the container or from bare node.
 *
 * SELF-CONTAINMENT IS THE POINT, so it is structural rather than careful:
 * the snapshot has no <script>, no stylesheet link, no font, and no <img> whose
 * src is a URL — every picture is inlined as a data: URI. There is nothing left
 * that could reach back to localhost:3901. The Function serves it under
 * `default-src 'none'; img-src data:`, so even a URL that somehow crept in
 * could not be fetched.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Where the snapshots are served from. Overridable per install, but this is the
// deployment that exists; see share-site/wrangler.jsonc.
const DEFAULT_ENDPOINT = 'https://relay-share-bkf.pages.dev';

/*
 * 128 bits, base64url, so the path segment is 22 characters. This is the whole
 * access control on a published page: there is no login in front of it, so it
 * must be infeasible to find one by trying. A sequential id, or anything
 * derived from the conversation id, would let anyone who has seen one link
 * enumerate the rest.
 */
const SLUG_BYTES = 16;

/*
 * The Function refuses anything over 20 MiB (KV's own ceiling is 25). Stopping
 * at 18 leaves room for the HTML around the pictures, and any image that will
 * not fit inside the budget becomes a visible "omitted" placeholder rather than
 * a silently broken picture — see renderSnapshot.
 */
const MAX_SNAPSHOT_BYTES = 18 * 1024 * 1024;

const CONFIG_FILE = 'share-config.json';

// Matched to server.js's parseChecklist EXACTLY. The published page has to
// number task-list items the same way the event log did, or the ticks land on
// the wrong lines. Sharing the rule by copying it is the bug; these two regexes
// are the rule, so they are quoted verbatim from server.js:717.
const RE_TASKLINE = /^(\s*)[-*+]\s+\[([ xX])\]\s*(.*)$/;
const RE_FENCELINE = /^\s*(?:```|~~~)/;

const RE_HEAD = /^(#{1,6})\s+(.*)$/;
const RE_QUOTE = /^\s*>\s?(.*)$/;
const RE_RULE = /^\s{0,3}([-*_])\s*(?:\1\s*){2,}$/;
const RE_ULI = /^(\s*)[-*+]\s+(.*)$/;
const RE_OLI = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const RE_IMG_PATH = /\/images\/([a-f0-9]{64})/g;
// A table is a row containing pipes followed by a dashes-and-colons rule. The
// live page renders these, so a snapshot that dropped them would show a wall of
// raw pipes where he is used to seeing a grid.
const RE_TRULE = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

const splitRow = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
const alignOf = (cell) => (/^:-+:$/.test(cell) ? 'center' : /^-+:$/.test(cell) ? 'right' : /^:-+$/.test(cell) ? 'left' : '');
const isTableAt = (lines, i) => (
  i + 1 < lines.length && lines[i].indexOf('|') >= 0
  && lines[i + 1].indexOf('-') >= 0 && RE_TRULE.test(lines[i + 1])
);

// ---------------------------------------------------------------- utilities

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

/** 128 bits of base64url — 22 unguessable characters. */
const newSlug = () => crypto.randomBytes(SLUG_BYTES).toString('base64url');

/**
 * Configuration, re-read on every call rather than cached at boot.
 *
 * Deliberate: it lives in DATA_DIR, which is the one writable mount, so he can
 * point sharing somewhere else or rotate the token without restarting a server
 * that has live coordinators attached to it.
 */
function loadConfig(dataDir) {
  const file = path.join(dataDir, CONFIG_FILE);
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { configured: false, file, reason: `no ${CONFIG_FILE} in the data directory` };
    }
    return { configured: false, file, reason: `${CONFIG_FILE} is not readable JSON: ${err.message}` };
  }
  const endpoint = String((raw && raw.endpoint) || DEFAULT_ENDPOINT).replace(/\/+$/, '');
  const token = raw && typeof raw.token === 'string' ? raw.token.trim() : '';
  if (!token) return { configured: false, file, endpoint, reason: `${CONFIG_FILE} has no "token"` };
  return { configured: true, file, endpoint, token };
}

// ---------------------------------------------------------------- secret scan
/*
 * ADVISORY ONLY. It never blocks a publish and never alters a byte of his text.
 *
 * He was asked whether publishing a thread that has carried tokens, hostnames
 * and file paths was acceptable and said the warning was enough, so this exists
 * to make the warning specific — "there is something shaped like a bearer token
 * in message 12" is actionable in a way that "be careful" is not. A scanner
 * that refused to publish, or quietly redacted, would be substituting its
 * judgement for his on his own data.
 */
const SECRET_PATTERNS = [
  ['Anthropic API key', /\bsk-ant-[A-Za-z0-9_-]{16,}/g],
  ['OpenAI API key', /\bsk-[A-Za-z0-9]{32,}/g],
  ['GitHub token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g],
  ['GitHub fine-grained token', /\bgithub_pat_[A-Za-z0-9_]{20,}/g],
  ['AWS access key id', /\bAKIA[0-9A-Z]{16}\b/g],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/g],
  ['Cloudflare token', /\bcfoat_[A-Za-z0-9._-]{20,}|\bcfort_[A-Za-z0-9._-]{20,}/g],
  ['private key block', /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g],
  ['JSON Web Token', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
  ['Authorization header', /\bauthorization\s*:\s*(?:bearer|basic)\s+\S+/gi],
  ['password assignment', /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*["']?[^\s"',;]{6,}/gi],
];

/**
 * What in this conversation looks like a credential. Returns one row per KIND
 * with a count and one masked example, because a thread that pasted the same
 * token forty times should say so once.
 */
function scanSecrets(entries) {
  const found = new Map();
  for (const e of entries) {
    const text = String(e.text || '');
    for (const [label, re] of SECRET_PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) {
        const hit = m[0];
        const row = found.get(label) || { kind: label, count: 0, example: null, entries: [] };
        row.count++;
        if (!row.example) {
          // Masked: enough to recognise which one it is, not enough to use.
          row.example = hit.length <= 12 ? hit.slice(0, 4) + '…' : hit.slice(0, 8) + '…' + hit.slice(-3);
        }
        if (row.entries.indexOf(e.id) < 0 && row.entries.length < 8) row.entries.push(e.id);
        found.set(label, row);
        if (re.lastIndex === m.index) re.lastIndex++; // zero-width guard
      }
    }
  }
  return [...found.values()].sort((a, b) => b.count - a.count);
}

// ---------------------------------------------------------------- images

/** Every image blob this conversation refers to: attachments and inline markdown. */
function collectImageIds(entries) {
  const ids = new Set();
  for (const e of entries) {
    if (Array.isArray(e.images)) {
      for (const im of e.images) if (im && /^[a-f0-9]{64}$/.test(String(im.id))) ids.add(im.id);
    }
    const text = String(e.text || '');
    RE_IMG_PATH.lastIndex = 0;
    let m;
    while ((m = RE_IMG_PATH.exec(text)) !== null) ids.add(m[1]);
  }
  return [...ids];
}

// ---------------------------------------------------------------- markdown
/*
 * A small CommonMark-ish renderer producing an HTML STRING.
 *
 * The page's own renderer (public/index.html, mdRender) builds DOM nodes and
 * cannot run here — the snapshot is rendered in the container, where there is
 * no document, and must arrive as static HTML with no script to build it. What
 * is NOT duplicated is anything that decides meaning: ordering, roles,
 * timestamps, attachments and tick state all come from threadEntries(), the
 * same projection the live UI reads. Only presentation is reimplemented.
 */

/** Only schemes a public page should ever navigate to. Anything else is inert text. */
function safeHref(raw) {
  const url = String(raw || '').trim();
  if (/^(?:https?:|mailto:)/i.test(url)) return url;
  if (/^\/images\/[a-f0-9]{64}$/.test(url)) return null; // handled as an image, never a link
  return null;
}

function linkHtml(href, innerHtml) {
  const safe = safeHref(href);
  if (!safe) return innerHtml; // a javascript: or relative URL renders as plain text
  return `<a href="${esc(safe)}" target="_blank" rel="noopener noreferrer nofollow">${innerHtml}</a>`;
}

/**
 * Inline spans. Scanned left to right rather than by chained replace(), so a
 * URL inside a code span stays literal and escaping happens once, on the
 * literal pieces only — a replace() chain corrupts hrefs containing `&`.
 */
function inline(src, ctx) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const rest = src.slice(i);
    let m;

    // Code spans win over everything inside them.
    if ((m = /^(`+)([\s\S]*?)\1/.exec(rest))) {
      out += `<code>${esc(m[2].trim())}</code>`;
      i += m[0].length; continue;
    }
    // Inline image: ![alt](/images/<sha>) or an external URL.
    if ((m = /^!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/.exec(rest))) {
      out += ctx.image(m[2], m[1]);
      i += m[0].length; continue;
    }
    if ((m = /^\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/.exec(rest))) {
      out += linkHtml(m[2], inline(m[1], ctx));
      i += m[0].length; continue;
    }
    if ((m = /^<((?:https?|mailto):[^>\s]+)>/.exec(rest))) {
      out += linkHtml(m[1], esc(m[1]));
      i += m[0].length; continue;
    }
    // Bare URLs. He pastes these constantly and asked for links specifically,
    // so an unbracketed one has to become clickable too. Trailing punctuation is
    // left out of the href: "see https://x.com/a." must not link the full stop.
    if ((m = /^https?:\/\/[^\s<>"']+/.exec(rest))) {
      const trimmed = m[0].replace(/[.,;:!?)\]]+$/, '');
      out += linkHtml(trimmed, esc(trimmed));
      i += trimmed.length; continue;
    }
    if ((m = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/.exec(rest))) {
      out += `<strong>${inline(m[2], ctx)}</strong>`;
      i += m[0].length; continue;
    }
    if ((m = /^~~(?=\S)([\s\S]*?\S)~~/.exec(rest))) {
      out += `<del>${inline(m[1], ctx)}</del>`;
      i += m[0].length; continue;
    }
    // Emphasis. `_` only at a word boundary, so snake_case_names survive.
    if ((m = /^\*(?=\S)([\s\S]*?\S)\*/.exec(rest))) {
      out += `<em>${inline(m[1], ctx)}</em>`;
      i += m[0].length; continue;
    }
    if (/^_/.test(rest) && !/[A-Za-z0-9]$/.test(src.slice(0, i))) {
      if ((m = /^_(?=\S)([\s\S]*?\S)_(?![A-Za-z0-9])/.exec(rest))) {
        out += `<em>${inline(m[1], ctx)}</em>`;
        i += m[0].length; continue;
      }
    }
    out += esc(src[i]);
    i++;
  }
  return out;
}

/**
 * Block structure. `checklist` is the entry's LIVE tick state from the event
 * log; task-list lines are numbered exactly as parseChecklist numbers them, and
 * each one is drawn from that state rather than from the `[x]` in the text —
 * which is the entire point, because ticking a box in the UI never rewrites the
 * message.
 */
function blocks(text, ctx, checklist) {
  const lines = String(text == null ? '' : text).split(/\r?\n/);
  const items = (checklist && checklist.items) || [];
  let out = '';
  let i = 0;
  let taskIndex = 0;
  let para = [];

  const flushPara = () => {
    if (!para.length) return;
    out += `<p>${para.map((l) => inline(l, ctx)).join('<br>')}</p>`;
    para = [];
  };

  while (i < lines.length) {
    const line = lines[i];
    let m;

    if (RE_FENCELINE.test(line)) {
      flushPara();
      const buf = [];
      i++;
      while (i < lines.length && !RE_FENCELINE.test(lines[i])) { buf.push(lines[i]); i++; }
      i++; // the closing fence, if there was one
      out += `<pre><code>${esc(buf.join('\n'))}</code></pre>`;
      continue;
    }

    if (!line.trim()) { flushPara(); i++; continue; }

    if ((m = RE_HEAD.exec(line))) {
      flushPara();
      const level = Math.min(6, m[1].length);
      out += `<div class="h h${level}" role="heading" aria-level="${level}">${inline(m[2], ctx)}</div>`;
      i++; continue;
    }

    if (RE_RULE.test(line)) { flushPara(); out += '<hr>'; i++; continue; }

    if ((m = RE_QUOTE.exec(line))) {
      flushPara();
      const buf = [];
      while (i < lines.length && (m = RE_QUOTE.exec(lines[i]))) { buf.push(m[1]); i++; }
      out += `<blockquote>${buf.map((l) => inline(l, ctx)).join('<br>')}</blockquote>`;
      continue;
    }

    if (isTableAt(lines, i)) {
      flushPara();
      const aligns = splitRow(lines[i + 1]).map(alignOf);
      const heads = splitRow(lines[i]);
      const cell = (tag, text, n) => {
        const a = aligns[n] ? ` style="text-align:${aligns[n]}"` : '';
        return `<${tag}${a}>${inline(text === undefined ? '' : text, ctx)}</${tag}>`;
      };
      let t = '<table><thead><tr>';
      heads.forEach((h, n) => { t += cell('th', h, n); });
      t += '</tr></thead><tbody>';
      i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].indexOf('|') >= 0) {
        const cells = splitRow(lines[i]);
        t += '<tr>';
        for (let n = 0; n < Math.max(cells.length, heads.length); n++) t += cell('td', cells[n], n);
        t += '</tr>';
        i++;
      }
      out += `${t}</tbody></table>`;
      continue;
    }

    // A run of list items, task or plain, ordered or not. Nesting is by
    // indentation, matching how the live page reads a pasted list.
    if (RE_TASKLINE.test(line) || RE_ULI.test(line) || RE_OLI.test(line)) {
      flushPara();
      const stack = []; // { indent, tag }
      while (i < lines.length) {
        const l = lines[i];
        if (!l.trim() || RE_FENCELINE.test(l)) break;
        let indent, body, tag, task = null;
        if ((m = RE_TASKLINE.exec(l))) {
          indent = m[1].replace(/\t/g, '    ').length;
          tag = 'ul';
          body = m[3];
          const state = items[taskIndex];
          // The event log is the authority; the text's own [x] is only the
          // fallback for a list nobody has touched since it was written.
          task = { checked: state ? !!state.checked : /x/i.test(m[2]), by: state ? state.by : null };
          taskIndex++;
        } else if ((m = RE_OLI.exec(l))) {
          indent = m[1].replace(/\t/g, '    ').length; tag = 'ol'; body = m[3];
        } else if ((m = RE_ULI.exec(l))) {
          indent = m[1].replace(/\t/g, '    ').length; tag = 'ul'; body = m[2];
        } else break;

        while (stack.length && indent < stack[stack.length - 1].indent) { out += `</li></${stack.pop().tag}>`; }
        const top = stack[stack.length - 1];
        if (!top || indent > top.indent) {
          out += `<${tag}${task ? ' class="tasks"' : ''}>`;
          stack.push({ indent, tag });
        } else {
          out += '</li>';
        }
        if (task) {
          const mark = task.checked
            ? '<span class="box on" aria-hidden="true">&#10003;</span>'
            : '<span class="box" aria-hidden="true"></span>';
          const label = task.checked ? 'checked' : 'unchecked';
          out += `<li class="task ${task.checked ? 'done' : ''}"><span class="sr">${label}: </span>${mark}<span>${inline(body, ctx)}</span>`;
        } else {
          out += `<li>${inline(body, ctx)}`;
        }
        i++;
      }
      while (stack.length) out += `</li></${stack.pop().tag}>`;
      continue;
    }

    para.push(line);
    i++;
  }
  flushPara();
  return out;
}

// ---------------------------------------------------------------- the page

const STYLE = `
:root {
  color-scheme: light dark;
  --bg:#f4f6f8; --fg:#14161a; --muted:#667085; --line:#dfe3e8; --panel:#ffffff;
  --accent:#2f6fed; --user-bg:#2f6fed; --user-fg:#ffffff; --code:#f2f4f7;
}
@media (prefers-color-scheme: dark) {
  :root { --bg:#0e1116; --fg:#e6e8ec; --muted:#98a2b3; --line:#232936; --panel:#151a22;
          --accent:#5b8dff; --user-bg:#2f6fed; --user-fg:#ffffff; --code:#1b212b; }
}
* { box-sizing: border-box; }
body {
  margin:0; background:var(--bg); color:var(--fg); padding:0 0 48px;
  font:16px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  -webkit-text-size-adjust:100%;
}
.wrap { max-width:820px; margin:0 auto; padding:0 16px; }
header { border-bottom:1px solid var(--line); background:var(--panel); padding:20px 0 16px; margin-bottom:20px; }
h1 { font-size:20px; margin:0 0 4px; }
.sub { color:var(--muted); font-size:13px; margin:0; }
.banner {
  margin:14px 0 0; padding:10px 12px; border-radius:10px; font-size:13px; line-height:1.5;
  background:#fff7ed; color:#7c2d12; border:1px solid #fed7aa;
}
@media (prefers-color-scheme: dark) { .banner { background:#2a1a0d; color:#fdba74; border-color:#7c2d12; } }
.msg { margin:0 0 18px; display:flex; flex-direction:column; }
.msg.user { align-items:flex-end; }
.meta { font-size:12px; color:var(--muted); margin:0 4px 4px; }
.bubble {
  max-width:100%; padding:10px 14px; border-radius:16px; overflow-wrap:anywhere;
  background:var(--panel); border:1px solid var(--line);
}
.msg.user .bubble { background:var(--user-bg); color:var(--user-fg); border-color:transparent; }
.msg.user .bubble a { color:#fff; text-decoration:underline; }
.bubble > :first-child { margin-top:0; }
.bubble > :last-child { margin-bottom:0; }
.bubble p { margin:0 0 10px; }
a { color:var(--accent); }
pre {
  background:var(--code); border:1px solid var(--line); border-radius:10px;
  padding:10px 12px; overflow-x:auto; margin:0 0 10px;
}
pre code { font-size:13px; }
code { font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size:.9em;
       background:var(--code); padding:1px 4px; border-radius:5px; }
.msg.user .bubble code { background:rgba(255,255,255,.18); }
.bubble pre { background:var(--code); }
.msg.user .bubble pre { background:rgba(0,0,0,.22); border-color:rgba(255,255,255,.18); }
.msg.user .bubble pre code { background:transparent; color:#fff; }
blockquote { margin:0 0 10px; padding:2px 0 2px 12px; border-left:3px solid var(--line); color:var(--muted); }
.h { font-weight:600; margin:14px 0 6px; }
.h1 { font-size:1.3em; } .h2 { font-size:1.18em; } .h3 { font-size:1.07em; }
.h4,.h5,.h6 { font-size:1em; }
hr { border:0; border-top:1px solid var(--line); margin:14px 0; }
ul,ol { margin:0 0 10px; padding-left:22px; }
ul.tasks { list-style:none; padding-left:2px; }
li.task { display:flex; align-items:flex-start; gap:8px; margin:3px 0; }
li.task.done > span:last-child { color:var(--muted); text-decoration:line-through; }
.box {
  flex:0 0 auto; width:16px; height:16px; margin-top:3px; border:1.5px solid var(--muted);
  border-radius:4px; display:inline-block; text-align:center; line-height:14px; font-size:12px;
}
.box.on { background:#16a34a; border-color:#16a34a; color:#fff; }
.sr { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; }
figure { margin:8px 0 0; }
figure img, .bubble img { max-width:100%; height:auto; border-radius:10px; display:block; border:1px solid var(--line); }
figcaption { font-size:12px; color:var(--muted); margin-top:4px; }
.omitted {
  font-size:13px; color:var(--muted); border:1px dashed var(--line);
  border-radius:10px; padding:10px 12px; margin:8px 0 0;
}
table { border-collapse:collapse; margin:0 0 10px; font-size:14px; display:block; overflow-x:auto; }
th,td { border:1px solid var(--line); padding:5px 9px; text-align:left; }
footer { color:var(--muted); font-size:12px; border-top:1px solid var(--line); margin-top:28px; padding-top:14px; }
`;

const fmtTime = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso || '');
  return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
};

/**
 * The whole published document.
 *
 * `images` is a Map of sha -> { dataUri, type, width, height, alt } or
 * -> { omitted: true, bytes } for anything that did not fit the size budget.
 */
function renderSnapshot(opts) {
  const { conv, entries, images, sharedAt, url } = opts;
  const title = (conv && (conv.title || conv.agent)) || 'Conversation';

  const imageHtml = (src, alt) => {
    const m = /^\/images\/([a-f0-9]{64})$/.exec(String(src || ''));
    if (!m) {
      // An external image URL would be a request off this page, which the CSP
      // forbids and the offline promise forbids. Show it as a link instead.
      const safe = safeHref(src);
      return safe ? linkHtml(safe, esc(alt || safe)) : esc(alt || '');
    }
    const im = images.get(m[1]);
    if (!im) return `<span class="omitted">Picture unavailable (${esc(m[1].slice(0, 12))}…)</span>`;
    if (im.omitted) {
      return `<div class="omitted">Picture omitted to keep this page under the size limit (${Math.round((im.bytes || 0) / 1024)} KB).</div>`;
    }
    const dims = (im.width && im.height) ? ` width="${im.width}" height="${im.height}"` : '';
    return `<img src="${im.dataUri}" alt="${esc(alt || im.alt || 'attached picture')}"${dims} loading="lazy">`;
  };
  const ctx = { image: imageHtml };

  let body = '';
  for (const e of entries) {
    const who = e.role === 'agent' ? (e.author || conv.agent || 'agent') : 'you';
    const cls = e.role === 'agent' ? 'agent' : 'user';
    body += `<div class="msg ${cls}">`;
    body += `<p class="meta">${esc(who)} &middot; ${esc(fmtTime(e.ts))}</p>`;
    body += '<div class="bubble">';
    body += blocks(e.text, ctx, e.checklist);
    if (Array.isArray(e.images) && e.images.length) {
      for (const im of e.images) {
        body += `<figure>${imageHtml(`/images/${im.id}`, im.alt)}`;
        if (im.alt) body += `<figcaption>${esc(im.alt)}</figcaption>`;
        body += '</figure>';
      }
    }
    body += '</div></div>';
  }
  if (!entries.length) body = '<p class="sub">This conversation had no messages when it was shared.</p>';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow, noarchive">
<!--
  Belt and braces with the header the Function sends. This copy keeps the
  guarantee if the file is ever saved to disk and reopened from file://:
  no scripts, no network, pictures only from the data: URIs already inside it.
-->
<meta http-equiv="content-security-policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<header><div class="wrap">
  <h1>${esc(title)}</h1>
  <p class="sub">${entries.length} message${entries.length === 1 ? '' : 's'} &middot; shared ${esc(fmtTime(sharedAt))}</p>
  <p class="banner"><strong>This is a snapshot, not a live view.</strong>
  It was copied out of a private relay at the time above and will not change as
  the conversation continues. Anyone with this link can read it.</p>
</div></header>
<main class="wrap">
${body}
</main>
<footer class="wrap">
  Snapshot of a relay-queue conversation, published ${esc(fmtTime(sharedAt))}.
  ${url ? `Permanent link: ${esc(url)}` : ''}
</footer>
</body>
</html>
`;
}

// ---------------------------------------------------------------- transport

async function putSnapshot(cfg, slug, html, title) {
  const res = await fetch(`${cfg.endpoint}/s/${slug}`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${cfg.token}`,
      'content-type': 'text/html; charset=utf-8',
      'x-share-title': String(title || '').replace(/[^\x20-\x7e]/g, '').slice(0, 200),
    },
    body: html,
  });
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 300);
    try { detail = JSON.parse(text).error || detail; } catch { /* not JSON */ }
    throw Object.assign(new Error(`share host refused the snapshot (HTTP ${res.status}): ${detail}`), { code: 502 });
  }
  try { return JSON.parse(text); } catch { return {}; }
}

async function deleteSnapshot(cfg, slug) {
  const res = await fetch(`${cfg.endpoint}/s/${slug}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${cfg.token}` },
  });
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 300);
    try { detail = JSON.parse(text).error || detail; } catch { /* not JSON */ }
    throw Object.assign(new Error(`share host refused the revoke (HTTP ${res.status}): ${detail}`), { code: 502 });
  }
  try { return JSON.parse(text); } catch { return {}; }
}

// ---------------------------------------------------------------- routes
/*
 * `ctx` is everything from server.js this module is allowed to touch, passed in
 * rather than reached for. Same shape of boundary as push.js: the protocol and
 * the rendering live here, the state and the log live there.
 */

/** What is about to become public — the preflight the UI shows before publishing. */
function preflight(ctx) {
  const { entries } = ctx;
  const imageIds = collectImageIds(entries);
  let bytes = 0;
  for (const id of imageIds) {
    const meta = ctx.blobs.get(id);
    if (meta && meta.bytes) bytes += meta.bytes;
  }
  const times = entries.map((e) => e.ts).filter(Boolean).sort();
  return {
    messages: entries.length,
    images: imageIds.length,
    imageBytes: bytes,
    first: times[0] || null,
    last: times[times.length - 1] || null,
    authors: [...new Set(entries.map((e) => (e.role === 'agent' ? (e.author || 'agent') : 'you')))],
    findings: scanSecrets(entries),
  };
}

function stateRoute(res, ctx) {
  const cfg = loadConfig(ctx.DATA_DIR);
  const current = ctx.shares.get(ctx.conv.id) || null;
  return ctx.send(res, 200, {
    conversationId: ctx.conv.id,
    shared: !!current,
    share: current,
    configured: cfg.configured,
    endpoint: cfg.endpoint || null,
    reason: cfg.configured ? null : cfg.reason,
    live: false, // said out loud, in the API too: a share is always a copy
    preflight: preflight(ctx),
  });
}

async function publishRoute(res, ctx, body) {
  const cfg = loadConfig(ctx.DATA_DIR);
  if (!cfg.configured) {
    return ctx.fail(res, 503, `sharing is not configured: ${cfg.reason}`, {
      expected: path.join(ctx.DATA_DIR, CONFIG_FILE),
      shape: { endpoint: DEFAULT_ENDPOINT, token: '<the SHARE_TOKEN secret from share-site>' },
    });
  }
  const { conv, entries } = ctx;

  /*
   * Re-sharing keeps the SAME slug, so a link he already sent someone keeps
   * working and simply shows newer content. A fresh slug per publish would
   * silently strand every copy of the old URL.
   */
  const existing = ctx.shares.get(conv.id);
  const slug = (existing && existing.slug) || newSlug();
  const url = `${cfg.endpoint}/s/${slug}`;

  // Pull the bytes off disk and inline them, within a budget.
  const images = new Map();
  let budget = MAX_SNAPSHOT_BYTES;
  let omitted = 0;
  for (const id of collectImageIds(entries)) {
    const meta = ctx.blobs.get(id) || {};
    let buf = null;
    try { buf = fs.readFileSync(ctx.imagePath(id)); } catch { buf = null; }
    if (!buf) { images.set(id, { omitted: true, bytes: meta.bytes || 0 }); omitted++; continue; }
    // base64 is 4 bytes out for every 3 in.
    const cost = Math.ceil(buf.length / 3) * 4;
    if (cost > budget) { images.set(id, { omitted: true, bytes: buf.length }); omitted++; continue; }
    budget -= cost;
    images.set(id, {
      dataUri: `data:${meta.type || 'image/png'};base64,${buf.toString('base64')}`,
      type: meta.type || null,
      width: meta.width || null,
      height: meta.height || null,
      alt: meta.alt || null,
    });
  }

  const sharedAt = ctx.nowIso();
  const html = renderSnapshot({ conv, entries, images, sharedAt, url });
  const result = await putSnapshot(cfg, slug, html, conv.title || conv.agent || 'conversation');

  const record = {
    conversationId: conv.id,
    slug,
    url,
    sharedAt,
    by: (body && typeof body.by === 'string' && body.by.slice(0, 200)) || null,
    messages: entries.length,
    images: images.size - omitted,
    imagesOmitted: omitted,
    bytes: (result && result.bytes) || Buffer.byteLength(html),
  };
  ctx.appendEvent({ t: 'share', share: record });

  return ctx.send(res, 200, {
    ...record,
    live: false,
    note: 'This is a snapshot. It will not update as the conversation continues — share again to refresh it.',
    findings: scanSecrets(entries),
  });
}

async function revokeRoute(res, ctx) {
  const current = ctx.shares.get(ctx.conv.id);
  if (!current) return ctx.fail(res, 404, `conversation "${ctx.conv.id}" is not shared`);
  const cfg = loadConfig(ctx.DATA_DIR);
  if (!cfg.configured) return ctx.fail(res, 503, `sharing is not configured: ${cfg.reason}`);
  await deleteSnapshot(cfg, current.slug);
  ctx.appendEvent({ t: 'unshare', conversationId: ctx.conv.id, slug: current.slug, at: ctx.nowIso() });
  return ctx.send(res, 200, { ok: true, conversationId: ctx.conv.id, slug: current.slug, revoked: true });
}

module.exports = {
  DEFAULT_ENDPOINT,
  MAX_SNAPSHOT_BYTES,
  newSlug,
  loadConfig,
  scanSecrets,
  collectImageIds,
  renderSnapshot,
  inline,
  blocks,
  preflight,
  stateRoute,
  publishRoute,
  revokeRoute,
};
