'use strict';

// Prefix every console line with an ISO timestamp so prevoyant-server.log
// entries are traceable without relying on the shell's redirection timestamp.
(function patchConsole() {
  const ts = () => new Date().toISOString();
  for (const level of ['log', 'warn', 'error', 'info']) {
    const orig = console[level].bind(console);
    console[level] = (...args) => orig(`[${ts()}]`, ...args);
  }
})();

const express = require('express');
const path    = require('path');
const { Worker } = require('worker_threads');
const config = require('./config/env');
const jiraWebhook = require('./webhooks/jira');
const dashboardRoutes = require('./dashboard/routes');
const { schedulePollScript, runFallbackPoll } = require('./runner/pollScheduler');
const { restoreScheduledJobs } = require('./queue/jobQueue');
const activityLog   = require('./dashboard/activityLog');
const serverEvents  = require('./serverEvents');
const watchManager  = require('./watchers/watchManager');
const telegramListener = require('./notifications/telegramListener');

const app = express();
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', server: 'prevoyant-server', ts: new Date().toISOString() });
});

// Dashboard
app.use('/dashboard', dashboardRoutes);

// Legacy redirect — /stats → /dashboard
app.use('/stats', (req, res) => res.redirect(301, '/dashboard' + req.url));

// Trigger routing: cron poll is the default; webhook and Hermes are optional accelerators.
// PRX_HERMES_ENABLED=N (default) — register /jira-events for direct Jira webhooks.
// PRX_HERMES_ENABLED=Y          — Hermes is the front door; expose /internal/* instead.
if (!config.hermesEnabled) {
  app.use('/jira-events', jiraWebhook);
} else {
  app.use('/internal/enqueue',             require('./integrations/hermes/routes/enqueue'));
  app.use('/internal/jobs/recent-results', require('./integrations/hermes/routes/results'));
  app.use('/internal/kb/insights',         require('./integrations/hermes/routes/kbInsights'));
}

// ── Health-monitor watchdog (worker thread) ───────────────────────────────────

let watchdogWorker       = null;
let diskWorker           = null;
let updateWorker            = null;
let kbSyncWorker            = null;
let ticketWatcherWorker     = null;
let kbFlowAnalystWorker     = null;
let patternMinerWorker      = null;
let kbStalenessWorker       = null;
let staleBranchWorker       = null;
let decisionOutcomeWorker   = null;
let cortexWorker            = null;
let hermesNotifierActive    = false;

function startWatchdog() {
  if (process.env.PRX_WATCHDOG_ENABLED !== 'Y') return;

  const workerData = {
    port:          config.port,
    intervalSecs:  parseInt(process.env.PRX_WATCHDOG_INTERVAL_SECS  || '60', 10),
    failThreshold: parseInt(process.env.PRX_WATCHDOG_FAIL_THRESHOLD || '3',  10),
    smtpHost: process.env.PRX_SMTP_HOST  || '',
    smtpPort: process.env.PRX_SMTP_PORT  || '587',
    smtpUser: process.env.PRX_SMTP_USER  || '',
    smtpPass: process.env.PRX_SMTP_PASS  || '',
    emailTo:  process.env.PRX_EMAIL_TO   || '',
  };

  watchdogWorker = new Worker(
    path.join(__dirname, 'workers', 'healthMonitor.js'),
    { workerData }
  );

  watchdogWorker.on('message', msg => {
    if (msg && msg.type === 'log') {
      // Watchdog log lines already printed inside the worker; suppress duplicates
    }
  });
  watchdogWorker.on('error', err =>
    console.error('[watchdog] Worker thread error:', err.message)
  );
  watchdogWorker.on('exit', code => {
    watchdogWorker = null;
    if (code !== 0) console.error(`[watchdog] Worker thread exited with code ${code}`);
  });

  console.log(`[prevoyant-server] Health watchdog active — check every ${workerData.intervalSecs}s, alert after ${workerData.failThreshold} failures`);
}

function startDiskMonitor() {
  if (process.env.PRX_DISK_MONITOR_ENABLED !== 'Y') return;

  const workerData = {
    intervalMins:        parseInt(process.env.PRX_DISK_MONITOR_INTERVAL_MINS  || '60',  10),
    cleanupIntervalDays: parseInt(process.env.PRX_DISK_CLEANUP_INTERVAL_DAYS  || '7',   10),
    maxSizeMB:           parseInt(process.env.PRX_PREVOYANT_MAX_SIZE_MB       || '500', 10),
    alertPct:            parseInt(process.env.PRX_DISK_CAPACITY_ALERT_PCT     || '80',  10),
    smtpHost: process.env.PRX_SMTP_HOST || '',
    smtpPort: process.env.PRX_SMTP_PORT || '587',
    smtpUser: process.env.PRX_SMTP_USER || '',
    smtpPass: process.env.PRX_SMTP_PASS || '',
    emailTo:  process.env.PRX_EMAIL_TO  || '',
  };

  diskWorker = new Worker(
    path.join(__dirname, 'workers', 'diskMonitor.js'),
    { workerData }
  );

  diskWorker.on('error', err =>
    console.error('[disk-monitor] Worker thread error:', err.message)
  );
  diskWorker.on('exit', code => {
    diskWorker = null;
    if (code !== 0) console.error(`[disk-monitor] Worker thread exited with code ${code}`);
  });

  console.log(`[prevoyant-server] Disk monitor active — check every ${workerData.intervalMins}m, alert at ${workerData.alertPct}% of ${workerData.maxSizeMB} MB quota`);
}

// Signal graceful stop to watchdog before this process exits so it doesn't
// fire a false DOWN alert for intentional restarts / stops.
function stopWatchdog() {
  if (watchdogWorker) {
    watchdogWorker.postMessage({ type: 'graceful-stop' });
  }
}

function stopDiskMonitor() {
  if (diskWorker) {
    diskWorker.postMessage({ type: 'graceful-stop' });
  }
}

function startUpdateChecker() {
  const pluginJsonPath = path.join(__dirname, '../plugin/.claude-plugin/plugin.json');
  let currentVersion = '0.0.0';
  try { currentVersion = JSON.parse(require('fs').readFileSync(pluginJsonPath, 'utf8')).version || '0.0.0'; }
  catch (_) {}

  const workerData = {
    currentVersion,
    smtpHost: process.env.PRX_SMTP_HOST || '',
    smtpPort: process.env.PRX_SMTP_PORT || '587',
    smtpUser: process.env.PRX_SMTP_USER || '',
    smtpPass: process.env.PRX_SMTP_PASS || '',
    emailTo:  process.env.PRX_EMAIL_TO  || '',
  };

  updateWorker = new Worker(
    path.join(__dirname, 'workers', 'updateChecker.js'),
    { workerData }
  );

  updateWorker.on('message', msg => {
    if (msg && msg.type === 'update-available') {
      console.log(`[update-checker] New version available: v${msg.latestVersion} (current v${msg.currentVersion})`);
    }
  });
  updateWorker.on('error', err =>
    console.error('[update-checker] Worker thread error:', err.message)
  );
  updateWorker.on('exit', code => {
    updateWorker = null;
    if (code !== 0) console.error(`[update-checker] Worker thread exited with code ${code}`);
  });

  console.log(`[prevoyant-server] Update checker active — polls GitHub every 6–24 h (current v${currentVersion})`);
}

function stopUpdateChecker() {
  if (updateWorker) {
    updateWorker.postMessage({ type: 'graceful-stop' });
  }
}

function startKbSync() {
  if (process.env.PRX_REALTIME_KB_SYNC !== 'Y') return;
  if (process.env.PRX_KB_MODE !== 'distributed') return;
  if (kbSyncWorker) return;

  const kbSync = require('./kb/kbSync');
  const workerData = {
    upstashUrl:   process.env.PRX_UPSTASH_REDIS_URL   || '',
    upstashToken: process.env.PRX_UPSTASH_REDIS_TOKEN  || '',
    kbDir:        kbSync.kbCloneDir(),
    machineName:  kbSync.machineName(),
    pollSecs:     parseInt(process.env.PRX_KB_SYNC_POLL_SECS     || '10', 10),
    trigger:               (process.env.PRX_KB_SYNC_TRIGGER       || 'session').toLowerCase(),
    debounceSecs: parseInt(process.env.PRX_KB_SYNC_DEBOUNCE_SECS || '3',  10),
  };

  kbSyncWorker = new Worker(
    path.join(__dirname, 'workers', 'kbSyncWorker.js'),
    { workerData }
  );

  kbSyncWorker.on('message', msg => {
    if (msg?.type === 'kb-synced') {
      // Another machine pushed — invalidate our local KB cache.
      require('./kb/kbCache').invalidate();
    }
  });
  kbSyncWorker.on('error', err =>
    console.error('[kb-sync] Worker thread error:', err.message)
  );
  kbSyncWorker.on('exit', code => {
    kbSyncWorker = null;
    if (code !== 0) console.error(`[kb-sync] Worker exited with code ${code}`);
  });

  console.log(`[prevoyant-server] KB real-time sync active — polling every ${workerData.pollSecs}s (machine: ${workerData.machineName})`);
}

function stopKbSync() {
  if (kbSyncWorker) {
    kbSyncWorker.postMessage({ type: 'graceful-stop' });
    kbSyncWorker = null;
  }
}

function startTicketWatcher() {
  if (process.env.PRX_WATCH_ENABLED !== 'Y') return;
  if (ticketWatcherWorker) return;

  // Worker reads Jira/project config from process.env directly (shared with parent).
  // Only SMTP credentials are passed as workerData since they don't change at runtime.
  const workerData = {
    smtpHost: process.env.PRX_SMTP_HOST || '',
    smtpPort: process.env.PRX_SMTP_PORT || '587',
    smtpUser: process.env.PRX_SMTP_USER || '',
    smtpPass: process.env.PRX_SMTP_PASS || '',
  };

  ticketWatcherWorker = new Worker(
    path.join(__dirname, 'workers', 'ticketWatcherWorker.js'),
    { workerData }
  );

  watchManager.setWorker(ticketWatcherWorker);

  ticketWatcherWorker.on('message', msg => {
    if (!msg) return;
    if (msg.type === 'log') return; // already printed inside worker
    if (msg.type === 'activity') {
      activityLog.record(msg.event, msg.key || null, 'system', msg.details || {});
    }
  });
  ticketWatcherWorker.on('error', err =>
    console.error('[ticket-watcher] Worker error:', err.message)
  );
  ticketWatcherWorker.on('exit', code => {
    ticketWatcherWorker = null;
    watchManager.setWorker(null);
    if (code !== 0) console.error(`[ticket-watcher] Worker exited with code ${code}`);
  });

  console.log('[prevoyant-server] Ticket watcher active — polling watched tickets every 60 s');
}

function stopTicketWatcher() {
  if (ticketWatcherWorker) {
    ticketWatcherWorker.postMessage({ type: 'graceful-stop' });
    ticketWatcherWorker = null;
    watchManager.setWorker(null);
  }
}

function startKbFlowAnalyst() {
  if (process.env.PRX_KBFLOW_ENABLED !== 'Y') return;
  if (kbFlowAnalystWorker) return;

  const workerData = {
    smtpHost: process.env.PRX_SMTP_HOST || '',
    smtpPort: process.env.PRX_SMTP_PORT || '587',
    smtpUser: process.env.PRX_SMTP_USER || '',
    smtpPass: process.env.PRX_SMTP_PASS || '',
  };

  kbFlowAnalystWorker = new Worker(
    path.join(__dirname, 'workers', 'kbFlowAnalystWorker.js'),
    { workerData }
  );

  kbFlowAnalystWorker.on('message', msg => {
    if (!msg) return;
    if (msg.type === 'log') return;
    if (msg.type === 'activity') {
      activityLog.record(msg.event, msg.key || null, 'system', msg.details || {});
    }
  });
  kbFlowAnalystWorker.on('error', err =>
    console.error('[kb-flow-analyst] Worker error:', err.message)
  );
  kbFlowAnalystWorker.on('exit', code => {
    kbFlowAnalystWorker = null;
    if (code !== 0) console.error(`[kb-flow-analyst] Worker exited with code ${code}`);
  });

  const interval = process.env.PRX_KBFLOW_INTERVAL_DAYS || '7';
  const lookback = process.env.PRX_KBFLOW_LOOKBACK_DAYS  || '30';
  console.log(`[prevoyant-server] KB Flow Analyst active — every ${interval} day(s), ${lookback}d Jira lookback`);
}

function stopKbFlowAnalyst() {
  if (kbFlowAnalystWorker) {
    kbFlowAnalystWorker.postMessage({ type: 'graceful-stop' });
    kbFlowAnalystWorker = null;
  }
}

function startPatternMiner() {
  if (process.env.PRX_PATTERN_MINER_ENABLED !== 'Y') return;
  if (patternMinerWorker) return;
  patternMinerWorker = new Worker(
    path.join(__dirname, 'workers', 'memoryPatternMinerWorker.js'),
    { workerData: {} }
  );
  patternMinerWorker.on('message', msg => {
    if (!msg) return;
    if (msg.type === 'patterns-proposed') {
      activityLog.record('pattern_miner_proposed', null, 'system', { count: msg.count });
    }
  });
  patternMinerWorker.on('error', err =>
    console.error('[pattern-miner] Worker error:', err.message)
  );
  patternMinerWorker.on('exit', code => {
    patternMinerWorker = null;
    if (code !== 0) console.error(`[pattern-miner] Worker exited with code ${code}`);
  });
  const interval = process.env.PRX_PATTERN_MINER_INTERVAL_DAYS || '7';
  console.log(`[prevoyant-server] Memory Pattern Miner active — every ${interval} day(s)`);
}

function stopPatternMiner() {
  if (patternMinerWorker) {
    patternMinerWorker.postMessage({ type: 'graceful-stop' });
    patternMinerWorker = null;
  }
}

function startKbStaleness() {
  if (process.env.PRX_STALENESS_ENABLED !== 'Y') return;
  if (kbStalenessWorker) return;
  kbStalenessWorker = new Worker(
    path.join(__dirname, 'workers', 'kbStalenessWorker.js'),
    { workerData: {} }
  );
  kbStalenessWorker.on('message', msg => {
    if (!msg) return;
    if (msg.type === 'staleness-scanned') {
      activityLog.record('kb_staleness_scanned', null, 'system', {
        kbFiles: msg.kbFiles, refsChecked: msg.refsChecked, stale: msg.stale,
      });
    }
  });
  kbStalenessWorker.on('error', err =>
    console.error('[kb-staleness] Worker error:', err.message)
  );
  kbStalenessWorker.on('exit', code => {
    kbStalenessWorker = null;
    if (code !== 0) console.error(`[kb-staleness] Worker exited with code ${code}`);
  });
  const interval = process.env.PRX_STALENESS_INTERVAL_DAYS || '7';
  console.log(`[prevoyant-server] KB Staleness Scanner active — every ${interval} day(s)`);
}

function stopKbStaleness() {
  if (kbStalenessWorker) {
    kbStalenessWorker.postMessage({ type: 'graceful-stop' });
    kbStalenessWorker = null;
  }
}

function startStaleBranchDetector() {
  if (process.env.PRX_STALE_BRANCH_ENABLED !== 'Y') return;
  if (staleBranchWorker) return;
  staleBranchWorker = new Worker(
    path.join(__dirname, 'workers', 'staleBranchWorker.js'),
    { workerData: {} }
  );
  staleBranchWorker.on('message', msg => {
    if (!msg) return;
    if (msg.type === 'log') return;
    if (msg.type === 'stale-branches-scanned') {
      activityLog.record('stale_branches_scanned', null, 'system', {
        branchesChecked: msg.branchesChecked,
        staleCount:      msg.staleCount,
        stale:           msg.stale,
      });
      if (msg.staleCount > 0) {
        console.warn(
          `[stale-branch] ⚠️  ${msg.staleCount} stale branch(es) detected ` +
          `(KB done, no PR): ${msg.stale.map(s => s.branch).join(', ')}`
        );
      }
    }
  });
  staleBranchWorker.on('error', err =>
    console.error('[stale-branch] Worker error:', err.message)
  );
  staleBranchWorker.on('exit', code => {
    staleBranchWorker = null;
    if (code !== 0) console.error(`[stale-branch] Worker exited with code ${code}`);
  });
  const days = process.env.PRX_STALE_BRANCH_DAYS || '14';
  const interval = process.env.PRX_STALE_BRANCH_INTERVAL_DAYS || '1';
  console.log(`[prevoyant-server] Stale Branch Detector active — stale after ${days}d quiet, check every ${interval} day(s)`);
}

function stopStaleBranchDetector() {
  if (staleBranchWorker) {
    staleBranchWorker.postMessage({ type: 'graceful-stop' });
    staleBranchWorker = null;
  }
}

function startDecisionOutcome() {
  if (process.env.PRX_DECISION_OUTCOME_ENABLED !== 'Y') return;
  if (decisionOutcomeWorker) return;
  decisionOutcomeWorker = new Worker(
    path.join(__dirname, 'workers', 'decisionOutcomeWorker.js'),
    { workerData: {} }
  );
  decisionOutcomeWorker.on('message', msg => {
    if (!msg) return;
    if (msg.type === 'log') return;
    if (msg.type === 'decisions-reviewed') {
      activityLog.record('decisions_reviewed', null, 'system', {
        decisionsScanned: msg.decisionsScanned,
        retrosScanned:    msg.retrosScanned,
        confirmed:        msg.confirmed,
        contradicted:     msg.contradicted,
        pending:          msg.pending,
      });
      if (msg.contradicted > 0) {
        console.warn(`[decision-outcome] ⚠️  ${msg.contradicted} decision(s) flagged CONTRADICTED — see decision-outcomes.md`);
      }
    }
  });
  decisionOutcomeWorker.on('error', err =>
    console.error('[decision-outcome] Worker error:', err.message)
  );
  decisionOutcomeWorker.on('exit', code => {
    decisionOutcomeWorker = null;
    if (code !== 0) console.error(`[decision-outcome] Worker exited with code ${code}`);
  });
  const interval = process.env.PRX_DECISION_OUTCOME_INTERVAL_DAYS || '7';
  const lookback = process.env.PRX_DECISION_OUTCOME_LOOKBACK_DAYS || '90';
  console.log(`[prevoyant-server] Decision-Outcome Linker active — every ${interval} day(s), ${lookback}d retro lookback`);
}

function stopDecisionOutcome() {
  if (decisionOutcomeWorker) {
    decisionOutcomeWorker.postMessage({ type: 'graceful-stop' });
    decisionOutcomeWorker = null;
  }
}

function startCortex() {
  if (process.env.PRX_CORTEX_ENABLED !== 'Y') return;
  if (cortexWorker) return;

  // If repowise is enabled and missing, kick off a background install so the
  // worker has it available by the time the user actually wants to run it.
  // Fire-and-forget — never blocks cortex startup.
  const repowiseInstaller = require('./runner/repowiseInstaller');
  if (repowiseInstaller.autoInstallEnabled() && !repowiseInstaller.isInstalled()) {
    repowiseInstaller.ensureInstalled({ trigger: 'cortex-startup' }).catch(() => {});
  }

  // Ensure lmdb is installed when Cortex is active.  If it's missing the
  // CortexMemory module already falls back to JSONL transparently, but we
  // kick off a background install so the upgrade happens automatically.
  // The server must restart after install for LMDB to take effect.
  const { lmdbAvailable } = require('./runner/cortexMemory');
  if (!lmdbAvailable()) {
    const { spawnSync } = require('child_process');
    const lmdbEnsure    = path.join(__dirname, 'scripts', 'ensure-lmdb.js');
    console.log('[prevoyant-server] lmdb not found — installing in background (CortexMemory using JSONL fallback)');
    // Spawn detached so it doesn't block the server event loop.
    require('child_process').spawn(process.execPath, [lmdbEnsure], {
      detached: true,
      stdio:    'ignore',
    }).unref();
  }

  cortexWorker = new Worker(
    path.join(__dirname, 'workers', 'cortexWorker.js'),
    { workerData: {} }
  );
  cortexWorker.on('message', msg => {
    if (!msg) return;
    if (msg.type === 'log') return;
    if (msg.type === 'cortex-synthesized') {
      activityLog.record('cortex_synthesized', null, 'system', {
        factsWritten:      msg.factsWritten,
        repowiseAvailable: msg.repowiseAvailable,
        distributed:       msg.distributed || false,
      });
    }
    if (msg.type === 'repowise-ran') {
      activityLog.record('repowise_ran', null, 'system', {
        ok:     msg.ok,
        mode:   msg.mode || null,        // 'init' on first run, 'update' after
        reason: msg.reason || null,      // skip reason if !ok
        durationMs: msg.durationMs || 0,
      });
    }
    if (msg.type === 'cortex-skipped') {
      activityLog.record('cortex_skipped', null, 'system', {
        reason:         msg.reason,
        currentBuilder: msg.currentBuilder,
        lastHeartbeat:  msg.lastHeartbeat,
      });
    }
    if (msg.type === 'cortex-builder-claimed') {
      activityLog.record('cortex_builder_claimed', null, 'system', {
        reason:         msg.reason,
        currentBuilder: msg.currentBuilder,
      });
    }
  });
  cortexWorker.on('error', err =>
    console.error('[cortex] Worker error:', err.message)
  );
  cortexWorker.on('exit', code => {
    cortexWorker = null;
    if (code !== 0) {
      console.error(`[cortex] Worker exited with code ${code}`);
      // Only log here for crashes — graceful stops are logged by stopCortex().
      activityLog.record('cortex_stopped', null, 'system', { reason: 'crash', exitCode: code });
    }
  });
  const repowise = process.env.PRX_REPOWISE_ENABLED === 'Y' ? 'on' : 'off';
  const distributed = process.env.PRX_CORTEX_DISTRIBUTED === 'Y';
  console.log(`[prevoyant-server] Cortex active — KB-watch + repowise=${repowise} distributed=${distributed} (always-on intelligence layer)`);
  activityLog.record('cortex_started', null, 'system', {
    repowiseEnabled: process.env.PRX_REPOWISE_ENABLED === 'Y',
    distributed,
    debounceSecs:    parseInt(process.env.PRX_CORTEX_DEBOUNCE_SECS || '30', 10),
  });
}

function stopCortex() {
  if (cortexWorker) {
    cortexWorker.postMessage({ type: 'graceful-stop' });
    cortexWorker = null;
    activityLog.record('cortex_stopped', null, 'system', { reason: 'graceful' });
  }
}

process.on('SIGTERM', () => { stopWatchdog(); stopDiskMonitor(); stopUpdateChecker(); stopKbSync(); stopTicketWatcher(); stopKbFlowAnalyst(); stopPatternMiner(); stopKbStaleness(); stopStaleBranchDetector(); stopDecisionOutcome(); stopCortex(); setTimeout(() => process.exit(0), 600); });
process.on('SIGINT',  () => { stopWatchdog(); stopDiskMonitor(); stopUpdateChecker(); stopKbSync(); stopTicketWatcher(); stopKbFlowAnalyst(); stopPatternMiner(); stopKbStaleness(); stopStaleBranchDetector(); stopDecisionOutcome(); stopCortex(); setTimeout(() => process.exit(0), 600); });

// Reactively start/stop workers when settings are saved from the dashboard.
// This avoids requiring a full server restart for monitor enable/disable toggles.
serverEvents.on('settings-saved', () => {
  const diskEnabled        = process.env.PRX_DISK_MONITOR_ENABLED === 'Y';
  const watchdogEnabled    = process.env.PRX_WATCHDOG_ENABLED     === 'Y';
  const kbSyncEnabled      = process.env.PRX_REALTIME_KB_SYNC     === 'Y'
                          && process.env.PRX_KB_MODE               === 'distributed';
  const watcherEnabled     = process.env.PRX_WATCH_ENABLED              === 'Y';
  const kbflowEnabled      = process.env.PRX_KBFLOW_ENABLED             === 'Y';
  const patternMinerOn     = process.env.PRX_PATTERN_MINER_ENABLED      === 'Y';
  const stalenessOn        = process.env.PRX_STALENESS_ENABLED          === 'Y';
  const staleBranchOn      = process.env.PRX_STALE_BRANCH_ENABLED       === 'Y';
  const decisionOutcomeOn  = process.env.PRX_DECISION_OUTCOME_ENABLED   === 'Y';
  const cortexOn           = process.env.PRX_CORTEX_ENABLED             === 'Y';

  if (diskEnabled && !diskWorker)                         startDiskMonitor();
  if (!diskEnabled && diskWorker)                         stopDiskMonitor();
  if (watchdogEnabled && !watchdogWorker)                 startWatchdog();
  if (!watchdogEnabled && watchdogWorker)                 stopWatchdog();
  if (kbSyncEnabled && !kbSyncWorker)                    startKbSync();
  if (!kbSyncEnabled && kbSyncWorker)                    stopKbSync();
  if (watcherEnabled && !ticketWatcherWorker)             startTicketWatcher();
  if (!watcherEnabled && ticketWatcherWorker)             stopTicketWatcher();
  if (kbflowEnabled && !kbFlowAnalystWorker)              startKbFlowAnalyst();
  if (!kbflowEnabled && kbFlowAnalystWorker)              stopKbFlowAnalyst();
  if (patternMinerOn && !patternMinerWorker)              startPatternMiner();
  if (!patternMinerOn && patternMinerWorker)              stopPatternMiner();
  if (stalenessOn && !kbStalenessWorker)                 startKbStaleness();
  if (!stalenessOn && kbStalenessWorker)                 stopKbStaleness();
  if (staleBranchOn && !staleBranchWorker)               startStaleBranchDetector();
  if (!staleBranchOn && staleBranchWorker)               stopStaleBranchDetector();
  if (decisionOutcomeOn && !decisionOutcomeWorker)       startDecisionOutcome();
  if (!decisionOutcomeOn && decisionOutcomeWorker)       stopDecisionOutcome();
  if (cortexOn && !cortexWorker)                         startCortex();
  if (!cortexOn && cortexWorker)                         stopCortex();

  // Settings-saved transition: PRX_REPOWISE_ENABLED flipped to Y.  Auto-install
  // if missing (idempotent — installer no-ops when already present).
  const repowiseInstaller = require('./runner/repowiseInstaller');
  if (repowiseInstaller.autoInstallEnabled() && !repowiseInstaller.isInstalled()) {
    repowiseInstaller.ensureInstalled({ trigger: 'settings-saved' }).catch(() => {});
  }

  // Hermes: skill install + gateway start/stop can happen without restart.
  // Route registration (/jira-events vs /internal/enqueue) still needs restart.
  const hermesManager    = require('./integrations/hermes/manager');
  const hermesNowEnabled = process.env.PRX_HERMES_ENABLED === 'Y';
  if (hermesNowEnabled && !hermesNotifierActive) {
    setImmediate(() => hermesManager.startup());
    require('./integrations/hermes/notifier').start(
      process.env.PRX_HERMES_GATEWAY_URL || 'http://localhost:8080'
    );
    hermesNotifierActive = true;
  } else if (!hermesNowEnabled && hermesManager.isGatewayRunning()) {
    // PRX_HERMES_ENABLED toggled to N — stop the gateway (don't uninstall).
    setImmediate(() => hermesManager.stopGateway());
  }

  // Telegram inbound listener — auto-disabled while Hermes mode is on.
  const tgListenerStatus = telegramListener.status();
  if (telegramListener.isInboundEnabled() && !tgListenerStatus.running) {
    telegramListener.start();
  } else if (!telegramListener.isInboundEnabled() && tgListenerStatus.running) {
    telegramListener.stop();
  }
});

// Manual scan trigger from /dashboard/knowledge-builder run-now button.
serverEvents.on('kbflow-run-now', () => {
  if (kbFlowAnalystWorker)  kbFlowAnalystWorker.postMessage({ type: 'run-now' });
});

serverEvents.on('pattern-miner-run-now', () => {
  if (patternMinerWorker)   patternMinerWorker.postMessage({ type: 'run-now' });
});

serverEvents.on('staleness-run-now', () => {
  if (kbStalenessWorker)    kbStalenessWorker.postMessage({ type: 'run-now' });
});

serverEvents.on('stale-branch-run-now', () => {
  if (staleBranchWorker)    staleBranchWorker.postMessage({ type: 'run-now' });
});

serverEvents.on('decision-outcome-run-now', () => {
  if (decisionOutcomeWorker) decisionOutcomeWorker.postMessage({ type: 'run-now' });
});

serverEvents.on('cortex-run-now', () => {
  if (cortexWorker) cortexWorker.postMessage({ type: 'run-now' });
});

serverEvents.on('cortex-repowise-now', () => {
  if (cortexWorker) cortexWorker.postMessage({ type: 'repowise-now' });
});

// When an agent writes a discovery via POST /cortex/memory/observe, forward
// the event to the cortex worker so it can trigger a debounced re-synthesis.
// This closes the feedback loop: agent observation → fresh facts in seconds,
// not at the next 6-hour heartbeat.
serverEvents.on('cortex-observation-written', (detail) => {
  if (cortexWorker) cortexWorker.postMessage({ type: 'observe-written', detail });
});

// ── Server listen ─────────────────────────────────────────────────────────────

app.listen(config.port, () => {
  console.log(`[prevoyant-server] Listening on port ${config.port}`);
  console.log(`[prevoyant-server] Dashboard: http://localhost:${config.port}/dashboard`);
  activityLog.record('server_started', null, 'system', { port: config.port });

  // Bootstrap the long-term memory index on startup (async, non-blocking).
  setImmediate(async () => {
    try {
      const mem = require('./memory/memoryAdapter');
      mem.ensureKbEntry();
      await mem.indexAllNew();
    } catch (err) {
      console.warn('[prevoyant-server] Memory index startup failed:', err.message);
    }
  });

  restoreScheduledJobs();
  startWatchdog();
  startDiskMonitor();
  startUpdateChecker();
  startKbSync();
  startTicketWatcher();
  startKbFlowAnalyst();
  startPatternMiner();
  startKbStaleness();
  startStaleBranchDetector();
  startDecisionOutcome();
  startCortex();

  // Config-coherence warnings — logged once at startup so they surface in logs
  // without requiring the user to open the settings page.
  if (process.env.PRX_REALTIME_KB_SYNC === 'Y' && (process.env.PRX_KB_MODE || 'local') !== 'distributed') {
    console.warn('[prevoyant-server] CONFIG WARNING: PRX_REALTIME_KB_SYNC=Y has no effect when PRX_KB_MODE=local. ' +
      'Real-time sync requires PRX_KB_MODE=distributed and Upstash credentials. ' +
      'Either set PRX_KB_MODE=distributed or set PRX_REALTIME_KB_SYNC=N to silence this warning.');
  }

  if (config.hermesEnabled) {
    // Hermes owns scheduling — run one startup sweep to catch tickets missed
    // while offline, then hand control to Hermes's cron.
    console.log('[prevoyant-server] Hermes mode active — scheduling owned by Hermes gateway');

    // Install skill + start gateway (idempotent — safe on every boot).
    const hermesManager = require('./integrations/hermes/manager');
    hermesManager.startup();

    require('./integrations/hermes/notifier').start(config.hermesGatewayUrl);
    hermesNotifierActive = true;
    runFallbackPoll();
  } else if (config.pollIntervalDays > 0) {
    // Cron is the primary trigger; webhook accelerates real-time delivery.
    schedulePollScript(config.pollIntervalDays);
  } else {
    console.log('[prevoyant-server] Scheduled polling disabled — running one-time startup scan as webhook fallback');
    runFallbackPoll();
  }

  // Bi-directional Telegram (no-op if disabled / Hermes is on).
  telegramListener.start();
});
