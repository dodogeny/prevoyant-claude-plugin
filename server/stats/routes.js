'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const { getStats, getTicket } = require('./tracker');

const router = express.Router();

// Plugin version — read once at startup
let pluginVersion = '—';
try {
  pluginVersion = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '../../plugin/.claude-plugin/plugin.json'), 'utf8')
  ).version || '—';
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
  .refresh-note { background: #fff3cd33; border: 1px solid #ffc10766; border-radius: 6px;
                  padding: .35rem .75rem; font-size: .75rem; color: #ffc107; white-space: nowrap; }
  .badge { padding: 2px 9px; border-radius: 10px; font-size: 0.74rem; font-weight: 600; }
  .badge-queued  { background: #f3f4f6; color: #6b7280; }
  .badge-running { background: #dbeafe; color: #1d4ed8; }
  .badge-success { background: #dcfce7; color: #166534; }
  .badge-failed  { background: #fee2e2; color: #991b1b; }
  .mode-badge { padding: 2px 8px; border-radius: 8px; font-size: 0.72rem; font-weight: 600; }
  .mode-dev    { background: #e0f2fe; color: #0369a1; }
  .mode-review { background: #f3e8ff; color: #7e22ce; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .spin { animation: spin 0.9s linear infinite; transform-origin: center; display: block; }
  .footer { text-align: center; padding: 1.2rem; font-size: 0.72rem; color: #ccc; }
`;

// ── Icons ─────────────────────────────────────────────────────────────────────

const ICONS = {
  queued:  (n = 18) => `<svg xmlns="http://www.w3.org/2000/svg" width="${n}" height="${n}" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
  running: (n = 18) => `<svg class="spin" xmlns="http://www.w3.org/2000/svg" width="${n}" height="${n}" viewBox="0 0 24 24" fill="none" stroke="#0d6efd" stroke-width="2.5" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>`,
  success: (n = 18) => `<svg xmlns="http://www.w3.org/2000/svg" width="${n}" height="${n}" viewBox="0 0 24 24" fill="none" stroke="#198754" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`,
  failed:  (n = 18) => `<svg xmlns="http://www.w3.org/2000/svg" width="${n}" height="${n}" viewBox="0 0 24 24" fill="none" stroke="#dc3545" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`,
};

function sessionIconBadge(status) {
  const labels = { queued: 'Queued', running: 'Running', success: 'Done', failed: 'Failed' };
  return `<span title="${labels[status] || status}" style="display:inline-flex;align-items:center;gap:6px">
    ${(ICONS[status] || ICONS.queued)(18)}<span class="badge badge-${status}">${labels[status] || status}</span>
  </span>`;
}

function modeBadge(mode) {
  if (mode === 'dev')    return '<span class="mode-badge mode-dev">Dev</span>';
  if (mode === 'review') return '<span class="mode-badge mode-review">Review</span>';
  return '<span style="color:#ccc;font-size:0.82rem">—</span>';
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

  const rows = stats.tickets.map(t => `
    <tr class="${t.status === 'running' ? 'row-running' : ''}">
      <td><a href="/dashboard/ticket/${encodeURIComponent(t.ticketKey)}" class="ticket-link">${t.ticketKey}</a></td>
      <td>${modeBadge(t.mode)}</td>
      <td><span class="source-tag ${t.source === 'disk' ? 'source-disk' : ''}">${t.source}</span></td>
      <td>${sessionIconBadge(t.status)}</td>
      <td style="font-size:0.82rem;color:#555">${fmt(t.queuedAt)}</td>
      <td style="font-size:0.82rem;color:#555">${fmt(t.completedAt)}</td>
      <td style="font-size:0.82rem;color:#555">${dur(t.startedAt, t.completedAt)}</td>
      <td>${reportCell(t.reportFiles)}</td>
    </tr>`).join('');

  const emptyRow = `<tr><td colspan="8" style="text-align:center;color:#bbb;padding:2.5rem;font-size:0.9rem">No tickets yet — waiting for Jira events.</td></tr>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="refresh" content="30">
  <title>Prevoyant Server — Dashboard</title>
  <style>
    ${BASE_CSS}
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
  </style>
</head>
<body>
  <header>
    <h1>Prevoyant Server</h1>
    <span class="version-badge">v${pluginVersion}</span>
    <div class="meta">
      <span>Uptime: <strong>${formatUptime(stats.uptimeSeconds)}</strong></span>
      <span>Started: ${fmt(stats.serverStartedAt)}</span>
      <span>Reports: ${stats.reportsDir}</span>
    </div>
    <div class="refresh-note">Auto-refreshes every 30s</div>
  </header>

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
          <th>Queued at</th><th>Completed at</th><th>Duration</th><th>Report</th>
        </tr>
      </thead>
      <tbody>${stats.tickets.length ? rows : emptyRow}</tbody>
    </table>
  </div>

  <div class="footer">Prevoyant Server v${pluginVersion} &mdash; Dashboard &mdash; ${new Date().toLocaleString('en-GB')}</div>
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
      case 'active':  icon = ICONS.running(20); cls = 'stage-active';  break;
      case 'done':    icon = ICONS.success(20); cls = 'stage-done';    break;
      case 'failed':  icon = ICONS.failed(20);  cls = 'stage-failed';  break;
      default:        icon = ICONS.queued(20);  cls = 'stage-pending'; break;
    }
    const d = s.startedAt ? dur(s.startedAt, s.completedAt || (s.status === 'active' ? null : undefined)) : '';
    return `<div class="pipeline-item">
      <div class="stage-card ${cls}">
        <div class="stage-icon">${icon}</div>
        <div class="stage-name">Step ${s.id}</div>
        <div class="stage-label">${s.label}</div>
        ${d ? `<div class="stage-dur">${d}</div>` : ''}
      </div>
      ${!isLast ? '<div class="pipeline-arrow">›</div>' : ''}
    </div>`;
  }).join('');

  return `<div class="pipeline-scroll"><div class="pipeline-row">${cards}</div></div>`;
}

function renderDetail(ticket) {
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
      const text = l.text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      return `<div class="log-line"><span class="log-ts">${ts}</span><span class="log-text">${text}</span></div>`;
    }).join('');
    outputSection = `
      <button class="output-toggle" onclick="toggleOutput()">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
        <span id="toggle-label">View Output</span> (${outputLines.length} lines)
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
  ${ticket.status === 'running' ? '<meta http-equiv="refresh" content="10">' : ''}
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
    .pipeline-arrow { font-size:1.2rem; color:#d1d5db; padding:0 4px; }
    .progress-wrap { background:#f0f1f5; border-radius:99px; height:6px; overflow:hidden; margin-top:1rem; }
    .progress-bar  { height:100%; border-radius:99px; background:linear-gradient(90deg,#0d6efd,#198754); transition:width .4s; }
    .output-toggle { display:inline-flex; align-items:center; gap:6px; padding:7px 16px; background:#1a1a2e;
                     color:#fff; border:none; border-radius:8px; font-size:0.82rem; font-weight:500; cursor:pointer; }
    .output-toggle:hover { background:#2d3a5e; }
    .output-box { display:none; margin-top:1rem; background:#0f1117; border-radius:10px; padding:1rem;
                  max-height:520px; overflow-y:auto; font-family:monospace; }
    .output-box.open { display:block; }
    .log-line { display:flex; gap:1rem; padding:2px 0; font-size:0.78rem; line-height:1.5; border-bottom:1px solid #1e2130; }
    .log-ts   { color:#4b5563; white-space:nowrap; flex-shrink:0; }
    .log-text { color:#d1d5db; white-space:pre-wrap; word-break:break-word; }
    .dl-btn { display:inline-flex; align-items:center; gap:4px; padding:5px 12px; background:#1a1a2e;
              color:#fff; border-radius:8px; font-size:0.8rem; text-decoration:none; font-weight:500; transition:background .15s; }
    .dl-btn:hover { background:#2d3a5e; }
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
          ${(ICONS[ticket.status] || ICONS.queued)(22)}
          ${ticket.ticketKey}
          <span class="badge badge-${ticket.status}" style="font-size:0.85rem">${ticket.status}</span>
          ${modeBadge(ticket.mode)}
        </div>
        <div class="ticket-meta">
          <span>Source: <strong>${ticket.source}</strong></span>
          <span>Queued: <strong>${fmt(ticket.queuedAt)}</strong></span>
          ${ticket.startedAt    ? `<span>Started: <strong>${fmt(ticket.startedAt)}</strong></span>`    : ''}
          ${ticket.completedAt  ? `<span>Finished: <strong>${fmt(ticket.completedAt)}</strong></span>` : ''}
          <span>Duration: <strong>${dur(ticket.startedAt, ticket.completedAt)}</strong></span>
        </div>
      </div>
    </div>

    <!-- Pipeline -->
    <div class="panel">
      <div class="panel-header">
        <h2>Pipeline</h2>
        ${stages.length ? `<span style="font-size:0.78rem;color:#888">${doneCount} / ${stages.length} stages</span>` : ''}
        ${currentStage ? `<span style="font-size:0.78rem;color:#0d6efd">Currently: Step ${currentStage.id} — ${currentStage.label}</span>` : ''}
      </div>
      <div class="panel-body">
        ${stagePipelineHtml(stages)}
        ${stages.length ? `<div class="progress-wrap"><div class="progress-bar" style="width:${Math.round(doneCount / stages.length * 100)}%"></div></div>` : ''}
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
  res.send(renderDetail(ticket));
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

module.exports = router;
