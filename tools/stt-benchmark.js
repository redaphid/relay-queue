'use strict';
/*
 * stt-benchmark — how long does each speech model actually take on THIS machine?
 *
 *   node tools/stt-benchmark.js                 # speak a sentence with piper, time every model
 *   node tools/stt-benchmark.js sample.wav      # use a real recording instead
 *   node tools/stt-benchmark.js --runs 5        # more repeats, tighter median
 *   node tools/stt-benchmark.js --text "..."    # a different sentence
 *
 * The point is a decision, not a leaderboard. Bigger whisper models are more
 * accurate and slower, the trade is entirely a matter of taste, and taste needs
 * numbers from the hardware in the room rather than from a benchmark someone else
 * ran on a different CPU. So this prints, per model, the time you wait and the
 * words you get — side by side, from identical audio.
 *
 * Every model is timed COLD then WARM, separately and on purpose. The first
 * request after a container starts pays for loading the model off disk, and on
 * the large models that is most of a minute; every request after it does not.
 * Reporting one blended number would libel the big models on steady-state
 * latency and flatter them on the first dictation after a reboot.
 *
 * Audio goes through relay-queue's own POST /stt, so this measures the path the
 * browser actually uses — not a private shortcut to the engine.
 *
 * Zero dependencies, like the server. Node built-ins only.
 */
const V = require('./voice-lib');

const RELAY = process.env.RELAY_URL || 'http://127.0.0.1:3901';
const PIPER_HOST = process.env.PIPER_HOST || '127.0.0.1';
const PIPER_PORT = Number(process.env.PIPER_PORT || 10200);
const SENTENCE = 'Zora, ask the coordinator to check whether mindmeld finished syncing at three forty-five.';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : dflt;
};

/** Milliseconds, rendered the way a person reads them. */
const ms = (n) => (n < 1000 ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(1)} s`);
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

async function post(pcm, model) {
  const started = Date.now();
  const res = await fetch(`${RELAY}/stt?model=${encodeURIComponent(model)}&rate=16000`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: pcm,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `${res.status} ${res.statusText}`);
  return { ...body, wallMs: Date.now() - started };
}

async function main() {
  const runs = Math.max(1, Number(arg('--runs', 3)));
  const spoken = arg('--text', SENTENCE);
  // The only bare argument is a WAV path: skip every `--flag` and the value that
  // follows it, or `--only large-v3` gets mistaken for a file to open.
  const argv = process.argv.slice(2);
  const wav = argv.find((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));

  // What the server is willing to talk to. Asking it, rather than hardcoding a
  // list here, means this tool can never drift out of step with the catalog.
  const settings = await (await fetch(`${RELAY}/settings`)).json();
  const only = arg('--only', null); // one model, for when you are tuning that one
  const models = settings.models.filter((m) => m.reachable && (!only || m.id === only));
  const unreachable = settings.models.filter((m) => !m.reachable);

  let audio;
  if (wav) {
    audio = V.readWav(wav);
    console.log(`audio: ${wav}`);
  } else {
    console.log(`audio: piper ${PIPER_HOST}:${PIPER_PORT} saying "${spoken}"`);
    audio = await V.synthesize(spoken, PIPER_HOST, PIPER_PORT);
  }
  // toMono16k already returns int16 — running it through f32ToInt16 as well
  // reinterprets each byte as a sample and hands every model full-scale noise,
  // which they answer with silence and hallucinated stock phrases.
  const pcm = V.toMono16k(audio.pcm, audio.rate, audio.channels);
  const secs = pcm.length / 2 / 16000;
  console.log(`       ${secs.toFixed(1)} s of speech, ${runs} warm run(s) per model`);
  if (unreachable.length) console.log(`skipped (not responding): ${unreachable.map((m) => m.id).join(', ')}`);
  console.log('');

  const results = [];
  for (const m of models) {
    process.stdout.write(`${m.id.padEnd(12)} `);
    let cold = null;
    const warm = [];
    let heard = '';
    try {
      const first = await post(pcm, m.id);
      cold = first.wallMs;
      heard = first.text;
      for (let i = 0; i < runs; i++) {
        const r = await post(pcm, m.id);
        warm.push(r.wallMs);
        heard = r.text;
      }
      const med = median(warm);
      results.push({ id: m.id, label: m.label, cold, warm: med, rt: med / 1000 / secs, heard });
      console.log(`cold ${ms(cold).padStart(7)}   warm ${ms(med).padStart(7)}   ${(med / 1000 / secs).toFixed(2)}x realtime`);
    } catch (err) {
      console.log(`FAILED — ${err.message}`);
      results.push({ id: m.id, label: m.label, cold, warm: null, heard: err.message });
    }
  }

  console.log('\nWhat each one heard:\n');
  for (const r of results) console.log(`  ${r.id.padEnd(12)} ${JSON.stringify(r.heard)}`);

  const ok = results.filter((r) => r.warm !== null);
  if (ok.length) {
    console.log('\nWaiting time for one dictated message, warm:\n');
    for (const r of ok) console.log(`  ${r.label.padEnd(12)} ${ms(r.warm).padStart(8)}`);
  }
  console.log(`\ncurrently selected: ${settings.settings.sttModel} — change it at ${RELAY.replace(/\/$/, '')}/config`);
}

main().catch((err) => {
  console.error(String((err && err.message) || err));
  process.exit(1);
});
