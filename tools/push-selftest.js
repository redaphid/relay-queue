'use strict';

/*
 * push-selftest — the parts of web push that cannot be checked by looking.
 *
 * Four things here would otherwise only be discovered on his phone, abroad:
 *   1. the payload encryption, which is either byte-exact or completely broken;
 *   2. quiet hours, which is where the watchdog's `--nudge-until` bug lives;
 *   3. the rule that agent-to-agent `channel` traffic never reaches him;
 *   4. the rule that pushing is opt-in — the 17-in-an-hour regression.
 *
 * The last section boots a real server.js on a spare port with a throwaway
 * DATA_DIR; everything above it is pure and needs no network.
 *
 * Run: node tools/push-selftest.js
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const wp = require('../push.js');
const { classify, browserLabel, nudgeText } = require('../server.js');
const { startServer } = require('./harness-lib');

let failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
}

// ---------------------------------------------------------------- encryption

console.log('\nthe payload encryption matches the published RFC 8291 vector');
{
  /*
   * RFC 8291 section 5. Salt and server key are pinned to the ones in the spec,
   * which is the only way to compare a ciphertext byte for byte. If this passes,
   * the encryption is correct — not "looks plausible", correct.
   */
  const body = wp.encrypt(
    Buffer.from('When I grow up, I want to be a watermelon', 'utf8'),
    'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
    'BTBZMqHH6r4Tts7J_aSIgg',
    {
      salt: wp.unb64u('DGv6ra1nlYgDCS1FRnbzlw'),
      serverKey: wp.unb64u('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'),
      recordSize: 4096,
    }
  );
  const want =
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8w' +
    'EqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN';
  check('the whole aes128gcm body is byte-exact', wp.b64u(body) === want, wp.b64u(body));
  check('the salt is the first 16 bytes', wp.b64u(body.subarray(0, 16)) === 'DGv6ra1nlYgDCS1FRnbzlw');
  check('the record size is 4096', body.readUInt32BE(16) === 4096, String(body.readUInt32BE(16)));
  check('the key id length says 65', body.readUInt8(20) === 65, String(body.readUInt8(20)));
  check('the server public key is an uncompressed point', body.readUInt8(21) === 4);
}

console.log('\nencryption refuses keys it cannot use, rather than sending garbage');
{
  const goodP = 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4';
  const goodA = 'BTBZMqHH6r4Tts7J_aSIgg';
  const threw = (fn) => { try { fn(); return false; } catch { return true; } };
  check('a short p256dh is rejected', threw(() => wp.encrypt(Buffer.from('x'), 'AAAA', goodA, {})));
  check('a short auth secret is rejected', threw(() => wp.encrypt(Buffer.from('x'), goodP, 'AAAA', {})));
  check('an oversized payload is rejected', threw(() => wp.encrypt(Buffer.alloc(5000), goodP, goodA, {})));
  check('a normal payload is accepted', !threw(() => wp.encrypt(Buffer.from('hello'), goodP, goodA, {})));
}

console.log('\nrandomness is per-message, so two sends never repeat a nonce');
{
  const p = 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4';
  const a = 'BTBZMqHH6r4Tts7J_aSIgg';
  const one = wp.encrypt(Buffer.from('same text'), p, a, {});
  const two = wp.encrypt(Buffer.from('same text'), p, a, {});
  check('the same plaintext encrypts differently each time', !one.equals(two));
  check('the salts differ', !one.subarray(0, 16).equals(two.subarray(0, 16)));
  check('the ephemeral server keys differ', !one.subarray(21, 86).equals(two.subarray(21, 86)));
}

// -------------------------------------------------------------------- VAPID

console.log('\nthe VAPID key pair and its JWT are well formed');
{
  const keys = wp.generateVapidKeys();
  check('the pair validates', wp.looksLikeVapidKeys(keys));
  check('the public key is 65 bytes', wp.unb64u(keys.publicKey).length === 65, String(wp.unb64u(keys.publicKey).length));
  check('the public key is an uncompressed point', wp.unb64u(keys.publicKey)[0] === 4);
  check('the private scalar is 32 bytes', wp.unb64u(keys.privateKey).length === 32);
  check('a truncated pair is rejected', !wp.looksLikeVapidKeys({ publicKey: 'AAAA', privateKey: keys.privateKey }));
  check('an empty pair is rejected', !wp.looksLikeVapidKeys({}));

  const header = wp.vapidHeader('https://updates.push.services.mozilla.com/wpush/v2/abc', keys, 'mailto:a@b.c');
  check('the header is a vapid scheme', header.indexOf('vapid t=') === 0, header.slice(0, 20));
  check('the header carries the public key', header.indexOf(`k=${keys.publicKey}`) > 0);

  const jwt = header.slice('vapid t='.length).split(',')[0].trim();
  const [h64, p64, s64] = jwt.split('.');
  const head = JSON.parse(wp.unb64u(h64).toString('utf8'));
  const claims = JSON.parse(wp.unb64u(p64).toString('utf8'));
  check('the algorithm is ES256', head.alg === 'ES256', String(head.alg));
  /*
   * `aud` must be the PUSH SERVICE's origin, not ours. Mozilla answers 401 on a
   * mismatch, which surfaces as "notifications just do not arrive" — the single
   * least debuggable failure in this whole feature.
   */
  check('aud is the push service origin', claims.aud === 'https://updates.push.services.mozilla.com', String(claims.aud));
  check('sub is carried through', claims.sub === 'mailto:a@b.c');
  check('exp is in the future', claims.exp > Math.floor(Date.now() / 1000));
  check('exp is within the 24h the spec allows', claims.exp < Math.floor(Date.now() / 1000) + 24 * 3600);

  // The signature must verify against the very key we advertise in `k=`.
  const pub = wp.unb64u(keys.publicKey);
  const pubKey = crypto.createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: wp.b64u(pub.subarray(1, 33)), y: wp.b64u(pub.subarray(33, 65)) },
    format: 'jwk',
  });
  const okSig = crypto.verify('sha256', Buffer.from(`${h64}.${p64}`), { key: pubKey, dsaEncoding: 'ieee-p1363' }, wp.unb64u(s64));
  check('the signature verifies against the advertised key', okSig);
  const badSig = crypto.verify('sha256', Buffer.from(`${h64}.${p64}x`), { key: pubKey, dsaEncoding: 'ieee-p1363' }, wp.unb64u(s64));
  check('a tampered token does not verify', !badSig);

  const other = wp.vapidHeader('https://fcm.googleapis.com/fcm/send/xyz', keys, 'mailto:a@b.c');
  const otherClaims = JSON.parse(wp.unb64u(other.slice('vapid t='.length).split(',')[0].trim().split('.')[1]).toString('utf8'));
  check('a Chrome endpoint gets its own aud', otherClaims.aud === 'https://fcm.googleapis.com', String(otherClaims.aud));
}

// -------------------------------------------------------------- quiet hours

console.log('\nquiet hours: the clock is parsed strictly');
{
  check('00:00 parses to 0', wp.parseHhMm('00:00') === 0);
  check('23:59 parses to 1439', wp.parseHhMm('23:59') === 1439);
  check('07:30 parses to 450', wp.parseHhMm('07:30') === 450);
  check('24:00 is refused', wp.parseHhMm('24:00') === null);
  check('7:30 without a leading zero is refused', wp.parseHhMm('7:30') === null);
  check('nonsense is refused', wp.parseHhMm('later') === null);
  check('empty is refused', wp.parseHhMm('') === null);
  check('null is refused', wp.parseHhMm(null) === null);
  check('minutes above 59 are refused', wp.parseHhMm('10:75') === null);
  check('formatting round-trips', wp.fmtHhMm(450) === '07:30', wp.fmtHhMm(450));
}

console.log('\nquiet hours: a window that has already passed today does NOT roll to tomorrow');
{
  /*
   * The regression this whole design exists to avoid. relay-watchdog's
   * `--nudge-until` computed a datetime cutoff and then did
   *     if (cutoff <= now) cutoff += one day
   * so the moment quiet time passed, the window silently became TOMORROW's and
   * stayed armed all night — it was found still armed at 05:00, configured to
   * escalate to voice in his bedroom every 15 minutes.
   *
   * inWindow() is a pure membership test on minutes-past-midnight. There is no
   * date to roll forward, so that failure is not representable. These checks
   * pin that.
   */
  const from = 22 * 60;      // 22:00
  const to = 23 * 60;        // 23:00
  check('inside the window is quiet', wp.inWindow(from, to, 22 * 60 + 30) === true);
  check('at the opening edge is quiet', wp.inWindow(from, to, from) === true);
  check('at the closing edge is NOT quiet (half-open)', wp.inWindow(from, to, to) === false);
  check('half an hour after it ended is NOT quiet', wp.inWindow(from, to, 23 * 60 + 30) === false);
  check('the next morning is NOT quiet', wp.inWindow(from, to, 9 * 60) === false);
  check('an hour before it starts is NOT quiet', wp.inWindow(from, to, 21 * 60) === false);
}

console.log('\nquiet hours: a window across midnight works in both halves of the night');
{
  const from = 23 * 60;          // 23:00
  const to = 7 * 60 + 30;        // 07:30
  check('23:30 is quiet', wp.inWindow(from, to, 23 * 60 + 30) === true);
  check('03:00 is quiet', wp.inWindow(from, to, 3 * 60) === true);
  check('07:29 is quiet', wp.inWindow(from, to, 7 * 60 + 29) === true);
  check('07:30 is awake again', wp.inWindow(from, to, 7 * 60 + 30) === false);
  check('midday is awake', wp.inWindow(from, to, 12 * 60) === false);
  check('22:59 is awake', wp.inWindow(from, to, 22 * 60 + 59) === false);
}

console.log('\nquiet hours: a degenerate window is off, never "always"');
{
  check('from equal to to is off', wp.inWindow(600, 600, 600) === false);
  check('a null start is off', wp.inWindow(null, 600, 300) === false);
  check('a null end is off', wp.inWindow(600, null, 900) === false);
  check('an equal window has no next edge', wp.minutesUntilEdge(600, 600, 300) === null);
}

console.log('\nquiet hours: the countdown to the next edge is right');
{
  const from = 23 * 60;
  const to = 7 * 60 + 30;
  check('awake at 20:00, quiet starts in 3h', wp.minutesUntilEdge(from, to, 20 * 60) === 180);
  check('quiet at 02:00, it lifts in 5h30', wp.minutesUntilEdge(from, to, 2 * 60) === 330);
  check('quiet at 23:00, it lifts in 8h30', wp.minutesUntilEdge(from, to, 23 * 60) === 510);
  check('awake at 07:30, quiet starts in 15h30', wp.minutesUntilEdge(from, to, 7 * 60 + 30) === 930);
}

console.log('\nquiet hours are anchored to a named zone, and say which one');
{
  /*
   * He is flying UTC-7 -> UTC+0 this week. At this instant it is 07:00 in Los
   * Angeles and 14:00 in Reykjavik, so a 23:00-07:30 window is still in force
   * in one and long over in the other. Getting this wrong is the difference
   * between silence at breakfast and a buzz at 3am.
   */
  const at = new Date('2026-08-10T14:00:00Z');
  const cfg = { quietFrom: '23:00', quietTo: '07:30' };

  const la = wp.quietState({ ...cfg, timezone: 'America/Los_Angeles' }, at);
  check('Los Angeles reads 07:00', la.zoneNow === '07:00', la.zoneNow);
  check('...so it is still quiet there', la.active === true);
  check('...and it names the zone in force', la.timezone === 'America/Los_Angeles', la.timezone);

  const rk = wp.quietState({ ...cfg, timezone: 'Atlantic/Reykjavik' }, at);
  check('Reykjavik reads 14:00', rk.zoneNow === '14:00', rk.zoneNow);
  check('...so it is not quiet there', rk.active === false);
  check('...and the same window is reported', rk.from === '23:00' && rk.to === '07:30');
  check('the two zones genuinely disagree', la.active !== rk.active);

  const utc = wp.quietState({ ...cfg, timezone: 'UTC' }, at);
  check('UTC reads 14:00 too', utc.zoneNow === '14:00', utc.zoneNow);
}

console.log('\nan unknown timezone degrades to UTC loudly, never silently');
{
  /*
   * The watchdog container ran UTC with no TZ set and nobody knew. Here an
   * unresolvable zone still falls back to UTC — but says so, so the UI can
   * print it rather than quietly applying the wrong clock.
   */
  const s = wp.quietState({ timezone: 'Mars/Olympus_Mons', quietFrom: '23:00', quietTo: '07:30' }, new Date('2026-08-10T14:00:00Z'));
  check('it falls back to UTC', s.timezone === 'UTC', s.timezone);
  check('it reports the zone as unknown', s.zoneKnown === false);
  check('it remembers what was asked for', s.requestedTimezone === 'Mars/Olympus_Mons');
  check('a real zone is reported as known', wp.quietState({ timezone: 'Atlantic/Reykjavik' }, new Date()).zoneKnown === true);
  check('zoneIsKnown accepts a real zone', wp.zoneIsKnown('Europe/London') === true);
  check('zoneIsKnown rejects a fake one', wp.zoneIsKnown('Nowhere/Nothing') === false);
  check('zoneIsKnown rejects an empty string', wp.zoneIsKnown('') === false);
}

console.log('\nwith no window set, nothing is ever suppressed');
{
  const s = wp.quietState({ timezone: 'Atlantic/Reykjavik' }, new Date('2026-08-10T03:00:00Z'));
  check('it is not configured', s.configured === false);
  check('it is not active at 3am', s.active === false);
  check('there is no countdown', s.changesInMin === null);
}

console.log('\nmidnight does not read as hour 24');
{
  // `hour12: false` yields "24" for midnight on some ICU builds, which would
  // put minute-of-day at 1440 and fall outside every window.
  const m = wp.minutesInZone('UTC', new Date('2026-08-10T00:15:00Z'));
  check('00:15 UTC is 15 minutes past midnight', m === 15, String(m));
  check('23:45 UTC is 1425', wp.minutesInZone('UTC', new Date('2026-08-10T23:45:00Z')) === 1425);
}

// ------------------------------------------------------------ what notifies

console.log('\nagent-to-agent channel traffic NEVER reaches his phone');
{
  /*
   * Rule zero. Anything with a `channel` carries visibility:'internal', and 12%
   * of one night's messages were agent coordination. If this ever regresses,
   * every one of them buzzes him.
   */
  const chan = { visibility: 'internal', channel: 'agents', conversationId: '#agents', from: 'vega', instruction: 'hi' };
  check('a channel message does not notify', classify('message', chan, null) === null);
  check('...not even hinted as needs-you', classify('message', chan, 'needs-you') === null);
  check('...not even hinted as broken', classify('message', chan, 'broken') === null);
  check('...not as a task', classify('task', chan, null) === null);
  check('...not as a result', classify('result', chan, null) === null);
  check('...and not with a bogus hint', classify('message', chan, 'nonsense') === null);
}

console.log('\nthe page never buzzes the phone that just sent the message');
{
  /*
   * `checklist` is in this list for a reason. It was missing: ticking a box on
   * his own phone posts a task with from:'checklist', which fell through to
   * 'needs-you' and pushed a notification back at the phone that had just sent
   * it — he ticked a box and got buzzed about it, by himself. PAGE_ORIGINS is
   * an allowlist that defaults to NOTIFY, so every posting surface the UI grows
   * must be added here or it will do this again. Any new origin belongs in this
   * loop on the same day it is invented.
   */
  for (const from of ['web', 'voice', 'voice-conversation', 'checklist']) {
    check(`a task he typed from "${from}" does not notify`, classify('task', { from, conversationId: 'main' }, null) === null);
  }
  check('a task from an agent does notify', classify('task', { from: 'vega', conversationId: 'main' }, null) === 'needs-you');
  check('a task from nobody notifies', classify('task', { from: null, conversationId: 'main' }, null) === 'needs-you');
  // The result side reads the same list, so a tick he is waiting on still lands.
  check('...and the answer to a checklist tick is still "done"',
    classify('result', { role: 'user', from: 'checklist', conversationId: 'main' }, null) === 'done');
}

console.log('\npushing is OPT-IN: an agent that says nothing wakes nobody');
{
  /*
   * The 2026-08-08 incident, pinned. classify() used to end
   *   if (kind === 'result' || kind === 'message') return 'done';
   * so every agent result and every agent message in one of his conversations
   * buzzed his phone: 17 pushes in an hour, 16 of them the word "done", while
   * he was abroad and could not walk away from the channel. If any of the
   * `=== null` checks below ever go green as 'done' again, that hour is back.
   */
  const agentTask = { role: 'user', conversationId: 'main', from: 'vega' }; // an agent posted it
  const hisTask = { role: 'user', conversationId: 'main', from: 'web' };    // he typed it on the page
  const agentMsg = { role: 'agent', conversationId: 'main', from: 'agent' }; // POST /messages

  check('an agent message is silent', classify('message', agentMsg, null) === null);
  check('...whoever it claims to be from', classify('message', { ...agentMsg, from: 'web' }, null) === null);
  check('...and an unknown hint does not revive the old default',
    classify('message', agentMsg, 'whatever') === null);
  check('a result on an agent-posted task is silent', classify('result', agentTask, null) === null);
  check('...ditto a task from nobody', classify('result', { role: 'user', from: null }, null) === null);
  check('...ditto a task the message route created', classify('result', agentMsg, null) === null);
  check('...and an unknown hint does not revive it either',
    classify('result', agentTask, 'whatever') === null);
}

console.log('\n...but the answer to something HE asked for is exactly what he wants');
{
  // "Things I was waiting on that finished" — the one surviving default.
  for (const from of ['web', 'voice', 'voice-conversation']) {
    check(`a result on a task he posted from "${from}" is "done"`,
      classify('result', { role: 'user', conversationId: 'main', from }, null) === 'done');
  }
  check('an unknown hint falls back to that same default',
    classify('result', { role: 'user', from: 'web' }, 'whatever') === 'done');
  // role is the belt to PAGE_ORIGINS' braces: a page origin is not enough on
  // its own if the record was not the human speaking.
  check('a page origin alone is not enough without role:"user"',
    classify('result', { role: 'agent', from: 'web' }, null) === null);
}

console.log('\nan explicit hint still wins, and "none" still silences everything');
{
  const t = { role: 'user', conversationId: 'main', from: 'vega' };
  const his = { role: 'user', conversationId: 'main', from: 'web' };
  check('an explicit "broken" wins over silence', classify('result', t, 'broken') === 'broken');
  check('an explicit "needs-you" wins over silence', classify('result', t, 'needs-you') === 'needs-you');
  check('an explicit "done" wins over silence', classify('message', t, 'done') === 'done');
  check('an explicit "none" silences a result', classify('result', t, 'none') === null);
  check('...even one he was waiting for', classify('result', his, 'none') === null);
  check('"none" silences a task too', classify('task', t, 'none') === null);
  check('a missing task notifies nothing', classify('result', null, null) === null);
  check('an unknown kind notifies nothing', classify('mystery', t, null) === null);
}

console.log('\nbrowsers are named, so he can tell which one is armed');
{
  check('Firefox on Android', browserLabel('Mozilla/5.0 (Android 16; Mobile; rv:153.0) Gecko/153.0 Firefox/153.0') === 'Firefox 153');
  check('Chrome on Android', browserLabel('Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36') === 'Chrome 150');
  check('something unrecognised', browserLabel('curl/8.0') === 'this browser');
  check('nothing at all', browserLabel(null) === 'this browser');
}

console.log('\nthe stale-pending nudge is one short line, not a sentence');
{
  /*
   * relay-watchdog's phrasing for the same situation is a full sentence:
   * "X has not picked up a message in Y for N minutes. Opening the thread
   * will deliver it." He explicitly asked for less token waste, so this one
   * is deliberately terser — a single line, no trailing period, no verb.
   */
  const one = nudgeText({ count: 1, oldestAgeSec: 190, title: 'Sporefall' });
  check('one unclaimed task reads naturally', one === '1 unclaimed 3 min in Sporefall', one);
  check('it is a single line', !one.includes('\n'));
  check('it is short — well under a sentence', one.length < 60, String(one.length));
  const many = nudgeText({ count: 3, oldestAgeSec: 610, title: 'relay-queue' });
  check('several unclaimed tasks still read as one line', many === '3 unclaimed 10 min in relay-queue', many);
}

// ------------------------------------------------- the same rule, over HTTP

/*
 * classify() is the rule; this is the proof that the rule is wired to the wire.
 * A real server.js, a real socket, and the counters /push/config already
 * exposes — `queued` moves the instant something is accepted for sending, so a
 * delta of zero across a POST is proof that the POST buzzed nobody.
 *
 * SAFETY, deliberately, because this test lives one typo away from his pocket:
 *
 *  - Push is left ENABLED. With PUSH=0 the notify path returns before `queued`
 *    is ever incremented, so every assertion below would pass vacuously and
 *    prove precisely nothing. Enabled counters are the only meaningful ones.
 *  - Nothing can leave the machine regardless: sendToAll() returns immediately
 *    while `subscriptions.size === 0`, and a throwaway DATA_DIR has no
 *    subscriptions in it. The first check asserts that the device list is
 *    empty and the run ABORTS if it is not, so this can never fire at his
 *    phone even if pointed at the wrong directory.
 *  - `delivered` is asserted to be 0 at the end: nothing was ever sent.
 *  - POST /push/test is never called. It bypasses the debounce AND quiet hours
 *    by design and would buzz his handset. It is a wiring check for his thumb.
 *  - A scratch PORT, never 3901. The live instance is never touched.
 */

// The server under test is started through tools/harness-lib.js, which owns
// the path, the port, and the proof of identity.
const TEST_PORT = Number(process.env.PUSH_TEST_PORT || 0);
const DEBOUNCE_MS = 40;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The scratch instance, set by overHttp(). Everything reads srv.base. */
let srv = null;

const getJson = async (p) => (await fetch(srv.base + p)).json();
async function post(p, body) {
  const res = await fetch(srv.base + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body === undefined ? {} : body),
  });
  return { status: res.status, body: await res.json() };
}

/*
 * How many notifications did this action put on the wire? Waits out the
 * debounce afterwards so consecutive steps cannot coalesce into one slot and
 * make a later step look silent when it was merely folded into an earlier one.
 */
async function queuedBy(fn) {
  const before = (await getJson('/push/config')).stats.queued;
  await fn();
  await sleep(DEBOUNCE_MS * 5);
  return (await getJson('/push/config')).stats.queued - before;
}

async function overHttp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-push-'));
  srv = await startServer({
    dir,
    port: TEST_PORT,
    label: 'push',
    env: {
      WATCH_TICK_MS: '600000',  // the deadman must not queue a 'broken' mid-run
      PUSH_DEBOUNCE_MS: String(DEBOUNCE_MS),
    },
    // PUSH must be ON, or the counters never move (see above); the hourly
    // ceiling(s) must be the compiled-in defaults, because that is what is asserted.
    unsetEnv: ['PUSH', 'PUSH_PER_HOUR', 'PUSH_PER_HOUR_ALERTS'],
  });

  try {
    /*
     * The port is the OS's choice, so it is stated rather than promised — and
     * whatever it is, the server answering on it has already proved it is the
     * child spawned two lines up. Which matters more here than anywhere: the
     * safety argument for this file rests on the instance under test having no
     * subscriptions, and that argument is void if it is not the instance being
     * measured.
     */
    console.log(`\nover HTTP: a scratch instance on ${srv.port} that can reach nobody`);
    const cfg0 = await getJson('/push/config');
    if (!Array.isArray(cfg0.devices) || cfg0.devices.length !== 0) {
      throw new Error('ABORT: this instance has subscribed devices — refusing to run, it could buzz a real phone');
    }
    check('no browser is subscribed, so nothing can be delivered', cfg0.devices.length === 0);
    check('push is enabled, so the counters mean something', cfg0.enabled === true);
    check('no notification has been queued yet', cfg0.stats.queued === 0, JSON.stringify(cfg0.stats));
    check('quiet hours are unset, so nothing is suppressed for the wrong reason', cfg0.quiet.configured === false);
    check('the "done" ceiling defaults to 6', cfg0.budgetLeftDone === 6, String(cfg0.budgetLeftDone));
    check('the alerts ceiling defaults to 20, so needs-you/broken get their own room', cfg0.budgetLeftAlerts === 20, String(cfg0.budgetLeftAlerts));
    check('budgetLeft is still the sum, for back-compat readers', cfg0.budgetLeft === 26, String(cfg0.budgetLeft));

    console.log('\nover HTTP: agent chatter queues NOTHING');
    check('an agent message with no hint queues nothing',
      await queuedBy(() => post('/messages', { text: 'done, boss', agent: 'vega', conversationId: 'main' })) === 0);
    check('...a hundred of them would still queue nothing',
      await queuedBy(() => post('/messages', { text: 'still working on it', agent: 'rune', conversationId: 'main' })) === 0);
    check('a channel message still queues nothing',
      await queuedBy(() => post('/messages', { text: 'internal chatter', agent: 'vega', channel: 'agents' })) === 0);
    check('...not even hinted "broken"',
      await queuedBy(() => post('/messages', { text: 'internal alarm', agent: 'vega', channel: 'agents', notify: 'broken' })) === 0);

    console.log('\nover HTTP: a result only buzzes when HE was the one waiting');
    let agentTaskId = null;
    check('a task posted BY an agent queues one "needs you"',
      await queuedBy(async () => {
        agentTaskId = (await post('/tasks', { text: 'please confirm the plan', from: 'vega' })).body.id;
      }) === 1);
    check('...but the result answering it queues nothing',
      await queuedBy(() => post(`/tasks/${agentTaskId}/result`, { result: 'confirmed' })) === 0);

    let hisTaskId = null;
    check('a task HE typed on the page queues nothing',
      await queuedBy(async () => {
        hisTaskId = (await post('/tasks', { text: 'what is the status', from: 'web' })).body.id;
      }) === 0);
    check('...and the result answering it DOES queue one',
      await queuedBy(() => post(`/tasks/${hisTaskId}/result`, { result: 'here you go' })) === 1);

    /*
     * The tick-buzzes-himself bug, over the wire. from:'checklist' was not in
     * PAGE_ORIGINS, so his own tick fell through to 'needs-you' and pushed
     * straight back at the phone that had just sent it.
     */
    check('ticking a checklist box on his own phone queues nothing',
      await queuedBy(() => post('/tasks', {
        text: 'Checked off: “buy milk” — please tick it off in Vikunja.', from: 'checklist',
      })) === 0);

    console.log('\nover HTTP: and that one is specifically the "done" category');
    {
      /*
       * queueNotify() drops a category he has switched off *before* bumping
       * `queued`, so switching exactly one category off and watching the same
       * action fall to zero names the category the counters cannot name.
       */
      await post('/push/config', { categories: { done: false } });
      const n = await queuedBy(async () => {
        const id = (await post('/tasks', { text: 'and now?', from: 'voice' })).body.id;
        await post(`/tasks/${id}/result`, { result: 'answered' });
      });
      check('with "done" switched off, the same result queues nothing', n === 0, String(n));
      await post('/push/config', { categories: { done: true } });
    }

    console.log('\nover HTTP: an explicit hint is how an agent opts in');
    const msg = (text, notify) => post('/messages', { text, agent: 'vega', conversationId: 'main', notify });
    check('a message hinted "broken" queues one', await queuedBy(() => msg('the disk is full', 'broken')) === 1);
    check('a message hinted "needs-you" queues one', await queuedBy(() => msg('which branch?', 'needs-you')) === 1);
    check('a message hinted "done" queues one', await queuedBy(() => msg('the build you asked about is green', 'done')) === 1);

    console.log('\nover HTTP: "none" still silences everything');
    check('a message hinted "none" queues nothing', await queuedBy(() => msg('nothing to see here', 'none')) === 0);
    check('a task from an agent hinted "none" queues nothing',
      await queuedBy(() => post('/tasks', { text: 'do not buzz him for this', from: 'vega', notify: 'none' })) === 0);
    check('a result he WAS waiting for, hinted "none", queues nothing',
      await queuedBy(async () => {
        const id = (await post('/tasks', { text: 'quietly, please', from: 'web' })).body.id;
        await post(`/tasks/${id}/result`, { result: 'done quietly', notify: 'none' });
      }) === 0);

    console.log('\nover HTTP: the counters add up, and nothing left the machine');
    const end = await getJson('/push/config');
    check('exactly 5 notifications were ever queued', end.stats.queued === 5, JSON.stringify(end.stats));
    check('all of them flushed', end.stats.flushed === 5, String(end.stats.flushed));
    check('none were suppressed by quiet hours (none are set)', end.stats.suppressedQuiet === 0);
    check('none were suppressed by the hourly budget', end.stats.suppressedBudget === 0);
    /*
     * Of the 5: 2 are "done" (his own task answered by voice, and the explicit
     * "done" hint), 2 are "needs-you" (the agent-posted task, and the explicit
     * hint), 1 is "broken" (the explicit hint) — so the "done" pool spent 2 of
     * its 6 and the alerts pool spent 3 of its 20, from two independent
     * counters that a shared budget would have conflated.
     */
    check('the "done" pool spent matches its 2 flushes', end.budgetLeftDone === 6 - 2, String(end.budgetLeftDone));
    check('the alerts pool spent matches its 3 flushes', end.budgetLeftAlerts === 20 - 3, String(end.budgetLeftAlerts));
    check('budgetLeft is still the sum of both pools', end.budgetLeft === end.budgetLeftDone + end.budgetLeftAlerts,
      `${end.budgetLeft} vs ${end.budgetLeftDone}+${end.budgetLeftAlerts}`);
    check('NOTHING was delivered — there was never a device to deliver to', end.stats.delivered === 0);
    check('the server never tried the network', srv.out.indexOf('[push] sent') === -1);
  } catch (e) {
    failures++;
    console.log(`  FAIL the HTTP section did not run — ${e && e.message}`);
    if (srv.out) console.log(srv.out.split('\n').slice(-8).map((l) => `       | ${l}`).join('\n'));
  } finally {
    await srv.stop();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* windows can hold it briefly */ }
  }
}

// --------------------------------------------------- the 2-minute nudge, live

/*
 * A second, isolated server instance, on purpose: it drives NUDGE_PENDING_MS
 * and NUDGE_RENUDGE_MS down to human-visible-but-fast scale (same trick
 * WAITING_GRACE_MS etc. use elsewhere — "the selftest also leans on these to
 * exercise the transitions in seconds") so this proves the real 15s tick and
 * 2-minute threshold logic without the test taking two minutes to run.
 * Sharing the first server's counters would also make the exact-count
 * assertions above fragile against timing.
 *
 * stalePending()'s age check rounds to the nearest SECOND before comparing
 * (same style as stuckClaims()'s forSec, elsewhere in server.js) — utterly
 * negligible at the real 2-minute threshold, but it means the moment of
 * crossing STALE_MS is only known to within ~500ms either side. So
 * NUDGE_RENUDGE_MS here is set much larger than that band plus the window
 * used to check "exactly one nudge happened" — otherwise a second, entirely
 * legitimate nudge can land inside that window and the assertion is really
 * testing timing noise, not the dedup logic. (First draft of this test used
 * a 1s cooldown against a ~2.7s check window and saw exactly that: 2 nudges
 * where 1 was expected, both real.)
 */
async function overHttpNudge() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-nudge-'));
  const TICK_MS = 200;
  const STALE_MS = 2000;
  const RENUDGE_MS = 4000;
  srv = await startServer({
    dir,
    port: TEST_PORT,
    label: 'nudge',
    env: {
      WATCH_TICK_MS: String(TICK_MS),
      NUDGE_PENDING_MS: String(STALE_MS),
      NUDGE_RENUDGE_MS: String(RENUDGE_MS),
      PUSH_DEBOUNCE_MS: String(DEBOUNCE_MS),
    },
    unsetEnv: ['PUSH', 'PUSH_PER_HOUR', 'PUSH_PER_HOUR_ALERTS'],
    timeoutMs: 20000,
  });

  try {
    console.log(`\nover HTTP: a stale pending task in an ASSIGNED conversation nudges once`);
    const conv = (await post('/conversations', { title: 'Sporefall art batch', agent: 'coord-props' })).body;
    const before = (await getJson('/push/config')).stats.queued;
    // from:'web' deliberately — a page origin, so task CREATION itself queues
    // nothing (classify()'s PAGE_ORIGINS rule, proven above). That isolates
    // every queued count below to the nudge mechanism, not the ordinary
    // "a task needs you" notify this route already sends for agent-posted work.
    const task = (await post('/tasks', { text: 'ready to render — go?', from: 'web', conversationId: conv.id })).body;
    check('task creation itself queued nothing (from:"web")', (await getJson('/push/config')).stats.queued === before,
      String((await getJson('/push/config')).stats.queued));

    // Well under the 2s threshold (rounds to at most 1s) — proves the check
    // can say "not yet", not just "yes" (COORDINATOR.md: prove it can fail).
    await sleep(800);
    const early = await getJson('/watch');
    check('not stale yet — under the threshold', early.stalePendingCount === 0, JSON.stringify(early.stalePending));
    const stillZero = (await getJson('/push/config')).stats.queued;
    check('...so nothing queued yet', stillZero === before, String(stillZero));

    // T0+3000: past STALE_MS even accounting for the ~500ms rounding band
    // (worst case it crossed as early as T0+1500), and nowhere near
    // RENUDGE_MS's earliest possible expiry (1500+4000=5500) — so exactly one
    // nudge, never zero, never two.
    await sleep(2200);
    const w1 = await getJson('/watch');
    check('the watch snapshot names the stale conversation', w1.stalePendingCount === 1, JSON.stringify(w1.stalePending));
    check('...with the right title and count', w1.stalePending[0] && w1.stalePending[0].title === conv.title && w1.stalePending[0].count === 1,
      JSON.stringify(w1.stalePending));
    const afterFirst = (await getJson('/push/config')).stats.queued;
    check('exactly one nudge queued for the one stale task', afterFirst - before === 1, String(afterFirst - before));

    console.log('\nover HTTP: it does NOT repeat every tick — that would be the spam this replaces');
    // T0+4500: several more ticks, still well inside even the earliest
    // possible re-nudge cooldown expiry (5500).
    await sleep(1500);
    const stillOne = (await getJson('/push/config')).stats.queued;
    check('no repeat nudge before the re-nudge cooldown elapses', stillOne === afterFirst, String(stillOne));

    console.log('\nover HTTP: still unclaimed after the re-nudge cooldown DOES nudge again');
    // T0+7000: past even the LATEST possible cooldown expiry (worst-case
    // first nudge at T0+2500, +4000 = 6500), so the second nudge has
    // definitely happened, and definitely not a third (7000 < 6500+4000).
    await sleep(2500);
    const afterSecond = (await getJson('/push/config')).stats.queued;
    check('a second nudge fires once the cooldown has passed', afterSecond - afterFirst === 1, String(afterSecond - afterFirst));

    console.log('\nover HTTP: claiming it stops the nudges');
    await post(`/tasks/${task.id}/claim`, { by: 'coord-props' });
    await sleep(TICK_MS * 3);
    const w2 = await getJson('/watch');
    check('claimed — no longer reported as stale-pending', w2.stalePendingCount === 0, JSON.stringify(w2.stalePending));
    const afterClaim = (await getJson('/push/config')).stats.queued;
    check('...and no further nudge queued for it', afterClaim === afterSecond, String(afterClaim));

    console.log('\nover HTTP: a conversation with NO assigned coordinator is never nudged');
    const orphan = (await post('/conversations', { title: 'nobody home' })).body;
    check('created with no agent', orphan.agent === null || orphan.agent === undefined, JSON.stringify(orphan.agent));
    await post('/tasks', { text: 'anyone?', from: 'web', conversationId: orphan.id });
    await sleep(2700); // safely past STALE_MS even with the rounding band
    const w3 = await getJson('/watch');
    const orphanListed = (w3.stalePending || []).some((g) => g.conversationId === orphan.id);
    check('unassigned conversation is excluded from stalePending', !orphanListed, JSON.stringify(w3.stalePending));
    const afterOrphan = (await getJson('/push/config')).stats.queued;
    check('...and it queued no nudge', afterOrphan === afterClaim, String(afterOrphan));
  } catch (e) {
    failures++;
    console.log(`  FAIL the nudge HTTP section did not run — ${e && e.message}`);
    if (srv.out) console.log(srv.out.split('\n').slice(-8).map((l) => `       | ${l}`).join('\n'));
  } finally {
    await srv.stop();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* windows can hold it briefly */ }
  }
}

overHttp().then(overHttpNudge).then(() => {
  console.log(failures ? `\n${failures} check(s) FAILED\n` : '\nall checks passed\n');
  process.exit(failures ? 1 : 0);
}).catch((err) => {
  /*
   * A server that never booted lands here, carrying the child's own output in
   * the message. It must exit non-zero: a run that aborted before its first
   * assertion prints no verdict at all, and "no failures" and "never ran" are
   * indistinguishable to anything reading the log rather than the exit code.
   */
  console.error(`\nFAIL — the push selftest could not run\n${err && err.message ? err.message : err}\n`);
  process.exit(1);
});
