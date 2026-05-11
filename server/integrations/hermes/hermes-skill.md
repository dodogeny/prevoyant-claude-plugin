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

### **YOU are the judge — self-validation requirement for AUTO mode**

Prevoyant deliberately does **not** run its own LLM judge. You (Hermes) already have the LLM smarts and the cross-ticket context — asking a separate Claude call to second-guess you would be redundant. Instead, you self-score every insight before posting and Prevoyant trusts your assessment, **verified by a cheap heuristic sanity check** so a buggy or hallucinating Hermes can't silently poison the KB.

#### Required self-validation rubric

Before posting, score the candidate insight on **five criteria, 0–2 each** (total 0–10):

| Criterion | 0 | 1 | 2 |
|---|---|---|---|
| **Specificity** | Generic platitude | Names a system but is vague | Names a concrete pattern with technical detail |
| **Evidence** | Pure speculation | One ticket cited but loosely | ≥ 3 tickets cited with clear pattern |
| **Actionability** | Vague philosophy | Suggests direction but no steps | A developer could act on this tomorrow |
| **Originality** | Restates ticket descriptions | Slightly more than what tickets say | Says something a careful reader of the linked tickets wouldn't already know |
| **Clarity** | Confused / rambling | Readable but unstructured | Clear, organized, no hallucinated specifics |

**Threshold:** only POST when your total self-score is **≥ 7**. If you can't get to 7, the insight isn't yet worth submitting — keep observing, gather more evidence, or skip it. **Don't lower your bar to push something through.**

#### Include the assessment in the POST payload

Add a `self_assessment` field to every POST:

```json
{
  "title":    "Recurring Redis auth failure pattern",
  "body":     "...",
  "tickets":  ["PROJ-1234", "PROJ-1456", "PROJ-2003"],
  "category": "bug-pattern",
  "tags":     ["redis", "auth"],
  "confidence": "high",
  "self_assessment": {
    "score":    9,
    "criteria": {
      "specificity":  2,
      "evidence":     2,
      "actionability": 2,
      "originality":  2,
      "clarity":      1
    },
    "reason": "Cites 5 tickets sharing same WRONGPASS error, links to specific commit, recommends pinning previous tag. Clarity docked 1 for compressed action section."
  }
}
```

The `reason` field is what gets shown to a human reviewer if the heuristic disagrees with you — make it useful.

#### How Prevoyant uses your self-assessment

A cheap heuristic on Prevoyant's side runs in parallel (no extra LLM call). The two scores are compared:

| Your score | Heuristic score | Verdict |
|:---:|:---:|---|
| ≥ 7 | ≥ 4 | **approve** — both confident |
| ≥ 7 | ≤ 3 | **pending** — you say good, heuristic says weak; human breaks tie |
| 4–6 | any | **pending** — you yourself flagged uncertainty |
| ≤ 3 | any | **reject** — you shouldn't have posted at all |
| missing | ≥ 8 | **approve** — heuristic alone is strong (transition path) |
| missing | ≤ 1 | **reject** — heuristic alone is damning |
| missing | else | **pending** |

If the heuristic flips your verdict, **frontmatter records both scores plus your reason** so the reviewer can see exactly where you and the heuristic disagreed.

### Lifecycle — three modes

The response `status` field tells you what happened. The exact behaviour depends on the operator's `PRX_HERMES_KB_WRITEBACK_ENABLED` setting:

| Mode | What happens on POST | Response `status` |
|---|---|---|
| `N` | Endpoint returns 403. Don't retry. | (HTTP 403, `error: "disabled"`) |
| `AUTO` (default) | Insight is written to `pending/`, then the verdict matrix above runs. Approves immediately index; rejects move to `rejected/`; pending stays for human review. | `"approved"`, `"rejected"`, or `"pending_review"` |
| `Y` | Insight is written to `pending/` regardless of your self-score. Only a human can promote it. | `"pending_review"` |

**Approved** insights immediately become retrievable context for future Claude Code dev/review/estimate runs (the memory indexer re-runs right after promotion). Frontmatter records full provenance: `state`, `reviewer`, `auto_approved` / `auto_rejected`, `self_score`, `heuristic_score`, `self_reason`.

**Rejected** insights are never indexed. They're kept for 30 days under `rejected/` for audit, then auto-pruned. If your insight comes back rejected, treat that as a signal — don't re-POST the same observation without new evidence.

**Pending** insights are awaiting human review at `/dashboard/hermes-insights`. Don't re-POST the same insight if it shows `"status": "pending_review"` — it's already on the queue.

Always use this endpoint instead of writing files directly — it gates by env, validates schema, runs the verdict matrix, and writes the activity-log entry.

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
