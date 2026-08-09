'use strict';
/*
 * stt-selftest — end-to-end check of POST /stt without a microphone.
 *
 *   node tools/stt-selftest.js                    # synthesise speech with piper, then transcribe it
 *   node tools/stt-selftest.js sample.wav         # transcribe an existing WAV instead
 *   node tools/stt-selftest.js --text "hello there"
 *
 * With no WAV it asks the local wyoming-piper TTS engine to speak a sentence,
 * saves it to a WAV, POSTs the PCM to relay-queue's /stt, and compares the
 * transcript to what it asked piper to say. That exercises the exact path the
 * browser uses (16 kHz mono int16 -> /stt -> wyoming-whisper) end to end.
 *
 * See also tools/tts-selftest.js, which checks the other direction (/tts).
 *
 * Zero dependencies, like the server. Node built-ins only.
 */
const fs = require('node:fs');
const path = require('node:path');
const V = require('./voice-lib');
const { assertRelayAt } = require('./harness-lib');

const RELAY = process.env.RELAY_URL || 'http://127.0.0.1:3901';
const PIPER_HOST = process.env.PIPER_HOST || '127.0.0.1';
const PIPER_PORT = Number(process.env.PIPER_PORT || 10200);

async function main() {
  // 3901 is an assumption, not a fact — check it before sending audio at it.
  const relay = await assertRelayAt(RELAY);
  console.log(`relay ${RELAY} — ${relay.name} v${relay.version}`);

  const args = process.argv.slice(2);
  const ti = args.indexOf('--text');
  const spoken = ti >= 0 ? args[ti + 1] : 'The quick brown fox jumps over the lazy dog.';
  const wavArg = args.find((a) => !a.startsWith('--') && a !== spoken);
  const outDir = path.join(__dirname, '..', 'data', 'tmp');

  let audio;
  if (wavArg) {
    audio = V.readWav(wavArg);
    console.log(`read ${wavArg} — ${audio.rate} Hz, ${audio.channels} ch, ${audio.pcm.length} bytes`);
  } else {
    console.log(`piper ${PIPER_HOST}:${PIPER_PORT} — synthesising: "${spoken}"`);
    audio = await V.synthesize(spoken, PIPER_HOST, PIPER_PORT);
    if (!audio.pcm.length) throw new Error('piper returned no audio');
    console.log(`  got ${audio.rate} Hz, ${audio.channels} ch, ${audio.pcm.length} bytes`);
    fs.mkdirSync(outDir, { recursive: true });
    const dest = path.join(outDir, 'stt-selftest.wav');
    fs.writeFileSync(dest, Buffer.concat([V.wavHeader(audio.pcm.length, audio.rate, audio.channels, audio.width), audio.pcm]));
    console.log(`  wrote ${dest}`);
  }

  const pcm = V.toMono16k(audio.pcm, audio.rate, audio.channels);
  const seconds = (pcm.length / 2 / V.RATE).toFixed(2);
  console.log(`POST ${RELAY}/stt — ${pcm.length} bytes of 16 kHz mono int16 (${seconds}s)`);

  const res = await fetch(`${RELAY}/stt`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: pcm,
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${body && body.error}`);

  console.log(`\n  transcript: "${body.text}"`);
  console.log(`  audio ${body.audioMs} ms, engine took ${body.tookMs} ms\n`);

  if (!wavArg) {
    const want = V.norm(spoken);
    const got = V.norm(body.text);
    console.log(got === want ? 'PASS — transcript matches what piper was asked to say.'
      : `NOTE — transcript differs from the prompt.\n    said: "${want}"\n   heard: "${got}"`);
  }
  if (!body.text.trim()) process.exitCode = 1;
}

main().catch((err) => { console.error(`FAIL — ${err.message}`); process.exitCode = 1; });
