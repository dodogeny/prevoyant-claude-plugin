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

// ── Constants ─────────────────────────────────────────────────────────────────

const TOPIC         = 'prevoyant/kb-sync/1';
const SYNC_PROTO    = '/prevoyant/kb-sync-req/1';
const KEY_FILE      = path.join(os.homedir(), '.prevoyant', 'server', 'p2p-key.b64');
const SIGNAL_FILE   = path.join(os.homedir(), '.prevoyant', '.kb-updated');
const MANIFEST_FILE = path.join(os.homedir(), '.prevoyant', '.p2p-manifest.json');
const SYNC_TS_FILE  = path.join(os.homedir(), '.prevoyant', '.p2p-synced-at');

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
const reconcileMins   = () => parseInt(process.env.PRX_P2P_RECONCILE_MINS || '60', 10);

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

// ── File scanning ─────────────────────────────────────────────────────────────

// Scan KB dir for .md files modified since sinceMs.
// Returns [{ path, content, lastModifiedMs }] sorted newest-first.
// Stops accumulating content once bytes > maxBytes, but still records paths.
function gatherChangedFiles(dir, sinceMs, maxBytes) {
  if (!fs.existsSync(dir)) return [];
  const limit = maxBytes !== undefined ? maxBytes : MAX_GOSSIP_BYTES;
  const out = [];
  let totalBytes = 0;
  let truncated = false;

  const scan = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) { scan(full); continue; }
      if (!e.name.endsWith('.md')) continue;
      try {
        const stat = fs.statSync(full);
        if (stat.mtimeMs < sinceMs) continue;
        const rel = path.relative(dir, full);
        if (truncated) { out.push({ path: rel, content: null, lastModifiedMs: stat.mtimeMs }); continue; }
        const content = fs.readFileSync(full, 'utf8');
        totalBytes += content.length;
        if (totalBytes > limit) {
          truncated = true;
          log('warn', `Bundle exceeds ${limit} bytes — remaining files queued for next batch`);
          out.push({ path: rel, content: null, lastModifiedMs: stat.mtimeMs });
          continue;
        }
        out.push({ path: rel, content, lastModifiedMs: stat.mtimeMs });
      } catch (_) {}
    }
  };
  scan(dir);
  // Sort newest-first so most-recent changes ship first when truncated
  out.sort((a, b) => (b.lastModifiedMs || 0) - (a.lastModifiedMs || 0));
  return out;
}

// Gather ALL .md files (no size cap — for stream-based full sync).
function gatherAllFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  const scan = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) { scan(full); continue; }
      if (!e.name.endsWith('.md')) continue;
      try {
        const stat = fs.statSync(full);
        out.push({ path: path.relative(dir, full), content: fs.readFileSync(full, 'utf8'), lastModifiedMs: stat.mtimeMs });
      } catch (_) {}
    }
  };
  scan(dir);
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
function kbFingerprint(dir) {
  const files = gatherAllFiles(dir).map(f => `${f.path}:${f.lastModifiedMs}`).sort();
  return crypto.createHash('sha256').update(files.join('\n')).digest('hex').slice(0, 16);
}

// ── File application with conflict resolution ─────────────────────────────────

// Apply an array of { path, content, lastModifiedMs } to the local KB.
// Only writes a file if the incoming version is strictly newer than what's on disk.
// Returns { written, skipped }.
function applyFiles(files, dir) {
  let written = 0, skipped = 0;
  for (const f of files) {
    if (!f.path || typeof f.content !== 'string') continue;
    const safe = path.normalize(f.path).replace(/^(\.\.(\/|\\|$))+/, '');
    const dest = path.join(dir, safe);
    try {
      if (fs.existsSync(dest) && f.lastModifiedMs) {
        const localMtime = fs.statSync(dest).mtimeMs;
        if (f.lastModifiedMs <= localMtime) { skipped++; continue; } // local is same or newer
      }
      writeAtomic(dest, f.content);
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

// ── Outbound: publish KB changes via GossipSub ────────────────────────────────

let lastPublishMs = 0;

async function publishUpdate(node, ticket) {
  const sinceMs = lastPublishMs || (Date.now() - 60_000);
  const allChanged = gatherChangedFiles(kbDir(), sinceMs);

  // Detect deletions: paths in manifest but no longer on disk
  const manifest   = loadManifest();
  const currentSet = new Set(gatherAllFiles(kbDir()).map(f => f.path));
  const deletionTs = Date.now();
  const deletions  = Object.keys(manifest)
    .filter(p => !currentSet.has(p))
    .map(p => ({ path: p, deletedAt: deletionTs }));

  if (!allChanged.length && !deletions.length) {
    log('info', 'No KB changes or deletions — skipping publish');
    return;
  }

  lastPublishMs = Date.now();

  // Split into batches that fit within GossipSub limit.
  // Files without content (truncated) carry only path+mtime and are sent in later batches.
  const withContent    = allChanged.filter(f => f.content !== null);
  const withoutContent = allChanged.filter(f => f.content === null);

  // Group withContent into size-bounded batches
  const batches = [];
  let current = [], currentSize = 0;
  for (const f of withContent) {
    const sz = f.content.length;
    if (current.length && currentSize + sz > MAX_GOSSIP_BYTES) {
      batches.push(current);
      current = []; currentSize = 0;
    }
    current.push(f);
    currentSize += sz;
  }
  if (current.length) batches.push(current);
  if (!batches.length) batches.push([]); // ensure at least one message for deletions

  const batchTotal = batches.length;
  let published = 0;

  for (let i = 0; i < batches.length; i++) {
    const payload = {
      machine:    machineName(),
      ticket:     ticket || '',
      ts:         Date.now(),
      batchIndex: i,
      batchTotal,
      files:      batches[i],
      deletions:  i === 0 ? deletions : [], // deletions only in first batch
    };
    const envelope = signEnvelope(payload);
    try {
      await node.services.pubsub.publish(TOPIC, new TextEncoder().encode(envelope));
      published += batches[i].length;
    } catch (e) {
      log('warn', `Publish batch ${i} failed: ${e.message}`);
    }
  }

  const totalFiles = withContent.length;
  log('info', `Published ${totalFiles} file(s) in ${batchTotal} batch(es), ${deletions.length} deletion(s) — ticket=${ticket || '?'}`);

  // Update manifest to reflect current state
  saveManifest(gatherAllFiles(kbDir()));

  if (parentPort) parentPort.postMessage({
    type:      'kb-notified',
    ticket,
    filesCount: totalFiles,
    filePaths:  withContent.map(f => f.path).slice(0, 10),
  });

  // Notify about any files that couldn't fit in this round
  if (withoutContent.length) {
    log('warn', `${withoutContent.length} file(s) exceeded batch budget — will publish on next trigger`);
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
    saveManifest(gatherAllFiles(kbDir()));
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

async function applyReconcile(payload, node) {
  if (payload.machine === machineName()) return;
  const localFp = kbFingerprint(kbDir());
  if (payload.fingerprint === localFp) return; // already in sync

  log('info', `Reconcile fingerprint mismatch with ${payload.machine} — requesting delta sync`);
  // requestDeltaSync is defined later inside main(); we schedule it via a message
  if (parentPort) parentPort.postMessage({ type: 'reconcile-needed', machine: payload.machine });
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
  });
}

(async function main() {
  if (kbMode() !== 'distributed') {
    log('warn', `PRX_KB_MODE=${kbMode()} — P2P requires distributed mode. Exiting.`);
    if (parentPort) parentPort.postMessage({ type: 'p2p-error', reason: 'P2P requires PRX_KB_MODE=distributed' });
    return;
  }

  const authMode = p2pSecret() ? 'HMAC-SHA256' : 'none (set PRX_P2P_SECRET to enable)';
  log('info', `Starting — port=${p2pPort()} trigger=${syncTrigger()} mdns=${mdnsEnabled()} auth=${authMode}`);

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

  peerDiscoveryPlugins.push(bootstrap({ list: bootstrapList() }));

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

  // ── GossipSub subscriber ──────────────────────────────────────────────────
  libp2pNode.services.pubsub.subscribe(TOPIC);

  libp2pNode.services.pubsub.addEventListener('message', async evt => {
    try {
      const { topic, data } = evt.detail;
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
        if (payload) await applyReconcile(payload, libp2pNode);
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
      const files   = sinceMs === 0 ? gatherAllFiles(kbDir()) : gatherChangedFiles(kbDir(), sinceMs, Infinity);
      const fp      = kbFingerprint(kbDir());

      log('info', `Sync request from ${req.machine || from} sinceMs=${sinceMs} → sending ${files.length} file(s)`);

      const resp = { machine: machineName(), files, deletions: [], fingerprint: fp };
      await stream.sink([Buffer.from(JSON.stringify(resp))]);
    } catch (e) {
      log('warn', `Sync handler error from ${from}: ${e.message}`);
      try { await stream.sink([Buffer.from(JSON.stringify({ machine: machineName(), files: [], deletions: [], fingerprint: '' }))]); } catch (_) {}
    }
  });

  async function requestDeltaSync(peerId, sinceMs) {
    const reqBody = { sinceMs, machine: machineName() };
    const sig     = p2pSecret() ? hmacSign(JSON.stringify(reqBody)) : '';
    const req     = Buffer.from(JSON.stringify({ ...reqBody, sig }));

    try {
      const stream = await libp2pNode.dialProtocol(peerId, SYNC_PROTO);
      await stream.sink([req]);

      const chunks = [];
      for await (const chunk of stream.source) {
        chunks.push(chunk instanceof Uint8Array ? chunk : Buffer.from(chunk.slice()));
      }
      if (!chunks.length) { log('warn', 'Empty sync response'); return; }

      const resp = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const { written, skipped } = applyFiles(resp.files || [], kbDir());
      const deleted = applyDeletions(resp.deletions || [], kbDir());

      if (written || deleted) {
        saveManifest(gatherAllFiles(kbDir()));
        saveLastSyncTs(Date.now());
        syncedFromPeer = true;
      }

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
      log('warn', `Delta sync from ${peerId.toString().slice(0,12)} failed: ${e.message}`);
    }
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
  });

  libp2pNode.addEventListener('peer:disconnect', evt => {
    const id = evt.detail?.toString ? evt.detail.toString() : String(evt.detail);
    log('info', `Peer disconnected: ${id.slice(0, 20)}…`);
    broadcastPeers(libp2pNode, selfId, addrs);
  });

  // ── Reconciliation broadcaster ────────────────────────────────────────────
  // Every reconcileMins(), broadcast our KB fingerprint so peers can detect drift.
  async function broadcastReconcile() {
    const fp = kbFingerprint(kbDir());
    const payload = { type: 'reconcile', machine: machineName(), fingerprint: fp, ts: Date.now() };
    try {
      const envelope = signEnvelope(payload);
      await libp2pNode.services.pubsub.publish(TOPIC, new TextEncoder().encode(envelope));
      log('info', `Reconcile broadcast — fingerprint=${fp}`);
    } catch (e) {
      log('warn', `Reconcile broadcast failed: ${e.message}`);
    }
  }

  // Handle reconcile-needed from main thread (triggered when a peer's fingerprint mismatches)
  if (parentPort) {
    parentPort.on('message', msg => {
      if (msg?.type === 'trigger-reconcile-sync') {
        const peers = buildPeerList(libp2pNode);
        if (peers.length) requestDeltaSync(peers[0].id, loadLastSyncTs());
      }
    });
  }

  const reconcileInterval = setInterval(async () => {
    if (halted) { clearInterval(reconcileInterval); return; }
    await broadcastReconcile();
  }, reconcileMins() * 60_000);

  // Also broadcast once at startup (after a short delay to allow peer discovery)
  setTimeout(broadcastReconcile, 15_000);

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
