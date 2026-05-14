# Prevoyant Server

Prevoyant Server is an optional Node.js service that runs alongside the Claude Code plugin as an always-on ambient agent. It receives Jira webhook events (or polls on a schedule), queues tickets for analysis, spawns Claude, and surfaces live progress on a web dashboard. Over time it also augments the Knowledge Base automatically through a suite of background workers.

---

## Table of Contents

- [Quick Start](#quick-start)
- [Features](#features)
- [Start / Stop the Server](#start--stop-the-server)
- [Environment Variables](#environment-variables)
- [Dashboard](#dashboard)
- [Add Ticket to Queue](#add-ticket-to-queue)
- [Evidence-Only Runs](#evidence-only-runs)
- [Pipeline Tracking](#pipeline-tracking)
- [Job Queue & Stop/Kill](#job-queue--stopkill)
- [Stage Instructions](#stage-instructions)
- [Knowledge Base Augmentation](#knowledge-base-augmentation)
- [Background Workers](#background-workers)
- [Jira Webhook Setup](#jira-webhook-setup)
- [Scheduled Polling](#scheduled-polling)
- [API Reference](#api-reference)
- [Architecture](#architecture)
- [File Structure](#file-structure)

---

## Quick Start

### 1. Install dependencies

```bash
cd server
npm install
```

### 2. Configure `.env`

Copy the root `.env.example` to `.env` (if you haven't already) and set the server-specific values:

```bash
# Port the server listens on (default: 3000)
WEBHOOK_PORT=3000

# Jira credentials (required for webhook filtering and MCP auth)
JIRA_URL=https://yourcompany.atlassian.net
JIRA_USERNAME=your.name@yourcompany.com
JIRA_API_TOKEN=your-api-token

# Secret token for the webhook URL (optional — leave blank to skip validation)
WEBHOOK_SECRET=your-random-secret
```

### 3. Start the server

```bash
bash server/scripts/start.sh
```

Open the dashboard: [http://localhost:3000/dashboard](http://localhost:3000/dashboard)

### 4. Register the Jira webhook

In your Jira project: **Project Settings → Webhooks → Create webhook**

| Field | Value |
|-------|-------|
| URL | `http://your-server:3000/jira-events?token=your-random-secret` |
| Events | Issue Created, Issue Updated |

Tickets assigned to `JIRA_USERNAME` with status **To Do / Open / Parked / Blocked** are queued automatically from this point on.

### 5. Or run a ticket manually

Visit the dashboard, find any ticket, select a mode (Dev / Review / Estimate), and click the play button.

---

## Features

### Real-time Jira Webhooks

Registers as a Jira webhook receiver (`POST /jira-events`). When a ticket is created, assigned, or updated, Jira pushes the event immediately and the server queues it for analysis — no polling delay, no cron job required. Incoming events are filtered by assignee and ticket status so only relevant tickets are processed. A configurable secret token protects the endpoint from unauthorised calls.

### Scheduled Polling Fallback

When webhooks are unavailable (e.g. the server is behind a firewall or Jira's outbound delivery is unreliable), the server can run `poll-jira.sh` on a configurable day interval (`WEBHOOK_POLL_INTERVAL_DAYS`). Both mechanisms share the same deduplication cache so a ticket is never queued twice regardless of which path triggered it.

### Live Web Dashboard

A full-featured web UI at `http://localhost:3000/dashboard` auto-refreshes every 30 seconds and shows:
- Summary counters: Running, Queued, Done, Failed
- A sortable table of all processed tickets with source, status badge, mode, timestamps, and duration
- Download links for every PDF/HTML report associated with each ticket
- Play (re-run) and Stop buttons per row
- A JSON feed at `/dashboard/json` for programmatic access

### Per-ticket Detail Page

Clicking a ticket key opens a dedicated detail page with:
- A live pipeline visualisation updated every 5 seconds while the job runs
- A progress bar showing completed vs total stages
- A collapsible session output log with markdown rendering
- Inline PDF/HTML report viewer
- Run and Stop controls

### Pipeline Visualisation

Each ticket's progress is displayed as a horizontal row of stage cards. Every card shows the step number, label, elapsed time, and a colour-coded status:

| Status | Colour | Meaning |
|--------|--------|---------|
| Pending | Grey | Not yet reached |
| Active | Blue (pulsing) | Currently executing |
| Done | Green | Completed successfully |
| Skipped | Grey + *Skipped* badge | Jumped over or not applicable |
| Failed | Red | Errored or stopped mid-step |

Stage definitions are stored in `server/dashboard/stages.json` and can be edited without touching any code.

### Job Queue

All analysis jobs run through a single FIFO queue. Only one Claude session executes at a time (`MAX_CONCURRENT = 1`) to prevent resource exhaustion. Additional jobs wait in the queue and start automatically when the current one finishes. The queue state is visible on the dashboard.

### Stop / Kill Running Jobs

Any running or queued job can be cancelled instantly from the dashboard — either from the ticket list row or the detail page Run panel. Clicking **Stop Job** sends SIGTERM to the Claude process (graceful shutdown), followed by SIGKILL after 3 seconds if the process has not exited. Queued jobs that have not started yet are removed from the queue immediately. In both cases the ticket status is set to **Interrupted**, the active pipeline stage is marked failed, and remaining pending stages are skipped. The ticket can be re-run at any time.

### Session Persistence

The in-progress state of every job — stage transitions, output log entries, status — is written to disk in `~/.prevoyant/sessions/` throughout the run (every 10 output lines and on every step change). If the server is restarted mid-run, sessions are restored from disk on startup. Any session that was `running` or `queued` at restart time is automatically marked `interrupted` so the dashboard never shows stale running indicators.

### Automatic Report Discovery

The server scans `CLAUDE_REPORT_DIR` (default `~/.prevoyant/reports/`) on every dashboard request and associates PDF/HTML files with their ticket keys by filename pattern. Historical tickets that only exist as report files (no live session) appear in the dashboard as `disk` source entries with full download links.

### Manual Re-run

Any ticket — including historical disk-only entries — can be re-run from the dashboard in any mode (Dev / Review / Estimate) at any time. A seen-ticket cache prevents accidental duplicate runs; a **Force** option bypasses the cache when a deliberate rerun is intended.

### Extensible Stage Instructions

Drop a markdown file into `server/dashboard/stage-instructions/<stageId>.md` to define what Claude should do in a custom pipeline stage — no SKILL.md edits needed. On the next session start the server reads all instruction files for the current mode and injects them into Claude's runtime prompt alongside the stage sequence. This makes the pipeline fully data-driven: `stages.json` defines what stages exist and `stage-instructions/` defines what Claude does in each one.

### Three Analysis Modes

Every ticket can be run in any of three modes, selectable from the dashboard:

| Mode | Trigger | What Claude does |
|------|---------|-----------------|
| **Dev** | Default | Full 15-step dev workflow: KB sync → ticket ingestion → root cause analysis → proposed fix → PDF report → KB update |
| **Review** | `review` | 11-step PR review: fetches the feature branch diff → Engineering Panel code review → consolidated findings PDF |
| **Estimate** | `estimate` | 9-step Planning Poker: scope analysis → simultaneous voting → structured debate → consensus → PDF estimate |

### Evidence-Only Runs

Any document or URL can be submitted for analysis without a Jira ticket. Leave the ticket key blank in the **Add Ticket to Queue** modal and the server generates a synthetic key (`EV-YYYYMMDD-HHMMSS`). Claude performs direct evidence analysis and writes its findings to the `evidence-insights` KB layer — bypassing the `/prx:dev` skill entirely. See [Evidence-Only Runs](#evidence-only-runs) for details.

### Automatic KB Augmentation

A suite of background workers keeps the Knowledge Base growing and healthy without manual intervention:

- **Marker Rescue** — catches `[KB+]` / `[CMM+]` / `[LL+]` markers from interrupted sessions
- **Memory Pattern Miner** — surfaces recurring cross-ticket learnings as pattern proposals
- **KB Staleness Scanner** — validates `ref: file:line` entries against the source repository
- **Evidence Insights** — evidence-only analyses are indexed into the KB for future runs

See [Knowledge Base Augmentation](#knowledge-base-augmentation) and [Background Workers](#background-workers) for details.

### Health Endpoint

`GET /health` returns `{ status: "ok", server: "prevoyant-server", ts: "..." }` — useful for uptime monitors, load balancers, and deployment health checks.

---

## Start / Stop the Server

Use the provided shell scripts from the **project root** (not from inside `server/`):

### Start

```bash
bash server/scripts/start.sh
```

- Checks if already running (reads `server/.server.pid`)
- Runs `npm install` if `node_modules/` is missing
- Spawns `node index.js` in the background
- Writes PID to `server/.server.pid`
- Logs to `server/prevoyant-server.log`
- Prints the dashboard URL on success

### Stop

```bash
bash server/scripts/stop.sh
```

- Reads PID from `server/.server.pid`
- Sends SIGTERM (graceful); waits up to 5 seconds
- Sends SIGKILL if the process hasn't exited
- Removes the PID file

### Restart

```bash
bash server/scripts/stop.sh && bash server/scripts/start.sh
```

### Run in foreground (development)

```bash
cd server
npm start          # node index.js
npm run dev        # node --watch index.js  (auto-reloads on file changes)
```

### View logs

```bash
tail -f server/prevoyant-server.log
```

---

## Environment Variables

All variables are read from the root `.env` file. The server never reads a `server/.env`.

### Server

| Variable | Default | Description |
|----------|---------|-------------|
| `WEBHOOK_PORT` | `3000` | Port the Express server listens on |
| `WEBHOOK_SECRET` | — | Token appended to the webhook URL (`?token=...`). Leave blank to skip token validation. |
| `WEBHOOK_POLL_INTERVAL_DAYS` | `0` (disabled) | Run `poll-jira.sh` every N days. Fractional values allowed (`0.5` = every 12 h). Set to `0` to disable polling. |

### Jira

| Variable | Description |
|----------|-------------|
| `JIRA_URL` | Atlassian base URL, e.g. `https://yourcompany.atlassian.net` |
| `JIRA_USERNAME` | Your account email — also used to filter incoming webhooks to only your tickets |
| `JIRA_API_TOKEN` | Jira API token ([generate here](https://id.atlassian.com/manage-profile/security/api-tokens)) |

### Analysis

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAUDE_REPORT_DIR` | `~/.prevoyant/reports` | Directory where Claude saves PDF/HTML reports |
| `AUTO_MODE` | — | Set to `Y` to bypass all Claude confirmation gates (headless mode) |
| `FORCE_FULL_RUN_ON` | — | Set to `1` to force all steps to run in full even on reruns |
| `PRX_REPO_DIR` | — | Absolute path to the source repository. Used by the KB Staleness Scanner and any feature that checks file existence. Falls back to `PRX_SOURCE_REPO_DIR`. |

### Knowledge Base

| Variable | Default | Description |
|----------|---------|-------------|
| `PRX_KB_MODE` | `local` | `local` — KB lives at `PRX_KNOWLEDGE_DIR`. `distributed` — KB is a git-managed clone at `PRX_KB_LOCAL_CLONE`. |
| `PRX_KNOWLEDGE_DIR` | `~/.prevoyant/knowledge-base` | Path to the local knowledge base (used when `PRX_KB_MODE=local`). |
| `PRX_KB_LOCAL_CLONE` | `~/.prevoyant/kb` | Path to the git-cloned KB (used when `PRX_KB_MODE=distributed`). |
| `PRX_REALTIME_KB_SYNC` | `N` | Set to `Y` to push KB updates to Upstash Redis in real time (requires `PRX_KB_MODE=distributed`). Has no effect in `local` mode. |

### Memory Pattern Miner

| Variable | Default | Description |
|----------|---------|-------------|
| `PRX_PATTERN_MINER_ENABLED` | `N` | Set to `Y` to enable the Memory Pattern Miner background worker. |
| `PRX_PATTERN_MINER_INTERVAL_DAYS` | `7` | Days between scan runs. Fractional values supported. |
| `PRX_PATTERN_MINER_MIN_TICKETS` | `3` | Minimum distinct tickets a learning must appear in to qualify as a pattern. Minimum enforced: 2. |
| `PRX_PATTERN_MINER_MAX_PROPOSALS` | `20` | Maximum proposals written per run. |

### KB Staleness Scanner

| Variable | Default | Description |
|----------|---------|-------------|
| `PRX_STALENESS_ENABLED` | `N` | Set to `Y` to enable the KB Staleness Scanner background worker. |
| `PRX_STALENESS_INTERVAL_DAYS` | `7` | Days between scan runs. Fractional values supported. |

---

## Dashboard

Open [http://localhost:3000/dashboard](http://localhost:3000/dashboard) in any browser.

### Summary cards

Four counters at the top of the page: **Running**, **Queued**, **Done**, **Failed**.

### Tickets table

Each row shows:

| Column | Description |
|--------|-------------|
| Ticket | Jira key (or `EV-*` synthetic key for evidence-only runs) — click to open the detail page |
| Mode | Dev / Review / Estimate |
| Source | `webhook` / `manual` / `disk` |
| Status | Queued / Running / Done / Failed / Interrupted |
| Queued at | When the ticket entered the queue |
| Completed | When the session finished |
| Duration | Elapsed run time |
| Reports | Download links for generated PDF/HTML files |
| Actions | Play button (re-run) + **Stop button** (visible when running or queued) |

The page auto-refreshes every 30 seconds. The JSON feed is at `/dashboard/json`.

### Ticket detail page

Click any ticket key to open its detail page, which shows:

- **Status badge** and **current stage** — live-updated every 5 seconds while running
- **Pipeline** — horizontal scrollable row of stage cards. Each card shows the step number, label, duration, and a colour-coded status. Skipped stages display a grey **Skipped** badge.
- **Progress bar** — percentage of completed stages
- **Run panel** — mode selector, Run button, and (when active) a **Stop Job** button
- **View Output** — collapsible session log with markdown rendering; falls back to PDF embed when the session is complete
- **Reports** — list of all associated PDF/HTML files with download and inline view links

---

## Add Ticket to Queue

Click **+ Add Ticket to Queue** on the dashboard to open the modal. It supports two distinct workflows:

### Standard Jira run

1. Enter a **Ticket key** (e.g. `PRX-42`).
2. Optionally set the **Analysis mode** (Dev / Review / Estimate).
3. Optionally toggle **Apply changes** to commit Claude's proposed changes to a feature branch.
4. Optionally expand **Extra evidence** to attach supplemental context (see below).
5. Click **Add to Queue**.

### Evidence-only run

Leave the **Ticket key** blank. The form switches to evidence-only mode:

- Jira fields are hidden.
- The evidence section is required.
- A synthetic key `EV-YYYYMMDD-HHMMSS` is generated automatically.

Attach evidence in any combination of:

| Method | Description |
|--------|-------------|
| **Files** | Select any number of files (no size limit). Text files are read in the browser and sent as JSON. |
| **URLs** | Paste one URL per line. The server fetches each URL before spawning Claude (30 s timeout, follows redirects). |
| **Analyst notes** | Free-form text injected directly into the prompt. |

---

## Evidence-Only Runs

Evidence-only runs let you submit documents, logs, or URLs for analysis without a Jira ticket. They use a completely separate prompt path from the standard `/prx:dev` skill.

### How they work

1. The server assigns a synthetic key: `EV-YYYYMMDD-HHMMSS`.
2. Any URLs in the submission are fetched server-side and their content included in the prompt.
3. Claude receives an `evidenceOnlyPrompt` — no KB pre-load, no Jira context, direct analysis only.
4. Claude is instructed to write `[KB+]` markers inline and save its findings to:
   ```
   ~/.prevoyant/knowledge-base/evidence-insights/{ticketKey}.md
   ```
5. The `evidence-insights` layer is included in the KB pre-load for all subsequent standard runs, so findings from evidence-only sessions feed forward into the team's knowledge.

### Output

| Artefact | Location |
|----------|----------|
| Evidence insight file | `~/.prevoyant/knowledge-base/evidence-insights/{EV-*}.md` |
| Session output log | `~/.prevoyant/sessions/{EV-*}.json` |
| Dashboard entry | Visible as any other ticket, labelled with the synthetic key |

### URL fetching

- Fetched server-side using Node's native `https`/`http` modules
- 30-second timeout per URL
- Follows HTTP redirects (up to one hop)
- Failed fetches are included in the prompt as `_(fetch failed: reason)_` so Claude is aware of the attempt
- Only `http://` and `https://` URLs are accepted

---

## Pipeline Tracking

### How it works

1. Claude announces each step in its output using the format:
   ```
   ### Step N — {label}
   ```
2. The server detects this pattern via regex and marks the corresponding stage as **Active**.
3. When the next step is announced, the previous stage is marked **Done** and any skipped stages are marked **Skipped**.
4. When the session ends, remaining stages become **Skipped** (success) or the active stage becomes **Failed** (error/stop).

### Editing stage definitions

Stage definitions live in `server/dashboard/stages.json` — one array per mode:

```json
{
  "dev":      [ { "id": "0",  "label": "KB Sync & Query" }, ... ],
  "review":   [ { "id": "R0", "label": "KB Sync & Query" }, ... ],
  "estimate": [ { "id": "E0", "label": "KB Sync & Query" }, ... ]
}
```

**To add a new stage:**
1. Add an entry to the appropriate array in `stages.json`.
2. Optionally create `server/dashboard/stage-instructions/<id>.md` with Claude's instructions for that step (see [Stage Instructions](#stage-instructions)).
3. Restart the server.

The stage ID must match what Claude announces in its output (`"Step 15 —"` for id `"15"`). For a new stage to go **active** during a run, Claude must also announce it — which happens automatically when a `stage-instructions/<id>.md` file exists and instructs Claude to do so.

---

## Job Queue & Stop/Kill

### Queue behaviour

- All jobs run through a single FIFO queue.
- Only **one Claude session runs at a time** (`MAX_CONCURRENT = 1`) to prevent resource exhaustion.
- Additional jobs wait in the queue and start automatically when the current one finishes.

### Stop a job

Click the **Stop** button (red square icon) on the dashboard list row or the ticket detail page. A confirmation prompt appears before the job is cancelled.

**What happens:**

| State | Action |
|-------|--------|
| Queued | Removed from queue immediately; status set to **Interrupted** |
| Running | SIGTERM sent to the Claude process; SIGKILL after 3 seconds if still alive |

After stopping:
- The active pipeline stage is marked **Failed**
- All remaining pending stages are marked **Skipped**
- The session is persisted to disk with status `interrupted`
- The ticket can be re-run at any time from the dashboard
- The **Marker Rescue** safety net scans the output log for any `[KB+]` / `[CMM+]` / `[LL+]` markers and saves them for manual review (see [Marker Rescue](#marker-rescue))

---

## Stage Instructions

Stage instructions let you define what Claude should do in a custom pipeline stage — without editing SKILL.md.

### How to add instructions for a new stage

1. Add the stage to `server/dashboard/stages.json`:
   ```json
   { "id": "15", "label": "Security Scan" }
   ```

2. Create `server/dashboard/stage-instructions/15.md` with the instructions:
   ```markdown
   Scan the proposed fix for OWASP Top 10 vulnerabilities. For each finding report:
   - Vulnerability type and CWE reference
   - Affected file and line number
   - Recommended remediation
   
   If no issues are found, state "No vulnerabilities detected."
   ```

3. Restart the server.

On the next session, Claude receives the stage sequence and the custom instructions injected into its prompt. It announces `### Step 15 — Security Scan` when it reaches that step, and the pipeline tracks it live.

**Key rule:** The stage ID in `stages.json` must match what Claude announces (`"Step 15 —"`). The instructions file is what tells Claude to announce that step and what to do there.

---

## Knowledge Base Augmentation

The KB is built up from multiple independent flows that each contribute different types of knowledge. Every flow is non-blocking — they write proposals or drafts for human review rather than committing directly to the KB.

### KB layers

| Layer | Path | Populated by |
|-------|------|-------------|
| `shared` | `knowledge-base/shared/` | Manual curation + Step 13j promotions |
| `core-mental-map` | `knowledge-base/core-mental-map/` | KB Flow Analyst + manual |
| `lessons-learned` | `knowledge-base/lessons-learned/` | Step 13 during Dev runs |
| `personas/memory` | `knowledge-base/personas/memory/{agent}/` | Agent memory after each run |
| `evidence-insights` | `knowledge-base/evidence-insights/` | Evidence-only runs (automatic) |

### Augmentation flows

#### 1. Step 13 — KB update (inline, every Dev run)

The SKILL.md Step 13 instructs Claude to emit `[KB+]`, `[CMM+]`, and `[LL+]` markers inline during investigation and then consolidate them into the KB at the end of the session. This is the primary KB write path.

#### 2. Evidence-only runs → evidence-insights layer

Evidence-only runs (no Jira ticket) write their findings to `evidence-insights/{key}.md`. These files are included in the KB pre-load for all subsequent standard runs — so one-off document analyses feed forward into every future Claude session.

#### 3. Marker Rescue — safety net for interrupted sessions

When Step 13 does not run to completion (session killed, timeout, error), any `[KB+]` / `[CMM+]` / `[LL+]` markers emitted during the session are rescued and written to:
```
~/.prevoyant/knowledge-buildup/rescued-markers/{ticketKey}.md
```
These are for manual review. Nothing is written to the KB directly.

#### 4. Memory Pattern Miner — cross-ticket pattern detection

After enough tickets have been processed, the Pattern Miner scans the agent memory files for learnings that recur across multiple tickets and proposes them as shared patterns:
```
~/.prevoyant/knowledge-buildup/pattern-proposals.md
```
Proposals are **PENDING APPROVAL** — a human or the Step 13j review process must promote them to `shared/patterns.md`.

#### 5. KB Flow Analyst — structural flow discovery

The optional KB Flow Analyst worker queries Jira for recent incidents, identifies the most-impacted business flows, traces them in the codebase, and proposes Core Mental Map updates to:
```
~/.prevoyant/knowledge-buildup/kbflow-pending.md
```

#### 6. KB Staleness Scanner — ref hygiene

Periodically validates all `ref: file:line` citations in the KB against the source repository. Stale refs are written to:
```
~/.prevoyant/knowledge-buildup/stale-refs.md
```
and a machine-readable summary to:
```
~/.prevoyant/server/kb-staleness-report.json
```

### Knowledge buildup directory

All pending review artefacts land in `~/.prevoyant/knowledge-buildup/`:

| File | Source |
|------|--------|
| `rescued-markers/{key}.md` | Marker Rescue |
| `pattern-proposals.md` | Memory Pattern Miner |
| `stale-refs.md` | KB Staleness Scanner |
| `kbflow-pending.md` | KB Flow Analyst |
| `kbflow-sessions.md` | KB Flow Analyst run log |

---

## Background Workers

All workers run as `worker_threads` inside the server process. They can be enabled, disabled, and triggered manually from **Settings** in the dashboard without restarting the server.

### Marker Rescue

Not a long-running worker — runs once automatically after every ticket session ends.

- Scans `tracker.outputLog` for `[KB+]`, `[CMM+]`, `[LL+]` markers
- If markers are found **and** Step 13 did not run to completion, appends them to `rescued-markers/{ticketKey}.md`
- No configuration required — always active

### Memory Pattern Miner

Enabled via `PRX_PATTERN_MINER_ENABLED=Y`.

**How it works:**

1. Reads all `{KB_DIR}/personas/memory/{agent}/*.md` files directly (no Redis required)
2. Parses the `## What I Learned` and `## Things That Surprised Me` sections
3. Groups learnings by category across all agents and tickets
4. Any category that appears in `PRX_PATTERN_MINER_MIN_TICKETS` or more distinct tickets becomes a pattern candidate
5. Top 3 representative learnings (by confidence) are selected per candidate
6. Proposals are appended to `pattern-proposals.md`
7. Already-proposed ticket sets are tracked in `~/.prevoyant/server/pattern-miner-state.json` to avoid duplicates

**Proposal format:**
```markdown
## PATTERN-CANDIDATE: CACHING (4 tickets)
Status: PENDING APPROVAL
Date: 2025-11-01
Source: memory-pattern-miner
Tickets: PRX-12, PRX-34, PRX-56, PRX-78

### Representative learnings
  - [morgan/PRX-12] Redis TTL mismatches between write and read paths cause stale data...
  - [alex/PRX-34] Cache keys must include tenant ID to avoid cross-tenant leakage...

### Proposed shared/patterns.md entry
> **Pattern: CACHING** — Appears in 4 tickets (PRX-12, PRX-34, PRX-56, PRX-78).
> [Auto-proposal — review, refine, and promote to shared/patterns.md]
```

**Settings:**

| Setting | Default |
|---------|---------|
| `PRX_PATTERN_MINER_ENABLED` | `N` |
| `PRX_PATTERN_MINER_INTERVAL_DAYS` | `7` |
| `PRX_PATTERN_MINER_MIN_TICKETS` | `3` |
| `PRX_PATTERN_MINER_MAX_PROPOSALS` | `20` |

### KB Staleness Scanner

Enabled via `PRX_STALENESS_ENABLED=Y`. Requires `PRX_REPO_DIR` to check file existence.

**How it works:**

1. Walks all `.md` files in the active KB directory
2. Extracts `ref: path/to/File.java:123` and `Source: path/to/File.java:123` references
3. For each reference:
   - Checks whether the file exists at `{PRX_REPO_DIR}/{filePart}`
   - If it exists, checks the file's line count — if the referenced line is beyond the end of the file (with a 5-line tolerance), it is marked `line-stale`
4. Writes a markdown report to `stale-refs.md` and a JSON summary to `kb-staleness-report.json`

**Staleness categories:**

| Status | Meaning |
|--------|---------|
| `ok` | File exists and line number is within range |
| `file-missing` | File does not exist at the repo path |
| `line-stale` | File exists but has fewer lines than the reference |
| `no-repo` | `PRX_REPO_DIR` not configured — file checks skipped |

**Settings:**

| Setting | Default |
|---------|---------|
| `PRX_STALENESS_ENABLED` | `N` |
| `PRX_STALENESS_INTERVAL_DAYS` | `7` |

### KB Flow Analyst

Enabled via `PRX_KBFLOW_ENABLED=Y`. Queries Jira and uses Claude to discover high-impact business flows and propose Core Mental Map updates. See the [KB Flow Analyst](#kb-flow-analyst-settings) settings section for configuration.

### Configuring workers from the dashboard

All background workers can be configured without editing `.env` directly:

1. Go to **Dashboard → Settings**
2. Scroll to the relevant worker section (Memory Pattern Miner, KB Staleness Scanner, KB Flow Analyst)
3. Toggle **Enable**, adjust intervals, click **Save**
4. Use the **▶ Run now** button to trigger an immediate scan without waiting for the interval

Changes take effect immediately — no server restart required.

---

## Jira Webhook Setup

### Prerequisites

- Your server must be reachable from Jira's servers (public IP or tunnel — e.g., `ngrok` for local development).
- `WEBHOOK_SECRET` must be set in `.env` (recommended for security).

### Configuration in Jira

1. Go to **Jira Settings → System → WebHooks** (or **Project Settings → Webhooks** for project-scoped).
2. Click **Create a WebHook**.
3. Set the URL:
   ```
   http://your-server:3000/jira-events?token=your-webhook-secret
   ```
4. Under **Issue**, check: **Created**, **Updated**.
5. Save.

### Filtering

The server automatically filters incoming events. A ticket is queued only if **all** of the following are true:

- The Jira issue status is one of: **To Do**, **Open**, **Parked**, **Blocked**
- The assignee matches `JIRA_USERNAME` (when set)
- The ticket has not already been processed (deduplication via `.jira-seen-tickets` cache file)

### Local development with ngrok

```bash
ngrok http 3000
# Copy the https://xxx.ngrok.io URL and use it as the webhook URL in Jira
```

---

## Scheduled Polling

As a fallback when webhooks are unavailable, the server can run `poll-jira.sh` on a schedule.

Enable by setting `WEBHOOK_POLL_INTERVAL_DAYS` in `.env`:

```bash
WEBHOOK_POLL_INTERVAL_DAYS=1      # run daily
WEBHOOK_POLL_INTERVAL_DAYS=0.5    # run every 12 hours
WEBHOOK_POLL_INTERVAL_DAYS=0      # disabled (default)
```

The poll script is run once at server startup (if enabled) and then every N days thereafter. It queries Jira for tickets matching the configured criteria and queues any that aren't already in the seen-tickets cache.

---

## API Reference

### Health

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Returns `{ status: "ok", server: "prevoyant-server", ts: "..." }` |

### Dashboard

| Method | Path | Description |
|--------|------|-------------|
| GET | `/dashboard` | Dashboard HTML page |
| GET | `/dashboard/json` | Dashboard data as JSON |
| GET | `/dashboard/ticket/:key` | Ticket detail page |
| GET | `/dashboard/ticket/:key/partial` | Live partial update (polling endpoint used by the detail page) |

### Job Control

| Method | Path | Body | Description |
|--------|------|------|-------------|
| POST | `/dashboard/ticket/:key/run` | `mode=dev\|review\|estimate`, `force=1` (optional) | Queue a ticket for analysis |
| POST | `/dashboard/ticket/:key/stop` | — | Stop a running or queued job |
| POST | `/dashboard/queue` | JSON body (see below) | Add a ticket or evidence-only run to the queue |

**`POST /dashboard/queue` body:**

```json
{
  "ticketKey": "PRX-42",          // optional — leave blank for evidence-only
  "mode": "dev",                  // dev | review | estimate
  "applyChanges": false,
  "evidenceOnly": false,          // auto-set to true when ticketKey is blank
  "extraContext": "...",          // analyst notes
  "attachments": [                // files read by the browser
    { "name": "error.log", "content": "..." }
  ],
  "evidenceUrls": [               // fetched server-side
    "https://example.com/doc.txt"
  ]
}
```

### Reports

| Method | Path | Description |
|--------|------|-------------|
| GET | `/dashboard/view?path=...` | Inline view of a PDF/HTML report (path must be inside reports directory) |
| GET | `/dashboard/download?path=...` | Download a PDF/HTML report |

### Background Worker Controls

| Method | Path | Description |
|--------|------|-------------|
| POST | `/dashboard/settings/pattern-miner/run-now` | Trigger an immediate Pattern Miner scan (requires `PRX_PATTERN_MINER_ENABLED=Y`) |
| POST | `/dashboard/settings/staleness/run-now` | Trigger an immediate Staleness scan (requires `PRX_STALENESS_ENABLED=Y`) |
| POST | `/dashboard/knowledge-builder/run-now` | Trigger an immediate KB Flow Analyst run (requires `PRX_KBFLOW_ENABLED=Y`) |

### Webhook

| Method | Path | Description |
|--------|------|-------------|
| POST | `/jira-events?token=...` | Jira webhook receiver (standalone mode only) |

### Hermes Integration (optional)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/internal/enqueue` | Hermes → Prevoyant event handoff (Hermes mode only) |
| GET | `/internal/jobs/recent-results` | Results poll endpoint for Hermes skill |
| GET | `/dashboard/api/hermes-status` | Live Hermes install/gateway/skill status |

> See [hermes-integration.md](hermes-integration.md) for the full setup guide and API reference.

---

## Architecture

```
Jira webhook ──▶ POST /jira-events
                        │
                        ▼
                   webhooks/jira.js
                   (token check, status/assignee filter, dedup)
                        │
                        ▼
                  queue/jobQueue.js  ◀──  dashboard manual run
                  (FIFO, MAX=1)      ◀──  evidence-only submission
                        │
                        ▼
               runner/claudeRunner.js
               (fetch URLs → build evidence block → KB pre-load →
                spawn `claude --print`, parse stream-json)
                        │
                   step detected              session ends
                   (regex: "Step N —")              │
                        │                           ▼
                        ▼              runner/markerRescue.js
               dashboard/tracker.js   (scan outputLog, rescue
               (in-memory state +      [KB+]/[CMM+]/[LL+] markers)
                session files)
                        │
               ┌────────┴────────┐
               ▼                 ▼
    dashboard/routes.js     ~/.prevoyant/sessions/
    (HTTP + HTML rendering)  (disk persistence)

Background workers (worker_threads):
  ┌─────────────────────────────────────────────────┐
  │  memoryPatternMinerWorker.js                    │
  │    reads personas/memory/{agent}/*.md           │
  │    → knowledge-buildup/pattern-proposals.md     │
  ├─────────────────────────────────────────────────┤
  │  kbStalenessWorker.js                           │
  │    walks KB .md files, checks file:line refs    │
  │    → knowledge-buildup/stale-refs.md            │
  │    → server/kb-staleness-report.json            │
  ├─────────────────────────────────────────────────┤
  │  kbFlowAnalystWorker.js                         │
  │    queries Jira + Claude for flow discovery     │
  │    → knowledge-buildup/kbflow-pending.md        │
  └─────────────────────────────────────────────────┘
```

**Key design decisions:**

- **No database** — all state is held in a `Map` in memory and mirrored to JSON files in `~/.prevoyant/sessions/`. On restart the files are loaded back in.
- **No template engine** — HTML is generated by plain JavaScript string concatenation. This keeps the server dependency-free beyond Express.
- **Single concurrent job** — Claude is a resource-intensive process. Running one at a time prevents memory exhaustion and keeps the output logs readable.
- **Stream parsing** — Claude is invoked with `--output-format stream-json`. The server buffers stdout into lines and parses each JSON event to extract assistant text and detect step boundaries in real time.
- **Workers never write to KB directly** — all background workers write proposals to `~/.prevoyant/knowledge-buildup/` for human review. Only Step 13 (inline during a run) and evidence-only runs write directly to KB layers.
- **Evidence-only runs skip KB pre-load** — no Jira key means no KB context to query; the evidence itself is the entire context.

---

## File Structure

```
server/
├── index.js                      Express app setup, route mounting, worker lifecycle
├── package.json
│
├── config/
│   └── env.js                    Loads root .env, exports typed config object
│
├── dashboard/
│   ├── routes.js                 All /dashboard endpoints + HTML/CSS rendering
│   ├── tracker.js                In-memory ticket state, session persistence, stage lifecycle
│   ├── stages.json               Pipeline stage definitions for all three modes
│   └── stage-instructions/       Optional per-stage markdown instruction files
│       └── .gitkeep
│
├── queue/
│   └── jobQueue.js               FIFO queue, drain loop, killJob()
│
├── runner/
│   ├── claudeRunner.js           Spawns claude CLI, parses stream-json, builds prompts,
│   │                             fetches evidence URLs, pre-loads KB
│   ├── markerRescue.js           Post-run safety net: rescues [KB+]/[CMM+]/[LL+] markers
│   │                             from interrupted sessions → knowledge-buildup/rescued-markers/
│   └── pollScheduler.js          Schedules poll-jira.sh on a day interval
│
├── kb/
│   ├── kbQuery.js                Builds KB pre-load block (all layers incl. evidence-insights)
│   └── kbCache.js                5-minute in-memory cache of KB .md files
│
├── workers/
│   ├── memoryPatternMinerWorker.js  Mines agent memory for cross-ticket patterns
│   │                                → knowledge-buildup/pattern-proposals.md
│   ├── kbStalenessWorker.js         Validates KB file:line refs against source repo
│   │                                → knowledge-buildup/stale-refs.md
│   └── kbFlowAnalystWorker.js       Autonomous KB Flow Analyst (PRX_KBFLOW_ENABLED)
│
├── webhooks/
│   └── jira.js                   POST /jira-events receiver, filtering, dedup
│
├── notifications/
│   ├── email.js                  Transactional email (SMTP)
│   └── sms.js                    SMS stub (planned)
│
├── integrations/
│   └── hermes/                   Optional Hermes agent layer (PRX_HERMES_ENABLED=Y)
│       ├── manager.js            CLI detect, skill deploy, gateway lifecycle
│       ├── notifier.js           Push results to Hermes, Jira write-back, memory sync
│       ├── hermes-skill.md       SKILL.md deployed to ~/.hermes/skills/prevoyant/
│       ├── routes/
│       │   ├── enqueue.js        POST /internal/enqueue
│       │   ├── results.js        GET /internal/jobs/recent-results
│       │   └── kbInsights.js     POST /internal/kb/insights (Hermes KB write-back)
│       └── scripts/
│           ├── install.sh        Write env vars, print registration steps
│           └── uninstall.sh      Set PRX_HERMES_ENABLED=N, stop gateway
│
└── scripts/
    ├── start.sh                  Start server in background, write PID
    └── stop.sh                   Stop server by PID, clean up
```
