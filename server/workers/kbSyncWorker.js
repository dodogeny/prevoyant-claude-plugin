'use strict';

// KB sync worker — runs as a worker_threads thread.
//
// Always active: XREAD polling (receives KB updates from other machines → git pull).
//
// Session trigger (trigger=session|both):
//   Watches ~/.prevoyant/.kb-updated (signal file written by SKILL.md after git push).
//   On signal: read ticket key → git rev-parse HEAD → XADD → delete signal file.
//   kb-sync.js never touches git push — SKILL.md owns that.
//
// Filesystem trigger (trigger=filesystem|both):
//   Watches the KB dir for .md changes (manual edits outside sessions).
//   On change (debounced): git add -A + commit + push → XADD.
//   (kb-sync.js owns git only here — SKILL.md is not running.)

const { workerData, parentPort } = require('worker_threads');
const { execSync } = require('child_process');
const https        = require('https');
const fs           = require('fs');
const path         = require('path');
const os           = require('os');

const {
  upstashUrl   = '',
  upstashToken = '',
  kbDir        = '',
  machineName  = os.hostname(),
  pollSecs     = 10,
  trigger      = 'session',   // 'session' | 'filesystem' | 'both'
  debounceSecs = 3,
} = workerData || {};

const STREAM_KEY  = 'prevoyant:kb-updates';
const STATE_FILE  = path.join(os.homedir(), '.prevoyant', 'server', 'kb-sync-state.json');
const SIGNAL_FILE = path.join(os.homedir(), '.prevoyant', '.kb-updated');
const SIGNAL_DIR  = path.dirname(SIGNAL_FILE);

// ── State persistence ─────────────────────────────────────────────────────────

function loadLastId() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).lastId || '0-0'; }
  catch (_) { return '0-0'; }
}

function saveLastId(id) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ lastId: id, updatedAt: new Date().toISOString() }));
  } catch (_) { /* non-fatal */ }
}

// ── Upstash REST ──────────────────────────────────────────────────────────────

function upstashPost(command) {
  if (!upstashUrl || !upstashToken) {
    return Promise.reject(new Error('Upstash URL/token not configured'));
  }
  const parsed  = new URL(upstashUrl.endsWith('/') ? upstashUrl.slice(0, -1) : upstashUrl);
  const payload = Buffer.from(JSON.stringify(command));

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: parsed.hostname,
      path:     '/',
      method:   'POST',
      headers: {
        'Authorization':  `Bearer ${upstashToken}`,
        'Content-Type':   'application/json',
        'Content-Length': payload.length,
      },
    }, res => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        try {
          const body = JSON.parse(raw);
          if (body.error) return reject(new Error(`Upstash: ${body.error}`));
          resolve(body.result);
        } catch (e) {
          reject(new Error(`Upstash parse error: ${raw}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('Upstash timeout')));
    req.write(payload);
    req.end();
  });
}

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
    for (let i = 0; i < fields.length; i += 2) obj[fields[i]] = fields[i + 1];
    return obj;
  });
}

async function xadd(ticket, commit) {
  return upstashPost([
    'XADD', STREAM_KEY,
    'MAXLEN', '~', '1000',
    '*',
    'machine', machineName,
    'ticket',  ticket  || '',
    'commit',  commit  || '',
  ]);
}

// ── Git helpers ───────────────────────────────────────────────────────────────

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

// Used only in filesystem-driven mode — SKILL.md is not running, so we own git.
function gitAddCommitPush(dir) {
  const status = execSync('git status --porcelain', {
    cwd: dir, encoding: 'utf8', timeout: 5000,
  }).trim();
  if (!status) return null; // nothing to commit
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  execSync('git add -A', { cwd: dir, encoding: 'utf8', timeout: 10000, stdio: 'pipe' });
  execSync(`git commit -m "kb: manual edit [${ts}]"`, {
    cwd: dir, encoding: 'utf8', timeout: 10000, stdio: 'pipe',
  });
  execSync('git push origin main', { cwd: dir, encoding: 'utf8', timeout: 60000, stdio: 'pipe' });
  return gitHead(dir);
}

// ── Session trigger — signal file watcher ────────────────────────────────────
// SKILL.md writes ~/.prevoyant/.kb-updated containing the ticket key after push.
// We watch for that file, ring Redis, then delete it.

let signalProcessing = false;

async function processSignalFile() {
  if (signalProcessing) return;
  signalProcessing = true;
  try {
    let ticketKey = '';
    try {
      ticketKey = fs.readFileSync(SIGNAL_FILE, 'utf8').trim();
    } catch (_) {
      signalProcessing = false;
      return; // file already gone (race with another process)
    }

    const commit = kbDir ? gitHead(kbDir) : '';

    // XADD first — only delete the signal file after a successful notification.
    // If XADD fails, the file stays so the next watcher event or server restart retries.
    const id = await xadd(ticketKey, commit);
    fs.unlinkSync(SIGNAL_FILE);

    console.log(`[kb-sync-worker] Signal → XADD id=${id} ticket=${ticketKey} commit=${commit}`);
    if (parentPort) parentPort.postMessage({ type: 'kb-notified', ticket: ticketKey, commit });
  } catch (e) {
    console.warn('[kb-sync-worker] Signal processing error:', e.message);
  } finally {
    signalProcessing = false;
  }
}

function startSignalWatcher() {
  // Process signal file if it already exists (e.g. server restarted after SKILL.md ran).
  if (fs.existsSync(SIGNAL_FILE)) {
    console.log('[kb-sync-worker] Found existing signal file — processing immediately');
    processSignalFile();
  }

  try {
    fs.mkdirSync(SIGNAL_DIR, { recursive: true });
    fs.watch(SIGNAL_DIR, (event, filename) => {
      if (filename === path.basename(SIGNAL_FILE) && event === 'rename') {
        if (fs.existsSync(SIGNAL_FILE)) processSignalFile();
      }
    });
    console.log(`[kb-sync-worker] Signal watcher active — watching ${SIGNAL_FILE}`);
  } catch (e) {
    console.warn('[kb-sync-worker] Signal watcher failed to start:', e.message);
  }
}

// ── Filesystem trigger — KB directory watcher ─────────────────────────────────
// Watches the KB dir for .md file changes (manual edits outside sessions).
// Debounced: waits debounceSecs after the last change before committing.

let fsDebounceTimer = null;

async function handleFsChange() {
  if (!kbDir) return;
  try {
    const commit = gitAddCommitPush(kbDir);
    if (!commit) return; // nothing was dirty
    const id = await xadd('manual', commit);
    console.log(`[kb-sync-worker] Filesystem change → committed + XADD id=${id} commit=${commit}`);
    if (parentPort) parentPort.postMessage({ type: 'kb-notified', ticket: 'manual', commit });
  } catch (e) {
    console.warn('[kb-sync-worker] Filesystem push error:', e.message.split('\n')[0]);
  }
}

function startFsWatcher() {
  if (!kbDir) {
    console.warn('[kb-sync-worker] Filesystem trigger requested but kbDir is not set — skipping');
    return;
  }

  const schedule = () => {
    clearTimeout(fsDebounceTimer);
    fsDebounceTimer = setTimeout(handleFsChange, debounceSecs * 1000);
  };

  let watching = false;
  try {
    fs.watch(kbDir, { recursive: true }, (event, filename) => {
      if (!filename || !filename.endsWith('.md')) return;
      // Ignore the signal file and git internals
      if (filename.startsWith('.git')) return;
      schedule();
    });
    watching = true;
    console.log(`[kb-sync-worker] Filesystem watcher active — watching ${kbDir} (debounce: ${debounceSecs}s)`);
  } catch (e) {
    // fs.watch recursive is not supported on Linux — fall back to polling git status.
    console.warn(`[kb-sync-worker] fs.watch recursive not supported (${e.message}). Falling back to git-status polling every ${pollSecs}s.`);
  }

  if (!watching) {
    // Linux fallback: poll git status on the same interval as the Redis poll.
    // handleFsChange is called from the main poll loop when trigger includes 'filesystem'.
  }
}

// ── XREAD poll loop (always active — receives updates from other machines) ───

let halted = false;
let lastId = loadLastId();

if (parentPort) {
  parentPort.on('message', msg => {
    if (msg?.type === 'graceful-stop') halted = true;
  });
}

async function pollOnce() {
  // Linux filesystem fallback: check git status on every poll cycle.
  if (!halted && (trigger === 'filesystem' || trigger === 'both')) {
    if (!fsDebounceTimer && kbDir) {
      // Only if no debounce is pending (would mean fs.watch didn't fire — Linux).
      // We check git status cheaply; handleFsChange will no-op if nothing is dirty.
      const needsPush = (() => {
        try {
          return execSync('git status --porcelain', {
            cwd: kbDir, encoding: 'utf8', timeout: 5000,
          }).trim().length > 0;
        } catch (_) { return false; }
      })();
      if (needsPush) handleFsChange();
    }
  }

  let entries;
  try { entries = await xread(lastId); }
  catch (e) {
    console.warn('[kb-sync-worker] poll error:', e.message);
    return;
  }

  for (const entry of entries) {
    lastId = entry.id;
    if (entry.machine === machineName) continue; // skip our own notifications

    console.log(`[kb-sync-worker] Notification from ${entry.machine} — ticket: ${entry.ticket} commit: ${entry.commit}`);

    if (kbDir) {
      try {
        gitPull(kbDir);
        console.log(`[kb-sync-worker] KB pulled from remote (${entry.machine}/${entry.ticket})`);
        if (parentPort) parentPort.postMessage({ type: 'kb-synced', entry });
      } catch (e) {
        console.warn('[kb-sync-worker] git pull failed:', e.message.split('\n')[0]);
      }
    }
  }

  if (entries.length > 0) saveLastId(lastId);
}

// ── Start ─────────────────────────────────────────────────────────────────────

(async () => {
  console.log(`[kb-sync-worker] Started — trigger=${trigger} poll=${pollSecs}s machine=${machineName}`);

  if (trigger === 'session' || trigger === 'both') startSignalWatcher();
  if (trigger === 'filesystem' || trigger === 'both') startFsWatcher();

  while (!halted) {
    await pollOnce();
    await new Promise(r => setTimeout(r, pollSecs * 1000));
  }

  console.log('[kb-sync-worker] Stopped');
})();
