'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const STORE_DIR  = path.join(os.homedir(), '.prevoyant', 'server');
const STORE_FILE = path.join(STORE_DIR, 'watched-tickets.json');

const INTERVAL_MS   = { '1h': 3600000, '1d': 86400000, '2d': 172800000, '5d': 432000000 };
const SAVE_DEBOUNCE = 500;   // batch multiple updates within 500ms

function intervalMs(interval) {
  return INTERVAL_MS[interval] || 86400000;
}

// In-memory cache — loaded once from disk on first access; mutations update
// the cache immediately and are flushed asynchronously, so each operation no
// longer does a read+write pair against the filesystem.
let _cache     = null;
let _saveTimer = null;

function _getCache() {
  if (_cache !== null) return _cache;
  try {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    _cache = (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) ? raw : {};
  } catch (_) {
    _cache = {};
  }
  return _cache;
}

function load() {
  return _getCache();
}

function _flush() {
  _saveTimer = null;
  const snapshot = JSON.stringify(_cache, null, 2);
  fs.mkdirSync(STORE_DIR, { recursive: true });
  fs.writeFile(STORE_FILE, snapshot, 'utf8', err => {
    if (err) console.error('[watch-store] Save failed:', err.message);
  });
}

function save(tickets) {
  _cache = tickets;
  if (_saveTimer) return;      // already scheduled — picks up the latest _cache
  _saveTimer = setTimeout(_flush, SAVE_DEBOUNCE);
}

function list() {
  return Object.values(load());
}

function get(key) {
  return load()[key] || null;
}

function addTicket(key, interval, maxPolls) {
  const tickets = load();
  const now = Date.now();
  tickets[key] = {
    key,
    addedAt:      new Date(now).toISOString(),
    interval:     interval || '1d',
    maxPolls:     parseInt(maxPolls) || 0,
    pollCount:    0,
    lastPollAt:   null,
    nextPollAt:   new Date(now + intervalMs(interval || '1d')).toISOString(),
    status:       'watching',
    lastDigest:   null,
    lastDigestAt: null,
    lastError:    null,
  };
  save(tickets);
  return tickets[key];
}

function stopTicket(key) {
  const tickets = load();
  if (tickets[key]) {
    tickets[key].status    = 'stopped';
    tickets[key].nextPollAt = null;
    save(tickets);
    return true;
  }
  return false;
}

function resumeTicket(key) {
  const tickets = load();
  if (tickets[key] && tickets[key].status !== 'watching') {
    tickets[key].status    = 'watching';
    tickets[key].nextPollAt = new Date(Date.now() + intervalMs(tickets[key].interval)).toISOString();
    tickets[key].lastError  = null;
    save(tickets);
    return tickets[key];
  }
  return null;
}

function removeTicket(key) {
  const tickets = load();
  if (key in tickets) {
    delete tickets[key];
    save(tickets);
    return true;
  }
  return false;
}

module.exports = { load, list, get, addTicket, stopTicket, resumeTicket, removeTicket, intervalMs };
