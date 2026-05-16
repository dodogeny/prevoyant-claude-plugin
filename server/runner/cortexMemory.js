'use strict';

// CortexMemory — fast local disk-backed memory engine for the Cortex layer.
//
// Storage backend (auto-selected at startup):
//
//   LMDB  (preferred) — Lightning Memory-Mapped Database via the `lmdb` npm
//     package.  Synchronous mmap'd reads (~0.5 µs), transactional writes,
//     zero config, crash-proof, prebuilt binaries for macOS / Linux / Windows.
//     Installed automatically on first use when PRX_CORTEX_ENABLED=Y via
//     server/scripts/ensure-lmdb.js (postinstall) and the plugin SessionStart
//     hook (plugin/hooks/ensure-lmdb.sh).
//
//   JSONL  (fallback) — append-only JSONL log + JSON tag index.  Used when
//     `lmdb` is not yet installed.  Functionally identical API, slightly slower
//     cold reads (linear scan).  Migrates automatically to LMDB on next start
//     once `lmdb` is available.
//
// Both backends expose the same public API:
//   put(key, value, {tags, ttl})   → store a value
//   get(key)                       → retrieve (null if missing/expired)
//   del(key)                       → delete
//   byTag(tag)                     → [key, …] for all live keys with tag
//   recent(n, {tag})               → n most-recent entries, newest-first
//   signal(event, data)            → append to ring-buffer event stream
//   signals(n)                     → last n signals, newest-first
//   getOrCompute(key, fn, opts)    → get or compute+store
//   compact()                      → GC expired entries (JSONL only; no-op on LMDB)
//   stats()                        → storage + health statistics
//   health()                       → { ok, backend, lmdbInstalled, … }
//   close()                        → flush + teardown
//
// Storage layout  (under <cortexDir>/memory/):
//   memory.lmdb/    — LMDB environment directory  (when lmdb is installed)
//   store.jsonl     — JSONL entry log              (fallback; migrated on upgrade)
//   index.json      — JSONL tag index snapshot     (fallback only)
//   signals.jsonl   — ring-buffer event stream     (both backends)
//
// Config env vars:
//   PRX_CORTEX_MEM_LRU_MAX       — hot LRU cache size (default 200)
//   PRX_CORTEX_MEM_SIGNAL_LINES  — max signal ring-buffer lines (default 2000)
//   PRX_CORTEX_MEM_FLUSH_MS      — JSONL index flush debounce ms (default 400)
//   PRX_CORTEX_MEM_COMPACT_KB    — JSONL compact threshold KB (default 512)

const fs   = require('fs');
const path = require('path');

// ── Config ────────────────────────────────────────────────────────────────────

const cfg = {
  lruMax()       { return Math.max(50,  parseInt(process.env.PRX_CORTEX_MEM_LRU_MAX      || '200',  10)); },
  signalLines()  { return Math.max(100, parseInt(process.env.PRX_CORTEX_MEM_SIGNAL_LINES || '2000', 10)); },
  flushMs()      { return Math.max(50,  parseInt(process.env.PRX_CORTEX_MEM_FLUSH_MS     || '400',  10)); },
  compactBytes() { return Math.max(64,  parseInt(process.env.PRX_CORTEX_MEM_COMPACT_KB   || '512',  10)) * 1024; },
};

// ── LMDB availability ─────────────────────────────────────────────────────────
//
// We try to require lmdb once at module load.  If it's not installed yet the
// JSONL backend is used transparently.  When the SessionStart hook installs
// lmdb the server must be restarted to pick it up (the require cache is warm).

let lmdbModule = null;
let lmdbInstallError = null;

try {
  lmdbModule = require('lmdb');
} catch (err) {
  lmdbInstallError = err.message;
}

function lmdbAvailable() { return lmdbModule !== null; }

// ── Helpers ───────────────────────────────────────────────────────────────────

function readSafe(p)    { try { return fs.readFileSync(p, 'utf8'); } catch (_) { return null; } }
function nowMs()        { return Date.now(); }
function isExpired(m)   { return m && m.ttl > 0 && (nowMs() - m.ts) > m.ttl; }

function writeAtomic(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = filePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, filePath);
}

// ── LRU Cache (shared by both backends) ──────────────────────────────────────

class LRUCache {
  constructor(max) { this._max = max; this._map = new Map(); }
  get(key) {
    if (!this._map.has(key)) return undefined;
    const val = this._map.get(key);
    this._map.delete(key); this._map.set(key, val);
    return val;
  }
  set(key, val) {
    if (this._map.has(key)) this._map.delete(key);
    else if (this._map.size >= this._max) this._map.delete(this._map.keys().next().value);
    this._map.set(key, val);
  }
  del(key)   { this._map.delete(key); }
  has(key)   { return this._map.has(key); }
  clear()    { this._map.clear(); }
  get size() { return this._map.size; }
}

// ══════════════════════════════════════════════════════════════════════════════
// LMDB BACKEND
// ══════════════════════════════════════════════════════════════════════════════
//
// Key layout (all in one LMDB environment, single unnamed database):
//   e:<key>           → { v, tags, ts, ttl, seq }   (entry)
//   t:<tag>:<key>     → 1                            (tag index marker)
//
// Tag range scan:  getRange({ start: 't:<tag>:', end: 't:<tag>:\xff' })
// Entry scan:      getRange({ start: 'e:', end: 'e:\xff' })

class LmdbBackend {
  constructor(memDir) {
    this._dir  = memDir;
    this._lru  = new LRUCache(cfg.lruMax());
    this._seq  = 0;
    this._db   = null;
    this._open();
  }

  _open() {
    // lmdb v3 stores the database as a single file (not a directory).
    // Do NOT pre-create the path — let lmdb create the file itself.
    // The parent directory (this._dir) must exist; it was created by the caller.
    const dbPath = path.join(this._dir, 'memory.lmdb');
    this._db = lmdbModule.open({
      path:        dbPath,
      encoding:    'json',
      compression: false,
    });
    // Restore seq counter from last stored value.
    const seqEntry = this._db.get('__seq__');
    if (seqEntry && typeof seqEntry === 'number') this._seq = seqEntry;
  }

  // ── Write ─────────────────────────────────────────────────────────────────
  //
  // All writes use transactionSync() so they are committed immediately and
  // visible to subsequent get()/getRange() calls in the same tick.
  // lmdb v3's plain transaction() batches commits asynchronously, which would
  // cause reads immediately after a write to see stale data.

  put(key, value, opts = {}) {
    const tags  = Array.isArray(opts.tags) ? opts.tags : [];
    const ttl   = (typeof opts.ttl === 'number' && opts.ttl > 0) ? opts.ttl : 0;
    const seq   = ++this._seq;
    const ts    = nowMs();
    const entry = { v: value, tags, ts, ttl, seq };

    this._db.transactionSync(() => {
      // Remove stale tag index entries for this key.
      const prev = this._db.get(`e:${key}`);
      if (prev) {
        for (const t of (prev.tags || [])) this._db.removeSync(`t:${t}:${key}`);
      }
      this._db.putSync(`e:${key}`, entry);
      for (const t of tags) this._db.putSync(`t:${t}:${key}`, 1);
      this._db.putSync('__seq__', seq);
    });

    this._lru.set(key, value);
    return seq;
  }

  del(key) {
    this._db.transactionSync(() => {
      const prev = this._db.get(`e:${key}`);
      if (prev) {
        for (const t of (prev.tags || [])) this._db.removeSync(`t:${t}:${key}`);
      }
      this._db.removeSync(`e:${key}`);
    });
    this._lru.del(key);
  }

  // ── Read ──────────────────────────────────────────────────────────────────

  get(key) {
    // Always read metadata from LMDB first to enforce TTL — mmap reads are
    // ~0.5µs so the overhead is negligible, and it prevents the LRU from
    // serving expired values.
    const entry = this._db.get(`e:${key}`);
    if (!entry) { this._lru.del(key); return null; }
    if (isExpired(entry)) { this.del(key); return null; }

    // Value may already be in the LRU from a previous read.
    const cached = this._lru.get(key);
    if (cached !== undefined) return cached;

    this._lru.set(key, entry.v);
    return entry.v;
  }

  byTag(tag) {
    const now    = nowMs();
    // Range: all keys starting with 't:<tag>:'.
    // Use tag + ';' as end (';' is one code-point above ':' in ASCII) so we
    // don't rely on \xff which can behave unexpectedly in lmdb string ordering.
    const prefix = `t:${tag}:`;
    const end    = `t:${tag};`;
    const result = [];
    for (const { key: tagKey } of this._db.getRange({ start: prefix, end })) {
      const k     = tagKey.slice(prefix.length);
      const entry = this._db.get(`e:${k}`);
      if (!entry) continue;
      if (entry.ttl > 0 && (now - entry.ts) > entry.ttl) continue;
      result.push(k);
    }
    return result;
  }

  recent(n = 10, opts = {}) {
    const { tag } = opts;
    const now     = nowMs();
    const entries = [];
    // 'e;' is one code-point above 'e:' — covers all 'e:*' keys.
    for (const { key, value } of this._db.getRange({ start: 'e:', end: 'e;' })) {
      if (!value) continue;
      if (isExpired(value)) continue;
      if (tag && !(value.tags || []).includes(tag)) continue;
      entries.push({ key: key.slice(2), value: value.v, tags: value.tags || [], ts: value.ts, seq: value.seq });
    }
    return entries.sort((a, b) => b.seq - a.seq).slice(0, n);
  }

  // Scan and remove expired entries.
  compact() {
    const now      = nowMs();
    const toDelete = [];
    for (const { key, value } of this._db.getRange({ start: 'e:', end: 'e;' })) {
      if (!value) continue;
      if (value.ttl > 0 && (now - value.ts) > value.ttl) toDelete.push({ key, entry: value });
    }
    if (toDelete.length) {
      this._db.transactionSync(() => {
        for (const { key, entry } of toDelete) {
          for (const t of (entry.tags || [])) this._db.removeSync(`t:${t}:${key.slice(2)}`);
          this._db.removeSync(key);
        }
      });
    }
    this._lru.clear();
    return { backend: 'lmdb', removed: toDelete.length, kept: this._countEntries(), compactedAt: nowMs() };
  }

  _countEntries() {
    let n = 0;
    for (const _ of this._db.getRange({ start: 'e:', end: 'e;' })) n++;
    return n;
  }

  stats() {
    let dbSizeKB = 0;
    // lmdb v3 stores the database as a single file.
    try { dbSizeKB = Math.round(fs.statSync(path.join(this._dir, 'memory.lmdb')).size / 1024); } catch (_) {}

    let signalSz = 0;
    try { signalSz = Math.round(fs.statSync(path.join(this._dir, 'signals.jsonl')).size / 1024); } catch (_) {}

    return {
      backend:     'lmdb',
      keys:        this._countEntries(),
      seq:         this._seq,
      lruEntries:  this._lru.size,
      lruMax:      cfg.lruMax(),
      dbSizeKB,
      signalSizeKB: signalSz,
      totalSizeKB: dbSizeKB + signalSz,
      dir:         this._dir,
    };
  }

  close() {
    try { this._db.close(); } catch (_) {}
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// JSONL FALLBACK BACKEND
// ══════════════════════════════════════════════════════════════════════════════

class JsonlBackend {
  constructor(memDir) {
    this._dir   = memDir;
    this._store = path.join(memDir, 'store.jsonl');
    this._index = path.join(memDir, 'index.json');
    this._lru   = new LRUCache(cfg.lruMax());
    this._meta  = Object.create(null);   // key → { seq, tags, ts, ttl }
    this._tagIdx = Object.create(null);  // tag → Set<key>
    this._seq   = 0;
    this._fd    = null;
    this._dirty = false;
    this._flushTimer = null;

    fs.mkdirSync(memDir, { recursive: true });
    this._loadIndex();
    this._openFd();
  }

  _loadIndex() {
    const raw = readSafe(this._index);
    if (!raw) return;
    let saved;
    try { saved = JSON.parse(raw); } catch (_) { return; }
    this._seq = saved.seq || 0;
    const now = nowMs();
    for (const [k, m] of Object.entries(saved.keys || {})) {
      if (m.ttl > 0 && (now - m.ts) > m.ttl) continue;
      this._meta[k] = m;
      for (const t of (m.tags || [])) {
        if (!this._tagIdx[t]) this._tagIdx[t] = new Set();
        this._tagIdx[t].add(k);
      }
    }
  }

  _saveIndex() {
    const keys = Object.create(null);
    for (const [k, m] of Object.entries(this._meta)) keys[k] = m;
    writeAtomic(this._index, JSON.stringify({ seq: this._seq, compactedAt: this._compactedAt || 0, keys }, null, 2));
  }

  _openFd() {
    try { this._fd = fs.openSync(this._store, 'a'); } catch (_) { this._fd = null; }
  }

  _closeFd() {
    if (this._fd !== null) { try { fs.closeSync(this._fd); } catch (_) {} this._fd = null; }
  }

  _append(line) {
    const data = line + '\n';
    if (this._fd !== null) fs.writeSync(this._fd, data);
    else fs.appendFileSync(this._store, data, 'utf8');
  }

  _scheduleFlush() {
    if (this._dirty) return;
    this._dirty = true;
    if (this._flushTimer) clearTimeout(this._flushTimer);
    this._flushTimer = setTimeout(() => {
      this._dirty = false; this._flushTimer = null;
      try { this._saveIndex(); } catch (_) {}
      this._maybeCompact();
    }, cfg.flushMs());
  }

  _maybeCompact() {
    try {
      if (fs.statSync(this._store).size > cfg.compactBytes()) this.compact();
    } catch (_) {}
  }

  // ── Write ─────────────────────────────────────────────────────────────────

  put(key, value, opts = {}) {
    const tags = Array.isArray(opts.tags) ? opts.tags : [];
    const ttl  = (typeof opts.ttl === 'number' && opts.ttl > 0) ? opts.ttl : 0;
    const seq  = ++this._seq;
    const ts   = nowMs();

    this._append(JSON.stringify({ k: key, v: value, tags, ts, ttl, seq }));

    const prev = this._meta[key];
    if (prev) {
      for (const t of (prev.tags || [])) {
        if (this._tagIdx[t]) { this._tagIdx[t].delete(key); if (!this._tagIdx[t].size) delete this._tagIdx[t]; }
      }
    }
    this._meta[key] = { seq, tags, ts, ttl };
    for (const t of tags) {
      if (!this._tagIdx[t]) this._tagIdx[t] = new Set();
      this._tagIdx[t].add(key);
    }
    this._lru.set(key, value);
    this._scheduleFlush();
    return seq;
  }

  del(key) {
    this._append(JSON.stringify({ k: key, _del: true, seq: ++this._seq, ts: nowMs() }));
    const prev = this._meta[key];
    if (prev) {
      for (const t of (prev.tags || [])) {
        if (this._tagIdx[t]) { this._tagIdx[t].delete(key); if (!this._tagIdx[t].size) delete this._tagIdx[t]; }
      }
      delete this._meta[key];
    }
    this._lru.del(key);
    this._scheduleFlush();
  }

  // ── Read ──────────────────────────────────────────────────────────────────

  get(key) {
    const meta = this._meta[key];
    if (!meta) return null;
    if (isExpired(meta)) { this.del(key); return null; }
    const cached = this._lru.get(key);
    if (cached !== undefined) return cached;
    return this._coldRead(key);
  }

  _coldRead(key) {
    const raw = readSafe(this._store);
    if (!raw) return null;
    let result, bestSeq = -1;
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try {
        const e = JSON.parse(line);
        if (e.k !== key) continue;
        if (e._del) { result = undefined; bestSeq = e.seq; continue; }
        if (e.seq > bestSeq) { bestSeq = e.seq; result = e.v; }
      } catch (_) {}
    }
    if (result !== undefined) { this._lru.set(key, result); }
    return result !== undefined ? result : null;
  }

  byTag(tag) {
    const bucket = this._tagIdx[tag];
    if (!bucket) return [];
    const now = nowMs();
    return [...bucket].filter(k => { const m = this._meta[k]; return m && !(m.ttl > 0 && (now - m.ts) > m.ttl); });
  }

  recent(n = 10, opts = {}) {
    const { tag } = opts;
    const raw  = readSafe(this._store);
    if (!raw) return [];
    const byKey = new Map();
    const now   = nowMs();
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try {
        const e = JSON.parse(line);
        if (e._del) { byKey.delete(e.k); continue; }
        if (e.ttl > 0 && (now - e.ts) > e.ttl) continue;
        if (tag && !(e.tags || []).includes(tag)) continue;
        const prev = byKey.get(e.k);
        if (!prev || e.seq > prev.seq) byKey.set(e.k, e);
      } catch (_) {}
    }
    return [...byKey.values()].sort((a, b) => b.seq - a.seq).slice(0, n)
      .map(e => ({ key: e.k, value: e.v, tags: e.tags || [], ts: e.ts }));
  }

  compact() {
    this._closeFd();
    const raw = readSafe(this._store);
    const byKey = new Map();
    let tombstoned = 0, expired = 0, overwritten = 0;
    const now = nowMs();

    if (raw) {
      for (const line of raw.split('\n')) {
        if (!line) continue;
        try {
          const e = JSON.parse(line);
          if (e._del) { if (byKey.has(e.k)) tombstoned++; byKey.delete(e.k); continue; }
          if (e.ttl > 0 && (now - e.ts) > e.ttl) { expired++; continue; }
          if (byKey.has(e.k)) overwritten++;
          byKey.set(e.k, e);
        } catch (_) {}
      }
    }

    const live = [...byKey.values()].sort((a, b) => a.seq - b.seq);
    writeAtomic(this._store, live.map(e => JSON.stringify(e)).join('\n') + (live.length ? '\n' : ''));

    this._lru.clear(); this._meta = Object.create(null); this._tagIdx = Object.create(null);
    for (const e of live) {
      this._meta[e.k] = { seq: e.seq, tags: e.tags || [], ts: e.ts, ttl: e.ttl || 0 };
      for (const t of (e.tags || [])) {
        if (!this._tagIdx[t]) this._tagIdx[t] = new Set();
        this._tagIdx[t].add(e.k);
      }
    }
    this._compactedAt = nowMs();
    this._saveIndex();
    this._openFd();
    return { backend: 'jsonl', kept: live.length, tombstoned, expired, overwritten, compactedAt: this._compactedAt };
  }

  stats() {
    let storeSz = 0, indexSz = 0, signalSz = 0;
    try { storeSz  = Math.round(fs.statSync(this._store).size   / 1024); } catch (_) {}
    try { indexSz  = Math.round(fs.statSync(this._index).size   / 1024); } catch (_) {}
    try { signalSz = Math.round(fs.statSync(path.join(this._dir, 'signals.jsonl')).size / 1024); } catch (_) {}
    return {
      backend:        'jsonl',
      keys:           Object.keys(this._meta).length,
      tags:           Object.keys(this._tagIdx).length,
      seq:            this._seq,
      lruEntries:     this._lru.size,
      lruMax:         cfg.lruMax(),
      compactedAt:    this._compactedAt || 0,
      compactThreshKB: Math.round(cfg.compactBytes() / 1024),
      storeSizeKB:    storeSz,
      indexSizeKB:    indexSz,
      signalSizeKB:   signalSz,
      totalSizeKB:    storeSz + indexSz + signalSz,
      dir:            this._dir,
    };
  }

  close() {
    if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = null; }
    try { this._saveIndex(); } catch (_) {}
    this._closeFd();
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// CortexMemory — unified facade
// ══════════════════════════════════════════════════════════════════════════════

class CortexMemory {
  constructor(baseDir) {
    this._baseDir = baseDir;
    this._memDir  = path.join(baseDir, 'memory');
    fs.mkdirSync(this._memDir, { recursive: true });

    if (lmdbAvailable()) {
      this._backend = new LmdbBackend(this._memDir);
      this._backendName = 'lmdb';
      this._migrateJsonlToLmdb();   // one-time, no-op if already done
    } else {
      this._backend = new JsonlBackend(this._memDir);
      this._backendName = 'jsonl';
    }
  }

  // One-time migration: if an old store.jsonl exists and the LMDB is empty,
  // import the JSONL entries into LMDB then rename the file so it isn't
  // re-imported on the next start.
  _migrateJsonlToLmdb() {
    const storePath = path.join(this._memDir, 'store.jsonl');
    const donePath  = path.join(this._memDir, 'store.jsonl.migrated');
    if (!fs.existsSync(storePath) || fs.existsSync(donePath)) return;

    try {
      const raw = fs.readFileSync(storePath, 'utf8');
      if (!raw.trim()) return;

      const now   = nowMs();
      const byKey = new Map();
      for (const line of raw.split('\n')) {
        if (!line) continue;
        try {
          const e = JSON.parse(line);
          if (e._del) { byKey.delete(e.k); continue; }
          if (e.ttl > 0 && (now - e.ts) > e.ttl) continue;
          const prev = byKey.get(e.k);
          if (!prev || e.seq > prev.seq) byKey.set(e.k, e);
        } catch (_) {}
      }

      let imported = 0;
      for (const e of byKey.values()) {
        this._backend.put(e.k, e.v, { tags: e.tags || [], ttl: e.ttl || 0 });
        imported++;
      }

      fs.renameSync(storePath, donePath);
      console.log(`[cortexMemory] migrated ${imported} entries from JSONL → LMDB`);
    } catch (err) {
      console.warn(`[cortexMemory] JSONL→LMDB migration skipped: ${err.message}`);
    }
  }

  // ── Shared signals stream (ring-buffer, both backends) ────────────────────

  _signalsPath() { return path.join(this._memDir, 'signals.jsonl'); }

  signal(event, data = {}) {
    const line = JSON.stringify({ event, data, ts: nowMs() });
    try {
      fs.appendFileSync(this._signalsPath(), line + '\n', 'utf8');
      this._trimSignals();
    } catch (_) {}
  }

  _trimSignals() {
    try {
      const st = fs.statSync(this._signalsPath());
      if (st.size < cfg.signalLines() * 200 * 1.5) return;
      const raw   = readSafe(this._signalsPath());
      if (!raw) return;
      const lines = raw.split('\n').filter(Boolean);
      if (lines.length > cfg.signalLines())
        writeAtomic(this._signalsPath(), lines.slice(-cfg.signalLines()).join('\n') + '\n');
    } catch (_) {}
  }

  signals(n = 50) {
    const raw = readSafe(this._signalsPath());
    if (!raw) return [];
    return raw.split('\n').filter(Boolean).slice(-n).reverse()
      .map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
  }

  // ── Public API (delegates to active backend) ──────────────────────────────

  put(key, value, opts = {})          { return this._backend.put(key, value, opts); }
  get(key)                            { return this._backend.get(key); }
  del(key)                            { return this._backend.del(key); }
  byTag(tag)                          { return this._backend.byTag(tag); }
  recent(n = 10, opts = {})           { return this._backend.recent(n, opts); }

  async getOrCompute(key, factory, opts = {}) {
    const existing = this.get(key);
    if (existing !== null) return existing;
    const value = await factory();
    if (value !== undefined && value !== null) this.put(key, value, opts);
    return value;
  }

  compact() { return this._backend.compact(); }

  stats() {
    const s = this._backend.stats();
    let signalLines = 0;
    try { signalLines = readSafe(this._signalsPath())?.split('\n').filter(Boolean).length || 0; } catch (_) {}
    return { ...s, signalLines };
  }

  // Health report consumed by the dashboard and server startup checks.
  health() {
    const installed = lmdbAvailable();
    const active    = this._backendName === 'lmdb';
    let version     = null;
    if (installed) {
      try { version = require(path.join(__dirname, '..', 'node_modules', 'lmdb', 'package.json')).version; } catch (_) {}
    }
    return {
      ok:              true,
      backend:         this._backendName,
      lmdbInstalled:   installed,
      lmdbActive:      active,
      lmdbVersion:     version,
      lmdbInstallError: lmdbInstallError,
      fallbackReason:  installed ? null : 'lmdb not installed — run: cd server && npm install lmdb',
    };
  }

  close() { this._backend.close(); }
}

// ── Module-level singleton registry ───────────────────────────────────────────

const _instances = new Map();

function getInstance(baseDir) {
  if (!_instances.has(baseDir)) _instances.set(baseDir, new CortexMemory(baseDir));
  return _instances.get(baseDir);
}

function closeAll() {
  for (const inst of _instances.values()) { try { inst.close(); } catch (_) {} }
  _instances.clear();
}

module.exports = { CortexMemory, getInstance, closeAll, lmdbAvailable, LRUCache };
