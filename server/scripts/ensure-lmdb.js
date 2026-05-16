#!/usr/bin/env node
'use strict';

// Installs the `lmdb` npm package into the server's own node_modules when it
// is not already present.  Called via `postinstall` in server/package.json so
// it runs automatically after `npm install` in the server directory.
//
// Also called by plugin/install/install-lmdb.js (which the SessionStart hook
// invokes) so users who never run `npm install` manually still get lmdb the
// first time they open Claude Code after enabling Cortex.
//
// Behaviour:
//   • Already installed → instant exit 0 (no npm invocation)
//   • Not installed     → runs `npm install lmdb --save` in the server dir
//   • Any failure       → logs a warning and exits 0 (never blocks startup)

const { spawnSync } = require('child_process');
const path          = require('path');
const fs            = require('fs');

const BOLD   = '\x1b[1m';
const CYAN   = '\x1b[36m';
const GREEN  = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RESET  = '\x1b[0m';

const SERVER_DIR = path.join(__dirname, '..');

function isInstalled() {
  try {
    require.resolve('lmdb', { paths: [SERVER_DIR] });
    return true;
  } catch (_) {
    return false;
  }
}

function npmCmd() {
  // On Windows, npm is npm.cmd; on Unix it's npm.
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

console.log(`\n${CYAN}[prevoyant] checking for lmdb (CortexMemory storage engine)…${RESET}`);

if (isInstalled()) {
  try {
    const pkg = require(path.join(SERVER_DIR, 'node_modules', 'lmdb', 'package.json'));
    console.log(`${GREEN}  ✓ lmdb already installed (${pkg.version || 'found'})${RESET}\n`);
  } catch (_) {
    console.log(`${GREEN}  ✓ lmdb already installed${RESET}\n`);
  }
  process.exit(0);
}

console.log(`  lmdb not found — installing (prebuilt binaries, no compilation needed)…\n`);

const result = spawnSync(
  npmCmd(),
  ['install', 'lmdb', '--save', '--prefer-offline'],
  {
    cwd:      SERVER_DIR,
    stdio:    'inherit',
    encoding: 'utf8',
    timeout:  120_000,
    shell:    process.platform === 'win32',
  }
);

if (result.status === 0 && isInstalled()) {
  try {
    const pkg = require(path.join(SERVER_DIR, 'node_modules', 'lmdb', 'package.json'));
    console.log(`\n${GREEN}  ✓ lmdb installed successfully (${pkg.version || 'done'})${RESET}\n`);
  } catch (_) {
    console.log(`\n${GREEN}  ✓ lmdb installed successfully${RESET}\n`);
  }
} else {
  console.log(`\n${YELLOW}  ⚠  lmdb installation failed — CortexMemory will fall back to JSONL storage.${RESET}`);
  console.log(`${YELLOW}     To install manually:  cd server && npm install lmdb${RESET}\n`);
  console.log(`${BOLD}  Cortex still works without lmdb — install it when convenient for better performance.${RESET}\n`);
}

process.exit(0); // never block npm install / server startup
