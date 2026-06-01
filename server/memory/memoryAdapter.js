'use strict';

/**
 * Unified memory adapter — JSON file-based index.
 *
 * Indexes agent learnings, surprises, and running context notes from session
 * memory files and injects the most relevant ones per session.
 * Backend: ~/.prevoyant/memory/index.json (local, zero-dependency).
 */

const json = require('./jsonMemory');

function isEnabled() { return json.isEnabled(); }

async function indexSession(ticketKey, meta = {}) {
  if (json.isEnabled()) {
    try { json.indexSession(ticketKey, meta); }
    catch (err) { console.warn(`[memory-adapter] JSON index failed: ${err.message}`); }
  }
}

async function indexAllNew() {
  if (json.isEnabled()) { try { json.indexAllNew(); } catch (_) {} }
}

async function queryRelevant(opts = {}) {
  if (json.isEnabled()) {
    try { return json.query(opts); } catch (_) {}
  }
  return { learnings: [], surprises: [], notes: [], total: 0 };
}

function formatBlock({ learnings = [], surprises = [], notes = [], total = 0 } = {}) {
  if (!learnings.length && !surprises.length && !notes.length) return null;

  const lines = [];
  lines.push(`### Agent Memory — ${learnings.length} relevant learning(s) from ${total} indexed (JSON)`);
  lines.push('');

  if (learnings.length) {
    lines.push('| Agent | Ticket | Category | Confidence | Learning |');
    lines.push('|-------|--------|----------|------------|----------|');
    for (const l of learnings) {
      const cat     = (l.category   || '—');
      const conf    = (l.confidence || '—').slice(0, 4);
      const content = (l.content    || '').replace(/\|/g, '\\|').slice(0, 110);
      lines.push(`| ${l.agent} | ${l.ticketKey} | ${cat} | ${conf} | ${content} |`);
    }
    lines.push('');
  }

  if (surprises.length) {
    lines.push('**High-value surprises from related sessions:**');
    for (const s of surprises) {
      lines.push(`- [${s.agent} / ${s.ticketKey}] ${(s.content || '').slice(0, 130)}`);
    }
    lines.push('');
  }

  if (notes.length) {
    lines.push('**Running context from related sessions:**');
    for (const n of notes) {
      lines.push(`- [${n.agent} / ${n.ticketKey}] ${(n.content || '').slice(0, 130)}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

async function stats() {
  if (json.isEnabled()) {
    try { return json.stats(); } catch (_) {}
  }
  return { enabled: false, backend: 'none', connected: false, total: 0, surprises: 0, notes: 0, indexedFiles: 0, agents: 0 };
}

function ensureKbEntry() {
  try { json.ensureKbEntry(); } catch (_) {}
}

module.exports = { isEnabled, indexSession, indexAllNew, queryRelevant, formatBlock, stats, ensureKbEntry };
