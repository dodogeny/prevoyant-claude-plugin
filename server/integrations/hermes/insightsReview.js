'use strict';

// Hermes-insight review pipeline — Option A.
//
//   <KB>/hermes-insights/
//     ├── pending/    ← raw POST from /internal/kb/insights lands here
//     ├── approved/   ← human-approved; indexer walks this dir
//     └── rejected/   ← human-rejected; kept for audit (auto-archived after 30 d)
//
// All file moves happen via rename (atomic on the same filesystem). Reviewer
// edits are applied just before the move so the approved file already reflects
// any human polish.

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const REJECT_RETENTION_DAYS = 30;

function kbDir() {
  return process.env.PRX_KNOWLEDGE_DIR
    || path.join(os.homedir(), '.prevoyant', 'knowledge-base');
}

function dirFor(state) {
  return path.join(kbDir(), 'hermes-insights', state); // 'pending' | 'approved' | 'rejected'
}

function ensureDirs() {
  for (const s of ['pending', 'approved', 'rejected']) {
    try { fs.mkdirSync(dirFor(s), { recursive: true }); } catch {}
  }
}

// Naive frontmatter parser — handles the limited YAML we emit ourselves.
function parseFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { fm: {}, body: text };
  const fm  = {};
  const lines = m[1].split('\n');
  for (const line of lines) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    let val   = line.slice(idx + 1).trim();
    if (val.startsWith('[') && val.endsWith(']')) {
      val = val.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    } else if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    fm[key] = val;
  }
  const body = text.slice(m[0].length);
  // Strip the title line (we re-add on render to keep things idempotent).
  const titleMatch = body.match(/^\s*#\s+(.+)\n+/);
  if (titleMatch) {
    fm.title = titleMatch[1].trim();
    return { fm, body: body.slice(titleMatch[0].length) };
  }
  return { fm, body };
}

function yamlScalar(s) {
  return /[:\n\-#"'\[\]{}*&!|>%@`]|^\s|\s$/.test(s) ? JSON.stringify(s) : s;
}

function renderFile(meta, body) {
  const lines = ['---', 'source: hermes', `state: ${meta.state || 'pending'}`];
  if (meta.recorded_at)        lines.push(`recorded_at: ${meta.recorded_at}`);
  if (meta.category)           lines.push(`category: ${yamlScalar(meta.category)}`);
  if (meta.confidence)         lines.push(`confidence: ${meta.confidence}`);
  if (Array.isArray(meta.tickets) && meta.tickets.length) lines.push(`tickets: [${meta.tickets.join(', ')}]`);
  if (Array.isArray(meta.tags)    && meta.tags.length)    lines.push(`tags: [${meta.tags.map(yamlScalar).join(', ')}]`);
  if (meta.reviewed_at)        lines.push(`reviewed_at: ${meta.reviewed_at}`);
  if (meta.reviewer)           lines.push(`reviewer: ${yamlScalar(meta.reviewer)}`);
  if (meta.self_score != null)        lines.push(`self_score: ${meta.self_score}`);
  if (meta.heuristic_score != null)   lines.push(`heuristic_score: ${meta.heuristic_score}`);
  if (meta.self_reason)        lines.push(`self_reason: ${yamlScalar(meta.self_reason)}`);
  if (meta.reject_reason)      lines.push(`reject_reason: ${yamlScalar(meta.reject_reason)}`);
  if (meta.edited)             lines.push(`edited: true`);
  lines.push('---', '', `# ${meta.title || 'Untitled insight'}`, '', body.trim(), '');
  return lines.join('\n');
}

function readInsight(state, filename) {
  const full = path.join(dirFor(state), filename);
  let text;
  try { text = fs.readFileSync(full, 'utf8'); }
  catch (err) { return { ok: false, error: err.code === 'ENOENT' ? 'not_found' : err.message }; }
  const { fm, body } = parseFrontmatter(text);
  const stats = fs.statSync(full);
  return {
    ok: true,
    file: filename,
    state,
    path: full,
    meta: fm,
    body,
    size: stats.size,
    mtime: stats.mtimeMs,
  };
}

function listPending() {
  ensureDirs();
  const dir = dirFor('pending');
  let entries;
  try { entries = fs.readdirSync(dir); }
  catch { return []; }

  return entries
    .filter(f => f.endsWith('.md'))
    .map(f => readInsight('pending', f))
    .filter(r => r.ok)
    .sort((a, b) => b.mtime - a.mtime); // newest first
}

function counts() {
  ensureDirs();
  const c = { pending: 0, approved: 0, rejected: 0 };
  for (const state of Object.keys(c)) {
    try { c[state] = fs.readdirSync(dirFor(state)).filter(f => f.endsWith('.md')).length; } catch {}
  }
  return c;
}

function approve(filename, { reviewer, edits } = {}) {
  ensureDirs();
  const src = path.join(dirFor('pending'), filename);
  if (!fs.existsSync(src)) return { ok: false, error: 'not_found' };

  const text = fs.readFileSync(src, 'utf8');
  const { fm, body } = parseFrontmatter(text);

  const next = {
    ...fm,
    state:        'approved',
    reviewed_at:  new Date().toISOString(),
    reviewer:     reviewer || 'dashboard',
  };
  let nextBody = body;

  if (edits && typeof edits === 'object') {
    if (typeof edits.title === 'string' && edits.title.trim())    { next.title = edits.title.trim(); next.edited = true; }
    if (typeof edits.body  === 'string' && edits.body.trim())     { nextBody   = edits.body;          next.edited = true; }
    if (typeof edits.category === 'string' && edits.category.trim()) { next.category = edits.category.trim(); next.edited = true; }
  }

  const dest = path.join(dirFor('approved'), filename);
  try {
    fs.writeFileSync(dest, renderFile(next, nextBody), 'utf8');
    fs.unlinkSync(src);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  return { ok: true, file: filename, dest, edited: !!next.edited, title: next.title };
}

function reject(filename, { reviewer, reason } = {}) {
  ensureDirs();
  const src = path.join(dirFor('pending'), filename);
  if (!fs.existsSync(src)) return { ok: false, error: 'not_found' };

  const text = fs.readFileSync(src, 'utf8');
  const { fm, body } = parseFrontmatter(text);

  const next = {
    ...fm,
    state:         'rejected',
    reviewed_at:   new Date().toISOString(),
    reviewer:      reviewer || 'dashboard',
    reject_reason: (reason || '').slice(0, 500) || 'no reason given',
  };

  const dest = path.join(dirFor('rejected'), filename);
  try {
    fs.writeFileSync(dest, renderFile(next, body), 'utf8');
    fs.unlinkSync(src);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  return { ok: true, file: filename, dest, reason: next.reject_reason };
}

// Periodic cleanup — call from index.js or a scheduler. Deletes rejected files
// older than REJECT_RETENTION_DAYS. Returns the count removed.
function pruneRejected() {
  ensureDirs();
  const dir = dirFor('rejected');
  const cutoff = Date.now() - REJECT_RETENTION_DAYS * 86400_000;
  let removed = 0;
  let files;
  try { files = fs.readdirSync(dir); } catch { return 0; }
  for (const f of files) {
    if (!f.endsWith('.md')) continue;
    const full = path.join(dir, f);
    try {
      if (fs.statSync(full).mtimeMs < cutoff) { fs.unlinkSync(full); removed++; }
    } catch {}
  }
  return removed;
}

// Promote an insight that's already been written to pending/ — used by the
// AUTO-mode validator (no human reviewer involved). Records validator
// provenance in the frontmatter for full audit trail.
function autoApprove(filename, validatorResult) {
  ensureDirs();
  const src = path.join(dirFor('pending'), filename);
  if (!fs.existsSync(src)) return { ok: false, error: 'not_found' };

  const text = fs.readFileSync(src, 'utf8');
  const { fm, body } = parseFrontmatter(text);
  const next = {
    ...fm,
    state:           'approved',
    reviewed_at:     new Date().toISOString(),
    reviewer:        validatorResult.validator || 'auto',
    auto_approved:   true,
    self_score:      validatorResult.self_score,
    heuristic_score: validatorResult.heuristic_score,
    self_reason:     validatorResult.reason,
  };
  const dest = path.join(dirFor('approved'), filename);
  try {
    fs.writeFileSync(dest, renderFile(next, body), 'utf8');
    fs.unlinkSync(src);
  } catch (err) { return { ok: false, error: err.message }; }
  return { ok: true, file: filename, dest };
}

function autoReject(filename, validatorResult) {
  ensureDirs();
  const src = path.join(dirFor('pending'), filename);
  if (!fs.existsSync(src)) return { ok: false, error: 'not_found' };

  const text = fs.readFileSync(src, 'utf8');
  const { fm, body } = parseFrontmatter(text);
  const next = {
    ...fm,
    state:            'rejected',
    reviewed_at:      new Date().toISOString(),
    reviewer:         validatorResult.validator || 'auto',
    auto_rejected:    true,
    self_score:       validatorResult.self_score,
    heuristic_score:  validatorResult.heuristic_score,
    reject_reason:    (validatorResult.reason || 'auto-rejected').slice(0, 500),
  };
  const dest = path.join(dirFor('rejected'), filename);
  try {
    fs.writeFileSync(dest, renderFile(next, body), 'utf8');
    fs.unlinkSync(src);
  } catch (err) { return { ok: false, error: err.message }; }
  return { ok: true, file: filename, dest };
}

module.exports = {
  kbDir, dirFor, readInsight, listPending, counts, approve, reject, autoApprove, autoReject,
  pruneRejected, REJECT_RETENTION_DAYS,
};
