'use strict';

// Telegram notifications via Bot API — zero npm dependencies.
// POST https://api.telegram.org/bot{TOKEN}/sendMessage

const https = require('https');

function isEnabled() {
  return (process.env.PRX_TELEGRAM_ENABLED || 'N') === 'Y'
    && !!(process.env.PRX_TELEGRAM_BOT_TOKEN)
    && !!(process.env.PRX_TELEGRAM_CHAT_ID);
}

function shouldSend(eventType) {
  if (!isEnabled()) return false;
  const raw = (process.env.PRX_TELEGRAM_EVENTS || '').trim();
  if (!raw) return true; // no filter = all events
  return raw.split(',').map(s => s.trim()).filter(Boolean).includes(eventType);
}

function sendText(text) {
  const token  = process.env.PRX_TELEGRAM_BOT_TOKEN;
  const chatId = process.env.PRX_TELEGRAM_CHAT_ID;
  const body   = Buffer.from(JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }));

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.telegram.org',
      path:     `/bot${token}/sendMessage`,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': body.length },
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Telegram timeout')); });
    req.write(body);
    req.end();
  }).catch(e => console.error('[telegram] sendText failed:', e.message));
}

// ── Event → message text ──────────────────────────────────────────────────────

const EVENT_TEXT = {
  ticket_queued:        (k)    => `📋 <b>${k}</b> queued`,
  ticket_scheduled:     (k)    => `🕐 <b>${k}</b> scheduled`,
  ticket_started:       (k)    => `▶️ <b>${k}</b> started`,
  ticket_completed:     (k)    => `✅ <b>${k}</b> complete`,
  ticket_failed:        (k)    => `❌ <b>${k}</b> failed`,
  ticket_interrupted:   (k)    => `⏹ <b>${k}</b> interrupted`,
  jira_assigned:        (k)    => `🎫 <b>${k}</b> assigned to you`,
  poll_ran:             ()     => `🔄 Jira poll ran`,
  stage_dev_report:     (k)    => `📄 <b>${k}</b> dev report ready`,
  stage_review_report:  (k)    => `📄 <b>${k}</b> review report ready`,
  stage_est_report:     (k)    => `📄 <b>${k}</b> estimate report ready`,
  hermes_gateway_started: ()   => `🟢 Hermes gateway started`,
  hermes_gateway_stopped: ()   => `🔴 Hermes gateway stopped`,
  hermes_installed:       ()   => `✅ Hermes CLI installed`,
  hermes_install_failed:  (k, d) => `❌ Hermes install failed: ${d?.reason || 'unknown'}`,
};

function eventText(type, key, details) {
  const fn = EVENT_TEXT[type];
  return fn ? fn(key || '', details || {}) : null;
}

module.exports = { isEnabled, shouldSend, sendText, eventText };
