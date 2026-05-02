'use strict';

// KB real-time sync: Redis is the doorbell, Git is the mail carrier.
//
// Responsibility split:
//   SKILL.md      — git add / git commit / git push  (unchanged)
//   kbSync.js     — watches for SKILL.md to finish, rings Redis (XADD)
//                   pulls on incoming notifications (XREAD → git pull)
//
// Session trigger (PRX_KB_SYNC_TRIGGER=session or both):
//   SKILL.md writes ~/.prevoyant/.kb-updated (signal file) after push.
//   kbSyncWorker sees the file → reads ticket key → XADD → deletes file.
//
// Filesystem trigger (PRX_KB_SYNC_TRIGGER=filesystem or both):
//   kbSyncWorker watches the KB dir for .md changes (manual edits).
//   On change (debounced): git add -A + commit + push → XADD.
//   (kb-sync.js owns git only here — SKILL.md is not running.)
//
// No KB content ever touches Redis. Payload ≈ 100 bytes: { machine, ticket, commit }.

const { execSync } = require('child_process');
const https        = require('https');
const os           = require('os');
const path         = require('path');

const STREAM_KEY  = 'prevoyant:kb-updates';
const STREAM_MAXLEN = '1000';

// Signal file: SKILL.md writes this after a successful git push.
const SIGNAL_FILE = path.join(os.homedir(), '.prevoyant', '.kb-updated');

function isEnabled() {
  return process.env.PRX_REALTIME_KB_SYNC === 'Y';
}

function isDistributed() {
  return (process.env.PRX_KB_MODE || 'local') === 'distributed';
}

function machineName() {
  return (process.env.PRX_KB_SYNC_MACHINE || os.hostname()).trim();
}

function syncTrigger() {
  return (process.env.PRX_KB_SYNC_TRIGGER || 'session').toLowerCase();
}

function kbCloneDir() {
  const { kbDir } = require('./kbCache');
  return kbDir();
}

// ── Upstash REST API (no driver dependency) ──────────────────────────────────

function upstashPost(command) {
  const url   = process.env.PRX_UPSTASH_REDIS_URL   || '';
  const token = process.env.PRX_UPSTASH_REDIS_TOKEN  || '';

  if (!url || !token) {
    throw new Error('PRX_UPSTASH_REDIS_URL and PRX_UPSTASH_REDIS_TOKEN must be set');
  }

  const parsed  = new URL(url.endsWith('/') ? url.slice(0, -1) : url);
  const payload = Buffer.from(JSON.stringify(command));

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: parsed.hostname,
      path:     '/',
      method:   'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type':  'application/json',
        'Content-Length': payload.length,
      },
    }, res => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        try {
          const body = JSON.parse(raw);
          if (body.error) return reject(new Error(`Upstash error: ${body.error}`));
          resolve(body.result);
        } catch (e) {
          reject(new Error(`Upstash parse error: ${raw}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('Upstash request timeout')));
    req.write(payload);
    req.end();
  });
}

// XADD — posts a ~100-byte notification. Returns the new stream entry ID.
async function xadd(machine, ticket, commit) {
  return upstashPost([
    'XADD', STREAM_KEY,
    'MAXLEN', '~', STREAM_MAXLEN,
    '*',
    'machine', machine,
    'ticket',  ticket  || '',
    'commit',  commit  || '',
  ]);
}

// XREAD — returns any new entries since lastId. Returns [] when nothing new.
async function xread(lastId) {
  const result = await upstashPost([
    'XREAD', 'COUNT', '20',
    'STREAMS', STREAM_KEY,
    lastId || '0-0',
  ]);

  if (!result) return [];
  const entries = result[0]?.[1] ?? [];
  return entries.map(([id, fields]) => {
    const obj = { id };
    for (let i = 0; i < fields.length; i += 2) {
      obj[fields[i]] = fields[i + 1];
    }
    return obj;
  });
}

// ── Git helpers (read-only and pull only — push lives in SKILL.md / worker) ──

function gitHead(dir) {
  try {
    return execSync('git rev-parse --short HEAD', {
      cwd: dir, encoding: 'utf8', timeout: 5000,
    }).trim();
  } catch (_) { return ''; }
}

function gitPull(dir) {
  execSync('git pull --rebase origin main', {
    cwd: dir, encoding: 'utf8', timeout: 60000, stdio: 'pipe',
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

// Called by the kbSyncWorker when a notification arrives from another machine.
function pullFromRemote(dir) {
  gitPull(dir);
}

module.exports = {
  isEnabled, isDistributed, machineName, syncTrigger, kbCloneDir,
  SIGNAL_FILE, gitHead,
  xread, xadd,
  pullFromRemote,
};
