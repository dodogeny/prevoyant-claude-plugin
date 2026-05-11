'use strict';

// Hermes lifecycle manager — detects install, deploys the Prevoyant skill,
// and starts the gateway daemon. All operations are idempotent.
//
// Strategy:
//   1. Detect:  `which hermes` — CLI must be installed manually (interactive installer).
//   2. Skill:   Copy hermes-skill.md → ~/.hermes/skills/prevoyant/SKILL.md (auto).
//   3. Gateway: spawn `hermes gateway start` detached (auto, if not already running).
//   4. Results: Hermes skill polls GET /internal/jobs/recent-results on this server.

const os   = require('os');
const fs   = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

const SKILL_DIR = path.join(os.homedir(), '.hermes', 'skills', 'prevoyant');
const SKILL_SRC = path.join(__dirname, 'hermes-skill.md');
const INSTALL_CMD = 'curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash';

function isInstalled() {
  try {
    execSync('which hermes', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
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
// Safe to call when PRX_HERMES_ENABLED is toggled to N.
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

// Returns a snapshot for the status API and settings UI.
function status() {
  const installed      = isInstalled();
  const gatewayRunning = installed && isGatewayRunning();
  const skillInstalled = installed && isSkillInstalled();
  return {
    installed,
    gatewayRunning,
    skillInstalled,
    installCmd: INSTALL_CMD,
  };
}

// Called on server startup and on settings save when PRX_HERMES_ENABLED=Y.
// Idempotent — safe to call multiple times.
function startup() {
  if (!isInstalled()) {
    console.warn('[hermes/manager] Hermes CLI not found.');
    console.warn(`[hermes/manager] Install with: ${INSTALL_CMD}`);
    return { ok: false, reason: 'not_installed' };
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
  startup,
  status,
  INSTALL_CMD,
};
