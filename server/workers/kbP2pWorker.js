'use strict';

// KB P2P sync worker — runs as a worker_threads thread.
//
// Active only when PRX_P2P_ENABLED=Y and PRX_KB_MODE=distributed.
// P2P takes full precedence over git: changed .md files are bundled inline
// inside the GossipSub message and written directly on receipt — no git
// operations are involved at any point.
//
// In local mode (PRX_KB_MODE=local) all KB files remain on the dev machine;
// this worker exits immediately with a warning.
//
// Transport stack: TCP · Noise encryption · Yamux muxer · Bootstrap + mDNS discovery
//
// Hardcoded bootstrap nodes (public IPFS network entry points — used for initial
// peer routing only; they do not receive KB content):
//   /dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN
//   /dnsaddr/bootstrap.libp2p.io/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa
//   /dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb
//   /dnsaddr/bootstrap.libp2p.io/p2p/QmcZf59bWwK5XFi76CZX8cbJ4BhTzzA3gU1ZjYZcYW3dwt
//
// Override with PRX_P2P_BOOTSTRAP_NODES (comma-separated multiaddrs).
//
// Config:
//   PRX_P2P_ENABLED=Y
//   PRX_P2P_PORT=7001
//   PRX_P2P_BOOTSTRAP_NODES=   (override; leave empty for defaults)
//   PRX_P2P_MDNS_ENABLED=Y     (LAN auto-discovery via multicast UDP; set N in Docker)
//   PRX_KB_SYNC_TRIGGER=session|filesystem|both
//   PRX_KB_SYNC_DEBOUNCE_SECS=3
//   PRX_KB_MODE=distributed    (required; local mode exits immediately)

const { workerData, parentPort } = require('worker_threads');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const TOPIC    = 'prevoyant/kb-sync/1';
const KEY_FILE = path.join(os.homedir(), '.prevoyant', 'server', 'p2p-key.b64');
const SIGNAL_FILE = path.join(os.homedir(), '.prevoyant', '.kb-updated');

const DEFAULT_BOOTSTRAP = [
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN',
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa',
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb',
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmcZf59bWwK5XFi76CZX8cbJ4BhTzzA3gU1ZjYZcYW3dwt',
];

// ── Config ────────────────────────────────────────────────────────────────────

function p2pPort()       { return parseInt(process.env.PRX_P2P_PORT || '7001', 10); }
function kbMode()        { return (process.env.PRX_KB_MODE || 'local').toLowerCase(); }
function syncTrigger()   { return (process.env.PRX_KB_SYNC_TRIGGER || 'session').toLowerCase(); }
function debounceMs()    { return parseInt(process.env.PRX_KB_SYNC_DEBOUNCE_SECS || '3', 10) * 1000; }
function mdnsEnabled()   { return (process.env.PRX_P2P_MDNS_ENABLED || 'Y').toUpperCase() !== 'N'; }
function machineName()   { return (process.env.PRX_KB_SYNC_MACHINE || os.hostname()).trim(); }

function bootstrapList() {
  const env = (process.env.PRX_P2P_BOOTSTRAP_NODES || '').trim();
  if (env) return env.split(',').map(s => s.trim()).filter(Boolean);
  return DEFAULT_BOOTSTRAP;
}

function kbDir() {
  return process.env.PRX_KB_LOCAL_CLONE || path.join(os.homedir(), '.prevoyant', 'kb');
}

// ── Logging ───────────────────────────────────────────────────────────────────

function log(level, msg) {
  const ts = new Date().toISOString();
  if (parentPort) parentPort.postMessage({ type: 'log', level, msg, ts });
  console.log(`[${ts}] [p2p/${level}] ${msg}`);
}

// ── File helpers ──────────────────────────────────────────────────────────────

function writeAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, typeof content === 'string' ? content : content.toString('utf8'));
  fs.renameSync(tmp, file);
}

// ── File bundler ──────────────────────────────────────────────────────────────
// Changed .md files are always bundled inline in the GossipSub message so
// remote peers write them directly — no git involved on either side.

const MAX_INLINE_BYTES = 800_000; // stay comfortably under the 1 MB gossipsub limit

function gatherChangedFiles(dir, sinceMs) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  let totalBytes = 0;
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
        const content = fs.readFileSync(full, 'utf8');
        totalBytes += content.length;
        if (totalBytes > MAX_INLINE_BYTES) {
          log('warn', `Inline bundle size exceeded ${MAX_INLINE_BYTES} bytes — truncating file list`);
          return;
        }
        out.push({ path: path.relative(dir, full), content });
      } catch (_) {}
    }
  };
  scan(dir);
  return out;
}

let lastPublishMs = 0;

function applyInlineFiles(files, dir) {
  if (!Array.isArray(files) || !files.length) return 0;
  let written = 0;
  for (const f of files) {
    if (!f.path || typeof f.content !== 'string') continue;
    // Normalise to prevent path traversal
    const safe = path.normalize(f.path).replace(/^(\.\.(\/|\\|$))+/, '');
    const dest = path.join(dir, safe);
    try {
      writeAtomic(dest, f.content);
      written++;
    } catch (e) {
      log('warn', `Could not write ${safe}: ${e.message}`);
    }
  }
  return written;
}

// ── Peer key persistence ──────────────────────────────────────────────────────

async function loadOrGenerateKey() {
  let generateKeyPair, privateKeyFromProtobuf, privateKeyToProtobuf;
  try {
    ({ generateKeyPair, privateKeyFromProtobuf, privateKeyToProtobuf } =
      await import('@libp2p/crypto/keys'));
  } catch (_) {
    // Older API path
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
      log('warn', `Existing P2P key unreadable (${e.message}) — generating new key`);
    }
  }

  const key = await generateKeyPair('Ed25519');
  try {
    fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
    const bytes = privateKeyToProtobuf(key);
    fs.writeFileSync(KEY_FILE, Buffer.from(bytes).toString('base64'), 'utf8');
    log('info', `New P2P peer key generated and saved to ${KEY_FILE}`);
  } catch (e) {
    log('warn', `Could not persist P2P key (${e.message}) — peer ID will change on restart`);
  }
  return key;
}

// ── Peer list helpers ─────────────────────────────────────────────────────────

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

function broadcastPeers(node) {
  if (!parentPort) return;
  parentPort.postMessage({
    type:    'peers-updated',
    selfId:  node.peerId.toString(),
    addrs:   node.getMultiaddrs().map(a => a.toString()),
    peers:   buildPeerList(node),
    topic:   TOPIC,
  });
}

// ── Outbound: bundle changed .md files and publish ───────────────────────────

async function publishUpdate(node, ticket) {
  const sinceMs = lastPublishMs || (Date.now() - 60_000);
  const files = gatherChangedFiles(kbDir(), sinceMs);

  if (!files.length) {
    log('info', 'No changed KB files to bundle — skipping publish');
    return;
  }

  lastPublishMs = Date.now();

  const payload = {
    machine: machineName(),
    ticket:  ticket || '',
    ts:      Date.now(),
    files,
  };

  const encoded = new TextEncoder().encode(JSON.stringify(payload));
  try {
    await node.services.pubsub.publish(TOPIC, encoded);
    log('info', `Published ${files.length} KB file(s) — ticket=${ticket || '?'}`);
    if (parentPort) parentPort.postMessage({
      type: 'kb-notified', ticket, filesCount: files.length,
    });
  } catch (e) {
    log('warn', `Publish failed: ${e.message}`);
  }
}

// ── Inbound: receive and apply a peer's KB update ────────────────────────────

async function applyUpdate(payload) {
  const { machine, ticket, files } = payload;
  log('info', `Received KB update from ${machine} — ticket=${ticket} files=${(files || []).length}`);

  if (!Array.isArray(files) || !files.length) {
    log('warn', `No inline files received from ${machine} — nothing to apply`);
    return;
  }

  const written = applyInlineFiles(files, kbDir());
  log('info', `Applied ${written}/${files.length} inline KB file(s) from ${machine}`);

  if (parentPort) parentPort.postMessage({
    type: 'kb-synced', machine, ticket,
  });
}

// ── Signal file watcher (session trigger) ─────────────────────────────────────

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
  if (fs.existsSync(SIGNAL_FILE)) {
    log('info', 'Found existing signal file — processing immediately');
    processSignalFile(node);
  }

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

// ── Filesystem watcher (manual edits in KB dir) ───────────────────────────────

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
      if (filename.startsWith('.git')) return;
      schedule();
    });
    log('info', `Filesystem watcher active — ${dir}`);
  } catch (e) {
    log('warn', `Filesystem watcher failed: ${e.message}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

let halted = false;
let libp2pNode = null;

if (parentPort) {
  parentPort.on('message', msg => {
    if (msg?.type === 'graceful-stop') {
      halted = true;
      if (libp2pNode) libp2pNode.stop().catch(() => {});
    }
    if (msg?.type === 'get-peers' && libp2pNode) {
      broadcastPeers(libp2pNode);
    }
  });
}

(async function main() {
  // P2P KB sync only makes sense when KB is distributed across machines.
  if (kbMode() !== 'distributed') {
    log('warn', `PRX_KB_MODE=${kbMode()} — P2P KB sync requires distributed mode; KB files stay local. Exiting.`);
    if (parentPort) parentPort.postMessage({ type: 'p2p-error', reason: 'P2P requires PRX_KB_MODE=distributed' });
    return;
  }

  log('info', `Starting — port=${p2pPort()} trigger=${syncTrigger()} mdns=${mdnsEnabled()} kbDir=${kbDir()}`);

  // ── Dynamically import ESM-only libp2p packages ───────────────────────────
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
    log('error', `Failed to load libp2p — is it installed? Run: cd server && npm install\n${e.message}`);
    if (parentPort) parentPort.postMessage({ type: 'p2p-error', reason: e.message });
    return;
  }

  peerDiscoveryPlugins.push(
    bootstrap({ list: bootstrapList() })
  );

  if (mdnsEnabled()) {
    try {
      const { mdns } = await import('@libp2p/mdns');
      peerDiscoveryPlugins.push(mdns());
      log('info', 'mDNS discovery enabled (LAN peers auto-discovered)');
    } catch (_) {
      log('warn', 'mDNS not available — LAN peer discovery disabled (install @libp2p/mdns or set PRX_P2P_MDNS_ENABLED=N)');
    }
  }

  // ── Load / generate stable peer key ───────────────────────────────────────
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

  // ── Create and start libp2p node ───────────────────────────────────────────
  const nodeConfig = {
    addresses:            { listen: [`/ip4/0.0.0.0/tcp/${p2pPort()}`] },
    transports:           [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers:         [yamux()],
    peerDiscovery:        peerDiscoveryPlugins,
    services: {
      pubsub: gossipsub({
        allowPublishToZeroPeers: true,
        emitSelf:                false,
        doPX:                    false,
      }),
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
  log('info', `Listening on: ${addrs.join(', ') || '(none yet — checking in 3s)'}`);
  log('info', `Topic: ${TOPIC}  Bootstrap nodes: ${bootstrapList().length}`);

  if (parentPort) parentPort.postMessage({
    type: 'p2p-started', selfId, addrs, topic: TOPIC,
  });

  // ── Subscribe to GossipSub topic ──────────────────────────────────────────
  libp2pNode.services.pubsub.subscribe(TOPIC);

  libp2pNode.services.pubsub.addEventListener('message', async evt => {
    try {
      const { topic, data } = evt.detail;
      if (topic !== TOPIC) return;
      const payload = JSON.parse(new TextDecoder().decode(data));
      if (payload.machine === machineName()) return; // own message
      await applyUpdate(payload);
    } catch (e) {
      log('warn', `Inbound message error: ${e.message}`);
    }
  });

  // ── Peer connect/disconnect tracking ──────────────────────────────────────
  libp2pNode.addEventListener('peer:connect', evt => {
    const id = evt.detail?.toString ? evt.detail.toString() : String(evt.detail);
    log('info', `Peer connected: ${id}`);
    broadcastPeers(libp2pNode);
  });

  libp2pNode.addEventListener('peer:disconnect', evt => {
    const id = evt.detail?.toString ? evt.detail.toString() : String(evt.detail);
    log('info', `Peer disconnected: ${id}`);
    broadcastPeers(libp2pNode);
  });

  // ── Start KB watchers ─────────────────────────────────────────────────────
  if (syncTrigger() === 'session' || syncTrigger() === 'both') {
    startSignalWatcher(libp2pNode);
  }
  if (syncTrigger() === 'filesystem' || syncTrigger() === 'both') {
    startFsWatcher(libp2pNode);
  }

  // ── Heartbeat: broadcast peers list every 30s ─────────────────────────────
  const heartbeat = setInterval(() => {
    if (halted) { clearInterval(heartbeat); return; }
    broadcastPeers(libp2pNode);
    const currentAddrs = libp2pNode.getMultiaddrs().map(a => a.toString());
    if (parentPort) parentPort.postMessage({
      type:  'addrs-updated',
      selfId,
      addrs: currentAddrs,
    });
  }, 30_000);

  setTimeout(() => broadcastPeers(libp2pNode), 3000);

  log('info', 'Ready — waiting for KB updates and peer connections');

  await new Promise(resolve => {
    const poll = setInterval(() => {
      if (halted) { clearInterval(poll); resolve(); }
    }, 500);
  });

  clearInterval(heartbeat);
  log('info', 'Stopped');
})();
