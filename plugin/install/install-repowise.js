#!/usr/bin/env node
'use strict';

// Cross-platform installer for repowise (https://github.com/repowise-dev/repowise).
//
// Repowise is a Python tool published on PyPI.  This script handles the install
// flow on macOS / Linux / Windows without assuming the user has a particular
// Python package manager.  Strategy:
//
//   1. If `repowise --version` already works → exit 0 (success, already installed).
//   2. If `pipx` is on PATH → `pipx install repowise` (cleanest install, isolated venv).
//   3. Else if `uv` is on PATH → `uv tool install repowise`.
//   4. Else fall back to `python3 -m pip install --user repowise`
//      (or `python` if `python3` is missing — Windows usually uses `python`).
//   5. If no Python interpreter is found, print a friendly message and exit 1.
//
// Used by:
//   - Plugin SessionStart hook (optional — only auto-installs if PRX_REPOWISE_AUTO_INSTALL=Y)
//   - The /dashboard/cortex/install-repowise dashboard route (button on the Cortex page).
//
// Output is JSON-on-last-line so callers can parse it; readable text precedes
// for human runs.

const { spawnSync, execSync } = require('child_process');
const os   = require('os');
const path = require('path');

function which(cmd) {
  // Windows: `where`. POSIX: `command -v` (always present in any sh).
  if (process.platform === 'win32') {
    const r = spawnSync('where', [cmd], { encoding: 'utf8' });
    return r.status === 0 && r.stdout.trim() ? r.stdout.trim().split(/\r?\n/)[0] : null;
  }
  const r = spawnSync('sh', ['-lc', `command -v ${cmd}`], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

function tryCmd(cmd, args, opts = {}) {
  console.log(`→ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    stdio:    ['ignore', 'inherit', 'inherit'],
    timeout:  10 * 60_000,  // 10 min — pip install can be slow on cold caches
    ...opts,
  });
  return r.status === 0;
}

function detectPython() {
  for (const c of ['python3', 'python']) {
    const p = which(c);
    if (!p) continue;
    // Confirm it's 3.11+ — repowise's minimum.
    const r = spawnSync(c, ['--version'], { encoding: 'utf8' });
    const m = (r.stdout || r.stderr || '').match(/Python\s+(\d+)\.(\d+)/);
    if (!m) continue;
    const major = parseInt(m[1], 10), minor = parseInt(m[2], 10);
    if (major === 3 && minor >= 11) return c;
    if (major > 3)                  return c;
  }
  return null;
}

function emit(result) {
  // Last line is always machine-readable JSON.
  console.log('\n' + JSON.stringify(result));
}

(function main() {
  const summary = {
    platform: process.platform,
    arch:     process.arch,
    home:     os.homedir(),
    via:      null,
    success:  false,
    message:  '',
  };

  console.log('═══════════════════════════════════════════════════');
  console.log('  repowise installer — Prevoyant Cortex layer');
  console.log('═══════════════════════════════════════════════════');
  console.log(`  Platform : ${summary.platform} (${summary.arch})`);
  console.log('');

  // Step 1 — already installed?
  if (which('repowise')) {
    const v = spawnSync('repowise', ['--version'], { encoding: 'utf8' });
    summary.success = true;
    summary.via     = 'already-installed';
    summary.message = (v.stdout || v.stderr || '').trim() || 'repowise is on PATH';
    console.log('✓ repowise is already installed — ' + summary.message);
    return emit(summary);
  }

  // Step 2 — pipx (preferred)
  if (which('pipx')) {
    if (tryCmd('pipx', ['install', 'repowise'])) {
      summary.success = true;
      summary.via     = 'pipx';
      summary.message = 'Installed via pipx';
      console.log('\n✓ Installed via pipx');
      return emit(summary);
    }
  }

  // Step 3 — uv tool install
  if (which('uv')) {
    if (tryCmd('uv', ['tool', 'install', 'repowise'])) {
      summary.success = true;
      summary.via     = 'uv';
      summary.message = 'Installed via uv tool';
      console.log('\n✓ Installed via uv tool');
      return emit(summary);
    }
  }

  // Step 4 — pip (user install)
  const py = detectPython();
  if (py) {
    if (tryCmd(py, ['-m', 'pip', 'install', '--user', 'repowise'])) {
      summary.success = true;
      summary.via     = `${py} -m pip --user`;
      summary.message = 'Installed via pip (user). You may need to add ~/.local/bin (Linux/macOS) or %APPDATA%\\Python\\Scripts (Windows) to PATH.';
      console.log('\n✓ Installed via pip');
      console.log('  Note: ensure the pip user-install bin dir is on your PATH.');
      return emit(summary);
    }
  }

  // Fall-through — nothing worked.
  summary.success = false;
  summary.message = py
    ? 'pipx / uv / pip install all failed — see logs above'
    : 'No Python 3.11+ interpreter found. Install Python 3.11 or later (https://python.org) and retry, OR install pipx (https://pipx.pypa.io).';
  console.log('\n✗ ' + summary.message);
  emit(summary);
  process.exit(1);
})();
