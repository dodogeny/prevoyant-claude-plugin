# Cortex — Always-on Intelligence Layer

> The cortex is the **curated, always-fresh summary** of everything Prevoyant has learned about your system. Agents read it at session start (and on demand mid-session) instead of trawling the raw KB every time.

This document describes what cortex does, why it was introduced, how it fits with the other Prevoyant components, and how to run it reliably on a 24/7 server.

---

## TL;DR

| | Without cortex | With cortex |
|---|----------------|-------------|
| **Step 0 KB read** | 10–20 files, ~9k–30k tokens per session | 3–6 fact files, ~600–2000 tokens |
| **Mid-session lookups** | Re-grep raw `shared/*.md` and `core-mental-map/*.md` per agent | Single `cortex_consult` against pre-digested facts |
| **New teammate's first session** | Cold KB walk from zero | Reads team-built cortex via KB sync (distributed mode) |
| **Architecture knowledge freshness** | Whatever was last hand-written in `core-mental-map/architecture.md` | Combined view of KB + repowise dependency graph (if enabled) |

Net effect: **~50–70% reduction in Step 0 tokens** when cortex is fresh, plus a uniform on-demand reference any panel step can hit. Measurable via the `cortex_referenced` events in the activity log.

---

## What it is

Cortex is a background worker (`server/workers/cortexWorker.js`) that watches the KB and synthesises six fact files at `~/.prevoyant/cortex/facts/` (or `<KB>/cortex/facts/` in distributed mode):

| File | Sourced from | Used for |
|------|--------------|----------|
| `architecture.md`   | `core-mental-map/architecture.md`, `shared/architecture.md`, repowise `CLAUDE.md` | System layers, ownership rules, entry points |
| `business-rules.md` | `shared/business-rules.md` (stale entries filtered) | Domain invariants the panel must respect |
| `patterns.md`       | `shared/patterns.md` (sorted by frequency) | Recurring bug patterns — Morgan's 7b-0 lookup |
| `decisions.md`      | `decision-outcomes.md` CONFIRMED entries, or raw `shared/decisions.md` | Past architectural choices that held up |
| `hotspots.md`       | Repowise hotspots + KB `[KB+ RISK]` markers | Files to handle with extra care |
| `glossary.md`       | Auto-extracted from `shared/*.md` headings | Fast domain term lookup |

Each file is small (~200–800 tokens) and **deterministically regenerated** — never hand-edited. The synthesis pass runs:
- On every KB change (debounced via `PRX_CORTEX_DEBOUNCE_SECS`, default 30s)
- On a heartbeat (`PRX_CORTEX_RESYNC_HOURS`, default 6h) as a safety net
- Optionally augmented by repowise (`PRX_REPOWISE_ENABLED=Y`) on a separate schedule

---

## Why it was introduced

Three problems in the workflow that cortex solves directly:

1. **Step 0 token cost grows with KB size.** As `shared/*.md` and `core-mental-map/*.md` accumulate over months, every new session reads more. The Layer 1b semantic relevance pre-score already trimmed this, but it still required reading the full headers of every candidate file just to score it. Cortex compresses the same information once, and Step 0a reads the compressed form.

2. **The panel re-derives the same context every session.** Morgan's KB pattern check (Step 7b-0), Riley's coverage signal (Step 7-pre), and Jordan's risk assessment all hit `shared/patterns.md` independently. They were each computing the same "frequency-sorted, stale-filtered" view on the fly. Cortex pre-computes it once per KB change.

3. **No portable orientation for new teammates.** A fresh dev joining the team had no shortcut — they had to wait several sessions for their local KB to build up before agents could orient quickly. With `PRX_CORTEX_DISTRIBUTED=Y`, cortex lives inside the KB and rides along with `git push` / Upstash sync, so a new machine's first session inherits the team's accumulated intelligence layer.

Cortex was inspired by [Muninn](https://github.com/ravnltd/muninn)'s pre-edit context model — but unlike Muninn (SQLite-backed, MCP-served), cortex keeps the markdown-as-source-of-truth property of the existing KB so human review (`kbflow-pending.md` voting) still works the same way.

---

## How it fits with the other components

```
                        ┌────────────────────────────────────┐
                        │           USER / TEAM              │
                        │  Jira → ticket assigned            │
                        └─────────────┬──────────────────────┘
                                      ▼
                        ┌────────────────────────────────────┐
                        │   prevoyant-server (24/7)          │
                        │  ─────────────────────────────     │
                        │   • job queue                      │
                        │   • dashboard /dashboard/*          │
                        │   • activity log                   │
                        └─┬────┬────┬────┬────┬────┬────┬───┘
                          │    │    │    │    │    │    │
       ┌──────────────────┘    │    │    │    │    │    └─────────────────┐
       ▼                       ▼    │    ▼    │    ▼                      ▼
 ┌───────────┐        ┌─────────────┐    │ ┌───────────────┐         ┌─────────────┐
 │ Ticket    │        │ KB Flow     │    │ │  Pattern       │        │  Stale      │
 │ Watcher   │        │ Analyst     │    │ │  Miner         │        │  Branch     │
 │ (polls    │        │ (mines      │    │ │ (rolls up      │        │ (flags      │
 │  Jira)    │        │  KB usage)  │    │ │  retros)       │        │  orphans)   │
 └───────────┘        └─────────────┘    │ └───────────────┘         └─────────────┘
                                         │
                          ┌──────────────▼──────────────────┐
                          │   KB filesystem                 │
                          │   shared/*.md                   │
                          │   core-mental-map/*.md          │
                          │   tickets/*.md                  │
                          │   personas/memory/{agent}/*.md  │
                          └──────────────┬──────────────────┘
                                         │  fs.watch (debounced 30s)
                                         ▼
                          ┌──────────────────────────────────┐
                          │   ★ CORTEX WORKER ★              │
                          │                                  │
                          │   synthesise on every KB change │
                          │     + heartbeat every 6h         │
                          │     + repowise refresh daily     │
                          │                                  │
                          │   writes:                        │
                          │     facts/architecture.md        │
                          │     facts/business-rules.md      │
                          │     facts/patterns.md            │
                          │     facts/decisions.md           │
                          │     facts/hotspots.md            │
                          │     facts/glossary.md            │
                          │     state.json (builder lock)    │
                          └──────────────┬───────────────────┘
                                         │
                       ┌─────────────────┼────────────────────┐
                       ▼                 ▼                    ▼
              ┌────────────────┐ ┌─────────────┐   ┌────────────────────┐
              │ dev skill      │ │ /dashboard/  │   │ KB sync (Upstash + │
              │ session        │ │ cortex page  │   │ git) — distributed │
              │                │ │              │   │ mode only          │
              │ Step 0a        │ │ Browse all   │   │                    │
              │ reads 6 facts  │ │ facts + run- │   │ Other dev's        │
              │                │ │ now buttons  │   │ machines pull and  │
              │ Step 5 / 7b-0  │ │              │   │ inherit the cortex │
              │ on-demand      │ │              │   │                    │
              │ consult        │ │              │   │                    │
              └────────────────┘ └─────────────┘   └────────────────────┘
```

### Relationship to the other workers

| Component | Role | How cortex relates |
|-----------|------|--------------------|
| **KB Flow Analyst** | Reviews KB usage, surfaces nudges to `kbflow-pending.md` | Cortex reads `shared/*.md` after KB Flow proposals are reviewed |
| **Pattern Miner** | Mines persona retros into pattern candidates | Confirmed patterns flow into `shared/patterns.md`, which cortex digests into `facts/patterns.md` |
| **Decision-Outcome Linker** | Grades decisions CONFIRMED/CONTRADICTED | Only CONFIRMED decisions reach `facts/decisions.md` — cortex filters by status |
| **KB Staleness Scanner** | Flags `file:line` refs that no longer exist | Independent — cortex re-synthesises whenever a KB file changes, including after staleness auto-heals |
| **Stale Branch Detector** | Flags orphaned branches | Independent — does not feed cortex |
| **Repowise** *(optional)* | Codebase dependency graph + auto-wiki | Cortex ingests repowise's `CLAUDE.md` into `facts/architecture.md` and `facts/hotspots.md` |
| **Conflict Checker** (file-overlap + co-change) | Detects merge collisions at enqueue | Independent — uses its own co-change cache, not cortex |

### Relationship to the dev skill (SKILL.md)

| Skill step | Cortex involvement |
|------------|--------------------|
| **Step 0a — Cortex Pass** (NEW in v1.4.1) | Reads all 6 fact files. Emits `[CORTEX HIT/MISS]` markers. Replaces Layers 1b/3 KB reads for topics it covers. |
| **Step 5 — File Map / Fragility** | Cross-checks `facts/hotspots.md`. Cortex+fragility agreement → `[KB+ RISK HIGH-CONFIDENCE]` |
| **Step 7b-0 — Morgan's KB patterns** | Prefers `facts/patterns.md` over `shared/patterns.md` (same data, pre-sorted) |
| **Step 7c, 7e — Panel investigation** | Generic `cortex_consult` helper any agent can call for on-demand context |

Every consultation pings `/dashboard/cortex/referenced` with a `step` field, so the activity log records exactly which step used cortex on which ticket.

---

## Operations

### Modes

| Mode | `PRX_CORTEX_DISTRIBUTED` | Storage | Sharing |
|------|--------------------------|---------|---------|
| **Local** (default) | `N` | `~/.prevoyant/cortex/` | Per-machine; never shared |
| **Shared** | `Y` | `<KB>/cortex/` | Rides along with KB sync — new teammate inherits the team's cortex |

### Builder lock (shared mode only)

In shared mode, only **one machine writes cortex at a time** to prevent two devs synthesising on different KB heads from clobbering each other. The lock is a heartbeat in `state.json`:

- First machine to tick claims the builder role
- Other machines become passive readers (they still consume `facts/*.md`)
- If the builder goes silent for 10 minutes, another machine auto-takes over
- `PRX_CORTEX_FORCE_BUILDER=Y` forces immediate takeover when the previous builder is offline

The cortex dashboard page shows the current builder + heartbeat age. Activity log records `cortex_builder_claimed` and `cortex_skipped` events for handoffs.

### Repowise integration

Optional. When `PRX_REPOWISE_ENABLED=Y`:

- Server checks for `repowise` on PATH at startup; if missing, **auto-installs** (pipx → uv → pip --user) unless `PRX_REPOWISE_AUTO_INSTALL=N`
- Python 3.11+ is the prerequisite — if missing, the installer surfaces a platform-specific install hint (brew / winget / apt / dnf / etc.) but does NOT auto-install Python
- `repowise update` runs on `PRX_REPOWISE_INTERVAL_DAYS` cadence (default 1d)
- Output (`CLAUDE.md`) is captured into `cortex/repowise/` and ingested into `facts/architecture.md` and `facts/hotspots.md`
- Graceful degradation: cortex works fine on KB-only sources if repowise is missing

### Environment variables

```bash
# Required to activate
PRX_CORTEX_ENABLED=Y

# Distribution
PRX_CORTEX_DISTRIBUTED=N           # Y → share via KB
PRX_CORTEX_FORCE_BUILDER=N         # Y → force this machine as builder

# Synthesis cadence
PRX_CORTEX_DEBOUNCE_SECS=30        # wait this long after last KB change
PRX_CORTEX_RESYNC_HOURS=6          # heartbeat resync safety net

# Repowise sub-integration
PRX_REPOWISE_ENABLED=N
PRX_REPOWISE_INTERVAL_DAYS=1
PRX_REPOWISE_PATH=repowise         # override if not on PATH
PRX_REPOWISE_AUTO_INSTALL=N        # Y → install on enable (default Y when ENABLED=Y)
```

All editable from the Settings page — no `.env` editing required.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Brain badge missing from header | `PRX_CORTEX_ENABLED` is `N` | Settings → Cortex → Enable → Save |
| `[CORTEX MISS]` on every Step 0a | `lastSynthesis` is stale (>24h) | Click "▶ Re-synthesise now" on `/dashboard/cortex`; check worker is alive |
| Cortex never claims builder (shared mode) | Another machine has a fresh heartbeat | Wait 10min for auto-takeover OR set `PRX_CORTEX_FORCE_BUILDER=Y` on the machine you want as builder |
| Repowise integration shows "MISSING" | `repowise` not on PATH | Click "⬇ Install repowise" on the Cortex page; check `PRX_REPOWISE_PATH` |
| Repowise install fails with "Python 3.11+ required" | Old or missing Python | Follow the platform-specific hint shown in the install log |
| Cortex page shows 0 fact files | Worker hasn't run yet OR errored during synthesis | Check `~/.prevoyant/server/prevoyant-server.log` for `[cortex/error]` lines |
| Worker stops after laptop wakes | Likely OK — wake-jitter delays first tick by up to 30s | If still missing after 5min, check `launchctl list` / `systemctl --user status` |

---

## See also

- [Settings page](http://localhost:3000/dashboard/settings#cortex) — all cortex envs editable from the UI
- [Cortex dashboard](http://localhost:3000/dashboard/cortex) — live view of every fact file
- [SKILL.md Step 0a / 5 / 7b-0](../plugin/skills/dev/SKILL.md) — agent-side consultation logic
- [server/workers/cortexWorker.js](../server/workers/cortexWorker.js) — synthesis worker
- [server/runner/cortexLayer.js](../server/runner/cortexLayer.js) — shared resolver / builder lock
- [Muninn](https://github.com/ravnltd/muninn) — the pre-edit context model that inspired cortex
- [Repowise](https://github.com/repowise-dev/repowise) — codebase intelligence sub-integration
