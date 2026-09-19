'use strict';
/*
 * folder-scopes-selftest — the server half of folder scopes.
 *
 *   node tools/folder-scopes-selftest.js
 *
 * A conversation carries `path`, a folder relative to the owner's home. The
 * page at `/Projects/x` lists only conversations in that folder and below, and
 * autoseat runs the seat's coordinator there. Everything that makes that safe
 * on the server is asserted here, against a real server on a scratch DATA_DIR
 * and an OS-assigned port (see harness-lib — never 3901, never real data):
 *
 *   - one normaliser for the field AND the `?path=` filter: a leading/trailing
 *     slash is forgiven, anything else non-canonical is a 400;
 *   - the filter is a whole-segment prefix: `Projects` must not list
 *     `ProjectsOld`, which a plain startsWith would;
 *   - a record from before folder scopes (no `path` at all in the log) reads
 *     as the root, with no log rewrite;
 *   - a browser navigation to a deep path gets the app page, while curl and
 *     fetch() still get the honest JSON 404 and every real route is untouched.
 *
 * Zero dependencies. Node built-ins only.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { startServer } = require('./harness-lib');

let failures = 0;
let passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; console.log(`  ok   ${name}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/*
 * A hand-written old log: a conversation record from before `path` existed,
 * and a patch to it that also predates it. Written BEFORE boot, so replay is
 * what has to make sense of it.
 */
const LEGACY_ID = 'legacy-conv-1';
function writeLegacyLog(dir) {
  const lines = [
    { t: 'conv', conv: { id: LEGACY_ID, title: 'from before scopes', agent: null, createdAt: '2026-01-01T00:00:00.000Z', archived: false, archivedAt: null } },
    { t: 'convpatch', id: LEGACY_ID, patch: { title: 'renamed before scopes' } },
  ];
  fs.writeFileSync(path.join(dir, 'events.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

async function withServer(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-scopes-'));
  writeLegacyLog(dir);
  const srv = await startServer({ dir, label: 'scopes' });
  const call = async (method, p, body, headers) => {
    const r = await fetch(srv.base + p, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(headers || {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON: the page, say */ }
    return { status: r.status, type: r.headers.get('content-type') || '', headers: r.headers, text, json };
  };

  /** A GET with exactly these headers and no others the client decided to add. */
  const raw = (p, headers) => new Promise((resolve, reject) => {
    const req = http.request(srv.base + p, { headers }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'] || '' }));
    });
    req.on('error', reject);
    req.end();
  });

  const inflight = [];
  function listen() {
    const frames = [];
    const req = http.request(`${srv.base}/events`, { headers: { accept: 'text/event-stream' } }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const line = frame.split('\n').find((l) => l.startsWith('data: '));
          if (!line) continue;
          try { frames.push(JSON.parse(line.slice(6))); } catch { /* not JSON */ }
        }
      });
    });
    req.on('error', () => {});
    req.end();
    inflight.push(req);
    return frames;
  }

  try {
    await fn({ call, raw, listen, dir });
  } catch (err) {
    process.stderr.write(`\n[server output]\n${srv.out}\n`);
    throw err;
  } finally {
    for (const req of inflight) req.destroy();
    await srv.stop();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* windows may hold the log */ }
  }
}

const ids = (list) => (list || []).map((c) => c.id).sort();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function main() {
  await withServer(async (s) => {
    console.log('\nlegacy records read as the home root');
    const legacy = await s.call('GET', `/conversations/${LEGACY_ID}`);
    check('a conversation logged without `path` replays', legacy.status === 200, `${legacy.status} ${legacy.text}`);
    check('...and reads path ""', legacy.json && legacy.json.path === '', JSON.stringify(legacy.json && legacy.json.path));
    const main0 = await s.call('GET', '/conversations/main');
    check('the in-memory default conversation has path ""', main0.json && main0.json.path === '', JSON.stringify(main0.json));

    console.log('\ncreate with a path, and the normaliser');
    const made = {};
    for (const [key, p, want] of [
      ['plain', 'Projects/relay-queue', 'Projects/relay-queue'],
      ['slashes', '/Projects/relay-queue/sub/', 'Projects/relay-queue/sub'],
      ['projects', 'Projects', 'Projects'],
      ['old', 'ProjectsOld/thing', 'ProjectsOld/thing'],
      ['spaced', 'Projects/with space ', 'Projects/with space '],
      ['dotted', '.config/app', '.config/app'],
    ]) {
      const r = await s.call('POST', '/conversations', { title: `conv ${key}`, path: p });
      made[key] = r.json;
      check(`create path ${JSON.stringify(p)} -> ${JSON.stringify(want)}`,
        r.status === 201 && r.json.path === want, `${r.status} ${r.text}`);
    }
    for (const [label, p] of [['absent', undefined], ['null', null], ['empty', ''], ['lone slash', '/']]) {
      const body = { title: `root ${label}` };
      if (p !== undefined) body.path = p;
      const r = await s.call('POST', '/conversations', body);
      made[`root-${label}`] = r.json;
      check(`create with path ${label} -> root ""`, r.status === 201 && r.json.path === '', `${r.status} ${r.text}`);
    }
    for (const [label, p] of [
      ['a number', 42],
      ['an object', { a: 1 }],
      ['a doubled slash', 'a//b'],
      ['two leading slashes', '//a'],
      ['two trailing slashes', 'a//'],
      ['a lone double slash', '//'],
      ['a . segment', 'a/./b'],
      ['a .. segment', '../etc'],
      ['a trailing ..', 'Projects/..'],
      ['a lone .', '.'],
      ['a backslash', 'Projects\\relay-queue'],
      ['a NUL', 'a\u0000b'],
      ['a newline', 'a\nb'],
      ['a DEL', 'a\u007fb'],
      ['over 1024 chars', 'x'.repeat(1025)],
    ]) {
      const r = await s.call('POST', '/conversations', { title: `bad ${label}`, path: p });
      check(`create refuses ${label} with 400`, r.status === 400 && /path/.test(r.json && r.json.error), `${r.status} ${r.text}`);
    }
    const after = await s.call('GET', '/conversations?archived=1');
    check('no refused create left a record behind',
      after.json.conversations.every((c) => !/^bad /.test(c.title)), JSON.stringify(ids(after.json.conversations)));

    console.log('\nthe list filter');
    const list = async (qs) => (await s.call('GET', `/conversations${qs}`)).json;
    const all = await list('');
    check('no ?path= lists everything (incl. main and the legacy one)',
      all.conversations.some((c) => c.id === 'main') && all.conversations.some((c) => c.id === LEGACY_ID)
      && all.conversations.some((c) => c.id === made.old.id), JSON.stringify(ids(all.conversations)));
    check('?path= empty is the same as absent', same(ids((await list('?path=')).conversations), ids(all.conversations)));
    check('?path=/ is the same as absent', same(ids((await list('?path=%2F')).conversations), ids(all.conversations)));
    const proj = await list('?path=Projects');
    check('?path=Projects lists the folder itself and every descendant',
      same(ids(proj.conversations), ids([made.plain, made.slashes, made.projects, made.spaced])), JSON.stringify(ids(proj.conversations)));
    check('?path=Projects does NOT list ProjectsOld (whole segments only)',
      proj.conversations.every((c) => c.id !== made.old.id));
    check('?path=Projects does not list root conversations',
      proj.conversations.every((c) => c.path !== ''));
    const deep = await list('?path=Projects/relay-queue');
    check('?path=Projects/relay-queue lists it and its sub-folder, not its parent',
      same(ids(deep.conversations), ids([made.plain, made.slashes])), JSON.stringify(ids(deep.conversations)));
    const slashed = await list('?path=%2FProjects%2Frelay-queue%2F');
    check('the filter is normalised like the field (slashes at the ends)',
      same(ids(slashed.conversations), ids(deep.conversations)));
    const encSpace = await list(`?path=${encodeURIComponent('Projects/with space ')}`);
    check('a folder with a trailing space is its own scope',
      same(ids(encSpace.conversations), ids([made.spaced])), JSON.stringify(ids(encSpace.conversations)));
    const none = await list('?path=Nowhere');
    check('a scope with nothing in it is an empty list, not an error', none.count === 0 && none.conversations.length === 0);
    for (const bad of ['a//b', '..', 'a%5Cb', 'a%00b']) {
      const r = await s.call('GET', `/conversations?path=${bad}`);
      check(`?path=${bad} is a 400`, r.status === 400 && /path/.test(r.json && r.json.error), `${r.status} ${r.text}`);
    }

    console.log('\npatching path');
    const moved = await s.call('POST', `/conversations/${made.old.id}`, { path: '/Projects/moved/' });
    check('patch path normalises and applies', moved.status === 200 && moved.json.path === 'Projects/moved', `${moved.status} ${moved.text}`);
    check('the moved conversation now lists under Projects',
      (await list('?path=Projects')).conversations.some((c) => c.id === made.old.id));
    const badPatch = await s.call('POST', `/conversations/${made.old.id}`, { path: 'a/../b' });
    check('patch with an invalid path is a 400', badPatch.status === 400, `${badPatch.status} ${badPatch.text}`);
    check('...and changed nothing', (await s.call('GET', `/conversations/${made.old.id}`)).json.path === 'Projects/moved');
    const badPatchMixed = await s.call('POST', `/conversations/${made.old.id}`, { title: 'should not land', path: 7 });
    check('a bad path refuses the WHOLE patch, title included',
      badPatchMixed.status === 400 && (await s.call('GET', `/conversations/${made.old.id}`)).json.title === 'conv old');
    const toRoot = await s.call('POST', `/conversations/${made.old.id}`, { path: null });
    check('patch path null moves it to the root', toRoot.status === 200 && toRoot.json.path === '', toRoot.text);
    const mainMoved = await s.call('POST', '/conversations/main', { path: 'Projects/relay-queue' });
    check('path can be set on main (it is only a label)', mainMoved.status === 200 && mainMoved.json.path === 'Projects/relay-queue', mainMoved.text);
    await s.call('POST', '/conversations/main', { path: '' });
    const legacyMoved = await s.call('POST', `/conversations/${LEGACY_ID}`, { path: 'Projects/legacy' });
    check('a legacy conversation can be given a path', legacyMoved.status === 200 && legacyMoved.json.path === 'Projects/legacy', legacyMoved.text);
    const nothing = await s.call('POST', `/conversations/${made.plain.id}`, {});
    check('an empty patch still says what can be updated, path included',
      nothing.status === 400 && /\bpath\b/.test(nothing.json.error), nothing.text);

    console.log('\nstacking with the archived filter');
    await s.call('POST', `/conversations/${made.slashes.id}`, { archived: true });
    const live = await list('?path=Projects/relay-queue');
    check('scoped list hides the archived one by default', same(ids(live.conversations), ids([made.plain])), JSON.stringify(ids(live.conversations)));
    const inc = await list('?path=Projects/relay-queue&archived=1');
    check('scoped + archived=1 includes it', same(ids(inc.conversations), ids([made.plain, made.slashes])), JSON.stringify(ids(inc.conversations)));
    const only = await list('?path=Projects/relay-queue&archived=only');
    check('scoped + archived=only is just the archived one in scope', same(ids(only.conversations), ids([made.slashes])), JSON.stringify(ids(only.conversations)));
    const onlyElsewhere = await list('?path=ProjectsOld&archived=only');
    check('archived=only in a different scope does not leak it', onlyElsewhere.count === 0, JSON.stringify(ids(onlyElsewhere.conversations)));

    console.log('\nGET /folders: immediate children with conversations at or below them');
    const tree = {};
    for (const [key, p] of [
      ['self', 'Tree'], ['alpha', 'Tree/alpha'], ['alphaDeep', 'Tree/alpha/deep/er'],
      ['alphabet', 'Tree/alphabet'], ['betaX', 'Tree/beta/x'], ['betaY', 'Tree/beta/y'], ['old', 'TreeOld/z'],
    ]) tree[key] = (await s.call('POST', '/conversations', { title: `tree ${key}`, path: p })).json;
    // One waiting message under alpha, and one answered-but-unrelayed one.
    await s.call('POST', '/tasks', { conversationId: tree.alphaDeep.id, text: 'waiting', from: 'test' });
    const answered = (await s.call('POST', '/tasks', { conversationId: tree.alpha.id, text: 'to answer', from: 'test' })).json;
    await s.call('POST', `/tasks/${answered.id}/claim`, { by: 'tester' });
    const resd = await s.call('POST', `/tasks/${answered.id}/result`, { by: 'tester', result: 'answered' });
    check('fixture: a result was posted', resd.status === 200, `${resd.status} ${resd.text.slice(0, 200)}`);
    await s.call('POST', `/conversations/${tree.betaX.id}`, { archived: true });

    const folders = async (qs) => s.call('GET', `/folders${qs}`);
    const t = await folders('?path=Tree');
    const byName = Object.fromEntries(((t.json && t.json.folders) || []).map((f) => [f.name, f]));
    check('/folders?path=Tree answers 200 with the normalised scope', t.status === 200 && t.json.path === 'Tree', t.text.slice(0, 300));
    check('only IMMEDIATE children, sorted by name, whole segments (alpha and alphabet apart)',
      same((t.json.folders || []).map((f) => f.name), ['alpha', 'alphabet', 'beta']), JSON.stringify(t.json.folders));
    check('each child carries its full home-relative path',
      byName.alpha && byName.alpha.path === 'Tree/alpha' && byName.beta.path === 'Tree/beta', JSON.stringify(byName.alpha));
    check('conversations counts everything at or below the child (alpha: itself + deep/er)',
      byName.alpha && byName.alpha.conversations === 2, JSON.stringify(byName.alpha));
    /*
     * Same meaning as the list route's own counters, by construction: `unread`
     * is `counts.unrelayed`, which includes messages still waiting, not only
     * answers. So compare against what GET /conversations says for the folder.
     */
    const alphaRows = (await list('?path=Tree/alpha')).conversations;
    const sum = (k) => alphaRows.reduce((n, c) => n + c.counts[k], 0);
    check('pending and unread are the sums of the list route\'s counters for that folder',
      byName.alpha && byName.alpha.pending === sum('pending') && byName.alpha.unread === sum('unrelayed')
      && byName.alpha.pending === 1 && byName.alpha.unread >= 1, `${JSON.stringify(byName.alpha)} vs pending ${sum('pending')} unrelayed ${sum('unrelayed')}`);
    check('archived conversations are excluded by default (beta counts only y)',
      byName.beta && byName.beta.conversations === 1, JSON.stringify(byName.beta));
    check('a conversation filed AT the scope is not a child folder, and TreeOld is not under Tree',
      !byName[''] && !byName.Tree && !byName.z && !byName.TreeOld, JSON.stringify(t.json.folders));
    const withArch = await folders('?path=Tree&archived=1');
    check('archived=1 counts the archived one too',
      (withArch.json.folders.find((f) => f.name === 'beta') || {}).conversations === 2, JSON.stringify(withArch.json.folders));
    const onlyArch = await folders('?path=Tree&archived=only');
    check('archived=only leaves just the folder holding an archived one',
      same(onlyArch.json.folders.map((f) => [f.name, f.conversations]), [['beta', 1]]), JSON.stringify(onlyArch.json.folders));
    const rootF = await folders('');
    const rootNames = (rootF.json.folders || []).map((f) => f.name);
    check('no ?path= is the home root: top-level folders only',
      rootF.json.path === '' && rootNames.includes('Tree') && rootNames.includes('TreeOld') && rootNames.includes('Projects')
      && rootNames.every((n) => n && n.indexOf('/') < 0), JSON.stringify(rootNames));
    check('the root list is sorted', same(rootNames, rootNames.slice().sort()), JSON.stringify(rootNames));
    const slashScope = await folders('?path=%2FTree%2F');
    check('the scope is normalised like everywhere else', slashScope.json && slashScope.json.path === 'Tree'
      && same(slashScope.json.folders, t.json.folders));
    const leaf = await folders('?path=Tree/alphabet');
    check('a leaf folder has no children', leaf.status === 200 && leaf.json.folders.length === 0, leaf.text.slice(0, 200));
    for (const bad of ['a//b', '..', 'a%5Cb']) {
      const r = await folders(`?path=${bad}`);
      check(`/folders?path=${bad} is a 400`, r.status === 400 && /path/.test(r.json && r.json.error), `${r.status} ${r.text}`);
    }
    check('POST /folders is a 405', (await s.call('POST', '/folders', { x: 1 })).status === 405);
    const htmlFolders = await s.call('GET', '/folders', null, { accept: 'text/html' });
    check('/folders is a real route: Accept text/html still gets JSON, not the page',
      htmlFolders.status === 200 && htmlFolders.json && Array.isArray(htmlFolders.json.folders), htmlFolders.type);

    console.log('\nSSE conversation frames carry path');
    const frames = s.listen();
    await sleep(300);
    await s.call('POST', `/conversations/${made.projects.id}`, { path: 'Projects/sse-check' });
    const created = await s.call('POST', '/conversations', { title: 'sse create', path: 'Projects/sse-new' });
    await sleep(300);
    const patchFrame = frames.find((f) => f.conversation && f.conversation.id === made.projects.id);
    check('a patch frame carries the new path',
      patchFrame && patchFrame.conversation.path === 'Projects/sse-check', JSON.stringify(patchFrame));
    const createFrame = frames.find((f) => f.conversation && f.conversation.id === created.json.id);
    check('a create frame carries the path',
      createFrame && createFrame.conversation.path === 'Projects/sse-new', JSON.stringify(createFrame));

    console.log('\npage routing: a deep path is the app for a browser, a 404 for everyone else');
    const page = await s.call('GET', '/Projects/foo', null, { accept: 'text/html,application/xhtml+xml,*/*;q=0.8' });
    const root = await s.call('GET', '/', null, { accept: 'text/html' });
    check('/ still serves the page', root.status === 200 && /text\/html/.test(root.type), `${root.status} ${root.type}`);
    check('Accept: text/html on /Projects/foo gets the page', page.status === 200 && /text\/html/.test(page.type), `${page.status} ${page.type}`);
    check('...byte for byte the page / serves', page.text === root.text);
    check('...stamped as the app shell for the service worker', page.headers.get('x-relay-app') === '1');
    check('...and it says it varies by Accept', /accept/i.test(page.headers.get('vary') || ''), page.headers.get('vary'));
    // Raw http, not fetch(): fetch stamps its own `sec-fetch-mode: cors` over ours.
    const nav = await s.raw('/Projects/foo/bar', { 'sec-fetch-mode': 'navigate', accept: '*/*' });
    check('Sec-Fetch-Mode: navigate alone also gets the page', nav.status === 200 && /text\/html/.test(nav.type), `${nav.status} ${nav.type}`);
    const bare = await s.raw('/Projects/foo/bar', {});
    check('a request with no Accept at all gets the JSON 404', bare.status === 404 && /application\/json/.test(bare.type), `${bare.status} ${bare.type}`);
    const curl = await s.call('GET', '/Projects/foo', null, { accept: '*/*' });
    check('a curl-style request (Accept */*) still gets the JSON 404',
      curl.status === 404 && /application\/json/.test(curl.type) && /no route/.test(curl.json && curl.json.error), `${curl.status} ${curl.text.slice(0, 200)}`);
    const js = await s.call('GET', '/Projects/foo', null, { accept: 'application/json' });
    check('Accept: application/json gets the JSON 404', js.status === 404 && js.json, `${js.status}`);
    const post = await s.call('POST', '/Projects/foo', { x: 1 }, { accept: 'text/html' });
    check('a POST to a deep path is still a 404 even with Accept text/html', post.status === 404, `${post.status}`);

    console.log('\nreal routes are not shadowed by the fallback');
    const htmlAccept = { accept: 'text/html' };
    const health = await s.call('GET', '/health', null, htmlAccept);
    check('/health with Accept text/html is still JSON', health.status === 200 && health.json && health.json.status === 'ok', health.type);
    const convs = await s.call('GET', '/conversations', null, htmlAccept);
    check('/conversations with Accept text/html is still the JSON list', convs.status === 200 && convs.json && Array.isArray(convs.json.conversations));
    const unknownConv = await s.call('GET', '/conversations/does-not-exist', null, htmlAccept);
    check('/conversations/:unknown is still its own JSON 404, not the page',
      unknownConv.status === 404 && unknownConv.json && /no conversation/.test(unknownConv.json.error), unknownConv.text.slice(0, 200));
    const unknownTask = await s.call('GET', '/tasks/nope', null, htmlAccept);
    check('/tasks/:unknown is still its own JSON 404', unknownTask.status === 404 && unknownTask.json, unknownTask.type);
    const sw = await s.call('GET', '/sw.js', null, htmlAccept);
    check('/sw.js is still the worker', sw.status === 200 && /javascript/.test(sw.type), sw.type);
    const manifest = await s.call('GET', '/manifest.webmanifest', null, htmlAccept);
    check('/manifest.webmanifest is still the manifest', manifest.status === 200 && !/text\/html/.test(manifest.type), manifest.type);
    const oa = await s.call('GET', '/openapi.json', null, htmlAccept);
    check('/openapi.json is still the API description', oa.status === 200 && oa.json && oa.json.openapi, oa.type);
    const wrongMethod = await s.call('DELETE', '/conversations', null, htmlAccept);
    check('a wrong method on a real route is still 405', wrongMethod.status === 405, `${wrongMethod.status}`);
  });

  console.log(failures ? `\n${failures} check(s) FAILED, ${passes} passed\n` : `\nall ${passes} checks passed\n`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error('FAIL —', err); process.exit(1); });
