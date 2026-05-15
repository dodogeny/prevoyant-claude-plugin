'use strict';

// Ticket Conflict Checker
//
// Called synchronously from jobQueue.enqueue() before a ticket is handed to
// Claude.  Reads KB ticket files for in-progress and queued tickets, extracts
// their file maps, and reports any source-file overlap with the newly queued
// ticket.  When overlap is found the caller logs a merge-conflict warning via
// the activity log so the developer sees it on the dashboard before branching.
//
// No external dependencies — pure Node built-ins.

const fs   = require('fs');
const os   = require('os');
const path = require('path');

// ── KB directory resolution ───────────────────────────────────────────────────

function kbDir() {
  const mode = process.env.PRX_KB_MODE || 'local';
  return mode === 'distributed'
    ? (process.env.PRX_KB_LOCAL_CLONE || path.join(os.homedir(), '.prevoyant', 'kb'))
    : (process.env.PRX_KNOWLEDGE_DIR  || path.join(os.homedir(), '.prevoyant', 'knowledge-base'));
}

function sessionsDir() {
  return path.join(os.homedir(), '.prevoyant', 'sessions');
}

// ── Active ticket discovery ───────────────────────────────────────────────────
// Reads session files directly to avoid a circular dependency with tracker.js.
// "Active" means status is running or queued — these are the tickets whose
// working branches could conflict with the newly enqueued ticket.

function getActiveTicketKeys(excludeKey) {
  const dir = sessionsDir();
  const keys = [];
  let files;
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('-session.json')); }
  catch (_) { return keys; }

  for (const file of files) {
    try {
      const raw    = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      const status = raw.status;
      if ((status === 'running' || status === 'queued') && raw.ticketKey !== excludeKey) {
        keys.push(raw.ticketKey);
      }
    } catch (_) { /* corrupt or missing — skip */ }
  }
  return keys;
}

// ── File map extraction ───────────────────────────────────────────────────────
// Parses the markdown File Map table written by Step 5 / Step R4 into the KB
// ticket file.  Looks for table rows where the first cell is a backtick-quoted
// source path, e.g.:
//   | `fcfrontend/src/CaseManager.java` | Primary fix target | ...
// Also matches inline `ref:` and `Source:` annotations used by KB+ markers.

const FILE_TABLE_RE = /^\|\s*`([^`]+\.[a-zA-Z]{1,10})`\s*\|/gm;
const REF_RE        = /(?:ref|[Ss]ource)\s*:\s*([\w./-]+\.[a-zA-Z]{1,10})(?::\d+)?/g;

function extractFilesFromKbTicket(ticketKey) {
  const ticketFile = path.join(kbDir(), 'tickets', `${ticketKey}.md`);
  let text;
  try { text = fs.readFileSync(ticketFile, 'utf8'); }
  catch (_) { return new Set(); }

  const files = new Set();

  FILE_TABLE_RE.lastIndex = 0;
  let m;
  while ((m = FILE_TABLE_RE.exec(text)) !== null) {
    const p = m[1].trim();
    if (p && !p.startsWith('File') && !p.startsWith('file')) files.add(p);
  }

  REF_RE.lastIndex = 0;
  while ((m = REF_RE.exec(text)) !== null) {
    const p = m[1].trim();
    if (p) files.add(p);
  }

  return files;
}

// ── Conflict detection ────────────────────────────────────────────────────────

/**
 * Check whether the newly enqueued ticket's known KB file map overlaps with
 * any in-progress or queued ticket's file map.
 *
 * @param {string} newTicketKey   - The ticket being enqueued (e.g. "IV-1234")
 * @returns {ConflictResult|null} - null if no overlap; otherwise a conflict object
 *
 * @typedef {Object} ConflictResult
 * @property {ConflictEntry[]} conflicts
 * @typedef {Object} ConflictEntry
 * @property {string}   ticketKey       - Conflicting in-progress ticket
 * @property {string[]} overlappingFiles - Source files both tickets touch
 */
function checkConflicts(newTicketKey) {
  const activeKeys = getActiveTicketKeys(newTicketKey);
  if (activeKeys.length === 0) return null;

  // The new ticket may have been analyzed in a prior session; its KB file
  // (if it exists) gives us the most accurate set of affected files.
  const newFiles = extractFilesFromKbTicket(newTicketKey);
  if (newFiles.size === 0) {
    // No prior KB record — no file-level comparison possible yet.
    return null;
  }

  const conflicts = [];

  for (const activeKey of activeKeys) {
    const activeFiles = extractFilesFromKbTicket(activeKey);
    if (activeFiles.size === 0) continue;

    const overlapping = [...activeFiles].filter(f => newFiles.has(f));
    if (overlapping.length > 0) {
      conflicts.push({ ticketKey: activeKey, overlappingFiles: overlapping });
    }
  }

  return conflicts.length > 0 ? { conflicts } : null;
}

module.exports = { checkConflicts };
