'use strict';

// Cortex Worker — runs as a worker_threads thread.
//
// Cortex is an always-on, self-updating intelligence layer that sits ON TOP
// of the KB.  It distills accumulated knowledge into a small set of curated
// fact files at ~/.prevoyant/cortex/facts/* that AI agents (via Step 0 of the
// dev skill) can reference to "upgrade" their understanding of the system in
// a single small read — instead of trawling the full KB on every session.
//
// Two trigger sources:
//   1. KB changes — fs.watch on the KB directory, debounced (default 30s).
//   2. Repowise — `repowise update` runs on a configurable interval to refresh
//      the codebase graph + auto-generated wiki used for hotspot/architecture
//      facts.  Repowise output is captured to ~/.prevoyant/cortex/repowise/.
//
// On each trigger, a synthesis pass runs:
//   - Aggregates KB shared/*.md into cortex/facts/*.md
//   - Filters decisions by CONFIRMED status (from decision-outcomes worker)
//   - Sorts patterns by frequency
//   - Combines repowise hotspots with our local fragility scoring
//   - Generates an index.md TOC and updates state.json
//
// Nothing destructive ever happens to the source KB.  Cortex is purely
// derivative — delete the cortex/ dir and re-run to rebuild.
//
// Config:
//   PRX_CORTEX_ENABLED            — Y/N (default N)
//   PRX_CORTEX_DEBOUNCE_SECS      — debounce KB-change syntheses (default 30)
//   PRX_CORTEX_RESYNC_HOURS       — heartbeat resync interval (default 6)
//   PRX_REPOWISE_ENABLED          — Y/N (default N) — run repowise updates
//   PRX_REPOWISE_INTERVAL_DAYS    — how often to refresh repowise (default 1)
//   PRX_REPOWISE_PATH             — override path/cmd (default: 'repowise')
//   PRX_REPO_DIR                  — source repository to index
//   PRX_KB_MODE / PRX_KNOWLEDGE_DIR / PRX_KB_LOCAL_CLONE — KB location.

const { workerData, parentPort } = require('worker_threads');
const { execSync, spawnSync }    = require('child_process');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const cortex = require('../runner/cortexLayer');

// ── Config ───────────────────────────────────────────────────────────────────

function isEnabled()           { return (process.env.PRX_CORTEX_ENABLED || '').toUpperCase() === 'Y'; }
function debounceMs()          { return Math.max(5, parseInt(process.env.PRX_CORTEX_DEBOUNCE_SECS || '30', 10)) * 1000; }
function resyncMs()            { return Math.max(0.5, parseFloat(process.env.PRX_CORTEX_RESYNC_HOURS || '6')) * 3_600_000; }
function repowiseEnabled()     { return (process.env.PRX_REPOWISE_ENABLED || '').toUpperCase() === 'Y'; }
function repowiseIntervalMs()  { return Math.max(0.1, parseFloat(process.env.PRX_REPOWISE_INTERVAL_DAYS || '1')) * 86_400_000; }
function repowiseCmd()         { return process.env.PRX_REPOWISE_PATH || 'repowise'; }
function repoDir()             { return process.env.PRX_REPO_DIR || process.env.PRX_SOURCE_REPO_DIR || ''; }

function kbDir() {
  const mode = process.env.PRX_KB_MODE || 'local';
  return mode === 'distributed'
    ? (process.env.PRX_KB_LOCAL_CLONE || path.join(os.homedir(), '.prevoyant', 'kb'))
    : (process.env.PRX_KNOWLEDGE_DIR  || path.join(os.homedir(), '.prevoyant', 'knowledge-base'));
}

const BUILDUP_DIR = path.join(os.homedir(), '.prevoyant', 'knowledge-buildup');

// ── Logging ──────────────────────────────────────────────────────────────────

function log(level, msg) {
  const ts = new Date().toISOString();
  if (parentPort) parentPort.postMessage({ type: 'log', level, msg, ts });
  console.log(`[${ts}] [cortex/${level}] ${msg}`);
}

// ── File helpers ─────────────────────────────────────────────────────────────

function readSafe(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (_) { return ''; }
}

function writeAtomic(file, content) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

function relToHome(p) {
  const h = os.homedir();
  return p && p.startsWith(h) ? '~' + p.slice(h.length) : p;
}

// ── Repowise integration ─────────────────────────────────────────────────────

let repowiseAvailable = null;

function checkRepowise() {
  if (repowiseAvailable !== null) return repowiseAvailable;
  try {
    const r = spawnSync(repowiseCmd(), ['--version'], { encoding: 'utf8', timeout: 5_000 });
    repowiseAvailable = r.status === 0;
  } catch (_) {
    repowiseAvailable = false;
  }
  return repowiseAvailable;
}

// Runs `repowise update` (or init on first run) against PRX_REPO_DIR.
// Captures CLAUDE.md into the cortex repowise dir so downstream synthesis
// can ingest it without depending on the source-repo tree.  Emits a
// `repowise-ran` parent message so the dashboard activity log can track
// when repowise actually runs (separately from synthesis passes).
function runRepowise() {
  const startedAt = Date.now();
  const emit = (result) => {
    if (parentPort) parentPort.postMessage({
      type:       'repowise-ran',
      ok:         !!result.ok,
      mode:       result.mode || null,
      reason:     result.skipped || result.error || null,
      durationMs: Date.now() - startedAt,
    });
    return result;
  };

  if (!repowiseEnabled()) return emit({ ok: false, skipped: 'disabled' });
  if (!repoDir() || !fs.existsSync(path.join(repoDir(), '.git'))) {
    return emit({ ok: false, skipped: 'no-repo' });
  }
  if (!checkRepowise()) {
    return emit({ ok: false, skipped: 'not-installed' });
  }

  const repo = repoDir();
  const alreadyIndexed = fs.existsSync(path.join(repo, '.repowise'));
  const sub = alreadyIndexed ? 'update' : 'init';

  log('info', `Running '${repowiseCmd()} ${sub}' in ${repo}`);
  let result;
  try {
    result = spawnSync(repowiseCmd(), [sub, repo, '--index-only'], {
      encoding: 'utf8',
      timeout: alreadyIndexed ? 5 * 60_000 : 60 * 60_000,  // init can be slow
      stdio:   ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    return emit({ ok: false, error: err.message });
  }

  if (result.status !== 0) {
    return emit({ ok: false, error: (result.stderr || '').slice(0, 400) });
  }

  // Try to regenerate CLAUDE.md and capture it.
  try {
    spawnSync(repowiseCmd(), ['generate-claude-md', repo], { encoding: 'utf8', timeout: 60_000, stdio: ['ignore','pipe','pipe'] });
    const claudeMd = path.join(repo, 'CLAUDE.md');
    if (fs.existsSync(claudeMd)) {
      fs.mkdirSync(cortex.repowiseDir(), { recursive: true });
      fs.copyFileSync(claudeMd, path.join(cortex.repowiseDir(), 'CLAUDE.md'));
    }
  } catch (_) { /* best effort */ }

  return emit({ ok: true, mode: sub });
}

// ── KB readers ───────────────────────────────────────────────────────────────

function readKbFile(rel) {
  return readSafe(path.join(kbDir(), rel));
}

function listKbShared() {
  const dir = path.join(kbDir(), 'shared');
  try { return fs.readdirSync(dir).filter(f => f.endsWith('.md')); }
  catch (_) { return []; }
}

function repowiseClaudeMd() {
  return readSafe(path.join(cortex.repowiseDir(), 'CLAUDE.md'));
}

// ── Synthesis ────────────────────────────────────────────────────────────────

const HEADER_PRELUDE =
`<!--
  AUTO-GENERATED by the Cortex Worker (server/workers/cortexWorker.js).
  Do NOT edit this file by hand — changes will be overwritten on the next
  synthesis pass.  To change the source, edit the underlying KB files
  (shared/*.md) or the repowise output.

  Generated at: {GENERATED_AT}
-->

`;

function withHeader(content) {
  return HEADER_PRELUDE.replace('{GENERATED_AT}', new Date().toISOString()) + content;
}

function synthesizeArchitecture() {
  const lines = ['# Cortex — Architecture\n'];
  const kbArch = readKbFile('core-mental-map/architecture.md');
  if (kbArch) {
    lines.push('## From KB · `core-mental-map/architecture.md`\n');
    lines.push(kbArch.trim());
    lines.push('');
  }
  const kbShared = readKbFile('shared/architecture.md');
  if (kbShared) {
    lines.push('## From KB · `shared/architecture.md`\n');
    lines.push(kbShared.trim());
    lines.push('');
  }
  const rw = repowiseClaudeMd();
  if (rw) {
    lines.push('## From repowise · `CLAUDE.md`\n');
    lines.push(rw.trim());
    lines.push('');
  }
  if (lines.length === 1) lines.push('_(no architecture sources found yet — populate KB or enable repowise)_\n');
  return withHeader(lines.join('\n'));
}

function synthesizeBusinessRules() {
  const src = readKbFile('shared/business-rules.md');
  if (!src) return withHeader('# Cortex — Business Rules\n\n_(no shared/business-rules.md in KB yet)_\n');
  // Light filter: drop entries explicitly marked `status: STALE` or `[STALE]`.
  const pruned = src
    .split(/\n(?=##\s)/)
    .filter(block => !/\[STALE\]|status:\s*STALE/i.test(block))
    .join('\n');
  return withHeader(`# Cortex — Business Rules\n\n_Sourced from \`shared/business-rules.md\` — stale entries filtered._\n\n${pruned.trim()}\n`);
}

function synthesizePatterns() {
  const src = readKbFile('shared/patterns.md');
  if (!src) return withHeader('# Cortex — Patterns\n\n_(no shared/patterns.md in KB yet)_\n');
  // Sort blocks by frequency counter if present.
  const blocks = src.split(/\n(?=##\s)/);
  const scored = blocks.map(b => {
    const m = b.match(/freq(?:uency)?\s*[:=]\s*(\d+)/i);
    return { score: m ? parseInt(m[1], 10) : 0, text: b };
  });
  scored.sort((a, b) => b.score - a.score);
  return withHeader(`# Cortex — Patterns\n\n_Sourced from \`shared/patterns.md\` — sorted by frequency._\n\n${scored.map(s => s.text).join('\n').trim()}\n`);
}

function synthesizeDecisions() {
  // Prefer CONFIRMED-only decisions: read the decision-outcomes proposals if
  // they exist; otherwise fall back to the raw shared/decisions.md.
  const proposals = readSafe(path.join(BUILDUP_DIR, 'decision-outcomes.md'));
  const lines = ['# Cortex — Confirmed Decisions\n'];

  if (proposals && /status:\s*\*\*CONFIRMED\*\*/.test(proposals)) {
    const blocks = proposals.split(/\n(?=##\s)/).filter(b => /status:\s*\*\*CONFIRMED\*\*/.test(b));
    lines.push('_Sourced from `decision-outcomes.md` — filtered to **CONFIRMED** only._\n');
    lines.push(blocks.join('\n').trim());
  } else {
    const raw = readKbFile('shared/decisions.md');
    if (raw) {
      lines.push('_Sourced from raw `shared/decisions.md` (no decision-outcomes review yet)._\n');
      lines.push(raw.trim());
    } else {
      lines.push('_(no decisions sources found yet)_\n');
    }
  }
  return withHeader(lines.join('\n'));
}

function synthesizeHotspots() {
  // Two signals combined:
  //   (a) repowise hotspots (high churn × complexity) — parsed loosely from
  //       the CLAUDE.md "Hotspots" section if present.
  //   (b) any file in shared/business-rules.md or shared/patterns.md flagged
  //       HIGH fragility via SKILL.md retros.
  const rw = repowiseClaudeMd();
  const out = ['# Cortex — Hotspots\n'];

  if (rw) {
    const m = rw.match(/##\s+Hotspots[\s\S]*?(?=\n##\s|$)/i);
    if (m) {
      out.push('## From repowise\n');
      out.push(m[0].replace(/^##\s+Hotspots\s*\n+/, '').trim());
      out.push('');
    }
  }

  // Roll up [KB+ RISK] fragility markers from shared/patterns.md if present.
  const patterns = readKbFile('shared/patterns.md');
  if (patterns) {
    const risks = patterns.split('\n').filter(l => /\[KB\+\s*RISK\]/i.test(l)).slice(0, 30);
    if (risks.length) {
      out.push('## From KB · `shared/patterns.md` (KB+ RISK markers)\n');
      out.push(risks.map(r => '- ' + r.trim()).join('\n'));
      out.push('');
    }
  }

  if (out.length === 1) out.push('_(no hotspots identified yet — enable repowise for richer signal)_\n');
  return withHeader(out.join('\n'));
}

function synthesizeGlossary() {
  // Build a glossary from shared/*.md headings — gives agents a fast index of
  // domain terms without having to grep each file.
  const dir = path.join(kbDir(), 'shared');
  const entries = [];
  for (const f of listKbShared()) {
    const text = readSafe(path.join(dir, f));
    if (!text) continue;
    const lines = text.split('\n');
    for (const line of lines) {
      const m = line.match(/^##\s+(.+?)\s*$/);
      if (m && m[1].length <= 80) entries.push({ term: m[1], src: `shared/${f}` });
    }
  }
  entries.sort((a, b) => a.term.localeCompare(b.term));
  const body = entries.length
    ? entries.map(e => `- **${e.term}** — \`${e.src}\``).join('\n')
    : '_(no shared/*.md headings found yet)_';
  return withHeader(`# Cortex — Glossary\n\n_Auto-extracted from \`shared/*.md\` headings._\n\n${body}\n`);
}

const SYNTHESIZERS = {
  'architecture':   synthesizeArchitecture,
  'business-rules': synthesizeBusinessRules,
  'patterns':       synthesizePatterns,
  'decisions':      synthesizeDecisions,
  'hotspots':       synthesizeHotspots,
  'glossary':       synthesizeGlossary,
};

function buildIndex(state) {
  const lines = [
    '# Cortex — Index',
    '',
    `_Generated at ${new Date().toISOString()}_`,
    '',
    'This is the **always-on intelligence layer**. Each file below is auto-synthesized',
    'from the underlying KB and (optionally) from repowise. Read these instead of the',
    'raw KB when you need a quick orientation — agents reference them in Step 0 of the dev skill.',
    '',
    '## Fact files',
    '',
  ];
  for (const f of cortex.listFactFiles()) {
    lines.push(`- ${f.icon} **[${f.name}](${f.file})** — ${f.exists ? 'fresh' : '_(not yet synthesized)_'}`);
  }
  lines.push('');
  lines.push('## State');
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify(state, null, 2));
  lines.push('```');
  lines.push('');
  return lines.join('\n');
}

function runSynthesis(state) {
  // Leader-election gate — in shared mode, only one machine writes at a time
  // so two devs synthesising on different KB heads can't clobber each other.
  // Local-per-machine mode short-circuits to allowed=true inside the helper.
  const claim = cortex.claimBuilder();
  if (!claim.allowed) {
    log('info',
      `Skipping synthesis — cortex builder is '${claim.currentBuilder}' ` +
      `(heartbeat ${Math.round((Date.now() - claim.lastHeartbeat) / 1000)}s ago). ` +
      `We are a passive reader on this machine.`
    );
    if (parentPort) parentPort.postMessage({
      type:           'cortex-skipped',
      reason:         claim.reason,
      currentBuilder: claim.currentBuilder,
      lastHeartbeat:  claim.lastHeartbeat,
    });
    return;
  }
  // Surface takeovers so the dashboard activity log shows builder changes.
  if (claim.reason === 'stale-takeover' || claim.reason === 'unclaimed' || claim.reason === 'force-builder') {
    log('info', `Cortex builder claim acquired (${claim.reason}) by ${claim.currentBuilder}`);
    if (parentPort) parentPort.postMessage({
      type:           'cortex-builder-claimed',
      reason:         claim.reason,
      currentBuilder: claim.currentBuilder,
    });
  }

  log('info', 'Synthesis pass starting');
  const factsDir = cortex.factsDir();
  fs.mkdirSync(factsDir, { recursive: true });

  let written = 0;
  const sources = {};
  for (const f of cortex.listFactFiles()) {
    const fn = SYNTHESIZERS[f.id];
    if (!fn) continue;
    try {
      const content = fn();
      writeAtomic(path.join(factsDir, f.file), content);
      sources[f.id] = { bytes: content.length, generatedAt: Date.now() };
      written++;
    } catch (err) {
      log('warn', `Synthesis ${f.id} failed: ${err.message}`);
    }
  }

  state.enabled        = true;
  state.lastSynthesis  = Date.now();
  state.synthesisCount = (state.synthesisCount || 0) + 1;
  state.sources        = sources;
  state.repowiseAvailable = checkRepowise();
  cortex.saveState(state);

  // Rebuild the index after state is fresh.
  try { writeAtomic(cortex.indexFile(), buildIndex(state)); } catch (_) {}

  log('info', `Synthesis pass complete — ${written}/${Object.keys(SYNTHESIZERS).length} fact files written`);

  if (parentPort) parentPort.postMessage({
    type:        'cortex-synthesized',
    factsWritten: written,
    repowiseAvailable: state.repowiseAvailable,
    distributed:  (process.env.PRX_CORTEX_DISTRIBUTED || '').toUpperCase() === 'Y',
  });
}

// ── KB watcher (debounced) ──────────────────────────────────────────────────

let watcher = null;
let pendingTimer = null;

function debouncedSynth() {
  if (pendingTimer) clearTimeout(pendingTimer);
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    try { runSynthesis(cortex.loadState()); } catch (e) { log('error', e.message); }
  }, debounceMs());
}

function startWatcher() {
  const dir = kbDir();
  if (!fs.existsSync(dir)) { log('warn', `KB dir does not exist: ${dir}`); return; }
  try {
    watcher = fs.watch(dir, { recursive: true }, (_event, filename) => {
      // Ignore obvious noise.
      if (!filename) return;
      if (filename.startsWith('.git/')) return;
      if (filename.endsWith('.swp') || filename.endsWith('.tmp')) return;
      debouncedSynth();
    });
    log('info', `Watching KB dir for changes: ${relToHome(dir)}`);
  } catch (err) {
    log('warn', `fs.watch failed (${err.message}) — falling back to periodic heartbeat only`);
  }
}

function stopWatcher() {
  if (watcher) { try { watcher.close(); } catch (_) {} watcher = null; }
  if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
}

// ── Main loop ────────────────────────────────────────────────────────────────

let halted = false;
if (parentPort) {
  parentPort.on('message', msg => {
    if (msg?.type === 'graceful-stop') { halted = true; stopWatcher(); }
    if (msg?.type === 'run-now')       { try { runSynthesis(cortex.loadState()); } catch (e) { log('error', e.message); } }
    if (msg?.type === 'repowise-now')  {
      try {
        const r = runRepowise();
        log('info', `Repowise run-now result: ${JSON.stringify(r)}`);
        runSynthesis(cortex.loadState());
      } catch (e) { log('error', e.message); }
    }
  });
}

(async function main() {
  log('info',
    `Started — debounce=${debounceMs()/1000}s heartbeat=${resyncMs()/3_600_000}h ` +
    `repowise=${repowiseEnabled() ? 'on' : 'off'} kb=${relToHome(kbDir())}`
  );

  // Initial state probe + first synthesis if the cortex dir is empty.
  const state = cortex.loadState();
  state.repowiseAvailable = checkRepowise();
  cortex.saveState(state);

  if (!state.lastSynthesis) {
    try { runSynthesis(state); } catch (e) { log('error', e.message); }
  }

  startWatcher();

  // Repowise scheduler — separate cadence from the KB watcher.
  let lastRepowise = state.lastRepowiseRun || 0;
  if (repowiseEnabled() && (Date.now() - lastRepowise) >= repowiseIntervalMs()) {
    try {
      const r = runRepowise();
      if (r.ok) {
        const s = cortex.loadState();
        s.lastRepowiseRun = Date.now();
        cortex.saveState(s);
        runSynthesis(cortex.loadState());
      } else {
        log('warn', `Repowise initial run skipped: ${r.skipped || r.error}`);
      }
    } catch (e) { log('error', e.message); }
  }

  // Heartbeat loop — handles both repowise interval ticks and a periodic
  // resync (in case fs.watch missed something).  We also detect wake-from-
  // sleep here: if the actual wall-clock gap between heartbeats is much
  // larger than what we asked setTimeout for, the laptop almost certainly
  // suspended the process.  Add a small jitter pause so multiple workers
  // waking together don't burst-fire git/repowise simultaneously.
  let lastTick = Date.now();
  while (!halted) {
    const want = Math.min(resyncMs(), repowiseEnabled() ? repowiseIntervalMs() : resyncMs());
    await new Promise(r => setTimeout(r, want));
    if (halted) break;

    const actual = Date.now() - lastTick;
    if (actual > want * 1.5 && actual > 5 * 60_000) {
      // Slept (or paused) — jitter 0–30s so co-located workers spread out.
      const jitter = Math.floor(Math.random() * 30_000);
      log('info', `Detected wake-from-sleep (gap=${Math.round(actual/1000)}s, expected=${Math.round(want/1000)}s) — jittering ${Math.round(jitter/1000)}s before resuming`);
      await new Promise(r => setTimeout(r, jitter));
    }
    lastTick = Date.now();

    // Repowise interval check
    if (repowiseEnabled()) {
      const s = cortex.loadState();
      if ((Date.now() - (s.lastRepowiseRun || 0)) >= repowiseIntervalMs()) {
        try {
          const r = runRepowise();
          if (r.ok) {
            const s2 = cortex.loadState();
            s2.lastRepowiseRun = Date.now();
            cortex.saveState(s2);
          }
        } catch (e) { log('error', e.message); }
      }
    }

    // Heartbeat resync
    try { runSynthesis(cortex.loadState()); } catch (e) { log('error', e.message); }
  }

  log('info', 'Stopped');
})();
