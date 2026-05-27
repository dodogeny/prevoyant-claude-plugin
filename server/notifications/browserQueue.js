'use strict';

// In-memory queue for mesh validation results to be delivered to the browser
// via polling. Drained by GET /dashboard/field/notifications.

const MAX = 50;
const _queue = [];

function push(notification) {
  _queue.push({ ...notification, ts: Date.now() });
  if (_queue.length > MAX) _queue.shift();
}

function drain() {
  return _queue.splice(0);
}

module.exports = { push, drain };
