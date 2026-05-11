'use strict';

// Hermes polls GET /internal/jobs/recent-results to pick up completed Prevoyant
// jobs and deliver them to Telegram/Slack/Discord via its gateway.
// The Hermes skill runs this on a short interval (e.g. every 60 s).

const express = require('express');
const config  = require('../../../config/env');
const tracker = require('../../../dashboard/tracker');

const router = express.Router();

router.get('/', (req, res) => {
  const secret = req.headers['x-hermes-secret'] || req.query.token;
  if (config.hermesSecret && secret !== config.hermesSecret) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  // Default: return jobs completed in the last 5 minutes.
  // Hermes passes ?since=<iso> on each poll to avoid re-delivering old results.
  const sinceRaw = req.query.since;
  const since    = sinceRaw ? new Date(sinceRaw) : new Date(Date.now() - 5 * 60 * 1000);
  if (isNaN(since)) return res.status(400).json({ error: 'invalid since param — use ISO 8601' });

  const { tickets } = tracker.getStats();
  const results = tickets
    .filter(t => ['success', 'failed', 'interrupted'].includes(t.status))
    .filter(t => t.completedAt && new Date(t.completedAt) >= since)
    .map(t => ({
      ticket_key:   t.ticketKey,
      status:       t.status,
      mode:         t.mode     || 'dev',
      source:       t.source   || 'unknown',
      cost_usd:     t.tokenUsage?.actualCostUsd ?? t.tokenUsage?.costUsd ?? null,
      completed_at: t.completedAt,
    }));

  res.json({ results, polled_at: new Date().toISOString() });
});

module.exports = router;
