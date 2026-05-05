#!/usr/bin/env node
'use strict';

// Checks for qpdf (needed for WhatsApp PDF encryption) and attempts a
// platform-appropriate install when it is missing. Never exits non-zero
// so that a missing qpdf does not abort `npm install`.

const { spawnSync } = require('child_process');
const os            = require('os');

const BOLD  = '\x1b[1m';
const CYAN  = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

function found(cmd) {
  const check = os.platform() === 'win32' ? 'where' : 'which';
  const r = spawnSync(check, [cmd], { stdio: 'ignore' });
  return r.status === 0;
}

function run(cmd, args) {
  console.log(`  → ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit' });
  return r.status === 0;
}

function printManualInstructions() {
  const platform = os.platform();
  console.log(`\n${YELLOW}  ┌─────────────────────────────────────────────────────────┐${RESET}`);
  console.log(`${YELLOW}  │  Install qpdf manually to enable PDF report encryption   │${RESET}`);
  console.log(`${YELLOW}  └─────────────────────────────────────────────────────────┘${RESET}`);

  if (platform === 'darwin') {
    console.log(`\n  ${BOLD}macOS (Homebrew):${RESET}`);
    console.log(`    brew install qpdf`);
    console.log(`\n  ${BOLD}macOS (without Homebrew — install Homebrew first):${RESET}`);
    console.log(`    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"`);
    console.log(`    brew install qpdf`);
  } else if (platform === 'linux') {
    console.log(`\n  ${BOLD}Debian / Ubuntu:${RESET}`);
    console.log(`    sudo apt-get install -y qpdf`);
    console.log(`\n  ${BOLD}RHEL / CentOS / Fedora:${RESET}`);
    console.log(`    sudo dnf install -y qpdf   # or: sudo yum install -y qpdf`);
  } else if (platform === 'win32') {
    console.log(`\n  ${BOLD}Windows (Chocolatey):${RESET}`);
    console.log(`    choco install qpdf`);
    console.log(`\n  ${BOLD}Windows (manual):${RESET}`);
    console.log(`    Download the installer from https://github.com/qpdf/qpdf/releases`);
    console.log(`    (grab the .msi or .exe for your architecture)`);
  }

  console.log(`\n  ${BOLD}Official releases (all platforms):${RESET}`);
  console.log(`    https://github.com/qpdf/qpdf/releases\n`);
  console.log(`  qpdf is only needed when PRX_WASENDER_PDF_PASSWORD is set.`);
  console.log(`  PDF reports are sent unencrypted until qpdf is installed.\n`);
}

// ── Main ───────────────────────────────────────────────────────────────────────

console.log(`\n${CYAN}[prevoyant] checking for qpdf (PDF encryption dependency)…${RESET}`);

if (found('qpdf')) {
  const v = spawnSync('qpdf', ['--version'], { encoding: 'utf8' });
  const version = (v.stdout || '').split('\n')[0].trim();
  console.log(`${GREEN}  ✓ qpdf found${version ? ': ' + version : ''}${RESET}\n`);
  process.exit(0);
}

console.log(`  qpdf not found — attempting install…\n`);

const platform = os.platform();
let installed  = false;

if (platform === 'darwin') {
  if (found('brew')) {
    installed = run('brew', ['install', 'qpdf']);
  } else {
    console.log(`  Homebrew not found — skipping auto-install.`);
  }
} else if (platform === 'linux') {
  if (found('apt-get')) {
    installed = run('apt-get', ['install', '-y', 'qpdf']);
  } else if (found('dnf')) {
    installed = run('dnf', ['install', '-y', 'qpdf']);
  } else if (found('yum')) {
    installed = run('yum', ['install', '-y', 'qpdf']);
  } else {
    console.log(`  No supported package manager found (apt-get / dnf / yum).`);
  }
} else {
  console.log(`  Auto-install not supported on ${platform}.`);
}

if (installed && found('qpdf')) {
  console.log(`\n${GREEN}  ✓ qpdf installed successfully${RESET}\n`);
} else {
  printManualInstructions();
}

process.exit(0); // never block npm install
