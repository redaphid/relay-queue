'use strict';
/*
 * tts-selftest — end-to-end check of POST /tts without a speaker.
 *
 *   node tools/tts-selftest.js
 *   node tools/tts-selftest.js --text "forty two widgets are on hand"
 *   node tools/tts-selftest.js --keep        # leave the WAV in data/tmp to listen to
 *
 * Nobody can hear a headless test, so "it played" is not checkable — but
 * everything short of the loudspeaker is. This asks /tts for audio and asserts:
 *
 *   1. it is a well-formed RIFF/WAVE the browser's decodeAudioData can take,
 *   2. the header agrees with the body (a truncated stream is the failure mode
 *      that still "plays", just wrongly),
 *   3. it is not silence — a TTS leg that returns the right number of zero bytes
 *      looks perfect to every check except this one,
 *   4. its length is plausible for the text, and
 *   5. **whisper can read it back**: the WAV is fed straight into /stt and the
 *      transcript compared to the input. That is the round trip that proves the
 *      audio is really speech and really says what was asked.
 *
 * (5) is the same trick stt-selftest uses in reverse, and it is the strongest
 * evidence available without ears: text -> piper -> WAV -> whisper -> text.
 *
 * Zero dependencies. Node built-ins only.
 */
const fs = require('node:fs');
const path = require('node:path');
const V = require('./voice-lib');

const RELAY = process.env.RELAY_URL || 'http://127.0.0.1:3901';
const MIN_RMS = 0.005; // below this it is silence, not speech
const OUT_DIR = path.join(__dirname, '..', 'data', 'tmp');

let failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`  ok   ${name}${detail ? ' — ' + detail : ''}`); return true; }
  failures++;
  console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
  return false;
}

async function speak(text) {
  const res = await fetch(`${RELAY}/tts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    let why = `HTTP ${res.status}`;
    try { const j = await res.json(); if (j && j.error) why += `: ${j.error}`; } catch { /* not JSON */ }
    throw new Error(why);
  }
  return {
    buf: Buffer.from(await res.arrayBuffer()),
    type: res.headers.get('content-type'),
    audioMs: Number(res.headers.get('x-audio-ms')),
    tookMs: Number(res.headers.get('x-took-ms')),
  };
}

async function main() {
  const args = process.argv.slice(2);
  const ti = args.indexOf('--text');
  const text = ti >= 0 ? args[ti + 1] : 'Forty two widgets are on hand and three are backordered.';
  const keep = args.includes('--keep');

  console.log(`\nPOST ${RELAY}/tts — "${text}"`);
  const out = await speak(text);
  console.log(`  ${out.buf.length} bytes, ${out.type}, engine took ${out.tookMs} ms\n`);

  check('content-type is audio/wav', /audio\/wav/.test(out.type || ''), out.type);

  let wav = null;
  try { wav = V.parseWav(out.buf, '/tts response'); } catch (e) { check('response parses as RIFF/WAVE', false, e.message); }
  if (!wav) { report(); return; }

  check('parses as RIFF/WAVE', true, `${wav.rate} Hz, ${wav.channels} ch, 16-bit`);
  check('is mono', wav.channels === 1, `${wav.channels} channels`);
  const declared = out.buf.readUInt32LE(40);
  check('header byte count matches the body', declared === out.buf.length - 44,
    `header says ${declared}, body has ${out.buf.length - 44}`);

  const seconds = wav.pcm.length / 2 / wav.rate;
  check('contains audible audio, not silence', V.rmsOf(wav.pcm) >= MIN_RMS, `rms ${V.rmsOf(wav.pcm).toFixed(4)}`);
  check('duration is plausible for the text', seconds > 0.5 && seconds < 60, `${seconds.toFixed(2)}s`);
  check('x-audio-ms header agrees with the audio', Math.abs(out.audioMs - seconds * 1000) < 50,
    `header ${out.audioMs} ms, measured ${Math.round(seconds * 1000)} ms`);

  if (keep) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const dest = path.join(OUT_DIR, 'tts-selftest.wav');
    fs.writeFileSync(dest, out.buf);
    console.log(`  wrote ${dest} — play it to hear what the page would say`);
  }

  // ---- the round trip: can whisper read back what piper just said? ----
  console.log('\nround trip — feeding the spoken audio straight into /stt');
  const pcm = V.toMono16k(wav.pcm, wav.rate, wav.channels);
  const res = await fetch(`${RELAY}/stt`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: pcm,
  });
  const body = await res.json();
  if (!res.ok) {
    check('/stt accepted the spoken audio', false, `HTTP ${res.status}: ${body && body.error}`);
    report();
    return;
  }
  console.log(`  transcript: "${body.text}"  (engine took ${body.tookMs} ms)`);
  check('transcribes back to something', !!V.norm(body.text));

  // The ASR model here is whisper tiny-int8, which is deliberately not being
  // upgraded — so an exact match is a bonus, not the bar. Word overlap is the
  // honest measure of "the audio really was this sentence".
  const want = V.norm(text).split(' ').filter(Boolean);
  const got = new Set(V.norm(body.text).split(' ').filter(Boolean));
  const hits = want.filter((w) => got.has(w)).length;
  const ratio = want.length ? hits / want.length : 0;
  check('round trip recovers most of the words', ratio >= 0.6,
    `${hits}/${want.length} words (${Math.round(ratio * 100)}%)`);
  if (ratio < 1) console.log('  (tiny-int8 mishears some words; the check is overlap, not equality)');

  report();
}

function report() {
  console.log(failures ? `\n${failures} check(s) FAILED\n` : '\nall checks passed\n');
  process.exitCode = failures ? 1 : 0;
}

main().catch((err) => { console.error(`\nFAIL — ${err.message}\n`); process.exitCode = 1; });
