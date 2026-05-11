'use strict';

// Inbound Telegram listener — long-polls getUpdates and dispatches slash
// commands to the registry in ./telegramCommands.js.
//
// Auto-disabled when PRX_HERMES_ENABLED=Y: only one consumer can poll a bot
// at a time, and in Hermes mode Hermes owns the chat surface. This guard
// avoids the two paths flicker-stealing updates from each other.

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const tg       = require('./telegram');
const commands = require('./telegramCommands');

const STATE_FILE        = path.join(os.homedir(), '.prevoyant', 'telegram-state.json');
const POLL_TIMEOUT_SECS = 25;
const ERROR_BACKOFF_MS  = 5_000;

let running   = false;
let loopAlive = false;

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { lastUpdateId: 0 }; }
}

function saveState(state) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.warn('[telegram/listener] state save failed:', err.message);
  }
}

function isInboundEnabled() {
  const tgEnabled     = (process.env.PRX_TELEGRAM_ENABLED         || 'N') === 'Y';
  const inboundFlag   = (process.env.PRX_TELEGRAM_INBOUND_ENABLED || 'N') === 'Y';
  const hermesEnabled = (process.env.PRX_HERMES_ENABLED           || 'N') === 'Y';
  const hasToken      = !!process.env.PRX_TELEGRAM_BOT_TOKEN;
  const hasChat       = !!process.env.PRX_TELEGRAM_CHAT_ID;
  return tgEnabled && inboundFlag && hasToken && hasChat && !hermesEnabled;
}

function disabledReason() {
  if ((process.env.PRX_HERMES_ENABLED || 'N') === 'Y')           return 'hermes_enabled';
  if ((process.env.PRX_TELEGRAM_ENABLED || 'N') !== 'Y')         return 'telegram_disabled';
  if ((process.env.PRX_TELEGRAM_INBOUND_ENABLED || 'N') !== 'Y') return 'inbound_disabled';
  if (!process.env.PRX_TELEGRAM_BOT_TOKEN)                       return 'missing_token';
  if (!process.env.PRX_TELEGRAM_CHAT_ID)                         return 'missing_chat_id';
  return null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function handleUpdate(update) {
  const msg = update.message || update.channel_post;
  if (!msg || !msg.text) return;

  const allowedChatId = String(process.env.PRX_TELEGRAM_CHAT_ID || '').trim();
  const fromChatId    = String(msg.chat?.id || '');
  if (fromChatId !== allowedChatId) {
    console.log(`[telegram/listener] ignored message from chat ${fromChatId} (not in allowlist)`);
    return;
  }

  const text = String(msg.text).trim();
  if (!text.startsWith('/')) return; // only slash commands

  // Parse "/cmd@BotName arg1 arg2" → cmd="cmd", args=["arg1","arg2"]
  const parts = text.slice(1).split(/\s+/);
  const cmd   = parts[0].split('@')[0].toLowerCase();
  const args  = parts.slice(1);

  try {
    const reply = await commands.dispatch(cmd, args, msg);
    if (reply) await tg.sendText(reply, fromChatId);
  } catch (err) {
    console.error('[telegram/listener] dispatch crashed:', err.message);
    try { await tg.sendText(`❌ Internal error: ${err.message}`, fromChatId); } catch {}
  }
}

async function pollLoop() {
  loopAlive = true;
  const state = loadState();
  let offset = state.lastUpdateId ? state.lastUpdateId + 1 : 0;

  console.log(`[telegram/listener] Poll loop started (offset=${offset})`);
  while (running) {
    try {
      const updates = await tg.getUpdates(offset, POLL_TIMEOUT_SECS);
      for (const u of updates) {
        offset = Math.max(offset, u.update_id + 1);
        await handleUpdate(u);
      }
      if (updates.length > 0) saveState({ lastUpdateId: offset - 1 });
    } catch (err) {
      if (!running) break;
      console.warn('[telegram/listener] getUpdates error:', err.message);
      await sleep(ERROR_BACKOFF_MS);
    }
  }
  loopAlive = false;
  console.log('[telegram/listener] Poll loop exited');
}

function start() {
  if (running) {
    console.log('[telegram/listener] Already running');
    return { ok: true, reason: 'already_running' };
  }
  const reason = disabledReason();
  if (reason) {
    console.log(`[telegram/listener] Not starting — ${reason}`);
    return { ok: false, reason };
  }
  running = true;
  pollLoop().catch(err => {
    running = false;
    console.error('[telegram/listener] Loop crashed:', err);
  });
  // Fire-and-forget: register the slash-command menu so it appears in clients.
  tg.setMyCommands(commands.menu()).catch(err =>
    console.warn('[telegram/listener] setMyCommands failed:', err.message)
  );
  console.log('[telegram/listener] Inbound commands listener started');
  return { ok: true };
}

function stop() {
  if (!running) return { ok: true, reason: 'already_stopped' };
  running = false;
  console.log('[telegram/listener] Stop requested (loop will exit on next poll cycle)');
  return { ok: true };
}

function status() {
  return {
    running,
    loopAlive,
    enabled: isInboundEnabled(),
    disabledReason: disabledReason(),
    stateFile: STATE_FILE,
    lastUpdateId: loadState().lastUpdateId || 0,
  };
}

module.exports = { start, stop, status, isInboundEnabled };
