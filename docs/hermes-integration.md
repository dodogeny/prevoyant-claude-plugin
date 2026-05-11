# Hermes Integration

Prevoyant can operate as a full-time autonomous agent by connecting to a local [Hermes](https://github.com/nousresearch/hermes-agent) gateway. Hermes acts as the nervous system — handling multi-platform messaging, persistent cross-session memory, unified webhook routing, and proactive scheduling — while Prevoyant remains the domain intelligence layer for Jira ticket analysis and PR review.

---

## Table of Contents

- [What is Hermes?](#what-is-hermes)
- [Architecture](#architecture)
- [How It Works](#how-it-works)
  - [Triggers](#triggers)
  - [Decision Routing](#decision-routing)
  - [Job Execution](#job-execution)
  - [Result Delivery](#result-delivery)
  - [Memory Sync](#memory-sync)
- [Prerequisites](#prerequisites)
- [Setup](#setup)
  - [Step 1 — Install Hermes](#step-1--install-hermes)
  - [Step 2 — Configure Hermes gateway](#step-2--configure-hermes-gateway)
  - [Step 3 — Enable in Prevoyant Settings](#step-3--enable-in-prevoyant-settings)
  - [Step 4 — Register Jira webhook with Hermes](#step-4--register-jira-webhook-with-hermes)
  - [Step 5 — Restart Prevoyant Server](#step-5--restart-prevoyant-server)
- [Configuration Reference](#configuration-reference)
- [Jira Write-back](#jira-write-back)
- [Turning Hermes Off](#turning-hermes-off)
- [API Reference](#api-reference)
- [Troubleshooting](#troubleshooting)

---

## What is Hermes?

[Hermes](https://github.com/nousresearch/hermes-agent) is an open-source autonomous AI agent by Nous Research (MIT licence). It runs persistently on your machine, stores memory in `~/.hermes/`, and exposes a gateway that bridges Telegram, Discord, Slack, WhatsApp, Signal, and CLI into a single conversation thread.

Key properties relevant to Prevoyant:

| Hermes capability | How Prevoyant uses it |
|---|---|
| Multi-platform gateway | Deliver analysis results to Telegram/Slack/Discord |
| Persistent memory (`~/.hermes/`) | Cross-session context about past ticket analyses |
| Built-in cron scheduler | Replace Prevoyant's own polling loop |
| `SKILL.md` open standard | Teach Hermes how to invoke Prevoyant |
| Unified webhook reception | Single entry point for Jira and GitHub events |

Hermes uses the same portable `SKILL.md` format as Prevoyant. The integration file at `server/integrations/hermes/hermes-skill.md` is the contract between the two systems.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                   External Triggers                      │
│  Jira webhook  ·  GitHub PR event  ·  Cron / Proactive  │
└──────────────────────────┬──────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────┐
│              Hermes Gateway  (port 8080)                 │
│                                                          │
│  ┌──────────────────┐   ┌──────────────────────────┐   │
│  │  Multi-platform  │   │   Persistent Memory       │   │
│  │  Inbox           │   │   ~/.hermes/              │   │
│  │  Telegram/Slack  │   │   prevoyant-memory.jsonl  │   │
│  │  Discord/CLI     │   │   skills/prevoyant/       │   │
│  └──────────────────┘   └──────────────────────────┘   │
│                                                          │
│  ┌────────────────────────────────────────────────┐     │
│  │  Decision Router                               │     │
│  │  event type + memory → Prevoyant mode          │     │
│  │  jira.status.in_progress  → dev               │     │
│  │  jira.pr.opened           → review             │     │
│  │  jira.ticket.stale        → estimate           │     │
│  └────────────────────────────────────────────────┘     │
└──────────────────────────┬──────────────────────────────┘
                           │
                POST /internal/enqueue
                           │
                           ▼
┌─────────────────────────────────────────────────────────┐
│          Prevoyant Server  (port 3000)                   │
│                                                          │
│  Job Queue → Claude Code Session (SKILL.md)             │
│  Dev mode · Review mode · Estimate mode                  │
│  KB updated · PDF report generated                       │
│                                                          │
│  GET /internal/jobs/recent-results  ◄── Hermes polls    │
└─────────────────────────────────────────────────────────┘
                           │
             job-completed event
                           │
                           ▼
┌─────────────────────────────────────────────────────────┐
│                     Outputs                              │
│                                                          │
│  Hermes → Telegram / Slack / Discord (push notify)      │
│  Jira comment posted on ticket  (opt-in write-back)     │
│  ~/.hermes/prevoyant-memory.jsonl updated               │
└─────────────────────────────────────────────────────────┘
```

**Without Hermes (`PRX_HERMES_ENABLED=N`, default):**  
Prevoyant operates standalone. Cron polling (`WEBHOOK_POLL_INTERVAL_DAYS`) is the primary trigger. The Jira webhook at `POST /jira-events` provides real-time acceleration.

**With Hermes (`PRX_HERMES_ENABLED=Y`):**  
Hermes is the front door. Prevoyant exposes `POST /internal/enqueue` for Hermes to hand off events, and `GET /internal/jobs/recent-results` for Hermes to poll for completed jobs. Cron scheduling is owned by Hermes. A one-time startup sweep still runs to recover tickets missed while the server was offline.

---

## How It Works

### Triggers

All external events enter Hermes first:

- **Jira webhook** — register your Jira project webhook URL to point at the Hermes gateway, not at Prevoyant directly. Hermes receives events like `jira:issue_created`, `jira:issue_updated`, `jira:issue_assigned`.
- **GitHub events** — PR opened, CI failed, merge to main. Hermes maps these to the `jira.pr.opened` event type and calls `/internal/enqueue` with `mode: review`.
- **Cron / proactive** — Hermes's built-in scheduler runs daily sweeps (stale tickets, budget checks, morning briefings) and calls `/internal/enqueue` for each ticket that needs attention.

### Decision Routing

The Hermes skill (`~/.hermes/skills/prevoyant/SKILL.md`) teaches Hermes to map incoming events to Prevoyant modes:

| Hermes event type | Prevoyant mode |
|---|---|
| `jira.status.in_progress` | `dev` |
| `jira.issue_assigned` | `dev` |
| `jira.issue_created` | `dev` |
| `jira.pr.opened` | `review` |
| `jira.ticket.stale` | `estimate` |

Hermes also consults its persistent memory (`~/.hermes/`) before deciding — if it already knows the ticket was recently processed, it can skip or defer.

### Job Execution

Hermes calls:

```
POST http://localhost:3000/internal/enqueue
Content-Type: application/json
X-Hermes-Secret: <PRX_HERMES_SECRET>

{
  "ticket_key": "PROJ-123",
  "event_type": "jira.status.in_progress",
  "mode": "dev",
  "priority": "normal"
}
```

Prevoyant Server queues the job and spawns a Claude Code session running the SKILL.md workflow — unchanged from standalone mode. The dashboard at `/dashboard` shows live progress.

### Result Delivery

When a job completes, Prevoyant notifies Hermes via two mechanisms:

**1. Push (if Hermes exposes an inbound endpoint):**  
Prevoyant POSTs to `<PRX_HERMES_GATEWAY_URL>/prevoyant/result`:

```json
{
  "ticket_key": "PROJ-123",
  "status": "success",
  "mode": "dev",
  "cost_usd": 0.14,
  "completed_at": "2026-05-10T08:32:00.000Z"
}
```

**2. Poll (always available):**  
The Hermes skill polls `GET /internal/jobs/recent-results` every 60 seconds. Pass `?since=<iso>` to avoid re-delivering old results:

```
GET http://localhost:3000/internal/jobs/recent-results?since=2026-05-10T08:00:00.000Z
X-Hermes-Secret: <PRX_HERMES_SECRET>
```

Response:

```json
{
  "results": [
    {
      "ticket_key": "PROJ-123",
      "status": "success",
      "mode": "dev",
      "source": "hermes",
      "cost_usd": 0.14,
      "completed_at": "2026-05-10T08:32:00.000Z"
    }
  ],
  "polled_at": "2026-05-10T08:33:00.000Z"
}
```

Hermes forwards each result to the developer via Telegram, Slack, Discord, or any configured messaging platform.

### Memory Sync

After every job completion, Prevoyant appends a record to `~/.hermes/prevoyant-memory.jsonl`:

```json
{"ticket_key":"PROJ-123","status":"success","mode":"dev","cost_usd":0.14,"completed_at":"...","type":"prevoyant_result","recorded_at":"..."}
```

Hermes reads this file as context in future sessions — giving it persistent cross-session memory of past analyses without requiring any special Hermes API.

---

## Prerequisites

- Prevoyant Server v1.3.0 or later running on your machine
- Node.js 18+
- Hermes CLI installed (see [Step 1](#step-1--install-hermes))
- Jira project with webhook support
- A configured messaging platform in Hermes (Telegram recommended for first setup)

---

## Setup

### Step 1 — Install Hermes

Run the official one-liner installer:

```bash
# Linux / macOS / WSL2 / Termux
curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash
source ~/.bashrc   # or ~/.zshrc on macOS
hermes --version   # verify
```

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.ps1 | iex
```

> The installer handles Python 3.11, Node.js, ripgrep, and ffmpeg automatically with no admin rights required.

### Step 2 — Configure Hermes gateway

Run the Hermes setup wizard to connect your messaging platforms:

```bash
hermes setup            # full wizard (recommended first time)
# or individually:
hermes gateway setup    # configure Telegram / Discord / Slack / WhatsApp
hermes model            # choose your LLM provider
```

Start the gateway daemon:

```bash
hermes gateway start
```

Verify it is running:

```bash
pgrep -a hermes   # should show the gateway process
```

### Step 3 — Enable in Prevoyant Settings

Open the dashboard at `http://localhost:3000/dashboard` → **Settings** → **Hermes Integration**:

| Field | Value |
|---|---|
| Enable Hermes | `Y` |
| Gateway URL | `http://localhost:8080` (Hermes default) |
| Shared secret | any strong random string, e.g. `openssl rand -hex 16` |
| Jira write-back | `Y` to auto-comment tickets (optional) |

Click **Save & Restart Server**.

On save, Prevoyant automatically:
1. Copies the Prevoyant skill to `~/.hermes/skills/prevoyant/SKILL.md`
2. Starts the Hermes gateway if it is not already running
3. Switches the server to Hermes mode (route change takes effect after restart)

Alternatively, run the guided script:

```bash
bash server/integrations/hermes/scripts/install.sh
```

### Step 4 — Register Jira webhook with Hermes

In Jira: **Project settings → Webhooks → Create webhook**

| Field | Value |
|---|---|
| URL | `http://<your-server>:8080/webhook/jira` |
| Events | Issue created, Issue updated, Issue assigned |

> Point the webhook at the Hermes gateway port (8080), **not** at Prevoyant (3000). Hermes is now the front door.

Load the Prevoyant skill into Hermes:

```bash
hermes skill install ~/.hermes/skills/prevoyant/SKILL.md
```

### Step 5 — Restart Prevoyant Server

If you used the Settings page, the server has already restarted. If you edited `.env` manually:

```bash
cd server && npm start
```

Confirm the mode in the server log:

```
[prevoyant-server] Hermes mode active — scheduling owned by Hermes gateway
[hermes/manager] Skill deployed → ~/.hermes/skills/prevoyant/SKILL.md
[hermes/manager] Gateway spawned (detached) — hermes gateway start
[hermes/notifier] Active — gateway: http://localhost:8080 + Jira write-back + memory sync
```

---

## Configuration Reference

All variables are set in `.env` or via **Settings → Hermes Integration** in the dashboard.

| Variable | Default | Description |
|---|---|---|
| `PRX_HERMES_ENABLED` | `N` | `Y` to activate Hermes mode. Requires server restart for route change. |
| `PRX_HERMES_GATEWAY_URL` | `http://localhost:8080` | Base URL of the Hermes gateway. Prevoyant pushes results here. |
| `PRX_HERMES_SECRET` | — | Shared secret. Hermes sends it in `X-Hermes-Secret` on `/internal/enqueue` calls. Leave blank to skip validation (trusted network only). |
| `PRX_HERMES_JIRA_WRITEBACK` | `N` | `Y` to auto-post a Jira comment when each analysis completes. Uses existing `JIRA_URL` / `JIRA_USERNAME` / `JIRA_API_TOKEN` credentials. |

---

## Jira Write-back

When `PRX_HERMES_JIRA_WRITEBACK=Y`, Prevoyant posts a comment on the Jira ticket after every job completion:

```
✅ *Prevoyant dev analysis success* | cost: $0.140
_Automated analysis by Prevoyant v1.3.0 — see the dashboard for the full report._
```

Status icons: ✅ success · ❌ failed · ⚠️ interrupted

No additional credentials are required — it reuses the `JIRA_URL` / `JIRA_USERNAME` / `JIRA_API_TOKEN` already configured in Prevoyant Settings.

---

## Turning Hermes Off

Hermes is never uninstalled — toggling off simply stops the gateway daemon and restores standalone mode.

**From the dashboard:**  
Settings → Hermes Integration → Enable: `N` → Save & Restart

**From the terminal:**

```bash
bash server/integrations/hermes/scripts/uninstall.sh
```

This sets `PRX_HERMES_ENABLED=N` in `.env` and stops the gateway with `pkill -f "hermes gateway"`. Your `~/.hermes/` data, memory, and skill files are untouched. Re-enable at any time by setting `PRX_HERMES_ENABLED=Y` and restarting.

---

## API Reference

These endpoints are only registered when `PRX_HERMES_ENABLED=Y`.

### `POST /internal/enqueue`

Hermes calls this to hand a Jira/GitHub event into the Prevoyant job queue.

**Auth:** `X-Hermes-Secret: <PRX_HERMES_SECRET>` header (or `?token=` query param)

**Request body:**

```json
{
  "ticket_key": "PROJ-123",
  "event_type": "jira.status.in_progress",
  "mode": "dev",
  "priority": "normal",
  "meta": {}
}
```

| Field | Required | Description |
|---|---|---|
| `ticket_key` | Yes | Jira issue key |
| `event_type` | No | Hermes event type — infers `mode` if `mode` is omitted |
| `mode` | No | `dev` / `review` / `estimate` — overrides `event_type` mapping |
| `priority` | No | `normal` (default) or `urgent` (jumps to front of queue) |
| `meta` | No | Optional ticket metadata: `{ components, labels, summary }` |

**Response:**

```json
{ "status": "queued", "ticket": "PROJ-123", "mode": "dev" }
```

---

### `GET /internal/jobs/recent-results`

Returns jobs completed since `?since=<iso>`. Hermes polls this to pick up results for delivery.

**Auth:** `X-Hermes-Secret: <PRX_HERMES_SECRET>` header (or `?token=`)

**Query params:**

| Param | Default | Description |
|---|---|---|
| `since` | 5 minutes ago | ISO 8601 timestamp. Only jobs completed at or after this time are returned. |

**Response:**

```json
{
  "results": [
    {
      "ticket_key": "PROJ-123",
      "status": "success",
      "mode": "dev",
      "source": "hermes",
      "cost_usd": 0.14,
      "completed_at": "2026-05-10T08:32:00.000Z"
    }
  ],
  "polled_at": "2026-05-10T08:33:00.000Z"
}
```

---

## Troubleshooting

**Settings page shows "Not installed"**  
Run the [install command](#step-1--install-hermes) in your terminal, then click **Recheck** on the Settings page. Make sure `hermes` is on your `PATH` (`which hermes` should return a path).

**Settings page shows "Installed" but "Gateway stopped"**  
Start the gateway manually: `hermes gateway start`. Prevoyant will also start it automatically on the next server restart with `PRX_HERMES_ENABLED=Y`.

**"Skill not deployed" badge**  
Save the settings with `PRX_HERMES_ENABLED=Y` — Prevoyant auto-copies the skill on every save/restart. Or run: `bash server/integrations/hermes/scripts/install.sh`.

**Hermes is not calling `/internal/enqueue`**  
1. Confirm the Jira webhook URL points to the Hermes gateway port (8080), not Prevoyant (3000).
2. Run `hermes skill install ~/.hermes/skills/prevoyant/SKILL.md` to load the Prevoyant skill into Hermes.
3. Check the Hermes gateway logs: `hermes gateway logs` (if supported) or the process stdout.

**Jira comments not appearing**  
Ensure `PRX_HERMES_JIRA_WRITEBACK=Y` and that `JIRA_URL`, `JIRA_USERNAME`, and `JIRA_API_TOKEN` are all set in `.env`. Test Jira connectivity from the Settings → Jira section of the dashboard.

**Reverting to standalone (route not switching)**  
Route registration (`/jira-events` vs `/internal/enqueue`) requires a full server restart. After toggling `PRX_HERMES_ENABLED`, always click **Save & Restart Server** rather than just **Save**.

---

> Back to [Prevoyant Server docs](./prevoyant-server.md) · [Main README](../README.md)
