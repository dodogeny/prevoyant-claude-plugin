#!/usr/bin/env node
'use strict';

// Fragility Score
//
// Borrowed from Muninn's pre-edit context model. For a given source file in the
// PRX_REPO_DIR, compute a weighted 0.0–1.0 fragility score from six signals:
//
//   1. Dependents      — how many other files import or reference this one
//   2. Coverage gap    — whether a sibling test file exists (1 = no test)
//   3. Error history   — commits whose message looks like a fix/bug/hotfix
//   4. Change velocity — commits in the last 90 days
//   5. Complexity      — lines of code (clamped, soft signal)
//   6. Export surface  — public API surface (best-effort regex by language)
//
// Each signal is normalised to 0–1 then combined via fixed weights (sum = 1.0).
// Used by SKILL.md Step 5 to inject a Fragility column into the file map so the
// engineering panel gets a quantitative risk anchor without doing the legwork.
//
// Usage as a library (server-side):
//   const { fragility } = require('./fragilityScore');
//   const { score, band, breakdown } = fragility(absRepoDir, relativeFile);
//
// Usage as a CLI (from a SKILL bash step):
//   node server/runner/fragilityScore.js --repo "$REPO_DIR" \
//        --file fcfrontend/src/.../CaseManager.java [--files file1,file2,...] \
//        [--json] [--testRoots fcfrontend/src/test,fcbackend/src/test]
//
// Output (--json):
//   { "<file>": { "score": 0.74, "band": "HIGH", "breakdown": {...}, "raw": {...} } }
//
// Default (table mode) prints a single markdown row per file suitable for
// pasting directly into the Step 5 file map.

const { execSync } = require('child_process');
const fs           = require('fs');
const path         = require('path');

// ── Tunables ──────────────────────────────────────────────────────────────────

// Weights MUST sum to 1.0.
const WEIGHTS = {
  dependents:   0.25,
  coverage_gap: 0.20,
  error_history:0.20,
  velocity:     0.15,
  complexity:   0.10,
  exports:      0.10,
};

// Signals are normalised to 0–1 using log-shaped curves so a few extra commits
// don't saturate the score immediately.  These are the "saturation anchors" —
// the count at which the signal is treated as 1.0.
const SATURATION = {
  dependents:   50,   // 50+ inbound references → max fragility on this axis
  velocity:     30,   // 30+ commits in 90 days
  error_history:15,   // 15+ fix-style commits in 365 days
  exports:      30,   // 30+ public symbols
};

// Complexity is linear (LOC), but with a floor and ceiling.
const COMPLEXITY = { floor: 100, ceil: 1000 };

// History windows.
const VELOCITY_DAYS      = 90;
const ERROR_HISTORY_DAYS = 365;

// Band thresholds — used for the file map column.
function band(score) {
  if (score >= 0.65) return 'HIGH';
  if (score >= 0.30) return 'MED';
  return 'LOW';
}

// Per-language hints for test discovery and export detection.
// Extension-driven — falls back to permissive defaults for unknown types.
const LANG = {
  '.java':  { testPatterns: ['{base}Test.java', '{base}IT.java', 'Test{base}.java'], exportRe: /^\s*public\s+(?:static\s+)?(?:final\s+)?(?:abstract\s+)?(?:synchronized\s+)?[\w<>\[\],?\s]+\s+\w+\s*\(/gm },
  '.ts':    { testPatterns: ['{base}.test.ts', '{base}.spec.ts'],                     exportRe: /^\s*export\s+(?:async\s+)?(?:function|class|const|interface|type)\s+\w+/gm },
  '.tsx':   { testPatterns: ['{base}.test.tsx', '{base}.spec.tsx'],                   exportRe: /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const)\s+\w+/gm },
  '.js':    { testPatterns: ['{base}.test.js', '{base}.spec.js'],                     exportRe: /^\s*(?:module\.exports\s*=|exports\.\w+\s*=|export\s+(?:async\s+)?(?:function|class|const))/gm },
  '.jsx':   { testPatterns: ['{base}.test.jsx', '{base}.spec.jsx'],                   exportRe: /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const)\s+\w+/gm },
  '.py':    { testPatterns: ['test_{base}.py', '{base}_test.py'],                     exportRe: /^\s*def\s+[a-z_][\w]*\s*\(/gm },
  '.go':    { testPatterns: ['{base}_test.go'],                                       exportRe: /^\s*func\s+(?:\([^)]+\)\s+)?[A-Z]\w*\s*\(/gm },
  '.rb':    { testPatterns: ['{base}_spec.rb', 'test_{base}.rb'],                     exportRe: /^\s*def\s+[a-z_][\w]*/gm },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function git(args, cwd, opts = {}) {
  try {
    return execSync(`git ${args}`, {
      cwd,
      encoding: 'utf8',
      timeout:  10_000,
      stdio:    ['ignore', 'pipe', 'ignore'],
      maxBuffer: 16 * 1024 * 1024,
      ...opts,
    }).trim();
  } catch (_) { return ''; }
}

function logNorm(value, saturationAt) {
  if (value <= 0) return 0;
  // log(1+v)/log(1+S) — smooth, saturates near 1 at S.
  return Math.min(1, Math.log(1 + value) / Math.log(1 + saturationAt));
}

function clamp01(v) { return Math.max(0, Math.min(1, v)); }

function extOf(file) { return path.extname(file).toLowerCase(); }
function baseOf(file) { return path.basename(file, path.extname(file)); }

// ── Signal collectors ─────────────────────────────────────────────────────────

// Dependents: count of distinct files that reference this file's basename via
// import / require / `.<ClassName>` patterns.  Best-effort grep — caller may
// already have a richer signal from the Step 5 caller traversal; if so, pass
// `dependentsHint` to override.
function countDependents(repo, file) {
  const base = baseOf(file);
  if (!base || base.length < 2) return 0;

  // Limit to common source extensions to keep grep fast in monorepos.
  const exts = ['*.java','*.ts','*.tsx','*.js','*.jsx','*.py','*.go','*.kt','*.scala','*.rb'];
  const includes = exts.map(e => `--include=${e}`).join(' ');

  // Match: import …Base, from '…Base', require('…Base'), <Base>, .Base(, new Base(
  // grep -l so we count distinct files.
  let out;
  try {
    out = execSync(
      `grep -rlE ${includes} "(\\\\bimport\\\\b.*\\\\b${base}\\\\b|require\\\\([\\"'][^\\"']*${base}[\\"']\\\\)|\\\\b${base}\\\\s*\\\\(|new\\\\s+${base}\\\\b)" .`,
      { cwd: repo, encoding: 'utf8', timeout: 15_000, stdio: ['ignore','pipe','ignore'], maxBuffer: 8 * 1024 * 1024 }
    );
  } catch (_) { return 0; }

  if (!out) return 0;
  const files = out.split('\n').filter(l => l && !l.endsWith('/' + path.basename(file)) && l !== './' + file);
  return new Set(files).size;
}

// Coverage gap: returns 1.0 if NO test file is found nearby, else 0.
// Looks beside the source first; falls back to repo-wide find with the language
// pattern.  Cheap — `find` is bounded by depth 6.
function coverageGap(repo, file, extraTestRoots = []) {
  const ext      = extOf(file);
  const patterns = (LANG[ext]?.testPatterns) || [`${baseOf(file)}.test*`, `${baseOf(file)}.spec*`];
  const base     = baseOf(file);

  const siblings = patterns.map(p => p.replace('{base}', base));
  const dir      = path.dirname(file);

  // 1) Same directory check.
  for (const sib of siblings) {
    if (fs.existsSync(path.join(repo, dir, sib))) return 0;
  }

  // 2) Configured test roots (e.g. fcfrontend/src/test).
  for (const root of extraTestRoots) {
    for (const sib of siblings) {
      try {
        const result = execSync(
          `find "${root}" -maxdepth 6 -name "${sib}" -print -quit 2>/dev/null`,
          { cwd: repo, encoding: 'utf8', timeout: 4_000, stdio: ['ignore','pipe','ignore'] }
        );
        if (result.trim()) return 0;
      } catch (_) {}
    }
  }

  // 3) Repo-wide last resort (capped).
  for (const sib of siblings) {
    try {
      const result = execSync(
        `find . -maxdepth 8 -name "${sib}" -print -quit 2>/dev/null`,
        { cwd: repo, encoding: 'utf8', timeout: 5_000, stdio: ['ignore','pipe','ignore'] }
      );
      if (result.trim()) return 0;
    } catch (_) {}
  }

  return 1;
}

// Change velocity: commits touching this file in the last VELOCITY_DAYS.
function changeVelocity(repo, file) {
  const raw = git(`log --since="${VELOCITY_DAYS} days ago" --oneline -- "${file}"`, repo);
  return raw ? raw.split('\n').filter(Boolean).length : 0;
}

// Error history: fix-style commits touching this file in the last year.
function errorHistory(repo, file) {
  const raw = git(
    `log --since="${ERROR_HISTORY_DAYS} days ago" --grep="fix\\|bug\\|hotfix\\|error\\|regression\\|broken\\|crash" -i --oneline -- "${file}"`,
    repo
  );
  return raw ? raw.split('\n').filter(Boolean).length : 0;
}

// Complexity: LOC (lines of code).  Soft signal — capped at 1.0 above CEIL.
function complexity(repo, file) {
  let loc = 0;
  try {
    const buf = fs.readFileSync(path.join(repo, file), 'utf8');
    loc = buf.split('\n').length;
  } catch (_) { return 0; }
  if (loc <= COMPLEXITY.floor) return 0;
  if (loc >= COMPLEXITY.ceil)  return 1;
  return (loc - COMPLEXITY.floor) / (COMPLEXITY.ceil - COMPLEXITY.floor);
}

// Export surface: public symbols defined in the file, language-aware.
function exportSurface(repo, file) {
  const ext = extOf(file);
  const re  = LANG[ext]?.exportRe;
  if (!re) return 0;
  let text;
  try { text = fs.readFileSync(path.join(repo, file), 'utf8'); }
  catch (_) { return 0; }
  // Reset the global regex's lastIndex (it persists between calls).
  re.lastIndex = 0;
  const matches = text.match(re);
  return matches ? matches.length : 0;
}

// ── Composite ─────────────────────────────────────────────────────────────────

function fragility(repo, file, opts = {}) {
  const raw = {
    dependents:    opts.dependentsHint != null ? opts.dependentsHint : countDependents(repo, file),
    coverage_gap:  coverageGap(repo, file, opts.testRoots || []),
    error_history: errorHistory(repo, file),
    velocity:      changeVelocity(repo, file),
    complexity_loc: 0,  // filled below
    exports:       exportSurface(repo, file),
  };

  // Pull the complexity LOC for the breakdown display; the score uses the
  // normalised 0–1 form.
  let loc = 0;
  try { loc = fs.readFileSync(path.join(repo, file), 'utf8').split('\n').length; } catch (_) {}
  raw.complexity_loc = loc;

  const normalised = {
    dependents:    logNorm(raw.dependents,    SATURATION.dependents),
    coverage_gap:  raw.coverage_gap,  // already 0 or 1
    error_history: logNorm(raw.error_history, SATURATION.error_history),
    velocity:      logNorm(raw.velocity,      SATURATION.velocity),
    complexity:    complexity(repo, file),
    exports:       logNorm(raw.exports,       SATURATION.exports),
  };

  let score = 0;
  for (const [k, w] of Object.entries(WEIGHTS)) {
    score += clamp01(normalised[k] || 0) * w;
  }
  score = clamp01(score);

  return {
    score:     +score.toFixed(2),
    band:      band(score),
    breakdown: Object.fromEntries(Object.entries(normalised).map(([k, v]) => [k, +(v.toFixed(2))])),
    raw,
  };
}

// ── CLI ───────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { files: [], testRoots: [], json: false, repo: process.env.PRX_REPO_DIR || '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json')       out.json = true;
    else if (a === '--repo')      out.repo = argv[++i];
    else if (a === '--file')      out.files.push(argv[++i]);
    else if (a === '--files')     out.files.push(...argv[++i].split(',').map(s => s.trim()).filter(Boolean));
    else if (a === '--testRoots') out.testRoots = argv[++i].split(',').map(s => s.trim()).filter(Boolean);
  }
  return out;
}

function renderRow(file, r) {
  const pct = Math.round(r.score * 100);
  const cov = r.breakdown.coverage_gap === 1 ? 'no test' : 'has test';
  const dep = r.raw.dependents;
  const err = r.raw.error_history;
  return `\`${file}\` | fragility=${r.score.toFixed(2)} (${r.band}) | dependents=${dep}, ${cov}, fix-commits=${err}, LOC=${r.raw.complexity_loc} | ${pct}%`;
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.repo) { console.error('error: --repo or PRX_REPO_DIR is required'); process.exit(2); }
  if (args.files.length === 0) { console.error('error: pass --file <path> or --files a,b,c'); process.exit(2); }

  const results = {};
  for (const f of args.files) {
    results[f] = fragility(args.repo, f, { testRoots: args.testRoots });
  }

  if (args.json) {
    process.stdout.write(JSON.stringify(results, null, 2) + '\n');
  } else {
    console.log('| File | Fragility | Signals | Score |');
    console.log('|------|-----------|---------|-------|');
    for (const f of args.files) console.log('| ' + renderRow(f, results[f]) + ' |');
  }
}

module.exports = { fragility, band, WEIGHTS, SATURATION };
