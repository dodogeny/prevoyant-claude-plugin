'use strict';

const { spawn } = require('child_process');
const path = require('path');
const config = require('../config/env');

function runPollScript() {
  const scriptPath = path.join(config.scriptsDir, 'poll-jira.sh');
  console.log(`[prevoyant-server/poll] Running poll-jira.sh`);

  const proc = spawn('/bin/bash', [scriptPath], {
    cwd: config.projectRoot,
    env: process.env,
    stdio: 'inherit',
  });

  proc.on('close', code => {
    console.log(`[prevoyant-server/poll] poll-jira.sh exited with code ${code}`);
  });

  proc.on('error', err => {
    console.error(`[prevoyant-server/poll] Failed to run poll-jira.sh: ${err.message}`);
  });
}

function schedulePollScript(intervalDays) {
  const intervalMs = intervalDays * 24 * 60 * 60 * 1000;

  // Run once immediately on startup so there is no initial blind spot
  runPollScript();

  setInterval(runPollScript, intervalMs);
  console.log(`[prevoyant-server/poll] Polling every ${intervalDays} day(s)`);
}

module.exports = { schedulePollScript };
