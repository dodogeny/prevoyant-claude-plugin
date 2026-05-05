'use strict';

// WhatsApp notifications via WaSenderAPI (https://wasenderapi.com).
// Uses Node's built-in https — zero new npm dependencies.
// Text messages: POST /api/send-message { to, messageType:'text', text }
// Documents:     POST /api/send-message { to, messageType:'document', documentUrl }
//   Documents must be served from a publicly reachable URL (PRX_WASENDER_PUBLIC_URL).

const https = require('https');

const BASE_HOST = 'www.wasenderapi.com';
const SEND_PATH = '/api/send-message';

function isEnabled() {
  return (process.env.PRX_WASENDER_ENABLED || 'N') === 'Y'
    && !!(process.env.PRX_WASENDER_API_KEY)
    && !!(process.env.PRX_WASENDER_TO);
}

function shouldSend(eventType) {
  if (!isEnabled()) return false;
  const raw = process.env.PRX_WASENDER_EVENTS || '';
  if (!raw.trim()) return true; // no filter = all events
  return raw.split(',').map(s => s.trim()).filter(Boolean).includes(eventType);
}

function post(payload) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(payload));
    const req  = https.request({
      hostname: BASE_HOST,
      path:     SEND_PATH,
      method:   'POST',
      headers:  {
        'Authorization': `Bearer ${process.env.PRX_WASENDER_API_KEY}`,
        'Content-Type':  'application/json',
        'Content-Length': body.length,
      },
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('WaSender timeout')); });
    req.write(body);
    req.end();
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

async function sendText(text) {
  return post({ to: process.env.PRX_WASENDER_TO, messageType: 'text', text })
    .catch(e => console.error('[whatsapp] sendText failed:', e.message));
}

async function sendDocument(documentUrl, caption) {
  const payload = { to: process.env.PRX_WASENDER_TO, messageType: 'document', documentUrl };
  if (caption) payload.text = caption;
  return post(payload)
    .catch(e => console.error('[whatsapp] sendDocument failed:', e.message));
}

// ── Event → message text ──────────────────────────────────────────────────────

const EVENT_TEXT = {
  ticket_queued:        (k)       => `📋 ${k} queued`,
  ticket_scheduled:     (k)       => `🕐 ${k} scheduled`,
  ticket_started:       (k)       => `▶️ ${k} started`,
  ticket_completed:     (k)       => `✅ ${k} complete`,
  ticket_failed:        (k)       => `❌ ${k} failed`,
  ticket_interrupted:   (k)       => `⏹ ${k} interrupted`,
  jira_assigned:        (k)       => `🎫 ${k} assigned to you`,
  poll_ran:             ()        => `🔄 Jira poll ran`,
  stage_dev_root_cause: (k)       => `🔍 ${k} root cause done`,
  stage_dev_fix:        (k)       => `🔧 ${k} fix proposed`,
  stage_dev_impact:     (k)       => `📊 ${k} impact analysis done`,
  stage_dev_report:     (k)       => `📄 ${k} dev report ready`,
  stage_review_panel:   (k)       => `👥 ${k} panel review done`,
  stage_review_report:  (k)       => `📄 ${k} review report ready`,
  stage_est_final:      (k, d)    => `🎯 ${k} estimate: ${d.points ?? '?'} pts`,
  stage_est_report:     (k)       => `📄 ${k} estimate report ready`,
  watch_poll_completed: (k, d) => {
    if (!d.emailed || !d.digest) return `👁 ${k} watch digest${d.emailed ? ' sent' : ' (unchanged)'}`;
    const header = `👁 *${k} — Watch Digest* (poll #${d.pollCount})\n\n`;
    const body   = d.digest.length > 4000 - header.length
      ? d.digest.slice(0, 4000 - header.length - 3) + '...'
      : d.digest;
    return header + body;
  },
  watch_poll_failed:    (k)       => `⚠️ ${k} watch poll failed`,
  watch_completed:      (k, d)    => `✔️ ${k} watch done (${d.totalPolls ?? '?'} polls)`,
};

function eventText(type, key, details) {
  const fn = EVENT_TEXT[type];
  return fn ? fn(key || '', details || {}) : null;
}

module.exports = { isEnabled, shouldSend, sendText, sendDocument, eventText };
