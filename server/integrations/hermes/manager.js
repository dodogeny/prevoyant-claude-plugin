'use strict';

// Hermes lifecycle manager — detects install, auto-installs if missing,
// deploys the Prevoyant skill, and starts the gateway daemon.
// All operations are idempotent.

const os   = require('os');
const fs   = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

const activityLog = require('../../dashboard/activityLog');

const IS_WINDOWS     = process.platform === 'win32';
const BIN_NAMES      = IS_WINDOWS ? ['hermes.exe', 'hermes.cmd', 'hermes.bat'] : ['hermes'];
const PATH_FINDER    = IS_WINDOWS ? 'where' : 'which';

const HERMES_DIR     = path.join(os.homedir(), '.hermes');
const SKILL_DIR      = path.join(HERMES_DIR, 'skills', 'prevoyant');
const SKILL_SRC      = path.join(__dirname, 'hermes-skill.md');
const GATEWAY_LOG    = path.join(HERMES_DIR, 'gateway.log');
const GATEWAY_PID_F  = path.join(HERMES_DIR, 'gateway.pid');
const GATEWAY_STATE  = path.join(HERMES_DIR, 'gateway_state.json');
const INSTALL_CMD    = IS_WINDOWS
  ? 'See https://github.com/NousResearch/hermes-agent for Windows install (manual; bash installer not supported)'
  : 'curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash';

// Common install locations Hermes may live in, by platform.
const INSTALL_DIRS = IS_WINDOWS
  ? [
      path.join(os.homedir(), '.hermes', 'bin'),
      path.join(os.homedir(), '.local', 'bin'),
      path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'hermes'),
      path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'hermes', 'bin'),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'hermes'),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'hermes', 'bin'),
    ]
  : [
      path.join(os.homedir(), '.local', 'bin'),
      path.join(os.homedir(), '.cargo', 'bin'),
      path.join(os.homedir(), '.hermes', 'bin'),
      '/usr/local/bin',
      '/opt/homebrew/bin',
    ];

// Extend PATH once so subsequent which/where/spawn calls find hermes.
function patchPath() {
  const cur = (process.env.PATH || '').split(path.delimiter);
  const extra = INSTALL_DIRS.filter(d => d && !cur.includes(d)).join(path.delimiter);
  if (extra) process.env.PATH = `${extra}${path.delimiter}${process.env.PATH || ''}`;
}
patchPath();

let installing = false;

// Resolves the hermes binary to a full path, or null if not found. Used by
// both isInstalled() and startGateway() so spawn() always sees a real path
// (avoids PATH-resolution flakiness on Windows where the cmd shell isn't used
// by default).
function findHermesBinary() {
  for (const dir of INSTALL_DIRS) {
    for (const name of BIN_NAMES) {
      const full = path.join(dir, name);
      try { if (fs.existsSync(full)) return full; } catch {}
    }
  }
  try {
    const out = execSync(`${PATH_FINDER} hermes`, { stdio: 'pipe', env: process.env })
      .toString().trim().split(/\r?\n/)[0];
    if (out && fs.existsSync(out)) return out;
  } catch {}
  return null;
}

function isInstalled() {
  return findHermesBinary() !== null;
}

function isSkillInstalled() {
  return fs.existsSync(path.join(SKILL_DIR, 'SKILL.md'));
}

function installSkill() {
  fs.mkdirSync(SKILL_DIR, { recursive: true });
  fs.copyFileSync(SKILL_SRC, path.join(SKILL_DIR, 'SKILL.md'));
  console.log(`[hermes/manager] Skill deployed → ${SKILL_DIR}/SKILL.md`);
}

// Read Hermes's own pid file (~/.hermes/gateway.pid). The actual daemon runs as
// `python -m hermes_cli.main gateway run`, which does NOT match `pgrep "hermes gateway"`,
// so this is the only reliable source of truth.
function readGatewayPidFile() {
  try {
    return JSON.parse(fs.readFileSync(GATEWAY_PID_F, 'utf8'));
  } catch {
    return null;
  }
}

function isPidAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try {
    process.kill(pid, 0); // signal 0 = liveness probe (no signal delivered)
    return true;
  } catch (err) {
    // EPERM means the process exists but we can't signal it → still "alive" for our purposes.
    return err.code === 'EPERM';
  }
}

function isGatewayRunning() {
  const meta = readGatewayPidFile();
  if (meta && isPidAlive(meta.pid)) return true;
  // Fallback for older Hermes versions that didn't write a pid file: match any
  // process whose argv mentions hermes_cli + gateway.
  try {
    const out = execSync('pgrep -f "hermes_cli.*gateway run"', { stdio: 'pipe' }).toString().trim();
    return out.length > 0;
  } catch {
    return false;
  }
}

function appendLog(line) {
  try {
    fs.mkdirSync(path.dirname(GATEWAY_LOG), { recursive: true });
    fs.appendFileSync(GATEWAY_LOG, `[${new Date().toISOString()}] ${line}\n`);
  } catch (err) {
    console.warn(`[hermes/manager] gateway-log write failed: ${err.message}`);
  }
}

function startGateway() {
  fs.mkdirSync(path.dirname(GATEWAY_LOG), { recursive: true });

  const bin = findHermesBinary();
  if (!bin) {
    appendLog('=== start failed — hermes binary not found on PATH ===');
    console.warn('[hermes/manager] Cannot start — hermes binary not found');
    return;
  }
  appendLog(`=== hermes gateway start (${bin}) ===`);

  const out = fs.openSync(GATEWAY_LOG, 'a');
  const err = fs.openSync(GATEWAY_LOG, 'a');
  const child = spawn(bin, ['gateway', 'start'], {
    detached:    true,
    stdio:       ['ignore', out, err],
    env:         process.env,
    windowsHide: true, // suppress the flash of a console window on Windows
  });
  child.unref();
  // The parent doesn't need its own copy of the fds — the child inherits them.
  try { fs.closeSync(out); fs.closeSync(err); } catch {}

  console.log(`[hermes/manager] Gateway spawned (detached) — ${bin} gateway start`);
  activityLog.record('hermes_gateway_started', null, 'system', {});
}

// Stops the gateway process without uninstalling Hermes. Prefer the canonical
// `hermes gateway stop` CLI; fall back to SIGTERM-ing the PID from gateway.pid.
function stopGateway() {
  if (!isGatewayRunning()) {
    console.log('[hermes/manager] Gateway not running — nothing to stop');
    appendLog('stop requested — gateway was not running');
    return;
  }
  // Preferred path: the CLI itself.
  const bin = findHermesBinary();
  if (bin) {
    try {
      execSync(`"${bin}" gateway stop`, { stdio: 'pipe', env: process.env, timeout: 8000, windowsHide: true });
      console.log('[hermes/manager] Gateway stopped (via `hermes gateway stop`)');
      appendLog('=== hermes gateway stopped ===');
      activityLog.record('hermes_gateway_stopped', null, 'system', {});
      return;
    } catch (err) {
      appendLog(`'hermes gateway stop' failed: ${err.message} — falling back to SIGTERM`);
    }
  } else {
    appendLog('hermes binary not found — falling back to SIGTERM');
  }
  // Fallback: signal the daemon directly using its own pid file.
  const meta = readGatewayPidFile();
  if (meta && meta.pid) {
    try {
      process.kill(meta.pid, 'SIGTERM');
      console.log(`[hermes/manager] Gateway stopped (SIGTERM → PID ${meta.pid})`);
      appendLog(`=== hermes gateway stopped (SIGTERM → PID ${meta.pid}) ===`);
      activityLog.record('hermes_gateway_stopped', null, 'system', {});
      return;
    } catch (err) {
      console.warn(`[hermes/manager] SIGTERM to PID ${meta.pid} failed: ${err.message}`);
      appendLog(`SIGTERM to PID ${meta.pid} failed: ${err.message}`);
    }
  }
  console.warn('[hermes/manager] Could not stop gateway — neither CLI nor pid-file fallback worked');
}

// Returns the tail of the gateway log file (last maxBytes, capped to maxLines).
function readGatewayLog(maxBytes = 200_000, maxLines = 400) {
  try {
    const stats = fs.statSync(GATEWAY_LOG);
    const start = Math.max(0, stats.size - maxBytes);
    const buf   = Buffer.alloc(stats.size - start);
    const fd    = fs.openSync(GATEWAY_LOG, 'r');
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);

    let text = buf.toString('utf8');
    if (start > 0) {
      const nl = text.indexOf('\n');
      if (nl >= 0) text = text.slice(nl + 1); // drop partial first line
    }
    const lines = text.split('\n');
    if (lines.length > maxLines) text = lines.slice(-maxLines).join('\n');
    return { exists: true, text, size: stats.size, mtime: stats.mtimeMs };
  } catch (err) {
    if (err.code === 'ENOENT') return { exists: false, text: '', size: 0, mtime: 0 };
    return { exists: false, text: `(read error: ${err.message})`, size: 0, mtime: 0 };
  }
}

// Runs the Hermes install script in the background (non-blocking).
// On success: deploys skill + starts gateway automatically.
// On Windows: bails out cleanly — the upstream installer is bash-only.
function autoInstall() {
  if (installing) {
    console.log('[hermes/manager] Auto-install already in progress');
    return;
  }
  if (IS_WINDOWS) {
    console.warn('[hermes/manager] Auto-install not supported on Windows — bash installer required.');
    console.warn('[hermes/manager] Install Hermes manually: see https://github.com/NousResearch/hermes-agent');
    appendLog('=== auto-install skipped: Windows is not supported by the upstream bash installer ===');
    appendLog('Install Hermes manually (WSL2 or native build) and then click Start Gateway.');
    activityLog.record('hermes_install_failed', null, 'system', { reason: 'windows_not_supported' });
    return;
  }
  installing = true;
  console.log('[hermes/manager] Hermes CLI not found — auto-installing in background …');
  console.log(`[hermes/manager] Running: ${INSTALL_CMD}`);
  activityLog.record('hermes_installing', null, 'system', {});

  const child = spawn('bash', ['-c', INSTALL_CMD], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env:   { ...process.env, HOME: os.homedir() },
  });

  child.stdout.on('data', d => process.stdout.write(`[hermes/install] ${d}`));
  child.stderr.on('data', d => process.stderr.write(`[hermes/install] ${d}`));

  child.on('close', code => {
    installing = false;
    if (code === 0) {
      patchPath(); // pick up any new dirs the installer added
      console.log('[hermes/manager] Hermes CLI installed successfully');
      if (isInstalled()) {
        activityLog.record('hermes_installed', null, 'system', {});
        installSkill();
        activityLog.record('hermes_skill_deployed', null, 'system', {});
        if (!isGatewayRunning()) startGateway();
      } else {
        console.warn('[hermes/manager] Install script exited 0 but binary not found — PATH may need reload');
        activityLog.record('hermes_install_failed', null, 'system', { reason: 'binary not found after install' });
      }
    } else {
      console.error(`[hermes/manager] Auto-install failed (exit ${code}). Install manually: ${INSTALL_CMD}`);
      activityLog.record('hermes_install_failed', null, 'system', { reason: `exit code ${code}` });
    }
  });

  child.on('error', err => {
    installing = false;
    console.error(`[hermes/manager] Auto-install error: ${err.message}`);
  });
}

// Returns a snapshot for the status API and settings UI.
function status() {
  const installed      = isInstalled();
  const gatewayRunning = installed && isGatewayRunning();
  const platform       = process.platform; // 'darwin' | 'linux' | 'win32'
  const autoInstallSupported = !IS_WINDOWS;
  const skillInstalled = installed && isSkillInstalled();
  return {
    installed,
    installing,
    gatewayRunning,
    skillInstalled,
    installCmd: INSTALL_CMD,
    platform,
    autoInstallSupported,
    binaryPath: installed ? findHermesBinary() : null,
  };
}

// Called on server startup and on settings save when PRX_HERMES_ENABLED=Y.
// Idempotent — safe to call multiple times.
function startup() {
  if (!isInstalled()) {
    autoInstall();
    return { ok: false, reason: 'installing' };
  }

  installSkill();

  if (isGatewayRunning()) {
    console.log('[hermes/manager] Gateway already running — skipping start');
  } else {
    startGateway();
  }

  return { ok: true };
}

module.exports = {
  isInstalled,
  isSkillInstalled,
  isGatewayRunning,
  installSkill,
  startGateway,
  stopGateway,
  autoInstall,
  startup,
  status,
  readGatewayLog,
  INSTALL_CMD,
  GATEWAY_LOG,
};
