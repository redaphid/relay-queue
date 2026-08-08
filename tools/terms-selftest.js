'use strict';
/*
 * terms-selftest — does the transcript repair fix what it should, and nothing else?
 *
 *   node tools/terms-selftest.js
 *
 * The first block is ground truth, not invention: every one of these is a real
 * thing the Whisper model produced while the user was dictating, including three
 * consecutive failed attempts to say the word "Claude" and one attempt to spell
 * it out letter by letter.
 *
 * The second block matters more. A wrong correction is worse than a missed one —
 * this text becomes instructions an agent acts on — so ordinary English has to
 * come through completely untouched, and the words that sound like our
 * vocabulary ("cold", "called", "the cloud") are the ones most likely to break.
 *
 * Zero dependencies. Requires server.js directly; it exports its pure helpers and
 * boots nothing when required.
 */
const { repairTranscript, metaphone } = require('../server.js');

let failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
}

/** Asserts the repaired text, and reports what it actually produced when wrong. */
function fixes(heard, want) {
  const got = repairTranscript(heard);
  check(`"${heard}" -> "${want}"`, got.text === want, `got "${got.text}"`);
}

/** Asserts the text is returned byte-for-byte with no corrections at all. */
function leaves(text) {
  const got = repairTranscript(text);
  const clean = got.text === text && got.corrections.length === 0;
  check(`untouched: "${text}"`, clean,
    got.text !== text ? `rewritten to "${got.text}"`
      : `${got.corrections.length} correction(s): ` + JSON.stringify(got.corrections));
}

console.log('\nthe real failures, verbatim');
fixes('cloud', 'Claude');
fixes('quad', 'Claude');
fixes('C-L-O-U-D-E-U', 'Claude');
fixes('mind about', 'mindmeld');
fixes('mine mall', 'mindmeld');
fixes('worst recognition', 'voice recognition');
fixes('a Lexus', 'Alexa');
fixes('coordinate or', 'coordinator');

console.log('\nthe same failures inside real sentences');
fixes('ask cloud to look at the logs', 'ask Claude to look at the logs');
fixes('can you get quad to review this', 'can you get Claude to review this');
fixes('search mind about for that conversation', 'search mindmeld for that conversation');
fixes('put it in mine mall please', 'put it in mindmeld please');
fixes('tell a Lexus to turn the lights off', 'tell Alexa to turn the lights off');
fixes('the coordinate or should pick this up', 'the coordinator should pick this up');
fixes('the worst recognition is terrible today', 'the voice recognition is terrible today');
fixes('ask the communicate or to relay it', 'ask the communicator to relay it');

console.log('\npunctuation and capitalisation survive');
fixes('Ask cloud, then wait.', 'Ask Claude, then wait.');
fixes('is cloud there?', 'is Claude there?');
fixes('mind about!', 'mindmeld!');

console.log('\nlonger terms win over shorter ones');
fixes('set up a cloud flare tunnel', 'set up a Cloudflare tunnel');
fixes('the meta mcp hub', 'the MetaMCP hub');
fixes('use tail scale for that', 'use Tailscale for that');
fixes('push it to git hub', 'push it to GitHub');

console.log('\nfound by round-tripping real speech through the engine');
// Observed live: piper said "cloud" and "mind about", Whisper heard these instead.
fixes('Ask clown to check mine to belt for me',
  'Ask Claude to check mindmeld for me');
leaves('stop clowning around');

console.log('\nsound-alikes it was never explicitly told about');
// "coordinateor" is not in the dictionary; it reaches "coordinator" purely by
// sounding identical, which is the whole point of the phonetic pass.
check('an unlisted sound-alike is still caught',
  repairTranscript('the coordinate  or').text === 'the coordinator',
  repairTranscript('the coordinate  or').text);
check('Claude and cloud really are phonetically identical',
  metaphone('Claude') === metaphone('cloud'), `${metaphone('Claude')} vs ${metaphone('cloud')}`);
check('a Lexus and Alexa really do collide',
  metaphone('alexus') === metaphone('Alexa'), `${metaphone('alexus')} vs ${metaphone('Alexa')}`);

console.log('\nalready correct is never touched');
leaves('ask Claude about mindmeld');
leaves('Alexa, Cloudflare, Vikunja, MetaMCP and Tailscale');
leaves('the coordinator will handle it');
leaves('voice recognition works now');

console.log('\nORDINARY ENGLISH — the regression that would matter most');
leaves('it is cold outside so take a coat');
leaves('she called me about the meeting');
leaves('I could not get the code to compile');
leaves('would you record the market data');
leaves('he clawed at the door');            // sounds exactly like "Claude"
leaves('it is cloudy today');
leaves('never mind about the meeting');     // "mind about" is a mindmeld variant
leaves('can you coordinate her schedule');  // "coordinate ..." is a coordinator variant
leaves('the cloud nine feeling');
leaves('we are moving it to the cloud');
leaves('cloud storage is cheaper now');
leaves('my mind is made up about that');
leaves('the mine is closed and the mall is empty');
leaves('what is the worst that could happen');
leaves('please get me a coffee');
leaves('the tail end of the scale');
leaves('I do not want to talk about it');
leaves('let me think about this for a minute');
leaves('there is an echo in this room');
leaves('whisper it to me quietly');

console.log('\nnothing silly happens at the edges');
check('empty string survives', repairTranscript('').text === '');
check('whitespace-only survives', repairTranscript('   ').text === '   ');
check('null is handled', repairTranscript(null).text === null);
check('a very long line is unchanged when it has no terms', (function () {
  const s = 'the quick brown fox jumps over the lazy dog. '.repeat(20).trim();
  return repairTranscript(s).text === s;
})());

console.log('\ncorrections are reported, so the page can show and undo them');
{
  const got = repairTranscript('ask cloud about mind about');
  check('both corrections are reported', got.corrections.length === 2, JSON.stringify(got.corrections));
  check('each names what it replaced',
    got.corrections[0].from === 'cloud' && got.corrections[0].to === 'Claude',
    JSON.stringify(got.corrections[0]));
  check('and how it decided', !!got.corrections[0].how, JSON.stringify(got.corrections[0]));
}

console.log(failures ? `\n${failures} check(s) FAILED\n` : '\nall checks passed\n');
process.exit(failures ? 1 : 0);
