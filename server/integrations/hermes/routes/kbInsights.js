'use strict';

// POST /internal/kb/insights — Hermes-contributed knowledge base entries.
//
// Hermes notices patterns across tickets ("5 tickets in 2 weeks mention the
// same Redis-auth bug") and posts them here. Prevoyant validates, writes a
// markdown file under <KB>/hermes-insights/, and records an activity-log entry
// so the contribution is traceable. The next memory-index sweep picks it up
// like any other KB file.
//
// Gated by PRX_HERMES_KB_WRITEBACK_ENABLED (default N) so it stays opt-in.
// Auth: same X-Hermes-Secret header used by /internal/enqueue.

const express = require('express');
const fs      = require('fs');
const os      = require('os');
const path    = require('path');

const config       = require('../../../config/env');
const activityLog  = require('../../../dashboard/activityLog');

const router = express.Router();

const MAX_TITLE_LEN  = 200;
const MAX_BODY_BYTES = 16_384;     // 16 KB markdown body
const MAX_TICKETS    = 50;
const MAX_TAGS       = 20;
const VALID_CATEGORIES = ['bug-pattern', 'lesson', 'playbook', 'warning', 'insight'];

function kbDir() {
  return process.env.PRX_KNOWLEDGE_DIR
    || path.join(os.homedir(), '.prevoyant', 'knowledge-base');
}

function insightsDir() {
  return path.join(kbDir(), 'hermes-insights');
}

function pendingDir() {
  return path.join(insightsDir(), 'pending');
}

function slugify(s) {
  return String(s).toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'insight';
}

// PRX_HERMES_KB_WRITEBACK_ENABLED is a tri-state:
//   N    → endpoint returns 403 (feature off)
//   AUTO → AI validator decides (approve / reject / leave pending) — default
//   Y    → every insight lands in pending/ for manual human review
function writebackMode() {
  const raw = (process.env.PRX_HERMES_KB_WRITEBACK_ENABLED || 'AUTO').trim().toUpperCase();
  if (raw === 'N')    return 'N';
  if (raw === 'Y')    return 'Y';
  return 'AUTO'; // anything else (incl. unset) → AUTO
}

// Validate the incoming insight; returns { ok, errors[], cleaned? }.
function validate(body) {
  const errors = [];
  if (!body || typeof body !== 'object') {
    return { ok: false, errors: ['body must be a JSON object'] };
  }

  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (!title) errors.push('title required (1–' + MAX_TITLE_LEN + ' chars)');
  else if (title.length > MAX_TITLE_LEN) errors.push(`title too long (${title.length} > ${MAX_TITLE_LEN})`);

  const text = typeof body.body === 'string' ? body.body : '';
  if (!text.trim()) errors.push('body required (markdown, 1–' + MAX_BODY_BYTES + ' bytes)');
  else if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) {
    errors.push(`body too large (> ${MAX_BODY_BYTES} bytes)`);
  }

  const tickets = Array.isArray(body.tickets) ? body.tickets : [];
  if (tickets.length > MAX_TICKETS) errors.push(`tickets[] too long (max ${MAX_TICKETS})`);
  const TICKET_RE = /^[A-Z][A-Z0-9_]*-\d+$/;
  const badTickets = tickets.filter(t => typeof t !== 'string' || !TICKET_RE.test(t));
  if (badTickets.length) errors.push('tickets[] entries must match KEY-1234');

  const tags = Array.isArray(body.tags) ? body.tags : [];
  if (tags.length > MAX_TAGS) errors.push(`tags[] too long (max ${MAX_TAGS})`);

  let category = typeof body.category === 'string' ? body.category.trim().toLowerCase() : 'insight';
  if (!VALID_CATEGORIES.includes(category)) category = 'insight';

  const confidence = typeof body.confidence === 'string' && ['low','medium','high'].includes(body.confidence.toLowerCase())
    ? body.confidence.toLowerCase()
    : null;

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    cleaned: { title, body: text, tickets, tags: tags.map(String), category, confidence },
  };
}

function yamlScalar(s) {
  // Quote if the string contains anything that could confuse a YAML parser.
  return /[:\n\-#"'\[\]{}*&!|>%@`]|^\s|\s$/.test(s) ? JSON.stringify(s) : s;
}

function renderFile(insight) {
  const frontmatter = [
    '---',
    'source: hermes',
    'state: pending',
    `recorded_at: ${new Date().toISOString()}`,
    `category: ${yamlScalar(insight.category)}`,
    insight.confidence ? `confidence: ${insight.confidence}` : null,
    insight.tickets.length ? `tickets: [${insight.tickets.join(', ')}]`           : null,
    insight.tags.length    ? `tags: [${insight.tags.map(yamlScalar).join(', ')}]` : null,
    '---',
    '',
    `# ${insight.title}`,
    '',
    insight.body.trim(),
    '',
  ].filter(s => s !== null).join('\n');
  return frontmatter;
}

router.post('/', express.json({ limit: '256kb' }), async (req, res) => {
  // Auth — same shared-secret check as /internal/enqueue.
  const secret = req.headers['x-hermes-secret'] || req.query.token;
  if (config.hermesSecret && secret !== config.hermesSecret) {
    console.warn('[hermes/kb-insights] Rejected — invalid secret');
    return res.status(401).json({ error: 'unauthorized' });
  }

  // Gate — feature must not be set to N.
  const mode = writebackMode();
  if (mode === 'N') {
    return res.status(403).json({
      error: 'disabled',
      hint:  'Set PRX_HERMES_KB_WRITEBACK_ENABLED=AUTO (AI validation) or =Y (manual review) to enable.',
    });
  }

  const result = validate(req.body);
  if (!result.ok) {
    return res.status(400).json({ error: 'invalid_payload', details: result.errors });
  }
  const insight = result.cleaned;

  // Step 1 — always write to pending/. This is the durable record of what
  // Hermes proposed before any validator/reviewer touches it.
  let filename, full;
  try {
    const dir = pendingDir();
    fs.mkdirSync(dir, { recursive: true });
    const date  = new Date().toISOString().slice(0, 10);
    const slug  = slugify(insight.title);
    const stamp = Date.now().toString(36).slice(-4);
    filename = `${date}-${slug}-${stamp}.md`;
    full     = path.join(dir, filename);
    fs.writeFileSync(full, renderFile(insight), 'utf8');
  } catch (err) {
    console.error('[hermes/kb-insights] Write failed:', err.message);
    return res.status(500).json({ error: 'write_failed', reason: err.message });
  }

  activityLog.record('hermes_kb_insight', null, 'hermes', {
    title:    insight.title.slice(0, 80),
    category: insight.category,
    tickets:  insight.tickets,
    file:     path.relative(kbDir(), full),
    state:    'pending',
    mode,
  });

  // Step 2 — Y mode stops here (human will decide). AUTO mode runs the AI
  // judge, then moves the file based on its verdict.
  if (mode === 'Y') {
    console.log(`[hermes/kb-insights] Pending (Y mode — manual review) → ${full}`);
    return res.status(201).json({
      status:     'pending_review',
      file:       filename,
      mode:       'Y',
      review_url: '/dashboard/hermes-insights',
      category:   insight.category,
      tickets:    insight.tickets,
    });
  }

  // AUTO mode
  let verdict;
  try {
    const validator = require('../insightsValidator');
    verdict = await validator.validate(insight);
  } catch (err) {
    console.warn('[hermes/kb-insights] Validator threw — leaving in pending/:', err.message);
    return res.status(201).json({
      status:     'pending_review',
      file:       filename,
      mode:       'AUTO',
      reason:     'validator unavailable — kicked to human review',
      review_url: '/dashboard/hermes-insights',
    });
  }

  const review = require('../insightsReview');
  if (verdict.decision === 'approve') {
    const r = review.autoApprove(filename, verdict);
    if (!r.ok) {
      console.warn('[hermes/kb-insights] autoApprove failed:', r.error);
      return res.status(500).json({ error: 'auto_approve_failed', reason: r.error });
    }
    activityLog.record('hermes_kb_insight_auto_approved', null, 'system', {
      file: filename, validator: verdict.validator, score: verdict.score, title: insight.title.slice(0, 80),
    });
    setImmediate(() => { try { require('../../../memory/memoryAdapter').indexAllNew(); } catch {} });
    console.log(`[hermes/kb-insights] AUTO-approved (${verdict.validator}, score ${verdict.score}) → ${filename}`);
    return res.status(201).json({
      status: 'approved', mode: 'AUTO', file: filename,
      validator: verdict.validator, score: verdict.score, reason: verdict.reason,
    });
  }

  if (verdict.decision === 'reject') {
    const r = review.autoReject(filename, verdict);
    if (!r.ok) return res.status(500).json({ error: 'auto_reject_failed', reason: r.error });
    activityLog.record('hermes_kb_insight_auto_rejected', null, 'system', {
      file: filename, validator: verdict.validator, score: verdict.score, reason: verdict.reason,
    });
    console.log(`[hermes/kb-insights] AUTO-rejected (${verdict.validator}, score ${verdict.score}) → ${filename}: ${verdict.reason}`);
    return res.status(201).json({
      status: 'rejected', mode: 'AUTO', file: filename,
      validator: verdict.validator, score: verdict.score, reason: verdict.reason,
    });
  }

  // verdict.decision === 'pending' — uncertain, leave for human.
  console.log(`[hermes/kb-insights] AUTO uncertain (${verdict.validator}, score ${verdict.score}) → ${filename}`);
  return res.status(201).json({
    status:     'pending_review',
    file:       filename,
    mode:       'AUTO',
    validator:  verdict.validator,
    score:      verdict.score,
    reason:     verdict.reason,
    review_url: '/dashboard/hermes-insights',
  });
});

module.exports = router;
