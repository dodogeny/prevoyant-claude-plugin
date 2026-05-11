'use strict';

// AI judge for Hermes-contributed KB insights — AUTO mode.
//
// Called from POST /internal/kb/insights when PRX_HERMES_KB_WRITEBACK_ENABLED=AUTO.
// Returns { decision: 'approve' | 'reject' | 'pending', reason, score, validator }.
//
// Two validators are tried in order:
//
//   1. **Claude judge** — if process.env.ANTHROPIC_API_KEY is set, the validator
//      asks Claude Haiku 4.5 (claude-haiku-4-5-20251001) to score the insight
//      against five criteria and return a structured JSON verdict.
//
//   2. **Heuristic** — pure rule-based scoring (length, ticket references,
//      title quality, structure). Used when no API key is available, or when
//      the Claude call errors / times out. Same scoring scale; more
//      conservative thresholds.
//
// Either way, a verdict of "pending" (uncertain) means the insight stays in the
// review queue for a human to look at — never silently dropped.

const https = require('https');

const CLAUDE_MODEL    = 'claude-haiku-4-5-20251001';
const CLAUDE_TIMEOUT  = 10_000;
const APPROVE_THRESHOLD = 7;  // score ≥ this → approve
const REJECT_THRESHOLD  = 3;  // score ≤ this → reject (anything in between → pending)

const SYSTEM_PROMPT = `You are a strict but fair editor reviewing AI-contributed knowledge-base entries for a software-engineering tool called Prevoyant.

Each entry is supposed to capture a cross-ticket pattern, lesson, playbook, or warning that future developers should know about. Bad entries dilute the KB; good entries help the team learn.

Judge the entry on five criteria, each scored 0–2:

1. **Specificity** (0–2): Does it name a concrete pattern with technical detail? Generic platitudes score 0.
2. **Evidence** (0–2): Does it reference real tickets or observable signals? Pure speculation without grounding scores 0.
3. **Actionability** (0–2): Could a developer act on this tomorrow? Vague philosophy scores 0.
4. **Originality** (0–2): Does it say something a careful reader of the linked tickets wouldn't already know? Restating ticket descriptions scores 0.
5. **Clarity** (0–2): Is the writing clear, organized, and free of hallucinated specifics? Confused or rambling text scores 0.

Sum: 0–10.

Verdict rules:
- 7-10 → "approve"
- 4-6  → "pending" (human should look)
- 0-3  → "reject"

Be conservative. If you're not sure, return "pending" — a human will handle it.

Respond with **ONLY** valid JSON, no prose, no markdown fences, in this exact shape:

{"decision":"approve|pending|reject","score":<0-10>,"reason":"<≤200 chars explaining the verdict>","criteria":{"specificity":<0-2>,"evidence":<0-2>,"actionability":<0-2>,"originality":<0-2>,"clarity":<0-2>}}`;

// ── Claude API call (raw HTTPS) ───────────────────────────────────────────────

function callClaude(insight) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return Promise.reject(new Error('no_api_key'));

  const userText = [
    `# ${insight.title}`,
    '',
    `Category: ${insight.category}`,
    insight.confidence ? `Confidence (self-reported): ${insight.confidence}` : '',
    insight.tickets.length ? `Tickets referenced: ${insight.tickets.join(', ')}` : 'Tickets referenced: (none)',
    insight.tags.length ? `Tags: ${insight.tags.join(', ')}` : '',
    '',
    '---',
    '',
    insight.body,
  ].filter(Boolean).join('\n');

  const payload = JSON.stringify({
    model:       CLAUDE_MODEL,
    max_tokens:  400,
    system:      SYSTEM_PROMPT,
    messages:    [{ role: 'user', content: userText }],
  });

  return new Promise((resolve, reject) => {
    const body = Buffer.from(payload);
    const req = https.request({
      hostname: 'api.anthropic.com',
      path:     '/v1/messages',
      method:   'POST',
      headers: {
        'Content-Type':      'application/json',
        'Content-Length':    body.length,
        'X-Api-Key':         apiKey,
        'Anthropic-Version': '2023-06-01',
      },
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (j.type === 'error' || res.statusCode >= 400) {
            return reject(new Error(`api ${res.statusCode}: ${j.error?.message || data.slice(0, 200)}`));
          }
          const text = (j.content || []).map(b => b.text || '').join('').trim();
          // The model is told to return ONLY JSON. Try to recover from minor formatting drift.
          const jsonStart = text.indexOf('{');
          const jsonEnd   = text.lastIndexOf('}');
          if (jsonStart < 0 || jsonEnd < 0) return reject(new Error('no JSON in model output'));
          const verdict = JSON.parse(text.slice(jsonStart, jsonEnd + 1));
          resolve(verdict);
        } catch (err) { reject(err); }
      });
    });
    req.on('error', reject);
    req.setTimeout(CLAUDE_TIMEOUT, () => { req.destroy(new Error('claude_timeout')); });
    req.write(body);
    req.end();
  });
}

// ── Heuristic fallback ────────────────────────────────────────────────────────

function heuristicScore(insight) {
  let s = 0;
  const reasons = [];

  // Length — too short = unhelpful; too long = probably rambling.
  const bodyLen = insight.body.length;
  if (bodyLen >= 300 && bodyLen <= 8000) { s += 2; }
  else if (bodyLen >= 150 && bodyLen <= 12000) { s += 1; reasons.push('body length borderline'); }
  else { reasons.push(`body length ${bodyLen} outside healthy range`); }

  // Title — must be specific.
  const generic = /^(insight|pattern|note|update|finding|observation|untitled)$/i;
  if (insight.title.length >= 15 && !generic.test(insight.title)) s += 2;
  else if (insight.title.length >= 8) { s += 1; reasons.push('title is short or generic'); }
  else reasons.push('title is too short / generic');

  // Tickets referenced.
  if (insight.tickets.length >= 3) s += 2;
  else if (insight.tickets.length >= 1) { s += 1; reasons.push('only 1–2 tickets cited'); }
  else reasons.push('no tickets cited');

  // Structure — multi-line body, headers, lists.
  const lines = insight.body.split('\n');
  const hasStructure = lines.length >= 4 || /^#{1,3}\s|^[-*]\s/m.test(insight.body);
  if (hasStructure) s += 2; else reasons.push('body lacks structure');

  // Specificity signals — code, version numbers, file paths, identifiers.
  const specific = /`[^`]+`|\b\w+\.[a-z]{1,4}\b|v\d+\.\d+|[A-Z]{2,}-\d+/.test(insight.body);
  if (specific) s += 2; else reasons.push('no concrete identifiers or code references in body');

  let decision;
  if (s >= APPROVE_THRESHOLD)      decision = 'approve';
  else if (s <= REJECT_THRESHOLD)  decision = 'reject';
  else                              decision = 'pending';

  return {
    decision,
    score:     s,
    reason:    reasons.length ? `Heuristic: ${reasons.join('; ')}` : 'Heuristic: passed all checks',
    validator: 'heuristic',
  };
}

// ── Public entry point ────────────────────────────────────────────────────────

async function validate(insight) {
  // Heuristic always runs first as the safety net. Cheap, deterministic.
  const heur = heuristicScore(insight);

  // If we have an API key, ask Claude to override the heuristic. Failures
  // (network, parse, timeout) silently fall back to the heuristic verdict.
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const v = await callClaude(insight);
      return {
        decision:  v.decision === 'approve' ? 'approve' : v.decision === 'reject' ? 'reject' : 'pending',
        score:     typeof v.score === 'number' ? v.score : heur.score,
        reason:    typeof v.reason === 'string' ? v.reason.slice(0, 500) : 'Claude verdict (no reason)',
        criteria:  v.criteria || null,
        validator: 'claude-haiku-4-5',
        heuristic_score: heur.score,
      };
    } catch (err) {
      console.warn(`[hermes/insights/validator] Claude call failed (${err.message}) — falling back to heuristic`);
      return { ...heur, validator_error: err.message };
    }
  }

  return heur;
}

module.exports = { validate, heuristicScore, APPROVE_THRESHOLD, REJECT_THRESHOLD };
