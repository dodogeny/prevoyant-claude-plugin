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

function sendText(text, chatId) {
  const token = process.env.PRX_TELEGRAM_BOT_TOKEN;
  const dest  = chatId || process.env.PRX_TELEGRAM_CHAT_ID;
  const body  = Buffer.from(JSON.stringify({ chat_id: dest, text, parse_mode: 'HTML' }));

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

// Long-poll for inbound updates. Telegram allows up to 50s of long-poll wait;
// we use 25s by default so a stop() is observed within ~25s.
function getUpdates(offset = 0, timeoutSecs = 25) {
  const token = process.env.PRX_TELEGRAM_BOT_TOKEN;
  if (!token) return Promise.reject(new Error('PRX_TELEGRAM_BOT_TOKEN not set'));

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.telegram.org',
      path:     `/bot${token}/getUpdates?offset=${offset}&timeout=${timeoutSecs}&allowed_updates=${encodeURIComponent('["message","channel_post"]')}`,
      method:   'GET',
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (!j.ok) return reject(new Error(`Telegram API error: ${j.description || data}`));
          resolve(j.result || []);
        } catch (err) { reject(err); }
      });
    });
    req.on('error', reject);
    // Allow ~5s grace beyond Telegram's own timeout before we give up locally.
    req.setTimeout((timeoutSecs + 5) * 1000, () => { req.destroy(new Error('getUpdates timeout')); });
    req.end();
  });
}

// Registers the bot's slash-command menu (appears in Telegram clients).
function setMyCommands(commands) {
  const token = process.env.PRX_TELEGRAM_BOT_TOKEN;
  if (!token) return Promise.reject(new Error('PRX_TELEGRAM_BOT_TOKEN not set'));
  const body = Buffer.from(JSON.stringify({ commands }));
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.telegram.org',
      path:     `/bot${token}/setMyCommands`,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': body.length },
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('setMyCommands timeout')); });
    req.write(body);
    req.end();
  });
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

module.exports = { isEnabled, shouldSend, sendText, eventText, getUpdates, setMyCommands };
