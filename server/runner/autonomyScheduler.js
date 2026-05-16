'use strict';

// Autonomy Scheduler — confidence-gated auto-promotion of LMDB observations.
//
// PRX_CORTEX_AUTONOMY_LEVEL controls how autonomous the AI team is:
//
//   0 — manual (default): observations stay in LMDB until explicitly promoted
//       via POST /cortex/memory/promote.  The human is always the final gate.
//
//   1 — cross-session memory: confirmCount is tracked and surfaced so agents
//       can see how many sessions validated an observation.  No auto-promotion.
//
//   2 — confidence-gated: when confirmCount >= threshold AND observation age >=
//       PRX_CORTEX_AUTO_PROMOTE_MIN_AGE_DAYS, queuedForPromotionAt is set.
//       This scheduler promotes after PRX_CORTEX_AUTO_PROMOTE_DELAY_HOURS unless
//       a human calls POST /cortex/memory/reject-promotion in the window.
//
//   3 — full-trust: immediate promotion in the /observe route — no review
//       window.  The scheduler still runs to tidy entries.

const fs   = require('fs');
const path = require('path');

// ── Config ──────────────────────────────────────────────────────────────────

function autonomyLevel()    { return Math.min(3, Math.max(0, parseInt(process.env.PRX_CORTEX_AUTONOMY_LEVEL          || '0', 10))); }
function promoteThreshold() { return Math.max(1, parseInt(process.env.PRX_CORTEX_AUTO_PROMOTE_THRESHOLD              || '3', 10)); }
function delayMs()          { return Math.max(0, parseFloat(process.env.PRX_CORTEX_AUTO_PROMOTE_DELAY_HOURS          || '24')) * 3_600_000; }
function minAgeMs()         { return Math.max(0, parseFloat(process.env.PRX_CORTEX_AUTO_PROMOTE_MIN_AGE_DAYS         || '2'))  * 86_400_000; }

// Type → KB file mapping — shared between this scheduler and route handlers.
const PROMOTE_TARGETS = {
  'pattern':        'shared/patterns.md',
  'business-rule':  'shared/business-rules.md',
  'decision':       'shared/decisions.md',
  'hotspot':        'shared/architecture.md',
  'anomaly':        'shared/patterns.md',
  'context':        'shared/architecture.md',
  'session-summary': 'shared/session-memory.md',
};

// ── Core promotion helper ────────────────────────────────────────────────────
//
// Used by: autonomyScheduler (level-2 delayed), routes.js /observe (level-3
// immediate), and routes.js /promote (explicit human).
// Returns { ok, kbFile, error } — caller emits serverEvents.

function promoteObservation(key, v, mem, kbBase) {
  const type    = v.type || 'context';
  const summary = v.summary || (v.raw != null ? JSON.stringify(v.raw) : JSON.stringify(v));
  const ticket  = v.ticket || null;

  const kbFile = PROMOTE_TARGETS[type];
  if (!kbFile) return { ok: false, error: `no KB target for type '${type}'` };

  const target = path.join(kbBase, kbFile);
  try { fs.mkdirSync(path.dirname(target), { recursive: true }); } catch (_) {}

  const date  = new Date().toISOString().slice(0, 10);
  const block = [
    '',
    `## ${key}`,
    `<!-- promoted from Cortex on ${date}${ticket ? ' · ticket: ' + ticket : ''} -->`,
    '',
    summary,
    '',
  ].join('\n');

  try {
    fs.appendFileSync(target, block, 'utf8');
  } catch (err) {
    return { ok: false, error: `could not write to KB: ${err.message}` };
  }

  mem.put(key, { ...v, promoted: true, promotedAt: Date.now(), promotedTo: kbFile }, {
    tags: ['agent-observed', type, 'promoted'],
    ttl: 0,
  });

  return { ok: true, kbFile, target };
}

// ── Scheduler loop ───────────────────────────────────────────────────────────

const TICK_MS = 60 * 60 * 1000; // hourly
let _timer    = null;

function tick(cortex) {
  if (autonomyLevel() < 2) return;

  const mem    = cortex.memory();
  const kbBase = cortex.kbDir();
  const delay  = delayMs();
  const minAge = minAgeMs();
  const now    = Date.now();

  let promoted = 0;
  for (const key of mem.byTag('pending-promotion')) {
    const v = mem.get(key);
    if (!v || typeof v !== 'object') continue;
    if (v.rejected || v.promoted)   continue;

    const queuedAt = v.queuedForPromotionAt || 0;
    const ts       = v.ts || 0;
    if (now - queuedAt < delay)  continue;
    if (now - ts       < minAge) continue;

    const result = promoteObservation(key, v, mem, kbBase);
    if (result.ok) {
      promoted++;
      console.log(`[autonomy] Auto-promoted '${key}' → ${result.kbFile}`);
      try {
        const serverEvents = require('../serverEvents');
        serverEvents.emit('cortex-observation-written', { key, autoPromoted: true });
      } catch (_) {}
    } else {
      console.warn(`[autonomy] Promotion failed for '${key}': ${result.error}`);
    }
  }

  if (promoted > 0) console.log(`[autonomy] Tick complete — promoted ${promoted} observation(s)`);
}

function start(cortex) {
  if (_timer) return;
  const level = autonomyLevel();
  if (level < 2) {
    console.log(`[autonomy] Level ${level} — scheduler idle (no auto-promotion)`);
    return;
  }
  console.log(`[autonomy] Level ${level} — scheduler active (threshold=${promoteThreshold()}, delay=${process.env.PRX_CORTEX_AUTO_PROMOTE_DELAY_HOURS || 24}h, minAge=${process.env.PRX_CORTEX_AUTO_PROMOTE_MIN_AGE_DAYS || 2}d)`);
  tick(cortex);
  _timer = setInterval(() => tick(cortex), TICK_MS);
  if (_timer.unref) _timer.unref();
}

function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = { start, stop, tick, promoteObservation, PROMOTE_TARGETS, autonomyLevel, promoteThreshold };
