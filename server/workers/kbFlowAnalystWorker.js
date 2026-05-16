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
function lookbackDays(){ return parseInt(process.env.PRX_KBFLOW_LOOKBACK_DAYS || '14', 10); }

// Maximum number of flows to analyse in one scan. Keeps runs focused.
function maxFlows()    { return parseInt(process.env.PRX_KBFLOW_MAX_FLOWS || '1', 10); }

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
    newPatterns:    num(/New patterns\s*:\s*(\d+)/),
    newLessons:     num(/New lessons\s*:\s*(\d+)/),
  };
}

// ── Pending proposal tracker ───────────────────────────────────────────────────

function parsePendingProposals() {
  let raw;
  try { raw = fs.readFileSync(PENDING_FILE, 'utf8'); } catch (_) { return { count: 0, oldestDays: 0, oldestId: null }; }

  const blocks  = raw.split(/^---\s*$/m).map(b => b.trim()).filter(Boolean);
  let count     = 0;
  let oldestMs  = Date.now();
  let oldestId  = null;

  for (const block of blocks) {
    const statusMatch   = block.match(/^Status:\s*(.+?)\s*$/m);
    if (!statusMatch || !statusMatch[1].toUpperCase().startsWith('PENDING')) continue;
    count++;
    const proposedMatch = block.match(/^Proposed:\s*(\d{4}-\d{2}-\d{2})\s*$/m);
    const idMatch       = block.match(/^##\s+(JP-\d+)/m);
    if (proposedMatch) {
      const t = new Date(proposedMatch[1]).getTime();
      if (t < oldestMs) { oldestMs = t; oldestId = idMatch ? idMatch[1] : null; }
    }
  }

  const oldestDays = count > 0 ? Math.floor((Date.now() - oldestMs) / 86400000) : 0;
  return { count, oldestDays, oldestId };
}

// Send a reminder if pending proposals are overdue and no nudge was sent recently.
async function maybeNudge() {
  const nudgeDays    = parseInt(process.env.PRX_KBFLOW_REVIEW_NUDGE_DAYS || '7', 10);
  const { count, oldestDays, oldestId } = parsePendingProposals();

  const state = loadState();
  const lastNudgeAt  = state.lastNudgeAt ? new Date(state.lastNudgeAt).getTime() : 0;
  const nudgeCoolMs  = nudgeDays * 24 * 60 * 60 * 1000;

  // Save latest pending stats regardless of whether we nudge
  saveState({ ...loadState(), pendingCount: count, oldestPendingDays: oldestDays });

  if (count === 0) return;
  if (oldestDays < nudgeDays) return;
  if (Date.now() - lastNudgeAt < nudgeCoolMs) return;

  const subject = `[Prevoyant KB] Review reminder — ${count} pending proposal${count === 1 ? '' : 's'} (oldest: ${oldestDays} days)`;
  const body = [
    `Javed's KB Flow Analyst has proposals awaiting team review at Step 13j.`,
    ``,
    `  Pending proposals : ${count}`,
    `  Oldest pending    : ${oldestDays} days${oldestId ? ` (${oldestId})` : ''}`,
    `  Review due since  : ${nudgeDays}+ days`,
    ``,
    `Open the next dev session and run Step 13j before Step 1 to clear the backlog.`,
    `Or review directly at: http://127.0.0.1:3000/dashboard/knowledge-builder`,
    ``,
    `Proposals that are not reviewed accumulate — the KB does not improve until the`,
    `panel votes and promotes approved entries to core-mental-map/.`,
  ].join('\n');

  await sendEmail(subject, body).catch(e => log('error', `Nudge email failed: ${e.message}`));
  saveState({ ...loadState(), lastNudgeAt: new Date().toISOString() });
  log('info', `Review nudge sent — ${count} proposals, oldest ${oldestDays}d`);
  recordActivity('kbflow_review_nudge', { count, oldestDays });
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
  const today        = new Date().toISOString().slice(0, 10);
  const jiraProject  = process.env.PRX_JIRA_PROJECT || '';
  const jiraBase     = (process.env.JIRA_URL || '').replace(/\/$/, '');
  const jqlScope     = jiraProject ? `project = ${jiraProject} AND ` : '';
  const nudgeDays    = parseInt(process.env.PRX_KBFLOW_REVIEW_NUDGE_DAYS || '7', 10);
  const persona      = loadPersona();

  return [
    persona ? `<persona>\n${persona}\n</persona>` : '',
    `You are Javed, a senior software developer and KB Flow Analyst for the Prevoyant team.`,
    ``,
    `Your job: identify which business flows are generating the most incidents, trace them`,
    `in the codebase, cross-check against the Core Mental Map, and propose updates to both`,
    `the CMM and the shared knowledge base (patterns + lessons-learned).`,
    ``,
    `Do NOT write directly to core-mental-map/, shared/, or lessons-learned/. All proposals`,
    `go to ${PENDING_FILE} as PENDING APPROVAL. The team votes at Step 13j.`,
    ``,
    `KNOWLEDGE_DIR : ${kbDir}`,
    `BUILDUP_DIR   : ${BUILDUP_DIR}`,
    `REPO_DIR      : ${repoDir}`,
    `DATE          : ${today}`,
    `MAX_FLOWS     : ${maxFlows()}`,
    ``,
    `Follow these steps exactly, announcing each one:`,
    ``,
    `### Step J1 — Load Knowledge Base`,
    `Read these files if they exist (skip missing ones silently):`,
    `  ${kbDir}/core-mental-map/architecture.md`,
    `  ${kbDir}/core-mental-map/business-logic.md`,
    `  ${kbDir}/core-mental-map/data-flows.md`,
    `  ${kbDir}/core-mental-map/gotchas.md`,
    `  ${kbDir}/shared/patterns.md          ← know existing [ESTIMATE-PATTERN] entries`,
    `  ${PENDING_FILE}                       ← skip flows already queued`,
    ``,
    `Also list all files in ${kbDir}/lessons-learned/ and read any that reference`,
    `flows likely to match today's analysis (skip if directory is empty).`,
    ``,
    `Output: (a) flows already queued in ${PENDING_FILE} (or "None pending"),`,
    `        (b) count of existing [ESTIMATE-PATTERN] entries in shared/patterns.md.`,
    ``,
    `### Step J2 — Query Jira for Recent Incidents`,
    `Use the Jira MCP. Run this JQL query:`,
    ``,
    `  ${jqlScope}updated >= -${lookbackDays()}d ORDER BY updated DESC`,
    ``,
    `Fetch up to 50 tickets. For each, collect: key, summary, description (first 300 chars),`,
    `labels, components, issue type, priority, resolution status.`,
    ``,
    `If Jira is unavailable or returns 0 tickets:`,
    `  - Log "Jira unavailable — skipping flow discovery"`,
    `  - Skip to Step J6 and write an INFO session record`,
    ``,
    `### Step J2.5 — Data Quality Assessment`,
    `Before clustering, assess the ticket metadata quality:`,
    ``,
    `  - labelled_pct    = tickets with ≥ 1 label / total tickets × 100`,
    `  - componented_pct = tickets with ≥ 1 component / total tickets × 100`,
    `  - described_pct   = tickets with non-trivial description (> 20 chars) / total × 100`,
    ``,
    `Output a one-line quality report:`,
    `  Data quality: {labelled_pct}% labelled · {componented_pct}% with components · {described_pct}% described`,
    ``,
    `If (labelled_pct + componented_pct) / 2 < 30:`,
    `  Log "⚠ Low metadata quality — switching to text-based clustering using summaries and descriptions."`,
    `  Set CLUSTER_MODE = "text"`,
    `Else:`,
    `  Set CLUSTER_MODE = "metadata+text"`,
    ``,
    `### Step J3 — Identify High-Frequency Business Flows`,
    `Cluster tickets into business flows using CLUSTER_MODE:`,
    ``,
    `  text mode         — extract key noun phrases from summaries + descriptions;`,
    `                      group tickets whose phrases share the same domain concept`,
    `                      (e.g., "payment", "checkout", "auth token", "report export")`,
    `  metadata+text mode — same as text mode, but labels and components are weighted`,
    `                      2× when multiple tickets share them exactly`,
    ``,
    `Rank clusters by:`,
    `  1. Frequency (ticket count)`,
    `  2. Severity (Bugs + Critical/High-priority tickets)`,
    `  3. Recency (tickets updated in last 7 days score higher)`,
    ``,
    `Select the top ${maxFlows()} clusters. Skip any flow already PENDING in ${PENDING_FILE}.`,
    `For each selected cluster state: flow name, ticket count, severity breakdown,`,
    `representative ticket keys (up to 3), why it ranked.`,
    ``,
    `### Step J4 — Trace Each Flow in the Codebase`,
    `For each selected flow:`,
    ``,
    `  a. Find the entry point — grep and find on key terms from the flow name and ticket`,
    `     summaries. If ast-grep is available, use it for semantic search:`,
    `       ast-grep --lang <lang> --pattern '<relevant_pattern>' ${repoDir}`,
    `     Identify the key files, classes, and services involved.`,
    ``,
    `  b. Read the key files. Trace the happy path end-to-end:`,
    `     input → transformation(s) → output`,
    `     Note: decision points, guard conditions, state transitions, external calls.`,
    ``,
    `  c. Check recent change velocity for each key file:`,
    `       git -C ${repoDir} log --oneline -15 -- <file>`,
    `     High churn (many recent commits) on a flow's key file is a risk amplifier —`,
    `     note it in your analysis.`,
    ``,
    `  d. Find and read test files that exercise this flow:`,
    `       grep -rl "<key_class_or_function>" ${repoDir} | grep -i "test\\|spec"`,
    `     Tests encode expected behaviour — gaps in test coverage flag knowledge risks.`,
    ``,
    `  e. Check for known-issue markers in flow files:`,
    `       grep -n "TODO\\|FIXME\\|HACK\\|XXX" <key_files>`,
    `     These often reveal engineering debt directly related to incidents.`,
    ``,
    `  f. Note patterns that explain recurring incidents:`,
    `     missing guards, complex branching, shared mutable state, high churn + no tests.`,
    ``,
    `### Step J5 — Cross-Check Against Core Mental Map, Patterns, and Lessons`,
    `For each traced flow, compare against CMM, shared/patterns.md, and lessons-learned/.`,
    ``,
    `Emit markers for each gap or finding:`,
    `  [CMM+ ARCH NEW]       — architecture fact missing from the CMM`,
    `  [CMM+ BIZ NEW]        — business rule not captured`,
    `  [CMM+ DATA NEW]       — data flow / write path not recorded`,
    `  [CMM+ GOTCHA NEW]     — non-obvious coupling or footgun exposed by incident pattern`,
    `  [CMM+ * CORRECT]      — existing CMM entry is wrong or outdated`,
    `  [CMM+ * CONFIRM]      — existing CMM entry is verified as accurate`,
    `  [PATTERN+ NEW]        — reusable complexity/risk pattern not in shared/patterns.md`,
    `  [LESSON+ NEW]         — systemic lesson (a recurring footgun or "always do X when`,
    `                          touching this flow") not in lessons-learned/`,
    ``,
    `Each marker must include a ref: file:line anchor.`,
    ``,
    `### Step J6 — Write CMM proposals to the pending file`,
    `File: ${PENDING_FILE}`,
    ``,
    `Read to find the highest existing JP-NNN number (start at JP-001 if none).`,
    ``,
    `For each [CMM+] marker from J5, append:`,
    ``,
    `---`,
    `## JP-{NNN} — {descriptive title, ≤ 8 words}`,
    `Status: PENDING APPROVAL`,
    `Flow: {flow name from J3}`,
    `Incidents: {comma-separated ticket keys}`,
    `Proposed: ${today}`,
    `Type: {CMM-ARCH | CMM-BIZ | CMM-DATA | CMM-GOTCHA}`,
    `Action: {NEW | CORRECT | CONFIRM}`,
    ``,
    `{compressed CMM entry — fact statement ≤ 3 lines}`,
    `ref: {file:line}`,
    `---`,
    ``,
    `If no flows identified or Jira unavailable, append an INFO entry instead.`,
    ``,
    `### Step J6b — Write pattern proposals to shared/patterns.md`,
    `For each [PATTERN+] marker from J5:`,
    ``,
    `  Read ${kbDir}/shared/patterns.md. Append (do NOT overwrite):`,
    ``,
    `  [ESTIMATE-PATTERN] {short pattern name}`,
    `  Source : {ticket keys}`,
    `  Observed: ${today} (Javed — autonomous)`,
    `  Pattern: {1–2 sentence description of the complexity or risk pattern}`,
    `  ref    : {file:line}`,
    ``,
    `  If shared/patterns.md does not exist, create it with a # Shared Patterns header first.`,
    ``,
    `### Step J6c — Write lessons to lessons-learned/javed.md`,
    `For each [LESSON+] marker from J5:`,
    ``,
    `  Read ${kbDir}/lessons-learned/javed.md (create with header if absent).`,
    `  Append one entry per lesson:`,
    ``,
    `  ## {Flow Name} — {short title}`,
    `  Date   : ${today}`,
    `  Author : Javed (autonomous KB scan)`,
    `  PITFALL: {what goes wrong when this flow is touched without care}`,
    `  KEY    : {one-line insight — the fact a new engineer must know}`,
    `  ref    : {file:line}`,
    ``,
    `### Step J7 — Update the sessions log`,
    `File: ${SESSIONS_FILE}`,
    ``,
    `If absent, create with header:`,
    `# KB Flow Analyst — Session Log`,
    `| Date | Flows Analysed | CMM Proposals | Patterns | Lessons | Status |`,
    `|------|----------------|---------------|----------|---------|--------|`,
    ``,
    `Append one row:`,
    `| ${today} | {flow1, flow2, ...} | {N CMM} | {N patterns} | {N lessons} | PENDING |`,
    ``,
    `### Final Summary`,
    ``,
    `── KB Flow Analyst — Run Complete ──────────────────────────────────`,
    `  Date           : ${today}`,
    `  Cluster mode   : {text | metadata+text} ({quality assessment result})`,
    `  Flows analysed : {N}`,
    `  Top flows      : {flow1}, {flow2}, ...`,
    `  New proposals  : {N}`,
    `  Corrections    : {N}`,
    `  Confirmations  : {N}`,
    `  New patterns   : {N}`,
    `  New lessons    : {N}`,
    `  Status         : PENDING APPROVAL — team vote at Step 13j`,
    `${jiraBase ? `  Jira scope     : ${jiraBase}${jiraProject ? ' / project ' + jiraProject : ''}` : ''}`,
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
      lastNewPatterns:   summary.newPatterns,
      lastNewLessons:    summary.newLessons,
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
    await maybeNudge();

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

  // Always check for overdue proposals, even if a scan is not yet due.
  await maybeNudge();

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
