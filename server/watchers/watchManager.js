'use strict';

// Bridge between dashboard routes and the ticketWatcherWorker thread.
// index.js calls setWorker() after creating the worker; routes call addTicket/stopTicket.

let _worker = null;

function setWorker(w)  { _worker = w; }
function getWorker()   { return _worker; }
function hasWorker()   { return _worker !== null; }

function addTicket(key, interval, maxPolls) {
  if (_worker) _worker.postMessage({ type: 'add-ticket', key, interval, maxPolls: parseInt(maxPolls) || 0 });
}

function stopTicket(key) {
  if (_worker) _worker.postMessage({ type: 'stop-ticket', key });
}

function resumeTicket(key) {
  if (_worker) _worker.postMessage({ type: 'resume-ticket', key });
}

function pollNow(key) {
  if (_worker) _worker.postMessage({ type: 'poll-now', key });
}

module.exports = { setWorker, getWorker, hasWorker, addTicket, stopTicket, resumeTicket, pollNow };
