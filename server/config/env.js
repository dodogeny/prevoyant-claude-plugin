'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

module.exports = {
  port: parseInt(process.env.WEBHOOK_PORT || '3000', 10),
  webhookSecret: process.env.WEBHOOK_SECRET || '',
  pollIntervalDays: parseFloat(process.env.WEBHOOK_POLL_INTERVAL_DAYS || '0'),
  hermesEnabled: process.env.PRX_HERMES_ENABLED === 'Y',
  hermesSecret: process.env.PRX_HERMES_SECRET || '',
  hermesGatewayUrl: process.env.PRX_HERMES_GATEWAY_URL || 'http://localhost:8080',
  hermesJiraWriteback: process.env.PRX_HERMES_JIRA_WRITEBACK === 'Y',
  // Tri-state: 'N' | 'AUTO' (default) | 'Y'. Anything unset → AUTO.
  hermesKbWriteback: (process.env.PRX_HERMES_KB_WRITEBACK_ENABLED || 'AUTO').toUpperCase() === 'N'
    ? 'N'
    : (process.env.PRX_HERMES_KB_WRITEBACK_ENABLED || 'AUTO').toUpperCase() === 'Y'
      ? 'Y'
      : 'AUTO',
  telegramEnabled: process.env.PRX_TELEGRAM_ENABLED === 'Y',
  telegramBotToken: process.env.PRX_TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.PRX_TELEGRAM_CHAT_ID || '',
  telegramEvents: process.env.PRX_TELEGRAM_EVENTS || '',
  telegramInboundEnabled: process.env.PRX_TELEGRAM_INBOUND_ENABLED === 'Y',
  jiraUsername: process.env.JIRA_USERNAME || process.env.JIRA_USER || '',
  jiraUrl: process.env.JIRA_URL || '',
  jiraToken: process.env.JIRA_API_TOKEN || process.env.JIRA_TOKEN || '',
  projectRoot: path.resolve(__dirname, '../..'),
  scriptsDir: path.resolve(__dirname, '../../scripts'),
  seenCacheFile: path.resolve(__dirname, '../../scripts/.jira-seen-tickets'),
  mcpConfigFile: path.resolve(__dirname, '../../.mcp.json'),
};
