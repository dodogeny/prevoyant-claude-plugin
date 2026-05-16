'use strict';

// Server-side wrapper around plugin/install/install-repowise.js.
//
// Purpose: when PRX_REPOWISE_ENABLED=Y, the server actively ensures repowise
// (+ pipx as a prerequisite) is installed.  Triggered:
//   - at startup, from server/index.js startCortex()
//   - on settings-saved when PRX_REPOWISE_ENABLED transitions to Y
//   - manually via the "Install repowise" button on /dashboard/cortex
//
// Behaviour:
//   - Fire-and-forget by default — never blocks startup or a settings save.
//   - Concurrent-call protection — if an install is already running, calls
//     return the existing promise instead of spawning a second process.
//   - Records activity events so the dashboard timeline shows what happened.
//   - Best-effort: a failed install does NOT crash anything; the cortex
//     worker just falls back to KB-only synthesis when repowise is missing.
//
// Caller behaviour is identical in all environments — repowise's actual
// install ladder (pipx → uv → pip --user) lives in the plugin script.

const { spawnSync, spawn } = require('child_process');
const path = require('path');
const fs   = require('fs');
const os   = require('os');

const activityLog = require('../dashboard/activityLog');

// ── Singleton state ──────────────────────────────────────────────────────────

let pendingPromise   = null;
let lastResult       = null;
let lastResultAt     = 0;

// ── Helpers ──────────────────────────────────────────────────────────────────

function repowiseCmd() {
  return process.env.PRX_REPOWISE_PATH || 'repowise';
}

function whichRepowise() {
  // Quick PATH check — fast (~30ms) and avoids spawning Python.
  try {
    const r = spawnSync(repowiseCmd(), ['--version'], { encoding: 'utf8', timeout: 5_000 });
    return r.status === 0;
  } catch (_) {
    return false;
  }
}

function autoInstallEnabled() {
  // PRX_REPOWISE_ENABLED=Y is the new default trigger.  PRX_REPOWISE_AUTO_INSTALL=N
  // is an explicit opt-out for users who want manual control (locked-down
  // dev machines, audit-tracked environments, etc.).
  if (process.env.PRX_REPOWISE_ENABLED !== 'Y') return false;
  const optOut = (process.env.PRX_REPOWISE_AUTO_INSTALL || '').toUpperCase() === 'N';
  return !optOut;
}

function locateInstallScript() {
  // The plugin's install script may be reachable either under
  // CLAUDE_PLUGIN_ROOT (when this code runs inside a Claude Code session) or
  // under the repo's plugin dir (when prevoyant-server runs locally).
  const candidates = [
    process.env.CLAUDE_PLUGIN_ROOT && path.join(process.env.CLAUDE_PLUGIN_ROOT, 'install', 'install-repowise.js'),
    path.join(__dirname, '..', '..', 'plugin', 'install', 'install-repowise.js'),
  ].filter(Boolean);
  return candidates.find(p => fs.existsSync(p)) || null;
}

// ── Public API ───────────────────────────────────────────────────────────────

function isInstalled() {
  return whichRepowise();
}

function getLastResult() {
  return lastResult ? { ...lastResult, completedAt: lastResultAt } : null;
}

function isInstalling() {
  return pendingPromise !== null;
}

/**
 * Ensure repowise is installed.  If already installed, returns immediately.
 * If an install is in flight, returns its promise.  Otherwise spawns the
 * installer in the background.
 *
 * @param {Object}  [opts]
 * @param {string}  [opts.trigger='auto']  - For activity event metadata.
 * @param {boolean} [opts.force=false]     - Run even if already installed.
 * @returns {Promise<{ok:boolean, summary:object, stdout:string, stderr:string}>}
 */
function ensureInstalled(opts = {}) {
  const trigger = opts.trigger || 'auto';
  const force   = !!opts.force;

  if (!force && isInstalled()) {
    return Promise.resolve({ ok: true, summary: { success: true, via: 'already-installed' }, stdout: '', stderr: '' });
  }
  if (pendingPromise) {
    return pendingPromise;
  }

  const script = locateInstallScript();
  if (!script) {
    return Promise.resolve({ ok: false, summary: { success: false, message: 'install-repowise.js not found' }, stdout: '', stderr: '' });
  }

  console.log(`[repowise-installer] Starting background install (trigger=${trigger}, script=${script})`);
  activityLog.record('repowise_install_started', null, 'system', { trigger });

  pendingPromise = new Promise((resolve) => {
    const startedAt = Date.now();
    let stdout = '', stderr = '';
    const child = spawn(process.execPath, [script, '--quiet'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env:   process.env,
    });
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });

    // Safety timeout — if the installer hangs (e.g. waiting for network),
    // kill after 15 minutes and treat as failed.
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch (_) {}
    }, 15 * 60_000);

    // Use 'close' (not 'exit') so we wait for all stdio streams to drain before
    // parsing stdout.  'exit' fires when the process exits; 'close' fires after
    // all piped I/O has been fully read.  The difference matters when the child
    // calls console.log() and then exits immediately — the pipe buffer may not
    // have been flushed to the parent by the time 'exit' fires.
    child.on('close', (code) => {
      clearTimeout(timer);
      pendingPromise = null;

      // Last JSON line is the installer's machine-readable summary.
      const lines   = stdout.trim().split('\n');
      const lastLine = lines.reverse().find(l => l.startsWith('{'));
      let summary = null;
      if (lastLine) { try { summary = JSON.parse(lastLine); } catch (_) {} }

      const ok = code === 0 && summary?.success === true;
      const durationMs = Date.now() - startedAt;

      // Cap retained output so a long-running server doesn't accumulate
      // megabytes of pip/pipx logs across repeated installs.  Full logs
      // were emitted to stdout live (via the installer's tryCmd) — what
      // we keep here is just for the dashboard last-install summary card.
      const STORED_OUT_CAP = 4 * 1024;  // 4 KB head, plenty for a summary
      const cappedStdout = stdout.length > STORED_OUT_CAP ? stdout.slice(-STORED_OUT_CAP) : stdout;
      const cappedStderr = stderr.length > STORED_OUT_CAP ? stderr.slice(-STORED_OUT_CAP) : stderr;
      lastResult   = { ok, summary, durationMs, exitCode: code, trigger, stdoutTail: cappedStdout, stderrTail: cappedStderr };
      lastResultAt = Date.now();

      if (ok) {
        activityLog.record('repowise_install_completed', null, 'system', {
          via:        summary?.via || null,
          durationMs,
          trigger,
        });
        console.log(`[repowise-installer] ✓ Install complete via ${summary?.via} in ${Math.round(durationMs/1000)}s`);
      } else {
        activityLog.record('repowise_install_failed', null, 'system', {
          message:    summary?.message || `exit code ${code}`,
          hint:       summary?.hint    || null,
          via:        summary?.via     || null,
          durationMs,
          trigger,
        });
        console.warn(`[repowise-installer] ✗ Install failed (code ${code}): ${summary?.message || 'unknown'}`);
        if (summary?.hint) console.warn(`[repowise-installer]   hint: ${summary.hint}`);
      }

      resolve({ ok, summary, stdout, stderr, durationMs, exitCode: code });
    });
  });

  return pendingPromise;
}

module.exports = {
  isInstalled,
  isInstalling,
  ensureInstalled,
  autoInstallEnabled,
  getLastResult,
};
