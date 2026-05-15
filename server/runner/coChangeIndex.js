'use strict';

// Co-Change Index
//
// Mines the source repo's git history into a file-pair frequency map so the
// conflict checker can detect SILENT conflicts: two tickets that don't touch
// the same file but touch files that historically change together.
//
// Example: ticket A edits CaseManager.java; ticket B edits AlertCentralPanel.java.
// The direct file-map overlap test in conflictChecker.js sees no conflict — but
// these two files co-changed in 11 of the last 14 commits, so a merge collision
// is highly likely.  The co-change index surfaces that.
//
// Cache strategy: full repo log is expensive on large monorepos, so we
// rebuild only when the cache is older than PRX_COCHANGE_CACHE_TTL_DAYS
// (default 7) or the repo HEAD has moved past the cached HEAD.
//
// Cache file: ~/.prevoyant/server/co-change-cache.json
// Shape:
//   {
//     generatedAt: <ms>,
//     repoDir:     <abs path>,
//     headSha:     <commit>,
//     windowDays:  180,
//     commitsScanned: N,
//     // For each file, top peers it has co-changed with — sorted desc by count.
//     // ratio = count / commitsTouchingThisFile (own-file is excluded).
//     byFile: {
//       "fcfrontend/.../CaseManager.java": [
//         { peer: "fcfrontend/.../AlertCentralPanel.java", count: 11, ratio: 0.78 },
//         ...
//       ],
//       ...
//     }
//   }

const { execSync } = require('child_process');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const CACHE_DIR  = path.join(os.homedir(), '.prevoyant', 'server');
const CACHE_FILE = path.join(CACHE_DIR, 'co-change-cache.json');

// Tunables — kept inside the module so callers don't drown in env vars.
const DEFAULTS = {
  windowDays:    180,
  maxCommits:    2000,    // hard cap — protects very busy monorepos
  maxFilesPerCommit: 40,  // skip megacommits (releases, bulk renames)
  topPeersPerFile:   8,   // truncate per-file peer list
  cacheTtlMs:    7 * 86_400_000,
};

function ttlMs() {
  const d = parseFloat(process.env.PRX_COCHANGE_CACHE_TTL_DAYS || '');
  return Number.isFinite(d) && d > 0 ? d * 86_400_000 : DEFAULTS.cacheTtlMs;
}

function windowDays() {
  const d = parseInt(process.env.PRX_COCHANGE_WINDOW_DAYS || '', 10);
  return Number.isFinite(d) && d > 0 ? d : DEFAULTS.windowDays;
}

function repoDir() {
  return process.env.PRX_REPO_DIR || process.env.PRX_SOURCE_REPO_DIR || '';
}

function git(args, cwd) {
  return execSync(`git ${args}`, {
    cwd,
    encoding: 'utf8',
    timeout:  30_000,
    stdio:    ['ignore', 'pipe', 'ignore'],
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

// ── Cache I/O ─────────────────────────────────────────────────────────────────

function loadCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); }
  catch (_) { return null; }
}

function saveCache(obj) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(obj, null, 2), 'utf8');
  } catch (_) {}
}

function isCacheFresh(cache, repo) {
  if (!cache || cache.repoDir !== repo) return false;
  const age = Date.now() - (cache.generatedAt || 0);
  if (age > ttlMs()) return false;
  try {
    const head = git('rev-parse HEAD', repo);
    return head && head === cache.headSha;
  } catch (_) {
    return false;
  }
}

// ── Index build ───────────────────────────────────────────────────────────────

function buildIndex(repo) {
  if (!repo || !fs.existsSync(path.join(repo, '.git'))) {
    return { generatedAt: Date.now(), repoDir: repo, headSha: '', windowDays: windowDays(), commitsScanned: 0, byFile: {} };
  }

  // Stream the log: one --- marker between commits, then file paths.
  const raw = git(
    `log --since="${windowDays()} days ago" --pretty=format:--- --name-only --max-count=${DEFAULTS.maxCommits}`,
    repo
  );
  if (!raw) {
    return { generatedAt: Date.now(), repoDir: repo, headSha: git('rev-parse HEAD', repo), windowDays: windowDays(), commitsScanned: 0, byFile: {} };
  }

  // Pair frequency: pairs[a][b] = count of commits where a AND b both changed.
  // Symmetric — we only store the upper triangle (a < b lex), then expand.
  const pairs    = new Map();   // "a\0b" -> count
  const fileHits = new Map();   // file -> commits touching it
  let commitsScanned = 0;

  let currentFiles = null;
  for (const line of raw.split('\n')) {
    if (line === '---') {
      if (currentFiles) tallyCommit(currentFiles, pairs, fileHits);
      currentFiles  = [];
      commitsScanned++;
      continue;
    }
    if (currentFiles == null) {
      // first commit's --- marker hasn't appeared yet — defensive
      currentFiles = [];
    }
    if (!line) continue;
    currentFiles.push(line);
  }
  if (currentFiles) tallyCommit(currentFiles, pairs, fileHits);

  // Materialise per-file peer lists.
  const byFile = {};
  for (const [key, count] of pairs.entries()) {
    const [a, b] = key.split('\0');
    pushPeer(byFile, a, b, count, fileHits.get(a) || 1);
    pushPeer(byFile, b, a, count, fileHits.get(b) || 1);
  }

  // Sort and cap each file's peer list.
  for (const f of Object.keys(byFile)) {
    byFile[f].sort((p, q) => q.count - p.count || q.ratio - p.ratio);
    if (byFile[f].length > DEFAULTS.topPeersPerFile) byFile[f].length = DEFAULTS.topPeersPerFile;
  }

  return {
    generatedAt:    Date.now(),
    repoDir:        repo,
    headSha:        git('rev-parse HEAD', repo),
    windowDays:     windowDays(),
    commitsScanned,
    byFile,
  };
}

function tallyCommit(files, pairs, fileHits) {
  // Drop megacommits — they swamp the pair counts with noise.
  if (files.length > DEFAULTS.maxFilesPerCommit) return;
  // De-dup (renames / mode changes can emit a file twice).
  const uniq = Array.from(new Set(files)).sort();
  for (const f of uniq) fileHits.set(f, (fileHits.get(f) || 0) + 1);

  for (let i = 0; i < uniq.length; i++) {
    for (let j = i + 1; j < uniq.length; j++) {
      const k = uniq[i] + '\0' + uniq[j];
      pairs.set(k, (pairs.get(k) || 0) + 1);
    }
  }
}

function pushPeer(byFile, anchor, peer, count, anchorHits) {
  if (!byFile[anchor]) byFile[anchor] = [];
  byFile[anchor].push({ peer, count, ratio: +(count / anchorHits).toFixed(2) });
}

// ── Public API ────────────────────────────────────────────────────────────────

// In-memory memo of the most recent index.  Re-validated through
// isCacheFresh() — which checks both the TTL and the HEAD pointer — on every
// access, so a long-running process that survives across many `git pull`s
// never serves stale data and never holds an indefinitely-old map in RAM.
let memo = null;

function getIndex(force = false) {
  const repo = repoDir();
  if (!force && memo && isCacheFresh(memo, repo)) return memo;

  // Drop the stale memo immediately so the GC can reclaim it before we
  // allocate the replacement.  Otherwise a long-lived process can hold two
  // full byFile maps in memory during the rebuild window.
  memo = null;

  const disk = !force ? loadCache() : null;
  if (disk && isCacheFresh(disk, repo)) {
    memo = disk;
    return memo;
  }

  memo = buildIndex(repo);
  saveCache(memo);
  return memo;
}

/**
 * Given the file sets for the new ticket and an in-progress ticket, return the
 * file pairs that historically co-change frequently — *excluding* files that
 * directly overlap (the existing checker already handles those).
 *
 * @param {string[]} newFiles    - files in the newly enqueued ticket's KB map
 * @param {string[]} activeFiles - files in the in-progress ticket's KB map
 * @param {Object}   [opts]
 * @param {number}   [opts.minCount=4]  - require >= N shared commits
 * @param {number}   [opts.minRatio=0.30] - require >= N% of one side's history
 * @returns {Array<{newFile, activeFile, count, ratio}>}
 */
function predictSilentConflicts(newFiles, activeFiles, opts = {}) {
  const minCount = opts.minCount != null ? opts.minCount : 4;
  const minRatio = opts.minRatio != null ? opts.minRatio : 0.30;

  const idx = getIndex();
  if (!idx || !idx.byFile) return [];

  const newSet    = new Set(newFiles);
  const activeSet = new Set(activeFiles);
  const seen      = new Set();
  const out       = [];

  for (const nf of newFiles) {
    if (activeSet.has(nf)) continue;  // direct overlap — skip
    const peers = idx.byFile[nf];
    if (!peers) continue;

    for (const p of peers) {
      if (newSet.has(p.peer)) continue;          // peer is also in the new ticket; nothing to flag
      if (!activeSet.has(p.peer)) continue;      // peer must be on the in-progress side
      if (p.count < minCount || p.ratio < minRatio) continue;

      const key = nf + '|' + p.peer;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ newFile: nf, activeFile: p.peer, count: p.count, ratio: p.ratio });
    }
  }

  // Strongest signal first.
  out.sort((a, b) => b.count - a.count || b.ratio - a.ratio);
  return out;
}

module.exports = {
  getIndex,
  predictSilentConflicts,
  // exported for tests / debugging
  _buildIndex: buildIndex,
  _cacheFile:  CACHE_FILE,
};
