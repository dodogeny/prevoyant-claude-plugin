'use strict';

const { runClaudeAnalysis } = require('../runner/claudeRunner');
const tracker = require('../stats/tracker');

const MAX_CONCURRENT = 1; // run one analysis at a time to avoid resource exhaustion
const queue = [];
let running = 0;

function enqueue(ticketKey, mode = 'dev') {
  queue.push({ ticketKey, mode });
  console.log(`[queue] Enqueued ${ticketKey} mode=${mode} (depth: ${queue.length})`);
  drain();
}

function drain() {
  while (running < MAX_CONCURRENT && queue.length > 0) {
    const { ticketKey: ticket, mode } = queue.shift();
    running++;
    tracker.recordStarted(ticket);
    console.log(`[queue] Starting ${ticket} mode=${mode} (running: ${running}/${MAX_CONCURRENT})`);

    runClaudeAnalysis(ticket, mode)
      .then(() => {
        tracker.recordCompleted(ticket, true);
        console.log(`[queue] ${ticket} complete`);
      })
      .catch(err => {
        tracker.recordCompleted(ticket, false);
        console.error(`[queue] ${ticket} failed: ${err.message}`);
      })
      .finally(() => {
        running--;
        drain();
      });
  }
}

module.exports = { enqueue };
