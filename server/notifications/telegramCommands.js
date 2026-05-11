'use strict';

// Slash-command registry for inbound Telegram messages. Each handler receives
// (args, msg) and returns a string (HTML, gets sent back via Bot API sendMessage).
//
// Wiring intentionally mirrors `routes/enqueue.js` so the Telegram path produces
// the same observable side effects (jobQueue + tracker + activityLog) as Hermes.

const jobQueue    = require('../queue/jobQueue');
const tracker     = require('../dashboard/tracker');
const activityLog = require('../dashboard/activityLog');

const TICKET_RE = /^[A-Z][A-Z0-9_]*-\d+$/;

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function fmtDate(d) {
  if (!d) return null;
  const dt = d instanceof Date ? d : new Date(d);
  if (isNaN(dt)) return null;
  return dt.toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' });
}

function enqueueCmd(mode) {
  return (args, msg) => {
    const key = String(args[0] || '').toUpperCase();
    if (!key) return `<b>Usage:</b> /${mode} &lt;TICKET-KEY&gt;`;
    if (!TICKET_RE.test(key)) return `❌ Invalid ticket key: <code>${esc(key)}</code>`;
    const user = msg?.from?.username || msg?.from?.first_name || 'telegram';
    jobQueue.enqueue(key, mode, 'normal', { source: 'telegram', user });
    tracker.recordQueued(key, 'telegram', 'normal');
    activityLog.record('telegram_command', key, 'telegram', { command: mode, user });
    return `✅ <b>${esc(key)}</b> queued for <b>${mode}</b> mode`;
  };
}

function statusCmd(args) {
  const key = String(args[0] || '').toUpperCase();
  if (!key) return '<b>Usage:</b> /status &lt;TICKET-KEY&gt;';
  if (!TICKET_RE.test(key)) return `❌ Invalid ticket key: <code>${esc(key)}</code>`;
  const t = tracker.getTicket(key);
  if (!t) return `❓ No record of <code>${esc(key)}</code>`;
  const lines = [
    `<b>${esc(key)}</b> · ${esc(t.status || 'unknown')}`,
    t.mode      ? `mode: ${esc(t.mode)}`                   : null,
    t.source    ? `source: ${esc(t.source)}`               : null,
    t.queuedAt    ? `queued: ${esc(fmtDate(t.queuedAt))}`     : null,
    t.startedAt   ? `started: ${esc(fmtDate(t.startedAt))}`   : null,
    t.completedAt ? `completed: ${esc(fmtDate(t.completedAt))}` : null,
  ].filter(Boolean);
  return lines.join('\n');
}

function queueCmd() {
  const stats  = tracker.getStats();
  const active = (stats.tickets || []).filter(t =>
    ['queued', 'running', 'scheduled', 'retrying'].includes(t.status)
  );
  if (active.length === 0) return '✓ Queue is empty';
  const head  = active.slice(0, 15);
  const lines = [`<b>Active queue (${active.length}):</b>`];
  for (const t of head) {
    lines.push(`• <code>${esc(t.ticketKey)}</code> — ${esc(t.status)}${t.mode ? ' (' + esc(t.mode) + ')' : ''}`);
  }
  if (active.length > head.length) lines.push(`… and ${active.length - head.length} more`);
  return lines.join('\n');
}

function helpCmd() {
  return [
    '<b>Prevoyant — Telegram commands</b>',
    '',
    '/dev &lt;TICKET&gt; — analyse in dev mode',
    '/review &lt;TICKET&gt; — review the PR',
    '/estimate &lt;TICKET&gt; — story-point estimate',
    '/status &lt;TICKET&gt; — current state of a ticket',
    '/queue — list active + queued tickets',
    '/help — this message',
  ].join('\n');
}

const REGISTRY = {
  dev:      enqueueCmd('dev'),
  review:   enqueueCmd('review'),
  estimate: enqueueCmd('estimate'),
  status:   statusCmd,
  queue:    queueCmd,
  help:     helpCmd,
  start:    helpCmd, // Telegram's default /start when a chat is initiated
};

function dispatch(cmd, args, msg) {
  const fn = REGISTRY[cmd];
  if (!fn) return `❓ Unknown command <code>/${esc(cmd)}</code>. Try /help.`;
  try {
    return fn(args, msg);
  } catch (err) {
    return `❌ Command failed: ${esc(err.message)}`;
  }
}

function menu() {
  return [
    { command: 'dev',      description: 'Analyse a ticket — /dev PROJ-123' },
    { command: 'review',   description: 'Review a PR — /review PROJ-123' },
    { command: 'estimate', description: 'Estimate — /estimate PROJ-123' },
    { command: 'status',   description: 'Ticket state — /status PROJ-123' },
    { command: 'queue',    description: 'List active + queued tickets' },
    { command: 'help',     description: 'Show available commands' },
  ];
}

module.exports = { dispatch, menu };
