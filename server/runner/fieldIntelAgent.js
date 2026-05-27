'use strict';

// Field Intelligence Agent — answers field engineer questions.
//
// Answer pipeline:
//   1. Build context from Cortex facts + KB shared files + P2P mesh observations
//   2. Run a KB-backed query via Claude CLI
//   3. If the answer is thin (KB miss), auto-trigger a source-code investigation
//      in PRX_REPO_DIR — Claude reads the actual codebase, finds the answer,
//      and outputs a structured KB draft entry
//   4. Write any new KB entry to shared/field-intel.md and broadcast over P2P
//
// KB miss is detected two ways:
//   Pre-flight:  KB is structurally empty (no Cortex facts AND no KB file content)
//   Post-flight: KB query answer contains miss-indicator phrases

const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const { spawn } = require('child_process');

const cortexLayer  = require('./cortexLayer');
const kbCache      = require('../kb/kbCache');
const serverEvents = require('../serverEvents');
const { sendEmail }    = require('../notifications/email');
const browserQueue     = require('../notifications/browserQueue');

const SESSIONS_DIR = path.join(os.homedir(), '.prevoyant', 'field-sessions');

// Phrases Claude emits when the provided context doesn't cover the question
const KB_MISS_RE = /not (in|available in|covered in|found in) (the )?(provided|this|above) (context|knowledge|information)|I (don't|do not|cannot|can't) (find|have|provide) (specific |)information|no (specific |)(information|data) (about|on|for|regarding)|based on (the |)context (provided|above)[,]? I (cannot|can't|am unable)|would need (to (look at|access|examine)|access to) (the (actual |)source|the codebase|the source code)|not (explicitly |)mentioned in the|cannot (be found|answer) (based on|from) (the |)provided|the (provided|available) (context|information) does not (contain|include|cover)/i;

// ── Source readers ────────────────────────────────────────────────────────────

function readCortexFacts() {
  if (!cortexLayer.isEnabled()) return {};
  const factsDir = cortexLayer.factsDir();
  const FACTS = ['architecture', 'business-rules', 'patterns', 'decisions', 'hotspots', 'glossary'];
  const out = {};
  for (const id of FACTS) {
    const fp = path.join(factsDir, `${id}.md`);
    try { out[id] = fs.readFileSync(fp, 'utf8').trim(); }
    catch (_) {}
  }
  return out;
}

function readKbFiles() {
  const cache = kbCache.get();
  const WANT = [
    'shared/field-intel.md',
    'shared/patterns.md',
    'shared/architecture.md',
    'shared/business-rules.md',
    'shared/glossary.md',
  ];
  const out = {};
  for (const key of WANT) {
    if (cache[key] && cache[key].trim().length > 50) out[key] = cache[key];
  }
  return out;
}

function readMeshObservations(limit = 30) {
  if (process.env.PRX_CORTEX_P2P_ENABLED !== 'Y') return [];
  try {
    const mem = cortexLayer.memory();
    let obs = mem.list({ tag: 'field-intel' });
    if (!obs.length) obs = mem.list({ tag: 'agent-observed' });
    obs.sort((a, b) => {
      const ca = (a.value && a.value.confirmCount) || 1;
      const cb = (b.value && b.value.confirmCount) || 1;
      return cb !== ca ? cb - ca : (b.ts || 0) - (a.ts || 0);
    });
    return obs.slice(0, limit).map(o => ({
      key:          o.key,
      summary:      o.summary || (o.value && o.value.summary) || '',
      confirmCount: (o.value && o.value.confirmCount) || 1,
      ts:           o.ts,
    }));
  } catch (_) {
    return [];
  }
}

// ── KB miss detection ─────────────────────────────────────────────────────────

// Pre-flight: KB has no meaningful content at all (skip KB query entirely)
function _kbIsEmpty(facts, kbFiles) {
  return Object.keys(facts).length === 0 && Object.keys(kbFiles).length === 0;
}

// Post-flight: KB query returned a thin / miss answer
function _isMissAnswer(text) {
  return KB_MISS_RE.test(text);
}

// ── Prompt builders ───────────────────────────────────────────────────────────

function _buildKbPrompt({ question, facts, kbFiles, meshObs, fieldPersona, history }) {
  const lines = [];
  lines.push('You are the Prevoyant AI team answering a field question from a field engineer.');
  lines.push('The engineer specialises in txswitch hub events, circuit commissioning, and on-site diagnostics.');
  lines.push('');
  lines.push('Answer using ONLY the knowledge provided below.');
  lines.push('If the answer is not in the provided context, say clearly: "This is not in the provided context."');
  lines.push('Be direct, concrete, and precise. Cite which KB source your answer comes from when relevant.');
  if (history.length) lines.push('This is a follow-up. Read the conversation history first.');
  lines.push('');

  if (fieldPersona) {
    lines.push('## Field Engineer Profile');
    lines.push(fieldPersona.slice(0, 800));
    lines.push('');
  }

  const factKeys = Object.keys(facts);
  if (factKeys.length) {
    lines.push('## Cortex — Pre-digested KB Facts');
    for (const id of factKeys) {
      lines.push(`### ${id}`);
      lines.push(facts[id].slice(0, 1200));
      lines.push('');
    }
  }

  for (const key of Object.keys(kbFiles)) {
    lines.push(`## KB: ${key}`);
    lines.push(kbFiles[key].slice(0, 2000));
    lines.push('');
  }

  if (meshObs.length) {
    lines.push('## P2P Mesh — Confirmed Observations');
    for (const o of meshObs.slice(0, 15))
      lines.push(`- [confirms:${o.confirmCount}] ${o.summary}`);
    lines.push('');
  }

  if (history.length) {
    lines.push('## Conversation so far');
    for (const t of history) {
      lines.push(`**${t.role === 'field' ? 'Field Engineer' : 'Team'}:** ${t.content.trim()}`);
      lines.push('');
    }
  }

  lines.push('---');
  lines.push("## Field engineer's question");
  lines.push(question.trim());
  return lines.join('\n');
}

function _buildInvestigationPrompt({ question, history, repoDir }) {
  const histBlock = history.length
    ? '## Prior conversation\n' + history.map(t =>
        `**${t.role === 'field' ? 'Field Engineer' : 'Team'}:** ${t.content.trim()}`
      ).join('\n\n') + '\n\n'
    : '';

  return [
    'You are a senior developer investigating the source code to answer a precise field question from a field engineer.',
    'The team knowledge base did not have this information. Read the actual source code to find the answer.',
    '',
    histBlock,
    '## Field question',
    question.trim(),
    '',
    '## Your task',
    `1. The source repository is at: ${repoDir}`,
    '2. Use Read and Bash tools (grep, find) to locate the relevant source files.',
    '3. Read the implementation — find the actual code that governs the behaviour described.',
    '4. Synthesise a precise, factual answer grounded in what the code actually does.',
    '5. At the END of your response, output a KB draft entry in EXACTLY this format',
    '   (do not change the delimiters):',
    '',
    '---FIELD-INTEL-START---',
    '## [Short descriptive title]',
    '',
    '**Question:** [field engineer\'s exact question]',
    '',
    '**Answer from source:** [Precise answer derived from the code]',
    '',
    '**Relevant files:**',
    '- `path/to/file:line` — [what this does]',
    '',
    '**Tags:** code-investigation, [other relevant tags]',
    '---FIELD-INTEL-END---',
  ].join('\n');
}

// ── Shared Claude spawner ─────────────────────────────────────────────────────

function _spawnClaude(prompt, cwd, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      'claude',
      ['--dangerously-skip-permissions', '--print', prompt, '--output-format', 'text'],
      {
        cwd,
        env: { ...process.env, AUTO_MODE: 'Y' },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );

    let out = '';
    let err = '';
    proc.stdout.on('data', c => { out += c.toString(); });
    proc.stderr.on('data', c => { err += c.toString(); });

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error(`Claude timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    proc.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(out.trim());
      else reject(new Error(`claude exited ${code}: ${err.slice(0, 300)}`));
    });

    proc.on('error', e => {
      clearTimeout(timer);
      reject(new Error(`Failed to spawn claude: ${e.message}`));
    });
  });
}

// ── KB entry writer ───────────────────────────────────────────────────────────

// Extract the ---FIELD-INTEL-START--- block from investigation output
function _parseIntelEntry(text) {
  const m = text.match(/---FIELD-INTEL-START---([\s\S]*?)---FIELD-INTEL-END---/);
  return m ? m[1].trim() : null;
}

// Write a draft KB entry from a code investigation into shared/field-intel.md
function _writeInvestigationEntry(entryMarkdown, question) {
  const kbDir     = kbCache.kbDir();
  const sharedDir = path.join(kbDir, 'shared');
  const filePath  = path.join(sharedDir, 'field-intel.md');

  try { fs.mkdirSync(sharedDir, { recursive: true }); } catch (_) {}

  const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ') + ' UTC';
  const block = [
    `<!-- code-investigation · ${stamp} -->`,
    entryMarkdown,
    '',
    '> [DRAFT — code investigation, pending human review]',
    '',
    '---',
    '',
  ].join('\n');

  let existing = '';
  try { existing = fs.readFileSync(filePath, 'utf8'); } catch (_) {}
  if (!existing.trim()) {
    existing = '# Field Intelligence Log\n\n> Entries logged via the Field Assistant. Each entry is peer-reviewed and promoted to shared KB patterns once verified.\n\n---\n\n';
  }

  const insertAt = (() => {
    const i = existing.indexOf('\n---\n');
    return i >= 0 ? i + 5 : existing.length;
  })();

  fs.writeFileSync(filePath, existing.slice(0, insertAt) + block + existing.slice(insertAt), 'utf8');
  kbCache.invalidate();
  return filePath;
}

// ── P2P broadcast ─────────────────────────────────────────────────────────────

function _broadcastObservation(summary, tags = []) {
  if (process.env.PRX_P2P_ENABLED !== 'Y' || process.env.PRX_CORTEX_P2P_ENABLED !== 'Y') return;
  try {
    const mem = cortexLayer.memory();
    const key = `field-intel-inv-${Date.now()}`;
    mem.observe({
      key,
      summary,
      type:    'field-intel',
      persona: 'field-engineer',
      tags:    ['field-intel', 'code-investigation', ...tags],
      value:   { summary, investigatedAt: new Date().toISOString() },
    });
    serverEvents.emit('cortex-obs-broadcast', { key });
  } catch (e) {
    console.warn('[fieldIntelAgent] P2P broadcast failed (non-fatal):', e.message);
  }
}

// ── Public: build query context (used by tests / diagnostics) ─────────────────

function buildQueryContext(question, history = []) {
  const facts    = readCortexFacts();
  const kbFiles  = readKbFiles();
  const meshObs  = readMeshObservations();

  let fieldPersona = '';
  try {
    fieldPersona = fs.readFileSync(
      path.resolve(__dirname, '../../plugin/config/personas/field-engineer.md'), 'utf8'
    );
  } catch (_) {}

  const cappedHistory = history.slice(-20);
  const prompt = _buildKbPrompt({ question, facts, kbFiles, meshObs, fieldPersona, history: cappedHistory });

  const sources = [];
  if (Object.keys(facts).length)   sources.push({ id: 'cortex', label: 'Cortex facts' });
  if (Object.keys(kbFiles).length) sources.push({ id: 'kb',     label: 'KB shared files' });
  if (meshObs.length)              sources.push({ id: 'mesh',   label: `P2P mesh (${meshObs.length} observations)` });

  return { prompt, sources, factCount: Object.keys(facts).length, kbFileCount: Object.keys(kbFiles).length };
}

// ── Public: run a field query ─────────────────────────────────────────────────

/**
 * Answer the field engineer's question.
 * Auto-triggers a source-code investigation if the KB has no relevant answer.
 *
 * Returns:
 *   { answer, sources, investigated, kbEntryAdded }
 *
 * @param {string} question
 * @param {Array}  history   — prior turns [{ role, content }], oldest first
 */
async function runFieldQuery(question, history = []) {
  const facts    = readCortexFacts();
  const kbFiles  = readKbFiles();
  const meshObs  = readMeshObservations();
  const cappedHistory = history.slice(-20);

  let fieldPersona = '';
  try {
    fieldPersona = fs.readFileSync(
      path.resolve(__dirname, '../../plugin/config/personas/field-engineer.md'), 'utf8'
    );
  } catch (_) {}

  const kbSources = [];
  if (Object.keys(facts).length)   kbSources.push({ id: 'cortex', label: 'Cortex facts' });
  if (Object.keys(kbFiles).length) kbSources.push({ id: 'kb',     label: 'KB shared files' });
  if (meshObs.length)              kbSources.push({ id: 'mesh',   label: `P2P mesh (${meshObs.length} observations)` });

  const kbEmpty = _kbIsEmpty(facts, kbFiles);
  let kbAnswer  = null;
  let miss      = kbEmpty; // pre-flight: skip KB query entirely if nothing to query

  if (!kbEmpty) {
    // Run KB-backed query
    const prompt = _buildKbPrompt({ question, facts, kbFiles, meshObs, fieldPersona, history: cappedHistory });
    kbAnswer = await _spawnClaude(prompt, path.resolve(__dirname, '../..'), 120000);
    miss = _isMissAnswer(kbAnswer);
  }

  // ── KB hit: return immediately ────────────────────────────────────────────
  if (!miss) {
    return { answer: kbAnswer, sources: kbSources, investigated: false, kbEntryAdded: false };
  }

  // ── KB miss: auto-trigger source-code investigation ───────────────────────
  const repoDir = process.env.PRX_REPO_DIR;
  if (!repoDir) {
    // No repo configured — return the thin KB answer (or a clear message) with a hint
    const fallback = kbAnswer
      ? kbAnswer + '\n\n> *Source-code investigation skipped — set PRX_REPO_DIR in .env to enable it.*'
      : 'The knowledge base does not have information on this topic. Set PRX_REPO_DIR in .env to enable automatic source-code investigation.';
    return { answer: fallback, sources: kbSources, investigated: false, kbEntryAdded: false };
  }

  if (!fs.existsSync(repoDir)) {
    const fallback = (kbAnswer || 'No KB context available.') +
      `\n\n> *Source-code investigation skipped — PRX_REPO_DIR (${repoDir}) does not exist.*`;
    return { answer: fallback, sources: kbSources, investigated: false, kbEntryAdded: false };
  }

  // Run investigation (longer timeout — Claude needs to read files)
  const invPrompt = _buildInvestigationPrompt({ question, history: cappedHistory, repoDir });
  const invOutput = await _spawnClaude(invPrompt, repoDir, 240000);

  // Strip the KB entry block from the answer shown to the field engineer
  const answerForField = invOutput
    .replace(/---FIELD-INTEL-START---[\s\S]*?---FIELD-INTEL-END---/g, '')
    .trim();

  // Parse and persist the KB entry
  const entry = _parseIntelEntry(invOutput);
  let kbEntryAdded = false;
  if (entry) {
    try {
      _writeInvestigationEntry(entry, question);
      kbEntryAdded = true;
      // Derive a short summary for the P2P observation from the first meaningful line
      const summaryLine = entry.split('\n').find(l => l.startsWith('##')) || question.slice(0, 100);
      _broadcastObservation(`[CODE INVESTIGATION] ${summaryLine.replace(/^#+\s*/, '')}`, ['code-investigation']);
    } catch (writeErr) {
      console.warn('[fieldIntelAgent] KB entry write failed (non-fatal):', writeErr.message);
    }
  }

  const invSources = [
    ...kbSources,
    { id: 'investigation', label: 'Source code investigation' },
    ...(kbEntryAdded ? [{ id: 'kb-draft', label: 'Draft added to KB' }] : []),
  ];

  return { answer: answerForField, sources: invSources, investigated: true, kbEntryAdded };
}

// ── Public: write a manual field log entry ────────────────────────────────────

function writeFieldIntelLog({ symptom, rootCause, fix, tags = [], jiraKey = '', jiraUrl = '', jiraSummary = '', jiraStatus = '', jiraPriority = '', jiraIssueType = '', component = '', obsKey = '' }) {
  const kbDir     = kbCache.kbDir();
  const sharedDir = path.join(kbDir, 'shared');
  const filePath  = path.join(sharedDir, 'field-intel.md');

  try { fs.mkdirSync(sharedDir, { recursive: true }); } catch (_) {}

  const stamp  = new Date().toISOString().slice(0, 19).replace('T', ' ') + ' UTC';
  const tagStr = tags.length ? tags.map(t => `\`${t}\``).join(' ') : '';

  // Machine-parseable meta comment for Cortex/mesh indexing
  const metaParts = [
    jiraKey       && `jira:${jiraKey}`,
    jiraStatus    && `status:${jiraStatus}`,
    jiraPriority  && `priority:${jiraPriority}`,
    jiraIssueType && `type:${jiraIssueType}`,
    component     && `component:${component}`,
    obsKey        && `obs:${obsKey}`,
    'logged-by:field-engineer',
  ].filter(Boolean);

  const jiraRef = jiraKey
    ? (jiraUrl ? `[${jiraKey}](${jiraUrl})` : jiraKey)
    : '';
  const jiraMeta = [jiraIssueType, jiraPriority, jiraStatus].filter(Boolean).join(' · ');

  const lines = [
    `## ${stamp}${jiraKey ? ' · ' + jiraKey : ''}${component ? ' · ' + component : ''}`,
    '',
    `<!-- ${metaParts.join(' | ')} -->`,
    '',
    ...(jiraRef  ? [`**Jira:** ${jiraRef}${jiraSummary ? ' — ' + jiraSummary : ''}`, ''] : []),
    ...(jiraMeta ? [`**Type/Status:** ${jiraMeta}`, ''] : []),
    `**Symptom:** ${symptom.trim()}`,
    '',
    `**Root cause:** ${rootCause.trim()}`,
    '',
    `**Fix applied:** ${fix.trim()}`,
    '',
  ];
  if (tagStr) lines.push(`**Tags:** ${tagStr}`, '');
  lines.push('[FIELD VERIFIED pending]', '', '---', '');

  let existing = '';
  try { existing = fs.readFileSync(filePath, 'utf8'); } catch (_) {}
  if (!existing.trim()) {
    existing = '# Field Intelligence Log\n\n> Entries logged via the Field Assistant. Each entry is peer-reviewed and promoted to shared KB patterns once verified.\n\n---\n\n';
  }

  const insertAt = (() => {
    const i = existing.indexOf('\n---\n');
    return i >= 0 ? i + 5 : existing.length;
  })();

  fs.writeFileSync(filePath, existing.slice(0, insertAt) + lines.join('\n') + existing.slice(insertAt), 'utf8');
  kbCache.invalidate();
  return { ok: true, path: filePath };
}

// ── Public: AI synthesis from Jira ticket ─────────────────────────────────────

async function synthesiseFromJira({ key, summary, description, comments = [], component = '', issueType = '', priority = '', status = '' }) {
  const commentBlock = comments.length
    ? 'Comments:\n' + comments.map((c, i) => `[${i + 1}] ${c}`).join('\n\n')
    : '';

  const prompt = [
    'You are creating a KB entry from a Jira ticket for a field engineering team working on txswitch hub installations.',
    'Extract or infer the following fields. Be concise and factual.',
    '',
    `Ticket: ${key}  Summary: ${summary}`,
    ...(issueType || priority || status ? [`Context: ${[issueType, priority, status].filter(Boolean).join(' | ')}`] : []),
    '',
    'Description:',
    description || '(no description)',
    '',
    ...(commentBlock ? [commentBlock, ''] : []),
    'Respond with ONLY valid JSON — no markdown fences, no extra text:',
    '{',
    '  "symptom": "What was observed on-site. Include alarm codes, error messages, or specific behaviour. 2–4 sentences.",',
    '  "rootCause": "The underlying technical cause. 1–2 sentences. Append (inferred) if not explicitly stated.",',
    '  "fix": "Exactly what was done to resolve the issue. 1–2 sentences.",',
    '  "component": "Specific subsystem or component affected. One short phrase.",',
    '  "tags": ["tag1", "tag2"]',
    '}',
  ].join('\n');

  const raw = await _spawnClaude(prompt, path.resolve(__dirname, '../..'), 90000);

  // Extract the JSON object — Claude may wrap it in prose or code fences
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON in synthesis response');
  const parsed = JSON.parse(match[0]);

  return {
    symptom:   String(parsed.symptom   || '').trim().slice(0, 800),
    rootCause: String(parsed.rootCause || '').trim().slice(0, 800),
    fix:       String(parsed.fix       || '').trim().slice(0, 800),
    component: String(parsed.component || '').trim().slice(0, 100),
    tags: Array.isArray(parsed.tags)
      ? parsed.tags.map(t => String(t).trim().toLowerCase().replace(/\s+/g, '-').slice(0, 40)).filter(Boolean).slice(0, 8)
      : [],
  };
}

// ── Public: session persistence ───────────────────────────────────────────────

function listSessions(limit = 50) {
  try { fs.mkdirSync(SESSIONS_DIR, { recursive: true }); } catch (_) {}
  let files;
  try { files = fs.readdirSync(SESSIONS_DIR); } catch (_) { return []; }
  return files
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8')); }
      catch (_) { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => (b.ts || 0) - (a.ts || 0))
    .slice(0, limit);
}

function saveSession({ question, answer, sources, turns = null }) {
  try { fs.mkdirSync(SESSIONS_DIR, { recursive: true }); } catch (_) {}
  const ts   = Date.now();
  const id   = `session-${ts}`;
  const file = path.join(SESSIONS_DIR, `${id}.json`);
  const record = turns
    ? { id, ts, question, turns, sources }
    : { id, ts, question, answer, sources };
  fs.writeFileSync(file, JSON.stringify(record, null, 2), 'utf8');
  return id;
}

// ── Mesh validation ───────────────────────────────────────────────────────────

// Validate a field finding against local Cortex. Called on peer nodes when they
// receive a field-intel observation. Fails open (default accept) on error.
async function validateFieldIntel({ symptom = '', rootCause = '', fix = '', component = '', tags = [] } = {}) {
  if (symptom.trim().length < 20)  return { valid: false, reason: 'Symptom description too short to be useful' };
  if (!rootCause.trim())           return { valid: false, reason: 'No root cause provided' };
  if (fix.trim().length < 10)      return { valid: false, reason: 'Fix description too brief to be actionable' };

  const facts = readCortexFacts();
  const factsBlock = Object.entries(facts)
    .filter(([, v]) => v.length > 50)
    .map(([k, v]) => `### ${k}\n${v.slice(0, 600)}`)
    .join('\n\n');

  const prompt = [
    'You are a field intelligence validator for a txswitch hub engineering team.',
    'Evaluate this field finding for technical credibility and KB value.',
    'Be lenient — a plausible finding from a field engineer should pass.',
    'Reject only if the finding is clearly incoherent, factually wrong, or too vague to be useful.',
    '',
    ...(factsBlock ? ['## System Context (Cortex)', factsBlock, ''] : []),
    '## Field Finding',
    `Component: ${component || '(not specified)'}`,
    `Symptom: ${symptom}`,
    `Root cause: ${rootCause}`,
    `Fix: ${fix}`,
    `Tags: ${tags.join(', ') || '(none)'}`,
    '',
    'Respond with ONLY valid JSON (no markdown fences, no extra text):',
    '{"valid": true, "reason": "one sentence"}',
  ].join('\n');

  try {
    const raw = await _spawnClaude(prompt, path.resolve(__dirname, '../..'), 30000);
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return { valid: true, reason: 'Validation inconclusive — defaulting to accept' };
    const parsed = JSON.parse(match[0]);
    return {
      valid:  Boolean(parsed.valid),
      reason: String(parsed.reason || 'No reason provided').trim().slice(0, 300),
    };
  } catch (e) {
    console.warn('[fieldIntelAgent] validateFieldIntel error:', e.message);
    return { valid: true, reason: 'Validation error — defaulting to accept' };
  }
}

// Update an existing KB entry's status from [FIELD VERIFIED pending] to
// [MESH VALIDATED — N nodes confirmed]. Called on the originating machine.
function markFieldIntelValidated(obsKey, confirmCount) {
  const filePath = path.join(kbCache.kbDir(), 'shared', 'field-intel.md');
  let content;
  try { content = fs.readFileSync(filePath, 'utf8'); } catch (_) { return; }
  if (!content.includes(`obs:${obsKey}`)) return;
  if (!content.includes('[FIELD VERIFIED pending]')) return;

  // Find [FIELD VERIFIED pending] that appears after obs:obsKey in the file
  const obsIdx = content.indexOf(`obs:${obsKey}`);
  const statusIdx = content.indexOf('[FIELD VERIFIED pending]', obsIdx);
  if (statusIdx === -1) return;

  content = content.slice(0, statusIdx)
    + `[MESH VALIDATED — ${confirmCount} node${confirmCount !== 1 ? 's' : ''} confirmed]`
    + content.slice(statusIdx + '[FIELD VERIFIED pending]'.length);

  fs.writeFileSync(filePath, content, 'utf8');
  kbCache.invalidate();
}

// Write a field-intel KB entry on a peer machine that has confirmed the finding.
// Idempotent — no-ops if the obsKey is already in the file.
function writePeerFieldIntelEntry(payload, confirmCount) {
  const {
    obsKey = '', symptom = '', rootCause = '', fix = '', component = '', tags = [],
    jiraKey = '', jiraUrl = '', jiraSummary = '', jiraStatus = '', jiraPriority = '', jiraIssueType = '',
  } = payload;

  const kbDir     = kbCache.kbDir();
  const sharedDir = path.join(kbDir, 'shared');
  const filePath  = path.join(sharedDir, 'field-intel.md');

  let existing = '';
  try { existing = fs.readFileSync(filePath, 'utf8'); } catch (_) {}
  if (obsKey && existing.includes(`obs:${obsKey}`)) return { ok: true, skipped: true };

  try { fs.mkdirSync(sharedDir, { recursive: true }); } catch (_) {}

  const stamp  = new Date().toISOString().slice(0, 19).replace('T', ' ') + ' UTC';
  const tagStr = tags.length ? tags.map(t => `\`${t}\``).join(' ') : '';

  const metaParts = [
    jiraKey       && `jira:${jiraKey}`,
    jiraStatus    && `status:${jiraStatus}`,
    jiraPriority  && `priority:${jiraPriority}`,
    jiraIssueType && `type:${jiraIssueType}`,
    component     && `component:${component}`,
    obsKey        && `obs:${obsKey}`,
    'logged-by:field-engineer',
  ].filter(Boolean);

  const jiraRef  = jiraKey ? (jiraUrl ? `[${jiraKey}](${jiraUrl})` : jiraKey) : '';
  const jiraMeta = [jiraIssueType, jiraPriority, jiraStatus].filter(Boolean).join(' · ');

  const lines = [
    `## ${stamp}${jiraKey ? ' · ' + jiraKey : ''}${component ? ' · ' + component : ''}`,
    '',
    `<!-- ${metaParts.join(' | ')} -->`,
    '',
    ...(jiraRef  ? [`**Jira:** ${jiraRef}${jiraSummary ? ' — ' + jiraSummary : ''}`, ''] : []),
    ...(jiraMeta ? [`**Type/Status:** ${jiraMeta}`, ''] : []),
    `**Symptom:** ${symptom.trim()}`,
    '',
    `**Root cause:** ${rootCause.trim()}`,
    '',
    `**Fix applied:** ${fix.trim()}`,
    '',
  ];
  if (tagStr) lines.push(`**Tags:** ${tagStr}`, '');
  lines.push(`[MESH VALIDATED — ${confirmCount} node${confirmCount !== 1 ? 's' : ''} confirmed]`, '', '---', '');

  if (!existing.trim()) {
    existing = '# Field Intelligence Log\n\n> Entries logged via the Field Assistant. Each entry is peer-reviewed and promoted to shared KB patterns once verified.\n\n---\n\n';
  }

  const insertAt = (() => {
    const i = existing.indexOf('\n---\n');
    return i >= 0 ? i + 5 : existing.length;
  })();

  fs.writeFileSync(filePath, existing.slice(0, insertAt) + lines.join('\n') + existing.slice(insertAt), 'utf8');
  kbCache.invalidate();
  return { ok: true };
}

// Notify the field engineer of the mesh validation outcome. Called on the originating machine only.
async function notifyFieldIntelResult({ payload = {}, valid, reason = '', confirmCount = 0 }) {
  const to = process.env.PRX_EMAIL_TO || '';
  if (!to) return;

  const {
    jiraKey = '', component = '', symptom = '', rootCause = '', fix = '',
  } = payload;

  const ref = [jiraKey, component].filter(Boolean).join(' · ') || '(no reference)';
  const status = valid ? 'ACCEPTED' : 'FLAGGED';
  const subject = `[Field Intel] ${status}: ${ref}`;

  const body = valid
    ? [
        'Field Finding Validation Result',
        '================================',
        `Status:     ACCEPTED (${confirmCount} mesh node${confirmCount !== 1 ? 's' : ''} confirmed)`,
        `Reference:  ${ref}`,
        '',
        'SYMPTOM:',
        symptom || '(none)',
        '',
        'ROOT CAUSE:',
        rootCause || '(none)',
        '',
        'FIX APPLIED:',
        fix || '(none)',
        '',
        'VALIDATION:',
        reason,
        '',
        '---',
        'This finding is now MESH VALIDATED in shared/field-intel.md.',
        'It will be promoted to the shared KB patterns on all connected nodes.',
      ].join('\n')
    : [
        'Field Finding Validation Result',
        '================================',
        'Status:     FLAGGED (inconsistency detected by mesh peer)',
        `Reference:  ${ref}`,
        '',
        'SYMPTOM:',
        symptom || '(none)',
        '',
        'REASON FLAGGED:',
        reason,
        '',
        '---',
        'The finding remains in shared/field-intel.md as [FIELD VERIFIED pending].',
        'Please review and re-submit, or correct the entry directly if the finding is accurate.',
      ].join('\n');

  // Push to browser notification queue (polled by the Field Assistant page)
  browserQueue.push({
    valid,
    ref:          [jiraKey, component].filter(Boolean).join(' · ') || null,
    reason,
    confirmCount,
    symptom:      (symptom || '').slice(0, 200),
  });

  // Also send email (async, non-blocking)
  sendEmail({ to, subject, body }).catch(e =>
    console.warn('[fieldIntelAgent] Notification email failed (non-fatal):', e.message)
  );
  console.log(`[fieldIntelAgent] Mesh validation notification queued (${status})`);
}

module.exports = { buildQueryContext, runFieldQuery, synthesiseFromJira, writeFieldIntelLog, validateFieldIntel, markFieldIntelValidated, writePeerFieldIntelEntry, notifyFieldIntelResult, listSessions, saveSession };
