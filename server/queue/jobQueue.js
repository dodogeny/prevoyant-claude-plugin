'use strict';

const { runClaudeAnalysis } = require('../runner/claudeRunner');
const tracker = require('../stats/tracker');

const MAX_CONCURRENT = 1; // run one analysis at a time to avoid resource exhaustion
const queue = [];
let running = 0;

function enqueue(ticketKey) {
  queue.push(ticketKey);
  console.log(`[queue] Enqueued ${ticketKey} (depth: ${queue.length})`);
  drain();
}

function drain() {
  while (running < MAX_CONCURRENT && queue.length > 0) {
    const ticket = queue.shift();
    running++;
    tracker.recordStarted(ticket);
    console.log(`[queue] Starting ${ticket} (running: ${running}/${MAX_CONCURRENT})`);

    runClaudeAnalysis(ticket)
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
