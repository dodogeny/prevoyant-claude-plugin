'use strict';

// Fires on every Prevoyant job lifecycle event when PRX_HERMES_ENABLED=Y.
// Responsibilities:
//   1. Push result to Hermes gateway (for Telegram/Slack/Discord delivery)
//   2. Post a Jira comment on the ticket (opt-in: PRX_HERMES_JIRA_WRITEBACK=Y)
//   3. Append outcome to ~/.hermes/prevoyant-memory.jsonl (Hermes memory sync)

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const os    = require('os');
const path  = require('path');

const MEMORY_FILE = path.join(os.homedir(), '.hermes', 'prevoyant-memory.jsonl');

// ── 1. Push to Hermes gateway ─────────────────────────────────────────────────

function postToHermes(gatewayUrl, payload) {
  let parsedUrl;
  try {
    parsedUrl = new URL('/prevoyant/result', gatewayUrl);
  } catch (err) {
    console.warn(`[hermes/notifier] Invalid gateway URL "${gatewayUrl}": ${err.message}`);
    return;
  }

  const body = JSON.stringify(payload);
  const mod  = parsedUrl.protocol === 'https:' ? https : http;

  const req = mod.request(
    {
      hostname: parsedUrl.hostname,
      port:     parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path:     parsedUrl.pathname,
      method:   'POST',
      headers:  {
        'Content-Type':       'application/json',
        'Content-Length':     Buffer.byteLength(body),
        'X-Prevoyant-Source': 'prevoyant-server',
      },
    },
    res => console.log(`[hermes/notifier] ${payload.ticket_key} → Hermes HTTP ${res.statusCode}`)
  );
  req.on('error', err =>
    console.warn(`[hermes/notifier] Gateway unreachable at ${gatewayUrl}: ${err.message}`)
  );
  req.write(body);
  req.end();
}

// ── 2. Jira write-back ────────────────────────────────────────────────────────

function postJiraComment(ticketKey, commentText) {
  const jiraUrl   = process.env.JIRA_URL   || '';
  const username  = process.env.JIRA_USERNAME || '';
  const token     = process.env.JIRA_API_TOKEN || process.env.JIRA_TOKEN || '';
  if (!jiraUrl || !username || !token) return;

  let parsedUrl;
  try {
    parsedUrl = new URL(`/rest/api/2/issue/${encodeURIComponent(ticketKey)}/comment`, jiraUrl);
  } catch { return; }

  const body = JSON.stringify({ body: commentText });
  const auth = Buffer.from(`${username}:${token}`).toString('base64');
  const mod  = parsedUrl.protocol === 'https:' ? https : http;

  const req = mod.request(
    {
      hostname: parsedUrl.hostname,
      port:     parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path:     parsedUrl.pathname + parsedUrl.search,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Authorization':  `Basic ${auth}`,
      },
    },
    res => console.log(`[hermes/notifier] Jira comment on ${ticketKey} → HTTP ${res.statusCode}`)
  );
  req.on('error', err =>
    console.warn(`[hermes/notifier] Jira write-back failed for ${ticketKey}: ${err.message}`)
  );
  req.write(body);
  req.end();
}

function buildJiraComment(ticketKey, status, mode, costUsd) {
  const emoji  = status === 'success' ? '✅' : status === 'failed' ? '❌' : '⚠️';
  const cost   = costUsd != null ? ` | cost: $${Number(costUsd).toFixed(3)}` : '';
  return `${emoji} *Prevoyant ${mode} analysis ${status}*${cost}\n_Automated analysis by Prevoyant v1.3.0 — see the dashboard for the full report._`;
}

// ── 3. Hermes memory sync ─────────────────────────────────────────────────────

function appendToHermesMemory(record) {
  try {
    fs.mkdirSync(path.dirname(MEMORY_FILE), { recursive: true });
    fs.appendFileSync(MEMORY_FILE, JSON.stringify(record) + '\n');
  } catch (err) {
    console.warn(`[hermes/notifier] Memory sync failed: ${err.message}`);
  }
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

function start(gatewayUrl) {
  const serverEvents      = require('../../serverEvents');
  const jiraWriteback     = process.env.PRX_HERMES_JIRA_WRITEBACK === 'Y';

  serverEvents.on('job-completed', ({ ticketKey, success, mode, costUsd }) => {
    const status = success ? 'success' : 'failed';
    const payload = { ticket_key: ticketKey, status, mode, cost_usd: costUsd, completed_at: new Date().toISOString() };

    postToHermes(gatewayUrl, payload);

    if (jiraWriteback) {
      postJiraComment(ticketKey, buildJiraComment(ticketKey, status, mode, costUsd));
    }

    appendToHermesMemory({ ...payload, type: 'prevoyant_result', recorded_at: new Date().toISOString() });
  });

  serverEvents.on('job-interrupted', ({ ticketKey, reason, mode }) => {
    const payload = { ticket_key: ticketKey, status: 'interrupted', reason, mode, completed_at: new Date().toISOString() };

    postToHermes(gatewayUrl, payload);

    appendToHermesMemory({ ...payload, type: 'prevoyant_result', recorded_at: new Date().toISOString() });
  });

  const writebackMsg = jiraWriteback ? ' + Jira write-back' : '';
  console.log(`[hermes/notifier] Active — gateway: ${gatewayUrl}${writebackMsg} + memory sync → ${MEMORY_FILE}`);
}

module.exports = { start };
