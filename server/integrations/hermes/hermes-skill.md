# Prevoyant — Jira-Driven Developer Workflow

**Version:** 1.3.0  
**Standard:** agentskills.io/v1  
**Maintainer:** Prevoyant Server (localhost)

## What this skill does

Prevoyant analyses Jira tickets and GitHub PRs using Claude Code, producing:
- Structured root-cause analysis and fix proposals (dev mode)
- PR review reports with binding verdicts (review mode)
- Planning Poker estimates with KB-grounded story points (estimate mode)

Results are pushed back to Hermes via `POST /prevoyant/result` once each job completes.

## Trigger conditions

| Event type | Action |
|---|---|
| `jira.status.in_progress` | Queue ticket for **dev** mode analysis |
| `jira.issue_assigned` | Queue ticket for **dev** mode analysis |
| `jira.issue_created` | Queue ticket for **dev** mode analysis |
| `jira.pr.opened` | Queue ticket for **review** mode |
| `jira.ticket.stale` | Queue ticket for **estimate** mode |

## How to invoke

Send a POST to Prevoyant Server's internal enqueue endpoint:

```
POST http://localhost:3000/internal/enqueue
Content-Type: application/json
X-Hermes-Secret: <PRX_HERMES_SECRET>

{
  "ticket_key": "PROJ-123",
  "event_type": "jira.status.in_progress",
  "mode": "dev",          // optional — inferred from event_type if omitted
  "priority": "normal",   // "normal" | "urgent"
  "meta": {}              // optional ticket metadata (components, labels, summary)
}
```

**Response:**
```json
{ "status": "queued", "ticket": "PROJ-123", "mode": "dev" }
```

## Result polling (preferred)

Hermes polls `GET /internal/jobs/recent-results` on a short interval (recommended: 60 s) to pick up completed jobs. Pass `?since=<iso>` on each poll to avoid re-delivering old results.

```
GET http://localhost:3000/internal/jobs/recent-results?since=2026-05-10T08:00:00.000Z
X-Hermes-Secret: <PRX_HERMES_SECRET>

Response:
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

For each result: deliver a push notification to the developer via Telegram/Slack/Discord with the ticket key, status, mode, and cost.

## Push callback (optional — if Prevoyant can reach Hermes)

If Hermes exposes an inbound HTTP endpoint, Prevoyant will also push results to `<PRX_HERMES_GATEWAY_URL>/prevoyant/result`:

```
POST <PRX_HERMES_GATEWAY_URL>/prevoyant/result
X-Prevoyant-Source: prevoyant-server

{ "ticket_key": "PROJ-123", "status": "success", "mode": "dev", "cost_usd": 0.14, "completed_at": "..." }
```

Use whichever delivery mechanism Hermes supports — polling is always available.

## Shared memory

Prevoyant's Knowledge Base lives at `~/.prevoyant/knowledge-base/` (or the configured `PRX_KNOWLEDGE_DIR`). Hermes can read KB files as reference context.

### Contributing insights (optional — opt-in)

When `PRX_HERMES_KB_WRITEBACK_ENABLED=Y`, Hermes may POST cross-ticket observations back to Prevoyant's KB:

```
POST http://localhost:3000/internal/kb/insights
Content-Type: application/json
X-Hermes-Secret: <PRX_HERMES_SECRET>

{
  "title":      "Recurring Redis auth failure pattern",
  "body":       "Markdown body (1–16 KB). Describe the pattern, root cause hypothesis, recommended action.",
  "tickets":    ["PROJ-1234", "PROJ-1456", "PROJ-2003"],   // optional — ticket keys this insight ties to
  "category":   "bug-pattern",                             // bug-pattern | lesson | playbook | warning | insight
  "tags":       ["redis", "auth"],                         // optional, max 20
  "confidence": "high"                                     // low | medium | high (optional)
}
```

**Response (201):**
```json
{ "status": "pending_review",
  "file": "2026-05-11-recurring-redis-auth-failure-pattern-9k3a.md",
  "path": "/Users/.../knowledge-base/hermes-insights/pending/...",
  "category": "bug-pattern",
  "tickets": ["PROJ-1234", "PROJ-1456", "PROJ-2003"],
  "review_url": "/dashboard/hermes-insights" }
```

### Lifecycle — three modes

The response `status` field tells you what happened. The exact behaviour depends on the operator's `PRX_HERMES_KB_WRITEBACK_ENABLED` setting:

| Mode | What happens on POST | Response `status` |
|---|---|---|
| `N` | Endpoint returns 403. Don't retry. | (HTTP 403, `error: "disabled"`) |
| `AUTO` (default) | Insight is written to `pending/`, then an AI judge (Claude Haiku 4.5 or a heuristic fallback) scores it on specificity, evidence, actionability, originality, clarity. Score ≥ 7 → auto-approved + indexed. Score ≤ 3 → auto-rejected. In between → left in `pending/` for human review. | `"approved"`, `"rejected"`, or `"pending_review"` |
| `Y` | Insight is written to `pending/` regardless of quality. Only a human can promote it. | `"pending_review"` |

**Approved** insights immediately become retrievable context for future Claude Code dev/review/estimate runs (the memory indexer re-runs right after promotion). Frontmatter records full provenance: `state`, `reviewer`, `auto_approved` / `auto_rejected`, `validator_score`, `validator_reason`.

**Rejected** insights are never indexed. They're kept for 30 days under `rejected/` for audit, then auto-pruned. If your insight comes back rejected with a reason, treat the reason as a signal — don't re-POST the same observation without new evidence.

**Pending** insights are awaiting human review at `/dashboard/hermes-insights`. Don't re-POST the same insight if it shows `"status": "pending_review"` — it's already on the queue.

Always use this endpoint instead of writing files directly — it gates by env, validates schema, invokes the AI judge, and writes the activity-log entry.

**When to send an insight (suggested heuristics):**
- You've seen ≥3 tickets in the last 30 days share the same root cause → `bug-pattern`.
- A completed ticket's report contains a non-obvious fix that future tickets would benefit from → `lesson`.
- A standard operating procedure crystallises from how the team handled a class of incidents → `playbook`.
- A known footgun is being repeatedly tripped → `warning`.

**Quotas / limits enforced server-side:** title ≤ 200 chars, body ≤ 16 KB, ≤ 50 ticket keys, ≤ 20 tags. Endpoint returns `403 {error: "disabled"}` when the env flag is `N`.

## Environment variables (Prevoyant side)

| Variable | Description |
|---|---|
| `PRX_HERMES_ENABLED` | `Y` to activate Hermes mode |
| `PRX_HERMES_GATEWAY_URL` | Hermes gateway base URL (default `http://localhost:8080`) |
| `PRX_HERMES_SECRET` | Shared secret for `/internal/enqueue` auth |

## Dashboard

Prevoyant Server exposes a job dashboard at `http://localhost:3000/dashboard` — all queued, running, and completed tickets are visible there regardless of Hermes mode.
