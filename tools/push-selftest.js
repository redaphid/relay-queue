'use strict';

/*
 * push-selftest — the parts of web push that cannot be checked by looking.
 *
 * Three things here would otherwise only be discovered on his phone, abroad:
 *   1. the payload encryption, which is either byte-exact or completely broken;
 *   2. quiet hours, which is where the watchdog's `--nudge-until` bug lives;
 *   3. the rule that agent-to-agent `channel` traffic never reaches him.
 *
 * No server, no browser, no network. Run: node tools/push-selftest.js
 */

const crypto = require('node:crypto');
const wp = require('../push.js');
const { classify, browserLabel } = require('../server.js');

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
  for (const from of ['web', 'voice', 'voice-conversation']) {
    check(`a task he typed from "${from}" does not notify`, classify('task', { from, conversationId: 'main' }, null) === null);
  }
  check('a task from an agent does notify', classify('task', { from: 'vega', conversationId: 'main' }, null) === 'needs-you');
  check('a task from nobody notifies', classify('task', { from: null, conversationId: 'main' }, null) === 'needs-you');
}

console.log('\nthe three categories are chosen sensibly, and hints win');
{
  const t = { conversationId: 'main', from: 'vega' };
  check('a result is "done"', classify('result', t, null) === 'done');
  check('an agent message is "done"', classify('message', t, null) === 'done');
  check('an explicit "broken" wins', classify('result', t, 'broken') === 'broken');
  check('an explicit "needs-you" wins', classify('result', t, 'needs-you') === 'needs-you');
  check('an explicit "none" silences it', classify('result', t, 'none') === null);
  check('"none" silences a task too', classify('task', t, 'none') === null);
  check('an unknown hint falls back to the default', classify('result', t, 'whatever') === 'done');
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

console.log(failures ? `\n${failures} check(s) FAILED\n` : '\nall checks passed\n');
process.exit(failures ? 1 : 0);
