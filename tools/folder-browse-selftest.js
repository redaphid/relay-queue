'use strict';
/*
 * folder-browse-selftest — browsing the real filesystem to pick a folder.
 *
 *   node tools/folder-browse-selftest.js
 *
 * `GET /folders` is derived only from conversation paths, so a folder that
 * holds no tab does not exist as far as the drawer is concerned and filing a
 * tab somewhere new means typing a path blind. The server cannot fix that by
 * itself: it runs in a container with no home mount, on purpose. So the host
 * (tools/autoseat.js) walks home and PUBLISHES an index, and the server stores
 * it and serves it back. See FOLDER-BROWSE-SPEC.md.
 *
 * Both halves are asserted here, against a real server on a scratch DATA_DIR
 * and an OS-assigned port (harness-lib — never 3901, never real data), and
 * against a scratch directory tree for the scan:
 *
 *   - an index round-trips: what is published is what /fs drills into;
 *   - counts merge with conversation paths, so one folder never wears two
 *     different badges depending on which route you asked;
 *   - THE INDEX IS A CACHE, NEVER THE TRUTH: a scope it has never heard of is
 *     200 + `known:false`, not a 404, and no index at all is an empty list
 *     rather than a broken route;
 *   - an entry that could not be a conversation's folder is DROPPED AND
 *     COUNTED, not fatal — one odd directory name must not cost the scan;
 *   - `stale` flips past ten minutes, which is what the page reports;
 *   - the scan does not follow symlinks, does not leave home, and stops.
 *
 * Zero dependencies. Node built-ins only.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer } = require('./harness-lib');
const autoseat = require('./autoseat.js');

let failures = 0;
let passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; console.log(`  ok   ${name}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
}

async function withServer(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-browse-'));
  const srv = await startServer({ dir, label: 'browse' });
  const call = async (method, p, body, headers) => {
    const r = await fetch(srv.base + p, {
      method,
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(headers || {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: r.status, type: r.headers.get('content-type') || '', text, json };
  };
  try {
    await fn({ call, dir, srv });
  } catch (err) {
    process.stderr.write(`\n[server output]\n${srv.out}\n`);
    throw err;
  } finally {
    await srv.stop();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* windows may hold the log */ }
  }
}

/** The folder names /fs listed, in the order it listed them. */
const names = (j) => (j && Array.isArray(j.dirs) ? j.dirs.map((d) => d.name) : null);
const byName = (j, n) => (j && Array.isArray(j.dirs) ? j.dirs.find((d) => d.name === n) : null);

// A tree with one of everything the scanner has to decide about.
function makeTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-home-'));
  const mk = (p) => fs.mkdirSync(path.join(root, p), { recursive: true });
  mk('Projects/relay-queue/data');
  mk('Projects/relay-queue/tools');
  mk('Projects/sporefall-station');
  mk('Projects/deep/one/two/three/four'); // past depth 4, below home
  mk('Projects/relay-queue/node_modules/lodash');
  mk('Projects/relay-queue/dist');
  mk('.config/somethingprivate');
  mk('Worktrees/relay-queue/relay');
  mk('outside-target');
  fs.writeFileSync(path.join(root, 'Projects', 'a-file.txt'), 'not a folder\n');
  return root;
}

async function main() {
  console.log('\nthe scan: what autoseat publishes');
  {
    const home = makeTree();
    try {
      fs.symlinkSync(path.join(home, 'outside-target'), path.join(home, 'Projects', 'linked'), 'dir');
    } catch { /* a platform without symlink permission: the rest still holds */ }
    const scan = autoseat.scanFolders(home);
    const has = (p) => scan.dirs.indexOf(p) >= 0;
    check('it finds the folders under home', has('Projects') && has('Projects/relay-queue')
      && has('Projects/relay-queue/data'), scan.dirs.join(' '));
    check('paths are home-relative, never absolute', scan.dirs.every((d) => !path.isAbsolute(d)));
    check('it is sorted, so an unchanged tree makes an unchanged payload',
      JSON.stringify(scan.dirs) === JSON.stringify(scan.dirs.slice().sort()));
    check('files are not folders', !has('Projects/a-file.txt'));
    check('dot-folders are skipped', !scan.dirs.some((d) => /(^|\/)\./.test(d)), scan.dirs.join(' '));
    check('node_modules, dist and friends are skipped',
      !has('Projects/relay-queue/node_modules') && !has('Projects/relay-queue/dist'));
    check('*** a symlink is not followed ***', !has('Projects/linked'), scan.dirs.join(' '));
    check('it stops at depth 4', has('Projects/deep/one/two') && !has('Projects/deep/one/two/three'),
      scan.dirs.filter((d) => /deep/.test(d)).join(' '));
    check('a clean scan is not truncated', scan.truncated === false);

    const capped = autoseat.scanFolders(home, { max: 3 });
    check('*** it stops at the entry cap and says so ***',
      capped.dirs.length === 3 && capped.truncated === true, `${capped.dirs.length} ${capped.truncated}`);

    const missing = autoseat.scanFolders(path.join(home, 'no-such-folder'));
    check('an unreadable root is an empty scan, not a throw',
      missing.dirs.length === 0 && missing.truncated === false);
    fs.rmSync(home, { recursive: true, force: true });
  }

  await withServer(async (s) => {
    console.log('\nno index yet: /fs answers, and admits it knows nothing');
    const before = await s.call('GET', '/fs?path=');
    check('/fs is a 200 before anything was ever published', before.status === 200, `${before.status} ${before.text}`);
    check('...with an empty list', Array.isArray(before.json.dirs) && before.json.dirs.length === 0, before.text);
    check('...known:false', before.json.known === false);
    check('...and stale, because nobody has ever looked',
      before.json.stale === true && before.json.scannedAt === null && before.json.ageSec === null, before.text);

    console.log('\npublish an index, and drill into it');
    const dirs = [
      'Projects',
      'Projects/relay-queue',
      'Projects/relay-queue/data',
      'Projects/relay-queue/tools',
      'Projects/sporefall-station',
      'Projects/life-control',
      'Worktrees',
      'Worktrees/relay-queue',
    ];
    const post = await s.call('POST', '/folder-index', { root: '~', scannedAt: new Date().toISOString(), truncated: false, dirs });
    check('POST /folder-index stores every entry', post.status === 200 && post.json.stored === dirs.length,
      `${post.status} ${post.text}`);
    check('...and dropped nothing', post.json.dropped === 0, post.text);

    const root = await s.call('GET', '/fs?path=');
    check('the root drills down to the top-level folders',
      JSON.stringify(names(root.json)) === JSON.stringify(['Projects', 'Worktrees']), root.text);
    check('...known, fresh and not truncated',
      root.json.known === true && root.json.stale === false && root.json.truncated === false
      && typeof root.json.ageSec === 'number', root.text);
    check('...each one says whether there is anything below it',
      byName(root.json, 'Projects').hasChildren === true, root.text);

    const deep = await s.call('GET', '/fs?path=Projects');
    check('*** a scope at depth lists its immediate children, sorted ***',
      JSON.stringify(names(deep.json)) === JSON.stringify(['life-control', 'relay-queue', 'sporefall-station']), deep.text);
    check('...with their full home-relative path to pass back',
      byName(deep.json, 'relay-queue').path === 'Projects/relay-queue', deep.text);
    check('a leaf folder is known, with no children',
      (await s.call('GET', '/fs?path=Projects/life-control')).json.known === true);
    const leaf = await s.call('GET', '/fs?path=Projects/life-control');
    check('...and an empty list', leaf.json.dirs.length === 0 && leaf.json.count === 0, leaf.text);
    check('the autocomplete hint is every folder below the scope',
      JSON.stringify(deep.json.descendants) === JSON.stringify([
        'Projects/life-control', 'Projects/relay-queue', 'Projects/relay-queue/data',
        'Projects/relay-queue/tools', 'Projects/sporefall-station']), JSON.stringify(deep.json.descendants));

    console.log('\nthe counts are the ones GET /folders reports, not a second opinion');
    await s.call('POST', '/conversations', { title: 'rq one', path: 'Projects/relay-queue' });
    const two = await s.call('POST', '/conversations', { title: 'rq two', path: 'Projects/relay-queue/tools' });
    await s.call('POST', '/tasks', { instruction: 'a waiting one', conversationId: two.json.id });
    await s.call('POST', '/conversations', { title: 'nothing to do with it', path: 'Worktrees/relay-queue' });
    const merged = await s.call('GET', '/fs?path=Projects');
    const rq = byName(merged.json, 'relay-queue');
    const folders = await s.call('GET', '/folders?path=Projects');
    const rqFolders = folders.json.folders.find((f) => f.name === 'relay-queue');
    check('a folder that holds tabs shows them', rq.conversations === 2 && rq.pending === 1, JSON.stringify(rq));
    check('*** and shows exactly what /folders shows ***',
      rq.conversations === rqFolders.conversations && rq.pending === rqFolders.pending
      && rq.unread === rqFolders.unread, `${JSON.stringify(rq)} vs ${JSON.stringify(rqFolders)}`);
    check('a folder that holds none shows zeros, and is still listed',
      byName(merged.json, 'life-control').conversations === 0, merged.text);
    check('...which is the whole point: /folders would not list it at all',
      !folders.json.folders.some((f) => f.name === 'life-control'), folders.text);
    check('an archived tab is left out here too, as on /folders',
      (await s.call('GET', '/fs?path=Projects&archived=only')).json.dirs.every((d) => d.conversations === 0));

    console.log('\nthe index is a cache, never the truth');
    const unknown = await s.call('GET', '/fs?path=Projects/never-heard-of-it');
    check('*** an unknown scope is 200 + known:false, NOT a 404 ***',
      unknown.status === 200 && unknown.json.known === false, `${unknown.status} ${unknown.text}`);
    check('...with an empty list rather than a guess',
      unknown.json.dirs.length === 0 && unknown.json.path === 'Projects/never-heard-of-it', unknown.text);
    for (const [label, p] of [
      ['a .. segment', '../etc'],
      ['a doubled slash', 'a//b'],
      ['a backslash', 'Projects\\relay-queue'],
      ['a NUL', 'a\u0000b'],
    ]) {
      const bad = await s.call('GET', `/fs?path=${encodeURIComponent(p)}`);
      check(`a malformed path (${label}) is 400, as everywhere else`,
        bad.status === 400 && /path/.test(bad.json && bad.json.error), `${bad.status} ${bad.text}`);
    }

    console.log('\nan entry that cannot be a folder is dropped, not fatal');
    const messy = await s.call('POST', '/folder-index', {
      dirs: ['Good', 'Good/one', '../escape', 'a//b', 'back\\slash', 'nul\u0000here', '', '/', 'Good', 42, null, { a: 1 }, 'Good/two'],
    });
    check('the good ones are stored', messy.status === 200 && messy.json.stored === 3, messy.text);
    check('...the bad ones are counted, and the whole post still succeeds',
      messy.json.dropped === 10, messy.text);
    const good = await s.call('GET', '/fs?path=Good');
    check('...and only the good ones can be drilled into',
      JSON.stringify(names(good.json)) === JSON.stringify(['one', 'two']), good.text);
    const escaped = await s.call('GET', '/fs?path=');
    check('*** nothing that escapes home ever entered the index ***',
      JSON.stringify(names(escaped.json)) === JSON.stringify(['Good']), escaped.text);

    console.log('\nage: the page has to be able to say the list is old');
    const stale = await s.call('POST', '/folder-index', {
      scannedAt: new Date(Date.now() - 601 * 1000).toISOString(),
      dirs: ['Projects'],
    });
    check('an index may be published with the time it was actually scanned', stale.status === 200);
    const aged = await s.call('GET', '/fs?path=');
    check('*** past ten minutes it is stale ***', aged.json.stale === true, JSON.stringify(aged.json.ageSec));
    check('...and says how old, in seconds', aged.json.ageSec >= 600, JSON.stringify(aged.json.ageSec));
    const fresh = await s.call('POST', '/folder-index', { scannedAt: new Date(Date.now() - 60 * 1000).toISOString(), dirs: ['Projects'] });
    check('a fresh one flips it back', fresh.status === 200 && (await s.call('GET', '/fs?path=')).json.stale === false);
    const truncated = await s.call('POST', '/folder-index', { truncated: true, dirs: ['Projects'] });
    check('a truncated scan is reported as one',
      truncated.status === 200 && (await s.call('GET', '/fs?path=')).json.truncated === true);

    console.log('\nthe store itself');
    const file = path.join(s.dir, 'folder-index.json');
    check('it lands in DATA_DIR/folder-index.json', fs.existsSync(file));
    check('...as parseable JSON with the folders in it',
      JSON.parse(fs.readFileSync(file, 'utf8')).dirs.indexOf('Projects') >= 0);
    check('...and no half-written part file is left behind',
      !fs.readdirSync(s.dir).some((f) => /folder-index\.json\./.test(f)), fs.readdirSync(s.dir).join(' '));
    const bad = await s.call('POST', '/folder-index', { root: '~' });
    check('a post with no dirs at all is a 400', bad.status === 400 && /dirs/.test(bad.json.error), bad.text);
    const notObj = await s.call('POST', '/folder-index', ['Projects']);
    check('...and so is an array where the object should be', notObj.status === 400, notObj.text);
    const wrongMethod = await s.call('GET', '/folder-index');
    check('GET /folder-index is a 405, not a leak of the store', wrongMethod.status === 405, `${wrongMethod.status}`);
    const fsPost = await s.call('POST', '/fs', {});
    check('POST /fs is a 405', fsPost.status === 405, `${fsPost.status}`);

    console.log('\nit survives a restart: a picker opened after one is not blank');
    await s.call('POST', '/folder-index', { dirs: ['Projects', 'Projects/relay-queue'] });
    await s.srv.restart();
    const after = await s.call('GET', '/fs?path=Projects');
    check('*** the index is read back from disk ***',
      after.status === 200 && after.json.known === true
      && JSON.stringify(names(after.json)) === JSON.stringify(['relay-queue']), after.text);

    console.log('\nautoseat publishes it, and only when it changed');
    const home = makeTree();
    const cfg = { queue: s.srv.base, home };
    const runtime = {};
    const first = await autoseat.publishFolderIndex(cfg, runtime);
    check('the first publish goes out', first.skipped === false && first.dirs > 0, JSON.stringify(first));
    const served = await s.call('GET', '/fs?path=Projects');
    check('...and the server serves what was scanned',
      names(served.json).indexOf('relay-queue') >= 0, served.text);
    const again = await autoseat.publishFolderIndex(cfg, runtime);
    check('*** an unchanged tree is not posted again ***', again.skipped === true, JSON.stringify(again));
    fs.mkdirSync(path.join(home, 'Projects', 'brand-new'));
    const third = await autoseat.publishFolderIndex(cfg, runtime);
    check('...but a new folder is', third.skipped === false, JSON.stringify(third));
    check('...and shows up', names((await s.call('GET', '/fs?path=Projects')).json).indexOf('brand-new') >= 0);

    const broken = { queue: 'http://127.0.0.1:1', home };
    let threw = null;
    try { await autoseat.publishFolderIndex(broken, {}); } catch (e) { threw = e; }
    check('a publish to an unreachable relay throws for its caller to swallow', !!threw);
    const rt = { log: () => {}, folderIndexKey: null };
    check('...and startFolderIndex swallows it: no throw, no timer left running',
      (() => {
        const t = autoseat.startFolderIndex(broken, rt);
        if (t) clearInterval(t);
        return true;
      })());
    fs.rmSync(home, { recursive: true, force: true });
  });

  console.log(failures ? `\n${failures} check(s) FAILED, ${passes} passed\n` : `\nall ${passes} checks passed\n`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error('FAIL —', err); process.exit(1); });
