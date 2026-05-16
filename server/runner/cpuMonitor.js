'use strict';

// cpuMonitor — lightweight per-process CPU and RSS sampler.
//
// Auto-starts on require().  Uses setInterval().unref() so the timer never
// prevents clean shutdown.  Safe to require from multiple modules — the ring
// buffer and interval are module-level singletons.
//
// Config:
//   PRX_CPU_ALERT_PCT  — CPU % above which alert:true is returned (default 80)

const os = require('os');

const SAMPLE_MS   = 2000;                                                     // measure every 2s
const RING_SIZE   = 120;                                                      // 4 min of history
const ALERT_HOLD  = 3;                                                        // consecutive samples before alert fires
const THRESHOLD   = Math.max(10, parseInt(process.env.PRX_CPU_ALERT_PCT || '80', 10));

const _ring = [];
let _lastCpu    = process.cpuUsage();
let _lastTs     = Date.now();
let _peak       = 0;
let _alertCount = 0;   // consecutive samples above threshold

function _tick() {
  const now   = Date.now();
  const delta = process.cpuUsage(_lastCpu);
  const elMs  = now - _lastTs;
  const ncpu  = os.cpus().length || 1;

  // (user + system µs) / elapsed_ms / 1000 / ncpu  →  % of total CPU capacity
  const pct = Math.min(100, ((delta.user + delta.system) / 1000 / elMs / ncpu) * 100);
  const mem = Math.round(process.memoryUsage().rss / (1024 * 1024));

  _lastCpu = process.cpuUsage();
  _lastTs  = now;

  const rounded = Math.round(pct * 10) / 10;
  if (rounded > _peak) _peak = rounded;

  _ring.push({ ts: now, cpu: rounded, mem });
  if (_ring.length > RING_SIZE) _ring.shift();

  _alertCount = rounded > THRESHOLD ? _alertCount + 1 : 0;
}

// Start immediately; unref so the timer does not keep the process alive.
const _timer = setInterval(_tick, SAMPLE_MS);
if (_timer.unref) _timer.unref();

function getStats() {
  if (!_ring.length) {
    return { current: 0, avg1m: 0, peak: 0, memMb: 0, numCpus: os.cpus().length, samples: [], alert: false, alertCount: 0, threshold: THRESHOLD };
  }

  const last30  = _ring.slice(-30);   // last 60s
  const current = _ring[_ring.length - 1].cpu;
  const avg1m   = +(last30.reduce((s, x) => s + x.cpu, 0) / last30.length).toFixed(1);
  const memMb   = _ring[_ring.length - 1].mem;
  const alert   = _alertCount >= ALERT_HOLD;

  return {
    current,
    avg1m,
    peak:       +(_peak.toFixed(1)),
    memMb,
    numCpus:    os.cpus().length,
    samples:    _ring.slice(-60),     // last 2 min for sparkline
    alert,
    alertCount: _alertCount,
    threshold:  THRESHOLD,
  };
}

module.exports = { getStats };
