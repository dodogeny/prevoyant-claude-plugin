'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

module.exports = {
  port: parseInt(process.env.WEBHOOK_PORT || '3000', 10),
  webhookSecret: process.env.WEBHOOK_SECRET || '',
  pollIntervalDays: parseFloat(process.env.WEBHOOK_POLL_INTERVAL_DAYS || '0'),
  jiraUsername: process.env.JIRA_USERNAME || process.env.JIRA_USER || '',
  jiraUrl: process.env.JIRA_URL || '',
  jiraToken: process.env.JIRA_API_TOKEN || process.env.JIRA_TOKEN || '',
  projectRoot: path.resolve(__dirname, '../..'),
  scriptsDir: path.resolve(__dirname, '../../scripts'),
  seenCacheFile: path.resolve(__dirname, '../../scripts/.jira-seen-tickets'),
  mcpConfigFile: path.resolve(__dirname, '../../.mcp.json'),
};
