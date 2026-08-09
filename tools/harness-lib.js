'use strict';
/*
 * harness-lib — start a server under test, and PROVE you are talking to it.
 *
 * Every self-test in this directory used to pick a FIXED port, spawn a server
 * on it, and then poll `/health` until something answered. Both halves of that
 * are unsound, and both have burned us:
 *
 *   1. A stale TIME_WAIT socket, or a leaked scratch server from an earlier
 *      run, makes the bind fail with EADDRINUSE. The child dies. The harness
 *      does not notice.
 *   2. Worse — and this is the one that actually happened — the child's stdout
 *      and stderr were piped and then thrown away (`proc.stdout.on('data',
 *      () => {})`), so its death was completely invisible. The boot poll then
 *      SUCCEEDED against the squatter already on that port, and the suite went
 *      on to interrogate a stranger's server and report the answers as fact.
 *      The tell, that time, was a `queued:62` counter on a server that had not
 *      yet been posted to. A false PASS is available by the same route.
 *
 * The second is strictly worse than the first: EADDRINUSE at least announces
 * itself. So the fix has to be both halves, not either:
 *
 *   - PORT=0. The OS picks a free port; nobody can be on it, and parallel runs
 *     cannot collide. The port actually bound is read back from the child
 *     rather than assumed — the port you ask for is not the port you get.
 *   - A boot nonce. The harness generates a token, passes it in as
 *     RELAY_BOOT_NONCE, and refuses to proceed until `/health` echoes THAT
 *     token back. A stranger cannot know it. A dead child cannot answer at all,
 *     which is separately checked on every poll via `proc.exitCode`.
 *   - The child's output is captured and PRINTED ON FAILURE, never swallowed.
 *     An invisible child death is what made this class of bug survivable.
 *
 * Zero dependencies, like the rest of the project.
 */
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const path = require('node:path');

const SERVER = path.join(__dirname, '..', 'server.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/*
 * How the port is learned: from the line server.js prints inside its own listen
 * callback, on the pipe of the child WE spawned. It reports the socket it
 * actually bound, which is the only trustworthy source given we asked for 0.
 *
 * This is deliberately the SAME line tools/lifecycle-selftest.js reads, and
 * deliberately the only port-learning mechanism in the repo. Two ways of
 * discovering the same fact is two things to keep in step, and drift between
 * them is exactly how a harness ends up talking to a stranger.
 *
 * The nonce below is not a second channel for the port — it never carries one.
 * It answers the separate question the port cannot: whether the thing ANSWERING
 * at that address is still the child that announced it.
 */
const LISTENING_LINE = /listening on http:\/\/[^\s:]+:(\d+)/;

function tail(text, n = 4000) {
  const t = String(text || '');
  return t.length > n ? '...' + t.slice(-n) : t;
}

/** A ServerHandle: the child, where it lives, and everything it has said. */
class ServerHandle {
  constructor(opts) {
    this.opts = opts;
    this.proc = null;
    this.port = null;
    this.base = null;
    this.nonce = null;
    this.stdout = '';
    this.stderr = '';
  }

  /** Everything the child wrote, in one blob, for regex assertions. */
  get out() { return this.stdout + this.stderr; }

  /** Context for an error message: what we were doing, and what the child said. */
  describe() {
    const p = this.proc;
    const state = !p ? 'never spawned'
      : p.exitCode !== null ? `EXITED with code ${p.exitCode}`
        : p.signalCode !== null ? `KILLED by ${p.signalCode}`
          : `running (pid ${p.pid})`;
    return `[${this.opts.label}] child is ${state}; asked for port `
      + `${this.opts.port === 0 ? '0 (any free)' : this.opts.port}, got ${this.port === null ? 'nothing' : this.port}\n`
      + `--- child stdout ---\n${tail(this.stdout) || '(nothing)'}\n`
      + `--- child stderr ---\n${tail(this.stderr) || '(nothing)'}\n--------------------`;
  }

  fail(why) { return new Error(`${why}\n${this.describe()}`); }

  /** Spawn, and do not return until the child itself has answered us. */
  async start() {
    const o = this.opts;
    this.nonce = crypto.randomBytes(12).toString('hex');
    this.stdout = '';
    this.stderr = '';

    const env = { ...process.env, DATA_DIR: o.dir, HOST: '127.0.0.1', WATCH_SOURCE: '0', ...o.env };
    for (const k of o.unsetEnv) delete env[k];
    // Ours, last, unconditionally: a caller must not be able to reintroduce the
    // fixed port or forge the nonce by accident.
    env.PORT = String(o.port);
    env.RELAY_BOOT_NONCE = this.nonce;

    this.proc = spawn(process.execPath, [o.server, ...o.args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stderr.setEncoding('utf8');
    this.proc.stdout.on('data', (c) => { this.stdout += c; });
    this.proc.stderr.on('data', (c) => { this.stderr += c; });
    this.proc.on('error', (e) => { this.stderr += `\n[spawn error] ${e.message}\n`; });

    await this.waitForBoot();
    return this;
  }

  /**
   * Block until the child is serving, or explain why it never will be.
   *
   * The three ways out of here are all loud. There is deliberately no path
   * that returns having merely found *something* listening.
   */
  async waitForBoot() {
    const deadline = Date.now() + this.opts.timeoutMs;
    while (Date.now() < deadline) {
      // A dead child can never be the thing answering. Check this FIRST, and
      // on every pass — the race we are closing is a child that dies between
      // spawn and the first successful fetch.
      if (this.proc.exitCode !== null || this.proc.signalCode !== null) {
        throw this.fail('the server under test died during boot');
      }

      if (this.port === null) {
        // Only our child writes to this pipe, so an announcement on it is our
        // child's. That is what makes the address ours rather than assumed.
        const m = LISTENING_LINE.exec(this.stdout);
        if (m) {
          this.port = Number(m[1]);
          this.base = `http://127.0.0.1:${this.port}`;
        }
      }

      if (this.port !== null) {
        let health = null;
        try {
          const r = await fetch(`${this.base}/health`);
          if (r.ok) health = await r.json();
        } catch { /* not accepting connections yet */ }
        if (health) {
          // The whole point. Reaching *a* healthy server proves nothing.
          if (health.boot !== this.nonce) {
            throw this.fail(`something else is answering on port ${this.port} — `
              + `/health returned boot=${JSON.stringify(health.boot)}, expected ${JSON.stringify(this.nonce)}. `
              + 'This is the bug this harness exists to make impossible: it would otherwise have tested a stranger.');
          }
          return this;
        }
      }
      await sleep(50);
    }
    throw this.fail(`the server under test never came up within ${this.opts.timeoutMs}ms`);
  }

  /**
   * Stop and wait for it to actually be gone.
   *
   * A process killed by a signal reports exitCode === null (signalCode carries
   * the signal), so a naive `exitCode === null` guard re-kills an already-dead
   * child and then awaits an 'exit' event that fired long ago — which hangs
   * silently and, once the event loop drains, ends the run with no output and
   * a success code.
   */
  stop() {
    const p = this.proc;
    if (!p || p.exitCode !== null || p.signalCode !== null) return Promise.resolve();
    const gone = new Promise((r) => p.once('exit', r));
    p.kill('SIGTERM');
    return gone;
  }

  /**
   * Restart onto the same DATA_DIR — the durability check every suite makes.
   *
   * The new process gets a NEW nonce and, by default, a NEW port, so `base`
   * moves. Callers must therefore reach the server through the handle
   * (`srv.base`) rather than caching a URL string, which is why every helper
   * below is built that way.
   */
  async restart(envOverrides = {}) {
    await this.stop();
    this.opts.env = { ...this.opts.env, ...envOverrides };
    this.port = null;
    this.base = null;
    return this.start();
  }
}

/**
 * Start server.js against a scratch DATA_DIR on an OS-assigned port.
 *
 * @param {object}   o
 * @param {string}   o.dir        DATA_DIR — always a throwaway, never the real one.
 * @param {object}   [o.env]      Extra environment. Cannot override PORT or the nonce.
 * @param {string[]} [o.unsetEnv] Variables to remove from the inherited environment.
 * @param {number}   [o.port]     Ask for a specific port. Defaults to 0, and 0 is
 *                                almost always right; a fixed port is a race with
 *                                the rest of the machine. Whatever is asked for,
 *                                the bound port is read back from the child.
 * @returns {Promise<ServerHandle>}
 */
function startServer(o = {}) {
  if (!o.dir) throw new Error('startServer needs a scratch DATA_DIR');
  return new ServerHandle({
    dir: o.dir,
    env: o.env || {},
    unsetEnv: o.unsetEnv || [],
    port: Number(o.port || 0),
    server: o.server || SERVER,
    args: o.args || [],
    timeoutMs: Number(o.timeoutMs || 20000),
    label: o.label || 'server',
  }).start();
}

/**
 * Bind an in-process http.Server to an OS-assigned port and report which one.
 *
 * For harnesses that serve fixtures themselves rather than spawning a child.
 * `listen(0)` cannot collide, but the answer must be read back from
 * `address()` — asking for 0 and then talking to port 0 is not a thing.
 */
function listenEphemeral(server, host = '127.0.0.1', port = 0) {
  return new Promise((resolve, reject) => {
    const onError = (e) => { server.removeListener('error', onError); reject(e); };
    server.once('error', onError);
    server.listen(port, host, () => {
      server.removeListener('error', onError);
      resolve(server.address().port);
    });
  });
}

/**
 * Confirm that what is listening at `base` is a relay-queue, before a tool
 * starts posting to it.
 *
 * For the probes that talk to an ALREADY-RUNNING server rather than starting
 * one — stt/tts-selftest against the real deployment on 3901. There is no
 * nonce to check there, and no child to blame, but the failure mode is the
 * same shape: an address is assumed, something else answers, and the run
 * reports on a stranger. A GET of /health is read-only and settles it.
 *
 * @returns {Promise<object>} the /health body, so a caller can log the version.
 */
async function assertRelayAt(base) {
  let health;
  try {
    const r = await fetch(`${base}/health`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    health = await r.json();
  } catch (e) {
    throw new Error(`nothing usable is answering at ${base} — ${e.message}. `
      + 'Set RELAY_URL if the server is somewhere else.');
  }
  if (!health || health.name !== 'relay-queue') {
    throw new Error(`${base} is answering, but it is not a relay-queue — /health said `
      + `name=${JSON.stringify(health && health.name)}. Refusing to send it anything.`);
  }
  return health;
}

module.exports = { startServer, listenEphemeral, assertRelayAt, ServerHandle, SERVER };
