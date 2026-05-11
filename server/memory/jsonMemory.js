'use strict';

/**
 * JSON file-based memory backend.
 * Stores indexed agent learnings at ~/.prevoyant/memory/index.json.
 * Used as a local fallback when Redis is unavailable or disabled.
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const AGENTS     = ['morgan', 'alex', 'sam', 'jordan', 'henk', 'riley', 'bryan'];
const CONF_SCORE = { high: 3, medium: 2, med: 2, low: 1 };

// ── Config ─────────────────────────────────────────────────────────────────────

function isEnabled() {
  return (process.env.PRX_MEMORY_INDEX_ENABLED || 'Y') !== 'N';
}

function indexPath() {
  return path.join(os.homedir(), '.prevoyant', 'memory', 'index.json');
}

function kbBaseDir() {
  const mode = process.env.PRX_KB_MODE || 'local';
  return mode === 'distributed'
    ? (process.env.PRX_KB_LOCAL_CLONE || path.join(os.homedir(), '.prevoyant', 'kb'))
    : (process.env.PRX_KNOWLEDGE_DIR  || path.join(os.homedir(), '.prevoyant', 'knowledge-base'));
}

// ── Index I/O ──────────────────────────────────────────────────────────────────

let _data  = null;
let _dirty = false;

function emptyIndex() { return { version: 1, learnings: [], indexed: {} }; }

function loadIndex() {
  if (_data) return _data;
  try { _data = JSON.parse(fs.readFileSync(indexPath(), 'utf8')); }
  catch (_) { _data = emptyIndex(); }
  _data.indexed   = _data.indexed   || {};
  _data.learnings = _data.learnings || [];
  return _data;
}

function saveIndex() {
  if (!_dirty || !_data) return;
  try {
    const p = indexPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(_data));
    _dirty = false;
  } catch (err) { console.warn(`[json-memory] Save failed: ${err.message}`); }
}

process.on('exit', saveIndex);

// ── Markdown parsing (shared with redisMemory) ────────────────────────────────

function extractSection(lines, headerRe) {
  let in_ = false;
  const out = [];
  for (const line of lines) {
    if (!in_) { if (headerRe.test(line)) in_ = true; }
    else { if (/^##\s+/.test(line)) break; out.push(line); }
  }
  return out;
}

function parseLearnings(lines) {
  const rows = [];
  for (const line of extractSection(lines, /##\s+What I Learned/i)) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').map(c => c.trim()).filter(Boolean);
    if (cells.length < 4) continue;
    if (cells[0] === '#' || /^-+$/.test(cells[0]) || cells[1] === 'Observation') continue;
    const [, obs, cat, conf, outcome] = cells;
    if (!obs || obs.startsWith('{')) continue;
    rows.push({ content: obs, category: (cat || '').trim(), confidence: (conf || '').trim(), outcome: (outcome || '').trim() });
  }
  return rows;
}

function parseSurprises(lines) {
  return extractSection(lines, /##\s+Things That Surprised Me/i)
    .filter(l => l.trim().startsWith('- ') && !l.includes('{Surprise'))
    .map(l => l.trim().slice(2).trim()).filter(Boolean);
}

function parseRunningNotes(lines) {
  return extractSection(lines, /##\s+Running Notes/i)
    .filter(l => l.trim().startsWith('- ') && !l.includes('{Note'))
    .map(l => l.trim().slice(2).trim()).filter(Boolean);
}

module.exports._parsers = { parseLearnings, parseSurprises, parseRunningNotes, extractSection };

// ── Indexing ───────────────────────────────────────────────────────────────────

function indexSession(ticketKey, { components = [], labels = [] } = {}) {
  if (!isEnabled()) return 0;
  if ((process.env.PRX_KB_MODE || 'local') === 'distributed' && process.env.PRX_KB_KEY) return 0;

  const data  = loadIndex();
  const base  = path.join(kbBaseDir(), 'personas', 'memory');
  const comps = components.map(c => c.toLowerCase());
  const labs  = labels.map(l => l.toLowerCase());
  let added   = 0;

  for (const agent of AGENTS) {
    const agentDir = path.join(base, agent);
    let files;
    try { files = fs.readdirSync(agentDir); } catch (_) { continue; }

    for (const file of files) {
      if (!file.endsWith('.md')) continue;
      if (ticketKey && !file.toUpperCase().includes(ticketKey.toUpperCase())) continue;

      const stem  = file.slice(0, -3);
      const idKey = `${agent}__${stem}`;
      if (data.indexed[idKey]) continue;

      try {
        const lines       = fs.readFileSync(path.join(agentDir, file), 'utf8').split('\n');
        const dateMatch   = stem.match(/^(\d{8})/);
        const date        = dateMatch ? dateMatch[1] : '';
        const tKey        = ticketKey || stem.replace(/^\d{8}-?/, '');

        const push = (obj) => { data.learnings.push(obj); added++; };

        parseLearnings(lines).forEach((r, i) => push({
          id: `${idKey}__${i}`, agent, ticketKey: tKey, date,
          content: r.content, category: r.category, confidence: r.confidence, outcome: r.outcome,
          type: 'learning', components: comps, labels: labs,
        }));

        parseSurprises(lines).forEach((s, i) => push({
          id: `${idKey}__s${i}`, agent, ticketKey: tKey, date,
          content: s, category: 'SURPRISE', confidence: 'High', outcome: '',
          type: 'surprise', components: comps, labels: labs,
        }));

        parseRunningNotes(lines).forEach((n, i) => push({
          id: `${idKey}__n${i}`, agent, ticketKey: tKey, date,
          content: n, category: 'NOTE', confidence: 'High', outcome: '',
          type: 'note', components: comps, labels: labs,
        }));

        data.indexed[idKey] = true;
      } catch (_) { /* skip unreadable */ }
    }
  }

  if (added > 0) { _dirty = true; saveIndex(); }
  return added;
}

// Walk <KB>/hermes-insights/approved/ and index each approved insight as a
// 'learning' entry. Frontmatter is parsed inline to avoid pulling the heavier
// reviewer module into the memory layer. Skipped when KB is in distributed mode
// without a key (mirrors indexSession's guard).
function indexHermesInsights() {
  if (!isEnabled()) return 0;
  if ((process.env.PRX_KB_MODE || 'local') === 'distributed' && process.env.PRX_KB_KEY) return 0;

  const dir = path.join(kbBaseDir(), 'hermes-insights', 'approved');
  let files;
  try { files = fs.readdirSync(dir); } catch { return 0; }

  const data = loadIndex();
  let added = 0;

  for (const file of files) {
    if (!file.endsWith('.md')) continue;
    const idKey = `hermes-insight__${file.slice(0, -3)}`;
    if (data.indexed[idKey]) continue;

    let text;
    try { text = fs.readFileSync(path.join(dir, file), 'utf8'); }
    catch { continue; }

    // Minimal frontmatter parse — same shape as insightsReview.js writes.
    const fmMatch = text.match(/^---\n([\s\S]*?)\n---\n?/);
    if (!fmMatch) continue;
    const fm = {};
    for (const line of fmMatch[1].split('\n')) {
      const i = line.indexOf(':');
      if (i < 0) continue;
      const key = line.slice(0, i).trim();
      let val = line.slice(i + 1).trim();
      if (val.startsWith('[') && val.endsWith(']')) {
        val = val.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
      } else if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      fm[key] = val;
    }
    const body = text.slice(fmMatch[0].length).trim();
    const titleMatch = body.match(/^#\s+(.+)\n+/);
    const title = titleMatch ? titleMatch[1].trim() : 'Untitled';
    const content = (titleMatch ? body.slice(titleMatch[0].length) : body).trim();
    const tickets = Array.isArray(fm.tickets) ? fm.tickets : (fm.tickets ? [fm.tickets] : []);
    const tags    = Array.isArray(fm.tags)    ? fm.tags    : (fm.tags    ? [fm.tags]    : []);
    const date    = (file.match(/^(\d{4})-(\d{2})-(\d{2})/) || []).slice(1).join('') || '';

    data.learnings.push({
      id:         idKey,
      agent:      'hermes',
      ticketKey:  tickets[0] || 'cross-ticket',
      date,
      content:    `**${title}**\n\n${content}`.slice(0, 4000),
      category:   (fm.category || 'insight').toUpperCase(),
      confidence: (fm.confidence || 'Medium').replace(/^./, c => c.toUpperCase()),
      outcome:    '',
      type:       'learning',
      components: [],
      labels:     tags.map(String).map(t => t.toLowerCase()),
      tickets,
    });

    data.indexed[idKey] = true;
    added++;
  }

  if (added > 0) { _dirty = true; saveIndex(); }
  return added;
}

function indexAllNew() {
  let n = indexSession(null);
  try { n += indexHermesInsights(); } catch (err) { console.warn('[jsonMemory] indexHermesInsights failed:', err.message); }
  return n;
}

// ── Query ──────────────────────────────────────────────────────────────────────

function query({ components = [], labels = [], ticketKey = null, limit = 15 } = {}) {
  if (!isEnabled()) return { learnings: [], surprises: [], notes: [], total: 0 };
  const data     = loadIndex();
  const compSet  = new Set(components.map(c => c.toLowerCase()));
  const labelSet = new Set(labels.map(l => l.toLowerCase()));
  const hasFilter = compSet.size > 0 || labelSet.size > 0;

  function scoreEntry(l) {
    let s = 0;
    for (const c  of (l.components || [])) if (compSet.has(c))  s += 3;
    for (const lb of (l.labels     || [])) if (labelSet.has(lb)) s += 1;
    s += CONF_SCORE[(l.confidence || '').toLowerCase()] || 0;
    const d = parseInt(l.date || '0', 10);
    if (d > 20200000) s += (d - 20200000) / 10_000_000;
    return s;
  }

  function pick(type, cap) {
    const pool = data.learnings.filter(l => l.type === type && l.ticketKey !== ticketKey);
    let ranked = pool.map(l => ({ ...l, _score: scoreEntry(l) }))
      .filter(l => !hasFilter || l._score > 0)
      .sort((a, b) => b._score - a._score);
    // Pad with recent entries when filter yields too few
    if (hasFilter && ranked.length < 3 && pool.length > ranked.length) {
      const seen = new Set(ranked.map(l => l.id));
      ranked = [...ranked, ...pool.filter(l => !seen.has(l.id))
        .map(l => ({ ...l, _score: scoreEntry(l) })).sort((a, b) => b._score - a._score)
        .slice(0, cap - ranked.length)];
    }
    return ranked.slice(0, cap);
  }

  const learnings = pick('learning', limit);
  const surprises = pick('surprise', 5);
  const notes     = pick('note', 5);
  const total     = data.learnings.filter(l => l.type === 'learning').length;

  return { learnings, surprises, notes, total };
}

// ── Stats ──────────────────────────────────────────────────────────────────────

function stats() {
  try {
    const data = loadIndex();
    return {
      enabled:      isEnabled(),
      backend:      'json',
      connected:    true,
      total:        data.learnings.filter(l => l.type === 'learning').length,
      surprises:    data.learnings.filter(l => l.type === 'surprise').length,
      notes:        data.learnings.filter(l => l.type === 'note').length,
      indexedFiles: Object.keys(data.indexed).length,
      agents:       AGENTS.length,
    };
  } catch (_) {
    return { enabled: isEnabled(), backend: 'json', connected: false, total: 0, surprises: 0, notes: 0, indexedFiles: 0, agents: 0 };
  }
}

// ── KB entry (plugin standalone mode) ─────────────────────────────────────────

function ensureKbEntry() {
  if (!isEnabled()) return;
  const sharedDir = path.join(kbBaseDir(), 'shared');
  const entryPath = path.join(sharedDir, 'memory-index.md');
  if (!fs.existsSync(sharedDir) || fs.existsSync(entryPath)) return;
  try {
    fs.writeFileSync(entryPath, [
      '## Agent Memory Index — Standalone Usage',
      '',
      'When running the skill **without the server** (standalone / plugin-only mode),',
      'call this script during Step 0b instead of reading individual persona memory files:',
      '',
      '```bash',
      'node scripts/query-memory.js \\',
      '  --ticket  PROJ-1234 \\',
      '  --components "auth,api-gateway" \\',
      '  --labels    "regression,critical" \\',
      '  --limit 15',
      '```',
      '',
      'The script outputs a compact ranked table of the most relevant cross-session',
      'learnings (~15 rows). Paste its output into the Prior Knowledge block.',
      '',
      '**Skip this step** when `<!-- KB_PRELOADED -->` is already present — the',
      'server has pre-loaded indexed memory for you.',
    ].join('\n'));
    console.log('[json-memory] Installed shared KB entry for standalone plugin use');
  } catch (_) {}
}

module.exports = { isEnabled, indexSession, indexAllNew, indexHermesInsights, query, stats, ensureKbEntry };
