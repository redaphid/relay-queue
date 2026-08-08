'use strict';
/*
 * voice-lib — the bits stt-selftest and tts-selftest both need: a Wyoming client
 * and enough WAV/resampling code to move audio between the two engines.
 *
 * This is a local module, not a dependency: `require('./voice-lib')`, no install.
 * The zero-dependency rule is about npm, not about having more than one file.
 *
 * The Wyoming framing here is deliberately the same shape as server.js's, so
 * reading one teaches you the other. It is NOT shared with the server — the
 * server is a single self-contained file on purpose and stays that way.
 */
const net = require('node:net');
const fs = require('node:fs');

const RATE = 16000; // what the ASR engine wants

// ---------------------------------------------------------------- wyoming
// JSON header line + \n, then `data_length` bytes of JSON, then
// `payload_length` bytes of binary. Both lengths omitted when absent.
function encode(type, data, payload) {
  const header = { type, data: data || {} };
  if (payload && payload.length) header.payload_length = payload.length;
  const line = Buffer.from(JSON.stringify(header) + '\n', 'utf8');
  return payload && payload.length ? Buffer.concat([line, payload]) : line;
}

function decoder(onEvent) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      const nl = buf.indexOf(0x0a);
      if (nl < 0) return;
      const header = JSON.parse(buf.subarray(0, nl).toString('utf8'));
      const dLen = header.data_length > 0 ? header.data_length : 0;
      const pLen = header.payload_length > 0 ? header.payload_length : 0;
      const end = nl + 1 + dLen + pLen;
      if (buf.length < end) return;
      const data = Object.assign({}, header.data);
      if (dLen) Object.assign(data, JSON.parse(buf.subarray(nl + 1, nl + 1 + dLen).toString('utf8')));
      const payload = pLen ? buf.subarray(nl + 1 + dLen, end) : null;
      buf = buf.subarray(end);
      onEvent(header.type, data, payload);
    }
  };
}

/** Ask a wyoming-piper at host:port to speak `text`; resolves { pcm, rate, width, channels }. */
function synthesize(text, host, port) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host, port });
    const parts = [];
    let fmt = { rate: 22050, width: 2, channels: 1 };
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('piper timed out')); }, 60000);
    const feed = decoder((type, data, payload) => {
      if (type === 'audio-start') fmt = { rate: data.rate, width: data.width, channels: data.channels };
      else if (type === 'audio-chunk' && payload) parts.push(Buffer.from(payload));
      else if (type === 'audio-stop') {
        clearTimeout(timer);
        sock.destroy();
        resolve({ pcm: Buffer.concat(parts), ...fmt });
      }
    });
    sock.on('data', (c) => { try { feed(c); } catch (e) { clearTimeout(timer); sock.destroy(); reject(e); } });
    sock.on('error', (e) => { clearTimeout(timer); reject(new Error(`piper at ${host}:${port} — ${e.message}`)); });
    sock.on('connect', () => sock.write(encode('synthesize', { text })));
  });
}

// ---------------------------------------------------------------- wav + resample
function wavHeader(bytes, rate, channels, width) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + bytes, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * channels * width, 28);
  h.writeUInt16LE(channels * width, 32); h.writeUInt16LE(width * 8, 34);
  h.write('data', 36); h.writeUInt32LE(bytes, 40);
  return h;
}

/** Minimal RIFF reader — enough for the mono PCM WAVs we make and read here. */
function parseWav(buf, label) {
  const where = label || 'audio';
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`${where} is not a RIFF/WAVE file`);
  }
  let pos = 12, fmt = null, data = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = buf.subarray(pos + 8, Math.min(pos + 8 + size, buf.length));
    if (id === 'fmt ') fmt = { channels: body.readUInt16LE(2), rate: body.readUInt32LE(4), width: body.readUInt16LE(14) / 8 };
    else if (id === 'data') data = body;
    pos += 8 + size + (size % 2); // chunks are word-aligned
  }
  if (!fmt || !data) throw new Error(`${where}: missing fmt or data chunk`);
  if (fmt.width !== 2) throw new Error(`${where}: only 16-bit PCM is supported`);
  return { pcm: data, ...fmt };
}

const readWav = (file) => parseWav(fs.readFileSync(file), file);

/** int16 PCM -> 16 kHz mono int16, box-averaging so downsampling does not alias. */
function toMono16k(pcm, rate, channels) {
  const frames = Math.floor(pcm.length / 2 / channels);
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += pcm.readInt16LE((i * channels + c) * 2);
    mono[i] = sum / channels / 32768;
  }
  if (rate === RATE) return f32ToInt16(mono);
  const ratio = rate / RATE;
  const out = new Float32Array(Math.floor(frames / ratio));
  for (let i = 0; i < out.length; i++) {
    const from = Math.floor(i * ratio);
    const to = Math.min(Math.max(Math.floor((i + 1) * ratio), from + 1), frames);
    let sum = 0;
    for (let j = from; j < to; j++) sum += mono[j];
    out[i] = sum / (to - from);
  }
  return f32ToInt16(out);
}

function f32ToInt16(f) {
  const out = Buffer.alloc(f.length * 2);
  for (let i = 0; i < f.length; i++) {
    const s = Math.max(-1, Math.min(1, f[i]));
    out.writeInt16LE(Math.round(s < 0 ? s * 32768 : s * 32767), i * 2);
  }
  return out;
}

/** Loudness of int16 PCM, 0..1. Silence is what a broken TTS leg looks like. */
function rmsOf(pcm) {
  const n = Math.floor(pcm.length / 2);
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) { const s = pcm.readInt16LE(i * 2) / 32768; sum += s * s; }
  return Math.sqrt(sum / n);
}

/** Comparison key for "did it say the same thing": case/punctuation insensitive. */
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, '').replace(/\s+/g, ' ').trim();

module.exports = {
  RATE, encode, decoder, synthesize,
  wavHeader, parseWav, readWav, toMono16k, f32ToInt16, rmsOf, norm,
};
