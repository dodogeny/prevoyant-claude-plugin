'use strict';

// Internal endpoint called by Hermes gateway when PRX_HERMES_ENABLED=Y.
// Hermes owns webhook reception and scheduling; this route is the handoff point
// into Prevoyant Server's job queue. Not exposed to Jira directly.

const express = require('express');
const config = require('../../../config/env');
const jobQueue = require('../../../queue/jobQueue');
const tracker = require('../../../dashboard/tracker');
const activityLog = require('../../../dashboard/activityLog');

const router = express.Router();

const EVENT_MODE_MAP = {
  'jira.status.in_progress': 'dev',
  'jira.issue_assigned':     'dev',
  'jira.issue_created':      'dev',
  'jira.pr.opened':          'review',
  'jira.ticket.stale':       'estimate',
};

router.post('/', (req, res) => {
  const secret = req.headers['x-hermes-secret'] || req.query.token;
  if (config.hermesSecret && secret !== config.hermesSecret) {
    console.warn('[hermes/enqueue] Rejected — invalid secret');
    return res.status(401).json({ error: 'unauthorized' });
  }

  const { event_type, ticket_key, mode, priority = 'normal', meta = {} } = req.body;

  if (!ticket_key) {
    return res.status(400).json({ error: 'missing ticket_key' });
  }

  const resolvedMode = mode || EVENT_MODE_MAP[event_type] || 'dev';

  jobQueue.enqueue(ticket_key, resolvedMode, priority, meta);
  tracker.recordQueued(ticket_key, 'hermes', priority);
  activityLog.record('hermes_enqueue', ticket_key, 'hermes', { event_type, mode: resolvedMode });

  console.log(`[hermes/enqueue] ${ticket_key} — queued for ${resolvedMode} (via ${event_type || 'direct'})`);
  res.json({ status: 'queued', ticket: ticket_key, mode: resolvedMode });
});

module.exports = router;
