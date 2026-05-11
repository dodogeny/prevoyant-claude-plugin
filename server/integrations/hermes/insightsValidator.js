'use strict';

// Verdict matrix for Hermes-contributed KB insights — AUTO mode.
//
// Architecture: Hermes is the judge (it's an LLM, it has cross-ticket context).
// Per the SKILL.md it deploys, Hermes self-scores every insight 0–10 on five
// criteria before posting, and only POSTs when its self-score ≥ 7. Prevoyant
// runs a cheap heuristic alongside as a sanity check — so a buggy or
// hallucinating Hermes can't silently poison the KB.
//
// No external API call. No ANTHROPIC_API_KEY needed.
//
// Returns { decision: 'approve' | 'reject' | 'pending', reason, self_score,
//           heuristic_score, criteria, validator }.

const APPROVE_THRESHOLD_SELF = 7;   // SKILL.md tells Hermes not to post below this
const APPROVE_THRESHOLD_HEUR = 4;   // heuristic must at least pass the sanity bar
const REJECT_THRESHOLD       = 3;   // both validators agree this is junk

// ── Heuristic sanity check ────────────────────────────────────────────────────
//
// Cheap rule-based scoring on five structural signals. Sums 0–10. NOT a
// semantic judge — it's looking for "does this even look like a real insight
// or did Hermes hallucinate empty markdown?".

function heuristicScore(insight) {
  let s = 0;
  const reasons = [];

  const bodyLen = insight.body.length;
  if (bodyLen >= 300 && bodyLen <= 8000) s += 2;
  else if (bodyLen >= 150 && bodyLen <= 12000) { s += 1; reasons.push('body length borderline'); }
  else reasons.push(`body length ${bodyLen} outside healthy range`);

  const generic = /^(insight|pattern|note|update|finding|observation|untitled)$/i;
  if (insight.title.length >= 15 && !generic.test(insight.title)) s += 2;
  else if (insight.title.length >= 8) { s += 1; reasons.push('title is short or generic'); }
  else reasons.push('title is too short / generic');

  if (insight.tickets.length >= 3) s += 2;
  else if (insight.tickets.length >= 1) { s += 1; reasons.push('only 1–2 tickets cited'); }
  else reasons.push('no tickets cited');

  const hasStructure = insight.body.split('\n').length >= 4 || /^#{1,3}\s|^[-*]\s/m.test(insight.body);
  if (hasStructure) s += 2; else reasons.push('body lacks structure');

  const specific = /`[^`]+`|\b\w+\.[a-z]{1,4}\b|v\d+\.\d+|[A-Z]{2,}-\d+/.test(insight.body);
  if (specific) s += 2; else reasons.push('no concrete identifiers or code references in body');

  return { score: s, reasons };
}

// ── Verdict matrix ────────────────────────────────────────────────────────────

function validate(insight) {
  const heur = heuristicScore(insight);
  const selfScore = insight.self_assessment ? insight.self_assessment.score : null;
  const selfReason = insight.self_assessment ? insight.self_assessment.reason : '';

  let decision, reason, validator;

  if (selfScore == null) {
    // No self-assessment — Hermes didn't follow the SKILL.md contract.
    // Fall back to heuristic-only thresholds (more conservative).
    if (heur.score >= 8) {
      decision  = 'approve';
      reason    = `Heuristic strong (${heur.score}/10) and no self-assessment provided.`;
      validator = 'heuristic-only';
    } else if (heur.score <= 1) {
      decision  = 'reject';
      reason    = `Heuristic weak (${heur.score}/10) and no self-assessment: ${heur.reasons.join('; ')}`;
      validator = 'heuristic-only';
    } else {
      decision  = 'pending';
      reason    = `No self-assessment provided. Heuristic score ${heur.score}/10 (${heur.reasons.join('; ') || 'OK'}). Human reviews.`;
      validator = 'heuristic-only';
    }
  } else if (selfScore <= REJECT_THRESHOLD) {
    // Hermes shouldn't have posted. Still record it for audit, but reject.
    decision  = 'reject';
    reason    = `Hermes self-score ${selfScore}/10 below threshold — insight should not have been posted. ${selfReason}`.trim();
    validator = 'hermes-self';
  } else if (selfScore >= APPROVE_THRESHOLD_SELF && heur.score >= APPROVE_THRESHOLD_HEUR) {
    // Both Hermes and the heuristic agree the insight is solid.
    decision  = 'approve';
    reason    = `Hermes self-score ${selfScore}/10 + heuristic ${heur.score}/10 — both confident. ${selfReason}`.trim();
    validator = 'hermes-self+heuristic';
  } else if (selfScore >= APPROVE_THRESHOLD_SELF && heur.score < APPROVE_THRESHOLD_HEUR) {
    // Hermes confident, heuristic isn't. Likely Hermes is right but the heuristic
    // is dumb — still kick to human so we don't silently trust a possibly
    // hallucinating Hermes.
    decision  = 'pending';
    reason    = `Hermes confident (${selfScore}/10) but heuristic flags weakness (${heur.score}/10): ${heur.reasons.join('; ')}. Human breaks the tie. Hermes: ${selfReason}`.trim();
    validator = 'hermes-self+heuristic';
  } else {
    // Hermes self-flagged uncertainty (4–6). SKILL.md says don't post below 7,
    // but if Hermes did, respect its uncertainty and queue for human.
    decision  = 'pending';
    reason    = `Hermes self-score ${selfScore}/10 in uncertain range. ${selfReason}`.trim();
    validator = 'hermes-self';
  }

  return {
    decision,
    reason,
    self_score:      selfScore,
    heuristic_score: heur.score,
    criteria:        insight.self_assessment ? insight.self_assessment.criteria : null,
    validator,
  };
}

module.exports = {
  validate, heuristicScore,
  APPROVE_THRESHOLD_SELF, APPROVE_THRESHOLD_HEUR, REJECT_THRESHOLD,
};
