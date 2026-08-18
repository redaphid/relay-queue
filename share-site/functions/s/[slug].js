/*
 * relay-share — the public half of relay-queue's "share this conversation".
 *
 * WHY THIS EXISTS AT ALL, since the obvious answer is a tunnel:
 *
 *   The relay runs on his desktop, published on loopback and reached from
 *   outside through a Cloudflare tunnel with Access in front. A "share link"
 *   pointing at that origin — even a public, Access-exempt one — is still a URL
 *   whose bytes come off *his machine*. He asked for a link that works "even
 *   when my computer is offline", and a tunnel to a sleeping desktop is a 502.
 *
 *   So sharing cannot proxy. It has to COPY: the relay renders the conversation
 *   to one self-contained HTML file and PUTs it here, and from then on this
 *   serves it from Cloudflare's edge with his machine out of the loop entirely.
 *   That is a SNAPSHOT, frozen at the moment he shared it — never a live view.
 *   The relay bakes a dated banner into every page saying so.
 *
 * Why Pages and not a workers.dev Worker: this account has a Cloudflare Access
 * policy covering `relay-share.loqwai.workers.dev`, which 302s anonymous readers
 * to a login screen — the exact opposite of a public share link. `*.pages.dev`
 * carries no such policy, so the snapshot is reachable by someone who has never
 * heard of this Cloudflare account. (Verified: workers.dev 302'd to
 * loqwai.cloudflareaccess.com, pages.dev returned 200.)
 *
 * Why not push the HTML with `wrangler pages deploy` per share: the relay is an
 * alpine container with the repo mounted read-only and no Docker socket. It
 * cannot shell out to wrangler. It CAN make an HTTPS request, so publishing is
 * one authenticated PUT to this Function and needs nothing installed.
 *
 * Routes (all on /s/<slug>):
 *   GET/HEAD  public, unauthenticated — the snapshot itself
 *   PUT       bearer token — publish, or re-publish to refresh a stale one
 *   DELETE    bearer token — revoke
 */

// 128 bits of base64url is 22 characters; the range leaves room for a future
// format without ever being loose enough to enumerate.
const SLUG_RE = /^[A-Za-z0-9_-]{16,64}$/;

// KV's own value ceiling is 25 MiB. Stopping short of it means an oversized
// snapshot fails HERE, with a number in the message, not as an opaque KV error.
const MAX_BYTES = 20 * 1024 * 1024;

/*
 * The published page is static HTML with no scripts, so this can be brutal.
 * `default-src 'none'` with only `img-src data:` allowed is the machine-checked
 * form of the promise this feature makes: the page CANNOT call back to
 * localhost:3901, because there is no origin it is permitted to reach and no
 * script with which to try. Auditing the HTML shows no localhost URL is present;
 * this enforces that none could be used even if one ever crept in.
 */
const CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; " +
  "base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const htmlHeaders = (extra) => ({
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy': CSP,
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  // A share link is unguessable, not secret-by-policy: keep it out of indexes.
  'x-robots-tag': 'noindex, nofollow, noarchive',
  ...extra,
});

const json = (status, obj) => new Response(JSON.stringify(obj, null, 2) + '\n', {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

/** A small styled page for every state that is not a snapshot. */
function notice(status, title, body) {
  const page = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #f4f6f8; color: #14161a; padding: 24px;
  }
  main { max-width: 32rem; text-align: center; }
  h1 { font-size: 20px; margin: 0 0 8px; }
  p { margin: 0; color: #667085; }
  @media (prefers-color-scheme: dark) { body { background: #0e1116; color: #e6e8ec; } p { color: #98a2b3; } }
</style>
<main><h1>${esc(title)}</h1><p>${esc(body)}</p></main>
`;
  return new Response(page, { status, headers: htmlHeaders({ 'cache-control': 'no-store' }) });
}

/**
 * Constant-time bearer check. Compared byte-for-byte with no early exit, so a
 * wrong guess leaks nothing through timing.
 */
function authorised(request, env) {
  // Trimmed because a secret is very often stored with the trailing newline of
  // whatever echoed it into `wrangler secret put`, and an invisible byte that
  // turns every request into a 401 is a genuinely horrible afternoon.
  const secret = String(env.SHARE_TOKEN || '').trim();
  if (!secret) return false; // unconfigured means closed, never open
  const m = /^Bearer\s+(.+)$/i.exec((request.headers.get('authorization') || '').trim());
  if (!m) return false;
  const enc = new TextEncoder();
  const a = enc.encode(m[1].trim());
  const b = enc.encode(secret);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function onRequest({ request, env, params }) {
  const url = new URL(request.url);
  const method = request.method;
  const slug = String(params.slug || '');

  if (!SLUG_RE.test(slug)) return notice(404, 'Not found', 'That is not a share link.');
  if (!env.SHARES) return json(500, { error: 'SHARES KV binding is missing from this deployment' });

  if (method === 'GET' || method === 'HEAD') {
    const stored = await env.SHARES.getWithMetadata(slug, { type: 'text' });
    if (stored.value === null) {
      /*
       * A tombstone is written on revoke so this can honestly say "was taken
       * down" rather than "never existed" — he needs to tell a successful
       * unshare from a mistyped link.
       */
      const gone = await env.SHARES.get(`revoked:${slug}`, { type: 'json' });
      if (gone) {
        return notice(410, 'This share was taken down',
          'The conversation that used to be here has been unshared by its owner.');
      }
      return notice(404, 'No such share',
        'This link does not point at anything. It may have been mistyped, or it may never have existed.');
    }
    const headers = htmlHeaders({
      // Short, so that re-sharing to refresh a snapshot actually shows up.
      // Revocation does not rely on this: a revoked key is gone from KV.
      'cache-control': 'public, max-age=60',
    });
    if (stored.metadata && stored.metadata.sharedAt) {
      headers['last-modified'] = new Date(stored.metadata.sharedAt).toUTCString();
    }
    return new Response(method === 'HEAD' ? null : stored.value, { status: 200, headers });
  }

  if (method === 'PUT') {
    if (!authorised(request, env)) return json(401, { error: 'bad or missing bearer token' });
    const body = await request.text();
    if (!body) return json(400, { error: 'empty body' });
    const bytes = new TextEncoder().encode(body).length;
    if (bytes > MAX_BYTES) {
      return json(413, { error: `snapshot is ${bytes} bytes, over the ${MAX_BYTES} limit`, bytes, limit: MAX_BYTES });
    }
    const meta = {
      sharedAt: new Date().toISOString(),
      title: (request.headers.get('x-share-title') || '').slice(0, 200) || null,
      bytes,
    };
    await env.SHARES.put(slug, body, { metadata: meta });
    // Re-sharing a previously revoked slug clears the tombstone, so the two
    // states can never both be true.
    await env.SHARES.delete(`revoked:${slug}`);
    return json(200, { ok: true, slug, url: `${url.origin}/s/${slug}`, ...meta });
  }

  if (method === 'DELETE') {
    if (!authorised(request, env)) return json(401, { error: 'bad or missing bearer token' });
    const existed = (await env.SHARES.get(slug, { type: 'text' })) !== null;
    await env.SHARES.delete(slug);
    await env.SHARES.put(`revoked:${slug}`, JSON.stringify({ at: new Date().toISOString() }));
    return json(200, { ok: true, slug, existed, revoked: true });
  }

  return json(405, { error: `method ${method} not allowed`, allow: 'GET, HEAD, PUT, DELETE' });
}
