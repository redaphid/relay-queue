'use strict';

/*
 * relay — service worker. Two jobs: web push, and reading offline.
 *
 * PUSH came first, and is the reason this file exists at all: a push event can
 * only be delivered to a service worker, so this is the only way to reach him
 * with the tab closed. Everything needed to draw the notification travels
 * inside the encrypted payload and the push path never fetches — the page sits
 * behind Cloudflare Access, and a background fetch after an expired session
 * comes back as an HTML login page, which would make the notification fail
 * silently at the exact moment it was needed.
 *
 * OFFLINE READING was added second, and reverses this file's original position
 * that it should cache nothing. That position was right about the danger and
 * wrong about the conclusion. The danger is real and worth stating plainly:
 *
 *   The checkout IS the deployment. The server restarts itself when its source
 *   changes, so a worker that serves a cached shell is the most reliable way
 *   ever devised to ship a page nobody can update. Pinning him to a broken old
 *   build with no way out is strictly worse than having no offline support.
 *
 * So the cache is built to lose every argument with the network:
 *
 *   1. The shell is NETWORK-FIRST, not cache-first. While there is a network,
 *      the freshly deployed page wins, always. The cache is consulted only when
 *      the network has actually failed or gone quiet for SHELL_TIMEOUT_MS — and
 *      even then the in-flight request is left running to refresh the cache, so
 *      a slow connection updates him rather than pinning him.
 *   2. Caches are VERSIONED and everything else of ours is deleted on activate.
 *   3. skipWaiting + clients.claim, so a new worker takes over immediately
 *      instead of a week on Tuesday.
 *   4. Nothing is cached unless the server stamped it as genuinely this app
 *      (see APP_HEADER). An Access login page can never be mistaken for the
 *      shell, which is the specific failure the push path was written to avoid.
 *
 * What is cached is the shell, the icons, and the most recent read of each
 * conversation's thread — the last thing he was told, so a plane or a dead spot
 * still shows the conversation instead of a dinosaur.
 *
 * WHY THE CACHE API AND NOT IndexedDB. The store holds `/thread` and
 * `/conversations` *responses*, keyed by conversation, exactly as the server
 * sent them. The page then needs no second code path: its existing poll() gets
 * the JSON it always gets, merge() and render() are untouched, and there is one
 * definition of a message rather than two that can drift. Structured storage
 * would buy per-message queries the page has no use for — it holds the whole
 * window in memory anyway — at the price of a serialiser on both sides.
 *
 * It is bounded by construction: one entry per conversation, capped at
 * MAX_THREADS by eviction of the least recently written, and each entry is one
 * server response already limited to the page's window. Hundreds of messages,
 * not an unbounded log.
 */

/*
 * Bump VERSION when the SHAPE of what is cached changes — not for ordinary
 * deploys, which network-first already handles. Old versions are deleted on
 * activate, so a bump is also the way to throw away a store gone bad.
 */
const VERSION = 'v1';
const SHELL_CACHE = 'relay-shell-' + VERSION;
const DATA_CACHE = 'relay-data-' + VERSION;
const OURS = [SHELL_CACHE, DATA_CACHE];

/*
 * The server sets this on the app shell and on nothing else. It is what tells a
 * real page apart from an Access login page or a captive portal's interception,
 * both of which are 200s full of HTML and would otherwise be cached AS the app.
 */
const APP_HEADER = 'x-relay-app';
// Set by this worker on the way out, so the page can tell it is reading history
// rather than the present, and say so instead of quietly looking current.
const FROM_CACHE = 'x-relay-from-cache';
const CACHED_AT = 'x-relay-cached-at';

const SHELL_KEY = '/';
const ASSETS = [
  '/manifest.webmanifest',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png',
  '/apple-touch-icon.png',
];

// How long to wait before showing the saved copy. Patchy hotel wifi does not
// fail, it hangs; a spinner forever is the thing to avoid. The shell is the
// tighter of the two because nothing at all is on screen until it resolves.
const SHELL_TIMEOUT_MS = 4000;
/*
 * Longer than the shell's, deliberately. A thread read is a hundred kilobytes
 * of JSON and a genuinely slow connection abroad can take five or six seconds
 * to deliver it — giving up on that and declaring him offline would be both
 * wrong and infuriating, since the data was on its way. This only has to be
 * short enough to rescue a connection that is never going to answer at all.
 *
 * The truly offline case does not wait for this: offlineForSure() answers from
 * the cache immediately.
 */
const DATA_TIMEOUT_MS = 6000;
// Conversations kept readable offline, least-recently-written evicted first.
const MAX_THREADS = 12;

const CATEGORIES = {
  'needs-you': {
    // Two taps and a question — the long pulse last, so it reads as "asking".
    vibrate: [0, 100, 70, 100, 70, 300],
    fallbackTitle: 'Needs you',
  },
  done: {
    // Two light taps. Deliberately the least intrusive of the three.
    vibrate: [0, 50, 90, 50],
    fallbackTitle: 'Reply ready',
  },
  broken: {
    // Three long pulses. Nothing else in the set feels like this.
    vibrate: [0, 300, 100, 300, 100, 300],
    fallbackTitle: 'Something is broken',
  },
};

self.addEventListener('install', function (e) {
  // Take over at once rather than waiting for every tab to close: an update
  // that lands a week from now is not an update.
  e.waitUntil(precache().then(function () { return self.skipWaiting(); }));
});

/*
 * Warm the cache during install rather than waiting for a second visit.
 *
 * The navigation that loaded the page happened before this worker controlled
 * anything, so without this the shell is not saved until the next load — and
 * "install it, then get on the plane" is precisely the sequence that has to
 * work. Install is also the safest moment to do it: he is demonstrably holding
 * a working session right now, so the Access cookie is good.
 *
 * Best effort throughout. A missing icon must never fail the install and leave
 * him with no worker at all, which would take push down with it.
 */
function precache() {
  return caches.open(SHELL_CACHE).then(function (cache) {
    const jobs = ASSETS.map(function (path) {
      return fetch(path, { credentials: 'same-origin' })
        .then(function (res) { return res && res.ok ? cache.put(path, res) : null; })
        .catch(function () { return null; });
    });
    jobs.push(refreshShell(cache).catch(function () { return null; }));
    return Promise.all(jobs);
  }).catch(function () { return null; });
}

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (names) {
        return Promise.all(names.map(function (n) {
          // Only ever delete our own. Scoped by prefix so a cache belonging to
          // anything else sharing this origin is left alone.
          if (n.indexOf('relay-') !== 0 || OURS.indexOf(n) >= 0) return null;
          return caches.delete(n);
        }));
      })
      .catch(function () { return null; })
      .then(function () { return self.clients.claim(); })
  );
});

// ---------------------------------------------------------------- caching

/*
 * The one connectivity signal worth acting on.
 *
 * navigator.onLine is famously useless as a claim that the network WORKS — a
 * captive portal is "online" and reaches nothing. But it is trustworthy in the
 * negative: when the OS says there is no interface, there is no interface. So
 * it is used for exactly that, and only that. On a plane this turns a five
 * second wait for a timeout into an instant open, which is the difference
 * between an app and a spinner.
 *
 * It cannot pin him to a stale build: the moment the OS reports a network, the
 * network-first path is back in charge.
 */
function offlineForSure() {
  try { return self.navigator && self.navigator.onLine === false; } catch (e) { return false; }
}

/** True only for a response the server stamped as the real app shell. */
function isShell(res) {
  return !!(res && res.ok && !res.redirected && res.headers.get(APP_HEADER));
}

/*
 * True only for a real API answer. Access serves its login page as 200 text/html
 * to any request, including this one, so the content type is the thing that
 * says "this is the queue talking" rather than "this is the front door".
 */
function isJson(res) {
  const t = res && res.ok && !res.redirected ? res.headers.get('content-type') : null;
  return !!t && t.indexOf('application/json') >= 0;
}

/** A copy of `res` carrying `extra` headers. Responses are otherwise immutable. */
function restamp(res, extra) {
  return res.arrayBuffer().then(function (body) {
    const h = new Headers(res.headers);
    for (const k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) h.set(k, extra[k]);
    return new Response(body, { status: res.status, statusText: res.statusText, headers: h });
  });
}

/** Store `res` under `key`, stamped with the time, so staleness can be shown. */
function keep(cache, key, res) {
  return restamp(res, { [CACHED_AT]: String(Date.now()) })
    .then(function (stamped) { return cache.put(key, stamped); })
    .catch(function () { return null; });
}

function fromCache(hit) {
  return restamp(hit, { [FROM_CACHE]: '1' });
}

/*
 * Fetch the shell and, if it really is the shell, save it under the canonical
 * key. Resolves with whatever the network said.
 *
 * `request` is the browser's own navigation request when there is one, and not
 * a synthetic GET, because only a navigation request produces an opaqueredirect
 * the browser will follow. That is what keeps an expired Cloudflare Access
 * session working: it must land him on the login page, not on a saved thread
 * that will never refresh. It is stored under SHELL_KEY regardless, so the
 * whole app shares one entry however the URL was decorated.
 */
function refreshShell(cache, request) {
  const req = request || new Request(SHELL_KEY, { credentials: 'same-origin', cache: 'no-store' });
  return fetch(req).then(function (res) {
    if (isShell(res)) keep(cache, SHELL_KEY, res.clone());
    return res;
  });
}

/*
 * The shell: network-first, with the saved copy as a fallback rather than a
 * default. See the note at the top of this file — this ordering is the whole
 * reason it is safe to cache the page of an app whose checkout is its deploy.
 */
function handleShell(event) {
  return caches.open(SHELL_CACHE).then(function (cache) {
    // Airplane mode: open at once from what we have rather than spending the
    // patience budget below discovering what the OS already knows.
    if (offlineForSure()) {
      return cache.match(SHELL_KEY).then(function (hit) {
        return hit ? fromCache(hit) : offlinePage();
      });
    }

    const net = refreshShell(cache, event.request);
    /*
     * Keep the worker alive for the real request even if the race below has
     * already given up on it. A connection too slow to read is still fast
     * enough to update what he will see next time, and abandoning it here is
     * how a cached page would start to feel permanent.
     */
    event.waitUntil(net.catch(function () { return null; }));

    const patience = new Promise(function (resolve) { setTimeout(resolve, SHELL_TIMEOUT_MS); });
    return Promise.race([net, patience])
      .catch(function () { return null; })
      .then(function (res) {
        if (res) return res;                       // the network won, as it should
        return cache.match(SHELL_KEY).then(function (hit) {
          return hit ? fromCache(hit) : offlinePage();
        });
      });
  });
}

/*
 * One cache entry per conversation, under a key of our own rather than the URL
 * that produced it.
 *
 * The page reads a thread two ways: a full window on a cold start, and a
 * `since=` delta every few seconds afterwards. Keying by URL would save a
 * hundred useless deltas and lose the one snapshot worth having, and would
 * orphan everything the day the window size changes. So only a full read is
 * ever stored, and every read — delta included — is answered from that snapshot
 * when the network is gone. Handing a snapshot to a delta request is safe
 * because the page merges by id and signature: re-seeing a message it already
 * has changes nothing and repaints nothing.
 */
function dataKey(url) {
  if (url.pathname === '/conversations') return '/__relay-offline/conversations';
  const conv = url.searchParams.get('conversation') || url.searchParams.get('conversationId') || '';
  return '/__relay-offline/thread?conversation=' + encodeURIComponent(conv);
}

function storable(url) {
  // A delta is not a snapshot; storing one would leave him reading three
  // messages out of four hundred and no way to tell.
  return url.pathname !== '/thread' || url.searchParams.get('since') === null;
}

/** Whatever was last saved for this key, marked as saved, or an honest failure. */
function savedData(key) {
  return caches.open(DATA_CACHE)
    .then(function (cache) { return cache.match(key); })
    .then(function (hit) {
      if (hit) return fromCache(hit);
      /*
       * Nothing saved for this conversation. Answer with a failure, not with an
       * empty thread: "No messages yet" would be a lie, and the page already
       * knows how to say "offline" when a read fails.
       */
      return new Response(JSON.stringify({ error: 'offline, and nothing saved for this conversation' }), {
        status: 504,
        headers: { 'content-type': 'application/json', [FROM_CACHE]: 'miss' },
      });
    })
    /*
     * The store itself failed, which should not happen and would be invisible
     * if it did: Response.error() reaches the page as a bare "NetworkError",
     * indistinguishable from simply being offline — the least useful possible
     * report from the one component that was supposed to be helping. Say what
     * broke instead; the page logs it to the server.
     */
    .catch(function (err) {
      return new Response(JSON.stringify({
        error: 'offline store unreadable: ' + ((err && err.message) || String(err)),
      }), {
        status: 504,
        headers: { 'content-type': 'application/json', [FROM_CACHE]: 'error' },
      });
    });
}

function handleData(event, url) {
  const key = dataKey(url);

  // Airplane mode, and the OS is certain. Do not spend five seconds proving it.
  if (offlineForSure()) return savedData(key);

  const net = fetch(event.request).then(function (res) {
    if (isJson(res) && storable(url)) {
      const copy = res.clone();
      event.waitUntil(
        caches.open(DATA_CACHE)
          .then(function (cache) { return keep(cache, key, copy).then(function () { return prune(cache); }); })
          .catch(function () { return null; })
      );
    }
    return res;
  });
  // Let a slow request finish in the background even after we have given up on
  // it, so the saved copy is refreshed for next time rather than left to rot.
  event.waitUntil(net.catch(function () { return null; }));

  /*
   * A read has to be able to give up.
   *
   * A failing network is the easy case; a HANGING one is the case that hurt.
   * A TCP connection that is open but dead — hotel wifi, a captive portal, a
   * train tunnel — never errors, it just never answers, and without this the
   * page waits on it for ever: no thread, no offline notice, no explanation.
   * That is a worse experience than having no offline support at all, since at
   * least a browser error page tells you something.
   */
  const patience = new Promise(function (resolve) { setTimeout(resolve, DATA_TIMEOUT_MS); });
  return Promise.race([net, patience])
    .catch(function () { return null; })
    .then(function (res) { return res || savedData(key); });
}

/** Keep the thread store to MAX_THREADS, dropping whatever was written longest ago. */
function prune(cache) {
  return cache.keys().then(function (keys) {
    const threads = keys.filter(function (r) { return r.url.indexOf('/__relay-offline/thread') >= 0; });
    if (threads.length <= MAX_THREADS) return null;
    return Promise.all(threads.map(function (r) {
      return cache.match(r).then(function (res) {
        return { req: r, at: Number((res && res.headers.get(CACHED_AT)) || 0) };
      });
    })).then(function (all) {
      all.sort(function (a, b) { return a.at - b.at; });
      return Promise.all(all.slice(0, all.length - MAX_THREADS).map(function (x) { return cache.delete(x.req); }));
    });
  }).catch(function () { return null; });
}

/** Stale-while-revalidate for the icons and manifest: they change almost never. */
function handleAsset(event) {
  return caches.open(SHELL_CACHE).then(function (cache) {
    return cache.match(event.request).then(function (hit) {
      const net = fetch(event.request).then(function (res) {
        if (res && res.ok && !res.redirected) cache.put(event.request, res.clone()).catch(function () {});
        return res;
      });
      if (hit) { event.waitUntil(net.catch(function () { return null; })); return hit; }
      return net;
    });
  });
}

/*
 * The last resort: offline, and not even the shell was saved. A plain page
 * beats the browser's error screen, which on Android offers a reload button and
 * no hint that this app has anything to show at all.
 */
function offlinePage() {
  const html = '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="color-scheme" content="light dark"><title>relay — offline</title>' +
    '<style>body{font:16px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;' +
    'min-height:100vh;background:#0e1116;color:#e6e8ec;text-align:center;padding:24px}' +
    'p{color:#98a2b3;max-width:32ch}b{color:#fdba74}</style></head><body><div>' +
    '<p><b>Offline.</b></p><p>No saved copy of relay on this device yet — open it once ' +
    'with a connection and the thread will be here next time.</p>' +
    '</div></body></html>';
  return new Response(html, {
    status: 503,
    headers: { 'content-type': 'text/html; charset=utf-8', [FROM_CACHE]: 'miss' },
  });
}

self.addEventListener('fetch', function (event) {
  const req = event.request;
  /*
   * Never a write. Replaying a POST is how a message gets sent twice or sent an
   * hour late to a conversation that has moved on, and the Cache API refuses
   * them anyway — this is here to say it was a decision, not an accident.
   */
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;

  /*
   * Only the root is the app. Any other path is a 404 from the server, and
   * answering one with the shell would turn a plain mistake into a page that
   * looks like it loaded and then does nothing.
   */
  if (req.mode === 'navigate' && url.pathname === '/') { event.respondWith(handleShell(event)); return; }
  if (url.pathname === '/thread' || url.pathname === '/conversations') {
    event.respondWith(handleData(event, url));
    return;
  }
  if (ASSETS.indexOf(url.pathname) >= 0) { event.respondWith(handleAsset(event)); return; }

  /*
   * Everything else is left entirely alone — no respondWith, so it does not
   * even pass through this worker's hands. That is deliberate for /events (an
   * EventSource must never be buffered), /stt and /tts (streams), and /status,
   * /watch and /push/* (answers that are worthless a second later, and
   * dangerous if they look current when they are not).
   */
});

/*
 * The escape hatch, driven from the page's Status panel. If the saved copy is
 * ever the problem, there has to be a way out that does not involve knowing
 * about DevTools on a phone.
 */
self.addEventListener('message', function (event) {
  const msg = event.data;
  if (!msg) return;

  /*
   * The page handing over the thread as it currently stands, which is the
   * primary way the offline copy stays current.
   *
   * Caching `/thread` responses as they fly past is not enough on its own: the
   * page reads a full window once on load and then lives on `since=` deltas,
   * so what the network sees is one snapshot and then a long tail of fragments
   * that are worthless on their own. Waiting for the next full read would leave
   * the saved copy up to ten minutes behind — and the ten minutes he most wants
   * are the last ten.
   *
   * So the page, which is already holding a correctly merged thread in memory,
   * simply gives it to us. No merge logic is duplicated here; this is a byte
   * store. The page remains the only thing that knows how to assemble a thread.
   */
  if (msg.relay === 'save-thread' && typeof msg.body === 'string') {
    const key = '/__relay-offline/thread?conversation=' + encodeURIComponent(msg.conversation || '');
    event.waitUntil(
      caches.open(DATA_CACHE).then(function (cache) {
        const res = new Response(msg.body, { headers: { 'content-type': 'application/json' } });
        return keep(cache, key, res).then(function () { return prune(cache); });
      }).catch(function () { return null; })
    );
    return;
  }

  if (msg.relay !== 'forget-offline') return;
  event.waitUntil(
    caches.keys()
      .then(function (names) {
        return Promise.all(names.map(function (n) {
          return n.indexOf('relay-') === 0 ? caches.delete(n) : null;
        }));
      })
      .catch(function () { return null; })
      .then(function () {
        if (event.source && event.source.postMessage) {
          try { event.source.postMessage({ relay: 'offline-forgotten' }); } catch (e) { /* the tab went away */ }
        }
      })
  );
});

function parsePayload(event) {
  try {
    const j = event.data ? event.data.json() : null;
    if (j && typeof j === 'object') return j;
  } catch (err) { /* fall through to the generic shape below */ }
  return null;
}

self.addEventListener('push', function (event) {
  const j = parsePayload(event);
  const category = j && CATEGORIES[j.c] ? j.c : 'done';
  const spec = CATEGORIES[category];
  const title = (j && j.t) || spec.fallbackTitle;
  const body = (j && j.b) || '';
  const url = (j && j.u) || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (clientList) {
      let focused = null;
      for (const c of clientList) if (c.focused) focused = c;

      /*
       * If he is already looking at the page, tell it to buzz with the pattern
       * itself — navigator.vibrate is only callable from a page, not from here,
       * and it is far more reliable on Firefox Android than the notification's
       * own `vibrate` option. Then show the notification silently, because the
       * push contract requires a *visible* notification for every push (skip it
       * and the browser eventually revokes the subscription) but he does not
       * need to be buzzed twice for one event.
       */
      if (focused) {
        try {
          focused.postMessage({ relay: 'notify', category: category, title: title, body: body });
        } catch (err) { /* the page went away mid-flight; the notification still shows */ }
      }

      return self.registration.showNotification(title, {
        body: body,
        tag: category, // collapse repeats of a kind rather than stacking them
        renotify: true,
        silent: !!focused,
        // Best effort. Firefox on Android largely defers to the OS notification
        // channel here, which is why the in-page path above is the one that
        // actually delivers a distinguishable pattern.
        vibrate: spec.vibrate,
        timestamp: Date.now(),
        data: { url: url, category: category },
      });
    })
  );
});

self.addEventListener('notificationclick', function (event) {
  const data = event.notification.data || {};
  const target = data.url || '/';
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (clientList) {
      // Reuse a tab if one is open — opening a second copy of the page would
      // start a second EventSource and a second dictation session.
      for (const c of clientList) {
        if (c.url.indexOf(self.registration.scope) === 0 && 'focus' in c) {
          if ('navigate' in c && target !== '/') { try { c.navigate(target); } catch (err) { /* cross-origin or unsupported */ } }
          return c.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
      return undefined;
    })
  );
});
