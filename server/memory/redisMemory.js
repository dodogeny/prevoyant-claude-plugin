'use strict';

/**
 * Redis-backed agent memory store.
 *
 * Stores indexed learnings, surprises, and running context notes so the
 * whole team shares one memory across machines and parallel sessions.
 * Falls back gracefully to the JSON backend when Redis is unavailable.
 *
 * Redis key schema  (prefix = PRX_REDIS_PREFIX, default "prx:mem:")
 *   {p}:learning:{id}          Hash   – agent, ticketKey, date, content, …
 *   {p}:idx:comp:{comp}        ZSet   – id → confidence_score  (component index)
 *   {p}:idx:label:{label}      ZSet   – id → confidence_score  (label index)
 *   {p}:idx:date               ZSet   – id → YYYYMMDD int      (recency index)
 *   {p}:indexed                Set    – session file keys already processed
 *   {p}:meta                   Hash   – totalLearnings, totalSurprises, totalNotes
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');

// ioredis is optional — we load it lazily so the server doesn't crash if it
// isn't installed yet. npm install is deferred to first-use.
let Redis = null;
try { Redis = require('ioredis'); } catch (_) {}

const AGENTS     = ['morgan', 'alex', 'sam', 'jordan', 'henk', 'riley', 'bryan'];
const CONF_SCORE = { high: 3, medium: 2, med: 2, low: 1 };

// ── Config ─────────────────────────────────────────────────────────────────────

function cfg() {
  return {
    enabled:  (process.env.PRX_REDIS_ENABLED  || 'N') === 'Y',
    url:      process.env.PRX_REDIS_URL       || 'redis://localhost:6379',
    password: process.env.PRX_REDIS_PASSWORD  || '',
    prefix:   process.env.PRX_REDIS_PREFIX    || 'prx:mem:',
    ttlDays:  parseInt(process.env.PRX_REDIS_TTL_DAYS || '0', 10) || 0,
  };
}

function isEnabled() {
  return (process.env.PRX_REDIS_ENABLED || 'N') === 'Y' && Redis !== null;
}

// Key helper
function k(suffix) { return `${cfg().prefix}${suffix}`; }

function ttlSecs() {
  const days = cfg().ttlDays;
  return days > 0 ? days * 86400 : 0;
}

// ── Connection management ──────────────────────────────────────────────────────

let _client = null;

function getClient() {
  if (!Redis || !isEnabled()) return null;
  if (_client) return _client;

  const c = cfg();
  try {
    _client = new Redis(c.url, {
      password:             c.password || undefined,
      maxRetriesPerRequest: 1,       // fail fast so we fall back to JSON quickly
      enableOfflineQueue:   false,   // don't queue — return error immediately
      connectTimeout:       4000,
      lazyConnect:          false,
    });

    _client.on('error', err => {
      // Auth failures won't resolve on retry — disconnect immediately to stop the spam.
      if (err.message && /WRONGPASS|NOAUTH|ERR invalid password/i.test(err.message)) {
        console.warn(`[redis-memory] Auth failed — stopping reconnection attempts. Fix PRX_REDIS_URL or set PRX_REDIS_ENABLED=N.`);
        setImmediate(() => resetClient());
        return;
      }
      // Suppress noisy connection-refused spam; log everything else.
      if (!['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET'].includes(err.code)) {
        console.warn(`[redis-memory] ${err.message}`);
      }
    });

    console.log(`[redis-memory] Connecting to ${c.url}`);
    return _client;
  } catch (err) {
    console.warn(`[redis-memory] Client creation failed: ${err.message}`);
    _client = null;
    return null;
  }
}

/** Disconnect and clear the cached client (called when settings change). */
function resetClient() {
  if (_client) { try { _client.disconnect(); } catch (_) {} _client = null; }
}

async function ping() {
  const client = getClient();
  if (!client) return false;
  try { return (await client.ping()) === 'PONG'; }
  catch (_) { return false; }
}

// ── Helpers shared with jsonMemory ─────────────────────────────────────────────

function kbBaseDir() {
  const mode = process.env.PRX_KB_MODE || 'local';
  return mode === 'distributed'
    ? (process.env.PRX_KB_LOCAL_CLONE || path.join(os.homedir(), '.prevoyant', 'kb'))
    : (process.env.PRX_KNOWLEDGE_DIR  || path.join(os.homedir(), '.prevoyant', 'knowledge-base'));
}

function extractSection(lines, re) {
  let in_ = false; const out = [];
  for (const line of lines) {
    if (!in_) { if (re.test(line)) in_ = true; }
    else { if (/^##\s+/.test(line)) break; out.push(line); }
  }
  return out;
}

function parseLearnings(lines) {
  const rows = [];
  for (const line of extractSection(lines, /##\s+What I Learned/i)) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').map(c => c.trim()).filter(Boolean);
    if (cells.length < 4 || cells[0] === '#' || /^-+$/.test(cells[0]) || cells[1] === 'Observation') continue;
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

// ── Indexing ───────────────────────────────────────────────────────────────────

async function indexSession(ticketKey, { components = [], labels = [] } = {}) {
  if (!isEnabled()) return 0;
  const client = getClient();
  if (!client) return 0;

  if ((process.env.PRX_KB_MODE || 'local') === 'distributed' && process.env.PRX_KB_KEY) return 0;

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

      try {
        const alreadyDone = await client.sismember(k('indexed'), idKey);
        if (alreadyDone) continue;
      } catch (_) { continue; } // Redis unavailable

      try {
        const lines     = fs.readFileSync(path.join(agentDir, file), 'utf8').split('\n');
        const dateMatch = stem.match(/^(\d{8})/);
        const date      = dateMatch ? dateMatch[1] : '';
        const dateInt   = parseInt(date || '0', 10);
        const tKey      = ticketKey || stem.replace(/^\d{8}-?/, '');
        const ttl       = ttlSecs();
        const pipe      = client.pipeline();

        const storeEntry = (id, content, category, confidence, outcome, type) => {
          const confScore = CONF_SCORE[(confidence || '').toLowerCase()] || 1;

          pipe.hset(k(`learning:${id}`),
            'agent',      agent,        'ticketKey', tKey,
            'date',       date,         'content',   content,
            'category',   category,     'confidence',confidence,
            'outcome',    outcome || '', 'type',      type,
            'components', JSON.stringify(comps),
            'labels',     JSON.stringify(labs),
          );
          if (ttl > 0) pipe.expire(k(`learning:${id}`), ttl);

          // Component and label sorted sets — score encodes confidence
          for (const comp  of comps) { pipe.zadd(k(`idx:comp:${comp}`),   confScore, id); if (ttl > 0) pipe.expire(k(`idx:comp:${comp}`),  ttl); }
          for (const label of labs)  { pipe.zadd(k(`idx:label:${label}`), confScore, id); if (ttl > 0) pipe.expire(k(`idx:label:${label}`), ttl); }

          // Recency index
          pipe.zadd(k('idx:date'), dateInt || Date.now(), id);

          added++;
        };

        parseLearnings(lines).forEach((r, i) =>
          storeEntry(`${idKey}__${i}`, r.content, r.category, r.confidence, r.outcome, 'learning'));

        parseSurprises(lines).forEach((s, i) =>
          storeEntry(`${idKey}__s${i}`, s, 'SURPRISE', 'High', '', 'surprise'));

        parseRunningNotes(lines).forEach((n, i) =>
          storeEntry(`${idKey}__n${i}`, n, 'NOTE', 'High', '', 'note'));

        pipe.sadd(k('indexed'), idKey);
        await pipe.exec();

        // Update meta counters (best-effort, outside pipeline)
        const lr = parseLearnings(lines).length;
        const sr = parseSurprises(lines).length;
        const nr = parseRunningNotes(lines).length;
        client.hincrby(k('meta'), 'totalLearnings', lr).catch(() => {});
        client.hincrby(k('meta'), 'totalSurprises', sr).catch(() => {});
        client.hincrby(k('meta'), 'totalNotes',     nr).catch(() => {});
        client.hincrby(k('meta'), 'indexedFiles',    1).catch(() => {});

      } catch (err) {
        console.warn(`[redis-memory] Failed to index ${idKey}: ${err.message}`);
      }
    }
  }

  if (added > 0) console.log(`[redis-memory] Indexed ${added} entries (${ticketKey || 'startup sweep'})`);
  return added;
}

async function indexAllNew() { return indexSession(null); }

// ── Query ──────────────────────────────────────────────────────────────────────

async function query({ components = [], labels = [], ticketKey = null, limit = 15 } = {}) {
  if (!isEnabled()) return null;
  const client = getClient();
  if (!client) return null;

  try {
    const compKeys   = components.map(c => k(`idx:comp:${c.toLowerCase()}`));
    const labelKeys  = labels.map(l => k(`idx:label:${l.toLowerCase()}`));
    const unionKeys  = [...compKeys, ...labelKeys];
    const weights    = [...compKeys.map(() => 3), ...labelKeys.map(() => 1)];

    let ids = [];

    if (unionKeys.length > 0) {
      // Filter to keys that actually exist to avoid ZUNIONSTORE errors
      const existChecks = await Promise.all(unionKeys.map(key => client.exists(key)));
      const existingKeys    = unionKeys.filter((_, i) => existChecks[i]);
      const existingWeights = weights.filter((_, i) => existChecks[i]);

      if (existingKeys.length > 0) {
        const tempKey = k(`tmp:${Date.now()}-${Math.random().toString(36).slice(2)}`);
        await client.zunionstore(
          tempKey, existingKeys.length, ...existingKeys,
          'WEIGHTS', ...existingWeights, 'AGGREGATE', 'SUM'
        );
        await client.expire(tempKey, 60);
        // Fetch more than limit so we can filter out same-ticket entries
        ids = await client.zrevrange(tempKey, 0, limit + 30 - 1);
        await client.del(tempKey).catch(() => {});
      }
    }

    // Fall back to recency-based results when no component/label index match
    if (ids.length === 0) {
      ids = await client.zrevrange(k('idx:date'), 0, limit + 30 - 1);
    }

    // Fetch hashes in a pipeline for efficiency
    const pipe = client.pipeline();
    for (const id of ids) pipe.hgetall(k(`learning:${id}`));
    const results = await pipe.exec();

    const learnings = [], surprises = [], notes = [];
    for (const [err, hash] of results) {
      if (err || !hash || !hash.content) continue;
      if (hash.ticketKey === ticketKey) continue;
      if (hash.type === 'surprise' && surprises.length < 5)     surprises.push(hash);
      else if (hash.type === 'note' && notes.length < 5)        notes.push(hash);
      else if (hash.type === 'learning' && learnings.length < limit) learnings.push(hash);
    }

    const meta  = await client.hgetall(k('meta')).catch(() => ({}));
    const total = parseInt((meta || {}).totalLearnings || '0', 10);

    return { learnings, surprises, notes, total };

  } catch (err) {
    console.warn(`[redis-memory] Query failed: ${err.message}`);
    return null; // signal caller to fall back to JSON
  }
}

// ── Stats ──────────────────────────────────────────────────────────────────────

async function stats() {
  const base = { enabled: isEnabled(), backend: 'redis', connected: false, total: 0, surprises: 0, notes: 0, indexedFiles: 0, agents: AGENTS.length };
  if (!isEnabled()) return base;
  const client = getClient();
  if (!client)     return base;
  try {
    const ok = await client.ping();
    if (ok !== 'PONG') return base;
    const meta = await client.hgetall(k('meta')) || {};
    return {
      ...base,
      connected:    true,
      total:        parseInt(meta.totalLearnings || '0', 10),
      surprises:    parseInt(meta.totalSurprises || '0', 10),
      notes:        parseInt(meta.totalNotes     || '0', 10),
      indexedFiles: parseInt(meta.indexedFiles   || '0', 10),
    };
  } catch (_) { return base; }
}

module.exports = { isEnabled, getClient, resetClient, ping, indexSession, indexAllNew, query, stats };
