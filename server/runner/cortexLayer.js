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

// Cortex lives outside the KB so that:
//   - Distributed-mode KB sync (Upstash) never accidentally ships cortex files.
//   - A user can delete and rebuild the cortex without touching the KB.
const CORTEX_DIR    = path.join(os.homedir(), '.prevoyant', 'cortex');
const FACTS_DIR     = path.join(CORTEX_DIR, 'facts');
const REPOWISE_DIR  = path.join(CORTEX_DIR, 'repowise');
const STATE_FILE    = path.join(CORTEX_DIR, 'state.json');
const INDEX_FILE    = path.join(CORTEX_DIR, 'index.md');

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

function cortexDir()   { return CORTEX_DIR; }
function factsDir()    { return FACTS_DIR; }
function repowiseDir() { return REPOWISE_DIR; }
function stateFile()   { return STATE_FILE; }
function indexFile()   { return INDEX_FILE; }

function factFilePath(id) {
  const m = FACT_FILES.find(f => f.id === id);
  return m ? path.join(FACTS_DIR, m.file) : null;
}

function listFactFiles() {
  return FACT_FILES.map(f => ({
    ...f,
    path:    path.join(FACTS_DIR, f.file),
    exists:  fs.existsSync(path.join(FACTS_DIR, f.file)),
  }));
}

// ── State ────────────────────────────────────────────────────────────────────

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch (_) {
    return {
      enabled:           false,
      lastSynthesis:     0,
      lastRepowiseRun:   0,
      synthesisCount:    0,
      repowiseAvailable: false,
      sources:           {},
    };
  }
}

function saveState(state) {
  try {
    fs.mkdirSync(CORTEX_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (_) {}
}

// ── Stats (used by dashboard + backup route) ─────────────────────────────────

function cortexStats() {
  const exists = fs.existsSync(CORTEX_DIR);
  if (!exists) {
    return { exists: false, dir: CORTEX_DIR, fileCount: 0, sizeBytes: 0, factCount: 0 };
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
  })(CORTEX_DIR);

  const factCount = listFactFiles().filter(f => f.exists).length;
  return { exists: true, dir: CORTEX_DIR, fileCount, sizeBytes, factCount };
}

// ── Read helper (used by the dashboard page) ─────────────────────────────────

function readFactSafe(id) {
  const p = factFilePath(id);
  if (!p) return null;
  try { return fs.readFileSync(p, 'utf8'); }
  catch (_) { return null; }
}

function readIndexSafe() {
  try { return fs.readFileSync(INDEX_FILE, 'utf8'); }
  catch (_) { return null; }
}

module.exports = {
  isEnabled,
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
