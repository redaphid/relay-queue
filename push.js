'use strict';

/**
 * Web Push, on node builtins only.
 *
 * Implements the three specs a browser actually requires:
 *   RFC 8030 — the HTTP push protocol (TTL, Urgency, Topic)
 *   RFC 8291 — aes128gcm payload encryption
 *   RFC 8292 — VAPID, the ES256 JWT that identifies this server
 *
 * The `web-push` npm package does exactly this in ~800 lines of dependencies.
 * Node 22 has every primitive built in (P-256 ECDH, HKDF, AES-128-GCM, and
 * ES256 signing via `dsaEncoding: 'ieee-p1363'`), so the project's zero-runtime-
 * dependency rule survives. `tools/push-selftest.js` checks the encryption
 * against the published RFC 8291 §5 test vector, which is the only way to know
 * this is right without a real phone in the loop.
 *
 * Delivery path, and why Cloudflare Access is not in it:
 *   this server --(outbound HTTPS)--> Mozilla autopush / Google FCM --> the phone
 * The phone holds a long-lived connection to its own vendor's push service. The
 * push service is named by the subscription's own `endpoint` URL, which is a
 * mozilla.com or google.com host — never relay.hypnodroid.com. So a notification
 * arrives with the tab closed, with the page unreachable, and with an expired
 * Access session. Nothing about Access gates it. The only thing Access still
 * gates is *opening* the page after tapping the notification.
 */

const crypto = require('node:crypto');
const https = require('node:https');

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (s) => Buffer.from(String(s), 'base64url');

const P256 = 'prime256v1';
const UNCOMPRESSED_LEN = 65; // 0x04 || X(32) || Y(32)
const AUTH_LEN = 16;

// ---------------------------------------------------------------- VAPID keys

/**
 * A fresh VAPID keypair, both halves base64url, the public one in the
 * uncompressed-point form the browser's `applicationServerKey` expects.
 */
function generateVapidKeys() {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: P256 });
  const jwk = privateKey.export({ format: 'jwk' });
  return {
    publicKey: b64u(Buffer.concat([Buffer.from([4]), unb64u(jwk.x), unb64u(jwk.y)])),
    privateKey: jwk.d, // export() already gives base64url
  };
}

/** Rebuild a signing key from the stored base64url halves. */
function vapidKeyObject(keys) {
  const pub = unb64u(keys.publicKey);
  if (pub.length !== UNCOMPRESSED_LEN || pub[0] !== 4) throw new Error('VAPID public key is not an uncompressed P-256 point');
  return crypto.createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      d: keys.privateKey,
      x: b64u(pub.subarray(1, 33)),
      y: b64u(pub.subarray(33, 65)),
    },
    format: 'jwk',
  });
}

function looksLikeVapidKeys(keys) {
  if (!keys || typeof keys.publicKey !== 'string' || typeof keys.privateKey !== 'string') return false;
  try {
    vapidKeyObject(keys);
    return unb64u(keys.privateKey).length === 32;
  } catch {
    return false;
  }
}

/**
 * The `Authorization: vapid t=<jwt>, k=<pubkey>` header for one endpoint.
 * `aud` must be the push service's origin, not ours — it is the audience of the
 * token, and Mozilla rejects a mismatch with 401.
 */
function vapidHeader(endpoint, keys, subject, now) {
  const aud = new URL(endpoint).origin;
  const exp = Math.floor((now || Date.now()) / 1000) + 12 * 3600; // spec caps this at 24h
  const signing =
    b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' })) + '.' + b64u(JSON.stringify({ aud, exp, sub: subject }));
  // ES256 is raw r||s, not the DER that node signs with by default.
  const sig = crypto.sign('sha256', Buffer.from(signing), {
    key: vapidKeyObject(keys),
    dsaEncoding: 'ieee-p1363',
  });
  return `vapid t=${signing}.${b64u(sig)}, k=${keys.publicKey}`;
}

// ----------------------------------------------------------- RFC 8291 crypto

const INFO_KEY = Buffer.concat([Buffer.from('WebPush: info'), Buffer.from([0])]);
const INFO_CEK = Buffer.concat([Buffer.from('Content-Encoding: aes128gcm'), Buffer.from([0])]);
const INFO_NONCE = Buffer.concat([Buffer.from('Content-Encoding: nonce'), Buffer.from([0])]);

/**
 * Encrypt one payload for one subscription. `opts.salt` and `opts.serverKey`
 * exist only so the selftest can pin the RFC's vector; production always wants
 * fresh randomness for both.
 *
 * Returns the complete aes128gcm body:
 *   salt(16) || rs(4) || idlen(1) || as_public(65) || ciphertext+tag
 */
function encrypt(plaintext, p256dh, auth, opts) {
  const o = opts || {};
  const uaPublic = unb64u(p256dh);
  const authSecret = unb64u(auth);
  if (uaPublic.length !== UNCOMPRESSED_LEN) throw new Error(`p256dh must be ${UNCOMPRESSED_LEN} bytes, got ${uaPublic.length}`);
  if (authSecret.length !== AUTH_LEN) throw new Error(`auth must be ${AUTH_LEN} bytes, got ${authSecret.length}`);

  const salt = o.salt ? Buffer.from(o.salt) : crypto.randomBytes(16);
  const ecdh = crypto.createECDH(P256);
  if (o.serverKey) ecdh.setPrivateKey(Buffer.from(o.serverKey));
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);

  // Two-stage HKDF: the first is salted with the subscription's auth secret and
  // binds both public keys, the second with the message salt. hkdfSync does
  // extract+expand in one call, which is exactly each stage.
  const keyInfo = Buffer.concat([INFO_KEY, uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, INFO_CEK, 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, INFO_NONCE, 12));

  const recordSize = o.recordSize || 4096;
  // 0x02 is the last-record delimiter. We never split records: a push payload
  // is capped at ~4kB by every push service anyway.
  const padded = Buffer.concat([Buffer.from(plaintext), Buffer.from([2])]);
  if (padded.length + 16 > recordSize) throw new Error('payload too large for one record');

  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(recordSize, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, ciphertext]);
}

// ------------------------------------------------------------------ delivery

const URGENCY = { 'very-low': 1, low: 1, normal: 1, high: 1 };

/**
 * POST one encrypted payload to one push service.
 *
 * Resolves `{ status, gone, retryAfterSec }` — it never rejects on an HTTP
 * error, because a dead subscription is an expected outcome, not a fault.
 * `gone` is the important one: 404 and 410 mean the subscription is permanently
 * dead (permission revoked, browser data cleared, app uninstalled) and the
 * caller must delete it. Retrying those forever is how a subscription store
 * quietly rots.
 */
function deliver(sub, body, opts) {
  const o = opts || {};
  const headers = {
    'content-encoding': 'aes128gcm',
    'content-type': 'application/octet-stream',
    'content-length': body.length,
    ttl: String(o.ttl === undefined ? 3600 : o.ttl),
    urgency: URGENCY[o.urgency] ? o.urgency : 'normal',
    authorization: vapidHeader(sub.endpoint, o.keys, o.subject, o.now),
  };
  // Topic lets the push service *replace* an undelivered message with the same
  // topic instead of queueing both. On a plane with the phone offline this is
  // what stops a week of backlog landing at once — he gets the latest of each
  // kind. Must be <=32 chars from the base64url alphabet.
  if (o.topic) headers.topic = String(o.topic).slice(0, 32);

  return new Promise((resolve) => {
    let req;
    const done = (v) => {
      if (req && !req.destroyed) req.destroy();
      resolve(v);
    };
    try {
      const u = new URL(sub.endpoint);
      if (u.protocol !== 'https:') return done({ status: 0, gone: true, error: 'endpoint is not https' });
      req = https.request(
        { hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: 'POST', headers },
        (res) => {
          res.resume(); // drain, we only care about the status
          const status = res.statusCode || 0;
          const ra = Number(res.headers['retry-after']);
          resolve({
            status,
            gone: status === 404 || status === 410,
            retryAfterSec: Number.isFinite(ra) ? ra : null,
          });
        }
      );
      req.setTimeout(o.timeoutMs || 10000, () => done({ status: 0, gone: false, error: 'timeout' }));
      req.on('error', (e) => resolve({ status: 0, gone: false, error: String((e && e.message) || e) }));
      req.end(body);
    } catch (e) {
      resolve({ status: 0, gone: false, error: String((e && e.message) || e) });
    }
  });
}

/** Encrypt for this subscription, then deliver. */
function sendOne(sub, payload, opts) {
  let body;
  try {
    body = encrypt(Buffer.from(payload, 'utf8'), sub.p256dh, sub.auth, opts);
  } catch (e) {
    // A subscription whose keys will not encrypt can never work again.
    return Promise.resolve({ status: 0, gone: true, error: String((e && e.message) || e) });
  }
  return deliver(sub, body, opts);
}

// -------------------------------------------------------------- quiet hours

/**
 * Minutes past local midnight in a named IANA zone, read out of the formatted
 * clock rather than computed from a stored offset — so DST, and flying to
 * Iceland, are both handled by ICU instead of by arithmetic here.
 */
function minutesInZone(tz, at) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hourCycle: 'h23', // not `hour12:false`, which yields "24" for midnight on some ICU builds
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(at || new Date());
  let h = 0;
  let m = 0;
  for (const p of parts) {
    if (p.type === 'hour') h = Number(p.value);
    if (p.type === 'minute') m = Number(p.value);
  }
  return ((h % 24) * 60 + m) % 1440;
}

/** True if this build's ICU actually knows the zone. Small-ICU builds know only UTC. */
function zoneIsKnown(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** "HH:MM" -> minutes past midnight, or null. Rejects anything else. */
function parseHhMm(s) {
  const m = /^([01][0-9]|2[0-3]):([0-5][0-9])$/.exec(String(s || '').trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function fmtHhMm(min) {
  const m = ((min % 1440) + 1440) % 1440;
  return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
}

/**
 * Is `nowMin` inside the window [from, to)?
 *
 * This is a pure membership test on minutes-past-midnight, and that is the
 * entire point. The watchdog's `--nudge-until` computed a *datetime* cutoff and
 * then did `if (cutoff <= now) cutoff += one day`, so the instant quiet time
 * arrived the window silently became tomorrow's and never suppressed anything.
 * There is no date here to roll forward, so that failure is unrepresentable:
 * the answer depends only on the wall clock, and a window either contains this
 * minute or it does not.
 *
 * from === to is "off", never "always" — an accidentally equal pair must not
 * silence everything forever.
 */
function inWindow(fromMin, toMin, nowMin) {
  if (fromMin === null || toMin === null || fromMin === toMin) return false;
  if (fromMin < toMin) return nowMin >= fromMin && nowMin < toMin; // within one day
  return nowMin >= fromMin || nowMin < toMin; // wraps midnight
}

/** Minutes until the window's next edge, so the UI can say "quiet in 3h12m". */
function minutesUntilEdge(fromMin, toMin, nowMin) {
  if (fromMin === null || toMin === null || fromMin === toMin) return null;
  const target = inWindow(fromMin, toMin, nowMin) ? toMin : fromMin;
  return ((target - nowMin) % 1440 + 1440) % 1440;
}

/**
 * The whole quiet-hours verdict, with everything the UI needs to show *which*
 * zone is in force. A zone the runtime cannot resolve degrades to UTC and says
 * so loudly via `zoneKnown: false`, rather than silently running on UTC the way
 * the watchdog container did.
 */
function quietState(cfg, at) {
  const now = at || new Date();
  const wanted = (cfg && cfg.timezone) || 'UTC';
  const zoneKnown = zoneIsKnown(wanted);
  const timezone = zoneKnown ? wanted : 'UTC';
  const nowMin = minutesInZone(timezone, now);
  const from = parseHhMm(cfg && cfg.quietFrom);
  const to = parseHhMm(cfg && cfg.quietTo);
  const configured = from !== null && to !== null && from !== to;
  const active = configured && inWindow(from, to, nowMin);
  const edge = configured ? minutesUntilEdge(from, to, nowMin) : null;
  return {
    timezone,
    requestedTimezone: wanted,
    zoneKnown,
    zoneNow: fmtHhMm(nowMin),
    configured,
    active,
    from: from === null ? null : fmtHhMm(from),
    to: to === null ? null : fmtHhMm(to),
    changesInMin: edge,
  };
}

module.exports = {
  b64u,
  unb64u,
  generateVapidKeys,
  looksLikeVapidKeys,
  vapidKeyObject,
  vapidHeader,
  encrypt,
  deliver,
  sendOne,
  minutesInZone,
  zoneIsKnown,
  parseHhMm,
  fmtHhMm,
  inWindow,
  minutesUntilEdge,
  quietState,
};
