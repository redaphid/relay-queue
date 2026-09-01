'use strict';
/*
 * staffability — why nothing is ever going to pick up this pending task.
 *
 * THE FAILURE THIS EXISTS FOR. On 2026-08-31 a 7-task backlog had been sitting
 * for up to 8 days. Every one of them was being refused BY DESIGN by
 * tools/autoseat.js — 5 because their conversation was archived, 2 because
 * `from` was `relay-watchdog`, 1 because `from` was `checklist`. The dispatcher
 * was healthy the entire time. But nothing anywhere SAID so: `/health` and
 * `GET /tasks?status=pending` reported a nonzero pending count and nothing
 * else, which reads exactly like an outage. Learning the truth required
 * reading autoseat's source, and the obvious remedy — restart the dispatcher —
 * would have been wrong every time.
 *
 * A permanent backlog and a broken autoseat must not look identical. This
 * module is the difference.
 *
 * WHY THE REASONS LIVE HERE AND NOT IN EITHER CALLER. Both server.js and
 * tools/autoseat.js need to answer the same question, and they are separate
 * processes: autoseat runs on the host and talks to relay over HTTP, so it
 * cannot ask the server and the server cannot ask it. Two copies of "who counts
 * as a human client" is two things to keep in step, and the whole point of the
 * check is that it is STRUCTURAL — a copy that drifts is a copy that has
 * stopped being structural. So the origin set and the exact refusal wording are
 * defined once, here, and required by both.
 *
 * WHAT IS DELIBERATELY *NOT* HERE — and this is the load-bearing half.
 * autoseat refuses for nine reasons; only these five are permanent. The other
 * four — a dispatch already sent, the seat filled by a live agent, the message
 * still inside its grace window, the concurrency cap — are TRANSIENT: they
 * describe this second, they resolve themselves, and a task refused for one of
 * them will be seated on a later pass. Surfacing those would be noise, and
 * worse, it would mean reimplementing autoseat's scheduler inside the server
 * out of state the server does not have (`dispatched`, `inFlight`, `ignore`,
 * `maxConcurrent` are all process-local to the dispatcher).
 *
 * The split is not a compromise, it is the reason this works: the refusals that
 * are PERMANENT are exactly the refusals the server can compute on its own,
 * from the task and the conversation. So the server can answer "will anything
 * ever pick this up?" — the only question a backlog actually raises — without
 * knowing anything about the dispatcher's internal state.
 *
 * Zero dependencies, like the rest of the project.
 */

/*
 * The human's own clients, and the whole trigger test alongside `role === 'user'`.
 *
 * KEEP IT AN ALLOWLIST. It is what makes the dangerous loops impossible rather
 * than merely unlikely: agent posts carry `role:"agent"`, the watchdog's pokes
 * carry `from:"relay-watchdog"`, checklist settles carry `from:"checklist"`,
 * and none of those are on the list — so a dispatched agent cannot dispatch
 * anything by writing, and the watchdog cannot amplify itself through it. A
 * blocklist would flip the default to *dispatch*, and every posting surface
 * nobody remembered to exclude would become a loop.
 */
const HUMAN_ORIGINS = new Set(['web', 'voice', 'voice-conversation']);

/*
 * The wording, single-sourced. These strings are read by a human staring at a
 * backlog wondering whether to restart something, so they say what is true
 * rather than what is missing — "which IS the answer" is doing real work in the
 * archived case, where the absence of a coordinator is the correct outcome.
 */
const REASON = {
  notUserRole: (t) => `role is ${JSON.stringify(t.role)}, so this is not the human speaking`,
  notHumanOrigin: (t) => `from is ${JSON.stringify(t.from)}, not a human client; `
    + `he posts from ${[...HUMAN_ORIGINS].join(', ')}`,
  noConversation: () => 'conversation is not in the conversation list',
  archived: () => 'conversation is archived, which IS the answer',
  stopped: () => 'conversation was deliberately stopped',
};

/*
 * A short machine-readable tag beside the sentence. The sentence is for the
 * human; the tag is what /health groups by, so a count can be reported without
 * anyone parsing prose.
 */
const CODES = ['not-user-role', 'not-human-origin', 'no-conversation', 'archived', 'stopped'];

/**
 * Why autoseat will never seat this task — or null if nothing permanent is
 * stopping it. `null` does NOT promise a seat: a task can still be waiting on
 * the grace window, the cap, or an agent already in the chair. It promises only
 * that the task is not permanently stranded.
 *
 * @param {object} task  a task record
 * @param {object|null|undefined} conv  its conversation, or null/undefined if there is none
 * @returns {{code:string, why:string}|null}
 */
function unstaffable(task, conv) {
  if (!task || task.status !== 'pending') return null;
  if (task.role !== 'user') return { code: 'not-user-role', why: REASON.notUserRole(task) };
  if (!HUMAN_ORIGINS.has(task.from)) {
    return { code: 'not-human-origin', why: REASON.notHumanOrigin(task) };
  }
  if (!conv) return { code: 'no-conversation', why: REASON.noConversation() };
  if (conv.archived) return { code: 'archived', why: REASON.archived() };
  if (conv.stopAck === 'stopped') return { code: 'stopped', why: REASON.stopped() };
  return null;
}

module.exports = { HUMAN_ORIGINS, REASON, CODES, unstaffable };
