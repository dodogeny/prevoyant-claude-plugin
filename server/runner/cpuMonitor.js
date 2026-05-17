'use strict';

// cpuMonitor — lightweight per-process CPU + system RAM sampler.
//
// Auto-starts on require().  Uses setInterval().unref() so the timer never
// prevents clean shutdown.  Safe to require from multiple modules — the ring
// buffer and interval are module-level singletons.
//
// Config:
//   PRX_CPU_ALERT_PCT  — CPU % above which alert:true is returned (default 80)
//   PRX_RAM_ALERT_PCT  — system RAM % above which ramAlert:true is returned (default 85)

const os = require('os');

const SAMPLE_MS     = 2000;
const RING_SIZE     = 120;   // 4 min of history
const ALERT_HOLD    = 3;     // consecutive samples before alert fires
const COOLDOWN_MS   = 5 * 60 * 1000;   // 5 min between repeated spike callbacks

const CPU_THRESHOLD = Math.max(10, parseInt(process.env.PRX_CPU_ALERT_PCT || '80', 10));
const RAM_THRESHOLD = Math.max(10, parseInt(process.env.PRX_RAM_ALERT_PCT  || '85', 10));

const _ring = [];
let _lastCpu      = process.cpuUsage();
let _lastTs       = Date.now();
let _peak         = 0;
let _alertCount   = 0;
let _ramAlertCount = 0;
let _lastCpuSpike  = 0;
let _lastRamSpike  = 0;

const _spikeCallbacks = [];

function registerSpikeCallback(cb) {
  _spikeCallbacks.push(cb);
}

function _fireSpike(type, value, threshold, extra) {
  for (const cb of _spikeCallbacks) {
    try { cb({ type, value, threshold, ...extra }); } catch (_) {}
  }
}

function _tick() {
  const now   = Date.now();
  const delta = process.cpuUsage(_lastCpu);
  const elMs  = now - _lastTs;
  const ncpu  = os.cpus().length || 1;

  const pct      = Math.min(100, ((delta.user + delta.system) / 1000 / elMs / ncpu) * 100);
  const mu       = process.memoryUsage();
  const mem      = Math.round(mu.rss        / (1024 * 1024));
  const heapUsed = Math.round(mu.heapUsed   / (1024 * 1024));
  const heapTotal= Math.round(mu.heapTotal  / (1024 * 1024));

  _lastCpu = process.cpuUsage();
  _lastTs  = now;

  const rounded = Math.round(pct * 10) / 10;
  if (rounded > _peak) _peak = rounded;

  // System RAM
  const totalMem = os.totalmem();
  const freeMem  = os.freemem();
  const ramPct   = Math.round((1 - freeMem / totalMem) * 100);
  const ramMb    = Math.round((totalMem - freeMem) / (1024 * 1024));
  const totalRamMb = Math.round(totalMem / (1024 * 1024));

  _ring.push({ ts: now, cpu: rounded, mem, heapUsed, heapTotal, ramPct, ramMb, totalRamMb });
  if (_ring.length > RING_SIZE) _ring.shift();

  // CPU spike detection
  const prevCpuCount = _alertCount;
  _alertCount = rounded > CPU_THRESHOLD ? _alertCount + 1 : 0;
  if (_alertCount >= ALERT_HOLD && prevCpuCount < ALERT_HOLD && now - _lastCpuSpike >= COOLDOWN_MS) {
    _lastCpuSpike = now;
    _fireSpike('cpu', rounded, CPU_THRESHOLD, {
      avg1m:   +(_ring.slice(-30).reduce((s, x) => s + x.cpu, 0) / Math.min(_ring.length, 30)).toFixed(1),
      peak:    +(_peak.toFixed(1)),
      numCpus: ncpu,
      loadAvg: +os.loadavg()[0].toFixed(2),
      ramPct,
    });
  }

  // RAM spike detection
  const prevRamCount = _ramAlertCount;
  _ramAlertCount = ramPct >= RAM_THRESHOLD ? _ramAlertCount + 1 : 0;
  if (_ramAlertCount >= ALERT_HOLD && prevRamCount < ALERT_HOLD && now - _lastRamSpike >= COOLDOWN_MS) {
    _lastRamSpike = now;
    _fireSpike('ram', ramPct, RAM_THRESHOLD, {
      ramMb,
      totalRamMb,
      freeMb: Math.round(freeMem / (1024 * 1024)),
      cpuPct: rounded,
    });
  }
}

const _timer = setInterval(_tick, SAMPLE_MS);
if (_timer.unref) _timer.unref();

function getStats() {
  const totalMem   = os.totalmem();
  const freeMem    = os.freemem();
  const sysRamPct  = Math.round((1 - freeMem / totalMem) * 100);
  const sysRamMb   = Math.round((totalMem - freeMem) / (1024 * 1024));
  const totalRamMb = Math.round(totalMem / (1024 * 1024));

  if (!_ring.length) {
    const mu = process.memoryUsage();
    return {
      current: 0, avg1m: 0, peak: 0,
      memMb: Math.round(mu.rss / (1024 * 1024)),
      heapUsedMb: Math.round(mu.heapUsed / (1024 * 1024)),
      heapTotalMb: Math.round(mu.heapTotal / (1024 * 1024)),
      numCpus: os.cpus().length, samples: [],
      alert: false, alertCount: 0, threshold: CPU_THRESHOLD,
      ramPct: sysRamPct, ramMb: sysRamMb, totalRamMb, ramAlert: false, ramThreshold: RAM_THRESHOLD,
    };
  }

  const last30     = _ring.slice(-30);
  const current    = _ring[_ring.length - 1].cpu;
  const avg1m      = +(last30.reduce((s, x) => s + x.cpu, 0) / last30.length).toFixed(1);
  const last       = _ring[_ring.length - 1];
  const memMb      = last.mem;
  const heapUsedMb = last.heapUsed;
  const heapTotalMb= last.heapTotal;

  return {
    current,
    avg1m,
    peak:         +(_peak.toFixed(1)),
    memMb,
    heapUsedMb,
    heapTotalMb,
    numCpus:      os.cpus().length,
    samples:      _ring.slice(-60),
    alert:        _alertCount >= ALERT_HOLD,
    alertCount:   _alertCount,
    threshold:    CPU_THRESHOLD,
    ramPct:       sysRamPct,
    ramMb:        sysRamMb,
    totalRamMb,
    ramAlert:     _ramAlertCount >= ALERT_HOLD,
    ramThreshold: RAM_THRESHOLD,
  };
}

module.exports = { getStats, registerSpikeCallback };
