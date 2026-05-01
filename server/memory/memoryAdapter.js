'use strict';

/**
 * Unified memory adapter — routes between Redis (primary) and JSON (fallback).
 *
 * Priority:
 *   1. Redis  — when PRX_REDIS_ENABLED=Y and connection is healthy
 *   2. JSON   — when PRX_MEMORY_INDEX_ENABLED=Y (local file-based index)
 *   3. None   — both disabled; memory block is omitted from the prompt
 *
 * When Redis is enabled, both backends are written to simultaneously
 * so the JSON index stays warm as a hot-standby if Redis goes down.
 *
 * External callers import ONLY this module — never the individual backends.
 */

const redis = require('./redisMemory');
const json  = require('./jsonMemory');

// ── Routing helpers ────────────────────────────────────────────────────────────

function redisOn() { return redis.isEnabled(); }
function jsonOn()  { return json.isEnabled(); }

function isEnabled() { return redisOn() || jsonOn(); }

// ── Indexing (dual-write) ──────────────────────────────────────────────────────

async function indexSession(ticketKey, meta = {}) {
  // Write to Redis first; JSON write is always attempted as hot-standby.
  // Neither failure is fatal — catch individually so one bad backend
  // doesn't prevent the other from indexing.
  if (redisOn()) {
    try { await redis.indexSession(ticketKey, meta); }
    catch (err) { console.warn(`[memory-adapter] Redis index failed: ${err.message}`); }
  }
  if (jsonOn()) {
    try { json.indexSession(ticketKey, meta); }
    catch (err) { console.warn(`[memory-adapter] JSON index failed: ${err.message}`); }
  }
}

async function indexAllNew() {
  if (redisOn()) { try { await redis.indexAllNew(); } catch (_) {} }
  if (jsonOn())  { try {       json.indexAllNew();  } catch (_) {} }
}

// ── Query (Redis → JSON fallback) ─────────────────────────────────────────────

async function queryRelevant(opts = {}) {
  if (redisOn()) {
    try {
      const result = await redis.query(opts);
      if (result) return result; // null means connection failed → fall through
    } catch (_) {}
  }
  if (jsonOn()) {
    try { return json.query(opts); } catch (_) {}
  }
  return { learnings: [], surprises: [], notes: [], total: 0 };
}

// ── Format ─────────────────────────────────────────────────────────────────────

function formatBlock({ learnings = [], surprises = [], notes = [], total = 0 } = {}) {
  if (!learnings.length && !surprises.length && !notes.length) return null;

  const backend = redisOn() ? 'Redis' : 'JSON';
  const lines   = [];
  lines.push(`### Agent Memory — ${learnings.length} relevant learning(s) from ${total} indexed (${backend})`);
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

// ── Stats ──────────────────────────────────────────────────────────────────────

async function stats() {
  if (redisOn()) {
    try { return await redis.stats(); } catch (_) {}
  }
  if (jsonOn()) {
    try { return json.stats(); } catch (_) {}
  }
  return { enabled: false, backend: 'none', connected: false, total: 0, surprises: 0, notes: 0, indexedFiles: 0, agents: 0 };
}

// ── KB shared entry (plugin standalone mode) ───────────────────────────────────

function ensureKbEntry() {
  try { json.ensureKbEntry(); } catch (_) {}
}

// ── Redis-specific helpers exposed for the settings API ───────────────────────

function resetRedisClient() {
  try { redis.resetClient(); } catch (_) {}
}

async function pingRedis() {
  try { return await redis.ping(); } catch (_) { return false; }
}

module.exports = {
  isEnabled, indexSession, indexAllNew,
  queryRelevant, formatBlock, stats,
  ensureKbEntry, resetRedisClient, pingRedis,
};
