'use strict';
/*
 * share-selftest — prove a published snapshot is honest and self-contained.
 *
 *   node tools/share-selftest.js
 *
 * The request was "a public URL that shows this conversation, including links,
 * even when my computer is offline". Everything load-bearing in that sentence
 * is checkable here, without a network and without a server, because the
 * snapshot is a pure function of the thread projection:
 *
 *   1. IT CANNOT PHONE HOME. "Offline" is the whole feature. If a single
 *      `/images/<sha>` src, or any localhost URL, survives into the published
 *      HTML, then the page is broken exactly when he needs it and looks fine
 *      while his machine is up — the worst possible failure mode.
 *   2. TICKS COME FROM THE EVENT LOG, NOT THE TEXT. Ticking a box in the UI
 *      never rewrites the message, so a renderer that trusts the `[x]` in the
 *      text publishes a list in the wrong state. This is asserted in BOTH
 *      directions, because trusting the text passes a one-directional test.
 *   3. PICTURES TRAVEL. They are sha256 blobs on his disk. A public page that
 *      404s every picture is a failed feature, so an image is either inlined as
 *      a data: URI or replaced by a VISIBLE placeholder — never a dead src.
 *
 * The localhost check has a negative control. A test that has never been seen
 * to fail is not evidence, and "no localhost in the output" is exactly the kind
 * of assertion that passes forever because the string could never have appeared.
 *
 * Nothing here touches the real data directory, the network, or the running
 * server. Zero dependencies.
 */
const share = require('../share.js');

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}`);
  if (!ok && detail !== undefined) console.log(`        ${String(detail).slice(0, 300)}`);
}

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const conv = { id: 'conv1', title: 'Trip planning', agent: 'coordinator' };

const entries = [
  {
    id: 'e1', role: 'user', ts: '2026-08-16T10:00:00.000Z',
    text: 'See [the docs](https://example.com/a?x=1&y=2), plain https://bare.example.com/p, '
      + 'and <script>alert(1)</script> for good measure.',
  },
  {
    id: 'e2', role: 'agent', author: 'coordinator', ts: '2026-08-16T10:01:00.000Z',
    // The text says the FIRST is unticked and the SECOND is ticked. The log below
    // says the opposite of both. The published page must follow the log.
    text: '## Packing\n- [ ] passport\n- [x] socks\n\n```sh\ncurl http://localhost:3901/thread\n```\n\n> a **quoted** note',
    checklist: {
      total: 2, done: 1,
      items: [
        { index: 0, label: 'passport', checked: true, by: 'him' },
        { index: 1, label: 'socks', checked: false, by: null },
      ],
    },
  },
  {
    id: 'e3', role: 'agent', ts: '2026-08-16T10:02:00.000Z',
    text: `Inline: ![shot](/images/${SHA_A})`,
    images: [{ id: SHA_A, alt: 'the shot', width: 10, height: 5 }],
  },
  {
    id: 'e4', role: 'agent', ts: '2026-08-16T10:03:00.000Z',
    text: `Missing on disk: ![gone](/images/${SHA_B})`,
  },
];

const images = new Map([
  [SHA_A, { dataUri: 'data:image/png;base64,iVBORw0KGgo=', type: 'image/png', width: 10, height: 5, alt: 'the shot' }],
  [SHA_B, { omitted: true, bytes: 4096 }],
]);

const render = (es) => share.renderSnapshot({
  conv, entries: es, images, sharedAt: '2026-08-16T10:05:00.000Z',
  url: 'https://relay-share-bkf.pages.dev/s/abcdefghijklmnopqrstuv',
});

const html = render(entries);

/*
 * THE AUDITOR.
 *
 * The distinction it draws is the one that matters, and a cruder check gets it
 * wrong in both directions. A localhost URL printed as TEXT — inside a code
 * fence, where he pasted the curl command that produced the thread — is not a
 * leak; it is content, and stripping it would be vandalism. A localhost URL in
 * a position the browser will FETCH is the entire failure this feature exists
 * to avoid. So this looks only at fetchable positions: attributes that load
 * something, script elements, inline event handlers, and CSS url().
 */
const AUDIT = new RegExp([
  '(?:src|href|action|poster|srcset|data|formaction)\\s*=\\s*["\'][^"\']*(?:localhost|127\\.0\\.0\\.1|:3901|/images/)',
  '<script[\\s>]',
  '\\son[a-z]+\\s*=\\s*["\']',
  'url\\(\\s*["\']?(?:https?:|//|/images/)',
].join('|'), 'i');
const leakOf = (doc) => (doc.match(AUDIT) || [null])[0];

console.log('\nself-containment — the page must not be able to call home');
check('nothing fetchable points at the relay', !AUDIT.test(html), leakOf(html));
check('the code fence still SHOWS the localhost URL as text', html.includes('http://localhost:3901/thread'),
  'the snapshot should quote his commands, just never fetch them');
check('...and that URL is not in an href', !/href="[^"]*localhost/.test(html));
check('every img src is a data: URI', (html.match(/<img[^>]+src="([^"]*)"/g) || [])
  .every((t) => /src="data:/.test(t)), html.match(/<img[^>]+>/g));
check('no stylesheet, font or other external link', !/<link\b/i.test(html));

/*
 * NEGATIVE CONTROLS. An assertion nobody has watched go red is not evidence.
 * These plant exactly the regressions the auditor exists to catch — a real
 * attribute, not escaped text — and fail the suite if it sleeps through them.
 */
const planted = [
  ['an <img> pointing back at the relay', html.replace('</main>', '<img src="http://localhost:3901/images/x.png"></main>')],
  ['an unresolved /images/ src', html.replace('</main>', `<img src="/images/${SHA_A}"></main>`)],
  ['a re-introduced <script>', html.replace('</main>', '<script src="/app.js"></script></main>')],
  ['an inline event handler', html.replace('</main>', '<div onload="fetch(1)"></div></main>')],
];
for (const [what, doc] of planted) {
  check(`CONTROL: the auditor catches ${what}`, AUDIT.test(doc),
    'the leak check slept through a planted regression, so it proves nothing');
}

console.log('\nchecklists — the event log is the authority, not the text');
check('text "[ ]" renders TICKED when the log says ticked', /box on[\s\S]{0,140}passport/.test(html));
check('text "[x]" renders UNTICKED when the log says unticked',
  /<span class="box" aria-hidden="true"><\/span><span>socks/.test(html));
check('the ticked item is struck through', /class="task done"/.test(html));
check('tick state is announced to screen readers', html.includes('checked: ') && html.includes('unchecked: '));

console.log('\nlinks — he asked for these specifically');
check('markdown link, with & escaped in the query', html.includes('href="https://example.com/a?x=1&amp;y=2"'));
check('a bare URL becomes a link', html.includes('href="https://bare.example.com/p"'));
check('links open safely', /rel="noopener noreferrer nofollow"/.test(html));
check('javascript: is refused', !/href="javascript:/i.test(share.inline('[x](javascript:alert(1))', { image: () => '' })));

console.log('\nescaping');
check('a script tag in his text is inert', html.includes('&lt;script&gt;') && !/<script[\s>]/i.test(html));

console.log('\nimages travel with the snapshot');
check('the present one is inlined', html.includes('data:image/png;base64,iVBORw0KGgo='));
check('the missing one is a VISIBLE placeholder, not a dead link',
  /class="omitted"/.test(html) && !html.includes(`/images/${SHA_B}`));
check('the attachment keeps its caption', html.includes('the shot'));

console.log('\nit says what it is');
check('the page says it is a snapshot, not live', /snapshot, not a live view/i.test(html));
check('the page says anyone with the link can read it', /Anyone with this link/i.test(html));
check('it is dated', html.includes('2026-08-16 10:05 UTC'));

console.log('\nslugs are unguessable');
const slugs = new Set();
for (let i = 0; i < 5000; i++) slugs.add(share.newSlug());
check('5000 slugs, no collision', slugs.size === 5000);
check('22 chars of base64url (128 bits)', /^[A-Za-z0-9_-]{22}$/.test(share.newSlug()), share.newSlug());

console.log('\nsecret scan is advisory only');
const findings = share.scanSecrets([{ id: 'x', text: 'key=sk-ant-abcdefghijklmnop1234567 and Authorization: Bearer zzzzzzzzzzzzzz' }]);
check('it finds an obvious token', findings.some((f) => /Anthropic/.test(f.kind)), JSON.stringify(findings));
check('it finds an Authorization header', findings.some((f) => /Authorization/.test(f.kind)));
check('the example is masked, not the whole secret',
  findings.every((f) => !f.example || f.example.includes('…')), JSON.stringify(findings));
check('it does NOT alter the text it scanned',
  render(entries).includes('passport'), 'scanning must never redact');
check('a clean thread reports nothing', share.scanSecrets([{ id: 'y', text: 'just a normal sentence' }]).length === 0);

console.log(failures ? `\n${failures} check(s) FAILED\n` : '\nall checks passed\n');
process.exit(failures ? 1 : 0);
