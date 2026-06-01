'use strict';

// KB P2P sync worker — runs as a worker_threads thread.
//
// Improvements over baseline:
//   1. Conflict resolution  — lastModifiedMs per file; only write if incoming is newer
//   2. Persisted sync stamp — survives restarts; reconnecting peers get delta, not full dump
//   3. Deletion propagation — detect deleted files via manifest; guard against race
//   4. GossipSub batching   — split large change sets across multiple messages
//   5. HMAC authentication  — PRX_P2P_SECRET; all messages signed; unsigned dropped
//   6. Periodic reconcile   — broadcast manifest fingerprint hourly; pull missing deltas
//   7. File-path reporting  — surface which files moved in each sync to the dashboard
//
// Config:
//   PRX_P2P_ENABLED=Y
//   PRX_P2P_PORT=7001
//   PRX_P2P_SECRET=               (shared secret; if blank, auth is disabled)
//   PRX_P2P_BOOTSTRAP_NODES=      (comma-sep multiaddrs; blank = public IPFS defaults)
//   PRX_P2P_MDNS_ENABLED=Y        (LAN mDNS auto-discovery; set N in Docker)
//   PRX_P2P_RECONCILE_MINS=60     (how often to broadcast reconcile fingerprint)
//   PRX_KB_SYNC_TRIGGER=session|filesystem|both
//   PRX_KB_SYNC_DEBOUNCE_SECS=3
//   PRX_KB_MODE=distributed       (required; local exits immediately)

const { parentPort }  = require('worker_threads');
const fs              = require('fs');
const path            = require('path');
const os              = require('os');
const crypto          = require('crypto');
const https           = require('https');

// ── Constants ─────────────────────────────────────────────────────────────────

const TOPIC         = 'prevoyant/kb-sync/1';
const SYNC_PROTO    = '/prevoyant/kb-sync-req/1';
const CORTEX_OBS_TOPIC     = 'prevoyant/cortex-sync/observations/1'; // lightweight facts: context, pattern, decision, hotspot…
const CORTEX_SESSION_TOPIC = 'prevoyant/cortex-sync/sessions/1';      // session-summary type (larger, infrequent)
const CORTEX_TOPIC_LEGACY  = 'prevoyant/cortex-sync/1';               // kept for backward compat with pre-1.3.5 nodes
const CORTEX_PROTO         = '/prevoyant/cortex-query/1';
const KEY_FILE             = path.join(os.homedir(), '.prevoyant', 'server', 'p2p-key.b64');
const SIGNAL_FILE          = path.join(os.homedir(), '.prevoyant', '.kb-updated');
const MANIFEST_FILE        = path.join(os.homedir(), '.prevoyant', '.p2p-manifest.json');
const SYNC_TS_FILE         = path.join(os.homedir(), '.prevoyant', '.p2p-synced-at');
const CORTEX_SYNC_TS_FILE  = path.join(os.homedir(), '.prevoyant', '.p2p-cortex-sync.json');

// Upstash peer-presence keys
const P2P_PEER_KEY_PREFIX = 'prx:p2p:peer:';
const P2P_PEER_TTL_SECS   = 7200; // 2 h — refreshed each reconcile cycle

// GossipSub hard limit is 1 MB; stay well under it
const MAX_GOSSIP_BYTES  = 750_000;
// No size limit for stream-based full sync
const DEFAULT_BOOTSTRAP = [
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN',
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa',
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb',
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmcZf59bWwK5XFi76CZX8cbJ4BhTzzA3gU1ZjYZcYW3dwt',
];

// ── Config helpers ────────────────────────────────────────────────────────────

const p2pPort         = () => parseInt(process.env.PRX_P2P_PORT || '7001', 10);
const kbMode          = () => (process.env.PRX_KB_MODE || 'local').toLowerCase();
const syncTrigger     = () => (process.env.PRX_KB_SYNC_TRIGGER || 'session').toLowerCase();
const debounceMs      = () => parseInt(process.env.PRX_KB_SYNC_DEBOUNCE_SECS || '3', 10) * 1000;
const mdnsEnabled     = () => (process.env.PRX_P2P_MDNS_ENABLED || 'Y').toUpperCase() !== 'N';
const machineName     = () => (process.env.PRX_KB_SYNC_MACHINE || os.hostname()).trim();
const p2pSecret       = () => (process.env.PRX_P2P_SECRET || '').trim();
const reconcileMins   = () => parseInt(process.env.PRX_P2P_RECONCILE_MINS    || '60', 10);
const trickleEnabled   = () => (process.env.PRX_P2P_TRICKLE || 'N').toUpperCase() === 'Y';
const cortexMeshEnabled = () => (process.env.PRX_CORTEX_P2P_ENABLED || 'N').toUpperCase() === 'Y';
// Trickle internals are self-deterministic — initial values, then adapted per-batch by RTT feedback.
const TRICKLE_INIT_DELAY_MS   = 500;
const TRICKLE_INIT_BATCH_SIZE = 2;

const bootstrapList   = () => {
  const env = (process.env.PRX_P2P_BOOTSTRAP_NODES || '').trim();
  return env ? env.split(',').map(s => s.trim()).filter(Boolean) : DEFAULT_BOOTSTRAP;
};

const kbDir = () =>
  process.env.PRX_KB_LOCAL_CLONE || path.join(os.homedir(), '.prevoyant', 'kb');

// ── Logging ───────────────────────────────────────────────────────────────────

function log(level, msg) {
  const ts = new Date().toISOString();
  if (parentPort) parentPort.postMessage({ type: 'log', level, msg, ts });
  console.log(`[${ts}] [p2p/${level}] ${msg}`);
}

// ── Cortex mesh cache ─────────────────────────────────────────────────────────
//
// In-worker observation store — populated from:
//   (a) main thread snapshots   (cortex-snapshot / cortex-broadcast messages)
//   (b) peer GossipSub messages (CORTEX_OBS_TOPIC / CORTEX_SESSION_TOPIC / CORTEX_TOPIC_LEGACY)
// Used to answer /prevoyant/cortex-query/1 stream requests from other peers.

const MAX_CORTEX_CACHE = 2000;
const cortexCache = new Map(); // key → { key, value, tags, sourceNode, ts }

function cortexCacheSet(key, value, tags, sourceNode) {
  cortexCache.set(key, {
    key,
    value:      value      || null,
    tags:       tags       || [],
    sourceNode: sourceNode || null,
    ts:         (value && value.ts) || Date.now(),
  });
  if (cortexCache.size > MAX_CORTEX_CACHE) {
    // Evict the oldest entry (Map preserves insertion order)
    cortexCache.delete(cortexCache.keys().next().value);
  }
}

// ── Per-peer cortex sync timestamps (differential sync) ───────────────────────
// Tracks the last successful observation dump from each peer so reconnects
// only pull observations added since the last successful sync — not a full replay.
// Loaded from disk so the delta window survives worker restarts.
const peerCortexSyncTs = loadCortexSyncTs(); // peerIdStr → lastSuccessfulDumpMs

// ── HMAC authentication ───────────────────────────────────────────────────────

function hmacSign(data) {
  const secret = p2pSecret();
  if (!secret) return '';
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

function hmacVerify(data, sig) {
  const secret = p2pSecret();
  if (!secret) return true; // auth disabled — accept all
  const expected = crypto.createHmac('sha256', secret).update(data).digest('hex');
  // Constant-time comparison
  try { return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig || '')); }
  catch (_) { return false; }
}

// ── AES-256-GCM content encryption (optional — PRX_P2P_ENCRYPT=Y) ─────────────
// Key is derived once from PRX_P2P_SECRET; encryption is per-file (random IV).
// When PRX_P2P_SECRET is blank, PRX_P2P_ENCRYPT is silently ignored.

function getEncKey() {
  if ((process.env.PRX_P2P_ENCRYPT || 'N').toUpperCase() !== 'Y') return null;
  const secret = p2pSecret();
  if (!secret) return null;
  return crypto.createHash('sha256').update('prevoyant-p2p-enc-v1:' + secret).digest();
}

function encryptContent(plaintext, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { iv: iv.toString('hex'), ciphertext: enc.toString('base64'), tag: cipher.getAuthTag().toString('hex') };
}

function decryptContent(enc, key) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(enc.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(enc.tag, 'hex'));
  return Buffer.concat([
    decipher.update(Buffer.from(enc.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

// Wrap outbound payload with HMAC envelope
function signEnvelope(payload) {
  const payloadStr = JSON.stringify(payload);
  return JSON.stringify({ v: 2, payload: payloadStr, sig: hmacSign(payloadStr) });
}

// Unwrap and verify inbound envelope; returns parsed payload or null on failure
function verifyEnvelope(raw) {
  let outer;
  try { outer = JSON.parse(raw); } catch (_) { return null; }

  // v2 format: { v, payload, sig }
  if (outer.v === 2 && typeof outer.payload === 'string') {
    if (!hmacVerify(outer.payload, outer.sig)) {
      log('warn', 'Dropping message: HMAC verification failed');
      return null;
    }
    try { return JSON.parse(outer.payload); } catch (_) { return null; }
  }

  // v1 / legacy format (no envelope) — accept only when auth is disabled
  if (!p2pSecret()) return outer;
  log('warn', 'Dropping legacy (unsigned) message — PRX_P2P_SECRET is set');
  return null;
}

// ── Atomic file write ─────────────────────────────────────────────────────────

function writeAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, typeof content === 'string' ? content : content.toString('utf8'));
  fs.renameSync(tmp, file);
}

// ── Manifest (tracks all KB files + mtimes for deletion detection) ────────────
// Format: { [relativePath]: mtime }

function loadManifest() {
  try { return JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8')); }
  catch (_) { return {}; }
}

function saveManifest(files) {
  const m = {};
  for (const f of files) m[f.path] = f.lastModifiedMs || 0;
  try { writeAtomic(MANIFEST_FILE, JSON.stringify(m)); } catch (_) {}
}

// ── Persisted sync timestamp (survives worker restarts) ───────────────────────

function loadLastSyncTs() {
  try { return parseInt(fs.readFileSync(SYNC_TS_FILE, 'utf8').trim(), 10) || 0; }
  catch (_) { return 0; }
}

function saveLastSyncTs(ts) {
  try { writeAtomic(SYNC_TS_FILE, String(ts)); } catch (_) {}
}

// ── Persisted per-peer cortex sync timestamps ─────────────────────────────────

function loadCortexSyncTs() {
  try {
    const raw = JSON.parse(fs.readFileSync(CORTEX_SYNC_TS_FILE, 'utf8'));
    return new Map(Object.entries(raw).map(([k, v]) => [k, Number(v)]));
  } catch (_) { return new Map(); }
}

function saveCortexSyncTs(map) {
  try {
    const obj = {};
    for (const [k, v] of map) obj[k] = v;
    writeAtomic(CORTEX_SYNC_TS_FILE, JSON.stringify(obj));
  } catch (_) {}
}

// ── Upstash peer discovery (WAN bootstrap) ────────────────────────────────────
// Publishes this node's multiaddrs to Upstash so peers on other networks
// can discover each other without hardcoded bootstrap addresses.

function upstashP2PRequest(command) {
  const url   = process.env.PRX_UPSTASH_REDIS_URL   || '';
  const token = process.env.PRX_UPSTASH_REDIS_TOKEN  || '';
  if (!url || !token) return Promise.resolve(null);
  let parsed;
  try { parsed = new URL(url.endsWith('/') ? url.slice(0, -1) : url); }
  catch (_) { return Promise.resolve(null); }
  const payload = Buffer.from(JSON.stringify(command));
  return new Promise((resolve) => {
    const req = https.request({
      hostname: parsed.hostname,
      path:     '/',
      method:   'POST',
      headers: {
        'Authorization':  `Bearer ${token}`,
        'Content-Type':   'application/json',
        'Content-Length': payload.length,
      },
    }, res => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(raw).result); } catch (_) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(5000, () => { req.destroy(); resolve(null); });
    req.write(payload);
    req.end();
  });
}

async function upstashP2PPublish(addrs) {
  if (!addrs || !addrs.length) return;
  try {
    await upstashP2PRequest([
      'SET', `${P2P_PEER_KEY_PREFIX}${machineName()}`,
      JSON.stringify({ machine: machineName(), addrs, ts: Date.now() }),
      'EX', P2P_PEER_TTL_SECS,
    ]);
    log('info', `P2P presence published to Upstash (${addrs.length} addr(s))`);
  } catch (e) {
    log('warn', `Upstash P2P publish failed: ${e.message}`);
  }
}

async function upstashP2PDiscover() {
  const url   = process.env.PRX_UPSTASH_REDIS_URL   || '';
  const token = process.env.PRX_UPSTASH_REDIS_TOKEN  || '';
  if (!url || !token) {
    log('info', 'Upstash WAN peer discovery skipped — PRX_UPSTASH_REDIS_URL / PRX_UPSTASH_REDIS_TOKEN not set. ' +
      'To enable cross-network peer discovery: (1) sign up free at https://upstash.com, ' +
      '(2) create a Redis database, (3) copy the REST URL and token into PRX_UPSTASH_REDIS_URL / PRX_UPSTASH_REDIS_TOKEN. ' +
      'mDNS LAN discovery and any PRX_P2P_BOOTSTRAP_NODES remain active.');
    return [];
  }
  try {
    const keys = await upstashP2PRequest(['KEYS', `${P2P_PEER_KEY_PREFIX}*`]);
    if (!Array.isArray(keys) || !keys.length) return [];
    const remoteKeys = keys.filter(k => k !== `${P2P_PEER_KEY_PREFIX}${machineName()}`);
    if (!remoteKeys.length) return [];
    const values = await upstashP2PRequest(['MGET', ...remoteKeys]);
    const discovered = [];
    for (const v of (values || [])) {
      if (!v) continue;
      try {
        const peer = JSON.parse(v);
        if (Array.isArray(peer.addrs)) discovered.push(...peer.addrs);
      } catch (_) {}
    }
    if (discovered.length) log('info', `Upstash P2P discovery: ${discovered.length} addr(s) from ${remoteKeys.length} remote node(s)`);
    return discovered;
  } catch (e) {
    log('warn', `Upstash P2P discovery failed: ${e.message}`);
    return [];
  }
}

// ── File scanning ─────────────────────────────────────────────────────────────

// Scan KB dir for .md files modified since sinceMs.
// Returns [{ path, content, lastModifiedMs }] sorted newest-first.
// Stops accumulating content once bytes > maxBytes, but still records paths.
// Async so the libp2p event loop stays responsive during large KB scans.
async function gatherChangedFiles(dir, sinceMs, maxBytes) {
  if (!fs.existsSync(dir)) return [];
  const limit = maxBytes !== undefined ? maxBytes : MAX_GOSSIP_BYTES;
  const out = [];
  let totalBytes = 0;
  let truncated = false;

  const scan = async (d) => {
    let entries;
    try { entries = await fs.promises.readdir(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) { await scan(full); continue; }
      if (!e.name.endsWith('.md')) continue;
      try {
        const stat = await fs.promises.stat(full);
        if (stat.mtimeMs < sinceMs) continue;
        const rel = path.relative(dir, full);
        if (truncated) { out.push({ path: rel, content: null, lastModifiedMs: stat.mtimeMs }); continue; }
        const content = await fs.promises.readFile(full, 'utf8');
        totalBytes += content.length;
        if (totalBytes > limit) {
          truncated = true;
          log('warn', `Bundle exceeds ${limit} bytes — remaining files queued for next batch`);
          out.push({ path: rel, content: null, lastModifiedMs: stat.mtimeMs });
          continue;
        }
        const encKey = getEncKey();
        const payload = encKey
          ? { encrypted: encryptContent(content, encKey), content: null }
          : { content };
        out.push({ path: rel, lastModifiedMs: stat.mtimeMs, ...payload });
      } catch (_) {}
    }
  };
  await scan(dir);
  // Sort newest-first so most-recent changes ship first when truncated
  out.sort((a, b) => (b.lastModifiedMs || 0) - (a.lastModifiedMs || 0));
  return out;
}

// Gather ALL .md files (no size cap — for stream-based full sync).
// Async so the libp2p event loop stays responsive during large KB scans.
async function gatherAllFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  const encKey = getEncKey();
  const scan = async (d) => {
    let entries;
    try { entries = await fs.promises.readdir(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) { await scan(full); continue; }
      if (!e.name.endsWith('.md')) continue;
      try {
        const stat = await fs.promises.stat(full);
        const content = await fs.promises.readFile(full, 'utf8');
        const payload = encKey
          ? { encrypted: encryptContent(content, encKey), content: null }
          : { content };
        out.push({ path: path.relative(dir, full), lastModifiedMs: stat.mtimeMs, ...payload });
      } catch (_) {}
    }
  };
  await scan(dir);
  return out;
}

// Latest mtime across all .md files (0 if empty/missing).
function getKbLatestMtime(dir) {
  let latest = 0;
  if (!fs.existsSync(dir)) return latest;
  const scan = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) { scan(full); continue; }
      if (!e.name.endsWith('.md')) continue;
      try { const m = fs.statSync(full).mtimeMs; if (m > latest) latest = m; } catch (_) {}
    }
  };
  scan(dir);
  return latest;
}

// Fingerprint: sha256 of sorted "path:mtime" pairs — cheap manifest comparison.
async function kbFingerprint(dir) {
  const files = (await gatherAllFiles(dir)).map(f => `${f.path}:${f.lastModifiedMs}`).sort();
  return crypto.createHash('sha256').update(files.join('\n')).digest('hex').slice(0, 16);
}

// ── File application with conflict resolution ─────────────────────────────────

// Apply an array of { path, content, lastModifiedMs } to the local KB.
// Only writes a file if the incoming version is strictly newer than what's on disk.
// Returns { written, skipped }.
function applyFiles(files, dir) {
  let written = 0, skipped = 0;
  const encKey = getEncKey();
  for (const f of files) {
    if (!f.path) continue;
    // Resolve content: either plaintext or decrypt if encrypted
    let content = null;
    if (typeof f.content === 'string') {
      content = f.content;
    } else if (f.encrypted) {
      try {
        // Try with our key first; if no key, fall back to raw ciphertext object (shouldn't happen)
        content = encKey ? decryptContent(f.encrypted, encKey) : null;
      } catch (e) {
        log('warn', `Decryption failed for ${f.path}: ${e.message} — skipping`);
        continue;
      }
    }
    if (typeof content !== 'string') continue;

    const safe = path.normalize(f.path).replace(/^(\.\.(\/|\\|$))+/, '');
    const dest = path.join(dir, safe);
    try {
      if (fs.existsSync(dest) && f.lastModifiedMs) {
        const localMtime = fs.statSync(dest).mtimeMs;
        if (f.lastModifiedMs <= localMtime) { skipped++; continue; } // local is same or newer
      }
      writeAtomic(dest, content);
      written++;
    } catch (e) {
      log('warn', `Could not write ${safe}: ${e.message}`);
    }
  }
  return { written, skipped };
}

// Apply deletions: [{ path, deletedAt }].
// Only deletes a file if it hasn't been locally modified AFTER the remote deletion time.
function applyDeletions(deletions, dir) {
  let deleted = 0;
  for (const d of deletions) {
    if (!d.path) continue;
    const safe = path.normalize(d.path).replace(/^(\.\.(\/|\\|$))+/, '');
    const dest = path.join(dir, safe);
    try {
      if (!fs.existsSync(dest)) continue;
      if (d.deletedAt) {
        const localMtime = fs.statSync(dest).mtimeMs;
        if (localMtime > d.deletedAt) {
          log('info', `Skipping deletion of ${safe} — local version newer than remote deletion`);
          continue;
        }
      }
      fs.unlinkSync(dest);
      deleted++;
    } catch (e) {
      log('warn', `Could not delete ${safe}: ${e.message}`);
    }
  }
  return deleted;
}

// ── Peer key persistence ──────────────────────────────────────────────────────

async function loadOrGenerateKey() {
  let generateKeyPair, privateKeyFromProtobuf, privateKeyToProtobuf;
  try {
    ({ generateKeyPair, privateKeyFromProtobuf, privateKeyToProtobuf } =
      await import('@libp2p/crypto/keys'));
  } catch (_) {
    const cryptoMod = await import('@libp2p/crypto');
    generateKeyPair        = cryptoMod.keys?.generateKeyPair ?? cryptoMod.generateKeyPair;
    privateKeyFromProtobuf = cryptoMod.keys?.unmarshalPrivateKey ?? cryptoMod.unmarshalPrivateKey;
    privateKeyToProtobuf   = cryptoMod.keys?.marshalPrivateKey   ?? cryptoMod.marshalPrivateKey;
  }

  if (fs.existsSync(KEY_FILE)) {
    try {
      const raw = Buffer.from(fs.readFileSync(KEY_FILE, 'utf8').trim(), 'base64');
      return await privateKeyFromProtobuf(new Uint8Array(raw));
    } catch (e) {
      log('warn', `Existing P2P key unreadable (${e.message}) — regenerating`);
    }
  }

  const key = await generateKeyPair('Ed25519');
  try {
    fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
    const bytes = privateKeyToProtobuf(key);
    fs.writeFileSync(KEY_FILE, Buffer.from(bytes).toString('base64'), 'utf8');
    log('info', `New P2P peer key saved to ${KEY_FILE}`);
  } catch (e) {
    log('warn', `Could not persist P2P key (${e.message}) — ID will change on restart`);
  }
  return key;
}

// ── Peer list ─────────────────────────────────────────────────────────────────

function buildPeerList(node) {
  try {
    return node.getConnections().map(conn => ({
      id:        conn.remotePeer.toString(),
      addrs:     [conn.remoteAddr.toString()],
      latencyMs: null,
      protocols: conn.remoteAddr.protoNames ? conn.remoteAddr.protoNames() : [],
    }));
  } catch (_) { return []; }
}

function broadcastPeers(node, selfId, addrs) {
  if (!parentPort) return;
  parentPort.postMessage({
    type:   'peers-updated',
    selfId: selfId || node.peerId.toString(),
    addrs:  addrs  || node.getMultiaddrs().map(a => a.toString()),
    peers:  buildPeerList(node),
    topic:  TOPIC,
  });
}

// ── Cortex observation broadcast ──────────────────────────────────────────────

async function broadcastCortexObs(node, key, value, tags) {
  const payload = {
    type:       'cortex-observe',
    machine:    machineName(),
    key,
    value:      value || null,
    tags:       tags  || [],
    sourceNode: machineName(),
    ts:         Date.now(),
  };
  cortexCacheSet(key, value, tags, machineName());
  try {
    const envelope    = signEnvelope(payload);
    // Route session summaries to their own topic so per-session agent queries
    // aren't burdened with large infrequent blobs.
    const obsType     = (value && value.type) || 'context';
    const targetTopic = obsType === 'session-summary' ? CORTEX_SESSION_TOPIC : CORTEX_OBS_TOPIC;
    await node.services.pubsub.publish(targetTopic, new TextEncoder().encode(envelope));
    if (parentPort) parentPort.postMessage({ type: 'cortex-stats', observationsOut: 1, total: cortexCache.size });
  } catch (e) {
    log('warn', `Cortex broadcast failed: ${e.message}`);
  }
}

// ── Cortex dump request (stream-based full pull from a peer) ──────────────────

async function requestCortexDump(node, peerId, sinceMs) {
  const reqBody = { sinceMs: sinceMs || 0, machine: machineName() };
  const sig     = p2pSecret() ? hmacSign(JSON.stringify(reqBody)) : '';
  const req     = Buffer.from(JSON.stringify({ ...reqBody, sig }));
  try {
    const stream = await node.dialProtocol(peerId, CORTEX_PROTO);
    await stream.sink([req]);
    const chunks = [];
    for await (const chunk of stream.source) {
      chunks.push(chunk instanceof Uint8Array ? chunk : Buffer.from(chunk.slice()));
    }
    if (!chunks.length) return;
    const resp = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    let merged = 0;
    for (const obs of (resp.observations || [])) {
      if (!obs.key) continue;
      cortexCacheSet(obs.key, obs.value, obs.tags, obs.sourceNode || resp.machine);
      if (parentPort) parentPort.postMessage({
        type:       'cortex-obs-received',
        key:        obs.key,
        value:      obs.value,
        tags:       obs.tags || [],
        sourceNode: obs.sourceNode || resp.machine,
        machine:    resp.machine,
      });
      merged++;
    }
    if (merged > 0) {
      log('info', `Cortex dump from ${resp.machine}: ${merged} observation(s) received`);
      if (parentPort) parentPort.postMessage({ type: 'cortex-stats', observationsIn: merged, total: cortexCache.size });
    }
    // Record success timestamp regardless of merge count so reconnects use
    // differential pull even when the peer had nothing new this time.
    const peerIdStr = peerId.toString ? peerId.toString() : String(peerId);
    peerCortexSyncTs.set(peerIdStr, Date.now());
    saveCortexSyncTs(peerCortexSyncTs);
  } catch (e) {
    const msg = String(e.message || '').toLowerCase();
    if (!msg.includes('protocol') && !msg.includes('unsupported') && !msg.includes('no handler')) {
      log('warn', `Cortex dump request failed: ${e.message}`);
    }
  }
}

// ── Payload size helper ───────────────────────────────────────────────────────

// Returns serialized byte estimate for a file entry (works for plaintext + encrypted payloads).
function filePayloadSize(f) {
  if (typeof f.content === 'string') return f.content.length;
  if (f.encrypted?.ciphertext)       return f.encrypted.ciphertext.length + 100; // +100 for IV/tag JSON
  return 0;
}

// ── Outbound: bulk publish (all batches back-to-back) ─────────────────────────

async function bulkPublish(node, ticket, sendableFiles, deletions) {
  const batches = [];
  let current = [], currentSize = 0;
  for (const f of sendableFiles) {
    const sz = filePayloadSize(f);
    if (current.length && currentSize + sz > MAX_GOSSIP_BYTES) {
      batches.push(current); current = []; currentSize = 0;
    }
    current.push(f); currentSize += sz;
  }
  if (current.length) batches.push(current);
  if (!batches.length) batches.push([]); // at least one message for deletions only

  const batchTotal = batches.length;
  let published = 0;
  if (parentPort) parentPort.postMessage({ type: 'transfer-progress', phase: 'sending', done: 0, total: sendableFiles.length, file: '' });

  for (let i = 0; i < batches.length; i++) {
    const payload = {
      machine: machineName(), ticket: ticket || '', ts: Date.now(),
      batchIndex: i, batchTotal,
      files: batches[i],
      deletions: i === 0 ? deletions : [],
    };
    const envelope = signEnvelope(payload);
    let ok = false;
    for (let attempt = 0; attempt < 3 && !ok; attempt++) {
      try {
        await node.services.pubsub.publish(TOPIC, new TextEncoder().encode(envelope));
        published += batches[i].length; ok = true;
      } catch (e) {
        if (attempt < 2) await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
        else log('warn', `Publish batch ${i} failed after 3 attempts: ${e.message}`);
      }
    }
    if (parentPort) parentPort.postMessage({ type: 'transfer-progress', phase: 'sending', done: published, total: sendableFiles.length, file: '' });
  }

  if (parentPort) parentPort.postMessage({ type: 'transfer-progress', phase: 'done' });
  return { published, batchTotal };
}

// ── Outbound: trickle publish (incremental, adaptive inter-batch delay) ────────

async function tricklePublish(node, ticket, sendableFiles, deletions) {
  let   batchSz        = TRICKLE_INIT_BATCH_SIZE;
  let   delay          = TRICKLE_INIT_DELAY_MS;
  const MIN_DELAY      = 100, MAX_DELAY = 10_000;
  let   totalPublished = 0;
  let   cursor         = 0;   // index into sendableFiles; advances by adaptive batchSz each round
  let   batchIndex     = 0;

  if (parentPort) parentPort.postMessage({ type: 'transfer-progress', phase: 'sending', done: 0, total: sendableFiles.length, file: '' });

  while (cursor < sendableFiles.length || (batchIndex === 0 && deletions.length)) {
    const batch = sendableFiles.slice(cursor, cursor + batchSz);
    const i = batchIndex;
    // batchTotal is unknown up front (batchSz adapts); use 0 as sentinel
    const payload = {
      machine: machineName(), ticket: ticket || '', ts: Date.now(),
      batchIndex: i, batchTotal: 0,
      files: batch,
      deletions: i === 0 ? deletions : [],
    };
    const envelope = signEnvelope(payload);
    const t0 = Date.now();
    let ok = false;
    for (let attempt = 0; attempt < 3 && !ok; attempt++) {
      try {
        await node.services.pubsub.publish(TOPIC, new TextEncoder().encode(envelope));
        ok = true; totalPublished += batch.length;
      } catch (e) {
        if (attempt < 2) await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
        else log('warn', `Trickle batch ${i} failed: ${e.message}`);
      }
    }

    // Adaptive: fast RTT → shrink delay + grow batch; slow/failed → lengthen delay + shrink batch
    const rtt = Date.now() - t0;
    if (ok && rtt < 300) {
      delay   = Math.max(MIN_DELAY, Math.round(delay * 0.85));
      batchSz = Math.min(10, batchSz + 1);
    } else if (!ok || rtt > 1000) {
      delay   = Math.min(MAX_DELAY, Math.round(delay * 1.50));
      batchSz = Math.max(1, batchSz - 1);
    }

    cursor += batch.length || 1; // advance; guard against empty batch (deletions-only first pass)
    batchIndex++;

    if (parentPort) parentPort.postMessage({ type: 'transfer-progress', phase: 'sending', done: totalPublished, total: sendableFiles.length, file: batch[0]?.path || '' });

    const hasMore = cursor < sendableFiles.length;
    if (hasMore) await new Promise(r => setTimeout(r, delay));
  }

  if (parentPort) parentPort.postMessage({ type: 'transfer-progress', phase: 'done' });
  return { published: totalPublished, batchTotal: batchIndex };
}

// ── Outbound: entry point — branches to bulk or trickle ──────────────────────

let lastPublishMs = 0;

async function publishUpdate(node, ticket) {
  const sinceMs    = lastPublishMs || (Date.now() - 60_000);
  const allChanged = await gatherChangedFiles(kbDir(), sinceMs);

  // Detect deletions: paths in manifest but no longer on disk
  const manifest   = loadManifest();
  const currentSet = new Set((await gatherAllFiles(kbDir())).map(f => f.path));
  const deletionTs = Date.now();
  const deletions  = Object.keys(manifest)
    .filter(p => !currentSet.has(p))
    .map(p => ({ path: p, deletedAt: deletionTs }));

  // Sendable = files with plaintext content OR encrypted payload.
  // Skipped  = truncated entries (path+mtime only, no payload) — queued for next trigger.
  const sendableFiles = allChanged.filter(f => typeof f.content === 'string' || f.encrypted);
  const skippedFiles  = allChanged.filter(f => typeof f.content !== 'string' && !f.encrypted);

  if (!sendableFiles.length && !deletions.length) {
    log('info', 'No KB changes or deletions — skipping publish');
    return;
  }

  lastPublishMs = Date.now();

  const mode = trickleEnabled() ? 'trickle' : 'bulk';
  const { published, batchTotal } = trickleEnabled()
    ? await tricklePublish(node, ticket, sendableFiles, deletions)
    : await bulkPublish(node, ticket, sendableFiles, deletions);

  log('info', `Published ${published} file(s) in ${batchTotal} batch(es) [${mode}], ${deletions.length} deletion(s) — ticket=${ticket || '?'}`);

  saveManifest(await gatherAllFiles(kbDir()));

  if (parentPort) parentPort.postMessage({
    type:       'kb-notified',
    ticket,
    filesCount: published,
    filePaths:  sendableFiles.map(f => f.path).slice(0, 10),
  });

  if (skippedFiles.length) {
    log('warn', `${skippedFiles.length} file(s) exceeded batch budget — will publish on next trigger`);
  }
}

// ── Inbound: receive and apply a peer's GossipSub update ─────────────────────

async function applyUpdate(raw) {
  const payload = verifyEnvelope(raw);
  if (!payload) return;

  const { machine, ticket, files, deletions } = payload;
  if (machine === machineName()) return; // own echo

  log('info', `Received from ${machine} — files=${(files||[]).length} deletions=${(deletions||[]).length} ticket=${ticket}`);

  const { written, skipped } = applyFiles(files || [], kbDir());
  const deleted = applyDeletions(deletions || [], kbDir());

  if (written || deleted) {
    saveManifest(await gatherAllFiles(kbDir()));
    saveLastSyncTs(Date.now());
  }

  log('info', `Applied: wrote=${written} skipped=${skipped} deleted=${deleted} from ${machine}`);

  const filePaths = (files || []).filter(f => f.content !== null).map(f => f.path).slice(0, 10);

  if (parentPort) parentPort.postMessage({
    type:       'kb-synced',
    machine,
    ticket,
    filesCount: written,
    deleted,
    filePaths,
  });
}

// ── Inbound: reconcile fingerprint broadcast ──────────────────────────────────

async function applyReconcile(payload, node, onSync) {
  if (payload.machine === machineName()) return;
  const localFp  = await kbFingerprint(kbDir());
  const fpMatch  = payload.fingerprint === localFp;
  const peerObs  = typeof payload.observationCount === 'number' ? payload.observationCount : null;
  const obsDrift = peerObs !== null && peerObs !== cortexCache.size;

  if (fpMatch && !obsDrift) return; // fully in sync

  if (fpMatch && obsDrift) {
    log('info', `Reconcile: observation drift with ${payload.machine} (peer=${peerObs} local=${cortexCache.size}) — requesting cortex dump`);
    if (parentPort) parentPort.postMessage({ type: 'reconcile-needed', machine: payload.machine, cortexOnly: true });
    if (onSync) onSync({ cortexOnly: true });
    return;
  }

  log('info', `Reconcile fingerprint mismatch with ${payload.machine} — requesting delta sync`);
  if (parentPort) parentPort.postMessage({ type: 'reconcile-needed', machine: payload.machine });
  if (onSync) onSync({ cortexOnly: false });
}

// ── Signal file watcher ───────────────────────────────────────────────────────

let signalProcessing = false;

async function processSignalFile(node) {
  if (signalProcessing) return;
  signalProcessing = true;
  try {
    let ticketKey = '';
    try { ticketKey = fs.readFileSync(SIGNAL_FILE, 'utf8').trim(); }
    catch (_) { signalProcessing = false; return; }
    await publishUpdate(node, ticketKey);
    try { fs.unlinkSync(SIGNAL_FILE); } catch (_) {}
  } finally {
    signalProcessing = false;
  }
}

function startSignalWatcher(node) {
  if (fs.existsSync(SIGNAL_FILE)) processSignalFile(node);
  const dir = path.dirname(SIGNAL_FILE);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.watch(dir, (event, filename) => {
      if (filename === path.basename(SIGNAL_FILE) && event === 'rename') {
        if (fs.existsSync(SIGNAL_FILE)) processSignalFile(node);
      }
    });
    log('info', `Signal watcher active — ${SIGNAL_FILE}`);
  } catch (e) {
    log('warn', `Signal watcher failed: ${e.message}`);
  }
}

// ── Filesystem watcher ────────────────────────────────────────────────────────

let fsDebounceTimer = null;

function startFsWatcher(node) {
  const dir = kbDir();
  if (!dir) return;
  const schedule = () => {
    clearTimeout(fsDebounceTimer);
    fsDebounceTimer = setTimeout(async () => {
      fsDebounceTimer = null;
      await publishUpdate(node, 'manual');
    }, debounceMs());
  };
  try {
    fs.watch(dir, { recursive: true }, (_event, filename) => {
      if (!filename || !filename.endsWith('.md')) return;
      if (filename.startsWith('.')) return;
      schedule();
    });
    log('info', `Filesystem watcher active — ${dir}`);
  } catch (e) {
    log('warn', `Filesystem watcher failed: ${e.message}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

let halted    = false;
let libp2pNode = null;

if (parentPort) {
  parentPort.on('message', msg => {
    if (msg?.type === 'graceful-stop') {
      halted = true;
      if (libp2pNode) libp2pNode.stop().catch(() => {});
    }
    if (msg?.type === 'get-peers' && libp2pNode) broadcastPeers(libp2pNode);

    // Collective Intelligence Mesh — outbound broadcast
    if (msg?.type === 'cortex-broadcast' && libp2pNode && cortexMeshEnabled()) {
      broadcastCortexObs(libp2pNode, msg.key, msg.value, msg.tags).catch(() => {});
    }
    // Populate cache from main thread's current observation set (sent once on startup)
    if (msg?.type === 'cortex-snapshot') {
      for (const obs of (msg.observations || [])) {
        if (obs.key) cortexCacheSet(obs.key, obs.value, obs.tags, obs.sourceNode || machineName());
      }
      log('info', `Cortex cache seeded: ${cortexCache.size} observation(s) from main thread snapshot`);
    }
  });
}

(async function main() {
  if (kbMode() !== 'distributed') {
    log('warn', `PRX_KB_MODE=${kbMode()} — P2P requires distributed mode. Exiting.`);
    if (parentPort) parentPort.postMessage({ type: 'p2p-error', reason: 'P2P requires PRX_KB_MODE=distributed' });
    return;
  }

  const authMode = p2pSecret() ? 'HMAC-SHA256' : 'none (set PRX_P2P_SECRET to enable)';
  const xferMode = trickleEnabled() ? 'trickle (adaptive)' : 'bulk';
  log('info', `Starting — port=${p2pPort()} trigger=${syncTrigger()} mdns=${mdnsEnabled()} auth=${authMode} transfer=${xferMode}`);

  // ── Load libp2p ESM packages ───────────────────────────────────────────────
  let createLibp2p, tcp, noise, yamux, bootstrap, gossipsub;
  const peerDiscoveryPlugins = [];

  try {
    ({ createLibp2p } = await import('libp2p'));
    ({ tcp }         = await import('@libp2p/tcp'));
    ({ noise }       = await import('@chainsafe/libp2p-noise'));
    ({ yamux }       = await import('@libp2p/yamux'));
    ({ bootstrap }   = await import('@libp2p/bootstrap'));
    ({ gossipsub }   = await import('@libp2p/gossipsub'));
  } catch (e) {
    log('error', `Failed to load libp2p — run: cd server && npm install\n${e.message}`);
    if (parentPort) parentPort.postMessage({ type: 'p2p-error', reason: e.message });
    return;
  }

  // Discover WAN peers from Upstash before initialising the bootstrap plugin.
  // Falls back to empty list silently if Upstash is not configured.
  const upstashPeers = await upstashP2PDiscover();
  const allBootstrap = [...new Set([...bootstrapList(), ...upstashPeers])];
  peerDiscoveryPlugins.push(bootstrap({ list: allBootstrap }));

  if (mdnsEnabled()) {
    try {
      const { mdns } = await import('@libp2p/mdns');
      peerDiscoveryPlugins.push(mdns());
      log('info', 'mDNS LAN discovery enabled');
    } catch (_) {
      log('warn', 'mDNS not available — set PRX_P2P_MDNS_ENABLED=N to silence');
    }
  }

  // ── Peer key ──────────────────────────────────────────────────────────────
  let privateKey;
  try {
    privateKey = await loadOrGenerateKey();
  } catch (e) {
    log('warn', `Key load failed (${e.message}) — using ephemeral identity`);
    const { generateKeyPair } = await import('@libp2p/crypto/keys').catch(() =>
      import('@libp2p/crypto').then(m => ({ generateKeyPair: m.keys.generateKeyPair }))
    );
    privateKey = await generateKeyPair('Ed25519');
  }

  // ── Create node ───────────────────────────────────────────────────────────
  const nodeConfig = {
    addresses:            { listen: [`/ip4/0.0.0.0/tcp/${p2pPort()}`] },
    transports:           [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers:         [yamux()],
    peerDiscovery:        peerDiscoveryPlugins,
    services: {
      pubsub: gossipsub({ allowPublishToZeroPeers: true, emitSelf: false, doPX: false }),
    },
  };
  if (privateKey) nodeConfig.privateKey = privateKey;

  try {
    libp2pNode = await createLibp2p(nodeConfig);
  } catch (e) {
    log('error', `Failed to start libp2p node: ${e.message}`);
    if (parentPort) parentPort.postMessage({ type: 'p2p-error', reason: e.message });
    return;
  }

  const selfId = libp2pNode.peerId.toString();
  const addrs  = libp2pNode.getMultiaddrs().map(a => a.toString());
  log('info', `Node started — peer ID: ${selfId}`);
  if (parentPort) parentPort.postMessage({ type: 'p2p-started', selfId, addrs, topic: TOPIC });

  // Publish our multiaddrs to Upstash so WAN peers can find us.
  upstashP2PPublish(addrs).catch(() => {});

  // ── GossipSub subscriber ──────────────────────────────────────────────────
  libp2pNode.services.pubsub.subscribe(TOPIC);

  if (cortexMeshEnabled()) {
    libp2pNode.services.pubsub.subscribe(CORTEX_OBS_TOPIC);
    libp2pNode.services.pubsub.subscribe(CORTEX_SESSION_TOPIC);
    libp2pNode.services.pubsub.subscribe(CORTEX_TOPIC_LEGACY); // backward compat with pre-1.3.5 peers
    log('info', `Cortex P2P mesh active — obs=${CORTEX_OBS_TOPIC} sessions=${CORTEX_SESSION_TOPIC}`);
  }

  libp2pNode.services.pubsub.addEventListener('message', async evt => {
    try {
      const { topic, data } = evt.detail;

      // ── Cortex mesh messages ────────────────────────────────────────────
      // Accept on typed topics (obs/sessions) and legacy topic for backward compat.
      if ((topic === CORTEX_OBS_TOPIC || topic === CORTEX_SESSION_TOPIC || topic === CORTEX_TOPIC_LEGACY) && cortexMeshEnabled()) {
        const raw = new TextDecoder().decode(data);
        let outer, innerPeek;
        try { outer = JSON.parse(raw); } catch (_) { return; }
        const innerRaw = (outer.v === 2 && outer.payload) ? outer.payload : raw;
        try { innerPeek = JSON.parse(innerRaw); } catch (_) {}
        if (innerPeek?.machine === machineName()) return; // own echo
        const payload = verifyEnvelope(raw);
        if (!payload) return;
        const { type: msgType, key, value, tags, sourceNode } = payload;
        if (msgType === 'cortex-observe' || msgType === 'cortex-confirm') {
          if (key) {
            cortexCacheSet(key, value, tags, sourceNode || payload.machine);
            if (parentPort) {
              parentPort.postMessage({
                type:       'cortex-obs-received',
                key,
                value,
                tags:       tags || [],
                sourceNode: sourceNode || payload.machine,
                machine:    payload.machine,
              });
              parentPort.postMessage({ type: 'cortex-stats', observationsIn: 1, total: cortexCache.size });
            }
          }
        } else if (msgType === 'cortex-retract' && key) {
          cortexCache.delete(key);
          if (parentPort) parentPort.postMessage({ type: 'cortex-retract-received', key });
        }
        return;
      }

      if (topic !== TOPIC) return;
      const raw = new TextDecoder().decode(data);

      // Peek at machine field before full verification to discard own echoes fast
      let peek;
      try { peek = JSON.parse(raw); } catch (_) { return; }
      const innerRaw = (peek.v === 2 && peek.payload) ? peek.payload : raw;
      let innerPeek;
      try { innerPeek = JSON.parse(innerRaw); } catch (_) {}
      if (innerPeek?.machine === machineName()) return;

      // Dispatch by message type
      if (innerPeek?.type === 'reconcile') {
        const payload = verifyEnvelope(raw);
        if (payload) await applyReconcile(payload, libp2pNode, ({ cortexOnly }) => {
          const peers = buildPeerList(libp2pNode);
          if (!peers.length) return;
          if (cortexOnly) requestCortexDump(libp2pNode, peers[0].id, 0).catch(() => {});
          else requestDeltaSync(peers[0].id, loadLastSyncTs());
        });
      } else {
        await applyUpdate(raw);
      }
    } catch (e) {
      log('warn', `Inbound message error: ${e.message}`);
    }
  });

  // ── Stream-based full/delta sync protocol ────────────────────────────────
  // Request:  { sinceMs, machine, sig? }
  // Response: { machine, files, deletions, fingerprint }

  // Track whether we've done our initial catch-up this session.
  // Also check persisted stamp — if we synced recently, skip full dump.
  let syncedFromPeer = loadLastSyncTs() > 0;

  await libp2pNode.handle(SYNC_PROTO, async ({ stream, connection }) => {
    const from = connection.remotePeer.toString().slice(0, 12);
    try {
      const chunks = [];
      for await (const chunk of stream.source) {
        chunks.push(chunk instanceof Uint8Array ? chunk : Buffer.from(chunk.slice()));
      }
      const raw = Buffer.concat(chunks).toString('utf8');

      // Verify auth on stream request
      let req;
      try { req = JSON.parse(raw); } catch (_) { return; }
      if (p2pSecret() && !hmacVerify(JSON.stringify({ sinceMs: req.sinceMs, machine: req.machine }), req.sig || '')) {
        log('warn', `Dropping sync request from ${from}: HMAC failed`);
        return;
      }

      const sinceMs = typeof req.sinceMs === 'number' ? req.sinceMs : 0;
      const files   = sinceMs === 0 ? await gatherAllFiles(kbDir()) : await gatherChangedFiles(kbDir(), sinceMs, Infinity);
      const fp      = await kbFingerprint(kbDir());

      log('info', `Sync request from ${req.machine || from} sinceMs=${sinceMs} → sending ${files.length} file(s)`);

      const resp = { machine: machineName(), files, deletions: [], fingerprint: fp };
      await stream.sink([Buffer.from(JSON.stringify(resp))]);
    } catch (e) {
      log('warn', `Sync handler error from ${from}: ${e.message}`);
      try { await stream.sink([Buffer.from(JSON.stringify({ machine: machineName(), files: [], deletions: [], fingerprint: '' }))]); } catch (_) {}
    }
  });

  async function requestDeltaSync(peerId, sinceMs, attempt = 0) {
    const MAX_ATTEMPTS = 3;
    const reqBody = { sinceMs, machine: machineName() };
    const sig     = p2pSecret() ? hmacSign(JSON.stringify(reqBody)) : '';
    const req     = Buffer.from(JSON.stringify({ ...reqBody, sig }));

    if (parentPort) parentPort.postMessage({ type: 'transfer-progress', phase: 'connecting', done: 0, total: 0, file: '' });

    try {
      const stream = await libp2pNode.dialProtocol(peerId, SYNC_PROTO);
      await stream.sink([req]);

      if (parentPort) parentPort.postMessage({ type: 'transfer-progress', phase: 'receiving', done: 0, total: 0, file: '' });

      const chunks = [];
      for await (const chunk of stream.source) {
        chunks.push(chunk instanceof Uint8Array ? chunk : Buffer.from(chunk.slice()));
      }
      if (!chunks.length) {
        log('warn', 'Empty sync response');
        if (parentPort) parentPort.postMessage({ type: 'transfer-progress', phase: 'done' });
        return;
      }

      const resp       = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const totalFiles = (resp.files || []).length;

      if (parentPort) parentPort.postMessage({ type: 'transfer-progress', phase: 'applying', done: 0, total: totalFiles, file: '' });

      const { written, skipped } = applyFiles(resp.files || [], kbDir());
      const deleted = applyDeletions(resp.deletions || [], kbDir());

      if (written || deleted) {
        saveManifest(await gatherAllFiles(kbDir()));
        saveLastSyncTs(Date.now());
        syncedFromPeer = true;
      }

      if (parentPort) parentPort.postMessage({ type: 'transfer-progress', phase: 'done' });

      log('info', `Delta sync from ${resp.machine}: wrote=${written} skipped=${skipped} deleted=${deleted}`);

      const filePaths = (resp.files || []).map(f => f.path).slice(0, 10);
      if (parentPort) parentPort.postMessage({
        type:       'kb-synced',
        machine:    resp.machine,
        ticket:     sinceMs === 0 ? 'initial-sync' : 'reconcile-sync',
        filesCount: written,
        deleted,
        filePaths,
      });
    } catch (e) {
      if (attempt < MAX_ATTEMPTS - 1) {
        const delay = 2000 * Math.pow(2, attempt); // 2 s → 4 s
        log('warn', `Sync attempt ${attempt + 1}/${MAX_ATTEMPTS} failed (${e.message}) — retrying in ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
        return requestDeltaSync(peerId, sinceMs, attempt + 1);
      }
      log('warn', `Delta sync failed after ${MAX_ATTEMPTS} attempts: ${e.message}`);
      if (parentPort) parentPort.postMessage({ type: 'transfer-progress', phase: 'done' });
    }
  }

  // ── Cortex query stream handler ───────────────────────────────────────────
  if (cortexMeshEnabled()) {
    await libp2pNode.handle(CORTEX_PROTO, async ({ stream, connection }) => {
      const from = connection.remotePeer.toString().slice(0, 12);
      try {
        const chunks = [];
        for await (const chunk of stream.source) {
          chunks.push(chunk instanceof Uint8Array ? chunk : Buffer.from(chunk.slice()));
        }
        const raw = Buffer.concat(chunks).toString('utf8');
        let req;
        try { req = JSON.parse(raw); } catch (_) { return; }

        if (p2pSecret() && !hmacVerify(JSON.stringify({ sinceMs: req.sinceMs, machine: req.machine }), req.sig || '')) {
          log('warn', `Cortex query from ${from}: HMAC verification failed`);
          return;
        }

        const sinceMs = typeof req.sinceMs === 'number' ? req.sinceMs : 0;
        let observations = [...cortexCache.values()];
        if (sinceMs > 0) observations = observations.filter(o => (o.ts || 0) >= sinceMs);

        log('info', `Cortex query from ${req.machine || from} → ${observations.length} observation(s)`);
        const resp = { machine: machineName(), observations, networkSize: cortexCache.size, ts: Date.now() };
        await stream.sink([Buffer.from(JSON.stringify(resp))]);
      } catch (e) {
        log('warn', `Cortex query handler error from ${from}: ${e.message}`);
        try {
          await stream.sink([Buffer.from(JSON.stringify({
            machine: machineName(), observations: [], networkSize: 0, ts: Date.now(),
          }))]);
        } catch (_) {}
      }
    });
  }

  // ── Peer connect / disconnect ─────────────────────────────────────────────
  libp2pNode.addEventListener('peer:connect', evt => {
    const id = evt.detail?.toString ? evt.detail.toString() : String(evt.detail);
    log('info', `Peer connected: ${id.slice(0, 20)}…`);
    broadcastPeers(libp2pNode, selfId, addrs);

    if (!syncedFromPeer) {
      // sinceMs = persisted last-sync stamp (0 = brand-new node → full dump)
      const sinceMs = loadLastSyncTs();
      setTimeout(() => requestDeltaSync(evt.detail, sinceMs), 2000);
    }

    // Pull collective intelligence from the new peer.
    // Pass per-peer last-sync timestamp so established peers do a delta pull
    // (only observations added since last successful dump) instead of a full replay.
    if (cortexMeshEnabled()) {
      const sinceMs = peerCortexSyncTs.get(id) || 0;
      setTimeout(() => requestCortexDump(libp2pNode, evt.detail, sinceMs), 3500);
    }
  });

  libp2pNode.addEventListener('peer:disconnect', evt => {
    const id = evt.detail?.toString ? evt.detail.toString() : String(evt.detail);
    log('info', `Peer disconnected: ${id.slice(0, 20)}…`);
    broadcastPeers(libp2pNode, selfId, addrs);
  });

  // ── Reconciliation broadcaster ────────────────────────────────────────────
  // Every reconcileMins(), broadcast our KB fingerprint so peers can detect drift.
  async function broadcastReconcile() {
    const fp = await kbFingerprint(kbDir());
    const payload = { type: 'reconcile', machine: machineName(), fingerprint: fp, observationCount: cortexCache.size, ts: Date.now() };
    try {
      const envelope = signEnvelope(payload);
      await libp2pNode.services.pubsub.publish(TOPIC, new TextEncoder().encode(envelope));
      log('info', `Reconcile broadcast — fingerprint=${fp}`);
    } catch (e) {
      log('warn', `Reconcile broadcast failed: ${e.message}`);
    }
  }

  const reconcileInterval = setInterval(async () => {
    if (halted) { clearInterval(reconcileInterval); return; }
    await broadcastReconcile();
    // Refresh Upstash presence so our TTL doesn't expire between reconcile cycles.
    upstashP2PPublish(libp2pNode.getMultiaddrs().map(a => a.toString())).catch(() => {});
  }, reconcileMins() * 60_000);

  // Also broadcast once at startup (after a short delay to allow peer discovery)
  setTimeout(broadcastReconcile, 15_000);

  // ── Cortex mesh ping (presence + observation count broadcast) ─────────────
  if (cortexMeshEnabled()) {
    const cortexPingInterval = setInterval(async () => {
      if (halted) { clearInterval(cortexPingInterval); return; }
      const payload = {
        type:             'cortex-ping',
        machine:          machineName(),
        observationCount: cortexCache.size,
        ts:               Date.now(),
      };
      try {
        const envelope = signEnvelope(payload);
        await libp2pNode.services.pubsub.publish(CORTEX_OBS_TOPIC, new TextEncoder().encode(envelope));
      } catch (_) {}
    }, reconcileMins() * 60_000);

    // Initial ping after peer discovery window
    setTimeout(async () => {
      const payload = { type: 'cortex-ping', machine: machineName(), observationCount: cortexCache.size, ts: Date.now() };
      try {
        const envelope = signEnvelope(payload);
        await libp2pNode.services.pubsub.publish(CORTEX_OBS_TOPIC, new TextEncoder().encode(envelope));
      } catch (_) {}
    }, 20_000);
  }

  // ── KB watchers ───────────────────────────────────────────────────────────
  if (syncTrigger() === 'session' || syncTrigger() === 'both') startSignalWatcher(libp2pNode);
  if (syncTrigger() === 'filesystem' || syncTrigger() === 'both') startFsWatcher(libp2pNode);

  // ── Heartbeat ─────────────────────────────────────────────────────────────
  const heartbeat = setInterval(() => {
    if (halted) { clearInterval(heartbeat); return; }
    broadcastPeers(libp2pNode, selfId, libp2pNode.getMultiaddrs().map(a => a.toString()));
  }, 30_000);

  setTimeout(() => broadcastPeers(libp2pNode, selfId, addrs), 3000);

  log('info', `Ready — auth=${authMode} reconcile=${reconcileMins()}min`);

  await new Promise(resolve => {
    const poll = setInterval(() => { if (halted) { clearInterval(poll); resolve(); } }, 500);
  });

  clearInterval(heartbeat);
  clearInterval(reconcileInterval);
  log('info', 'Stopped');
})();
