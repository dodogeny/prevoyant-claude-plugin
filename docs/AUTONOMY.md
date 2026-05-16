# Cortex Autonomy — Confidence-Gated Self-Improvement

The autonomy system controls how much the AI team can independently consolidate what it learns into the permanent knowledge base. At the highest levels, agents that repeatedly observe the same insight across multiple sessions can promote it directly into the KB — no human action required, but with a configurable review window and reject mechanism.

## The four levels

```
PRX_CORTEX_AUTONOMY_LEVEL=0   # default — safe starting point
```

| Level | Name | What changes |
|-------|------|--------------|
| **0** | Manual | All promotions require an explicit human call to `POST /cortex/memory/promote` or the Cortex dashboard button. Agents can observe and confirm freely; nothing touches the KB without human intent. |
| **1** | Cross-session memory | `confirmCount` is tracked across sessions and included in Step 0 context. Agents can see "this pattern has been observed 5 times by different sessions" and weight their reasoning accordingly. Still no auto-promotion. |
| **2** | Confidence-gated | When an observation reaches the confirm threshold **and** is old enough, it enters a review queue with a timer. If no human rejects it before the timer expires, the scheduler promotes it to the KB automatically. Humans remain in the loop — they just don't have to act for approvals. |
| **3** | Full-trust | Promotion is immediate on the N-th confirmation — no review window, no scheduler delay. The agent's final observe call writes to the KB in the same HTTP request. Only suitable when you trust the quality of agent observations completely. |

---

## How confirmCount works

Every call to `POST /cortex/memory/observe` with the same `key` increments `confirmCount` in the stored LMDB value. A re-observation updates `summary` and `ts` but preserves the accumulated count:

```
Session 1 (Alex): POST /observe { key: "pattern:retry-on-503", summary: "...", type: "pattern" }
→ LMDB: { confirmCount: 1, ts: T1 }

Session 2 (Morgan): POST /observe { key: "pattern:retry-on-503", summary: "..." }
→ LMDB: { confirmCount: 2, ts: T2 }

Session 3 (Riley): POST /observe { key: "pattern:retry-on-503", summary: "..." }
→ LMDB: { confirmCount: 3, ts: T3 }   ← threshold hit at level ≥ 2 → queuedForPromotionAt = T3
```

The count survives server restarts (it is written to LMDB, not held in memory). It is surfaced in `GET /cortex/memory/context` and in `cortex/facts/observations.md` so agents starting a new session can see how well-validated an observation already is.

---

## Level 2 — the validation gate in detail

```
PRX_CORTEX_AUTONOMY_LEVEL=2
PRX_CORTEX_AUTO_PROMOTE_THRESHOLD=3     # confirmations before queuing
PRX_CORTEX_AUTO_PROMOTE_DELAY_HOURS=24  # review window before KB write
PRX_CORTEX_AUTO_PROMOTE_MIN_AGE_DAYS=2  # observation must be this old
```

### Promotion flow

```
                 confirmCount >= threshold
                 AND age >= MIN_AGE_DAYS
                          │
                          ▼
             queuedForPromotionAt = now
             tag: pending-promotion added
                          │
              ┌───────────┴───────────┐
              │  24h review window    │
              │                       │
       Human rejects            Timer expires
              │                       │
              ▼                       ▼
        rejected=true       autonomyScheduler.tick()
        tag: rejected            promotes to KB
        stays in LMDB            tag: promoted
                                 synthesis triggered
```

The scheduler runs hourly. An observation is eligible for promotion only when **both** conditions are met:
- `now - queuedForPromotionAt >= DELAY_HOURS`
- `now - ts >= MIN_AGE_DAYS`

This two-gate design prevents a single noisy session from fast-tracking a bad observation: the observation must be old enough to have survived scrutiny, and the review window must have elapsed.

### What the human sees

The **Cortex dashboard** → Autonomy panel lists every pending observation with its confirm count, queuing time, and two buttons: **Promote now** (immediate) and **Reject** (blocks the scheduler). There is no approval required for the happy path — silence is consent.

Alternatively, use the API directly:
```
# Block an auto-promotion
POST /cortex/memory/reject-promotion
{ "key": "pattern:retry-on-503" }

# Force-approve ahead of the timer
POST /cortex/memory/promote
{ "key": "pattern:retry-on-503" }

# See the current queue
GET /cortex/memory/pending-promotions
```

---

## Level 3 — full-trust immediate promotion

```
PRX_CORTEX_AUTONOMY_LEVEL=3
```

On the N-th observation of the same key, the `/observe` route calls `promoteObservation()` synchronously and returns `{ ok: true, autoPromoted: true, kbFile: "shared/patterns.md" }`. The KB file is written in the same HTTP round-trip, and `fs.watch` triggers a cortex re-synthesis within 30 seconds.

No queue, no scheduler, no review window. Suitable for environments where:
- You have high confidence in the agent personas writing observations
- You want the KB to update in real-time during active sessions
- You are running a solo project and trust your own agents completely

**Caution:** a hallucinated or incorrect observation at confirmCount=3 will enter the KB permanently. You can still correct it by editing the KB file directly; the cortex will re-synthesise on next change.

---

## Session memory and the `persona` field

Any observation with `type: session-summary` is automatically tagged `session-memory` and synthesised into `cortex/facts/session-memory.md`. This file is read at Step 0 so an agent knows what its persona worked on in previous sessions:

```json
POST /cortex/memory/observe
{
  "key":     "session:alex:2026-05-16",
  "type":    "session-summary",
  "persona": "alex",
  "summary": "Worked on PRX-212. Discovered that the retry middleware silently swallows 503s. Left a pending observation: pattern:retry-on-503.",
  "ticketKey": "PRX-212"
}
```

The `persona` field is preserved across re-observations and shown in `session-memory.md` so different agents can read each other's session histories — enabling genuine knowledge handoff between sessions.

---

## Type → KB file mapping

| Observation type | KB file written to |
|------------------|--------------------|
| `pattern` | `shared/patterns.md` |
| `business-rule` | `shared/business-rules.md` |
| `decision` | `shared/decisions.md` |
| `hotspot` | `shared/architecture.md` |
| `anomaly` | `shared/patterns.md` |
| `context` | `shared/architecture.md` |
| `session-summary` | `shared/session-memory.md` |

Each promotion appends a dated block:
```markdown
## pattern:retry-on-503
<!-- promoted from Cortex on 2026-05-18 · ticket: PRX-212 -->

The API gateway retries automatically on 503 but does not surface the retry
count in logs. Services downstream see a clean 200 after the retry cycle,
masking transient failures from observability tools.
```

---

## Synthesised fact files

Two new fact files are generated alongside `observations.md`:

| File | Contents |
|------|----------|
| `cortex/facts/autonomy-queue.md` | Current autonomy level, pending/promoted/rejected observations with confirm counts and timestamps. Agents read this to understand what the team has validated but not yet promoted. |
| `cortex/facts/session-memory.md` | Session summaries written by agents at session end, grouped by persona. Agents read this at Step 0 to recall what their persona last worked on. |

Both files are included in the distributed cortex sync — in `PRX_CORTEX_DISTRIBUTED=Y` mode, these files live inside the KB git repo and travel to team machines automatically.

---

## Configuration reference

| Variable | Default | Description |
|----------|---------|-------------|
| `PRX_CORTEX_AUTONOMY_LEVEL` | `0` | 0=manual · 1=cross-session memory · 2=confidence-gated · 3=full-trust |
| `PRX_CORTEX_AUTO_PROMOTE_THRESHOLD` | `3` | Number of re-observations (confirms) before an observation becomes eligible |
| `PRX_CORTEX_AUTO_PROMOTE_DELAY_HOURS` | `24` | Review window at level 2 — human can reject within this period |
| `PRX_CORTEX_AUTO_PROMOTE_MIN_AGE_DAYS` | `2` | Minimum age of an observation before it can be auto-promoted |

All variables can be changed via the dashboard **Settings → Cortex** section without restarting the server. The autonomy scheduler re-reads config on every hourly tick.

---

## Recommended upgrade path

Start at level 0. Move to level 1 after a few weeks to validate that agents are writing useful, non-redundant observations. Move to level 2 when you trust the observation quality enough to let the review window be your main gate. Move to level 3 only if you find yourself approving every queued item without ever rejecting.

```
Level 0 (weeks 1-4)  → human sees every observation, learns what agents write
Level 1 (weeks 4-8)  → confirmCount accumulates, patterns emerge across sessions
Level 2 (weeks 8+)   → high-confidence observations self-promote with 24h review
Level 3 (optional)   → full autonomy for trusted solo/small-team environments
```

The KB always reflects the human-approved truth. Cortex LMDB is the staging area — confident enough at higher levels, but always correctable by editing the KB source files directly.

---

## API quick-reference

```
# Read
GET /dashboard/cortex/memory/context?ticket=PRX-NNN   # Step 0: facts + observations
GET /dashboard/cortex/memory/pending-promotions        # current autonomy queue
GET /dashboard/cortex/memory/recent?n=20&since=<ms>   # recent observations (optional since filter)

# Write
POST /dashboard/cortex/memory/observe                  # store/update observation
  { key, summary, type, persona, ticketKey, tags, ttl }

POST /dashboard/cortex/memory/promote                  # manual immediate promote
  { key }

POST /dashboard/cortex/memory/reject-promotion         # block pending auto-promote
  { key }
```
