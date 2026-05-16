#!/usr/bin/env node
'use strict';

// Installs the `lmdb` npm package into the prevoyant server's node_modules.
//
// Usage:
//   node install-lmdb.js [--quiet]
//
// Called by:
//   • plugin/hooks/ensure-lmdb.sh (SessionStart when PRX_CORTEX_ENABLED=Y)
//   • server/scripts/ensure-lmdb.js via postinstall
//   • Manually for troubleshooting
//
// The server directory is resolved as a sibling of the plugin directory
// (i.e. <plugin-root>/../server).  If the server directory doesn't exist
// the script exits gracefully — it may be a hosted/cloud install where the
// server runs separately.
//
// Output: last line is JSON for machine-readable callers, readable text before
// that for human runs.  --quiet suppresses the readable text.

const { spawnSync } = require('child_process');
const path          = require('path');
const fs            = require('fs');

const QUIET = process.argv.includes('--quiet');

const BOLD   = '\x1b[1m';
const GREEN  = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN   = '\x1b[36m';
const RESET  = '\x1b[0m';

function log(msg)  { if (!QUIET) console.log(msg); }
function done(obj) { console.log(JSON.stringify(obj)); }

// Resolve server directory — <plugin-root>/../server
const PLUGIN_ROOT = path.resolve(__dirname, '..');
const SERVER_DIR  = path.resolve(PLUGIN_ROOT, '..', 'server');

if (!fs.existsSync(SERVER_DIR)) {
  log(`${YELLOW}  ⚠  Server directory not found at ${SERVER_DIR} — skipping lmdb install${RESET}`);
  done({ ok: false, skipped: 'no-server-dir', serverDir: SERVER_DIR });
  process.exit(0);
}

function isInstalled() {
  try {
    require.resolve('lmdb', { paths: [SERVER_DIR] });
    return true;
  } catch (_) {
    // Also check for the compiled native addon directly
    const nativeAddon = path.join(SERVER_DIR, 'node_modules', 'lmdb', 'build', 'Release');
    return fs.existsSync(nativeAddon);
  }
}

function getVersion() {
  try {
    const pkg = require(path.join(SERVER_DIR, 'node_modules', 'lmdb', 'package.json'));
    return pkg.version || null;
  } catch (_) { return null; }
}

function npmCmd() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

log(`\n${CYAN}[prevoyant] lmdb installer — CortexMemory storage engine${RESET}`);

if (isInstalled()) {
  const version = getVersion();
  log(`${GREEN}  ✓ lmdb already installed${version ? ' (' + version + ')' : ''}${RESET}\n`);
  done({ ok: true, skipped: 'already-installed', version });
  process.exit(0);
}

log(`  Installing lmdb (prebuilt binaries, no compilation)…`);

const result = spawnSync(
  npmCmd(),
  ['install', 'lmdb', '--save', '--prefer-offline'],
  {
    cwd:     SERVER_DIR,
    stdio:   QUIET ? 'pipe' : 'inherit',
    timeout: 120_000,
    shell:   process.platform === 'win32',
  }
);

const success = result.status === 0 && isInstalled();
const version = success ? getVersion() : null;

if (success) {
  log(`\n${GREEN}  ✓ lmdb installed successfully${version ? ' (' + version + ')' : ''}${RESET}`);
  log(`${BOLD}  CortexMemory will use LMDB on next server start.${RESET}\n`);
  done({ ok: true, version });
} else {
  const stderr = (result.stderr || '').toString().slice(-800);
  log(`\n${YELLOW}  ⚠  lmdb installation failed — CortexMemory will use JSONL fallback.${RESET}`);
  log(`${YELLOW}     Manual fix:  cd ${SERVER_DIR} && npm install lmdb${RESET}\n`);
  done({ ok: false, error: stderr || 'npm exited with status ' + result.status });
}

process.exit(0); // never exit non-zero — never block session start
