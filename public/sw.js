'use strict';

/*
 * relay — service worker.
 *
 * This exists for exactly one reason: a push event can only be delivered to a
 * service worker, so this is the only way to reach him with the tab closed.
 *
 * It caches NOTHING, on purpose. The checkout is the deployment on this machine
 * and the server restarts itself on every source change, so a worker that
 * served a cached shell would be the single most reliable way to ship a page he
 * cannot update. Offline support is a separate problem; this file does not
 * pretend to solve it.
 *
 * Everything needed to draw the notification travels inside the encrypted push
 * payload. The worker never fetches. That matters more than it looks: the page
 * sits behind Cloudflare Access, so a background fetch after an expired session
 * would come back as an HTML login page, and the notification would silently
 * fail at the exact moment it was needed.
 */

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
  e.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', function (e) {
  e.waitUntil(self.clients.claim());
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
