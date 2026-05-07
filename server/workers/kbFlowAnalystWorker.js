'use strict';

// KB Flow Analyst Worker — runs as a worker_threads thread inside prevoyant-server.
// On a configurable day interval, invokes Claude CLI (as Javed) to:
//   1. Query Jira for recent tickets/incidents and identify which business flows
//      are generating the most problems — no manual flow configuration required.
//   2. Trace the top recurring flows in the codebase.
//   3. Cross-check against the Core Mental Map and propose CMM updates.
// Contributions land in ~/.prevoyant/knowledge-buildup/kbflow-pending.md (PENDING APPROVAL).
// The buildup dir lives outside the KB tree on purpose — pending/session files
// must never be synced or committed; only entries promoted to core-mental-map/
// via the Step 13j vote enter the shared KB.
// The team votes at Step 13j in the next dev session.
// State persists in ~/.prevoyant/server/kbflow-analyst-state.json.

const { workerData, parentPort } = require('worker_threads');
const { spawn } = require('child_process');
const crypto   = require('crypto');
const net      = require('net');
const tls      = require('tls');
const fs       = require('fs');
const os       = require('os');
const path     = require('path');

const {
  smtpHost = '',
  smtpPort = '587',
  smtpUser = '',
  smtpPass = '',
} = workerData || {};

function emailTo()     { return process.env.PRX_EMAIL_TO || ''; }
function isEnabled()   { return (process.env.PRX_KBFLOW_ENABLED || '').toUpperCase() === 'Y'; }
function intervalDays(){ return Math.max(1, parseFloat(process.env.PRX_KBFLOW_INTERVAL_DAYS || '7')); }
function intervalMs()  { return intervalDays() * 24 * 60 * 60 * 1000; }

// How many days of Jira history to scan when identifying high-frequency flows.
function lookbackDays(){ return parseInt(process.env.PRX_KBFLOW_LOOKBACK_DAYS || '30', 10); }

// Maximum number of flows to analyse in one scan. Keeps runs focused.
function maxFlows()    { return parseInt(process.env.PRX_KBFLOW_MAX_FLOWS || '3', 10); }

// Maximum hours the Claude process is allowed to run before being killed.
function timeoutHours(){ return Math.max(0.25, parseFloat(process.env.PRX_KBFLOW_TIMEOUT_HOURS || '2')); }

function knowledgeDir() {
  const mode = (process.env.PRX_KB_MODE || 'local').toLowerCase();
  if (mode === 'distributed') {
    return process.env.PRX_KB_LOCAL_CLONE || path.join(os.homedir(), '.prevoyant', 'kb');
  }
  return process.env.PRX_KNOWLEDGE_DIR || path.join(os.homedir(), '.prevoyant', 'knowledge-base');
}

// ── Project paths ──────────────────────────────────────────────────────────────

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const MCP_CONFIG   = path.resolve(__dirname, '../../.mcp.json');

// Working dir for unapproved KB Flow Analyst output. Kept outside the KB tree
// so neither distributed-sync nor manual git operations can pick these up.
const BUILDUP_DIR     = path.join(os.homedir(), '.prevoyant', 'knowledge-buildup');
const PENDING_FILE    = path.join(BUILDUP_DIR, 'kbflow-pending.md');
const SESSIONS_FILE   = path.join(BUILDUP_DIR, 'kbflow-sessions.md');

// ── State persistence ──────────────────────────────────────────────────────────

const STATE_DIR  = path.join(os.homedir(), '.prevoyant', 'server');
const STATE_FILE = path.join(STATE_DIR, 'kbflow-analyst-state.json');

function loadState() {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return (typeof raw === 'object' && raw !== null) ? raw : {};
  } catch (_) { return {}; }
}

function saveState(state) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) { log('error', `State save failed: ${err.message}`); }
}

// ── Log dir ────────────────────────────────────────────────────────────────────

const LOG_DIR = path.join(os.homedir(), '.prevoyant', 'kbflow', 'logs');

function safeTimestamp() {
  return new Date().toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-');
}

function openLogStream(runNum) {
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (_) {}
  const logFile = `${safeTimestamp()}_run-${runNum}.log`;
  const logPath = path.join(LOG_DIR, logFile);
  const stream  = fs.createWriteStream(logPath, { encoding: 'utf8' });
  return { stream, logFile };
}

// ── Logging ────────────────────────────────────────────────────────────────────

function log(level, msg) {
  const ts = new Date().toISOString();
  if (parentPort) parentPort.postMessage({ type: 'log', level, msg, ts });
  console.log(`[${ts}] [kb-flow-analyst/${level}] ${msg}`);
}

function recordActivity(event, details) {
  if (parentPort) parentPort.postMessage({ type: 'activity', event, key: null, details: details || {} });
}

// ── Persona loader ─────────────────────────────────────────────────────────────

function loadPersona() {
  try {
    return fs.readFileSync(
      path.join(PROJECT_ROOT, 'plugin', 'config', 'personas', 'javed.md'), 'utf8'
    );
  } catch (_) { return ''; }
}

// ── Summary parser — extract proposal counts from Claude's final summary block ─

function parseSummary(output) {
  const num = (re) => { const m = output.match(re); return m ? parseInt(m[1], 10) : null; };
  return {
    flowsAnalysed:  num(/Flows analysed\s*:\s*(\d+)/),
    newProposals:   num(/New proposals\s*:\s*(\d+)/),
    corrections:    num(/Corrections\s*:\s*(\d+)/),
    confirmations:  num(/Confirmations\s*:\s*(\d+)/),
  };
}

// ── MCP config builder ─────────────────────────────────────────────────────────

function buildMcpConfig() {
  const jiraUrl      = process.env.JIRA_URL      || '';
  const jiraUsername = process.env.JIRA_USERNAME  || '';
  const jiraToken    = process.env.JIRA_API_TOKEN || '';
  if (!jiraUrl || !jiraUsername || !jiraToken) return MCP_CONFIG;

  const tmp = path.join(os.tmpdir(), `prevoyant-kbflow-mcp-${process.pid}.json`);
  fs.writeFileSync(tmp, JSON.stringify({
    mcpServers: {
      jira: {
        command: 'uvx',
        args:    ['mcp-atlassian'],
        env: { JIRA_URL: jiraUrl, JIRA_USERNAME: jiraUsername, JIRA_API_TOKEN: jiraToken },
      },
    },
  }));
  return tmp;
}

// ── Prompt builder ─────────────────────────────────────────────────────────────

function buildPrompt(kbDir, repoDir) {
  const today       = new Date().toISOString().slice(0, 10);
  const jiraProject = process.env.PRX_JIRA_PROJECT || '';
  const jiraBase    = (process.env.JIRA_URL || '').replace(/\/$/, '');
  const projectScope = jiraProject
    ? `project = ${jiraProject} AND`
    : 'updated >= -30d AND';

  const persona = loadPersona();

  return [
    persona ? `<persona>\n${persona}\n</persona>` : '',
    `You are Javed, a senior software developer and KB Flow Analyst for the Prevoyant team.`,
    ``,
    `Your job today: identify which business flows in the codebase are generating the most`,
    `incidents/bugs recently, then scan those flows against the Core Mental Map and propose`,
    `any missing or incorrect CMM entries. You work autonomously — you decide which flows`,
    `deserve attention based on real incident data from Jira.`,
    ``,
    `Do NOT write directly to core-mental-map/ files. All proposals go to`,
    `${PENDING_FILE} as PENDING APPROVAL. The team votes at Step 13j.`,
    ``,
    `KNOWLEDGE_DIR : ${kbDir}`,
    `BUILDUP_DIR   : ${BUILDUP_DIR}  (unapproved working files — outside the KB tree)`,
    `REPO_DIR      : ${repoDir}`,
    `DATE          : ${today}`,
    `MAX_FLOWS     : ${maxFlows()} (analyse at most this many flows per run)`,
    ``,
    `Follow these steps exactly, announcing each one:`,
    ``,
    `### Step J1 — Load Knowledge Base`,
    `Read these files if they exist (skip missing files silently):`,
    `  ${kbDir}/core-mental-map/architecture.md`,
    `  ${kbDir}/core-mental-map/business-logic.md`,
    `  ${kbDir}/core-mental-map/data-flows.md`,
    `  ${kbDir}/core-mental-map/gotchas.md`,
    `  ${PENDING_FILE}   ← skip flows already queued to avoid duplicates`,
    ``,
    `Output: list flows already queued in ${PENDING_FILE} (or "None pending").`,
    ``,
    `### Step J2 — Query Jira for Recent Incidents`,
    `Use the Jira MCP to run this JQL query (last ${lookbackDays()} days):`,
    ``,
    `  ${projectScope} updated >= -${lookbackDays()}d`,
    `  ORDER BY updated DESC`,
    ``,
    `Fetch up to 50 tickets. For each ticket collect: key, summary, labels, components,`,
    `issue type (Bug/Story/Task), priority, and resolution status.`,
    ``,
    `If Jira is unavailable or no tickets are returned:`,
    `  - Log "Jira unavailable — skipping flow discovery"`,
    `  - Skip to Step J6 and write an INFO session record`,
    ``,
    `### Step J3 — Identify High-Frequency Business Flows`,
    `Analyse the tickets from J2. Group them by the business domain or flow they touch.`,
    `Use labels, components, and key terms in the summaries to cluster them.`,
    ``,
    `Rank each cluster by:`,
    `  1. Frequency — how many tickets reference it`,
    `  2. Severity — count of Bugs and Critical/High-priority tickets`,
    `  3. Recency — clusters with tickets in the last 7 days score higher`,
    ``,
    `Select the top ${maxFlows()} clusters. For each, state:`,
    `  - Flow name (short, descriptive)`,
    `  - Ticket count and severity breakdown`,
    `  - Representative ticket keys (up to 3)`,
    `  - Why it ranked: what pattern makes this flow high-risk`,
    ``,
    `Skip any flow that already has PENDING entries in the pending file (from J1).`,
    ``,
    `### Step J4 — Trace Each Flow in the Codebase`,
    `For each flow selected in J3:`,
    ``,
    `  a. Search ${repoDir} for the flow's entry point.`,
    `     Use grep and find on key terms from the flow name and the representative tickets.`,
    `     Identify the key files, classes, and services involved.`,
    ``,
    `  b. Read the key files. Trace the happy path end-to-end:`,
    `     input → transformation(s) → output`,
    `     Note: decision points, guard conditions, state transitions, external calls.`,
    ``,
    `  c. Note any code patterns that could explain the recurring incidents`,
    `     (missing guards, complex branching, shared mutable state, etc.).`,
    ``,
    `### Step J5 — Cross-Check Against Core Mental Map`,
    `For each traced flow, compare against what is already in the CMM.`,
    ``,
    `For each discrepancy or gap, emit a marker:`,
    `  [CMM+ ARCH NEW]    — architecture fact missing from the CMM`,
    `  [CMM+ BIZ NEW]     — business rule not captured`,
    `  [CMM+ DATA NEW]    — data flow / write path not recorded`,
    `  [CMM+ GOTCHA NEW]  — non-obvious coupling or footgun exposed by incident pattern`,
    `  [CMM+ * CORRECT]   — existing CMM entry is wrong or outdated`,
    `  [CMM+ * CONFIRM]   — existing CMM entry is verified as accurate`,
    ``,
    `Each marker must include a ref: file:line anchor.`,
    ``,
    `### Step J6 — Write to the pending-proposals file`,
    `File: ${PENDING_FILE}`,
    ``,
    `Read the file to find the highest existing JP-NNN number (start at JP-001 if none).`,
    ``,
    `For each [CMM+] marker from J5, append an entry in EXACTLY this format:`,
    ``,
    `---`,
    `## JP-{NNN} — {descriptive title, ≤ 8 words}`,
    `Status: PENDING APPROVAL`,
    `Flow: {flow name from J3}`,
    `Incidents: {comma-separated ticket keys from J3}`,
    `Proposed: ${today}`,
    `Type: {CMM-ARCH | CMM-BIZ | CMM-DATA | CMM-GOTCHA}`,
    `Action: {NEW | CORRECT | CONFIRM}`,
    ``,
    `{compressed CMM entry — fact statement ≤ 3 lines}`,
    `ref: {file:line}`,
    `---`,
    ``,
    `If no flows were identified or Jira was unavailable, append:`,
    ``,
    `---`,
    `## JP-{NNN} — No actionable findings (${today})`,
    `Status: INFO`,
    `Proposed: ${today}`,
    `Reason: {no recurring flows identified | Jira unavailable | all flows already pending}`,
    `---`,
    ``,
    `### Step J7 — Update the sessions log`,
    `File: ${SESSIONS_FILE}`,
    ``,
    `If the file does not exist, create it with this header:`,
    `# KB Flow Analyst — Session Log`,
    `| Date | Flows Analysed | Proposals | Confirmations | Status |`,
    `|------|----------------|-----------|---------------|--------|`,
    ``,
    `Append one row for this run:`,
    `| ${today} | {flow1, flow2, ...} | {N new/corrected} | {N confirmed} | PENDING |`,
    ``,
    `### Final Summary`,
    ``,
    `── KB Flow Analyst — Run Complete ──────────────────────────────────`,
    `  Date           : ${today}`,
    `  Flows analysed : {N} (identified from Jira incident patterns)`,
    `  Top flows      : {flow1}, {flow2}, ...`,
    `  New proposals  : {N}`,
    `  Corrections    : {N}`,
    `  Confirmations  : {N}`,
    `  Status         : PENDING APPROVAL — team vote at Step 13j`,
    `${jiraBase ? `  Jira scope     : ${jiraBase}` : ''}`,
    `────────────────────────────────────────────────────────────────────`,
  ].join('\n');
}

// ── Step-announcement regex ────────────────────────────────────────────────────

const STEP_RE = /(?:^|[*#\s])Step\s+(J\d+)\s*[—–]/m;

// ── Claude invocation ──────────────────────────────────────────────────────────

function runClaude(kbDir, onText) {
  return new Promise((resolve, reject) => {
    const repoDir     = process.env.PRX_REPO_DIR || '';
    const mcpConfig   = buildMcpConfig();
    const usingTmpCfg = mcpConfig !== MCP_CONFIG;
    const prompt      = buildPrompt(kbDir, repoDir);

    const proc = spawn(
      'claude',
      [
        '--dangerously-skip-permissions',
        '--print', prompt,
        '--mcp-config', mcpConfig,
        '--output-format', 'stream-json',
        '--verbose',
      ],
      {
        cwd:   PROJECT_ROOT,
        env:   { ...process.env, AUTO_MODE: 'Y' },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );

    let text    = '';
    let lineBuf = '';
    let settled = false;

    function cleanup() {
      clearTimeout(killer);
      if (usingTmpCfg) try { fs.unlinkSync(mcpConfig); } catch (_) {}
    }
    function done(err, val) {
      if (settled) return; settled = true;
      cleanup();
      if (err) reject(err); else resolve(val);
    }

    // Kill the process if it exceeds the configured timeout.
    const killer = setTimeout(() => {
      log('warn', `Claude timed out after ${timeoutHours()}h — sending SIGTERM`);
      proc.kill('SIGTERM');
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) {} }, 5000);
      done(new Error(`Claude process timed out after ${timeoutHours()}h`));
    }, timeoutHours() * 3600 * 1000);

    proc.stdout.on('data', chunk => {
      lineBuf += chunk.toString();
      const lines = lineBuf.split('\n');
      lineBuf = lines.pop();
      for (const line of lines) {
        try {
          const ev = JSON.parse(line);
          if (ev.type === 'assistant') {
            for (const block of (ev.message?.content || [])) {
              if (block.type === 'text' && block.text?.trim()) {
                text += block.text;
                if (onText) onText(block.text);
                const stepMatch = block.text.match(STEP_RE);
                if (stepMatch) {
                  const label = block.text.match(/###\s*Step\s+\S+\s*[—–]\s*(.+)/)?.[1]?.trim() || stepMatch[1];
                  log('info', `${stepMatch[1]} — ${label}`);
                }
              }
            }
          }
        } catch (_) {}
      }
    });

    proc.stderr.on('data', chunk => {
      const msg = chunk.toString().trim();
      if (msg) log('warn', `claude stderr: ${msg.slice(0, 200)}`);
    });

    proc.on('error', err => done(new Error(`Failed to spawn claude: ${err.message}`)));

    proc.on('close', code => {
      if (lineBuf.trim()) {
        try {
          const ev = JSON.parse(lineBuf);
          if (ev.type === 'assistant') {
            for (const block of (ev.message?.content || [])) {
              if (block.type === 'text' && block.text?.trim()) text += block.text;
            }
          }
        } catch (_) {}
      }
      if (code === 0 || text.trim()) done(null, text.trim() || '(no output produced)');
      else done(new Error(`claude exited with code ${code}`));
    });
  });
}

// ── SMTP ───────────────────────────────────────────────────────────────────────

function sendEmail(subject, body) {
  const to = emailTo();
  if (!smtpHost || !smtpUser || !smtpPass || !to) {
    log('warn', 'Email skipped — SMTP not fully configured');
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const USE_SSL = parseInt(smtpPort, 10) === 465;
    let sock = null, active = null, buf = '', phase = 'greeting', settled = false;

    function done(err) {
      if (settled) return; settled = true;
      try { (active || sock) && (active || sock).destroy(); } catch (_) {}
      err ? reject(err) : resolve();
    }
    function write(s) { active.write(s + '\r\n'); }
    function handle(code) {
      switch (phase) {
        case 'greeting':  if (code !== 220) return done(new Error(`Greeting ${code}`));
                          phase = 'ehlo1'; write('EHLO prevoyant-kbflow'); break;
        case 'ehlo1':     if (code === 250) { if (USE_SSL) { phase = 'auth'; write('AUTH LOGIN'); }
                            else { phase = 'starttls'; write('STARTTLS'); } } break;
        case 'starttls':  if (code !== 220) return done(new Error(`STARTTLS ${code}`));
                          phase = 'ehlo2';
                          { const up = tls.connect({ socket: sock, host: smtpHost, rejectUnauthorized: false });
                            up.on('secureConnect', () => { active = up; write('EHLO prevoyant-kbflow'); });
                            up.on('data', onData); up.on('error', done); }
                          break;
        case 'ehlo2':     if (code === 250) { phase = 'auth'; write('AUTH LOGIN'); } break;
        case 'auth':      if (code !== 334) return done(new Error(`AUTH ${code}`));
                          phase = 'user'; write(Buffer.from(smtpUser).toString('base64')); break;
        case 'user':      if (code !== 334) return done(new Error(`USER ${code}`));
                          phase = 'pass'; write(Buffer.from(smtpPass).toString('base64')); break;
        case 'pass':      if (code !== 235) return done(new Error(`PASS ${code}`));
                          phase = 'mail'; write(`MAIL FROM:<${smtpUser}>`); break;
        case 'mail':      if (code !== 250) return done(new Error(`MAIL ${code}`));
                          phase = 'rcpt'; write(`RCPT TO:<${to}>`); break;
        case 'rcpt':      if (code !== 250) return done(new Error(`RCPT ${code}`));
                          phase = 'data'; write('DATA'); break;
        case 'data':      if (code !== 354) return done(new Error(`DATA ${code}`));
                          phase = 'body';
                          write(`From: Prevoyant KB Flow Analyst <${smtpUser}>`);
                          write(`To: ${to}`);
                          write(`Subject: ${subject}`);
                          write(`Date: ${new Date().toUTCString()}`);
                          write('MIME-Version: 1.0');
                          write('Content-Type: text/plain; charset=utf-8');
                          write('');
                          for (const line of body.split('\n')) write(line.startsWith('.') ? '.' + line : line);
                          write('.');
                          break;
        case 'body':      if (code !== 250) return done(new Error(`MSG ${code}`));
                          phase = 'quit'; write('QUIT'); break;
        case 'quit':      done(null); break;
      }
    }
    function onData(chunk) {
      buf += chunk.toString();
      let idx;
      while ((idx = buf.indexOf('\r\n')) !== -1) {
        const line = buf.slice(0, idx); buf = buf.slice(idx + 2);
        if (!line) continue;
        const code = parseInt(line.slice(0, 3), 10);
        if (line[3] !== '-' && !isNaN(code)) handle(code);
      }
    }
    const co = { host: smtpHost, port: parseInt(smtpPort, 10), rejectUnauthorized: false };
    sock = USE_SSL ? tls.connect(co) : net.connect(co);
    active = sock;
    sock.on('data', onData); sock.on('error', done);
    sock.setTimeout(20000, () => done(new Error('SMTP timeout')));
  });
}

// ── Main scan run ──────────────────────────────────────────────────────────────

let _running = false;

async function runScan() {
  if (_running) {
    log('warn', 'Scan already in progress — skipping tick');
    return;
  }
  _running = true;

  const kbDir  = knowledgeDir();
  try { fs.mkdirSync(BUILDUP_DIR, { recursive: true }); } catch (_) {}
  const state  = loadState();
  const runNum = (state.runCount || 0) + 1;
  const { stream: logStream, logFile } = openLogStream(runNum);
  const startedAt = new Date();

  logStream.write(
    `=== KB Flow Analyst Run #${runNum} ===\n` +
    `Started   : ${startedAt.toISOString()}\n` +
    `KB Dir    : ${kbDir}\n` +
    `Buildup   : ${BUILDUP_DIR}\n` +
    `Lookback  : ${lookbackDays()}d | Max flows: ${maxFlows()}\n` +
    `${'─'.repeat(60)}\n\n`
  );

  log('info', `Starting run #${runNum} — discovering high-frequency flows from Jira`);
  recordActivity('kbflow_scan_started', { runNum });
  saveState({
    ...loadState(),
    isRunning:          true,
    currentRunNum:      runNum,
    currentRunStartedAt: startedAt.toISOString(),
  });

  try {
    const output = await runClaude(kbDir, text => { logStream.write(text); });

    logStream.write(`\n${'─'.repeat(60)}\n=== Run complete ===\nFinished: ${new Date().toISOString()}\n`);
    logStream.end();

    const outputHash = crypto.createHash('sha1').update(output).digest('hex');
    const nextRunAt  = new Date(Date.now() + intervalMs()).toISOString();
    const summary    = parseSummary(output);

    saveState({
      lastRunAt:        startedAt.toISOString(),
      runCount:         runNum,
      lastRunStatus:    'completed',
      lastOutputHash:   outputHash,
      lastLogFile:      logFile,
      nextRunAt,
      isRunning:        false,
      currentRunNum:    null,
      currentRunStartedAt: null,
      lastFlowsAnalysed: summary.flowsAnalysed,
      lastNewProposals:  summary.newProposals,
      lastCorrections:   summary.corrections,
      lastConfirmations: summary.confirmations,
    });

    const divider   = '─'.repeat(60);
    const subject   = `[Prevoyant KB Flow Analyst] Incident-driven CMM scan · run #${runNum}`;
    const emailBody = [
      `KB Flow Analyst — Autonomous Run #${runNum}`,
      `${startedAt.toUTCString()}`,
      divider,
      '',
      output,
      '',
      divider,
      `Proposals: ${PENDING_FILE}`,
      `Next run : ${new Date(nextRunAt).toUTCString()}`,
      `Review pending contributions at Step 13j in the next dev session.`,
    ].join('\n');

    await sendEmail(subject, emailBody)
      .catch(e => log('error', `Email failed: ${e.message}`));

    log('info', `Run #${runNum} complete — results emailed`);
    recordActivity('kbflow_scan_completed', { runNum, nextRunAt });

  } catch (err) {
    logStream.write(`\n${'─'.repeat(60)}\n=== Run FAILED: ${err.message} ===\n${new Date().toISOString()}\n`);
    logStream.end();

    log('error', `Run #${runNum} failed: ${err.message}`);
    recordActivity('kbflow_scan_failed', { runNum, error: err.message });

    const nextRunAt = new Date(Date.now() + intervalMs()).toISOString();
    saveState({
      ...loadState(),
      lastRunAt:          startedAt.toISOString(),
      runCount:           runNum,
      lastRunStatus:      'failed',
      lastError:          err.message,
      lastLogFile:        logFile,
      nextRunAt,
      isRunning:          false,
      currentRunNum:      null,
      currentRunStartedAt: null,
    });
  } finally {
    _running = false;
  }
}

// ── Polling tick (every 60 minutes) ───────────────────────────────────────────

let halted = false;

async function tick() {
  if (halted) return;
  if (!isEnabled()) return;

  const state = loadState();
  const now   = Date.now();

  if (state.nextRunAt) {
    if (new Date(state.nextRunAt).getTime() > now) return;
  } else if (state.lastRunAt) {
    if (new Date(state.lastRunAt).getTime() + intervalMs() > now) return;
  }

  await runScan();
}

// ── Messages from main thread ──────────────────────────────────────────────────

if (parentPort) {
  parentPort.on('message', msg => {
    if (!msg) return;

    if (msg.type === 'graceful-stop') {
      halted = true;
      log('info', 'Graceful-stop — KB Flow Analyst halted');
      setTimeout(() => process.exit(0), 500);
      return;
    }

    if (msg.type === 'run-now') {
      if (_running) { log('warn', 'Scan already in flight'); return; }
      const s = loadState();
      saveState({ ...s, nextRunAt: null });
      runScan();
      return;
    }

    if (msg.type === 'get-state') {
      if (parentPort) parentPort.postMessage({ type: 'kbflow-state', state: loadState() });
    }
  });
}

// ── Bootstrap ──────────────────────────────────────────────────────────────────

log('info', `Started — interval: every ${intervalDays()}d, lookback: ${lookbackDays()}d, max flows: ${maxFlows()}`);

const state = loadState();
if (!state.nextRunAt && !state.lastRunAt) {
  log('info', 'First run — starting initial scan');
  runScan();
} else {
  const next = state.nextRunAt ? new Date(state.nextRunAt).toUTCString() : 'unknown';
  log('info', `Next run at: ${next}`);
}

setInterval(tick, 60 * 60 * 1000);
