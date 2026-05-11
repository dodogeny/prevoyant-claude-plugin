'use strict';

// Hermes lifecycle manager — detects install, auto-installs if missing,
// deploys the Prevoyant skill, and starts the gateway daemon.
// All operations are idempotent.

const os   = require('os');
const fs   = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

const SKILL_DIR = path.join(os.homedir(), '.hermes', 'skills', 'prevoyant');
const SKILL_SRC = path.join(__dirname, 'hermes-skill.md');
const INSTALL_CMD = 'curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash';

// Common install locations the shell script may put the binary.
const INSTALL_DIRS = [
  path.join(os.homedir(), '.local', 'bin'),
  path.join(os.homedir(), '.cargo', 'bin'),
  path.join(os.homedir(), '.hermes', 'bin'),
  '/usr/local/bin',
  '/opt/homebrew/bin',
];

// Extend PATH once so subsequent which/spawn calls find hermes.
function patchPath() {
  const extra = INSTALL_DIRS
    .filter(d => !process.env.PATH.split(path.delimiter).includes(d))
    .join(path.delimiter);
  if (extra) process.env.PATH = `${extra}${path.delimiter}${process.env.PATH}`;
}
patchPath();

let installing = false;

function isInstalled() {
  try {
    execSync('which hermes', { stdio: 'pipe', env: process.env });
    return true;
  } catch {
    // Fallback: check binary exists in known dirs even if PATH not sourced yet.
    return INSTALL_DIRS.some(d => fs.existsSync(path.join(d, 'hermes')));
  }
}

function isSkillInstalled() {
  return fs.existsSync(path.join(SKILL_DIR, 'SKILL.md'));
}

function installSkill() {
  fs.mkdirSync(SKILL_DIR, { recursive: true });
  fs.copyFileSync(SKILL_SRC, path.join(SKILL_DIR, 'SKILL.md'));
  console.log(`[hermes/manager] Skill deployed → ${SKILL_DIR}/SKILL.md`);
}

function isGatewayRunning() {
  try {
    const out = execSync('pgrep -f "hermes gateway"', { stdio: 'pipe' }).toString().trim();
    return out.length > 0;
  } catch {
    return false;
  }
}

function startGateway() {
  const child = spawn('hermes', ['gateway', 'start'], {
    detached: true,
    stdio:    'ignore',
    env:      process.env,
  });
  child.unref();
  console.log('[hermes/manager] Gateway spawned (detached) — hermes gateway start');
}

// Stops the gateway process without uninstalling Hermes.
function stopGateway() {
  if (!isGatewayRunning()) {
    console.log('[hermes/manager] Gateway not running — nothing to stop');
    return;
  }
  try {
    execSync('pkill -f "hermes gateway"', { stdio: 'pipe' });
    console.log('[hermes/manager] Gateway stopped');
  } catch (err) {
    console.warn(`[hermes/manager] Could not stop gateway: ${err.message}`);
  }
}

// Runs the Hermes install script in the background (non-blocking).
// On success: deploys skill + starts gateway automatically.
function autoInstall() {
  if (installing) {
    console.log('[hermes/manager] Auto-install already in progress');
    return;
  }
  installing = true;
  console.log('[hermes/manager] Hermes CLI not found — auto-installing in background …');
  console.log(`[hermes/manager] Running: ${INSTALL_CMD}`);

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
        installSkill();
        if (!isGatewayRunning()) startGateway();
      } else {
        console.warn('[hermes/manager] Install script exited 0 but binary not found — PATH may need reload');
      }
    } else {
      console.error(`[hermes/manager] Auto-install failed (exit ${code}). Install manually: ${INSTALL_CMD}`);
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
  const skillInstalled = installed && isSkillInstalled();
  return {
    installed,
    installing,
    gatewayRunning,
    skillInstalled,
    installCmd: INSTALL_CMD,
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
  INSTALL_CMD,
};
