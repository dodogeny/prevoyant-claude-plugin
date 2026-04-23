'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { getStats, getTicket, reRunTicket } = require('./tracker');
const { killJob } = require('../queue/jobQueue');
const { enqueue } = require('../queue/jobQueue');
const { getPollStatus } = require('../runner/pollScheduler');

const VALID_MODES = new Set(['dev', 'review', 'estimate']);

const config = require('../config/env');

function isInSeenCache(ticketKey) {
  try {
    return fs.readFileSync(config.seenCacheFile, 'utf8')
      .split('\n')
      .some(l => l.trim() === ticketKey);
  } catch (_) {
    return false;
  }
}

function removeFromSeenCache(ticketKey) {
  try {
    const lines = fs.readFileSync(config.seenCacheFile, 'utf8').split('\n');
    fs.writeFileSync(
      config.seenCacheFile,
      lines.filter(l => l.trim() !== ticketKey).join('\n')
    );
  } catch (_) { /* file missing — nothing to remove */ }
}

const router = express.Router();

// Plugin metadata — read once at startup
let pluginVersion = '—';
let pluginDescription = 'Claude Code plugin for structured Jira-driven developer workflow.';
let pluginAuthor = 'dodogeny';
const GITHUB_URL = 'https://github.com/dodogeny/prevoyant-claude-plugin';
try {
  const meta = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '../../plugin/.claude-plugin/plugin.json'), 'utf8')
  );
  pluginVersion    = meta.version     || '—';
  pluginDescription = meta.description || pluginDescription;
  pluginAuthor     = (meta.author && meta.author.name) || pluginAuthor;
} catch (_) { /* non-fatal */ }

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatUptime(s) {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600),
        m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function fmt(date) {
  if (!date) return '—';
  return date.toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'medium' });
}

function dur(start, end) {
  if (!start) return '—';
  const ms = (end || new Date()) - start;
  const mins = Math.floor(ms / 60000), secs = Math.floor((ms % 60000) / 1000);
  return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
}

function fmtRelative(date) {
  if (!date) return null;
  const diffMs = date - Date.now();
  const abs    = Math.abs(diffMs);
  const past   = diffMs < 0;
  const mins   = Math.floor(abs / 60000);
  const hours  = Math.floor(abs / 3600000);
  const days   = Math.floor(abs / 86400000);
  let label;
  if (abs < 60000)         label = `${Math.floor(abs / 1000)}s`;
  else if (hours < 1)      label = `${mins}m`;
  else if (days < 1)       label = `${hours}h ${Math.floor((abs % 3600000) / 60000)}m`;
  else                     label = `${days}d ${Math.floor((abs % 86400000) / 3600000)}h`;
  return past ? `${label} ago` : `in ${label}`;
}

// ── Shared CSS ────────────────────────────────────────────────────────────────

const BASE_CSS = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, -apple-system, sans-serif; background: #f5f6f8; color: #1a1a2e; }
  header { background: #1a1a2e; color: #fff; padding: 1.1rem 2rem; display: flex; align-items: center; gap: 1.2rem; }
  header h1 { font-size: 1.3rem; font-weight: 700; letter-spacing: -0.02em; }
  .version-badge { background: #ffffff22; border: 1px solid #ffffff33; color: #a0a8c0;
                   font-size: 0.72rem; padding: 2px 8px; border-radius: 10px; font-weight: 500; }
  .meta { font-size: 0.8rem; color: #a0a8c0; flex: 1; }
  .meta span { margin-right: 1.2rem; }
  .refresh-note { display:inline-flex; align-items:center; gap:.45rem; background: #fff3cd33;
                  border: 1px solid #ffc10766; border-radius: 6px; padding: .3rem .6rem;
                  font-size: .75rem; color: #ffc107; white-space: nowrap; }
  .refresh-select { background:transparent; border:none; color:#ffc107; font-size:.75rem;
                    font-family:inherit; cursor:pointer; padding:0; outline:none;
                    appearance:none; -webkit-appearance:none; }
  .refresh-select option { background:#1a1a2e; color:#fff; }
  .badge { padding: 2px 9px; border-radius: 10px; font-size: 0.74rem; font-weight: 600; }
  .badge-queued  { background: #f3f4f6; color: #6b7280; }
  .badge-running { background: #dbeafe; color: #1d4ed8; }
  .badge-success { background: #dcfce7; color: #166534; }
  .badge-failed       { background: #fee2e2; color: #991b1b; }
  .badge-interrupted  { background: #fff7ed; color: #9a3412; }
  .mode-badge { padding: 2px 8px; border-radius: 8px; font-size: 0.72rem; font-weight: 600; }
  .mode-dev      { background: #e0f2fe; color: #0369a1; }
  .mode-review   { background: #f3e8ff; color: #7e22ce; }
  .mode-estimate { background: #fef3c7; color: #92400e; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .spin { animation: spin 0.9s linear infinite; transform-origin: center; display: block; }
  .footer { text-align: center; padding: 1.2rem; font-size: 0.72rem; color: #ccc; }
`;

// ── Icons ─────────────────────────────────────────────────────────────────────

const ICONS = {
  queued:  (n = 18) => `<svg xmlns="http://www.w3.org/2000/svg" width="${n}" height="${n}" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
  running: (n = 18) => `<svg class="spin" xmlns="http://www.w3.org/2000/svg" width="${n}" height="${n}" viewBox="0 0 24 24" fill="none" stroke="#0d6efd" stroke-width="2.5" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>`,
  success: (n = 18) => `<svg xmlns="http://www.w3.org/2000/svg" width="${n}" height="${n}" viewBox="0 0 24 24" fill="none" stroke="#198754" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`,
  failed:       (n = 18) => `<svg xmlns="http://www.w3.org/2000/svg" width="${n}" height="${n}" viewBox="0 0 24 24" fill="none" stroke="#dc3545" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`,
  interrupted:  (n = 18) => `<svg xmlns="http://www.w3.org/2000/svg" width="${n}" height="${n}" viewBox="0 0 24 24" fill="none" stroke="#ea580c" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`,
  skipped:      (n = 18) => `<svg xmlns="http://www.w3.org/2000/svg" width="${n}" height="${n}" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>`,
};

function sessionIconBadge(status) {
  const labels = { queued: 'Queued', running: 'Running', success: 'Done', failed: 'Failed', interrupted: 'Interrupted' };
  return `<span title="${labels[status] || status}" style="display:inline-flex;align-items:center;gap:6px">
    ${(ICONS[status] || ICONS.queued)(18)}<span class="badge badge-${status}">${labels[status] || status}</span>
  </span>`;
}

// Lightweight server-side Markdown → HTML for the output log.
// Handles fenced code blocks, headers, bold/italic, inline code, tables,
// blockquotes, HR, and unordered/ordered lists. Keeps it dependency-free.
function renderMarkdown(raw) {
  let s = raw;

  // Fenced code blocks (``` ... ```) — must come before inline-code pass
  s = s.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const escaped = code.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    return `<pre><code>${escaped}</code></pre>`;
  });

  // Escape remaining HTML (outside pre blocks) — replace per-segment
  const parts = s.split(/(<pre>[\s\S]*?<\/pre>)/g);
  s = parts.map((p, i) => i % 2 === 1 ? p :
    p.replace(/&(?!amp;|lt;|gt;|quot;)/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
  ).join('');

  // Horizontal rule
  s = s.replace(/^[-*]{3,}\s*$/gm, '<hr>');

  // ATX headings
  s = s.replace(/^#{4,6}\s+(.+)$/gm, '<h5>$1</h5>');
  s = s.replace(/^#{3}\s+(.+)$/gm, '<h4>$1</h4>');
  s = s.replace(/^#{2}\s+(.+)$/gm, '<h3>$1</h3>');
  s = s.replace(/^#{1}\s+(.+)$/gm, '<h2>$1</h2>');

  // Tables (simple: | col | col |)
  s = s.replace(/((?:^\|.+\|\s*\n?)+)/gm, tableBlock => {
    const rows = tableBlock.trim().split('\n').filter(r => r.trim());
    const isSep = r => /^\|[-| :]+\|$/.test(r.trim());
    let html = '<table>';
    let headerDone = false;
    for (const row of rows) {
      if (isSep(row)) { headerDone = true; continue; }
      const cells = row.replace(/^\||\|$/g,'').split('|').map(c => c.trim());
      const tag = !headerDone ? 'th' : 'td';
      html += '<tr>' + cells.map(c => `<${tag}>${c}</${tag}>`).join('') + '</tr>';
      if (!headerDone) headerDone = true;
    }
    return html + '</table>';
  });

  // Blockquotes
  s = s.replace(/^&gt;\s?(.*)$/gm, '<blockquote>$1</blockquote>');

  // Unordered lists
  s = s.replace(/((?:^[-*+]\s+.+\n?)+)/gm, block => {
    const items = block.trim().split('\n').map(l => `<li>${l.replace(/^[-*+]\s+/,'')}</li>`).join('');
    return `<ul>${items}</ul>`;
  });

  // Ordered lists
  s = s.replace(/((?:^\d+\.\s+.+\n?)+)/gm, block => {
    const items = block.trim().split('\n').map(l => `<li>${l.replace(/^\d+\.\s+/,'')}</li>`).join('');
    return `<ol>${items}</ol>`;
  });

  // Inline: bold, italic, inline code
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__(.+?)__/g, '<strong>$1</strong>');
  s = s.replace(/\*(.+?)\*/g, '<em>$1</em>');
  s = s.replace(/_(.+?)_/g, '<em>$1</em>');
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Paragraphs — wrap consecutive non-block lines in <p>
  s = s.replace(/^(?!<[a-z]|$)(.+)$/gm, (_, line) => `<p>${line}</p>`);

  return s;
}

function modeBadge(mode) {
  if (mode === 'dev')      return '<span class="mode-badge mode-dev">Dev</span>';
  if (mode === 'review')   return '<span class="mode-badge mode-review">Review</span>';
  if (mode === 'estimate') return '<span class="mode-badge mode-estimate">Estimate</span>';
  return '<span style="color:#ccc;font-size:0.82rem">—</span>';
}

// ── Token usage cell ──────────────────────────────────────────────────────────

function fmtTokens(n) {
  if (n == null) return '0';
  return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
}

function tokenCell(usage) {
  if (!usage) return '<span style="color:#ccc">—</span>';
  const { inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, costUsd, actualCostUsd } = usage;

  // Build cost line — prefer ccusage actual cost, fall back to stream-json estimate
  let costHtml = '';
  if (actualCostUsd != null) {
    costHtml = `<div style="display:flex;align-items:center;gap:5px">` +
      `<span style="font-size:.85rem;font-weight:700;color:#1a1a2e">$${actualCostUsd.toFixed(4)}</span>` +
      `<span style="font-size:.66rem;font-weight:600;padding:1px 5px;border-radius:4px;background:#dbeafe;color:#1d4ed8">ccusage</span>` +
      `</div>`;
    if (costUsd != null) {
      costHtml += `<div style="font-size:.72rem;color:#9ca3af">est. $${costUsd.toFixed(4)}</div>`;
    }
  } else if (costUsd != null) {
    costHtml = `<div style="font-size:.85rem;font-weight:700;color:#1a1a2e">$${costUsd.toFixed(4)}</div>`;
  }

  const cacheNote = cacheReadTokens > 0 ? ` · ${fmtTokens(cacheReadTokens)} cached` : '';
  const tooltipParts = [
    `Input: ${inputTokens.toLocaleString()}`,
    `Output: ${outputTokens.toLocaleString()}`,
    cacheReadTokens > 0 ? `Cache read: ${cacheReadTokens.toLocaleString()}` : '',
    actualCostUsd != null ? `ccusage cost: $${actualCostUsd.toFixed(6)}` : '',
    costUsd       != null ? `Stream est.: $${costUsd.toFixed(6)}`         : '',
  ].filter(Boolean).join(' · ');

  const tokensHtml = (inputTokens || outputTokens)
    ? `<div style="font-size:.74rem;color:#6b7280;white-space:nowrap">${fmtTokens(inputTokens)} in · ${fmtTokens(outputTokens)} out${cacheNote}</div>`
    : '';

  return `<div title="${tooltipParts}">${costHtml}${tokensHtml}</div>`;
}

// ── Report cell ───────────────────────────────────────────────────────────────

function reportCell(reportFiles) {
  if (!reportFiles || !reportFiles.length) return '<span style="color:#ccc">—</span>';
  return reportFiles.map(f => {
    const ext = path.extname(f).toUpperCase().replace('.', '');
    const base = path.basename(f);
    const enc = encodeURIComponent(f);
    return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;flex-wrap:wrap">
      <span style="font-family:monospace;font-size:0.78rem;color:#555;word-break:break-all">${base}</span>
      <a href="/dashboard/download?path=${enc}" class="dl-btn" title="Download ${base}">
        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
        ${ext}
      </a>
    </div>`;
  }).join('');
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

function renderDashboard(stats) {
  const counts = stats.tickets.reduce((acc, t) => { acc[t.status] = (acc[t.status] || 0) + 1; return acc; }, {});

  const rows = stats.tickets.map(t => {
    const isRunning = t.status === 'running' || t.status === 'queued';
    const currentMode = t.mode || 'dev';
    const playBtn = `
      <form method="POST" action="/dashboard/ticket/${encodeURIComponent(t.ticketKey)}/run"
            style="display:inline-flex;align-items:center;gap:6px" onsubmit="return confirmRun(this)">
        <select name="mode" class="mode-select" title="Mode">
          <option value="dev"${currentMode === 'dev' ? ' selected' : ''}>Dev</option>
          <option value="review"${currentMode === 'review' ? ' selected' : ''}>Review</option>
          <option value="estimate"${currentMode === 'estimate' ? ' selected' : ''}>Estimate</option>
        </select>
        <button type="submit" class="play-btn" title="Run this ticket" ${isRunning ? 'disabled' : ''}>
          <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24"
               fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        </button>
      </form>`;
    return `
    <tr class="${isRunning ? 'row-running' : ''}">
      <td><a href="/dashboard/ticket/${encodeURIComponent(t.ticketKey)}" class="ticket-link">${t.ticketKey}</a></td>
      <td>${modeBadge(t.mode)}</td>
      <td><span class="source-tag ${t.source === 'disk' ? 'source-disk' : ''}">${t.source}</span></td>
      <td>${sessionIconBadge(t.status)}</td>
      <td style="font-size:0.82rem;color:#555">${fmt(t.queuedAt)}</td>
      <td style="font-size:0.82rem;color:#555">${fmt(t.completedAt)}</td>
      <td style="font-size:0.82rem;color:#555">${dur(t.startedAt, t.completedAt)}</td>
      <td>${tokenCell(t.tokenUsage)}</td>
      <td>${reportCell(t.reportFiles)}</td>
      <td style="display:flex;align-items:center;gap:6px">
        ${playBtn}
        ${isRunning ? `
        <form method="POST" action="/dashboard/ticket/${encodeURIComponent(t.ticketKey)}/stop"
              style="display:inline" onsubmit="return confirm('Stop this job?')">
          <button type="submit" class="stop-btn" title="Stop this job">
            <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24"
                 fill="currentColor"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>
          </button>
        </form>` : ''}
      </td>
    </tr>`;
  }).join('');

  const emptyRow = `<tr><td colspan="10" style="text-align:center;color:#bbb;padding:2.5rem;font-size:0.9rem">No tickets yet — waiting for Jira events.</td></tr>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Prevoyant Server — Dashboard</title>
  <style>
    ${BASE_CSS}
    .info-strip { display:flex; align-items:stretch; padding:0 2rem; background:#fff;
                  border-bottom:1px solid #e5e7eb; box-shadow:0 1px 4px rgba(0,0,0,.05); flex-wrap:wrap; }
    .info-item { display:flex; align-items:center; gap:.65rem; padding:.85rem 1.6rem;
                 border-right:1px solid #f0f1f3; flex-shrink:0; }
    .info-item:first-child { padding-left:0; }
    .info-item:last-child  { border-right:none; }
    .info-icon { color:#c4c9d4; flex-shrink:0; }
    .info-text { display:flex; flex-direction:column; gap:2px; }
    .info-lbl { font-size:0.64rem; color:#b0b7c3; text-transform:uppercase; letter-spacing:.09em; font-weight:700; }
    .info-val { font-size:0.82rem; color:#1a1a2e; font-weight:600; white-space:nowrap; }
    .info-val.muted  { color:#b0b7c3; font-weight:500; }
    .info-val.ok     { color:#166534; }
    .info-val.warn   { color:#92400e; }
    .cards { display:flex; gap:1rem; padding:1.5rem 2rem 0; flex-wrap:wrap; }
    .card { background:#fff; border-radius:10px; padding:.9rem 1.3rem; flex:1; min-width:90px;
            box-shadow:0 1px 3px rgba(0,0,0,.08); }
    .card .num { font-size:1.9rem; font-weight:700; line-height:1; }
    .card .lbl { font-size:0.72rem; color:#999; margin-top:4px; text-transform:uppercase; letter-spacing:.06em; }
    .card.success .num { color:#198754; } .card.failed .num { color:#dc3545; } .card.running .num { color:#0d6efd; }
    .section { margin:1.5rem 2rem 2rem; }
    .section h2 { font-size:0.8rem; color:#888; text-transform:uppercase; letter-spacing:.07em; margin-bottom:.75rem; }
    table { width:100%; border-collapse:collapse; background:#fff; border-radius:10px; overflow:hidden;
            box-shadow:0 1px 3px rgba(0,0,0,.08); }
    th { background:#f0f1f5; text-align:left; padding:.6rem 1rem; font-size:.72rem;
         text-transform:uppercase; letter-spacing:.06em; color:#777; font-weight:600; }
    td { padding:.75rem 1rem; border-top:1px solid #f2f2f5; vertical-align:middle; }
    tr:hover td { background:#fafafa; } tr.row-running td { background:#eff6ff; }
    .ticket-link { font-weight:700; font-size:0.95rem; color:#1a1a2e; text-decoration:none;
                   border-bottom:2px solid #0d6efd44; transition:border-color .15s; }
    .ticket-link:hover { border-bottom-color:#0d6efd; color:#0d6efd; }
    .source-tag  { font-size:0.75rem; color:#888; background:#f3f4f6; padding:2px 7px; border-radius:6px; }
    .source-disk { background:#fef9c3; color:#854d0e; }
    .dl-btn { display:inline-flex; align-items:center; gap:4px; padding:3px 9px; background:#1a1a2e;
              color:#fff; border-radius:6px; font-size:0.72rem; text-decoration:none; font-weight:500; transition:background .15s; }
    .dl-btn:hover { background:#2d3a5e; }
    .mode-select { font-size:0.72rem; padding:3px 5px; border:1px solid #d1d5db; border-radius:6px;
                   background:#fff; color:#374151; cursor:pointer; }
    .play-btn { display:inline-flex; align-items:center; justify-content:center; width:28px; height:28px;
                background:#16a34a; color:#fff; border:none; border-radius:6px; cursor:pointer; transition:background .15s; }
    .play-btn:hover:not([disabled]) { background:#15803d; }
    .play-btn[disabled] { background:#d1d5db; color:#9ca3af; cursor:not-allowed; }
    .stop-btn { display:inline-flex; align-items:center; justify-content:center; width:28px; height:28px;
                background:#dc2626; color:#fff; border:none; border-radius:6px; cursor:pointer; transition:background .15s; }
    .stop-btn:hover { background:#b91c1c; }
    .settings-link { display:inline-flex; align-items:center; gap:.4rem; color:#a0a8c0;
                     text-decoration:none; font-size:.8rem; padding:.3rem .7rem; border-radius:7px;
                     border:1px solid #ffffff22; transition:background .15s,color .15s; white-space:nowrap; }
    .settings-link:hover { background:#ffffff15; color:#fff; }
    .header-btn { display:inline-flex; align-items:center; gap:.4rem; color:#a0a8c0; background:none;
                  font-size:.8rem; padding:.3rem .7rem; border-radius:7px; border:1px solid #ffffff22;
                  cursor:pointer; transition:background .15s,color .15s; white-space:nowrap; font-family:inherit; }
    .header-btn:hover { background:#ffffff15; color:#fff; }
    .header-btn.icon-only { padding:.3rem .5rem; }
    .modal-overlay { position:fixed; inset:0; background:rgba(0,0,0,.45); display:none;
                     align-items:center; justify-content:center; z-index:900; padding:1rem; }
    .modal-overlay.open { display:flex; }
    .modal { background:#fff; border-radius:14px; padding:1.6rem 1.8rem; width:100%; max-width:420px;
             box-shadow:0 24px 64px rgba(0,0,0,.22); animation:modalIn .15s ease; }
    @keyframes modalIn { from { opacity:0; transform:scale(.96) translateY(6px); } to { opacity:1; transform:none; } }
    .modal-header { display:flex; align-items:center; justify-content:space-between; margin-bottom:1.2rem; }
    .modal-title  { font-size:1rem; font-weight:700; color:#1a1a2e; }
    .modal-close  { background:none; border:none; cursor:pointer; color:#9ca3af; padding:.2rem;
                    border-radius:5px; display:flex; align-items:center; transition:color .15s; }
    .modal-close:hover { color:#1a1a2e; }
    .modal-field  { display:flex; flex-direction:column; gap:.35rem; margin-bottom:1rem; }
    .modal-label  { font-size:.8rem; font-weight:600; color:#374151; }
    .modal-input  { padding:.5rem .75rem; border:1px solid #d1d5db; border-radius:8px;
                    font-size:.9rem; color:#1a1a2e; font-family:inherit; transition:border-color .15s; }
    .modal-input:focus { outline:none; border-color:#0d6efd; box-shadow:0 0 0 3px #0d6efd18; }
    .modal-select { padding:.5rem .75rem; border:1px solid #d1d5db; border-radius:8px;
                    font-size:.9rem; color:#1a1a2e; font-family:inherit; background:#fff; cursor:pointer; }
    .modal-actions { display:flex; gap:.65rem; margin-top:1.4rem; justify-content:flex-end; }
    .modal-btn-primary { padding:.5rem 1.2rem; background:#1a1a2e; color:#fff; border:none;
                         border-radius:8px; font-size:.88rem; font-weight:600; cursor:pointer; transition:background .15s; }
    .modal-btn-primary:hover { background:#2d3a5e; }
    .modal-btn-cancel  { padding:.5rem 1rem; background:none; border:1px solid #d1d5db; color:#6b7280;
                         border-radius:8px; font-size:.88rem; cursor:pointer; transition:border-color .15s; font-family:inherit; }
    .modal-btn-cancel:hover { border-color:#9ca3af; color:#374151; }
    .info-desc  { font-size:.88rem; color:#4b5563; line-height:1.6; margin-bottom:1rem; }
    .info-row   { display:flex; align-items:center; gap:.6rem; font-size:.82rem; color:#374151;
                  padding:.45rem 0; border-top:1px solid #f3f4f6; }
    .info-row svg { flex-shrink:0; color:#9ca3af; }
    .info-row a  { color:#0d6efd; text-decoration:none; font-weight:500; }
    .info-row a:hover { text-decoration:underline; }
    .info-modes { display:flex; gap:.5rem; flex-wrap:wrap; margin:.8rem 0 .4rem; }
    .info-mode-pill { font-size:.76rem; font-weight:600; padding:3px 10px; border-radius:20px; }
  </style>
</head>
<body>
  <header>
    <h1>Prevoyant Server</h1>
    <span class="version-badge">v${pluginVersion}</span>
    <div class="meta"></div>
    <button type="button" class="header-btn" onclick="openModal('add-ticket-modal')">
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      Add Ticket
    </button>
    <button type="button" class="header-btn icon-only" title="About Prevoyant" onclick="openModal('info-modal')">
      <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
    </button>
    <a href="/dashboard/settings" class="settings-link">
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
      Settings
    </a>
    <div class="refresh-note">
      <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
      Refresh every
      <select class="refresh-select" id="refresh-select" onchange="setRefreshInterval(this.value)">
        <option value="5">5s</option>
        <option value="30" selected>30s</option>
        <option value="60">1 min</option>
        <option value="180">3 min</option>
        <option value="300">5 min</option>
        <option value="600">10 min</option>
      </select>
    </div>
  </header>

  ${(() => {
    const ps = getPollStatus();
    let pollingVal, pollingClass, startupVal, startupClass;
    if (ps.enabled) {
      const next = ps.nextRunAt ? fmtRelative(ps.nextRunAt) : '—';
      const last = ps.lastRanAt ? fmtRelative(ps.lastRanAt) : 'never';
      pollingVal = `<span title="Last ran: ${last}">Every ${ps.intervalDays}d &middot; next ${next}</span>`;
      pollingClass = 'ok';
    } else {
      pollingVal = 'Disabled';
      pollingClass = 'muted';
    }
    if (ps.fallbackRanAt) {
      startupVal = fmtRelative(ps.fallbackRanAt);
      startupClass = 'ok';
    } else {
      startupVal = '—';
      startupClass = 'muted';
    }
    return `
  <div class="info-strip">
    <div class="info-item">
      <svg class="info-icon" xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
      <div class="info-text">
        <span class="info-lbl">Uptime</span>
        <span class="info-val">${formatUptime(stats.uptimeSeconds)}</span>
      </div>
    </div>
    <div class="info-item">
      <svg class="info-icon" xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
      <div class="info-text">
        <span class="info-lbl">Started</span>
        <span class="info-val">${fmt(stats.serverStartedAt)}</span>
      </div>
    </div>
    <div class="info-item">
      <svg class="info-icon" xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
      <div class="info-text">
        <span class="info-lbl">Reports</span>
        <span class="info-val" title="${stats.reportsDir}" style="max-width:260px;overflow:hidden;text-overflow:ellipsis">${stats.reportsDir}</span>
      </div>
    </div>
    <div class="info-item">
      <svg class="info-icon" xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
      <div class="info-text">
        <span class="info-lbl">Polling</span>
        <span class="info-val ${pollingClass}">${pollingVal}</span>
      </div>
    </div>
    <div class="info-item">
      <svg class="info-icon" xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
      <div class="info-text">
        <span class="info-lbl">Startup Scan</span>
        <span class="info-val ${startupClass}">${startupVal}</span>
      </div>
    </div>
  </div>`;
  })()}

  <div class="cards">
    <div class="card"><div class="num">${stats.tickets.length}</div><div class="lbl">Total</div></div>
    <div class="card running"><div class="num">${counts.running || 0}</div><div class="lbl">Running</div></div>
    <div class="card success"><div class="num">${counts.success || 0}</div><div class="lbl">Succeeded</div></div>
    <div class="card failed"><div class="num">${counts.failed || 0}</div><div class="lbl">Failed</div></div>
    <div class="card"><div class="num">${counts.queued || 0}</div><div class="lbl">Queued</div></div>
  </div>

  <div class="section">
    <h2>Processed Tickets <span style="font-weight:400;color:#aaa;font-size:0.72rem;text-transform:none;letter-spacing:0">(includes reports found in ${stats.reportsDir})</span></h2>
    <table>
      <thead>
        <tr>
          <th>Ticket</th><th>Type</th><th>Source</th><th>Session</th>
          <th>Queued at</th><th>Completed at</th><th>Duration</th><th>Tokens</th><th>Report</th><th>Run</th>
        </tr>
      </thead>
      <tbody>${stats.tickets.length ? rows : emptyRow}</tbody>
    </table>
  </div>

  <div class="footer">Prevoyant Server v${pluginVersion} &mdash; Dashboard &mdash; ${new Date().toLocaleString('en-GB')}</div>

  <!-- Add Ticket Modal -->
  <div class="modal-overlay" id="add-ticket-modal" onclick="overlayClick(event,'add-ticket-modal')">
    <div class="modal">
      <div class="modal-header">
        <span class="modal-title">Add Ticket to Queue</span>
        <button class="modal-close" onclick="closeModal('add-ticket-modal')" title="Close">
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div class="modal-field">
        <label class="modal-label" for="modal-ticket-key">Jira Ticket Key</label>
        <input type="text" id="modal-ticket-key" class="modal-input" placeholder="e.g. IV-1234"
               autocomplete="off" spellcheck="false" style="text-transform:uppercase"
               onkeydown="if(event.key==='Enter')submitAddTicket()">
        <span id="modal-key-err" style="font-size:.76rem;color:#dc2626;display:none">Please enter a ticket key.</span>
      </div>
      <div class="modal-field">
        <label class="modal-label" for="modal-ticket-mode">Mode</label>
        <select id="modal-ticket-mode" class="modal-select">
          <option value="dev">Dev</option>
          <option value="review">Review</option>
          <option value="estimate">Estimate</option>
        </select>
      </div>
      <div class="modal-actions">
        <button type="button" class="modal-btn-cancel" onclick="closeModal('add-ticket-modal')">Cancel</button>
        <button type="button" class="modal-btn-primary" onclick="submitAddTicket()">Add to Queue</button>
      </div>
    </div>
  </div>

  <!-- Info Modal -->
  <div class="modal-overlay" id="info-modal" onclick="overlayClick(event,'info-modal')">
    <div class="modal" style="max-width:460px">
      <div class="modal-header">
        <span class="modal-title">Prevoyant</span>
        <button class="modal-close" onclick="closeModal('info-modal')" title="Close">
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <p class="info-desc">${pluginDescription}</p>
      <div class="info-modes">
        <span class="info-mode-pill mode-dev">Dev</span>
        <span class="info-mode-pill mode-review">Review</span>
        <span class="info-mode-pill mode-estimate">Estimate</span>
      </div>
      <div class="info-row">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
        Version <strong>v${pluginVersion}</strong>
      </div>
      <div class="info-row">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"/></svg>
        <a href="${GITHUB_URL}" target="_blank" rel="noopener">${GITHUB_URL}</a>
      </div>
      <div class="info-row">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
        Author: <strong>${pluginAuthor}</strong>
      </div>
      <div class="modal-actions" style="margin-top:1rem">
        <button type="button" class="modal-btn-cancel" onclick="closeModal('info-modal')">Close</button>
      </div>
    </div>
  </div>

  <script>
    function confirmRun(form) {
      const key  = form.action.split('/ticket/')[1].split('/run')[0];
      const mode = form.querySelector('select[name=mode]').value;
      return confirm('Run ' + decodeURIComponent(key) + ' in ' + mode + ' mode?');
    }

    // ── Auto-refresh ──────────────────────────────────────────────────────────
    const REFRESH_KEY = 'prv_dashboard_refresh';
    let refreshTimer = null;

    function setRefreshInterval(seconds) {
      const s = parseInt(seconds, 10);
      localStorage.setItem(REFRESH_KEY, s);
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => location.reload(), s * 1000);
    }

    (function initRefresh() {
      const saved = parseInt(localStorage.getItem(REFRESH_KEY) || '30', 10);
      const sel = document.getElementById('refresh-select');
      // Apply saved preference to the dropdown (find closest option)
      if (sel) {
        const opt = [...sel.options].find(o => parseInt(o.value) === saved);
        if (opt) sel.value = opt.value;
      }
      setRefreshInterval(saved);
    })();
    function openModal(id) {
      document.getElementById(id).classList.add('open');
      if (id === 'add-ticket-modal') {
        setTimeout(() => document.getElementById('modal-ticket-key').focus(), 50);
      }
    }
    function closeModal(id) {
      document.getElementById(id).classList.remove('open');
      if (id === 'add-ticket-modal') {
        document.getElementById('modal-ticket-key').value = '';
        document.getElementById('modal-key-err').style.display = 'none';
      }
    }
    function overlayClick(e, id) {
      if (e.target === document.getElementById(id)) closeModal(id);
    }
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        ['add-ticket-modal','info-modal'].forEach(id => {
          if (document.getElementById(id).classList.contains('open')) closeModal(id);
        });
      }
    });
    function submitAddTicket() {
      const keyEl = document.getElementById('modal-ticket-key');
      const key   = keyEl.value.trim().toUpperCase();
      const errEl = document.getElementById('modal-key-err');
      if (!key) { errEl.style.display = ''; keyEl.focus(); return; }
      errEl.style.display = 'none';
      const mode = document.getElementById('modal-ticket-mode').value;
      const form = document.createElement('form');
      form.method = 'POST';
      form.action = '/dashboard/queue';
      [['ticketKey', key], ['mode', mode]].forEach(([n, v]) => {
        const i = document.createElement('input');
        i.type = 'hidden'; i.name = n; i.value = v;
        form.appendChild(i);
      });
      document.body.appendChild(form);
      form.submit();
    }
  </script>
</body>
</html>`;
}

// ── .env helpers ─────────────────────────────────────────────────────────────

const ENV_PATH = path.resolve(__dirname, '../../.env');

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function readEnvValues() {
  const v = {};
  try {
    for (const line of fs.readFileSync(ENV_PATH, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m) v[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch (_) {}
  return v;
}

function writeEnvValues(updates) {
  let content = '';
  try { content = fs.readFileSync(ENV_PATH, 'utf8'); } catch (_) {}
  const applied = new Set();
  const updated = content.split('\n').map(line => {
    const active = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (active && active[1] in updates) {
      applied.add(active[1]);
      return `${active[1]}=${updates[active[1]]}`;
    }
    const commented = line.match(/^#\s*([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (commented && commented[1] in updates && !applied.has(commented[1]) && updates[commented[1]] !== '') {
      applied.add(commented[1]);
      return `${commented[1]}=${updates[commented[1]]}`;
    }
    return line;
  });
  const extra = Object.entries(updates)
    .filter(([k, v]) => !applied.has(k) && v !== '')
    .map(([k, v]) => `${k}=${v}`);
  fs.writeFileSync(ENV_PATH, updated.join('\n') + (extra.length ? '\n' + extra.join('\n') : ''), 'utf8');
}

// ── Settings page ─────────────────────────────────────────────────────────────

function fld(key, label, type, val, placeholder, hint, opts) {
  const id = `f_${key}`;
  let input;
  if (type === 'select') {
    const options = opts.map(o =>
      `<option value="${esc(o.v)}"${val === o.v ? ' selected' : ''}>${esc(o.l)}</option>`
    ).join('');
    input = `<select id="${id}" name="${key}" class="s-input">${options}</select>`;
  } else if (type === 'password') {
    input = `<div class="pw-wrap">
      <input type="password" id="${id}" name="${key}" value="${esc(val)}" placeholder="${esc(placeholder || '')}" class="s-input" autocomplete="off">
      <button type="button" class="pw-eye" onclick="togglePw('${id}')" tabindex="-1">
        <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
      </button>
    </div>`;
  } else {
    input = `<input type="${type}" id="${id}" name="${key}" value="${esc(val)}" placeholder="${esc(placeholder || '')}" class="s-input">`;
  }
  return `<div class="s-field">
    <label for="${id}" class="s-label">${esc(label)} <code class="s-key">${key}</code></label>
    ${input}
    ${hint ? `<div class="s-hint">${esc(hint)}</div>` : ''}
  </div>`;
}

function sectionHasValues(keys, vals) {
  return keys.some(k => vals[k] && vals[k] !== '');
}

function renderSettings(vals, flash) {
  const v = k => vals[k] || '';

  const kbKeys = ['PRX_KB_MODE','PRX_SOURCE_REPO_URL','PRX_KNOWLEDGE_DIR','PRX_KB_REPO','PRX_KB_LOCAL_CLONE','PRX_KB_KEY'];
  const emailKeys = ['PRX_EMAIL_TO','PRX_SMTP_HOST','PRX_SMTP_PORT','PRX_SMTP_USER','PRX_SMTP_PASS'];
  const bryanKeys = ['PRX_INCLUDE_SM_IN_SESSIONS_ENABLED','PRX_SKILL_UPGRADE_MIN_SESSIONS','PRX_SKILL_COMPACTION_INTERVAL','PRX_MONTHLY_BUDGET'];
  const autoKeys  = ['AUTO_MODE','FORCE_FULL_RUN','PRX_REPORT_VERBOSITY','PRX_JIRA_PROJECT','PRX_ATTACHMENT_MAX_MB'];
  const reportKeys = ['CLAUDE_REPORT_DIR'];

  const flashHtml = flash === 'saved'
    ? `<div class="s-flash s-flash-ok">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
        Settings saved successfully.
      </div>`
    : flash === 'error'
    ? `<div class="s-flash s-flash-err">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        Failed to save settings — check server logs.
      </div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Settings — Prevoyant Server</title>
  <style>
    ${BASE_CSS}
    .breadcrumb { font-size:0.8rem; color:#a0a8c0; }
    .breadcrumb a { color:#a0a8c0; text-decoration:none; }
    .breadcrumb a:hover { color:#fff; }
    .settings-wrap { max-width:780px; margin:2rem auto; padding:0 1.5rem 4rem; }
    .s-flash { display:flex; align-items:center; gap:.6rem; padding:.75rem 1rem; border-radius:8px;
               font-size:.85rem; font-weight:500; margin-bottom:1.5rem; }
    .s-flash-ok  { background:#dcfce7; color:#166534; border:1px solid #bbf7d0; }
    .s-flash-err { background:#fee2e2; color:#991b1b; border:1px solid #fecaca; }
    .s-section { background:#fff; border-radius:10px; box-shadow:0 1px 3px rgba(0,0,0,.08);
                 margin-bottom:1.2rem; overflow:hidden; }
    .s-section summary { list-style:none; display:flex; align-items:center; gap:.6rem;
                         padding:.85rem 1.2rem; font-size:.82rem; font-weight:700;
                         text-transform:uppercase; letter-spacing:.07em; color:#555;
                         cursor:pointer; user-select:none; border-bottom:1px solid #f0f1f5; }
    .s-section summary::-webkit-details-marker { display:none; }
    .s-section summary .s-chevron { margin-left:auto; color:#bbb; transition:transform .2s; }
    details[open] summary .s-chevron { transform:rotate(90deg); }
    .s-section summary .s-req { font-size:.68rem; background:#fee2e2; color:#991b1b;
                                 padding:1px 6px; border-radius:4px; font-weight:600; text-transform:none; letter-spacing:0; }
    .s-section summary .s-opt { font-size:.68rem; background:#f3f4f6; color:#6b7280;
                                 padding:1px 6px; border-radius:4px; font-weight:600; text-transform:none; letter-spacing:0; }
    .s-body { padding:1.2rem; display:grid; grid-template-columns:1fr 1fr; gap:.9rem 1.2rem; }
    .s-body.full-width { grid-template-columns:1fr; }
    .s-field { display:flex; flex-direction:column; gap:.3rem; }
    .s-field.span2 { grid-column:span 2; }
    .s-label { font-size:.78rem; font-weight:600; color:#374151; display:flex; flex-wrap:wrap; align-items:center; gap:.4rem; }
    .s-key { font-family:monospace; font-size:.72rem; background:#f3f4f6; color:#6b7280;
              padding:1px 5px; border-radius:4px; font-weight:400; }
    .s-input { width:100%; padding:.45rem .65rem; border:1px solid #d1d5db; border-radius:7px;
               font-size:.85rem; color:#1a1a2e; background:#fff; transition:border-color .15s;
               font-family:inherit; }
    .s-input:focus { outline:none; border-color:#6366f1; box-shadow:0 0 0 3px #6366f120; }
    .s-hint { font-size:.73rem; color:#9ca3af; }
    .pw-wrap { position:relative; }
    .pw-wrap .s-input { padding-right:2.4rem; }
    .pw-eye { position:absolute; right:.5rem; top:50%; transform:translateY(-50%);
              background:none; border:none; cursor:pointer; color:#9ca3af; padding:.2rem;
              display:flex; align-items:center; }
    .pw-eye:hover { color:#374151; }
    .s-actions { display:flex; gap:.75rem; align-items:center; margin-top:1.8rem; flex-wrap:wrap; }
    .btn-save { padding:.55rem 1.4rem; background:#1a1a2e; color:#fff; border:none;
                border-radius:8px; font-size:.88rem; font-weight:600; cursor:pointer; transition:background .15s; }
    .btn-save:hover { background:#2d3a5e; }
    .btn-restart { padding:.55rem 1.4rem; background:#0d6efd; color:#fff; border:none;
                   border-radius:8px; font-size:.88rem; font-weight:600; cursor:pointer; transition:background .15s; }
    .btn-restart:hover { background:#0b5ed7; }
    .btn-cancel { font-size:.85rem; color:#6b7280; text-decoration:none; padding:.55rem .8rem; }
    .btn-cancel:hover { color:#1a1a2e; }
    @media(max-width:560px){ .s-body { grid-template-columns:1fr; } .s-field.span2 { grid-column:span 1; } }
  </style>
</head>
<body>
  <header>
    <h1>Prevoyant Server</h1>
    <span class="version-badge">v${pluginVersion}</span>
    <div class="meta">
      <span class="breadcrumb"><a href="/dashboard">Dashboard</a> › Settings</span>
    </div>
  </header>

  <div class="settings-wrap">
    ${flashHtml}

    <form method="POST" action="/dashboard/settings">
      <input type="hidden" name="_restart" id="_restart" value="0">

      <!-- Repository -->
      <details class="s-section" open>
        <summary>
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
          Repository
          <span class="s-req">Required</span>
          <span class="s-chevron">›</span>
        </summary>
        <div class="s-body full-width">
          ${fld('PRX_REPO_DIR','Repo Directory','text',v('PRX_REPO_DIR'),'/absolute/path/to/your/repo','Absolute path to local codebase clone. Skill creates branches and searches files here.')}
        </div>
      </details>

      <!-- Jira -->
      <details class="s-section" open>
        <summary>
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>
          Jira
          <span class="s-req">Required</span>
          <span class="s-chevron">›</span>
        </summary>
        <div class="s-body">
          ${fld('JIRA_URL','Jira URL','text',v('JIRA_URL'),'https://yourcompany.atlassian.net','')}
          ${fld('JIRA_USERNAME','Username','text',v('JIRA_USERNAME'),'firstname.lastname@yourcompany.com','')}
          <div class="s-field span2">
            ${fld('JIRA_API_TOKEN','API Token','password',v('JIRA_API_TOKEN'),'your-jira-api-token','Generate at id.atlassian.com/manage-profile/security/api-tokens')}
          </div>
        </div>
      </details>

      <!-- Webhook Server -->
      <details class="s-section" open>
        <summary>
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
          Webhook Server
          <span class="s-opt">Optional</span>
          <span class="s-chevron">›</span>
        </summary>
        <div class="s-body">
          ${fld('WEBHOOK_PORT','Port','number',v('WEBHOOK_PORT'),'3000','HTTP port the server listens on. Default: 3000.')}
          ${fld('WEBHOOK_POLL_INTERVAL_DAYS','Poll Interval (days)','number',v('WEBHOOK_POLL_INTERVAL_DAYS'),'1','Run poll-jira.sh every N days. 0 = disabled. Fractional values: 0.5 = every 12 h.')}
          <div class="s-field span2">
            ${fld('WEBHOOK_SECRET','Webhook Secret','password',v('WEBHOOK_SECRET'),'your-strong-secret','Token appended to the Jira webhook URL. Leave empty to skip validation.')}
          </div>
        </div>
      </details>

      <!-- Knowledge Base -->
      <details class="s-section"${sectionHasValues(kbKeys, vals) ? ' open' : ''}>
        <summary>
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
          Knowledge Base
          <span class="s-opt">Optional</span>
          <span class="s-chevron">›</span>
        </summary>
        <div class="s-body">
          ${fld('PRX_KB_MODE','Mode','select',v('PRX_KB_MODE') || 'local','','',
            [{v:'local',l:'local (default)'},{v:'distributed',l:'distributed (shared git repo)'}])}
          ${fld('PRX_SOURCE_REPO_URL','Source Repo URL','text',v('PRX_SOURCE_REPO_URL'),'https://github.com/myorg/myrepo','Used to cross-check KB file:line refs against the live branch. Omit to skip.')}
          ${fld('PRX_KNOWLEDGE_DIR','KB Directory (local mode)','text',v('PRX_KNOWLEDGE_DIR'),'$HOME/.prevoyant/knowledge-base','Override default KB path. Local mode only.')}
          ${fld('PRX_KB_REPO','KB Repo URL (distributed)','text',v('PRX_KB_REPO'),'git@github.com:yourorg/team-kb.git','Private git repo for shared KB. Required in distributed mode.')}
          ${fld('PRX_KB_LOCAL_CLONE','KB Local Clone (distributed)','text',v('PRX_KB_LOCAL_CLONE'),'$HOME/.prevoyant/kb','Local clone path. Distributed mode only.')}
          <div class="s-field span2">
            ${fld('PRX_KB_KEY','Encryption Key (distributed)','password',v('PRX_KB_KEY'),'your-strong-passphrase','AES-256-CBC passphrase for encrypting KB files. Optional. Never commit this value.')}
          </div>
        </div>
      </details>

      <!-- Report Output -->
      <details class="s-section"${sectionHasValues(reportKeys, vals) ? ' open' : ''}>
        <summary>
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
          Report Output
          <span class="s-opt">Optional</span>
          <span class="s-chevron">›</span>
        </summary>
        <div class="s-body full-width">
          ${fld('CLAUDE_REPORT_DIR','Reports Directory','text',v('CLAUDE_REPORT_DIR'),'$HOME/.prevoyant/reports','Folder where PDF/HTML reports are saved. Created automatically if missing.')}
        </div>
      </details>

      <!-- Automation -->
      <details class="s-section"${sectionHasValues(autoKeys, vals) ? ' open' : ''}>
        <summary>
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
          Automation
          <span class="s-opt">Optional</span>
          <span class="s-chevron">›</span>
        </summary>
        <div class="s-body">
          ${fld('AUTO_MODE','Auto Mode','select',v('AUTO_MODE') || 'N','','Bypass all interactive gates. Fix is applied automatically to the feature branch.',
            [{v:'N',l:'N — interactive (default)'},{v:'Y',l:'Y — headless / automated'}])}
          ${fld('FORCE_FULL_RUN','Force Full Run','select',v('FORCE_FULL_RUN') || 'N','','Force every step to run in full even on repeat tickets.',
            [{v:'N',l:'N — default'},{v:'Y',l:'Y — force fresh analysis'}])}
          ${fld('PRX_REPORT_VERBOSITY','Report Verbosity','select',v('PRX_REPORT_VERBOSITY') || 'full','','Controls panel dialogue in terminal. PDF always contains full content.',
            [{v:'full',l:'full (default)'},{v:'compact',l:'compact'},{v:'minimal',l:'minimal'}])}
          ${fld('PRX_JIRA_PROJECT','Jira Project','text',v('PRX_JIRA_PROJECT'),'IV','Scope polling to a single project key. Omit to poll all assigned projects.')}
          ${fld('PRX_ATTACHMENT_MAX_MB','Attachment Max MB','number',v('PRX_ATTACHMENT_MAX_MB'),'0','Max size for non-image attachments. 0 = no limit.')}
        </div>
      </details>

      <!-- Email Delivery -->
      <details class="s-section"${sectionHasValues(emailKeys, vals) ? ' open' : ''}>
        <summary>
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
          Email Delivery
          <span class="s-opt">Optional</span>
          <span class="s-chevron">›</span>
        </summary>
        <div class="s-body">
          ${fld('PRX_EMAIL_TO','Recipient','text',v('PRX_EMAIL_TO'),'recipient@example.com','Set this to enable email delivery after each report.')}
          ${fld('PRX_SMTP_HOST','SMTP Host','text',v('PRX_SMTP_HOST'),'smtp.gmail.com','smtp.gmail.com or smtp.office365.com')}
          ${fld('PRX_SMTP_PORT','SMTP Port','number',v('PRX_SMTP_PORT'),'587','587 (STARTTLS) or 465 (SSL).')}
          ${fld('PRX_SMTP_USER','SMTP Username','text',v('PRX_SMTP_USER'),'you@gmail.com','')}
          <div class="s-field span2">
            ${fld('PRX_SMTP_PASS','SMTP Password','password',v('PRX_SMTP_PASS'),'app-password','Gmail: generate an App Password when 2-Step Verification is enabled.')}
          </div>
        </div>
      </details>

      <!-- Bryan -->
      <details class="s-section"${sectionHasValues(bryanKeys, vals) ? ' open' : ''}>
        <summary>
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
          Bryan — Scrum Master
          <span class="s-opt">Optional</span>
          <span class="s-chevron">›</span>
        </summary>
        <div class="s-body">
          ${fld('PRX_INCLUDE_SM_IN_SESSIONS_ENABLED','Enable Bryan','select',v('PRX_INCLUDE_SM_IN_SESSIONS_ENABLED') || 'N','','Bryan observes sessions and proposes SKILL.md improvements.',
            [{v:'N',l:'N — disabled (default)'},{v:'Y',l:'Y — enabled'}])}
          ${fld('PRX_MONTHLY_BUDGET','Monthly Budget (USD)','number',v('PRX_MONTHLY_BUDGET'),'20.00','Claude subscription budget. Bryan flags at >80% and ≥100%.')}
          ${fld('PRX_SKILL_UPGRADE_MIN_SESSIONS','Min Sessions Before Push','number',v('PRX_SKILL_UPGRADE_MIN_SESSIONS'),'3','Sessions with an approved change before Bryan pushes to main.')}
          ${fld('PRX_SKILL_COMPACTION_INTERVAL','Compaction Interval','number',v('PRX_SKILL_COMPACTION_INTERVAL'),'10','Sessions between full SKILL.md compaction passes.')}
        </div>
      </details>

      <div class="s-actions">
        <button type="submit" class="btn-save">Save</button>
        <button type="button" class="btn-restart" onclick="saveAndRestart()">Save &amp; Restart Server</button>
        <a href="/dashboard" class="btn-cancel">Cancel</a>
      </div>
    </form>
  </div>

  <script>
    function togglePw(id) {
      const el = document.getElementById(id);
      el.type = el.type === 'password' ? 'text' : 'password';
    }
    function saveAndRestart() {
      document.getElementById('_restart').value = '1';
      document.querySelector('form').submit();
    }
  </script>
</body>
</html>`;
}

// ── Restart page ──────────────────────────────────────────────────────────────

function renderRestartPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Restarting — Prevoyant Server</title>
  <style>
    ${BASE_CSS}
    @keyframes spin { to { transform: rotate(360deg); } }
    body { display:flex; flex-direction:column; min-height:100vh; }
    .restart-box { flex:1; display:flex; flex-direction:column; align-items:center;
                   justify-content:center; gap:1.4rem; padding:2rem; text-align:center; }
    .spinner { width:46px; height:46px; border:4px solid #e2e8f0;
               border-top-color:#0d6efd; border-radius:50%; animation:spin .8s linear infinite; }
    .restart-title { font-size:1.3rem; font-weight:700; color:#1a1a2e; }
    .restart-sub   { font-size:.9rem; color:#64748b; }
    .restart-status { font-size:.8rem; color:#94a3b8; font-family:monospace; }
    #timeout-msg { display:none; }
    #timeout-msg a { color:#0d6efd; }
  </style>
</head>
<body>
  <header>
    <h1>Prevoyant Server</h1>
    <span class="version-badge">v${pluginVersion}</span>
  </header>
  <div class="restart-box">
    <div class="spinner" id="spinner"></div>
    <div class="restart-title">Server is restarting…</div>
    <div class="restart-sub">Settings saved. Waiting for the server to come back online.</div>
    <div class="restart-status" id="status-msg">Waiting…</div>
    <div id="timeout-msg" style="font-size:.85rem;color:#dc2626">
      Restart is taking longer than expected. <a href="/dashboard">Try refreshing</a> or check the server log.
    </div>
  </div>
  <script>
    const MAX_WAIT = 30000, POLL_MS = 2000;
    const start = Date.now();
    let attempts = 0;
    function poll() {
      attempts++;
      const elapsed = Math.round((Date.now() - start) / 1000);
      document.getElementById('status-msg').textContent = 'Attempt ' + attempts + ' — ' + elapsed + 's elapsed…';
      if (Date.now() - start > MAX_WAIT) {
        document.getElementById('spinner').style.display = 'none';
        document.getElementById('timeout-msg').style.display = '';
        return;
      }
      fetch('/health', { cache: 'no-store' })
        .then(r => { if (r.ok) window.location.replace('/dashboard'); else setTimeout(poll, POLL_MS); })
        .catch(() => setTimeout(poll, POLL_MS));
    }
    setTimeout(poll, 2500);
  </script>
</body>
</html>`;
}

// ── Ticket detail page ────────────────────────────────────────────────────────

function stagePipelineHtml(stages) {
  if (!stages || !stages.length) {
    return `<p style="color:#aaa;font-size:0.9rem;padding:.5rem 0">No stage data yet — stages appear as Claude processes the ticket.</p>`;
  }

  const cards = stages.map((s, i) => {
    const isLast = i === stages.length - 1;
    let icon, cls;
    switch (s.status) {
      case 'active':  icon = ICONS.running(20);  cls = 'stage-active';  break;
      case 'done':    icon = ICONS.success(20);  cls = 'stage-done';    break;
      case 'failed':  icon = ICONS.failed(20);   cls = 'stage-failed';  break;
      case 'skipped': icon = ICONS.skipped(20);  cls = 'stage-skipped'; break;
      default:        icon = ICONS.queued(20);   cls = 'stage-pending'; break;
    }
    const d = s.startedAt ? dur(s.startedAt, s.completedAt || (s.status === 'active' ? null : undefined)) : '';
    return `<div class="pipeline-item">
      <div class="stage-card ${cls}">
        <div class="stage-icon">${icon}</div>
        <div class="stage-name">Step ${s.id}</div>
        <div class="stage-label">${s.label}</div>
        ${s.status === 'skipped' ? '<div class="stage-skipped-badge">Skipped</div>' : ''}
        ${d ? `<div class="stage-dur">${d}</div>` : ''}
      </div>
      ${!isLast ? '<div class="pipeline-arrow">›</div>' : ''}
    </div>`;
  }).join('');

  return `<div class="pipeline-scroll"><div class="pipeline-row">${cards}</div></div>`;
}

function renderDetail(ticket, warn, warnMode) {
  const stages = ticket.stages || [];
  const outputLines = ticket.outputLog || [];
  const reportFiles = ticket.reportFiles || [];
  const currentStage = stages.find(s => s.status === 'active');
  const doneCount = stages.filter(s => s.status === 'done' || s.status === 'failed').length;
  const pdfFiles = reportFiles.filter(f => f.toLowerCase().endsWith('.pdf'));

  // Output section: session log if available, else embedded PDF, else empty state
  let outputSection;
  if (outputLines.length > 0) {
    const logHtml = outputLines.map(l => {
      const ts = new Date(l.ts).toLocaleTimeString('en-GB');
      const isStderr = l.text.startsWith('[stderr]');
      const isResult = l.text.startsWith('[Result]');
      let bodyHtml;
      if (isStderr) {
        const t = l.text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        bodyHtml = `<span class="log-stderr">${t}</span>`;
      } else if (isResult) {
        const t = l.text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        bodyHtml = `<span class="log-result">${t}</span>`;
      } else {
        bodyHtml = renderMarkdown(l.text);
      }
      return `<div class="log-entry"><div class="log-ts">${ts}</div><div class="log-body">${bodyHtml}</div></div>`;
    }).join('');
    outputSection = `
      <button class="output-toggle" onclick="toggleOutput()">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
        <span id="toggle-label">View Output</span> (<span id="output-count">${outputLines.length}</span> entries)
      </button>
      <div id="output-box" class="output-box">${logHtml}</div>`;
  } else if (pdfFiles.length > 0) {
    const enc = encodeURIComponent(pdfFiles[0]);
    outputSection = `
      <p style="font-size:0.82rem;color:#888;margin-bottom:.75rem">No live session captured. Showing saved report:</p>
      <iframe src="/dashboard/view?path=${enc}" style="width:100%;height:620px;border:none;border-radius:10px;box-shadow:0 1px 4px rgba(0,0,0,.12)"></iframe>`;
  } else {
    outputSection = `<p style="color:#bbb;font-size:0.85rem">No session output and no report found for this ticket.</p>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Prevoyant — ${ticket.ticketKey}</title>
  <style>
    ${BASE_CSS}
    .page { max-width:1400px; margin:0 auto; padding:1.5rem 2rem 3rem; }
    .topbar { display:flex; align-items:flex-start; gap:1rem; margin-bottom:1.5rem; flex-wrap:wrap; }
    .back-btn { display:inline-flex; align-items:center; gap:6px; padding:6px 14px; background:#fff;
                border:1px solid #dde; border-radius:8px; font-size:0.82rem; color:#444; text-decoration:none;
                font-weight:500; box-shadow:0 1px 2px rgba(0,0,0,.06); transition:background .15s; white-space:nowrap; }
    .back-btn:hover { background:#f0f1f5; }
    .ticket-title { font-size:1.5rem; font-weight:700; letter-spacing:-0.02em; display:flex; align-items:center; gap:.5rem; flex-wrap:wrap; }
    .ticket-meta  { font-size:0.82rem; color:#888; display:flex; gap:1.5rem; flex-wrap:wrap; margin-top:.4rem; }
    .panel { background:#fff; border-radius:12px; box-shadow:0 1px 3px rgba(0,0,0,.08); margin-bottom:1.25rem; }
    .panel-header { padding:.85rem 1.25rem; border-bottom:1px solid #f0f1f5; display:flex; align-items:center; gap:.75rem; }
    .panel-header h2 { font-size:0.82rem; font-weight:600; text-transform:uppercase; letter-spacing:.07em; color:#666; flex:1; }
    .panel-body { padding:1.25rem; }
    .pipeline-scroll { overflow-x:auto; padding-bottom:.5rem; }
    .pipeline-row { display:flex; align-items:center; min-width:max-content; }
    .pipeline-item { display:flex; align-items:center; }
    .stage-card { width:108px; padding:.7rem .5rem; border-radius:10px; border:2px solid transparent;
                  display:flex; flex-direction:column; align-items:center; gap:4px; }
    .stage-icon { display:flex; align-items:center; justify-content:center; }
    .stage-name  { font-size:0.7rem; font-weight:700; color:#666; }
    .stage-label { font-size:0.72rem; color:#888; text-align:center; line-height:1.3; }
    .stage-dur   { font-size:0.68rem; color:#aaa; margin-top:2px; }
    .stage-pending { background:#f9fafb; border-color:#e5e7eb; }
    .stage-active  { background:#eff6ff; border-color:#93c5fd; box-shadow:0 0 0 3px #dbeafe; }
    .stage-done    { background:#f0fdf4; border-color:#86efac; }
    .stage-failed  { background:#fef2f2; border-color:#fca5a5; }
    .stage-skipped { background:#f9fafb; border-color:#e5e7eb; opacity:0.55; }
    .stage-skipped-badge { font-size:0.6rem; font-weight:600; text-transform:uppercase; letter-spacing:.05em;
                           color:#9ca3af; background:#e5e7eb; border-radius:4px; padding:1px 5px; margin-top:2px; }
    .pipeline-arrow { font-size:1.2rem; color:#d1d5db; padding:0 4px; }
    .progress-wrap { background:#f0f1f5; border-radius:99px; height:6px; overflow:hidden; margin-top:1rem; }
    .progress-bar  { height:100%; border-radius:99px; background:linear-gradient(90deg,#0d6efd,#198754); transition:width .4s; }
    .output-toggle { display:inline-flex; align-items:center; gap:6px; padding:7px 16px; background:#1a1a2e;
                     color:#fff; border:none; border-radius:8px; font-size:0.82rem; font-weight:500; cursor:pointer; }
    .output-toggle:hover { background:#2d3a5e; }
    .output-box { display:none; margin-top:1rem; background:#0f1117; border-radius:10px; padding:1.2rem 1.4rem;
                  max-height:620px; overflow-y:auto; }
    .output-box.open { display:block; }
    .log-entry  { padding:6px 0; border-bottom:1px solid #1e2130; }
    .log-entry:last-child { border-bottom:none; }
    .log-ts     { font-family:monospace; font-size:0.7rem; color:#4b5563; margin-bottom:3px; }
    .log-body   { color:#d1d5db; font-size:0.82rem; line-height:1.65; }
    .log-body h1,.log-body h2,.log-body h3 { color:#93c5fd; margin:10px 0 4px; font-size:0.9rem; border-bottom:1px solid #1e3a5f; padding-bottom:3px; }
    .log-body h4,.log-body h5 { color:#7dd3fc; margin:8px 0 2px; font-size:0.83rem; }
    .log-body pre  { background:#1a1f2e; border:1px solid #2d3a5e; border-radius:6px; padding:10px 12px;
                     overflow-x:auto; margin:8px 0; }
    .log-body code { background:#1a1f2e; padding:1px 5px; border-radius:3px; font-family:monospace;
                     font-size:0.78rem; color:#a5f3fc; }
    .log-body pre code { background:none; padding:0; color:#e2e8f0; font-size:0.77rem; white-space:pre; }
    .log-body strong { color:#fbbf24; }
    .log-body em     { color:#c4b5fd; }
    .log-body table  { border-collapse:collapse; margin:8px 0; font-size:0.78rem; width:100%; }
    .log-body th     { background:#1e2d40; color:#93c5fd; padding:5px 10px; border:1px solid #2d3a5e; }
    .log-body td     { padding:4px 10px; border:1px solid #1e2130; }
    .log-body hr     { border:none; border-top:1px solid #2d3a5e; margin:10px 0; }
    .log-body blockquote { border-left:3px solid #3b82f6; padding-left:10px; color:#94a3b8; margin:6px 0; }
    .log-body ul,.log-body ol { padding-left:1.4rem; margin:4px 0; }
    .log-body li    { margin:2px 0; }
    .log-stderr { color:#f87171; font-family:monospace; font-size:0.77rem; }
    .log-result { color:#4ade80; font-family:monospace; font-size:0.77rem; font-weight:600; }
    .dl-btn { display:inline-flex; align-items:center; gap:4px; padding:5px 12px; background:#1a1a2e;
              color:#fff; border-radius:8px; font-size:0.8rem; text-decoration:none; font-weight:500; transition:background .15s; }
    .dl-btn:hover { background:#2d3a5e; }
    .warn-banner { background:#fffbeb; border:1.5px solid #f59e0b; border-radius:10px;
                   padding:1rem 1.25rem; margin-bottom:1.25rem; }
    .warn-banner h3 { font-size:0.88rem; font-weight:700; color:#92400e; margin-bottom:.5rem;
                      display:flex; align-items:center; gap:.4rem; }
    .warn-banner p  { font-size:0.82rem; color:#78350f; margin-bottom:.5rem; line-height:1.5; }
    .warn-banner code { background:#fef3c7; padding:2px 6px; border-radius:4px; font-family:monospace;
                        font-size:0.8rem; color:#92400e; word-break:break-all; }
    .warn-banner ol { font-size:0.82rem; color:#78350f; padding-left:1.3rem; line-height:1.8; }
    .warn-banner .warn-actions { display:flex; align-items:center; gap:.75rem; margin-top:.9rem; flex-wrap:wrap; }
    .force-btn { display:inline-flex; align-items:center; gap:6px; padding:7px 18px; background:#d97706;
                 color:#fff; border:none; border-radius:8px; font-size:0.82rem; font-weight:600;
                 cursor:pointer; transition:background .15s; }
    .force-btn:hover { background:#b45309; }
    .run-panel { display:flex; align-items:center; gap:1rem; flex-wrap:wrap; }
    .run-panel label { font-size:0.82rem; color:#555; font-weight:500; }
    .mode-btn-group { display:flex; gap:.4rem; }
    .mode-btn { padding:6px 18px; border:2px solid #d1d5db; border-radius:8px; background:#fff;
                font-size:0.82rem; font-weight:600; cursor:pointer; transition:all .15s; color:#555; }
    .mode-btn.selected { border-color:#0d6efd; background:#eff6ff; color:#1d4ed8; }
    .mode-btn:hover:not(.selected) { border-color:#9ca3af; background:#f9fafb; }
    .run-submit { display:inline-flex; align-items:center; gap:6px; padding:8px 20px; background:#16a34a;
                  color:#fff; border:none; border-radius:8px; font-size:0.85rem; font-weight:600;
                  cursor:pointer; transition:background .15s; }
    .run-submit:hover { background:#15803d; }
    .run-submit:disabled { background:#d1d5db; color:#9ca3af; cursor:not-allowed; }
    .stop-submit { display:inline-flex; align-items:center; gap:6px; padding:8px 20px; background:#dc2626;
                   color:#fff; border:none; border-radius:8px; font-size:0.82rem; font-weight:500; cursor:pointer; transition:background .15s; }
    .stop-submit:hover { background:#b91c1c; }
  </style>
</head>
<body>
  <header>
    <h1>Prevoyant Server</h1>
    <span class="version-badge">v${pluginVersion}</span>
    <div class="meta" style="flex:1"></div>
  </header>

  <div class="page">
    <div class="topbar">
      <a href="/dashboard" class="back-btn">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
        Dashboard
      </a>
      <div>
        <div class="ticket-title">
          <span id="status-icon">${(ICONS[ticket.status] || ICONS.queued)(22)}</span>
          ${ticket.ticketKey}
          <span id="status-badge" class="badge badge-${ticket.status}" style="font-size:0.85rem">${ticket.status}</span>
          ${modeBadge(ticket.mode)}
        </div>
        <div class="ticket-meta">
          <span>Source: <strong>${ticket.source}</strong></span>
          <span>Queued: <strong>${fmt(ticket.queuedAt)}</strong></span>
          ${ticket.startedAt    ? `<span>Started: <strong>${fmt(ticket.startedAt)}</strong></span>`    : ''}
          ${ticket.completedAt  ? `<span>Finished: <strong>${fmt(ticket.completedAt)}</strong></span>` : ''}
          <span>Duration: <strong id="duration-val">${dur(ticket.startedAt, ticket.completedAt)}</strong></span>
        </div>
      </div>
    </div>

    ${warn === 'seen' ? (() => {
      const safeKey = ticket.ticketKey.replace(/[^A-Za-z0-9_-]/g, '');
      const chosenMode = warnMode || ticket.mode || 'dev';
      const seenFile   = config.seenCacheFile;
      return `
    <div class="warn-banner">
      <h3>
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none"
             stroke="#d97706" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
          <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
        </svg>
        Ticket is in the seen-tickets cache
      </h3>
      <p><strong>${safeKey}</strong> is recorded in <code>${seenFile}</code>.
        The polling script skips tickets already in this file, so re-running from the dashboard
        will still work — but if you also want <code>poll-jira.sh</code> to pick it up again automatically,
        you need to remove it from the cache first.</p>
      <ol>
        <li>Remove just this ticket:<br>
            <code>sed -i '' '/^${safeKey}$/d' "${seenFile}"</code></li>
        <li>Or clear the entire cache (all tickets will be re-evaluated on next poll):<br>
            <code>truncate -s 0 "${seenFile}"</code></li>
      </ol>
      <div class="warn-actions">
        <form method="POST" action="/dashboard/ticket/${encodeURIComponent(ticket.ticketKey)}/run">
          <input type="hidden" name="mode"  value="${chosenMode}">
          <input type="hidden" name="force" value="1">
          <button type="submit" class="force-btn">
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24"
                 fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            Force Run &amp; remove from cache
          </button>
        </form>
        <span style="font-size:0.78rem;color:#92400e">
          This removes <strong>${safeKey}</strong> from the seen-tickets file and starts the job now.
        </span>
      </div>
    </div>`;
    })() : ''}

    <!-- Pipeline -->
    <div class="panel">
      <div class="panel-header">
        <h2>Pipeline</h2>
        <span id="pipeline-meta" style="font-size:0.78rem;color:#888;display:flex;align-items:center;gap:.75rem">
          ${stages.length ? `<span id="stage-count">${doneCount} / ${stages.length} stages</span>` : ''}
          ${currentStage ? `<span id="current-stage" style="color:#0d6efd">Currently: Step ${currentStage.id} — ${currentStage.label}</span>` : ''}
        </span>
      </div>
      <div class="panel-body">
        <div id="pipeline-content">${stagePipelineHtml(stages)}</div>
        ${stages.length ? `<div class="progress-wrap"><div id="progress-bar" class="progress-bar" style="width:${Math.round(doneCount / stages.length * 100)}%"></div></div>` : ''}
      </div>
    </div>

    <!-- Reports -->
    ${reportFiles.length ? `
    <div class="panel">
      <div class="panel-header"><h2>Reports</h2></div>
      <div class="panel-body" style="display:flex;gap:1rem;flex-wrap:wrap">
        ${reportFiles.map(f => {
          const ext = path.extname(f).toUpperCase().replace('.', '');
          const base = path.basename(f);
          const enc = encodeURIComponent(f);
          return `<a href="/dashboard/download?path=${enc}" class="dl-btn">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            Download ${ext} — ${base}
          </a>`;
        }).join('')}
      </div>
    </div>` : ''}

    <!-- Re-run -->
    <div class="panel">
      <div class="panel-header"><h2>Run</h2></div>
      <div class="panel-body">
        <form method="POST" action="/dashboard/ticket/${encodeURIComponent(ticket.ticketKey)}/run"
              class="run-panel" onsubmit="return confirmDetailRun(this)">
          <label>Mode:</label>
          <div class="mode-btn-group" id="mode-group">
            ${['dev','review','estimate'].map(m => `
              <button type="button" class="mode-btn${(ticket.mode || 'dev') === m ? ' selected' : ''}"
                      onclick="selectMode('${m}')">${m.charAt(0).toUpperCase() + m.slice(1)}</button>`).join('')}
          </div>
          <input type="hidden" name="mode" id="mode-input" value="${ticket.mode || 'dev'}">
          <button type="submit" class="run-submit" ${ticket.status === 'running' || ticket.status === 'queued' ? 'disabled' : ''}>
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24"
                 fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            ${ticket.status === 'running' ? 'Running…' : ticket.status === 'queued' ? 'Queued…' : 'Run'}
          </button>
          ${ticket.status === 'running' || ticket.status === 'queued' ? `
          <form method="POST" action="/dashboard/ticket/${encodeURIComponent(ticket.ticketKey)}/stop"
                style="display:inline" onsubmit="return confirm('Stop this job?')">
            <button type="submit" class="stop-submit">
              <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24"
                   fill="currentColor"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>
              Stop Job
            </button>
          </form>` : ''}
        </form>
      </div>
    </div>

    <!-- Claude session output / PDF fallback -->
    <div class="panel">
      <div class="panel-header"><h2>View Output</h2></div>
      <div class="panel-body">${outputSection}</div>
    </div>
  </div>

  <div class="footer">Prevoyant Server v${pluginVersion}</div>

  <script>
    function toggleOutput() {
      const box = document.getElementById('output-box');
      const lbl = document.getElementById('toggle-label');
      const open = box.classList.toggle('open');
      lbl.textContent = open ? 'Hide Output' : 'View Output';
      if (open) box.scrollTop = box.scrollHeight;
    }
    function selectMode(mode) {
      document.getElementById('mode-input').value = mode;
      document.querySelectorAll('#mode-group .mode-btn').forEach(b => {
        b.classList.toggle('selected', b.textContent.trim().toLowerCase() === mode);
      });
    }
    function confirmDetailRun(form) {
      const mode = document.getElementById('mode-input').value;
      return confirm('Run ${ticket.ticketKey} in ' + mode + ' mode?');
    }

    // Live polling — updates dynamic parts without a full page reload
    (function () {
      const ACTIVE = ['running', 'queued'];
      const ticketKey = ${JSON.stringify(ticket.ticketKey)};
      let knownOutputCount = ${outputLines.length};

      if (!ACTIVE.includes(${JSON.stringify(ticket.status)})) return;

      const timer = setInterval(async () => {
        let data;
        try {
          const res = await fetch('/dashboard/ticket/' + encodeURIComponent(ticketKey) + '/partial?since=' + knownOutputCount);
          if (!res.ok) return;
          data = await res.json();
        } catch (_) { return; }

        // Pipeline
        const pc = document.getElementById('pipeline-content');
        if (pc) pc.innerHTML = data.pipelineHtml;

        const pb = document.getElementById('progress-bar');
        if (pb) pb.style.width = data.progressPct + '%';

        const sc = document.getElementById('stage-count');
        if (sc) sc.textContent = data.doneCount + ' / ' + data.totalStages + ' stages';

        const cs = document.getElementById('current-stage');
        if (data.currentStageLabel) {
          if (cs) { cs.textContent = 'Currently: ' + data.currentStageLabel; cs.style.display = ''; }
        } else if (cs) { cs.style.display = 'none'; }

        // Duration
        const dv = document.getElementById('duration-val');
        if (dv && data.duration) dv.textContent = data.duration;

        // Output — append only new entries to preserve scroll and open state
        if (data.newLogEntries && data.newLogEntries.length) {
          const box = document.getElementById('output-box');
          if (box) {
            const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
            box.insertAdjacentHTML('beforeend', data.newLogEntries.join(''));
            if (atBottom) box.scrollTop = box.scrollHeight;
          }
          knownOutputCount += data.newLogEntries.length;
          const oc = document.getElementById('output-count');
          if (oc) oc.textContent = knownOutputCount;
        }

        // Status badge + icon
        if (data.status) {
          const badge = document.getElementById('status-badge');
          if (badge) {
            badge.className = 'badge badge-' + data.status;
            const labels = { queued: 'queued', running: 'running', success: 'success', failed: 'failed', interrupted: 'interrupted' };
            badge.textContent = labels[data.status] || data.status;
          }
          const icon = document.getElementById('status-icon');
          if (icon && data.statusIconHtml) icon.innerHTML = data.statusIconHtml;
        }

        // Stop polling once job is no longer active
        if (!ACTIVE.includes(data.status)) clearInterval(timer);
      }, 5000);
    })();
  </script>
</body>
</html>`;
}

// ── Routes ────────────────────────────────────────────────────────────────────

router.get('/', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(renderDashboard(getStats()));
});

router.get('/json', (_req, res) => res.json(getStats()));

router.get('/ticket/:key', (req, res) => {
  const ticket = getTicket(req.params.key);
  if (!ticket) return res.status(404).send('Ticket not found.');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(renderDetail(ticket, req.query.warn, req.query.mode));
});

// Partial update endpoint — returns only what the live-poll JS needs
router.get('/ticket/:key/partial', (req, res) => {
  const ticket = getTicket(req.params.key);
  if (!ticket) return res.status(404).json({ error: 'not found' });

  const stages = ticket.stages || [];
  const outputLines = ticket.outputLog || [];
  const doneCount = stages.filter(s => s.status === 'done' || s.status === 'failed').length;
  const currentStage = stages.find(s => s.status === 'active');
  const since = parseInt(req.query.since || '0', 10);

  const newLogEntries = outputLines.slice(since).map(l => {
    const ts = new Date(l.ts).toLocaleTimeString('en-GB');
    const isStderr = l.text.startsWith('[stderr]');
    const isResult = l.text.startsWith('[Result]');
    let bodyHtml;
    if (isStderr) {
      const t = l.text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      bodyHtml = `<span class="log-stderr">${t}</span>`;
    } else if (isResult) {
      const t = l.text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      bodyHtml = `<span class="log-result">${t}</span>`;
    } else {
      bodyHtml = renderMarkdown(l.text);
    }
    return `<div class="log-entry"><div class="log-ts">${ts}</div><div class="log-body">${bodyHtml}</div></div>`;
  });

  res.json({
    status: ticket.status,
    statusIconHtml: (ICONS[ticket.status] || ICONS.queued)(22),
    pipelineHtml: stagePipelineHtml(stages),
    progressPct: stages.length ? Math.round(doneCount / stages.length * 100) : 0,
    doneCount,
    totalStages: stages.length,
    currentStageLabel: currentStage ? `Step ${currentStage.id} — ${currentStage.label}` : null,
    duration: dur(ticket.startedAt, ticket.completedAt),
    newLogEntries,
    totalOutputCount: outputLines.length,
  });
});

// Secure inline view (for PDF iframe embedding)
router.get('/view', (req, res) => {
  const rawPath = req.query.path;
  if (!rawPath) return res.status(400).send('Missing path.');
  const { reportsDir } = getStats();
  const resolved = path.resolve(rawPath);
  const base = path.resolve(reportsDir);
  if (!resolved.startsWith(base + path.sep) && resolved !== base) return res.status(403).send('Access denied.');
  if (!fs.existsSync(resolved)) return res.status(404).send('File not found.');
  const ct = resolved.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'text/html';
  res.setHeader('Content-Type', ct);
  fs.createReadStream(resolved).pipe(res);
});

// Run / re-run a ticket
router.post('/ticket/:key/run', express.urlencoded({ extended: false }), (req, res) => {
  const ticketKey = req.params.key.toUpperCase();
  const mode  = (req.body.mode  || 'dev').toLowerCase();
  const force = req.body.force === '1';

  if (!VALID_MODES.has(mode)) return res.status(400).send('Invalid mode.');

  const existing = getTicket(ticketKey);
  if (existing && (existing.status === 'running' || existing.status === 'queued')) {
    return res.status(409).send('Job already in progress.');
  }

  if (!force && isInSeenCache(ticketKey)) {
    const enc = encodeURIComponent(ticketKey);
    return res.redirect(303, `/dashboard/ticket/${enc}?warn=seen&mode=${encodeURIComponent(mode)}`);
  }

  if (force) removeFromSeenCache(ticketKey);

  reRunTicket(ticketKey, mode, 'manual');
  enqueue(ticketKey, mode);
  res.redirect(303, `/dashboard/ticket/${encodeURIComponent(ticketKey)}`);
});

// Stop a running or queued job
router.post('/ticket/:key/stop', (req, res) => {
  const ticketKey = req.params.key.toUpperCase();
  killJob(ticketKey);
  res.redirect(303, `/dashboard/ticket/${encodeURIComponent(ticketKey)}`);
});

// Secure download
router.get('/download', (req, res) => {
  const rawPath = req.query.path;
  if (!rawPath) return res.status(400).send('Missing path.');
  const { reportsDir } = getStats();
  const resolved = path.resolve(rawPath);
  const base = path.resolve(reportsDir);
  if (!resolved.startsWith(base + path.sep) && resolved !== base) return res.status(403).send('Access denied.');
  if (!fs.existsSync(resolved)) return res.status(404).send('File not found.');
  res.download(resolved);
});

// Manually queue a ticket (from the Add Ticket modal on the dashboard)
router.post('/queue', express.urlencoded({ extended: false }), (req, res) => {
  const ticketKey = (req.body.ticketKey || '').toUpperCase().trim();
  const mode = (req.body.mode || 'dev').toLowerCase();
  if (!ticketKey || !VALID_MODES.has(mode)) return res.redirect(303, '/dashboard');
  const existing = getTicket(ticketKey);
  if (!existing || (existing.status !== 'running' && existing.status !== 'queued')) {
    reRunTicket(ticketKey, mode, 'manual');
    enqueue(ticketKey, mode);
  }
  res.redirect(303, '/dashboard');
});

// ── Settings ──────────────────────────────────────────────────────────────────

router.get('/settings', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(renderSettings(readEnvValues(), req.query.saved === '1' ? 'saved' : null));
});

router.post('/settings', express.urlencoded({ extended: false }), (req, res) => {
  const FIELDS = [
    'PRX_REPO_DIR',
    'JIRA_URL', 'JIRA_USERNAME', 'JIRA_API_TOKEN',
    'WEBHOOK_PORT', 'WEBHOOK_SECRET', 'WEBHOOK_POLL_INTERVAL_DAYS',
    'PRX_KB_MODE', 'PRX_SOURCE_REPO_URL', 'PRX_KNOWLEDGE_DIR',
    'PRX_KB_REPO', 'PRX_KB_LOCAL_CLONE', 'PRX_KB_KEY',
    'CLAUDE_REPORT_DIR',
    'AUTO_MODE', 'FORCE_FULL_RUN', 'PRX_REPORT_VERBOSITY',
    'PRX_JIRA_PROJECT', 'PRX_ATTACHMENT_MAX_MB',
    'PRX_EMAIL_TO', 'PRX_SMTP_HOST', 'PRX_SMTP_PORT', 'PRX_SMTP_USER', 'PRX_SMTP_PASS',
    'PRX_INCLUDE_SM_IN_SESSIONS_ENABLED', 'PRX_SKILL_UPGRADE_MIN_SESSIONS',
    'PRX_SKILL_COMPACTION_INTERVAL', 'PRX_MONTHLY_BUDGET',
  ];

  try {
    const updates = {};
    for (const key of FIELDS) {
      if (key in req.body) updates[key] = String(req.body[key] || '').trim();
    }
    writeEnvValues(updates);
  } catch (err) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(renderSettings(readEnvValues(), 'error'));
  }

  if (req.body._restart === '1') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(renderRestartPage());
    // Detached script: stop current server then start fresh (picks up new .env)
    setImmediate(() => {
      const scripts = path.join(__dirname, '../scripts');
      const child = spawn('bash', ['-c',
        `sleep 1 && bash "${scripts}/stop.sh" && sleep 2 && bash "${scripts}/start.sh"`
      ], { detached: true, stdio: 'ignore' });
      child.unref();
    });
  } else {
    res.redirect(303, '/dashboard/settings?saved=1');
  }
});

// Standalone restart (no save) — useful for manual recovery
router.post('/restart', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(renderRestartPage());
  setImmediate(() => {
    const scripts = path.join(__dirname, '../scripts');
    const child = spawn('bash', ['-c',
      `sleep 1 && bash "${scripts}/stop.sh" && sleep 2 && bash "${scripts}/start.sh"`
    ], { detached: true, stdio: 'ignore' });
    child.unref();
  });
});

module.exports = router;
