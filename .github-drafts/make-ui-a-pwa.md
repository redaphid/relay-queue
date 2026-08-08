# Make the UI an installable PWA

**Labels:** `feature`, `ui`

## Why

The page is used from a phone as the primary interface to the queue. As a browser tab it is a URL to
remember, it loses the address bar's screen space, and — more importantly — it cannot hold a media
session in the background, which
[`headphone-push-to-talk.md`](headphone-push-to-talk.md) depends on entirely.

Installed to the home screen it becomes an app: its own icon, no chrome, and a process the OS keeps
alive when the screen is off.

## What to do

**1. Serve a manifest.** Add `GET /manifest.webmanifest` to `server.js` (a small inline constant, in
keeping with the zero-dependency rule):

```json
{
  "name": "relay", "short_name": "relay", "start_url": "/", "scope": "/",
  "display": "standalone", "orientation": "portrait",
  "background_color": "#0e1116", "theme_color": "#0e1116",
  "icons": [ { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any maskable" } ]
}
```

Link it from the page and add `<meta name="theme-color">` for both colour schemes.

**2. Icons.** Android accepts SVG poorly and iOS needs a PNG `apple-touch-icon`. Either add real PNG
files under `public/` and serve them, or generate them once and inline them as data URIs. Note the
page currently has *no* asset files at all — adding the first ones means `server.js` needs a small
static handler, which is worth doing carefully rather than growing a path-traversal bug.

**3. Service worker** at `/sw.js`, registered from the page. Keep it deliberately dumb:
- **Cache the app shell only** (`/` and the icons) so the UI opens instantly and while offline.
- **Never cache API responses.** `/thread`, `/tasks`, `/events` and `/stt` must always hit the
  network — a stale thread or a replayed POST would be much worse than a spinner. Use a
  network-only strategy for anything that is not the shell.
- Version the cache and clean up old ones on `activate`, or the next UI change will be invisible
  behind a stale cache. Given the repo now auto-deploys on merge, a sticky service worker is the
  single most likely way to ship a page nobody can update.

**4. CSP needs to change.** The current policy is
`default-src 'none'; script-src 'unsafe-inline' blob:; …`. It must gain:
- `manifest-src 'self'` — otherwise the manifest is blocked outright.
- `'self'` in `script-src` — a service worker must be a real same-origin file; a `blob:` worker
  cannot control the page.
- `img-src 'self' data:` once real icon files exist.

**5. Offline behaviour.** The shell should open offline and show the last thread state with the
existing `offline — retrying` indicator, rather than a browser error page. Do not attempt an offline
send queue in this issue — that is its own design problem (ordering, duplicate suppression, and the
composer's "text stays put on failure" contract). File it separately if wanted.

## Acceptance criteria

- [ ] "Add to Home Screen" on Android and iOS produces a standalone app with a proper icon and no
      browser chrome.
- [ ] Launching it offline shows the UI shell and the offline indicator, not a browser error.
- [ ] `/thread`, `/tasks`, `/events` and `/stt` are never served from cache — verified by posting
      from another device and seeing it appear.
- [ ] A change to `public/index.html` reaches the installed app on next launch (cache versioning
      actually works — test this, do not assume it).
- [ ] Lighthouse's installability check passes.
- [ ] The page still makes zero external requests and remains one self-contained HTML file plus
      icons.
- [ ] CSP updated and still as tight as it can be — no blanket `'self'` on `default-src`.
