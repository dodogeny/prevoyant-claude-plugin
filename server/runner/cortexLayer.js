'use strict';

// Cortex Layer — shared resolver and read helpers.
//
// Cortex is an always-on intelligence layer that sits on top of the KB.  It is
// synthesized from two sources:
//
//   1. The KB itself (shared/*.md, decisions, patterns, business rules, etc.)
//   2. Repowise (https://github.com/repowise-dev/repowise), which indexes the
//      source repository into a dependency graph + auto-generated wiki.
//
// The worker (server/workers/cortexWorker.js) keeps the cortex files fresh.
// This module is the shared resolver used by the worker, the dashboard, and
// the backup/export route so every consumer agrees on file locations.

const fs   = require('fs');
const os   = require('os');
const path = require('path');

// Cortex storage modes (`PRX_CORTEX_DISTRIBUTED`):
//
//   N (default) — cortex lives at ~/.prevoyant/cortex/.  Per-machine, never
//                 syncs anywhere.  Each dev's cortex is independently built.
//
//   Y           — cortex lives INSIDE the KB at <KB>/cortex/.  The standard
//                 KB sync (git push or Upstash) ships cortex to other dev
//                 machines automatically — so a new teammate's first session
//                 sees the team's accumulated intelligence layer without
//                 having to synthesise from scratch.  Merge conflicts are
//                 possible if two devs synthesise on different KB heads; the
//                 worker writes atomically (rename-after-tmp) so the loser
//                 just overwrites, and the next KB-watch tick re-synthesises.
//
// Both modes preserve the same internal layout (facts/, repowise/, state.json,
// index.md) — only the parent directory changes.
const LOCAL_CORTEX_DIR = path.join(os.homedir(), '.prevoyant', 'cortex');

function isDistributed() {
  return (process.env.PRX_CORTEX_DISTRIBUTED || '').toUpperCase() === 'Y';
}

function kbDirForCortex() {
  const mode = process.env.PRX_KB_MODE || 'local';
  return mode === 'distributed'
    ? (process.env.PRX_KB_LOCAL_CLONE || path.join(os.homedir(), '.prevoyant', 'kb'))
    : (process.env.PRX_KNOWLEDGE_DIR  || path.join(os.homedir(), '.prevoyant', 'knowledge-base'));
}

function resolvedCortexDir() {
  return isDistributed() ? path.join(kbDirForCortex(), 'cortex') : LOCAL_CORTEX_DIR;
}

// All paths are computed on every call so the worker, dashboard, and CLI
// readers all respect a live toggle of PRX_CORTEX_DISTRIBUTED without
// restart.  Cost: a couple of string joins.

// Synthesised fact files — keep this list aligned with cortexWorker.js.
const FACT_FILES = [
  { id: 'architecture',    name: 'Architecture',     file: 'architecture.md',     icon: '🏗️' },
  { id: 'business-rules',  name: 'Business Rules',   file: 'business-rules.md',   icon: '📜' },
  { id: 'patterns',        name: 'Patterns',         file: 'patterns.md',         icon: '🧩' },
  { id: 'decisions',       name: 'Confirmed Decisions', file: 'decisions.md',     icon: '✅' },
  { id: 'hotspots',        name: 'Hotspots',         file: 'hotspots.md',         icon: '🔥' },
  { id: 'glossary',        name: 'Glossary',         file: 'glossary.md',         icon: '📖' },
];

// ── Resolvers ─────────────────────────────────────────────────────────────────

function isEnabled() {
  return (process.env.PRX_CORTEX_ENABLED || '').toUpperCase() === 'Y';
}

function cortexDir()   { return resolvedCortexDir(); }
function factsDir()    { return path.join(resolvedCortexDir(), 'facts'); }
function repowiseDir() { return path.join(resolvedCortexDir(), 'repowise'); }
function stateFile()   { return path.join(resolvedCortexDir(), 'state.json'); }
function indexFile()   { return path.join(resolvedCortexDir(), 'index.md'); }

function factFilePath(id) {
  const m = FACT_FILES.find(f => f.id === id);
  return m ? path.join(factsDir(), m.file) : null;
}

function listFactFiles() {
  const dir = factsDir();
  return FACT_FILES.map(f => ({
    ...f,
    path:    path.join(dir, f.file),
    exists:  fs.existsSync(path.join(dir, f.file)),
  }));
}

// ── State ────────────────────────────────────────────────────────────────────

function loadState() {
  try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); }
  catch (_) {
    return {
      enabled:           false,
      lastSynthesis:     0,
      lastRepowiseRun:   0,
      synthesisCount:    0,
      repowiseAvailable: false,
      sources:           {},
      distributed:       isDistributed(),
    };
  }
}

function saveState(state) {
  try {
    fs.mkdirSync(resolvedCortexDir(), { recursive: true });
    state.distributed = isDistributed();
    fs.writeFileSync(stateFile(), JSON.stringify(state, null, 2), 'utf8');
  } catch (_) {}
}

// ── Stats (used by dashboard + backup route) ─────────────────────────────────

function cortexStats() {
  const dir = resolvedCortexDir();
  const exists = fs.existsSync(dir);
  if (!exists) {
    return { exists: false, dir, distributed: isDistributed(), fileCount: 0, sizeBytes: 0, factCount: 0 };
  }

  let fileCount = 0, sizeBytes = 0;
  (function walk(d) {
    try {
      for (const f of fs.readdirSync(d)) {
        const full = path.join(d, f);
        let st;
        try { st = fs.statSync(full); } catch (_) { continue; }
        if (st.isDirectory()) walk(full);
        else { fileCount++; sizeBytes += st.size; }
      }
    } catch (_) {}
  })(dir);

  const factCount = listFactFiles().filter(f => f.exists).length;
  return { exists: true, dir, distributed: isDistributed(), fileCount, sizeBytes, factCount };
}

// ── Read helper (used by the dashboard page) ─────────────────────────────────

function readFactSafe(id) {
  const p = factFilePath(id);
  if (!p) return null;
  try { return fs.readFileSync(p, 'utf8'); }
  catch (_) { return null; }
}

function readIndexSafe() {
  try { return fs.readFileSync(indexFile(), 'utf8'); }
  catch (_) { return null; }
}

module.exports = {
  isEnabled,
  isDistributed,
  cortexDir,
  factsDir,
  repowiseDir,
  stateFile,
  indexFile,
  factFilePath,
  listFactFiles,
  loadState,
  saveState,
  cortexStats,
  readFactSafe,
  readIndexSafe,
  FACT_FILES,
};
