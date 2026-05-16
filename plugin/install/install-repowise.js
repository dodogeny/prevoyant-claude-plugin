#!/usr/bin/env node
'use strict';

// Cross-platform installer for repowise (https://github.com/repowise-dev/repowise).
//
// Repowise is a Python tool published on PyPI.  This script handles the install
// flow on macOS / Linux / Windows without assuming the user has a particular
// Python package manager.  Strategy:
//
//   1. If `repowise --version` already works → exit 0 (success, already installed).
//   2. Detect Python 3.11+.  If missing → emit clear platform-specific install
//      command and exit 1.  We do NOT attempt to install Python automatically
//      (requires sudo/admin on most systems; not safe to do silently).
//   3. If pipx is missing but Python is present → install pipx via
//      `python -m pip install --user pipx` (cheap, user-level, isolated).
//   4. Install repowise: prefer pipx → uv tool → pip --user (fallback ladder).
//   5. Verify by re-running `repowise --version`.
//
// Used by:
//   - Plugin SessionStart hook (`plugin/hooks/maybe-install-repowise.sh`) when
//     PRX_REPOWISE_ENABLED=Y (and PRX_REPOWISE_AUTO_INSTALL is not explicitly N).
//   - server/runner/repowiseInstaller.js — spawned by the prevoyant server in
//     the background as soon as cortex/repowise is enabled.
//   - The "Install repowise" button on /dashboard/cortex.
//
// Output: last line is JSON (machine-readable summary); readable text precedes
// for human runs.  --quiet suppresses readable output.

const { spawnSync, execSync } = require('child_process');
const os   = require('os');
const path = require('path');
const fs   = require('fs');

const QUIET = process.argv.includes('--quiet');

function say(...args) { if (!QUIET) console.log(...args); }

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
  say(`→ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    stdio:    QUIET ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'],
    timeout:  10 * 60_000,  // 10 min — pip install can be slow on cold caches
    ...opts,
  });
  return { ok: r.status === 0, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function detectPython() {
  for (const c of ['python3', 'python']) {
    const p = which(c);
    if (!p) continue;
    const r = spawnSync(c, ['--version'], { encoding: 'utf8' });
    const m = (r.stdout || r.stderr || '').match(/Python\s+(\d+)\.(\d+)(?:\.(\d+))?/);
    if (!m) continue;
    const major = parseInt(m[1], 10), minor = parseInt(m[2], 10);
    const version = `${major}.${minor}.${m[3] || 0}`;
    const ok      = (major === 3 && minor >= 11) || major > 3;
    return { cmd: c, version, supported: ok };
  }
  return null;
}

// Returns a platform-specific human-readable Python install hint.
function pythonInstallHint() {
  if (process.platform === 'darwin') {
    // Mac — prefer Homebrew, fall back to pyenv/python.org.
    if (which('brew')) return 'brew install python@3.12';
    return 'install Homebrew (https://brew.sh) then run: brew install python@3.12';
  }
  if (process.platform === 'win32') {
    if (which('winget'))      return 'winget install -e --id Python.Python.3.12';
    if (which('choco'))       return 'choco install python --version=3.12.0';
    return 'download the installer from https://www.python.org/downloads/ (check "Add to PATH")';
  }
  // Linux — sniff /etc/os-release.
  try {
    const text = fs.readFileSync('/etc/os-release', 'utf8');
    if (/ID(?:_LIKE)?=.*debian|ubuntu/i.test(text)) return 'sudo apt-get install -y python3 python3-pip python3-venv';
    if (/ID(?:_LIKE)?=.*fedora|rhel|centos/i.test(text)) return 'sudo dnf install -y python3 python3-pip';
    if (/ID(?:_LIKE)?=.*arch/i.test(text))           return 'sudo pacman -S python python-pip';
    if (/ID(?:_LIKE)?=.*alpine/i.test(text))         return 'sudo apk add python3 py3-pip';
    if (/ID(?:_LIKE)?=.*suse/i.test(text))           return 'sudo zypper install python3 python3-pip';
  } catch (_) {}
  return 'install Python 3.11+ via your distro\'s package manager (apt / dnf / pacman / apk / zypper)';
}

function emit(result) {
  // Last line is always machine-readable JSON.
  console.log('\n' + JSON.stringify(result));
}

(function main() {
  const summary = {
    platform: process.platform,
    arch:     process.arch,
    via:      null,
    success:  false,
    pythonInstalled: false,
    pipxInstalled:   false,
    message:  '',
    hint:     null,
  };

  say('═══════════════════════════════════════════════════');
  say('  repowise installer — Prevoyant Cortex layer');
  say('═══════════════════════════════════════════════════');
  say(`  Platform : ${summary.platform} (${summary.arch})`);
  say('');

  // ─── Step 1: already installed? ────────────────────────────────────────────
  // Check PATH first, then uv's tool bin dir (which may not be on the server's
  // PATH even though it's on the user's interactive shell PATH).
  let rwAbsPath = which('repowise');
  if (!rwAbsPath && which('uv')) {
    try {
      const uvBin = spawnSync('uv', ['tool', 'dir', '--bin'], { encoding: 'utf8', timeout: 5_000 });
      if (uvBin.status === 0 && uvBin.stdout.trim()) {
        const candidate = path.join(uvBin.stdout.trim(), 'repowise' + (process.platform === 'win32' ? '.exe' : ''));
        if (fs.existsSync(candidate)) rwAbsPath = candidate;
      }
    } catch (_) {}
  }
  if (rwAbsPath) {
    const v = spawnSync(rwAbsPath, ['--version'], { encoding: 'utf8' });
    summary.success  = true;
    summary.via      = 'already-installed';
    summary.message  = (v.stdout || v.stderr || '').trim() || 'repowise found';
    summary.absPath  = rwAbsPath;
    summary.pythonInstalled = true;
    say('✓ repowise is already installed — ' + summary.message);
    if (rwAbsPath !== 'repowise') say(`  path: ${rwAbsPath} (set PRX_REPOWISE_PATH if not on server PATH)`);
    return emit(summary);
  }

  // ─── Step 2: Python prerequisite ───────────────────────────────────────────
  const py = detectPython();
  if (!py) {
    summary.message = 'Python 3.11+ is required but not found on PATH.';
    summary.hint    = pythonInstallHint();
    say('✗ ' + summary.message);
    say('  → Install Python first: ' + summary.hint);
    say('    Then re-run this installer (or the "Install repowise" button on the Cortex page).');
    return emit(summary);
  }
  summary.pythonInstalled = true;
  say(`✓ Python found: ${py.cmd} (${py.version})${py.supported ? '' : ' — TOO OLD'}`);

  if (!py.supported) {
    summary.message = `Python ${py.version} is too old — repowise requires 3.11+.`;
    summary.hint    = pythonInstallHint();
    say('✗ ' + summary.message);
    say('  → Upgrade Python: ' + summary.hint);
    return emit(summary);
  }

  // ─── Step 3: pipx (preferred) ──────────────────────────────────────────────
  let havePipx = !!which('pipx');
  if (!havePipx) {
    say('  pipx not found — installing it (user-level, no sudo needed)…');
    // Use the detected python interpreter so we install pipx into the same env.
    const r = tryCmd(py.cmd, ['-m', 'pip', 'install', '--user', '--upgrade', 'pipx']);
    if (r.ok) {
      // After --user install, pipx is in `~/.local/bin` (POSIX) or
      // `%APPDATA%\Python\PythonXY\Scripts` (Windows).  Add to PATH for the
      // ensurepath step, which makes it permanent for future shells.
      tryCmd(py.cmd, ['-m', 'pipx', 'ensurepath']);
      havePipx = !!which('pipx');
      summary.pipxInstalled = havePipx;
      if (havePipx) say('✓ pipx installed and on PATH');
      else          say('⚠ pipx installed but not on PATH yet — will fall back to pip --user');
    } else {
      say('⚠ pipx install failed — falling back to uv or pip --user');
    }
  } else {
    summary.pipxInstalled = true;
  }

  // ─── Step 4: install repowise (preferred ladder) ───────────────────────────
  if (havePipx) {
    const r = tryCmd('pipx', ['install', 'repowise']);
    if (r.ok) {
      summary.success = true;
      summary.via     = 'pipx';
      summary.message = 'Installed via pipx';
      say('\n✓ Installed via pipx');
      return emit(summary);
    }
  }

  if (which('uv')) {
    const r = tryCmd('uv', ['tool', 'install', 'repowise']);
    if (r.ok) {
      // Resolve the absolute path so the caller can set PRX_REPOWISE_PATH if needed.
      let absPath = which('repowise');
      if (!absPath) {
        try {
          const uvBin = spawnSync('uv', ['tool', 'dir', '--bin'], { encoding: 'utf8', timeout: 5_000 });
          if (uvBin.status === 0) absPath = path.join(uvBin.stdout.trim(), 'repowise');
        } catch (_) {}
      }
      summary.success = true;
      summary.via     = 'uv';
      summary.absPath = absPath || null;
      summary.message = `Installed via uv tool${absPath ? ' (' + absPath + ')' : ''}`;
      say('\n✓ Installed via uv tool');
      if (absPath && absPath !== 'repowise') say(`  path: ${absPath} — set PRX_REPOWISE_PATH if not on server PATH`);
      return emit(summary);
    }
  }

  // pip --user fallback (always available if Python is present)
  const r = tryCmd(py.cmd, ['-m', 'pip', 'install', '--user', 'repowise']);
  if (r.ok) {
    summary.success = true;
    summary.via     = `${py.cmd} -m pip --user`;
    summary.message = 'Installed via pip --user.  You may need to add the pip user-install bin dir to PATH (~/.local/bin on macOS/Linux; %APPDATA%\\Python\\Scripts on Windows) — set PRX_REPOWISE_PATH to the absolute repowise binary path if it isn\'t picked up automatically.';
    say('\n✓ Installed via pip --user');
    say('  Note: ' + summary.message);
    return emit(summary);
  }

  // Fall-through — every install path failed.
  summary.success = false;
  summary.message = 'pipx / uv / pip install all failed — see logs above.';
  summary.hint    = `Try running manually: ${py.cmd} -m pip install --user repowise`;
  say('\n✗ ' + summary.message);
  emit(summary);
  // Use process.exitCode instead of process.exit() so the event loop drains
  // naturally and stdout is fully flushed before the process terminates.
  process.exitCode = 1;
})();
