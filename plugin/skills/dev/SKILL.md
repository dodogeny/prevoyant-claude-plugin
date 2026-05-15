---
name: dev
description: "\"Structured Jira-driven developer workflow skill. Supports two modes — (1) Dev mode: use when a developer provides a Jira ticket URL or ticket key (e.g. PROJ-1234) and wants to start development work; handles the full workflow from reading the Jira ticket to proposing a code fix. (2) PR Review mode: use when a developer wants to review code changes for a Jira ticket; analyses the ticket context plus all code changes on the associated feature branch, then outputs findings and recommendations as a PDF report.\""
version: 1.4.2
---

# Dev Workflow Skill

Full end-to-end developer workflow for Jira tickets. Guides Claude through reading, understanding, branching, locating, and fixing a reported issue or enhancement.

## Skill Change Log
<!-- Bryan appends one row per approved change. Never edit existing rows — append only. -->
<!-- Full details (before/after wording, revert status) are in shared/skill-changelog.md in the KB. -->
| SC# | Version | Date | Commit | Type | Summary | Status |
|-----|---------|------|--------|------|---------|--------|
| SC-001 | v1.3.0 | 2026-05-15 | — | Feature | Step 0b: semantic relevance pre-score gates KB file loads by ticket keyword match | ACTIVE |
| SC-002 | v1.3.0 | 2026-05-15 | — | Feature | Step 5: git blame injection on primary method + one-level call graph traversal | ACTIVE |
| SC-003 | v1.3.0 | 2026-05-15 | — | Feature | Step 7-pre: Riley's test suite signal before panel convenes | ACTIVE |
| SC-004 | v1.3.0 | 2026-05-15 | — | Feature | Step 7b-0: Morgan's KB patterns cross-reference before JIRA search | ACTIVE |
| SC-005 | v1.3.0 | 2026-05-15 | — | Feature | Step 7e: Certainty score (1–5) + "change my mind" gate on low-confidence votes | ACTIVE |
| SC-006 | v1.3.0 | 2026-05-15 | — | Feature | Step 7e-ii: Adversarial falsification round before cross-examination | ACTIVE |
| SC-007 | v1.3.0 | 2026-05-15 | — | Feature | Step 14c: Hypothesis tagging on SKILL.md proposals with post-session accuracy tracking | ACTIVE |
| SC-008 | v1.3.0 | 2026-05-15 | — | Feature | Step 14c-ii: Cross-ticket pattern synthesis pass in Bryan's retrospective | ACTIVE |
| SC-009 | v1.3.1 | 2026-05-15 | — | Feature | Step E0-b: Jira cycle time query surfaces P50/P90 throughput anchor before Planning Poker | ACTIVE |
| SC-010 | v1.3.1 | 2026-05-15 | — | Feature | Step E2-a: Dependency graph scoring feeds Jordan's Risk dimension vote directly | ACTIVE |
| SC-011 | v1.4.0 | 2026-05-15 | — | Feature | Step 5: Fragility score column (Muninn-style weighted composite) injected into the file map | ACTIVE |
| SC-012 | v1.4.1 | 2026-05-15 | — | Feature | Step 0b: Layer 0 Cortex Pass — read ~/.prevoyant/cortex/facts/*.md first; emit `[CORTEX HIT/MISS]` markers; narrow Layers 1b/3 by coverage map (~50–70% Step 0 token savings when fresh) | ACTIVE |
| SC-013 | v1.4.2 | 2026-05-15 | — | Feature | Mid-session cortex consultation — Step 5 hotspot cross-check (emits `[KB+ RISK HIGH-CONFIDENCE]` on cortex+fragility agreement), Step 7b-0 cortex-first patterns, and a generic `cortex_consult` helper any panel step can use. Telemetry pings now tag the step (0a / 5 / 7b-0 / 7c-{agent}). | ACTIVE |

## Configuration

Before executing any step, resolve the following variables. Run `echo $PRX_REPO_DIR` via Bash to confirm it is set — if it is empty, stop immediately and tell the developer: `PRX_REPO_DIR is not set. Add it to your .env file: PRX_REPO_DIR=/absolute/path/to/your/repo`

```
REPO_DIR       = ${PRX_REPO_DIR}   ← set via PRX_REPO_DIR in .env

KB_MODE        = ${PRX_KB_MODE:-local}
                 ┌─ local        → KNOWLEDGE_DIR = ${PRX_KNOWLEDGE_DIR:-$HOME/.prevoyant/knowledge-base}
                 └─ distributed  → KNOWLEDGE_DIR = ${PRX_KB_LOCAL_CLONE:-$HOME/.prevoyant/kb}

PRX_KB_REPO        = (required when KB_MODE=distributed — URL of the team's dedicated private KB repository)
                          e.g.  git@bitbucket.org:mycompany/prx-kb.git
                                https://github.com/mycompany/prx-kb.git
PRX_KB_LOCAL_CLONE = (optional — local clone path for the KB repo; default: $HOME/.prevoyant/kb)
PRX_KB_KEY         = (optional when KB_MODE=distributed — AES-256-CBC passphrase for defense-in-depth
                          encryption; omit to push plain Markdown to the private repo)

PRX_SOURCE_REPO_URL = (optional — hosted URL of your codebase, e.g. https://github.com/myorg/myrepo
                          Used to cross-check KB file:line references against the live branch.
                          Omit to skip the cross-check.)

PRX_EMAIL_TO       = (optional — recipient address; if set, the report is emailed after saving)
PRX_SMTP_HOST      = (required when PRX_EMAIL_TO is set — SMTP server hostname, e.g. smtp.gmail.com)
PRX_SMTP_PORT      = (optional — SMTP port; default: 587)
PRX_SMTP_USER      = (required when PRX_EMAIL_TO is set — SMTP login username)
PRX_SMTP_PASS      = (required when PRX_EMAIL_TO is set — SMTP password or app password)

PRX_ATTACHMENT_MAX_MB = (optional — maximum attachment size in MB to download and analyse; default: 0 = no limit.
                             Images/screenshots are always read regardless of this setting.
                             Set to e.g. 10 to skip attachments larger than 10 MB.)

AUTO_MODE          = (optional — Y/YES/true to bypass all interactive prompts and permission gates and run
                             the full workflow automatically; default: N. In auto mode the skill applies safe
                             defaults at every gate, does not ask for confirmation, and automatically applies
                             the proposed fix to the newly created feature branch.)

PRX_JIRA_PROJECT   = (optional — Jira project key used to scope ticket polling (e.g. IV).
                             When set, poll-jira.sh adds `project = {PRX_JIRA_PROJECT}` to the JQL filter
                             so only tickets from that project trigger analysis. Omit to poll all projects.)

PRX_REPORT_VERBOSITY      = (optional — controls terminal output verbosity; default: full.
                               full    → every structured block, all panel dialogue, verbatim debate rounds
                               compact → structured blocks intact (Root Cause, Enhancement Statement, Fix,
                                         Morgan's verdicts) but panel narrative condensed to bullet summaries;
                                         the PDF always contains full content regardless of this setting
                               minimal → structured blocks only — no panel narrative, no debate, no check-ins)

PRX_INCLUDE_SM_IN_SESSIONS_ENABLED         = (optional — enable Bryan's Scrum Master retrospective (Step 14 / R10);
                               default: N. Set to Y/YES/true to activate. When N, Steps 14 and R10
                               are skipped entirely and no process-efficiency.md entry is written.)

PRX_SKILL_UPGRADE_MIN_SESSIONS    = (optional — number of sessions with an approved change before Bryan pushes to
                               the plugin repo main branch; default: 3. Set to 1 to push after every session.
                               Only relevant when PRX_INCLUDE_SM_IN_SESSIONS_ENABLED=Y.)

PRX_SKILL_COMPACTION_INTERVAL = (optional — number of sessions between full SKILL.md compaction passes; default: 10.
                               On a compaction session Bryan runs a deep review of the entire SKILL.md to eliminate
                               redundancy, compress verbose prose, and remove dead weight — requires all five team
                               members to approve. Only relevant when PRX_INCLUDE_SM_IN_SESSIONS_ENABLED=Y.)

PRX_MONTHLY_BUDGET        = (optional — monthly Claude subscription budget in USD; default: 20.00.
                               Bryan tracks cumulative session costs against this limit, resets on the
                               first of each calendar month, and flags ⚠️ when spend exceeds 80% of
                               the budget or ❌ when the budget is fully consumed.
                               Only relevant when PRX_INCLUDE_SM_IN_SESSIONS_ENABLED=Y.)

FORCE_FULL_RUN     = (optional — Y/YES/true to force every step in the workflow to execute in full,
                               even when the ticket has been analysed in a prior session and the KB
                               already contains results. Without this flag the skill may condense
                               steps 1–12 into a summary on repeat runs. Set to Y when replaying
                               a ticket to produce a fresh, complete analysis from scratch; default: N.)

PRX_KBFLOW_ENABLED = (optional — enable the autonomous KB Flow Analyst worker in prevoyant-server;
                               default: N. Set to Y to activate. When enabled, the analyst queries Jira
                               for recent incidents, auto-discovers the most-impacted business flows,
                               traces them in the codebase, and proposes CMM contributions to
                               ~/.prevoyant/knowledge-buildup/kbflow-pending.md. The team reviews and votes at Step 13j.
                               No manual flow configuration is required — focus areas come from real
                               incident data.)

PRX_KBFLOW_INTERVAL_DAYS = (optional — days between autonomous scan runs; default: 7.
                               Fractional values supported: 0.5 = every 12 hours. Minimum: 1.
                               Only relevant when PRX_KBFLOW_ENABLED=Y.)

PRX_KBFLOW_LOOKBACK_DAYS = (optional — Jira ticket history window scanned to identify high-frequency
                               flows; default: 30. A wider window finds structural patterns; a narrower
                               one tracks recent spikes. Only relevant when PRX_KBFLOW_ENABLED=Y.)

PRX_KBFLOW_MAX_FLOWS = (optional — maximum number of business flows analysed per run; default: 3.
                               Keeps each run focused. Only relevant when PRX_KBFLOW_ENABLED=Y.)
```

**`KB_MODE=local` (default):** KB lives in the developer's home directory. No git sync. No encryption. Private to one machine.

**`KB_MODE=distributed`:** KB lives in a dedicated **private** git repository owned and controlled by the team (`PRX_KB_REPO`). The repo is cloned locally at `PRX_KB_LOCAL_CLONE`. KB access is governed by the repo's own permissions — a company Bitbucket, GitHub Enterprise, or GitLab instance ensures only authorised team members can read or write the knowledge base. No sensitive data is ever pushed to any public repository. If `PRX_KB_KEY` is also set, all files are AES-256-CBC encrypted before each push, adding a defense-in-depth layer. If `PRX_KB_KEY` is not set, plain Markdown is pushed directly — acceptable when the repo's access controls are sufficient.

Use `REPO_DIR` wherever the repository path is referenced.
Use `KNOWLEDGE_DIR` wherever the knowledge base path is referenced.
Use `KB_MODE` to conditionally execute sync and encryption steps.

**Pre-flight checks — run these via Bash before any step:**

```bash
# 1. REPO_DIR must be set
[ -z "$PRX_REPO_DIR" ] && echo "STOP: PRX_REPO_DIR is not set. Add it to your .env file: PRX_REPO_DIR=/absolute/path/to/your/repo" && exit 1

# 2. REPO_DIR must exist and be a git repository
[ ! -d "$PRX_REPO_DIR/.git" ] && echo "STOP: Directory '$PRX_REPO_DIR' is not a git repository (or does not exist). Check PRX_REPO_DIR in your .env file." && exit 1
```

If either check fails, stop immediately and show the error message to the developer — do not proceed to Step 0.

---

## Knowledge Base

The knowledge base is a shared, persistent store that grows richer after every Dev and Review session. Retrieval is grep on plain Markdown — near-instant, no external dependencies. The storage and distribution model is controlled by `KB_MODE` (defined in Configuration).

**Agents get smarter with every session.** The mechanism is compounding: Session 1 discovers a business rule and writes it. Session 2 reads that rule, applies it immediately rather than re-discovering it, and writes a new architecture insight. Session 3 reads both and contributes a gotcha. After dozens of sessions the agents arrive at a new ticket already knowing the relevant business rules, the risky call sites, the recurring patterns, and the system's architecture — the same mental model a senior engineer would have built over months. This is not incidental: it is the explicit goal of every KB read and write step. **Reading and writing the KB is never optional.** An agent that skips either step makes the whole team less capable on the next ticket.

### Storage Modes

| Mode | KB location on disk | Distribution | Access control | Encryption | Agent read/write path |
|------|--------------------|--------------|-----------------|-----------|-----------------------|
| **local** (default) | `KNOWLEDGE_DIR` (`$HOME/.prevoyant/knowledge-base/`) | None — one machine only | Local filesystem | None | `KNOWLEDGE_DIR` directly |
| **distributed** | `KNOWLEDGE_DIR` (local clone of `PRX_KB_REPO`) | Via git push/pull to the team's private KB repository | Private repo permissions (Bitbucket, GitHub Enterprise, GitLab, etc.) | Optional AES-256-CBC (`.md.enc` files) | `KNOWLEDGE_DIR` or `/tmp/prevoyant-kb-{PID}/` if encrypted |

**`KB_WORK_DIR`** — the path agents use for all KB reads and writes during a session:
```
KB_WORK_DIR = (KB_MODE=local)                            → {KNOWLEDGE_DIR}
            = (KB_MODE=distributed, no PRX_KB_KEY)   → {KNOWLEDGE_DIR}
            = (KB_MODE=distributed, PRX_KB_KEY set)  → /tmp/prevoyant-kb-{$$}/   ← decrypted session copy
```

Resolve `KB_WORK_DIR` in Step 0a and use it consistently for every KB read/write operation thereafter.

---

### Encryption Scheme

_(Applies only when `KB_MODE=distributed` **and** `PRX_KB_KEY` is set. Optional — plain Markdown is fine when the KB repository's access controls are sufficient.)_

**When to use:** Enable encryption when you want defense-in-depth — for example, if there is any risk the private repo could be accidentally made public, or company policy requires encrypted secrets at rest.

**Algorithm:** AES-256-CBC with PBKDF2-SHA512 key derivation (310,000 iterations, random 16-byte salt per file). Encrypted files are binary blobs — they appear as garbage when opened without the key. File extension on disk: `.md.enc`.

**Key:** `PRX_KB_KEY` environment variable — never committed to git.

**Encrypt a single file:**
```bash
openssl enc -aes-256-cbc -pbkdf2 -iter 310000 -md sha512 \
  -in  "$KB_WORK_DIR/{file}.md" \
  -out "$KNOWLEDGE_DIR/{file}.md.enc" \
  -pass env:PRX_KB_KEY
```

**Decrypt a single file:**
```bash
openssl enc -d -aes-256-cbc -pbkdf2 -iter 310000 -md sha512 \
  -in  "$KNOWLEDGE_DIR/{file}.md.enc" \
  -out "$KB_WORK_DIR/{file}.md" \
  -pass env:PRX_KB_KEY
```

**Batch decrypt (Step 0a — pull to session temp dir):**
```bash
KB_WORK_DIR="/tmp/prevoyant-kb-$$"
mkdir -p "$KB_WORK_DIR/tickets" "$KB_WORK_DIR/shared" "$KB_WORK_DIR/core-mental-map" "$KB_WORK_DIR/lessons-learned" \
         "$KB_WORK_DIR/personas/memory/morgan" "$KB_WORK_DIR/personas/memory/alex" \
         "$KB_WORK_DIR/personas/memory/sam"    "$KB_WORK_DIR/personas/memory/jordan" \
         "$KB_WORK_DIR/personas/memory/henk"   "$KB_WORK_DIR/personas/memory/riley" \
         "$KB_WORK_DIR/personas/memory/bryan"
find "$KNOWLEDGE_DIR" -name "*.md.enc" | while read f; do
  rel="${f#$KNOWLEDGE_DIR/}"           # e.g. tickets/IV-3672.md.enc
  out="$KB_WORK_DIR/${rel%.enc}"       # e.g. /tmp/prevoyant-kb-$$/tickets/IV-3672.md
  mkdir -p "$(dirname "$out")"
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 310000 -md sha512 \
    -in "$f" -out "$out" -pass env:PRX_KB_KEY 2>/dev/null || \
    echo "KB_DECRYPT_WARN: ${rel} — skipping (wrong key or corrupted)"
done
```

**Batch encrypt (Steps 13f / R9f — write back from session temp dir):**
```bash
find "$KB_WORK_DIR" -name "*.md" | while read f; do
  rel="${f#$KB_WORK_DIR/}"             # e.g. tickets/IV-3672.md
  out="$KNOWLEDGE_DIR/${rel}.enc"      # e.g. KNOWLEDGE_DIR/tickets/IV-3672.md.enc
  mkdir -p "$(dirname "$out")"
  openssl enc -aes-256-cbc -pbkdf2 -iter 310000 -md sha512 \
    -in "$f" -out "$out" -pass env:PRX_KB_KEY
done
# Remove stale .md.enc files whose source .md was deleted during the session
find "$KNOWLEDGE_DIR" -name "*.md.enc" | while read enc; do
  rel="${enc#$KNOWLEDGE_DIR/}"
  src="$KB_WORK_DIR/${rel%.enc}"
  [ -f "$src" ] || rm -f "$enc"
done
```

---

### Security Model

_(Applies to `KB_MODE=distributed`.)_

| Threat | Mitigation |
|--------|-----------|
| Unauthorised access to KB content | **Private repository** — access controlled by the team's git server (Bitbucket, GitHub Enterprise, GitLab). Only team members with repo access can read or push. |
| Accidental public exposure of the repo | **Optional encryption** — if `PRX_KB_KEY` is set, files are AES-256-CBC encrypted; the repo can be made public and no content is readable without the key. |
| Brute-force key recovery (if encrypted) | PBKDF2-SHA512 at 310,000 iterations per file makes each guess computationally expensive. |
| Key accidentally committed (if encrypted) | `PRX_KB_KEY` is an env var only; `.md.enc` files contain no key material. |
| Plaintext KB in session temp dir (if encrypted) | Decrypted files live only in `/tmp/prevoyant-kb-{PID}/`; deleted after push (Step 13f/R9f). |

**Primary security boundary:** the private repository's access control. Encryption is additive.

**Never store `PRX_KB_KEY` in any file tracked by git.** Set it only in the developer's shell profile (`~/.zshrc`, `~/.bash_profile`).

---

### Directory Layout

```
{KNOWLEDGE_DIR}/                        ← KB root (path depends on KB_MODE — see Storage Modes)
├── INDEX.md    (or INDEX.md.enc)      ← combined index: Memory Palace (primary) + Master Index (fallback)
├── tickets/                            ← per-ticket files (one per analysed / reviewed ticket)
│   └── IV-XXXX.md  (or .md.enc)
├── shared/                             ← accumulated team knowledge
│   ├── business-rules.md  (or .md.enc) ← domain invariants discovered across all tickets
│   ├── architecture.md    (or .md.enc) ← class hierarchies, data flows, ownership decisions
│   ├── patterns.md        (or .md.enc) ← recurring bug/fix patterns with frequency counters
│   ├── regression-risks.md (or .md.enc)← known fragile areas requiring care on every change
│   ├── process-efficiency.md (or .md.enc) ← Bryan's session log: cost, budget, changes applied
│   └── skill-changelog.md    (or .md.enc) ← full audit trail of every Bryan SKILL.md change (before/after, commit hash, revert status)
├── core-mental-map/                    ← compressed codebase mental model (contributed by all agents)
│   ├── INDEX.md   (or INDEX.md.enc)   ← quick index: what topics exist, entry counts, last-updated
│   ├── architecture.md  (or .md.enc)  ← system layers, component boundaries, key class relationships
│   ├── business-logic.md (or .md.enc) ← core domain invariants and state machine rules
│   ├── data-flows.md    (or .md.enc)  ← key data flows, RPC contracts, write paths
│   ├── tech-stack.md    (or .md.enc)  ← technologies, frameworks, key library choices
│   └── gotchas.md       (or .md.enc)  ← non-obvious couplings, footguns, edge-case traps
├── personas/                           ← agent personal memory (grows with every session)
│   └── memory/                         ← one subdirectory per agent; one file per session contribution
│       ├── morgan/                     ← Morgan's personal memory sessions
│       │   └── {YYYYMMDD-IV-XXXX}.md  ← one file per session (conflict-free: each session creates a unique file)
│       ├── alex/                       ← Alex's personal memory sessions
│       ├── sam/                        ← Sam's personal memory sessions
│       ├── jordan/                     ← Jordan's personal memory sessions
│       ├── henk/                       ← Henk's personal memory sessions
│       ├── riley/                      ← Riley's personal memory sessions
│       └── bryan/                      ← Bryan's personal memory sessions
└── lessons-learned/                    ← per-developer sprint retrospective entries; read by all agents
    └── {developer}.md  (or .md.enc)   ← one file per developer (name from git config or PRX_DEVELOPER_NAME)
```

**KB Flow Analyst working files** (unapproved, never committed): the autonomous Javed worker writes to `~/.prevoyant/knowledge-buildup/kbflow-pending.md` (proposed CMM contributions awaiting Step 13j vote) and `~/.prevoyant/knowledge-buildup/kbflow-sessions.md` (run log: timestamp, flows analysed, proposals, approval status). This dir lives outside the KB tree on purpose so neither distributed sync nor manual git operations can pick the files up — only entries promoted to `core-mental-map/` after the panel vote enter the shared KB.

**Persona definitions** (static, developer-editable): stored in the plugin at `plugin/config/personas/{agent}.md`. These files define each agent's voice, reasoning style, and priorities. Any developer may improve them. Each agent has a separate file, so concurrent edits to different agents never conflict.

**Personal memory** (dynamic, session-generated): stored in the KB at `{KB_WORK_DIR}/personas/memory/{agent}/{YYYYMMDD-TICKET}.md`. One file per session per agent — conflict-free by design since each session creates a unique timestamped file. In distributed mode, git auto-merges concurrent session files from different developers without conflicts.

In `KB_MODE=local` all files are plain `.md`. In `KB_MODE=distributed` all files on disk are `.md.enc`; the plain `.md` files exist only in `KB_WORK_DIR=/tmp/prevoyant-kb-{PID}/` during the session.

> **Note:** `PALACE.md` no longer exists as a separate file. The Memory Palace (room trigger tables) and the Master Index (flat entry list) are both sections within `INDEX.md`.

---

### Core Mental Map

The Core Mental Map is a **compressed, always-growing model of the codebase** — the kind of system understanding a senior engineer builds up over months on a project. Unlike `shared/`, which is ticket-driven (what went wrong and why), the Core Mental Map is **codebase-driven** (how the system works, independent of any single ticket).

Every agent contributes to it. Every session starts by reading the relevant sections. When an agent discovers something that contradicts the current map, they update the map with the freshest, most accurate information — so the whole team benefits.

#### Purpose

| `shared/*.md` | `core-mental-map/*.md` |
|---|---|
| Ticket-driven: what went wrong, root cause, fix | Codebase-driven: how the system works |
| Verbose: full context, confirmation history | Compressed: key-value facts, ≤ 3 lines per entry |
| Entries reference specific tickets | Entries reference source files and contributing sessions |
| Business rules, patterns, regression risks | Architecture, data flows, tech stack, gotchas |

#### File Descriptions

| File | Contains |
|------|----------|
| `architecture.md` | System layers, component hierarchy, key class relationships, ownership rules |
| `business-logic.md` | Core domain invariants, state machine rules, lifecycle constraints |
| `data-flows.md` | RPC request/response flows, DB write paths, event chains, API contracts |
| `tech-stack.md` | Technologies, frameworks, library choices, version constraints |
| `gotchas.md` | Non-obvious couplings, footguns, edge-case traps that surprised agents |

#### Entry Format (compressed)

Each entry in a Core Mental Map file is compact — no prose paragraphs. Facts only.

```markdown
## CMM-ARCH-001 — GWT Frontend → Backend API boundary
src: IV-3672 | date: 2026-03-10 | confirmed: 2 | contributors: 3
fcfrontend/ → (GWT RPC) → fcbackend/api/ → service layer → Oracle/PostgreSQL
KEY: RPC callbacks async; UI panels need explicit refresh() after response.
ref: fcfrontend/AlertCentralPanel.java:142, fcbackend/api/AlertService.java:88
```

Fields:
- **`src:`** — ticket that first contributed this entry (or "init" if inferred from a fresh code read)
- **`date:`** — date first written
- **`confirmed:`** — number of sessions that have verified this fact is still accurate
- **`contributors:`** — count of distinct agent sessions that have touched this entry
- **`KEY:`** — the single most important fact (one line, ≤ 120 chars)
- **`ref:`** — `file:line` anchors (verified against live repo before writing)
- Optional **`WARN:`** — a caveat or known exception to the rule

#### Core Mental Map INDEX.md Format

```markdown
# Core Mental Map
Updated: YYYY-MM-DD | Files: 5 | Total entries: N

| File | Entries | Updated | Summary |
|------|---------|---------|---------|
| architecture.md | 3 | 2026-04-18 | System layers, GWT RPC boundary, alert chain |
| business-logic.md | 2 | 2026-04-18 | Resolve lifecycle, pending flag invariant |
| data-flows.md | 2 | 2026-04-18 | Case save path, alert resolution chain |
| tech-stack.md | 2 | 2026-04-18 | GWT 2.x, Java 8, Oracle 12c, PostgreSQL 14 |
| gotchas.md | 3 | 2026-04-18 | Boolean flag trap, orphaned alert risk |
```

#### Cross-Check & Update Protocol

At the start of every session (Step 0b) agents **read** the relevant Core Mental Map sections. During the session (Steps 5, 7, 8) agents **verify** that the map's facts match the live codebase. At the end of each session (Step 13g) agents **update** the map:

- **Confirmed fact:** increment `confirmed:` counter — no other change.
- **Corrected fact:** update `KEY:` and `ref:` with fresh values; append `[CORRECTED {date}]` tag; increment `contributors:`.
- **New fact:** append a new entry; assign next sequential ID for the file (e.g. `CMM-ARCH-004`).
- **Obsolete fact:** mark `[DELETED {date}]` but retain the entry — knowledge of why something existed is still valuable.

**Agents emit `[CMM+]` markers** (analogous to `[KB+]`) during their work to flag contributions for Step 13g. Format:

```
[CMM+ ARCH]  {one-line fact} — ref: {file:line}  [NEW / CONFIRM / CORRECT / DELETE]
[CMM+ BIZ]   {one-line domain invariant} — ref: {file:line}  [NEW / CONFIRM / CORRECT]
[CMM+ FLOW]  {one-line data flow description} — ref: {entry point file:line}  [NEW / CONFIRM / CORRECT]
[CMM+ STACK] {one-line tech fact} — ref: {config or build file:line}  [NEW / CONFIRM / CORRECT]
[CMM+ GOTCHA]{one-line footgun or non-obvious behaviour} — ref: {file:line}  [NEW / CONFIRM]
```

**Cross-check rule:** If an agent's live code read contradicts an existing Core Mental Map entry, it **must** emit a `[CMM+ ... CORRECT]` marker and update the entry in Step 13g. Do not leave stale facts in the map.

---

### Lessons Learned

The Lessons Learned folder is a **per-developer sprint retrospective record** — pitfalls, surprises, and hard-won insights that developers accumulate over time. Unlike `shared/` (ticket-driven) or `core-mental-map/` (codebase-driven), lessons-learned is **developer-driven**: each person owns their own file and writes to it after investigations or sprint reviews.

Agents read all developer files at session start (Step 0b) and surface relevant entries in the Prior Knowledge block. They also emit `[LL+]` markers during investigation to flag new pitfalls discovered during the session; these are appended to the current developer's file at Step 13h.

#### File per Developer

Each developer's lessons are stored in `lessons-learned/{developer}.md` where `{developer}` is resolved from `$PRX_DEVELOPER_NAME` (if set) or `git config user.name` (normalised to lowercase, spaces replaced with hyphens). Agents write only to their own file; they read all files.

#### Entry Format

```markdown
## LL-001 — {short title}
date: 2026-04-14 | sprint: {sprint label or "—"} | ticket: {TICKET_KEY}
PITFALL: {what to avoid — specific and actionable}
KEY: {the lesson in one clear line}
ref: {file:line or "—"}
```

Fields:
- **`PITFALL:`** — the trap or mistake to avoid; written so a future agent recognises the warning
- **`KEY:`** — the corrective rule (one line, ≤ 120 chars)
- **`ref:`** — optional `file:line` anchor in the codebase that illustrates the pitfall
- **`sprint:`** — sprint label (e.g. `Sprint 42`) or `"—"` if not tracked

#### [LL+] Marker

Agents emit `[LL+]` markers during investigation (Steps 5, 7, 8) to flag lessons for Step 13h:

```
[LL+] {short title} | PITFALL: {what to avoid} | KEY: {lesson} | ref: {file:line or "—"}
```

Developers may also append entries manually to their own file at any time (e.g. after a sprint retrospective) using the entry format above.

---

### Memory Palace

The Memory Palace is the primary retrieval layer. It uses the **Method of Loci** — each part of the V1 system is a named **Room**; each knowledge entry has a **vivid trigger phrase** that makes it instantly recognisable when an agent reads a ticket. Agents walk the Palace first, before falling through to the Master Index section.

The Memory Palace lives in the **`## Memory Palace` section of `INDEX.md`** — it is not a separate file.

#### System Map (the loci)

```
                        ┌──────────────────────┐
                        │   GWT Frontend       │  ← UI events, panels, RPC callbacks
                        │   fcfrontend/        │     🖥️  FRONT ROOM
                        └──────────┬───────────┘
                                   │ GWT RPC
                        ┌──────────▼───────────┐
                        │   Backend API        │  ← REST endpoints, service layer
                        │   fcbackend/api/     │     🔧 ENGINE ROOM
                        └──────────┬───────────┘
                                   │
              ┌────────────────────┼────────────────────┐
              │                    │                     │
   ┌──────────▼──────┐  ┌──────────▼──────┐  ┌──────────▼──────┐
   │  Case Manager   │  │  Alert Central  │  │  Plugin/Workers  │
   │  FRAMS / Cases  │  │  FRAMS / Alerts │  │  fcplugin/       │
   │  🏠 CASE ROOM   │  │  🚨 ALERT ROOM  │  │  ⚙️  WORKER ROOM  │
   └──────────┬──────┘  └──────────┬──────┘  └──────────┬──────┘
              └────────────────────┼────────────────────┘
                                   │
                        ┌──────────▼───────────┐
                        │   Database           │  ← Oracle / PostgreSQL schemas
                        │   fcbuild/scripts/   │     🗄️  VAULT
                        └──────────────────────┘
```

#### Room Directory

| Room | System Area | Components / Labels | Enter when ticket mentions… |
|------|-------------|--------------------|-----------------------------|
| 🖥️ **FRONT ROOM** | GWT Frontend (`fcfrontend/`) | AlertCentral, CaseManager (UI) | panel refresh, button action, RPC call, screen not updating |
| 🔧 **ENGINE ROOM** | Backend API (`fcbackend/`) | API, REST, Service | endpoint, service method, response, HTTP |
| 🏠 **CASE ROOM** | Case Manager / FRAMS | CaseManager, FRAMS, Cases | case status, resolve case, case fields, case actions |
| 🚨 **ALERT ROOM** | Alert Central / FRAMS | AlertCentral, Alerts, FRAMS | alert state, alert sync, alert resolution, open alerts |
| ⚙️ **WORKER ROOM** | Plugin / Workers (`fcplugin/`) | Plugin, Worker, Spawner | worker, plugin, spawner, background job, scheduled task |
| 🗄️ **VAULT** | Database (`fcbuild/scripts/`) | Oracle, PostgreSQL, DB, Schema | SQL, schema, table, column, upgrade script |

#### Trigger Anchors

Each knowledge entry has a **trigger** — a 5–8 word memorable phrase that lets an agent recognise relevance in under one second. Triggers live in the **`## Memory Palace` section of `INDEX.md`** and are updated when new entries are added.

#### How Agents Use the Palace

1. **Map the ticket to rooms** — from the ticket's components and labels, identify which Room(s) apply using the Room Directory table above.
2. **Scan triggers** — read only the `### Triggers` table for the matched room(s). This takes one read, ~5 lines per room.
3. **Recognise matches** — any trigger that is relevant to the current ticket is a hit. Follow its `File` link.
4. **Read the matched entry** — grep the file for the section anchor, read ±40 lines.
5. **Fall through to the Master Index** — if the Palace yields no matches, grep the `## Master Index` section of `INDEX.md` directly by component/label keyword as a fallback.

**This two-layer retrieval (Palace triggers → Master Index fallback) means agents spend ≤ 3 read operations to surface all relevant prior knowledge, even as the KB grows to hundreds of entries.**

---

### INDEX.md Format

`INDEX.md` is the single combined KB index. It has two sections:

- **`## Memory Palace`** — the primary retrieval layer. Room-based trigger tables. Agents read this first.
- **`## Master Index`** — the fallback layer. A flat list of all entries, greppable by component, label, ticket key, and trigger.

```markdown
# Dev Knowledge Base
Updated: YYYY-MM-DD | Rooms: 6 | Triggers: N | Ticket entries: N | Shared entries: N

## Memory Palace

### 🏠 CASE ROOM  (CaseManager, FRAMS, Cases)
| Trigger | KB Entry | Type | File |
|---------|----------|------|------|
| "resolve case → must resolve alerts" | BIZ-001 | business-rule | shared/business-rules.md#biz-001 |
| "flag set, never reset — boolean trap" | PAT-001 | pattern | shared/patterns.md#pat-001 |
| "resolveCase — four callers watch this" | RISK-001 | regression-risk | shared/regression-risks.md#risk-001 |
| "pendingAlertResolve drives the chain" | ARCH-001 | architecture | shared/architecture.md#arch-001 |
| "flag removed in cleanup — IV-3672" | IV-3672 | bug-fix | tickets/IV-3672.md |

### 🚨 ALERT ROOM  (AlertCentral, FRAMS, Alerts)
| Trigger | KB Entry | Type | File |
|---------|----------|------|------|
| "resolve case → must resolve alerts" | BIZ-001 | business-rule | shared/business-rules.md#biz-001 |
| "resolveAlertCentral — shared by 3 screens" | RISK-002 | regression-risk | shared/regression-risks.md#risk-002 |

### 🖥️ FRONT ROOM  (GWT Frontend, fcfrontend)
| Trigger | KB Entry | Type | File |
|---------|----------|------|------|

### 🔧 ENGINE ROOM  (Backend API, fcbackend)
| Trigger | KB Entry | Type | File |
|---------|----------|------|------|

### ⚙️ WORKER ROOM  (Plugin, Workers, fcplugin)
| Trigger | KB Entry | Type | File |
|---------|----------|------|------|

### 🗄️ VAULT  (Database, fcbuild/scripts)
| Trigger | KB Entry | Type | File |
|---------|----------|------|------|

## Master Index

### Ticket Entries
| Ticket | Date | Type | Components | Labels | Summary | File |
|--------|------|------|------------|--------|---------|------|
| IV-3672 | 2026-03-10 | bug-fix | CaseManager | FRAMS | Boolean flag not reset — alerts stay open after case resolve | tickets/IV-3672.md |
| IV-3695 | 2026-04-01 | enhancement | AlertCentral | FRAMS | New bulk-resolve endpoint added to AlertService | tickets/IV-3695.md |

### Shared Knowledge Entries
| KB-ID | Domain | Date | Type | Trigger | File | Section |
|-------|--------|------|------|---------|------|---------|
| BIZ-001 | Case Management | 2026-03-10 | business-rule | resolve case → must resolve alerts | shared/business-rules.md | #biz-001 |
| ARCH-001 | CaseManager | 2026-03-10 | architecture | pendingAlertResolve drives the chain | shared/architecture.md | #arch-001 |
| PAT-001 | Boolean Flag | 2026-03-10 | pattern | flag set, never reset — boolean trap | shared/patterns.md | #pat-001 |
| RISK-001 | Alert Sync | 2026-03-10 | regression-risk | resolveCase — four callers watch this | shared/regression-risks.md | #risk-001 |
```

Note: A trigger may appear in multiple rooms if the knowledge spans components (e.g. BIZ-001 "resolve case → must resolve alerts" appears in both CASE ROOM and ALERT ROOM). The `Trigger` column in the Master Index matches the trigger phrases in the Memory Palace — the same entry is reachable via either layer.

### Ticket Entry File Format (`tickets/IV-XXXX.md`)

```markdown
---
ticket: IV-XXXX
date: YYYY-MM-DD
type: bug-fix | enhancement | bug-fix-reviewed | enhancement-reviewed
version: {skill version}
components: {comma-separated list}
labels: {comma-separated list}
rooms: {palace rooms this ticket maps to — e.g. "CASE ROOM, ALERT ROOM"}
verdict: {Approved / Request Changes / N/A}
summary: {one-line summary}
trigger: {5–8 word memorable trigger phrase for INDEX.md Memory Palace}
---

## Problem
{one paragraph — what was broken or missing}

## Root Cause / Enhancement Statement
{verbatim from Step 7i or Step 7-ENH-d}

## Fix / Change Applied
{what was changed and why — file:line references}

## Business Rules Discovered
{bulleted list of new business rules identified during this session — or "None"}

## Architecture Insights
{new understanding of system structure, class hierarchies, or data flows — or "None"}

## Patterns Observed
{recurring patterns seen in this ticket — Jordan pattern number if applicable — or "None"}

## Regression Risks Added
{new fragile areas identified — or "None"}

## Related Tickets
{list of linked tickets and relevance — or "None"}
```

### Shared Knowledge Files Format

Each shared file accumulates entries chronologically. Every entry has:
- An anchor (`{#id}`) matching its row in the Master Index section of INDEX.md
- A **trigger phrase** in the heading (used in the Memory Palace section of INDEX.md)
- A source ticket, date, and confirmation history

**`shared/business-rules.md` entry format:**
```markdown
## BIZ-001 — "resolve case → must resolve alerts" {#biz-001}
Date: 2026-03-10 | Source: IV-3672 | Rooms: CASE ROOM, ALERT ROOM
Confirmed by: IV-3801 (review, 2026-04-02)

When a case transitions to RESOLVED, all open alerts associated with that case must
also be resolved. The system achieves this via the `pendingAlertResolve` flag in
`CaseManager` — if not set before the save callback, the alert resolution chain is
silently skipped.

**Rule:** Every code path that resolves a case must set `pendingAlertResolve = true`
before calling the save service.
```

**`shared/patterns.md` entry format:**
```markdown
## PAT-001 — "flag set, never reset — boolean trap" {#pat-001}
Date: 2026-03-10 | Source: IV-3672 | Rooms: CASE ROOM | Frequency: 2
Jordan — Pattern #2 (Boolean Flag Not Reset)

Boolean flags in `CaseManager` are set on one path (resolve) but not reset on
complementary paths (cancel, error, re-open). This is Jordan's Pattern #2 recurring
in this class.

**Watch:** Any Boolean flag added or modified in `CaseManager` — verify all
complementary paths explicitly before submitting the fix.

**Recurrences:** IV-3672 (2026-03-10), IV-3810 (2026-04-05)
```

### Retrieval Rules

Follow the Memory Palace retrieval procedure in the **"How Agents Use the Palace"** section above (Palace triggers → Master Index fallback, ≤ 3 read operations). Additionally:

- **Read only matched files** — never read a full shared file; grep for the section anchor, then read ±40 lines.
- **Max 5 ticket entries** — if more than 5 ticket entries match, take the 5 most recent by date.
- **All matching shared entries** — business rules, patterns, risks matching the query are always included.
- **Never block on empty KB** — absence of prior knowledge is not an error; initialise and proceed.

### Re-Index Rules

`INDEX.md` is **derived data** — it indexes what is in `tickets/` and `shared/`. It contains no information that is not already present in those source files. Because of this, it is **always fully rebuilt from scratch** after every pull rather than merged. This eliminates all consistency problems regardless of how many developers push, in what order, or whether a push was done manually outside the skill.

**Why full rebuild, not append-only merge:**
When multiple developers push to the same KB repo, git must merge their copies of `INDEX.md`. Since it is an append-only file, git's default merge will produce conflicts whenever two developers both added rows. Resolving these conflicts manually is error-prone and defeats the purpose of automation. A full rebuild from the actual source files on disk always produces a correct, conflict-free result.

**`.gitattributes` — union merge for source files:**

The KB repo must have a `.gitattributes` file to prevent git conflicts on `shared/*.md` files (both developers may append to `business-rules.md` in the same session). Add this to the KB repo root:

```
# KB repo .gitattributes
tickets/*.md              merge=union
shared/*.md               merge=union
core-mental-map/*.md      merge=union
lessons-learned/*.md      merge=union
INDEX.md                  merge=union
```

`merge=union` tells git to keep lines from **both** sides on conflict (instead of marking `<<<<<<<` conflict markers). For append-only Markdown files this is always correct — all appended entries survive. The full rebuild then de-duplicates and normalises the result.

**Full rebuild algorithm (runs after every pull, Step 0a):**

```
1. Scan all tickets/*.md files in KB_WORK_DIR:
   For each file:
     - Read YAML frontmatter: ticket, date, type, components, labels, summary, trigger, rooms
     - Collect into an in-memory ticket list

2. Scan all shared/*.md files in KB_WORK_DIR:
   For each file, find all entries via "## {ID} — ..." headings:
     - Read: ID, trigger phrase (from heading), domain, type, date
     - Collect into an in-memory shared entry list

3. Rebuild INDEX.md from scratch:
   - Write fresh header: "Updated: {today} | Rooms: 6 | Triggers: N | Ticket entries: N | Shared entries: M"
   - Write `## Memory Palace` section:
     - For each of the 6 rooms, collect all triggers from tickets and shared entries
       whose `rooms:` field includes that room
     - Write each room's trigger table with deduplicated, sorted rows
     - For patterns: include the current Frequency value from the source entry
   - Write `## Master Index` section:
     - Write `### Ticket Entries` table — one row per ticket, sorted by date desc
     - Write `### Shared Knowledge Entries` table — one row per shared entry

4. Write INDEX.md to KB_WORK_DIR.

5. Rebuild core-mental-map/INDEX.md from scratch:
   - For each core-mental-map/*.md content file (architecture, business-logic, data-flows,
     tech-stack, gotchas), count entries ("## CMM-..." headings), read the last Updated
     date from the most recent entry's `date:` field, and extract a one-line summary.
   - Rewrite core-mental-map/INDEX.md with fresh counts, dates, and summaries.
   - Update the Total entries count in the header.

6. Rebuild shared/process-efficiency.md header and Velocity Dashboard (if PRX_INCLUDE_SM_IN_SESSIONS_ENABLED=Y):
   - Scan all [S-NNN] journal entries: count sessions, changes pushed, sessions since last push
   - Compute rolling 5-session avg cost per ticket type and trend direction
   - Identify most frequent hotspot step across last 5 sessions
   - Compute change acceptance rate (applied / proposed) across last 10 sessions
   - Overwrite lines 1–separator with fresh header + Velocity Dashboard
   - Leave the append-only journal (below the ═══ separator) untouched
```

**This handles every multi-developer scenario automatically:**
- Developer joins late with a stale INDEX.md → pull + rebuild gives them the full picture (both Palace and Master Index)
- Developer manually pushes raw ticket files → other developers' rebuild picks them up
- Two developers push simultaneously → union merge keeps all rows → rebuild de-duplicates
- Developer pushes from outside the skill → rebuild on next pull reconciles everything
- Core Mental Map union-merge: two developers both append new CMM entries → union merge keeps both → rebuild recount gives correct entry totals

**process-efficiency.md — Journal Format & Rebuild (distributed mode)**

`process-efficiency.md` follows the same append-only + rebuild-on-pull pattern. The file has two zones:

1. **Auto-generated header** (lines 1–~20) — rebuilt after every pull from journal data; never edited manually
2. **Append-only journal** (everything below the `═══` separator) — raw entries only ever appended, never mutated in-place

**Journal entry formats:**

```markdown
## [S-NNN] Session Record
date: YYYY-MM-DD | developer: {name} | ticket: {KEY} | type: Bug/Enh | cost: $N | budget: $N | status: ✅/⚠️
hotspot: {Step name} ({N}%) | change: {BL-NNN or "—"} | impact: {+$N saving vs prev / "baseline"}

## [BL-NNN] Backlog Item
date: YYYY-MM-DD | area: {Step or section} | priority: HIGH/MEDIUM/LOW | seen: 1
PROBLEM: {one-line description of the inefficiency}
[SEEN+1: YYYY-MM-DD by {developer}]
[PROMOTED HIGH: YYYY-MM-DD — seen {N}×]
[CONSENSUS ❌: YYYY-MM-DD — re-queued]
[APPLIED: YYYY-MM-DD in v{X.Y.Z}]

## [BK-NNN] Blocker
date: YYYY-MM-DD | developer: {name} | description: {one-line}
[COUNT+1: YYYY-MM-DD by {developer}]
[PROMOTED HIGH: YYYY-MM-DD — seen 3×]
[RESOLVED: YYYY-MM-DD]
```

**Rules that make union merge correct and lossless:**
- **Never edit any existing line** — only append new lines (status tags, count increments, observations)
- **Never rewrite the header** — it is rebuilt from journal data after pull
- **Duplicate detection** — if two developers both append `[SEEN+1]` to the same backlog item in the same session, the rebuild de-duplicates by grouping tags by date and developer

**process-efficiency.md rebuild algorithm (runs after every pull, alongside INDEX.md rebuild):**

```
1. Scan all [S-NNN] Session Records:
   - Parse date, type, cost, status — collect into session list
   - Count total sessions, sessions with change applied, sessions since last push

2. Scan all [BL-NNN] Backlog Items:
   - Parse base fields + all appended tag lines
   - Derive current priority (last [PROMOTED] tag wins)
   - Derive current status (last [APPLIED] or [CONSENSUS ❌] tag wins)
   - Count total [SEEN+1] tags to get current "seen" count

3. Scan all [BK-NNN] Blocker entries:
   - Count [COUNT+1] tags to get current count
   - Check for [RESOLVED] tag

4. Rebuild the auto-generated header from computed values:
   "Sessions tracked: N | Changes pushed: N | Sessions since last push: N | Next compaction: session N"

5. Rebuild Velocity Dashboard:
   - Sum cost of all [S-NNN] entries in the current calendar month → monthly spend
   - Compare against PRX_MONTHLY_BUDGET (default 20.00): derive % used and status (✅ / ⚠️ >80% / ❌ exceeded)
   - Compute rolling avg cost across last 5 sessions and trend direction
   - Identify most frequent hotspot step across last 5 sessions
   - Compute change acceptance rate (applied / proposed across last 10 sessions)

6. Write rebuilt header + Velocity Dashboard back to the top of the file
   (overwrite lines 1–separator; leave append-only journal untouched)
```

**Multi-developer merge scenarios:**
- Two developers push in the same session → union merge appends both `[S-NNN]` blocks (different ticket keys, possibly same session number — rebuild assigns final sequential numbers); no information lost
- Two developers both increment the same backlog item → union merge keeps both `[SEEN+1]` lines; rebuild counts them correctly
- One developer applies a change, another promotes it in the same push → union merge keeps both tags; rebuild derives the correct current state from the last tag
- Stale clone catches up after many sessions → pull + union merge + rebuild gives the full picture

---

### Update Rules

1. **Always write `tickets/IV-XXXX.md`** at the end of every Dev and Review session.
2. **Append to shared files only for genuinely new knowledge** — check existing entries before appending; never duplicate.
3. **Update `INDEX.md`** — add the new ticket's trigger to the relevant room(s) in the Memory Palace section; add/update rows in the Master Index section; update header counts and date.
4. **Bump pattern frequency** — when an existing pattern recurs, increment `Frequency: N` and append the ticket to Recurrences.
5. **Confirm business rules** — when a review session validates an existing rule, add `Confirmed by:` to the entry rather than creating a duplicate.

### KB Live Annotation Protocol

**Agents do not wait until Step 13/R9 to generate knowledge.** Business rules, architecture insights, patterns, and risks are discovered continuously — during code exploration (Step 5), investigations (Step 7), fix development (Step 8), impact search (Step 9), and code review (Step R4/R5). These must be captured as they arise so nothing is lost and the KB reflects everything the session actually learned.

#### Inline `[KB+]` Marker

Any agent who discovers new business knowledge during their work **must** emit a `[KB+]` annotation inline in their output at the point of discovery. Format:

```
[KB+ BIZ]  {domain rule or invariant} — Source: {file:line or ticket}
[KB+ ARCH] {class/component insight, data flow, ownership} — {file:line}
[KB+ PAT]  Pattern #{N}: {description} — {file:line}  [NEW or BUMP]
[KB+ RISK] {area / method / class} is fragile — {reason}
```

**When to emit:**
| Agent | Emit `[KB+]` when… |
|-------|---------------------|
| **Morgan** | A business rule is stated or confirmed; a historical precedent is found in JIRA (Step 7b) |
| **Alex** | A regression-inducing commit is found; a historical coupling or breaking change is identified via git history |
| **Sam** | A domain invariant is implied by the data flow (e.g. "flag X must be set before service Y runs"); a new component interaction is discovered |
| **Jordan** | A pattern from the 20-pattern checklist is matched — `NEW` if first occurrence, `BUMP` if already in KB |
| **Henk** | A long-standing business rule is confirmed or disputed from first-hand system knowledge; a proposed fix conflicts with established client behaviour or is of questionable necessity |
| **Riley** | A fragile area or edge case is uncovered during impact assessment; a test coverage gap is identified |

**What is worth flagging:**
- A domain rule that is implied by the code but not written anywhere (e.g. "resolving a case must also resolve its alerts")
- An architecture decision visible from the code (e.g. "AbstractXxxListener owns config; concrete subclass only wires it")
- A pattern that recurs (Jordan's 20 patterns)
- A regression risk: a method, class, or area where a change will silently break something else
- A historical coupling discovered via git blame or git log

**What is NOT worth flagging:** implementation details that are obvious from reading the code, standard Java conventions, or anything already in the Prior Knowledge block from Step 0b.

#### Session KB Collection

Step 13a/R9a collect all `[KB+]` markers from the session output (all steps) alongside the structured sources already listed. A `[KB+]` marker is treated as a candidate entry — Morgan confirms it before writing to avoid noise.

Step 13g/R9g collect all `[CMM+]` markers similarly. See the Core Mental Map section above for the full `[CMM+]` marker format and action tags (NEW / CONFIRM / CORRECT / DELETE).

---

### External Knowledge Sources

The knowledge base is augmented by two live external sources that are queried during Step 0b (alongside the local KB) to provide additional context before analysis begins:

| Source | URL | What to query | When to use |
|--------|-----|--------------|-------------|
| **Confluence** | `{JIRA_URL}/wiki` (derived from your `JIRA_URL` env var) | Business requirements, functional specs, known limitations, feature documentation | Before Step 2 — search for the ticket's component or label to find any spec pages |
| **Source Repository** | `PRX_SOURCE_REPO_URL` env var (optional — set to your codebase's hosted URL) | Live source code, recent commit history, current class state | Before Step 5 — cross-check the KB's file:line references against the live main branch to confirm they are still current |

#### Confluence Query (Step 0b — External Layer 1)

Use `mcp__plugin_atlassian_atlassian__searchConfluenceUsingCql` or `mcp__plugin_atlassian_atlassian__getConfluencePage` to search for pages relevant to the ticket:

```
CQL: space = "V1" AND text ~ "{COMPONENT}" AND text ~ "{LABEL}" ORDER BY lastmodified DESC
```

For each page found:
- Extract any acceptance criteria, business rules, or known limitations that relate to the current ticket
- Note the page title and URL as a source reference
- Carry relevant findings into the **Prior Knowledge** block under a `CONFLUENCE` section
- If a page directly contradicts or extends a KB business rule, flag the discrepancy

If no matching Confluence pages are found, state: "Confluence: no pages found for these terms."

#### Bitbucket Cross-Check (Step 0b — External Layer 2)

When the KB contains `file:line` references for the matched components, verify they are still current against the live `development` branch before the investigation team acts on them:

```
URL pattern: {PRX_SOURCE_REPO_URL}/src/{main-branch}/{file_path}
(Skip this cross-check if PRX_SOURCE_REPO_URL is not set.)
```

For each KB entry that cites a specific `file:line`:
1. Confirm the class/method at that line still exists (a quick read of the relevant file range via the Bitbucket source URL, or via local `git show origin/development:{file}`)
2. If a KB entry's file:line is stale (class moved, method renamed), flag it: `⚠️ KB entry {ID} may be stale — {file:line} not found on development branch`
3. Do not update the KB entry during Step 0 — flag it and let Step 13/R9 update it with the correct location after the investigation confirms it

The Bitbucket cross-check is **best-effort**: if the repository is not accessible or the file cannot be found quickly (> 2 targeted reads), skip and proceed with `⚠️ Bitbucket cross-check skipped — verify {file:line} references manually during Step 5.`

### Git Sync Rules

_(Applies only when `KB_MODE=distributed`. Skip entirely when `KB_MODE=local` — no git operations are performed on the KB.)_

The distributed knowledge base lives in a **dedicated private git repository** (`PRX_KB_REPO`) owned and controlled by the team. It is cloned locally at `KNOWLEDGE_DIR`. Because it is a standalone repository — not a branch on the product repo — git operations are straightforward: clone once, pull at session start, push at session end.

**First-time setup (once — when creating the KB repo for the team):**
```bash
KB_CLONE="${PRX_KB_LOCAL_CLONE:-$HOME/.prevoyant/kb}"
mkdir -p "$KB_CLONE/tickets" "$KB_CLONE/shared" "$KB_CLONE/core-mental-map" "$KB_CLONE/lessons-learned" \
         "$KB_CLONE/personas/memory/morgan" "$KB_CLONE/personas/memory/alex" \
         "$KB_CLONE/personas/memory/sam"    "$KB_CLONE/personas/memory/jordan" \
         "$KB_CLONE/personas/memory/henk"   "$KB_CLONE/personas/memory/riley" \
         "$KB_CLONE/personas/memory/bryan"
cd "$KB_CLONE"
git init && git remote add origin "$PRX_KB_REPO"
echo "# Dev Knowledge Base" > README.md

# Create .gitattributes — union merge prevents conflicts on append-only KB files
cat > .gitattributes << 'EOF'
tickets/*.md              merge=union
shared/*.md               merge=union
core-mental-map/*.md      merge=union
lessons-learned/*.md      merge=union
INDEX.md                  merge=union
EOF

git add README.md .gitattributes
git commit -m "init: create knowledge base repo"
git push -u origin main
```

If the repo already exists and a developer is cloning for the first time:
```bash
KB_CLONE="${PRX_KB_LOCAL_CLONE:-$HOME/.prevoyant/kb}"
git clone "$PRX_KB_REPO" "$KB_CLONE"
```

**Migrating from local to distributed (solo → team):**

When a developer who has been working in `KB_MODE=local` switches to `KB_MODE=distributed`, their `KNOWLEDGE_DIR` already contains plain `.md` files with no git history. A plain `git clone` would fail on a non-empty directory. The migration must commit the existing local files into the remote KB repo.

This is handled **automatically** by the updated Pull (Step 0a) logic below — no manual steps are required. The agent detects the "directory exists, no `.git`" condition and runs the migration inline. For reference, the manual equivalent is:

> **Key requirement — read before running:** If the team KB repo uses encryption (i.e. other contributors have `PRX_KB_KEY` set), you **must** set the same `PRX_KB_KEY` passphrase in your shell profile before migrating. Migrating without it pushes plain `.md` files that are invisible to every encrypted contributor, and encrypted files they push will be invisible to you. The migration script below detects this mismatch and aborts with instructions if the remote already contains `.md.enc` files and your `PRX_KB_KEY` is unset.

```bash
KB_CLONE="${PRX_KB_LOCAL_CLONE:-$HOME/.prevoyant/kb}"
cd "$KB_CLONE"
git init
git remote add origin "$PRX_KB_REPO"
cat > .gitattributes << 'EOF'
tickets/*.md              merge=union
shared/*.md               merge=union
core-mental-map/*.md      merge=union
lessons-learned/*.md      merge=union
INDEX.md                  merge=union
EOF

# --- Encryption consistency check (must run before committing any files) ---
REMOTE_MAIN_EXISTS=false
REMOTE_HAS_ENC=false
if git ls-remote --exit-code origin main >/dev/null 2>&1; then
  REMOTE_MAIN_EXISTS=true
  git fetch origin main --quiet 2>/dev/null
  if git ls-tree -r origin/main --name-only 2>/dev/null | grep -q '\.md\.enc$'; then
    REMOTE_HAS_ENC=true
  fi
fi

if [ "$REMOTE_HAS_ENC" = true ] && [ -z "$PRX_KB_KEY" ]; then
  echo "KB_MIGRATE_ERROR: The team KB repo uses encryption (.md.enc files detected on origin/main)."
  echo "                  PRX_KB_KEY is not set — your local KB files would be pushed as plain"
  echo "                  Markdown and will NOT be visible to other contributors."
  echo ""
  echo "  ACTION REQUIRED before retrying:"
  echo "  1. Obtain the PRX_KB_KEY passphrase from your team lead."
  echo "  2. Add it to your shell profile (~/.zshrc or ~/.bash_profile):"
  echo "       export PRX_KB_KEY='<passphrase>'"
  echo "  3. Reload your profile:  source ~/.zshrc"
  echo "  4. Re-run this session."
  echo ""
  echo "  Migration aborted. Your local KB files are safe and untouched."
  exit 1
fi

if [ -z "$PRX_KB_KEY" ]; then
  echo "KB_MIGRATE_WARN: PRX_KB_KEY is not set — your KB files will be pushed as plain Markdown."
  if [ "$REMOTE_MAIN_EXISTS" = false ]; then
    echo "                 The remote repo has no content yet. If your team uses PRX_KB_KEY you"
    echo "                 must set the same passphrase before migrating, or your entries will be"
    echo "                 invisible to encrypted contributors. Confirm with your team lead first."
  fi
fi
# ---------------------------------------------------------------------------

# Re-encrypt existing plain .md files if PRX_KB_KEY is set
if [ -n "$PRX_KB_KEY" ]; then
  find tickets shared -name "*.md" 2>/dev/null | while read f; do
    openssl enc -aes-256-cbc -pbkdf2 -in "$f" -out "${f%.md}.md.enc" -pass env:PRX_KB_KEY && rm "$f"
  done
  echo "KB_MIGRATE: existing KB files encrypted."
fi

git add .
git commit -m "kb: migrate solo local KB to distributed"

# If the team repo already has content on main, rebase local commits on top of it
if [ "$REMOTE_MAIN_EXISTS" = true ]; then
  git rebase origin/main 2>/dev/null || (git add . && git rebase --continue 2>/dev/null) || git rebase --skip
  git push origin main && echo "KB_MIGRATE: solo KB merged into team repo at ${PRX_KB_REPO}."
else
  git push --set-upstream origin main && echo "KB_MIGRATE: solo KB pushed as first content of ${PRX_KB_REPO}."
fi
```

**Migration behaviour by scenario:**

| Scenario | Result |
|---|---|
| Remote KB repo is empty (dev is first to push) | Local files committed and pushed as-is; team repo initialised with solo history. Soft warning emitted if `PRX_KB_KEY` is unset. |
| Remote KB repo already has content (joining an existing team) | Local files rebased on top of remote; union merge on `shared/*.md` keeps all entries from both sides |
| `PRX_KB_KEY` is set (encryption enabled) | Each `.md` is re-encrypted to `.md.enc` and the plain file is deleted before committing; repo never receives plaintext |
| Remote has `.md.enc` files but `PRX_KB_KEY` is **not set** | **Migration blocked.** `KB_MIGRATE_ERROR` emitted with step-by-step instructions to obtain and set the team passphrase. Local files are untouched. |
| Remote has plain `.md` files and `PRX_KB_KEY` **is set** | Migration proceeds but `KB_MIGRATE_WARN` notes the inconsistency — the team may not be using encryption; confirm with the team lead |
| Rebase conflict cannot be auto-resolved | `git rebase --skip` discards the conflicting local commit and logs `KB_MIGRATE_WARN`; run `git log ORIG_HEAD..` to recover |

After a successful migration the agent logs:
```
KB_MIGRATE: {N} local KB files migrated to distributed repo {PRX_KB_REPO}.
```
Subsequent sessions treat the directory as a normal distributed clone (the `.git` folder now exists) and follow the standard pull/push path.

**Pull (Step 0a — before session, distributed mode only):**
```bash
KB_CLONE="${PRX_KB_LOCAL_CLONE:-$HOME/.prevoyant/kb}"

if [ -d "$KB_CLONE/.git" ]; then
  # Normal path — already a git repo, just pull latest
  cd "$KB_CLONE" && git pull --rebase origin main && \
    echo "KB: pulled latest from ${PRX_KB_REPO}."

elif [ -d "$KB_CLONE" ] && [ -n "$(ls -A "$KB_CLONE" 2>/dev/null)" ]; then
  # Migration path — local-mode KB files exist but no git repo
  echo "KB_MIGRATE: local KB detected at ${KB_CLONE} — migrating to distributed repo ${PRX_KB_REPO}..."
  cd "$KB_CLONE"
  git init
  git remote add origin "$PRX_KB_REPO"
  cat > .gitattributes << 'EOF'
tickets/*.md              merge=union
shared/*.md               merge=union
core-mental-map/*.md      merge=union
lessons-learned/*.md      merge=union
INDEX.md                  merge=union
EOF
  # --- Encryption consistency check (must run before committing any files) ---
  REMOTE_MAIN_EXISTS=false
  REMOTE_HAS_ENC=false
  if git ls-remote --exit-code origin main >/dev/null 2>&1; then
    REMOTE_MAIN_EXISTS=true
    git fetch origin main --quiet 2>/dev/null
    if git ls-tree -r origin/main --name-only 2>/dev/null | grep -q '\.md\.enc$'; then
      REMOTE_HAS_ENC=true
    fi
  fi
  if [ "$REMOTE_HAS_ENC" = true ] && [ -z "$PRX_KB_KEY" ]; then
    echo "KB_MIGRATE_ERROR: The team KB repo uses encryption (.md.enc files detected on origin/main)."
    echo "                  PRX_KB_KEY is not set — your local KB files would be pushed as plain"
    echo "                  Markdown and will NOT be visible to other contributors."
    echo ""
    echo "  ACTION REQUIRED before retrying:"
    echo "  1. Obtain the PRX_KB_KEY passphrase from your team lead."
    echo "  2. Add it to your shell profile (~/.zshrc or ~/.bash_profile):"
    echo "       export PRX_KB_KEY='<passphrase>'"
    echo "  3. Reload your profile:  source ~/.zshrc"
    echo "  4. Re-run this session — migration will resume automatically."
    echo ""
    echo "  Migration aborted. Your local KB files are safe and untouched."
    exit 1
  fi
  if [ -z "$PRX_KB_KEY" ]; then
    echo "KB_MIGRATE_WARN: PRX_KB_KEY is not set — your KB files will be pushed as plain Markdown."
    if [ "$REMOTE_MAIN_EXISTS" = false ]; then
      echo "                 The remote repo has no content yet. If your team uses PRX_KB_KEY you"
      echo "                 must set the same passphrase before migrating, or your entries will be"
      echo "                 invisible to encrypted contributors. Confirm with your team lead first."
    fi
  fi
  # ---------------------------------------------------------------------------
  # Re-encrypt existing plain .md files if PRX_KB_KEY is set
  if [ -n "$PRX_KB_KEY" ]; then
    find tickets shared -name "*.md" 2>/dev/null | while read f; do
      openssl enc -aes-256-cbc -pbkdf2 -in "$f" -out "${f%.md}.md.enc" -pass env:PRX_KB_KEY && rm "$f"
    done
    echo "KB_MIGRATE: existing KB files encrypted."
  fi
  git add .
  git commit -m "kb: migrate solo local KB to distributed"
  # Merge with remote if main branch already exists
  if [ "$REMOTE_MAIN_EXISTS" = true ]; then
    git rebase origin/main 2>/dev/null || \
      (git add . && git rebase --continue 2>/dev/null) || git rebase --skip
    git push origin main
    echo "KB_MIGRATE: solo KB merged into team repo at ${PRX_KB_REPO}."
  else
    git push --set-upstream origin main
    echo "KB_MIGRATE: solo KB pushed as first content of ${PRX_KB_REPO}."
  fi

else
  # Fresh path — directory empty or does not exist, clone from remote
  git clone "$PRX_KB_REPO" "$KB_CLONE" && \
    echo "KB: cloned ${PRX_KB_REPO} → ${KB_CLONE}."
  mkdir -p "$KB_CLONE/tickets" "$KB_CLONE/shared" "$KB_CLONE/core-mental-map" "$KB_CLONE/lessons-learned" \
           "$KB_CLONE/personas/memory/morgan" "$KB_CLONE/personas/memory/alex" \
           "$KB_CLONE/personas/memory/sam"    "$KB_CLONE/personas/memory/jordan" \
           "$KB_CLONE/personas/memory/henk"   "$KB_CLONE/personas/memory/riley" \
           "$KB_CLONE/personas/memory/bryan"
fi
```

**Push (Steps 13f and R9f — after session, distributed mode only):**
```bash
KB_CLONE="${PRX_KB_LOCAL_CLONE:-$HOME/.prevoyant/kb}"
cd "$KB_CLONE"

# Step 1 — Pull latest from remote before committing (rebase keeps history clean)
# This ensures local commits land on top of any pushes made by other developers
# since the session started, preventing non-fast-forward push failures.
git pull --rebase origin main 2>/dev/null || \
  echo "KB_PULL_WARN: rebase failed — proceeding with local-only commit."

# Step 3 — Verify remote is reachable and the branch exists
if git ls-remote --exit-code origin main >/dev/null 2>&1; then
  REMOTE_EXISTS=true
  echo "KB: remote origin/main verified."
elif git ls-remote --exit-code origin >/dev/null 2>&1; then
  # Remote repo exists but main branch not yet created (first push ever)
  REMOTE_EXISTS=false
  echo "KB: remote repo reachable — main branch does not exist yet, will create."
else
  echo "KB_PUSH_WARN: remote '${PRX_KB_REPO}' is not reachable."
  echo "             Changes committed locally. Push manually: cd ${KB_CLONE} && git push -u origin main"
  exit 0
fi

# Step 4 — Stage and commit
git add .
if git diff --cached --quiet; then
  echo "KB: no changes to push."
  exit 0
fi
git commit -m "kb({TICKET_KEY}): {type} — {one-line summary}"

# Step 5 — Push (create remote branch if this is the first push)
if [ "$REMOTE_EXISTS" = true ]; then
  git push origin main && echo "KB: pushed to ${PRX_KB_REPO}." \
    && printf '%s' "${TICKET_KEY}" > "$HOME/.prevoyant/.kb-updated"
else
  git push --set-upstream origin main && \
    echo "KB: created and pushed origin/main at ${PRX_KB_REPO}." \
    && printf '%s' "${TICKET_KEY}" > "$HOME/.prevoyant/.kb-updated"
fi
```

**If the push fails after the reachability check** (auth error, network drop mid-push): log `KB_PUSH_WARN: push failed — {git error}`. Changes are committed locally; run `cd $KB_CLONE && git push origin main` manually.

**Merge conflicts:** If `git pull` produces a conflict (two developers pushed simultaneously), resolve by preferring the most recent content. Prefer keeping both sets of knowledge — append rather than overwrite shared file entries where possible.

**Remote repo does not exist at all** (the URL itself is invalid or the repo was never created): `git ls-remote` will fail with a fatal error. The agent logs `KB_PUSH_WARN: KB repository '${PRX_KB_REPO}' does not exist or is inaccessible. Create the private repo first, then retry.` and skips the push without failing the session.

## Headless Mode

If `FORCE_FULL_RUN` is set to `Y`, `YES`, or `true` (case-insensitive), execute every step in the workflow in full — do not condense, summarise, or skip any step even if the ticket was analysed in a prior session and results already exist in the KB. Default is `N`. Resolve at session start:

```bash
_ffr=$(echo "${FORCE_FULL_RUN:-N}" | tr '[:lower:]' '[:upper:]')
[ "$_ffr" = "Y" ] || [ "$_ffr" = "YES" ] || [ "$_ffr" = "TRUE" ] && FORCE_FULL_RUN_ON=1 || FORCE_FULL_RUN_ON=0
```

When `FORCE_FULL_RUN_ON=1`: proceed through every numbered step in sequence regardless of prior KB entries, existing reports, or session count. Announce each step header as normal.

---

If `AUTO_MODE` is set to `Y`, `YES`, or `true` (case-insensitive), the skill runs in **headless mode** with no interactive prompts and no blocking gates. Default is `N` (interactive). Resolve at session start:

```bash
_am=$(echo "${AUTO_MODE:-N}" | tr '[:lower:]' '[:upper:]')
[ "$_am" = "Y" ] || [ "$_am" = "YES" ] || [ "$_am" = "TRUE" ] && AUTO_MODE_ON=1 || AUTO_MODE_ON=0
```

When `AUTO_MODE_ON=1`, the skill runs in **analysis-only mode** with no interactive prompts and no side effects:

| Gate | Interactive behaviour | Headless default |
|------|-----------------------|-----------------|
| Step 0 — KB initialisation | Create directory if needed, present Prior Knowledge block | Create directory if needed; present Prior Knowledge block as normal — no interactive element |
| Step 13 — KB update failure | Warn developer if a write fails | Log `KB_WRITE_WARN: {reason}` and continue — do not block session completion |
| Step 13i — Agent personal memory | Write session memory file for each participating agent | Runs automatically; if write fails, log `KB_WRITE_WARN: persona memory — {reason}` and continue |
| Step 13j — Javed pending review | Review and vote on Javed's pending CMM contributions | Skip if `PRX_KBFLOW_ENABLED` is not `Y` or `~/.prevoyant/knowledge-buildup/kbflow-pending.md` has no PENDING APPROVAL entries |
| Step R0 — KB initialisation (Review mode) | Same as Step 0 | Same as Step 0 |
| Step R9 — KB update failure (Review mode) | Same as Step 13 | Same as Step 13 |
| Step 1 — MCP failure | Stop and wait for developer | Print `HEADLESS_ERROR: {reason}` and exit immediately |
| Step 4a — Base branch unconfirmed | Ask developer which branch to use | Default to `development`; note the fallback in output |
| Step 4c — Branch creation | Run `git checkout -b …` | **Default: skip** — report the branch name that would be created, run no git commands. **Override:** if `PRX_APPLY_CHANGES=Y` (set per-ticket from the dashboard's *Add Ticket → Apply code changes* checkbox), run `git checkout -b …` as in interactive mode. |
| Step 5 — Low file-map confidence | Stop and ask developer | Proceed with `⚠️ LOW CONFIDENCE — manual review required` |
| Step 6e — Low replication confidence | Stop and ask developer | Proceed with `⚠️ LOW CONFIDENCE — assumptions noted` |
| Step 7b — Morgan briefing *(Bug only)* | Morgan opens session and briefs team | Morgan briefing runs as normal; no developer input required |
| Step 7d — Mid-point check-in *(Bug only)* | Engineers and Riley report progress to Morgan | All four submit status; Morgan responds automatically |
| Step 7f — Riley's questions + Morgan cross-examination *(Bug only)* | Riley poses open question; Morgan cross-examines | All questions and responses generated automatically; no developer input required |
| Step 7g — Team debate *(Bug only)* | Open floor for one challenge round | Debate runs automatically; if no challenges, state "No challenges" and proceed |
| Step 7h — Morgan verdict *(Bug only)* | Morgan scores and declares adopted root cause | Verdict runs automatically; proceed with highest-scoring hypothesis |
| Step 7h-ii — Henk's check-in *(Bug only)* | Morgan consults Henk on business necessity and client value | Henk's check-in runs automatically; if Henk returns ⚠️ QUESTION or ❌ CHALLENGE, Morgan's response is recorded in the Root Cause Statement team note |
| Step 8c — Morgan fix review | Morgan vets the proposed fix | Review runs automatically; if REWORK REQUIRED, revise once and re-run; if still failing, proceed with `⚠️ UNRESOLVED — developer review required` |
| Step 8d — Apply fix prompt | Ask yes / no / partial | **Default: no** — propose the fix only; do not call Edit or modify any files. **Override:** if `PRX_APPLY_CHANGES=Y`, treat as **yes** — call Edit on the affected files, then stage + commit on the feature branch created at Step 4c (`git add` + `git commit -m "{TICKET_KEY}: {one-line summary}"`). Skipped only if Step 4c also skipped (no branch). |
| Step 12e — Email report | Send report to `PRX_EMAIL_TO` if set | **Always runs** — email is sent automatically whenever `PRX_EMAIL_TO` is configured; no interactive element |

In headless mode, Steps 1–10 run and produce full output with all interactive gates bypassed using safe defaults. Steps 11 and 12 (session stats + PDF report) run as normal so the PDF is saved to disk. Email (Step 12e) fires automatically if `PRX_EMAIL_TO` is set.

---

## Mode Selection

This skill operates in three modes. Detect the mode from the invocation:

| Mode | Trigger phrases | What runs |
|------|----------------|-----------|
| **Dev Mode** | `IV-XXXX`, `start dev on IV-XXXX`, `pick up IV-XXXX`, `/dev IV-XXXX` | **Step 0** (KB query) → Steps 1–12 (full dev workflow → proposed fix → PDF) → **Step 13** (KB update) |
| **PR Review Mode** | `review IV-XXXX`, `PR review IV-XXXX`, `code review IV-XXXX`, `/dev review IV-XXXX` | **Step R0** (KB query) → Steps R1–R8 (code diff review → PDF) → **Step R9** (KB update) |
| **Estimate Mode** | `estimate IV-XXXX`, `size IV-XXXX`, `point IV-XXXX`, `/dev estimate IV-XXXX` | **Step E0** (KB query) → Steps E1–E7 (planning poker → consensus → Jira update → KB update) |
| **Watch Mode** | `watch IV-XXXX`, `/prx:dev watch IV-XXXX` | **Step W0** (KB query) → **Step W1** (fetch ticket + all comments) → **Step W2** (progress analysis) → **Step W3** (digest output) |

**→ Check for trigger words in order: `estimate`/`size`/`point` → Estimate Mode. `review` → PR Review Mode. `watch` → Watch Mode. Otherwise → Dev Mode.**

---

## When to Use This Skill

Invoke when the developer provides:
- A Jira ticket URL: `https://yourcompany.atlassian.net/browse/PROJ-1234`
- A Jira ticket key: `PROJ-1234`
- A phrase like `/prevoyant:dev PROJ-1234` or `/dev PROJ-1234` or "start dev on PROJ-1234" or "pick up PROJ-1234"
- A phrase like `review PROJ-1234` or `PR review PROJ-1234` or `/dev review PROJ-1234` for code review
- A phrase like `estimate PROJ-1234` or `size PROJ-1234` or `/dev estimate PROJ-1234` for effort estimation

Do NOT invoke for general code questions unrelated to a Jira ticket.

## Workflow Steps

Execute all steps **in order**. Do not skip steps. Present output to the developer as you complete each one.

**Output verbosity** — resolve once at session start:
```bash
PRX_REPORT_VERBOSITY="${PRX_REPORT_VERBOSITY:-full}"
```
Apply throughout:
- `full` — every structured block, all panel dialogue, verbatim debate rounds (default)
- `compact` — all structured blocks intact (Root Cause Statement, Enhancement Statement, Fix, Morgan's verdicts, Riley's assessment); panel narrative (mid-point check-ins, debate, Morgan's briefing prose) condensed to bullet summaries. **The PDF always receives full content regardless of this setting.**
- `minimal` — structured blocks only; no panel narrative, no debate round, no check-in dialogue

---

### Step 0 — Knowledge Base: Sync, Initialise & Query

This step runs in two phases. **Phase A** (sync + initialise) runs before Step 1. **Phase B** (query) runs after Step 1 once ticket metadata is available.

#### 0 — Server Pre-load Gate

Before running any Phase A disk operations, check whether the server has already pre-loaded KB content into this prompt:

1. Look for `<!-- KB_PRELOADED schemaVersion=X.Y -->` near the top of this message.
2. If found, read `plugin/config/kb-schema.json` and get its `schemaVersion` field.
3. **Versions match → pre-load is valid:**
   - Output: `KB_STATUS: server pre-loaded (v{version}) — skipping Steps 0a and 0b disk reads.`
   - Skip Steps 0a and 0b entirely.
   - The **"Knowledge Base — Pre-loaded Context"** block at the top of this message contains INDEX.md, all shared files, Core Mental Map, Lessons Learned, and an Agent Memory block (relevance-scored indexed table — top learnings/surprises from all past sessions, ranked by component and label overlap with this ticket).
   - Use that content to run the Step 0b query logic (room matching, trigger scanning, building the Prior Knowledge block) without any additional file reads.
   - Present the Prior Knowledge block before Step 2, then proceed to Step 1.
4. **Sentinel absent or version mismatch → graceful fallback:**
   - Output: `KB_STATUS: fallback to standard load (pre-load unavailable or schema updated — re-reading from disk).`
   - Proceed with Steps 0a and 0b normally below.

---

#### 0a. Sync & Initialise

##### If `KB_MODE=local` (default):

**Step 1 — Initialise directories (no git sync):**
```bash
mkdir -p "$KNOWLEDGE_DIR/tickets" "$KNOWLEDGE_DIR/shared" "$KNOWLEDGE_DIR/core-mental-map" "$KNOWLEDGE_DIR/lessons-learned" \
         "$KNOWLEDGE_DIR/personas/memory/morgan" "$KNOWLEDGE_DIR/personas/memory/alex" \
         "$KNOWLEDGE_DIR/personas/memory/sam"    "$KNOWLEDGE_DIR/personas/memory/jordan" \
         "$KNOWLEDGE_DIR/personas/memory/henk"   "$KNOWLEDGE_DIR/personas/memory/riley" \
         "$KNOWLEDGE_DIR/personas/memory/bryan"
```
Set `KB_WORK_DIR="$KNOWLEDGE_DIR"`. No git operations.

**Step 2 — Create skeleton files if this is a first run:** _(see common steps below)_

**Step 3 — Report status:** _(see common steps below)_

---

##### If `KB_MODE=distributed`:

**Step 1 — Verify `PRX_KB_REPO` is set:**
```bash
if [ -z "$PRX_KB_REPO" ]; then
  echo "KB_ERROR: PRX_KB_REPO is not set."
  echo "         Set it to your team's private KB repository URL in your shell profile."
  echo "         Continuing without knowledge base."
fi
```
If not set, skip all remaining distributed steps and proceed without prior knowledge. Warn the developer prominently.

**Step 2 — Pull from the private KB repository:**

Use the pull command from the **Git Sync Rules** section above. If the local clone does not exist, clone the repo first.

```bash
KB_CLONE="${PRX_KB_LOCAL_CLONE:-$HOME/.prevoyant/kb}"
if [ -d "$KB_CLONE/.git" ]; then
  cd "$KB_CLONE" && git pull origin main && \
    echo "KB: pulled latest from ${PRX_KB_REPO}."
else
  git clone "$PRX_KB_REPO" "$KB_CLONE" && \
    echo "KB: cloned ${PRX_KB_REPO} → ${KB_CLONE}."
  mkdir -p "$KB_CLONE/tickets" "$KB_CLONE/shared" "$KB_CLONE/core-mental-map" "$KB_CLONE/lessons-learned" \
           "$KB_CLONE/personas/memory/morgan" "$KB_CLONE/personas/memory/alex" \
           "$KB_CLONE/personas/memory/sam"    "$KB_CLONE/personas/memory/jordan" \
           "$KB_CLONE/personas/memory/henk"   "$KB_CLONE/personas/memory/riley" \
           "$KB_CLONE/personas/memory/bryan"
fi
```

**Step 3 — Set `KB_WORK_DIR`:**

- If `PRX_KB_KEY` is **not set**: `KB_WORK_DIR="$KNOWLEDGE_DIR"` — operate directly on the local clone (plain Markdown).
- If `PRX_KB_KEY` **is set** (encryption enabled): clean up any prior session temp dirs, then decrypt:

```bash
# Clean prior temp dirs
rm -rf /tmp/prevoyant-kb-[0-9]* 2>/dev/null

# Decrypt to session temp dir
KB_WORK_DIR="/tmp/prevoyant-kb-$$"
mkdir -p "$KB_WORK_DIR/tickets" "$KB_WORK_DIR/shared" "$KB_WORK_DIR/core-mental-map" "$KB_WORK_DIR/lessons-learned" \
         "$KB_WORK_DIR/personas/memory/morgan" "$KB_WORK_DIR/personas/memory/alex" \
         "$KB_WORK_DIR/personas/memory/sam"    "$KB_WORK_DIR/personas/memory/jordan" \
         "$KB_WORK_DIR/personas/memory/henk"   "$KB_WORK_DIR/personas/memory/riley" \
         "$KB_WORK_DIR/personas/memory/bryan"
find "$KNOWLEDGE_DIR" -name "*.md.enc" | while read f; do
  rel="${f#$KNOWLEDGE_DIR/}"
  out="$KB_WORK_DIR/${rel%.enc}"
  mkdir -p "$(dirname "$out")"
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 310000 -md sha512 \
    -in "$f" -out "$out" -pass env:PRX_KB_KEY 2>/dev/null || \
    echo "KB_DECRYPT_WARN: ${rel} — skipping (wrong key or corrupted)"
done
enc_count=$(find "$KNOWLEDGE_DIR" -name "*.md.enc" 2>/dev/null | wc -l | tr -d ' ')
echo "KB: decrypted ${enc_count} encrypted files → ${KB_WORK_DIR}/"
```

**Step 4 — Create skeleton files if this is a first run:** _(see common steps below)_

**Step 5 — Report status:** _(see common steps below)_

---

##### Common steps (both modes — operate on `KB_WORK_DIR`):

**Create persona memory directories (always — no-op if they already exist):**

```bash
mkdir -p "$KB_WORK_DIR/personas/memory/morgan"  \
         "$KB_WORK_DIR/personas/memory/alex"    \
         "$KB_WORK_DIR/personas/memory/sam"     \
         "$KB_WORK_DIR/personas/memory/jordan"  \
         "$KB_WORK_DIR/personas/memory/henk"    \
         "$KB_WORK_DIR/personas/memory/riley"   \
         "$KB_WORK_DIR/personas/memory/bryan"
```

**Create skeleton files if this is a first run:**

If `INDEX.md` does not exist, create:
```markdown
# Dev Knowledge Base
Updated: {today} | Rooms: 6 | Triggers: 0 | Ticket entries: 0 | Shared entries: 0

## Memory Palace

### 🏠 CASE ROOM  (CaseManager, FRAMS, Cases)
| Trigger | KB Entry | Type | File |
|---------|----------|------|------|

### 🚨 ALERT ROOM  (AlertCentral, FRAMS, Alerts)
| Trigger | KB Entry | Type | File |
|---------|----------|------|------|

### 🖥️ FRONT ROOM  (GWT Frontend, fcfrontend)
| Trigger | KB Entry | Type | File |
|---------|----------|------|------|

### 🔧 ENGINE ROOM  (Backend API, fcbackend)
| Trigger | KB Entry | Type | File |
|---------|----------|------|------|

### ⚙️ WORKER ROOM  (Plugin, Workers, fcplugin)
| Trigger | KB Entry | Type | File |
|---------|----------|------|------|

### 🗄️ VAULT  (Database, fcbuild/scripts)
| Trigger | KB Entry | Type | File |
|---------|----------|------|------|

## Master Index

### Ticket Entries
| Ticket | Date | Type | Components | Labels | Summary | File |
|--------|------|------|------------|--------|---------|------|

### Shared Knowledge Entries
| KB-ID | Domain | Date | Type | Trigger | File | Section |
|-------|--------|------|------|---------|------|---------|
```

If any `shared/*.md` file does not exist, create it with a title-only header.

If `core-mental-map/INDEX.md` does not exist, create it:
```markdown
# Core Mental Map
Updated: {today} | Files: 5 | Total entries: 0

| File | Entries | Updated | Summary |
|------|---------|---------|---------|
| architecture.md | 0 | {today} | — |
| business-logic.md | 0 | {today} | — |
| data-flows.md | 0 | {today} | — |
| tech-stack.md | 0 | {today} | — |
| gotchas.md | 0 | {today} | — |
```

If any `core-mental-map/*.md` content file does not exist, create it with a title-only header (e.g. `# Architecture`). The files will be populated as agents contribute entries during sessions.

The `lessons-learned/` directory requires no skeleton files — developer files are created on first write (Step 13h). No action needed on init if the directory is empty.

If `shared/process-efficiency.md` does not exist, create it:
```markdown
# Process Efficiency Log
<!-- AUTO-GENERATED — rebuilt after every pull. Never edit this header manually. -->
Sessions tracked: 0 | Changes pushed: 0 | Sessions since last push: 0 | Next compaction: session {PRX_SKILL_COMPACTION_INTERVAL}

<!-- AUTO-GENERATED VELOCITY DASHBOARD — rebuilt after every pull -->
## Velocity Dashboard
| Metric | Value | Trend |
|--------|-------|-------|
| Monthly spend (current month) | $— of $— | — |
| Monthly budget status | — | — |
| Avg cost — last 5 sessions | $— | — |
| Token hotspot | — | — |
| Change acceptance rate | — | — |

<!-- ═══════════════════════════════════════════════════════════════════
     APPEND-ONLY JOURNAL — never edit existing lines; only append new
     ones. Bryan rebuilds the header and dashboard from these entries
     after every pull, the same way INDEX.md is rebuilt.
     ═══════════════════════════════════════════════════════════════════ -->
```

If `shared/skill-changelog.md` does not exist, create it:
```markdown
# SKILL.md Change Log
<!-- append-only — Bryan appends one [SC-NNN] block per approved and pushed change -->
<!-- Cross-reference: each entry links to the git commit so any change can be reverted with `git revert <commit>` -->
```

> **Merge safety:** `skill-changelog.md` is append-only — entries are never edited, only new blocks and status tags appended. `shared/*.md merge=union` in `.gitattributes` ensures lossless merges from concurrent pushes.

> **Merge safety:** `process-efficiency.md` uses an **append-only journal** below the auto-generated header. All raw data (sessions, backlog items, blockers) is expressed as new appended lines, never edits to existing lines. The header and Velocity Dashboard are rebuilt from the journal after every pull — exactly as `INDEX.md` is rebuilt. This makes `merge=union` correct and lossless for all concurrent pushes.

**Re-index after pull (distributed mode) or on every init (local mode):**

After a pull, other developers may have pushed ticket or shared files that are not yet referenced in the local INDEX.md. Scan the actual files on disk and reconcile any missing entries — do **not** rebuild from scratch; only add what is absent.

```bash
# Step 1 — Find ticket files not yet in INDEX.md
for f in "$KB_WORK_DIR"/tickets/*.md; do
  [ -f "$f" ] || continue
  key=$(basename "$f" .md)                          # e.g. IV-3801
  grep -q "$key" "$KB_WORK_DIR/INDEX.md" && continue  # already indexed

  # Read frontmatter fields from the file
  trigger=$(grep "^trigger:" "$f" | head -1 | sed 's/^trigger: *//')
  rooms=$(grep   "^rooms:"   "$f" | head -1 | sed 's/^rooms: *//')
  type=$(grep    "^type:"    "$f" | head -1 | sed 's/^type: *//')
  date=$(grep    "^date:"    "$f" | head -1 | sed 's/^date: *//')
  components=$(grep "^components:" "$f" | head -1 | sed 's/^components: *//')
  labels=$(grep  "^labels:"  "$f" | head -1 | sed 's/^labels: *//')
  summary=$(grep "^summary:" "$f" | head -1 | sed 's/^summary: *//')

  # Add row to Master Index section of INDEX.md
  echo "| $key | $date | $type | $components | $labels | $summary | tickets/${key}.md |" \
    >> "$KB_WORK_DIR/INDEX.md"
  echo "KB_REINDEX: added $key to INDEX.md (Master Index)"

  # Add trigger to Memory Palace section of INDEX.md for each room listed in frontmatter
  echo "KB_REINDEX: trigger '${trigger}' for rooms '${rooms}' — add to INDEX.md (Memory Palace)"
done

# Step 2 — Find shared entries not yet in INDEX.md
for f in "$KB_WORK_DIR"/shared/*.md; do
  [ -f "$f" ] || continue
  fname=$(basename "$f")
  # Scan for ## ENTRY-NNN headings
  grep -oE "^## [A-Z]+-[0-9]+" "$f" | while read heading; do
    id="${heading## }"                               # e.g. BIZ-001
    grep -q "$id" "$KB_WORK_DIR/INDEX.md" && continue
    trigger=$(grep -A1 "^## ${id}" "$f" | tail -1 | grep -oP '"[^"]+"' | head -1)
    echo "KB_REINDEX: shared entry $id not in INDEX.md — add row to Master Index for shared/$fname"
  done
done
```

After the re-index scan, update the `Updated:` date and all counts in the INDEX.md header to reflect the current state.

> **Why re-index on every pull?** INDEX.md is derived data — it indexes what is in the `tickets/` and `shared/` directories. When a developer pushes their KB files, git merges the raw content files, but INDEX.md may reflect a different state. The re-index step makes the local derived file consistent with whatever files are actually present on disk after the pull, without overwriting anyone's entries.

**Report status:**

```
KB: {KNOWLEDGE_DIR}
    Ticket entries : {N}  ({M} re-indexed from disk after pull)
    Shared entries : {P}  ({Q} re-indexed from disk after pull)
    Palace triggers: {R}
    Last updated   : {date from INDEX.md header or "new"}
    Index file     : INDEX.md (Memory Palace + Master Index)
```

**Lightweight KB integrity sweep** — immediately after the status block above, run a quick background pass over `shared/*.md` and `core-mental-map/*.md` to flag entries with `file:line` references that have drifted. Budget: ≤ 5 targeted operations — do not read whole files.

**Preferred path (graphify — symbol-level validation):** if `graph.json` exists at `{REPO_DIR}/` and `graphify` is on PATH, validate each `ref:` against the live symbol graph. This catches three cases the file-existence check below misses entirely: method renamed in place, method moved to another file, line number shifted.

```bash
if [ -f "$REPO_DIR/graph.json" ] && command -v graphify &>/dev/null; then
  grep -rh "ref:" "$KB_WORK_DIR/shared/" "$KB_WORK_DIR/core-mental-map/" 2>/dev/null \
    | grep -oE '[a-zA-Z/._-]+\.(java|py|js|ts|sql|xml):[0-9]+' | sort -u \
    | while read ref; do
        file="${ref%:*}"; line="${ref##*:}"
        # Ask the graph: is there a node at file:line (or within ±5 lines)?
        # graphify returns the node label + new line if it moved, or empty if deleted.
        hit=$(graphify query "node at $file:$line" --graph "$REPO_DIR/graph.json" 2>/dev/null)
        if   [ -z "$hit" ];                                  then echo "STALE_REF: $ref (symbol absent from graph — flag DELETED)"
        elif echo "$hit" | grep -q "line: $line"; then        :  # VALID — no-op
        else                                                       echo "RELOCATED_REF: $ref → $(echo "$hit" | grep -oE 'line: [0-9]+')"
        fi
      done
else
  # Fallback (no graph): file-existence check only — coarse but cheap.
  grep -rh "ref:" "$KB_WORK_DIR/shared/" "$KB_WORK_DIR/core-mental-map/" 2>/dev/null \
    | grep -oP '[a-zA-Z/._-]+\.(java|py|js|ts|sql|xml)' | sort -u | while read f; do
    [ ! -f "$REPO_DIR/$f" ] && echo "STALE_REF: $f"
  done
fi
```

`STALE_REF` and `RELOCATED_REF` lines are held in memory for the session. STALE entries auto-heal at Step 13c (shared) / Step 13g (CMM) with the `[DELETED]` marker; RELOCATED entries are rewritten with the new file:line and the `[RELOCATED]` marker. Do not interrupt Step 0 for this — note `{N} stale + {M} relocated refs flagged for auto-heal` and continue.

**KB coverage audit (graph-aware — runs only if `GRAPH_REPORT.md` exists at `{REPO_DIR}/`):**

graphify's `GRAPH_REPORT.md` lists (a) the codebase's most-connected symbols ("god nodes") and (b) cross-module connections ranked by unexpectedness. Both are high-value seeds for KB entries that don't yet exist. Compute the coverage delta and stage the gaps as proposals for Sam to triage at Step 13j.

Budget: ≤ 4 ops — read `GRAPH_REPORT.md` once, grep `INDEX.md` once per candidate batch, append to `kbflow-pending.md` once.

```bash
GRAPH_REPORT="$REPO_DIR/GRAPH_REPORT.md"
KBFLOW_PENDING="$HOME/.prevoyant/knowledge-buildup/kbflow-pending.md"

if [ -f "$GRAPH_REPORT" ]; then
  mkdir -p "$(dirname "$KBFLOW_PENDING")"
  today="$(date +%Y-%m-%d)"

  # (a) God nodes — most-connected symbols. Any god node not mentioned in INDEX.md is a coverage hole.
  awk '/^## God Nodes/,/^## /' "$GRAPH_REPORT" | grep -oE '`[A-Za-z_][A-Za-z0-9_]+`' \
    | tr -d '`' | sort -u | while read sym; do
      grep -qi "$sym" "$KB_WORK_DIR/INDEX.md" && continue
      printf '\n## CANDIDATE-COVERAGE-%s\nStatus: PENDING APPROVAL\nDate: %s\nSource: graphify god-node\nSymbol: %s\nProposal: New KB entry — frequently-coupled symbol with no current coverage.\n' \
        "$sym" "$today" "$sym" >> "$KBFLOW_PENDING"
    done

  # (b) Surprising connections — cross-module edges ranked by unexpectedness.
  # Read the top-5 of the "Surprising Connections" section and stage each as a discovery candidate.
  awk '/^## Surprising Connections/,/^## /' "$GRAPH_REPORT" | head -20 \
    | grep -oE '`[^`]+`[[:space:]]*↔[[:space:]]*`[^`]+`' | head -5 | while read edge; do
      # Hash-ish dedup key — append only if this edge isn't already in kbflow-pending.md
      grep -qF "$edge" "$KBFLOW_PENDING" 2>/dev/null && continue
      printf '\n## CANDIDATE-CONNECTION\nStatus: PENDING APPROVAL\nDate: %s\nSource: graphify surprising-connection\nEdge: %s\nProposal: Investigate whether this cross-module coupling deserves an architecture or risk entry.\n' \
        "$today" "$edge" >> "$KBFLOW_PENDING"
    done
fi
```

Emit: `KB coverage audit: {N} god-node gaps + {M} surprising-connection candidates staged for Sam (Step 13j).` These count as `PENDING APPROVAL` and are picked up by the standing-agenda check below — so any coverage gap surfaced here forces Step 13j review before the session closes.

**Pending KB contributions check (standing agenda item):**

If `PRX_KBFLOW_ENABLED` is `Y`/`YES`/`true`, check for pending Javed contributions now — before the session begins work, not after:

```bash
grep -c "^Status: PENDING APPROVAL" ~/.prevoyant/knowledge-buildup/kbflow-pending.md 2>/dev/null || echo 0
```

If the count is **0**: state `✓ No pending Javed contributions.` and continue.

If the count is **> 0**: display prominently:

```
⚠️  {N} pending KB contributions from Javed await team review (Step 13j).
    Oldest proposal: {date from the earliest PENDING entry, or "unknown"}.
    These must be reviewed at Step 13j before this session closes.
    Do not skip Step 13j — proposals do not enter the KB without a panel vote.
```

This is a **standing agenda item, not optional**. Surface it at session start so the team commits to reviewing it before closing — not as a surprise at Step 13.

#### 0b. Query (runs after Step 1 — ticket metadata available)

Once Step 1 has returned the ticket's **components** and **labels**, query in layered passes — **Cortex first, then KB**.

**Layer 0 — Cortex Pass (runs first, ~600–2000 tokens total, optional):**

Cortex is the **always-on intelligence layer** synthesised from the KB by the cortex worker (`server/workers/cortexWorker.js`). When enabled and fresh, it replaces the broad orientation reads of Layers 1b/2/3 for the topics it covers — saving roughly 50–70% of Step 0's tokens. Cortex is **never the source of truth** — for ticket-specific or anchor-level lookups (e.g. "what did we decide about IV-3641?") the KB layers still run.

```bash
# 1) Resolve the cortex location. Two modes:
#    A) PRX_CORTEX_DISTRIBUTED=Y — cortex lives in <KB>/cortex/ and rides
#       along with the KB sync (git push or Upstash distributed mode), so a
#       fresh teammate's first session sees the team's accumulated intelligence
#       layer without any local synthesis.
#    B) Otherwise — cortex lives in ~/.prevoyant/cortex/ (per-machine).
#
# We probe the distributed location first (more authoritative when present),
# then fall back to the local one.  Both have identical layouts.
KB_DIR="${PRX_KNOWLEDGE_DIR:-$HOME/.prevoyant/knowledge-base}"
[ "${PRX_KB_MODE:-local}" = "distributed" ] && KB_DIR="${PRX_KB_LOCAL_CLONE:-$HOME/.prevoyant/kb}"

CORTEX_DIR=""
for cand in "$KB_DIR/cortex" "$HOME/.prevoyant/cortex"; do
  if [ -f "$cand/state.json" ]; then CORTEX_DIR="$cand"; break; fi
done

CORTEX_FRESH=0
if [ -n "$CORTEX_DIR" ]; then
  # Accept cortex if lastSynthesis is within 24h.
  LAST=$(grep -o '"lastSynthesis"[^,}]*' "$CORTEX_DIR/state.json" | grep -o '[0-9]\+' | head -1)
  NOW=$(date +%s%3N 2>/dev/null || date +%s000)
  if [ -n "$LAST" ] && [ $((NOW - LAST)) -lt 86400000 ]; then
    CORTEX_FRESH=1
  fi
fi

# 2) Read the curated fact files when fresh. Each is small (~200–800 tokens).
HITS=""
MISS_COUNT=0
if [ "$CORTEX_FRESH" = "1" ]; then
  echo "[CORTEX SOURCE] $CORTEX_DIR (distributed=${CORTEX_DIR#$KB_DIR/cortex})"
  for f in architecture.md business-rules.md patterns.md decisions.md hotspots.md glossary.md; do
    if [ -f "$CORTEX_DIR/facts/$f" ]; then
      echo "[CORTEX HIT] facts/$f"
      HITS="${HITS:+$HITS,}$f"
    else
      echo "[CORTEX MISS] facts/$f"
      MISS_COUNT=$((MISS_COUNT + 1))
    fi
  done
else
  echo "[CORTEX MISS] state stale or absent — falling back to full KB walk"
  MISS_COUNT=6
fi

# 3) Export the resolved location so later mid-session steps (Step 5 hotspot
#    lookup, Step 7b-0 pattern grep, Step 7 architecture refresh) can consult
#    cortex on-demand without re-resolving the path or re-checking freshness.
#    Empty string = cortex unavailable; later steps must fall back to KB.
export PRX_CORTEX_RESOLVED_DIR="${CORTEX_FRESH:-0}"
[ "$CORTEX_FRESH" = "1" ] && export PRX_CORTEX_RESOLVED_DIR="$CORTEX_DIR" || export PRX_CORTEX_RESOLVED_DIR=""
```

If `[CORTEX HIT]` was emitted for a file, that file's content **replaces** the corresponding KB reads in Layers 1b–3 (mapping below). Carry the cortex content into the Prior Knowledge block under a `CORTEX` heading so the panel knows where it came from. If `[CORTEX MISS]` for any reason (state stale, file absent, or `PRX_CORTEX_ENABLED=N`), fall through to the original KB walk — cortex never blocks the workflow.

**Cortex → KB coverage map** (so Layers 1b–3 know what to skip):

| Cortex fact file | Replaces these KB reads when HIT |
|------------------|----------------------------------|
| `facts/architecture.md`   | `core-mental-map/architecture.md`, `shared/architecture.md` |
| `facts/business-rules.md` | `shared/business-rules.md` |
| `facts/patterns.md`       | `shared/patterns.md` (still required by Jordan — cortex satisfies it) |
| `facts/decisions.md`      | `shared/decisions.md` (CONFIRMED-only — for under-review decisions still read raw) |
| `facts/hotspots.md`       | _(cortex-only — no KB equivalent; feeds Riley's Step 7-pre signal)_ |
| `facts/glossary.md`       | _(cortex-only — fast term lookup)_ |

**What Layer 0 does NOT replace:** ticket-specific reads (`tickets/{KEY}.md`), per-ticket lessons-learned, Memory Palace trigger scans, or any anchor-style `file:line` lookup. Cortex is breadth-of-orientation; the KB remains depth-of-lookup.

Emit a single roll-up after Layer 0 so the savings are measurable:
```
Cortex orientation: {N} HIT, {M} MISS — Layers 1b/3 narrowed to {K} files
                   (estimated savings vs full walk: ~{P}% Step 0 tokens)
```

**Telemetry (fire-and-forget):** after Layer 0 completes, ping the dashboard so the activity log can record *when* and *which machine* referenced cortex. This is what the developer sees on `/dashboard/activity` as `cortex_referenced` (actor `claude`) — answers "did the agent actually use cortex on session X?" without any extra UI hookups. Best-effort and silent on failure; never blocks the step.

```bash
HITS_JSON=$(printf '%s' "${HITS:-}" | jq -Rcs 'split(",") | map(select(length>0))' 2>/dev/null || echo '[]')
MACHINE=$(hostname 2>/dev/null || echo unknown)
SERVER="http://localhost:${PRX_SERVER_PORT:-3000}"

curl -s -m 2 -X POST "$SERVER/dashboard/cortex/referenced" \
  -H "Content-Type: application/json" \
  -d "{\"ticketKey\":\"${TICKET_KEY}\",\"hits\":${HITS_JSON},\"missCount\":${MISS_COUNT:-0},\"machine\":\"${MACHINE}\",\"estSavingsPct\":${EST_PCT:-0},\"step\":\"0a\"}" \
  >/dev/null 2>&1 &
```

(Where `HITS` is a comma-separated list of `[CORTEX HIT]` filenames from the read pass, and `MISS_COUNT`/`EST_PCT` come from the roll-up line above. `jq` is optional — if missing, emit `[]` for `hits` and the dashboard still records the hit count.)

If `PRX_CORTEX_ENABLED=N` or the cortex directory does not exist, skip Layer 0 silently and continue with Layer 1.

**Layer 1 — Memory Palace (primary, fast path — ALWAYS runs, even on CORTEX HIT):**

Execute the Memory Palace retrieval procedure (see **"How Agents Use the Palace"** in the KB Architecture section): map ticket components/labels to rooms → scan triggers → read matched entries. Always ≤ 3 read operations.

**Layer 1b — Semantic Relevance Pre-Score (runs before Layers 2–4):**

**If Layer 0 emitted `[CORTEX HIT]` for a file's cortex equivalent (see coverage map above), exclude that KB file from the score table entirely — the cortex copy already covers it.** Skip directly to ticket-specific scoring for the remaining KB files.

Before loading any `shared/*.md` or `core-mental-map/*.md` file, perform a lightweight relevance pass against the ticket's components, labels, and a 10-keyword digest of the ticket description (extract the 10 highest-signal non-stop-words from the summary + description). Score every KB file in the index without reading its full content:

```
Relevance score per file = (component keyword hits × 3) + (label keyword hits × 2) + (description keyword hits × 1)
```

Produce a score table (internal — do not display, only use to gate reads):

| File | Component hits | Label hits | Desc hits | Score | Load? |
|------|---------------|------------|-----------|-------|-------|
| `shared/business-rules.md` | 2 | 1 | 3 | 11 | ✅ |
| `shared/patterns.md` | 0 | 0 | 1 | 1 | ❌ |
| `core-mental-map/architecture.md` | 3 | 2 | 4 | 17 | ✅ |

**Load threshold:** Score ≥ 3 → read the file. Score < 3 → skip entirely (note as `skipped (low relevance)` in the Prior Knowledge block header). Apply to `shared/*.md` (except `process-efficiency.md` and `skill-changelog.md` — never load these) and `core-mental-map/*.md`. `shared/patterns.md` is always loaded regardless of score (Jordan needs it) — **unless cortex `facts/patterns.md` was a HIT, in which case the cortex copy satisfies Jordan's requirement**.

Emit: `KB relevance pre-score: {N} files scored, {M} loaded, {P} skipped — saving ~{Q}% context.`

**Layer 2 — Master Index fallback (if Palace yields no matches):**

```bash
grep -i "{COMPONENT}" "$KNOWLEDGE_DIR/INDEX.md"
grep -i "{LABEL}"     "$KNOWLEDGE_DIR/INDEX.md"
grep -i "{TICKET_KEY}" "$KNOWLEDGE_DIR/INDEX.md"
```

Read the 5 most recent matching ticket entries and all matching shared entries.

**Layer 3 — Core Mental Map (relevance-gated by Layer 1b score; **further** narrowed by Layer 0 cortex hits):**

Read `core-mental-map/INDEX.md` to see available topics and entry counts. Then:

1. **If Layer 0 emitted `[CORTEX HIT]` for `facts/architecture.md`, skip `core-mental-map/architecture.md` entirely** — the cortex copy already covered it. Note `skipped (cortex hit)` in the Prior Knowledge block header.
2. For each *remaining* `core-mental-map/*.md` content file whose Layer 1b score is ≥ 3, read the full file. Skip files scoring < 3 (note `skipped (low relevance, score={N})`). (Files are small — compressed format; full reads are acceptable for qualifying files.)
3. Carry all relevant CMM entries into the Prior Knowledge block under `CORE MENTAL MAP`.
4. Increment the `confirmed:` counter for each CMM entry read — write the counter update to the file immediately (in-place sed or targeted edit) so other agents see fresh confirmation counts. If the file has not changed since last session, skip the counter update to avoid unnecessary writes. **Cortex-satisfied files still get their counter incremented (read from cortex still counts as a confirmation).**

If `core-mental-map/INDEX.md` does not exist or all files show `0` entries: state `Core Mental Map: empty — will populate in Step 13g.`

**Layer 4 — Lessons Learned (always runs):**

Read all `lessons-learned/*.md` files. For each entry whose `PITFALL:` or `KEY:` text overlaps with the current ticket's components, labels, or affected area, carry it into the Prior Knowledge block under `LESSONS LEARNED`. Show the author and date so the agent knows the source. If the directory is empty or no files exist: state `Lessons Learned: none recorded yet.`

**Layer 5 — Agent Personas & Personal Memory (always runs):**

Each agent reads their own persona definition and personal memory before engaging in the session. This grounds each agent in their character, reasoning style, and the accumulated experience of past sessions.

**5a. Read persona definitions** from the plugin directory:

```
plugin/config/personas/morgan.md
plugin/config/personas/alex.md
plugin/config/personas/sam.md
plugin/config/personas/jordan.md
plugin/config/personas/henk.md
plugin/config/personas/riley.md
plugin/config/personas/bryan.md
```

If the plugin directory is not accessible, agents fall back to the inline persona descriptions in the Engineering Panel section of SKILL.md — session proceeds normally.

**5b. Read personal memory** for each agent.

**When the server is active (KB_PRELOADED present):** agent memory is already pre-loaded as a relevance-scored indexed table — Layer 5b is skipped entirely. The pre-loaded Agent Memory block contains the top-ranked learnings, surprises, and running notes from all past sessions, filtered by component and label overlap with the current ticket. Pass this block through to the Prior Knowledge section as-is.

**Standalone mode (no KB_PRELOADED):** List all files in `{KB_WORK_DIR}/personas/memory/{agent}/`, sorted by filename (oldest first). Read the 5 most recent session files per agent (or all files if fewer than 5 exist). Synthesise across sessions to build each agent's running state:

- Calibration: which of their past hypotheses were confirmed vs. refuted
- Recurring surprises: areas where the agent's expectations were wrong
- Open notes: short-lived context flagged for follow-up
- Session count: how many sessions each agent has contributed to (builds credibility over time)

If an agent's memory directory is empty: state `{Agent} memory: none yet — first session.`

Each agent internalises their own memory before speaking. An agent with 20+ sessions of memory brings that accumulated experience to their analysis — they already know which areas of the codebase surprised them before, which of their past hypotheses proved correct, and which patterns they tend to miss.

Include a summary in the Prior Knowledge block:

**Present the Prior Knowledge block before Step 2:**

```
┌─ Knowledge Base — Prior Knowledge ──────────────────────────────┐
│ Rooms matched   : {e.g. 🏠 CASE ROOM, 🚨 ALERT ROOM}             │
│ Triggers matched: {N}  |  Ticket history: {N}  |  Shared: {M}    │
│                                                                   │
│ TICKET HISTORY                                                    │
│ ─────────────────────────────────────────────────────────────────│
│ [IV-XXXX] ({date}) {type} — {one-line summary}                   │
│   Root cause : {root cause one-liner}                            │
│   Files      : {primary files affected}                          │
│   Lesson     : {lesson learned}                                  │
│                                                                   │
│ BUSINESS RULES (🔑 memorise these)                               │
│ ─────────────────────────────────────────────────────────────────│
│ [BIZ-001] "resolve case → must resolve alerts"                   │
│           {one-line rule body}                                   │
│                                                                   │
│ ARCHITECTURE NOTES                                               │
│ ─────────────────────────────────────────────────────────────────│
│ [ARCH-001] "pendingAlertResolve drives the chain"                │
│           {one-line insight}                                     │
│                                                                   │
│ RECURRING PATTERNS (⚠️ seen before)                              │
│ ─────────────────────────────────────────────────────────────────│
│ [PAT-001] "flag set, never reset — boolean trap" (seen {N}×)     │
│           {one-line description}                                 │
│                                                                   │
│ REGRESSION RISKS                                                  │
│ ─────────────────────────────────────────────────────────────────│
│ [RISK-001] "resolveCase — four callers watch this"               │
│           {one-line risk}                                        │
│                                                                   │
│ CORE MENTAL MAP                                                   │
│ ─────────────────────────────────────────────────────────────────│
│ [CMM-ARCH-001] "GWT Frontend → Backend API boundary"             │
│   {KEY fact — one line}  ref: {file:line}                        │
│ [CMM-GOTCHA-001] "Boolean flag trap in CaseManager"              │
│   {KEY fact — one line}  ref: {file:line}                        │
│ ⚠️ CMM-ARCH-002 contradicts live code — flagged for Step 13g     │
│                                                                   │
│ LESSONS LEARNED                                                   │
│ ─────────────────────────────────────────────────────────────────│
│ [alice / LL-003] "Never skip X when Y is pending" (2026-04-10)   │
│   PITFALL: {what to avoid}                                        │
│   KEY: {corrective rule}                                         │
│                                                                   │
│ CONFLUENCE                                                        │
│ ─────────────────────────────────────────────────────────────────│
│ [{Page title}] — {URL}                                           │
│   {one-line summary of relevant content found}                   │
│   {any rule or constraint that extends or conflicts with KB}     │
│                                                                   │
│ BITBUCKET CROSS-CHECK                                            │
│ ─────────────────────────────────────────────────────────────────│
│ {file:line references verified: N current / M stale}             │
│ {⚠️ KB-XXX stale: {file:line} not found on development — verify} │
│                                                                   │
│ AGENT MEMORY  ({N} relevant learning(s) from {M} indexed)         │
│ ─────────────────────────────────────────────────────────────────│
│ [server mode — indexed table, pass through as-is from pre-loaded] │
│ | Agent  | Ticket   | Category | Conf | Learning                | │
│ | morgan | IV-XXXX  | PATTERN  | High | {one-line learning}     | │
│ | alex   | IV-YYYY  | ARCH     | Med  | {one-line learning}     | │
│ … (top 15 ranked by component/label overlap)                      │
│                                                                   │
│ [standalone mode — per-agent summary when KB_PRELOADED absent]    │
│ Morgan  : {N} sessions | last: {ticket} | calibration: {X/Y ok}  │
│   Notable: {one-line — most relevant personal insight}            │
│ … (one row per agent, omit "Notable" if no prior sessions)        │
└────────────────────────────────────────────────────────────────────┘
```

If no local KB entries and no Confluence results: `Prior knowledge: none found — starting fresh.`
If Confluence is unreachable: omit the CONFLUENCE section and note `Confluence: unavailable.`
If Bitbucket cross-check skipped: note `Bitbucket: skipped — verify file:line refs in Step 5.`

**The Prior Knowledge block is mandatory, not advisory.** Agents must actively use it:

- **Step 2:** State explicitly whether KB entries confirm, extend, or contradict the ticket's problem description. If a business rule applies, name it.
- **Step 5:** Check Core Mental Map `ref:` entries before grepping the codebase — known `file:line` anchors must be tried first. If a CMM entry contradicts live code, flag it for Step 13g correction.
- **Step 7:** Morgan must open the investigation by explicitly stating which KB history items (if any) inform the root cause direction. "KB prior knowledge not applicable" is a valid statement — but silence is not.
- **Step 8:** If a KB pattern or proven fix exists for this type of problem, build on it. State why you are deviating if you choose a different approach.
- **Step 13g:** Any `[CMM+]` markers emitted during Steps 5/7/8/9 are written to the Core Mental Map. Every session must produce at minimum one `[CMM+ ... CONFIRM]` for each CMM entry read in Step 0b — confirming facts against live code is how the map stays accurate.

**Compounding rule:** Each session must leave the KB and Core Mental Map in a more accurate or more complete state than it found them. A session that writes nothing — not even a confirmation — breaks the compounding chain.

---

---

### Step 1 — Read the Jira Ticket

Use `mcp__jira__get_issue` with the ticket key extracted from the input. Request only the fields needed: `summary`, `issuetype`, `priority`, `status`, `assignee`, `reporter`, `labels`, `components`, `fixVersions`, `versions`, `description`, `comment`, `attachment`. Do not fetch sprint metadata, change logs, epic links, or watcher lists.

**If the MCP call fails** (authentication error, ticket not found, MCP server not running):

Retry with exponential backoff before giving up — transient network issues should not abort the session:

```
Attempt 1 — immediate
Attempt 2 — wait 30 s
Attempt 3 — wait 30 s
```

If all three attempts fail:
- State the exact error returned by the last attempt
- In **interactive mode**: stop and instruct the developer to verify: (1) the Atlassian MCP is running, (2) the API token is valid, (3) the ticket key is correct. Do not proceed until the developer confirms the issue is resolved.
- In **headless mode** (`AUTO_MODE_ON=1`): print `HEADLESS_ERROR: MCP unavailable after 3 attempts — {error}` and exit immediately.

Display:
- **Summary** (ticket title)
- **Type** (Story / Bug / Support / Task)
- **Priority**
- **Status**
- **Assignee** and **Reporter**
- **Labels** and **Components**
- **Fix Version** (target release)
- **Full description** — extract all text from the ADF body content

---

### Step 2 — Understand the Problem

Analyse the description and produce a concise internal summary:

- **What is the problem / enhancement?** (1–2 sentences)
- **Who is affected?** (which user role, client, or system)
- **What is the expected behaviour?**
- **What is the current (broken/missing) behaviour?**
- **Acceptance criteria** — list each criterion clearly

If the ticket type is a **Bug**, explicitly state:
> "This is a defect — the system is doing X but should be doing Y."

If the ticket type is a **Story/Enhancement**, explicitly state:
> "This is an enhancement — the system currently lacks X; we need to add Y."

#### Linked & Associated Tickets

Fetch all issue links from the ticket (e.g. "is blocked by", "blocks", "relates to", "is cloned from", "duplicates", "is caused by", parent/child epic links, sub-task relationships).

**Lazy fetch — two-phase approach to avoid unnecessary full fetches:**

Phase 1 — fetch summary + status only for all linked tickets. Rate each for relevance:
- **High relevance**: same component as primary ticket; or `Closed/Resolved` with a root cause documented; or link type is `is caused by` / `is cloned from` / `duplicates`
- **Low relevance**: `relates to` with a different component; `blocks` / `is blocked by` with no shared component; `Open` with no description

Fetch full details (Phase 2) **only for High-relevance tickets**. For Low-relevance tickets, record the one-line summary and status only — do not fetch full description or attachments.

State: `Linked tickets: {N} found — {M} High-relevance (full fetch), {P} Low-relevance (summary only)`

For each **High-relevance** linked ticket:
1. Retrieve the full ticket details (summary, description, status, type, resolution, attachments).
2. Extract any context that enriches the current analysis:
   - Prior investigations or findings already documented
   - Acceptance criteria or scope changes that affect this ticket
   - Root cause or fix details from a related bug (especially "is caused by" / "is cloned from" links)
   - Design decisions or constraints described in parent epics or stories
   - Known workarounds or regression notes from "relates to" tickets
3. **Discover associated PRs** — check the ticket's remote issue links and development panel for any linked pull requests. For each PR found:
   - Fetch the PR title, status (open/merged/declined), source branch, and target branch
   - Retrieve the full diff / file changes from the PR
   - Analyse the code changes: what was modified, why (based on PR description and commit messages), and whether the change is relevant to the current ticket's problem or fix
   - If the PR is merged, note which branch it landed on and when
   - Summarise: `PR #N — "[title]" (status) — one-sentence relevance and key code change`
4. Summarise each linked ticket in one line: `[KEY] (type, status) — one-sentence relevance to this ticket`

Apply the same attachment analysis rules (file type handling) to qualifying attachments on linked tickets.

If the linked ticket provides no additional context beyond what the primary ticket already contains, state: "No additional context from linked ticket [KEY]."

If there are no linked tickets, state: "No linked tickets found."

Carry all relevant findings from linked tickets forward into the **Prior Investigation Summary** in Step 3.

#### Diagnostic Artefact Analysis

**Attachment triage pass** — before downloading or deeply analysing any attachment, classify each one in one line (name, type, size, direct relevance to the problem statement). Only deep-analyse attachments rated **directly relevant**:

| Relevance | Criteria | Action |
|-----------|----------|--------|
| **Direct** | Screenshot of the reported error; log containing the exception; config file for the failing component | Deep-analyse |
| **Indirect** | Generic UI screenshot unrelated to the error path; log from a different service; diagram of an unaffected flow | Note filename and type only — state "skipped (indirect)" |

State: `Attachments: {N} total — {M} directly relevant (deep-analyse), {P} indirect (noted only)`

Download and analyse all qualifying attachments from the ticket.

Resolve the size limit once before processing attachments:
```
ATTACH_MAX_MB = ${PRX_ATTACHMENT_MAX_MB:-0}   ← 0 means no limit
```

Apply these rules:

| Attachment type | Size limit | Action |
|----------------|------------|--------|
| Images / screenshots | **none** — always read regardless of `PRX_ATTACHMENT_MAX_MB` | Describe visually — UI state, error messages, highlighted fields |
| Log files (`.log`, `.txt`) | `ATTACH_MAX_MB` (0 = no limit) | Scan for stack traces, exceptions, and error patterns |
| Thread dumps (`.tdump`, `.txt` with thread stacks) | `ATTACH_MAX_MB` (0 = no limit) | Full analysis — see below |
| Memory / heap dumps (`.hprof`, `.heap`) | `ATTACH_MAX_MB` (0 = no limit) | Full analysis — see below |
| XML / config files | `ATTACH_MAX_MB` (0 = no limit) | Check for relevant config values, malformed entries |
| draw.io diagrams (`.drawio`, `.xml`) | `ATTACH_MAX_MB` (0 = no limit) | Describe the flow depicted |
| Binary files, archives (`.zip`, `.jar`, `.war`, `.class`) | any | Skip — state "skipped (binary/archive)" |
| Non-image file exceeding `ATTACH_MAX_MB` | — | Skip — state "skipped (exceeds ${ATTACH_MAX_MB} MB limit)" |

For each attachment analysed, state its filename, type, size, and a one-line summary of what was found before the detailed analysis below.

---

**Screenshots / Images:**
- Describe the UI state visible — screen name, error banners, field values, highlighted rows
- Note any error codes, HTTP status, or modal messages visible in the screenshot

**Thread Dumps** (`.tdump`, `.txt`, `.log` files containing thread stack traces):
- Identify threads in `BLOCKED`, `WAITING`, or `TIMED_WAITING` state
- Look for deadlock indicators (threads waiting on locks held by each other)
- Extract the top stack frames from the relevant thread — note the class and method at the point of contention
- Summarise: "Thread `X` is blocked at `ClassName.method():line` waiting for lock held by thread `Y`"

**Memory Dumps / Heap Dumps** (`.hprof`, `.heap`, OOM log excerpts):
- Identify the object type dominating heap usage
- Note the `OutOfMemoryError` message and which heap space was exhausted (heap, metaspace, stack)
- Extract any GC log patterns if present (frequent full GCs, long pause times)
- Summarise: "Heap exhausted by `N` instances of `ClassName` — likely a retention/leak in `FlowX`"

**Application / Server Logs** (`.log`, stack trace excerpts in description or attachments):
- Extract the full exception chain (root cause first)
- Note the first application frame in the stack trace (below any framework frames)
- Note timestamps and whether the error is intermittent or consistent
- Summarise: "`NullPointerException` at `ClassName.method():line` — triggered when `condition`"

**XML / Config Files:**
- Identify the config type (worker config, routing rule, datasource, etc.)
- Note any values that appear incorrect, missing, or relevant to the reported issue

If no attachments are present, state: "No attachments found — proceeding from description only."
If attachments are present but none are qualifying types, state: "Attachments present but all skipped (binary/archive or exceeds configured size limit)."

Carry all findings forward into the **Prior Investigation Summary** in Step 3 and the **Root Cause Analysis** in Step 7.

#### Issue Diagram (optional)

For issues involving a **non-obvious data flow or multi-step component interaction** (e.g. a race condition, a cross-layer call chain, a plugin → backend → DB path), generate a draw.io XML diagram and save it to `/tmp/{TICKET_KEY}-diagram.drawio`.

The diagram should show:
- The **happy path** (what should happen) as a green flow
- The **broken path** (what actually happens) as a red flow
- Key method calls and data values annotated at each transition point

State: `Diagram saved to /tmp/{TICKET_KEY}-diagram.drawio`

**Skip this diagram automatically for** trivial single-file bugs, simple null checks, or straightforward field additions where the flow is self-evident from the code. State: `Diagram skipped — single-file change, flow is self-evident.`

---

### Step 3 — Read Comments for Additional Context

Use `mcp__jira__get_comments` to fetch all comments on the ticket.

Summarise:
- Any clarifications from the reporter or PO
- Decisions made in comments that affect implementation
- Known constraints, edge cases, or related tickets mentioned
- Any prior investigation or partial fixes already done

If there are no comments, state: "No comments — proceed from description only."

#### Prior Investigation Carry-Forward

If any comments contain previous investigation work (root cause findings, code traces, attempted fixes, identified files, test results, or partial solutions), extract and explicitly carry these forward as **known context** for Steps 5, 7, and 8. Do not re-investigate what has already been established.

Produce a **Prior Investigation Summary** block if applicable:

```
Prior Investigation Summary:
- Root cause identified: [what was found]
- Files already identified: [list]
- Attempted fixes: [what was tried and outcome]
- Confirmed working / not working: [what was already validated]
- Remaining unknowns: [what is still unresolved]
```

This summary must be referenced in Step 7 (Root Cause Analysis) and Step 8 (Propose the Fix) — build the solution on top of what is already known rather than starting from scratch.

---

### Step 4 — Create the Development Branch

#### 4a. Determine the Base Branch

Use the following priority order to determine the base branch:

1. **Fix Versions is set** → derive the version string (e.g. `1.24.292` from `1.24.292.p1`), then check whether a release feature branch exists:
   ```bash
   git branch --list "Feature/Release_{VERSION}" && git branch -r | grep "Feature/Release_{VERSION}"
   ```
   - If `Feature/Release_{VERSION}` exists (locally or remotely) → fork from it, so the fix builds on top of any release-level work already in progress
   - If not found → fork from the plain version branch (e.g. `1.24.292`)
2. **Fix Versions is empty, Affected Versions is set** → fork from the plain version branch (e.g. `1.24.292`)
3. **Both are empty** → fork from `development`

| Version value          | Feature/Release branch found? | Base branch to use              |
|------------------------|------------------------------|---------------------------------|
| Not set / empty        | —                            | `development`                   |
| e.g. `1.24.292.p1`    | Yes (`Feature/Release_1.24.292`) | `Feature/Release_1.24.292`  |
| e.g. `1.24.292.p1`    | No                           | `1.24.292`                      |
| e.g. `1.24.292`        | Yes                          | `Feature/Release_1.24.292`      |
| e.g. `1.24.292`        | No                           | `1.24.292`                      |

Rule: Strip any suffix after the third version segment (e.g. `.p1`, `.hotfix`) — always use the base `major.minor.patch` format as the version string.

**Base branch confirmation gate:** Before running any `git checkout` or `git checkout -b` command, verify the chosen base branch exists either locally or on the remote:
```bash
git branch --list {BASE_BRANCH}
git branch -r | grep "origin/{BASE_BRANCH}"
```
If it cannot be confirmed in either location, **stop and ask the developer** which branch to use rather than silently forking from a stale or incorrect HEAD.

State clearly which base branch will be used and why before running any git command.

#### 4b. Determine the Feature Branch Name

Use this format:
```
Feature/{TICKET_KEY}_{Ticket_Summary_Title_Case_Underscored}
```

Rules:
- Replace spaces with underscores
- Remove special characters (except underscores)
- Title-case each word
- Keep it under 80 characters total
- Prefix always `Feature/`

Example: `IV-3672` + "Resolving Cases should Resolve Alerts"
→ `Feature/IV-3672_Resolving_Cases_Should_Resolve_Alerts`

#### 4c. Create the Branch

Run the following commands **in the repository working directory** (`{REPO_DIR}/`):

First, check if the base branch exists locally:

```bash
git branch --list {BASE_BRANCH}
```

- **If the branch exists locally** — check it out directly, no remote sync:
  ```bash
  git checkout {BASE_BRANCH}
  git checkout -b Feature/{TICKET_KEY}_{Formatted_Title}
  ```

- **If the branch does NOT exist locally** — fetch it from remote first, then fork:
  ```bash
  git fetch origin {BASE_BRANCH}
  git checkout -b {BASE_BRANCH} origin/{BASE_BRANCH}
  git checkout -b Feature/{TICKET_KEY}_{Formatted_Title}
  ```

Confirm the branch was created and is checked out.

---

### Step 5 — Locate Affected Code

Based on the ticket description, comments, and labels, search the codebase at `{REPO_DIR}/` to identify:

1. **Primary files likely affected** — use the three-pass search sequence below
2. **Entry point** — where does the flow start? (API endpoint, UI event handler, worker, scheduled job)
3. **Data flow** — trace the relevant path through the layers (Frontend → API → DataSource → DB, or Worker → Plugin → etc.)
4. **Related files** — any model, DTO, or DB script changes that will likely be needed
5. **Class hierarchy** *(mandatory for enhancement tickets adding new fields or methods)* — identify the full inheritance chain of the target class.

   **Preferred (graphify — single query, transitive, language-agnostic):**
   ```bash
   # All ancestors + descendants + interface implementors of {TargetClass}
   graphify query "class hierarchy of {TargetClass}" --graph "$REPO_DIR/graph.json"
   # Or, structured:
   graphify get-neighbors "{TargetClass}" --edges extends,implements --depth 3 --graph "$REPO_DIR/graph.json"
   ```

   **Fallback (ast-grep — when graph unavailable or symbol not extracted):**
   ```bash
   # All direct subclasses
   sg --pattern 'class $NAME extends {TargetClass}' --lang java {REPO_DIR}/
   # All classes implementing the target interface
   sg --pattern 'class $NAME implements {TargetClass}' --lang java {REPO_DIR}/
   # Where the target class itself extends
   sg --pattern 'class {TargetClass} extends $PARENT' --lang java {REPO_DIR}/
   ```
   - Confirm the abstract base class (if any) and enumerate all sibling subclasses
   - Ask: does the new infrastructure (fields, getters/setters, utility methods) belong in the concrete class, or in the abstract base so future subclasses inherit it automatically?
   - **Rule:** If the abstract base already owns similar state for other listeners/workers in the same family, the new state belongs there too. Keep only the concrete-class-specific config wiring (`getConfig()` items, `setAttribute()` cases) in the concrete class.
   - Add the abstract base class to the file map with role "Abstract base — owns shared infrastructure"

#### Search Sequence (mandatory — up to four passes)

Never read an entire source file speculatively. Always follow these passes in order, stopping as soon as confidence is **High**:

**Pass 0 — graphify (knowledge graph lookup)** *(optional — runs only if `graph.json` exists at `{REPO_DIR}/`)*

Before grepping, ask the codebase knowledge graph: where does `{ClassName}` / `{methodName}` live, and what are its immediate neighbors?

```bash
# Prerequisite: graphify CLI + graph.json at the repo root
which graphify >/dev/null 2>&1 && [ -f "$REPO_DIR/graph.json" ] || echo "graph index unavailable — skip Pass 0"

# Locate the node
graphify query "where is {ClassName}" --graph "$REPO_DIR/graph.json"
graphify query "where is {methodName}" --graph "$REPO_DIR/graph.json"

# Pull the structural neighborhood (callers, callees, fields, subclasses)
graphify get-neighbors "{ClassName}" --graph "$REPO_DIR/graph.json"
```

Purpose: short-circuit Passes 1–2 when the graph already knows the answer. Costs ~0 tokens per query (graph stays on disk; only the JSON answer is read into context).

> **When to stop at Pass 0:** if the graph returns a unique node with file:line + at least one neighbor that matches the ticket's vocabulary, set `File map confidence: High` and skip directly to Pass 3 (Read). Pass 1/2 exist for cases the graph doesn't cover.
>
> **When to fall through:** missing/stale `graph.json`, ambiguous results (>5 matching nodes with the same label), or a symbol the graph couldn't extract (macros, generated code, dynamic dispatch). Note the reason inline (`Pass 0: ambiguous — 7 nodes named {Method} across {N} files`) and continue with Pass 1.
>
> **Stale graph guard:** if the most recent commit on `{REPO_DIR}` is newer than the `graph.json` mtime by >24h or >100 commits, treat the graph as stale — log `Pass 0: graph stale, rebuilding in background` and trigger `(cd "$REPO_DIR" && graphify . &)` so the next session has fresh data. Do not block this session waiting for it.

**Pass 1 — Grep (candidate files)**
```bash
grep -rn "{ClassName}\|{methodName}\|{keyword}" --include="*.java" {REPO_DIR}/
```
Purpose: fast, cheap scan across the whole repo. Output is a list of candidate file paths and approximate line numbers. Cost: ~0 tokens.

**Pass 2 — ast-grep (structural precision)**

Run ast-grep on the candidate files (or the whole repo for targeted structural queries) to find exact symbol locations without reading file content:

| Goal | Command |
|------|---------|
| Find all calls to a method | `sg --pattern '$_.$METHOD($$$)' --lang java {REPO_DIR}/` |
| Find all definitions of a method | `sg --pattern 'public $_ {METHOD}($$$) { $$$ }' --lang java {REPO_DIR}/` |
| Find all overrides of a method | `sg --pattern '@Override $$$ {METHOD}($$$) { $$$ }' --lang java {REPO_DIR}/` |
| Find all subclasses | `sg --pattern 'class $NAME extends {Parent}' --lang java {REPO_DIR}/` |
| Find all interface implementations | `sg --pattern 'class $NAME implements {Interface}' --lang java {REPO_DIR}/` |
| Find field reads/writes | `sg --pattern '$_.$FIELD' --lang java {file}` |

ast-grep matches syntax, not text — it finds `isEnableServerSafeguard()` regardless of whitespace, comments between tokens, or line wrapping. Where grep returns false positives (e.g. matching a comment or string literal), ast-grep returns only real code references.

> **Prerequisite check:** before using ast-grep, verify it is available: `which sg`. If not installed, fall back to Pass 1 grep results and note `ast-grep not available — structural pass skipped` in the file map. Install with `brew install ast-grep` (macOS) or `cargo install ast-grep`.

**Pass 3 — Read (targeted context)**
```
Read only the relevant line range (the method ± ~20 lines of surrounding context)
```
Only read the full file if the method spans many lines or the previous passes left the exact location ambiguous.

Reading a 40-line method costs ~60 tokens. Reading a 2,000-line Java file costs ~3,000 tokens. Apply this discipline to every file in this step and in Step 8.

**When to stop at Pass 1:** if the CMM `core-mental-map/architecture.md` already provides a confirmed `file:line` anchor for the relevant class, go directly to Pass 3 — no searching needed. The three passes exist to find what the KB does not already know.

Use the ticket **Labels** and **Components** as hints:
- `CaseManager` → `fcfrontend/.../view/CaseManager.java`
- `AlertCentral` → `fcfrontend/.../view/AlertCentral.java` and backend alert APIs
- `FRAMS` → case/alert related backend in `fcbackend/src/main/java/com/fc/api/`
- `Plugin`/`Worker` → `fcplugin/src/main/java/com/fc/plugin/`
- DB changes → `fcbuild/scripts/upgrades/`

Present a **file map** — list each file with its role, fragility score, the specific method or line range identified, and recent git history for primary files:

| File | Role | Fragility | Key Location | Recent Git History |
|------|------|-----------|-------------|-------------------|
| `fcfrontend/.../CaseManager.java` | Primary fix target | `0.74 HIGH` (no test, fix-commits=8, velocity=21/90d) | `resolveCase():2272` | Last modified: 3 days ago by Javed — "IV-3641 fix alert sync" |

To populate the Recent Git History column, run:
```bash
git log --oneline -3 -- {file_path}
```

**Fragility score (computed per file):** A 0.00–1.00 composite borrowed from Muninn's pre-edit context model. Combines six signals with fixed weights — dependents (0.25), coverage gap (0.20), error history (0.20), change velocity (0.15), complexity (0.10), export surface (0.10). Bands: `< 0.30 LOW`, `< 0.65 MED`, `≥ 0.65 HIGH`. A score ≥ 0.65 means **the panel must treat this file with extra care** — surface the breakdown to engineers in Step 7b.

Run the helper (from any cwd inside the project repo):

```bash
node "$CLAUDE_PROJECT_DIR/server/runner/fragilityScore.js" \
  --repo "$REPO_DIR" \
  --file "{primary_file}" \
  --files "{secondary_file_1},{secondary_file_2}" \
  --testRoots "fcfrontend/src/test,fcbackend/src/test" \
  --json
```

Output JSON shape per file:
```json
{
  "score": 0.74,
  "band": "HIGH",
  "breakdown": { "dependents": 0.6, "coverage_gap": 1, "error_history": 0.5, "velocity": 0.7, "complexity": 0.4, "exports": 0.3 },
  "raw":       { "dependents": 12, "coverage_gap": 1, "error_history": 8, "velocity": 21, "complexity_loc": 540, "exports": 9 }
}
```

Render the Fragility column as `{score} {BAND} ({1–2 dominant raw signals})`. Pick the two raw signals with the highest normalised contribution to keep the column scannable — full breakdown stays in the JSON for the panel's reference. If the helper is unavailable (no Node, or the repo has no `.git`), write `Fragility: n/a` and proceed; do not block on this signal.

Emit `[KB+ RISK]` for any primary file scoring `HIGH`. Riley uses this in the **7-pre Test Suite Signal** to amplify her coverage warning — a HIGH-band file with `coverage_gap=1` is the strongest possible "danger here" signal she can give the panel.

**Cortex hotspot cross-check (only when `PRX_CORTEX_RESOLVED_DIR` is set):** After computing local fragility, also grep cortex `facts/hotspots.md` for each primary file. Cortex hotspots aggregate **historical churn + repowise centrality** (when repowise is enabled) — a different signal axis from local fragility (which is point-in-time). When BOTH agree (`fragility HIGH` AND cortex flags the file), emit `[KB+ RISK HIGH-CONFIDENCE]` instead of plain `[KB+ RISK]` — the panel weights this strongest:

```bash
if [ -n "$PRX_CORTEX_RESOLVED_DIR" ] && [ -f "$PRX_CORTEX_RESOLVED_DIR/facts/hotspots.md" ]; then
  for f in {primary_files}; do
    if grep -qF "$f" "$PRX_CORTEX_RESOLVED_DIR/facts/hotspots.md"; then
      echo "[CORTEX HOTSPOT] $f — confirmed by cortex/facts/hotspots.md"
    fi
  done
  echo "[CORTEX HIT mid-session] step=5 source=facts/hotspots.md"
  MACHINE=$(hostname 2>/dev/null || echo unknown)
  curl -s -m 2 -X POST "http://localhost:${PRX_SERVER_PORT:-3000}/dashboard/cortex/referenced" \
    -H "Content-Type: application/json" \
    -d "{\"ticketKey\":\"${TICKET_KEY}\",\"hits\":[\"hotspots.md\"],\"missCount\":0,\"machine\":\"${MACHINE}\",\"step\":\"5\"}" \
    >/dev/null 2>&1 &
fi
```

If cortex is unavailable (Layer 0 missed or `PRX_CORTEX_ENABLED=N`), skip this cross-check silently — local fragility is still authoritative.

**Git blame injection (primary file only):** After locating the key method via Pass 1–3, run `git blame` on the affected line range and inject it into the file map for the primary fix target. This surfaces who changed each line, when, and under which commit — giving the panel richer causal context for root cause analysis:

```bash
# Identify the method's line range from Pass 3 read (e.g. lines 2270–2295)
START_LINE={method_start}
END_LINE={method_end}
git -C "$REPO_DIR" blame -L ${START_LINE},${END_LINE} -- {primary_file} \
  --date=short --abbrev=8
```

Add a `## Git Blame — {primary_method}` subsection to the file map showing:
- Each line's last-touching commit hash, author, date, and content
- Highlight (with `← SUSPECT?`) any line modified in the last 90 days or by a commit whose message references a related ticket

Only run blame on the primary fix target file. Cap at 60 lines. If the method exceeds 60 lines, blame only the first 40 lines plus the last 20 (the entry and exit are the highest-signal areas). Label: `Git blame: {file}:{START}–{END} ({N} lines, capped at 60)`.

#### Call Graph Traversal (one level deep — runs after the file map is built)

After Pass 3 confirms the primary affected file(s), follow import/call chains **one level outward** to identify callers of the changed functions. This dramatically improves impact analysis accuracy without the cost of a full graph traversal.

**Caller discovery:**
```bash
# For each primary method identified in the file map (e.g. resolveCase):
METHOD="{primary_method}"

# Preferred: graphify (returns all callers in one query, transitive-aware)
which graphify >/dev/null 2>&1 && [ -f "$REPO_DIR/graph.json" ] && \
  graphify get-neighbors "$METHOD" --edges calls --direction incoming --depth 1 --graph "$REPO_DIR/graph.json"

# Fallback: ast-grep for all call sites
sg --pattern '$_.$METHOD($$$)' --lang java "$REPO_DIR/"

# Fallback if ast-grep unavailable:
grep -rn "\\.${METHOD}(" --include="*.java" "$REPO_DIR/"
```

Add a **Caller Map** subsection to the file map (max 8 callers; truncate with "…and N more" if exceeded):

| Caller file | Method | Line | Impact if primary changes |
|-------------|--------|------|--------------------------|
| `fcfrontend/.../AlertCentralPanel.java` | `onResolveClicked()` | 441 | Shares the same flag — risk of flag-not-reset affecting this path too |

Emit `[KB+ RISK]` for any caller in a different module or screen — cross-module callers are a regression hotspot.

**Cap:** If graphify or ast-grep returns >15 callers, note `Callers: {N} — showing top 8 (sorted by module boundary distance); full list available via graphify` and stop. Do not read all caller files — this is a signal pass, not a deep investigation. Alex will dive into specific callers in Step 7c if warranted.

#### Confidence Gate

After building the file map, assess your certainty:

- **High** — the relevant class, method, and line number are confirmed via grep → proceed automatically
- **Medium** — file identified but exact method is ambiguous; note the assumption and proceed, flagging it clearly
- **Low** — cannot locate the relevant code with reasonable certainty → **stop and ask the developer** for guidance before continuing to Step 6

State the confidence level explicitly: `File map confidence: High — proceeding.`

**Opportunistic KB stale validation** — for each file now confirmed in the file map, cross-check any KB entries (from the Step 0b Prior Knowledge block) that referenced that file. Since you are already reading these files, this costs zero extra ops:
- If a KB entry's `file:line` still matches → mark `VALID` (no action needed)
- If the line content has shifted → calculate new line, flag `RELOCATED` for Step 13c auto-heal
- If the symbol is gone from the file → flag `STALE` for Step 13c to mark `[DELETED]`

Emit inline: `KB cross-check: {N} refs validated, {M} flagged for auto-heal` and continue — do not pause the step.

#### KB Annotations — Step 5

While building the file map, emit `[KB+]` markers for any architecture or business knowledge discovered:
- `[KB+ ARCH]` — whenever a class hierarchy, ownership rule, or layer interaction is confirmed (e.g. "AbstractXxxListener owns shared config; concrete subclasses only wire `getConfig()`")
- `[KB+ BIZ]` — whenever the code implies a domain invariant not stated in the ticket (e.g. "saving a case also triggers alert resolution via the `pendingAlertResolve` flag")
- `[KB+ RISK]` — whenever a widely-coupled class or method is identified in the file map (e.g. "resolveCase() is called from 4 different screens")

These annotations are collected in Step 13a alongside the Panel's `[KB+]` markers.

---

### Step 6 — Replicate the Issue

Based on the ticket description, comments, and located code, produce clear step-by-step reproduction instructions that any developer on the team can follow to observe the problem firsthand before attempting a fix.

#### 6a. Prerequisites
List everything needed before reproduction can begin:
- Required modules / spawners that must be running (e.g. Case Service, Alert Scanner)
- Specific user roles or permissions needed
- Test data that must exist (e.g. a case with open alerts, a specific alert type)
- Environment notes (e.g. Oracle vs Postgres, specific config flags)

#### 6b. Reproduction Steps
Number each step. Be explicit — do not assume prior knowledge:

```
1. Log in as a user with [role] permissions.
2. Navigate to [Screen] via [Menu path].
3. [Perform action — e.g. "Select a case with at least 2 open alerts in Alert Central."]
4. [Perform the triggering action — e.g. "Use the Actions dropdown → Change Status → RESOLVED."]
5. Navigate to Alert Central and search for the alerts that were in the case.
```

#### 6c. Expected Result
State clearly what **should** happen if the system were working correctly.

#### 6d. Actual Result (the bug / gap)
State clearly what **actually** happens — the symptom the reporter sees.

#### 6e. Replication Confidence

Same three-level gate as Step 5 (High → proceed; Medium → note assumption and proceed; Low → stop and ask developer before continuing to Step 7). State: `Replication confidence: {level} — {reason}.` If Medium or Low, list the specific unknowns or assumptions.

#### 6f. Service Restart Guidance

If the fix touches the **Plugin or Worker layer** (`fcplugin/`), state which spawner or service must be restarted locally to pick up the change:

```
To test this fix locally, restart:
  - [Spawner/Worker name] — e.g. "CaseResolutionWorker" or "AlertScannerWorker"
  - Any dependent service that loads the plugin at startup
```

If the fix touches only the **GWT Frontend** (`fcfrontend/`), state: `Frontend-only change — recompile GWT module; no backend restart required.`

If the fix touches only the **Backend API** (`fcbackend/`), state: `Backend-only change — restart the application server (Tomcat/embedded).`

If the fix touches **multiple layers**, list each service that needs restarting in the correct order.

---

### Step 7 — Root Cause Analysis

This step has two paths. **Choose the correct path based on the Decision Tree result in 7a:**

| Ticket type | Path |
|-------------|------|
| **BUG** (Data / UI / Async / Regression) | Engineering Panel → 7b through 7i |
| **ENHANCEMENT** (feature that never existed) | Direct Analysis → Step 7-ENH, then skip to Step 8 |

Do not guess — verify every claim by reading code at the specific location. The Grep-First rule applies throughout this step.

#### 7-pre. Riley's Test Suite Signal *(Bug tickets only — runs before the panel convenes)*

Before opening the engineering panel, Riley performs a **test-first reconnaissance** against the affected files identified in Step 5. Test names and assertions are often the clearest specification of intended behaviour; coverage gaps are a leading indicator of where bugs hide.

**Operations (max 4 — Riley is scouting, not deep-reading):**

```bash
# Locate test files for each primary file in the file map
for src_file in {primary_files}; do
  base=$(basename "$src_file" .java)
  find "$REPO_DIR" -name "${base}Test.java" -o -name "Test${base}.java" \
       -o -name "${base}IT.java" -o -name "${base}*Test*.java" 2>/dev/null
done
```

For each test file found: read only the method signatures (test names) and any `@Test` annotation lines — do not read full test bodies (too expensive). Cap at 2 test files, 50 lines each.

Riley produces a **Test Signal block** surfaced in Morgan's briefing:

```
┌─ Riley — Test Suite Signal (pre-panel) ──────────────────────────┐
│ Test files located : {N} for {M} primary files                    │
│   {TestClassName} → {file path}                                   │
│     Test names found : {list of @Test method names}               │
│     Intended behaviour spec'd by tests: {one-line summary}        │
│     Coverage gaps noticed: {any obvious scenario not tested, or   │
│                             "None apparent from test names alone"} │
│                                                                    │
│ No test file found for: {primary_file} ← coverage gap             │
│                                                                    │
│ Signal to panel: {one sentence directing the engineers — e.g.     │
│   "The tests confirm resolveCase() must reset the flag — any      │
│    hypothesis not addressing the reset path contradicts the spec." │
│    or "No tests exist for this method — root cause analysis must   │
│    rely entirely on code reading; treat with Medium confidence."}  │
└────────────────────────────────────────────────────────────────────┘
```

Morgan includes the Test Signal in the 7b briefing. Engineers must address any coverage gap or spec constraint identified here in their hypotheses. Riley emits `[KB+ RISK]` for every uncovered primary method.

---

#### 7a. Diagnostic Decision Tree

Before anyone begins investigating, classify the failure mode. This classification drives Morgan's briefing and each engineer's focus:

```
Issue reported
    │
    ├─► BUG (defect — something that worked before or should work now)
    │       │
    │       ├─► DATA ISSUE? (wrong value stored / returned)
    │       │       ├─► Missing null/empty check → Hypothesis: NPE or silent empty result
    │       │       ├─► Wrong field read or written → Hypothesis: Field mapping error
    │       │       └─► DB query incorrect → Hypothesis: SQL / ORM misconfiguration
    │       │
    │       ├─► UI ISSUE? (screen not rendering, action not triggering)
    │       │       ├─► Event handler missing or broken → Hypothesis: GWT callback not wired
    │       │       ├─► Service call fails silently → Hypothesis: RPC error swallowed
    │       │       └─► State not refreshed after action → Hypothesis: Missing panel reload
    │       │
    │       ├─► ASYNC / TIMING ISSUE? (intermittent, race condition)
    │       │       ├─► Multiple callbacks competing → Hypothesis: Race condition
    │       │       ├─► Lock / transaction conflict → Hypothesis: Deadlock / dirty read
    │       │       └─► Worker processing order → Hypothesis: Out-of-order execution
    │       │
    │       └─► REGRESSION? (was working, now broken)
    │               ├─► Check git log on affected files (last 90 days)
    │               └─► Identify which commit introduced the change
    │
    └─► ENHANCEMENT (feature that never existed)
            ├─► Pure addition → no breakage risk; identify insertion point
            └─► Modification of existing flow → treat sub-paths as BUG branches above
```

State: `Decision tree path: {BUG → DATA ISSUE → Missing null check}` (or whichever branch matched).

**→ If ENHANCEMENT: proceed to Step 7-ENH below and skip the Engineering Panel entirely.**
**→ If BUG: proceed to 7b (Engineering Panel).**

---

#### Step 7-ENH — Enhancement Direct Analysis *(Enhancement tickets only — skip for bugs)*

Read the files identified in Step 5 and produce a direct analysis. No panel. No debate.

**7-ENH-a. What needs to be added + insertion points**

State: *"The system currently lacks X. We need to add Y at Z."* with specific `file:line` references. For each insertion point: name what already exists there, what new code goes in (field, method, config item, UI hook), and whether new fields/methods belong in the abstract base — apply the Step 5 class hierarchy rule.

**7-ENH-c. Git history check**
- Run `git log --oneline --all -- {primary_file}` for each affected file
- Confirm: no partial implementation of this feature already exists in any branch
- If a partial exists: note it explicitly and build on it rather than duplicating

**7-ENH-d. Enhancement Statement**

Produce the following block — this replaces the Root Cause Statement for Step 8:

```
ENHANCEMENT STATEMENT
────────────────────────────────────────────────────────────────────
What is missing : [one sentence — what the system cannot currently do]
Insertion points: [file:line for each touch point]
Approach        : [one paragraph — the design decision, e.g. new field
                  in AbstractJsonListener wired through getConfig() in
                  the concrete class; new UI config item; new DB column]
Class hierarchy : [N/A / Confirmed concrete class is correct /
                   Moved to {AbstractBase} — {N} sibling classes benefit]
Partial exists  : [No — confirmed by git log / Yes — {branch:file:line}]
Confidence      : High / Medium / Low
────────────────────────────────────────────────────────────────────
```

If confidence is **Low** (insertion points unclear after reading the code), stop and ask the developer for clarification before proceeding to Step 8.

**→ After completing Step 7-ENH, skip to Step 8 directly.**

---

#### 7b-pre. Complexity Gate *(Bug tickets only)*

Before convening the full panel, Morgan performs a **2-op pre-assessment** to decide whether the full panel is needed or a fast-path is sufficient.

**Pre-assessment (≤ 2 ops):**
1. Count files in the Step 5 file map and run a quick caller count: `sg --pattern '$_.$METHOD($$$)' --lang java "$REPO_DIR/" | wc -l` (fall back to `grep -r "{primary_method}" "$REPO_DIR" | wc -l` if ast-grep is unavailable)
2. Check whether Step 0b surfaced a Prior Knowledge hit with High confidence on the same component and pattern

**Complexity verdict:**

| Signal | Fast-path? |
|--------|-----------|
| ≤ 2 files in file map AND ≤ 5 callers AND KB hit (High confidence, same component + pattern) | **Yes** — fast-path |
| Any signal outside those bounds | **No** — full panel |

**Fast-path mode** (skips mid-point check-in and full cross-examination):
- KB short-circuit: Morgan opens with `"KB identifies [Pattern/Rule] as likely mechanism — engineers confirm or rule out, 4 ops each maximum. No fresh investigation needed unless the evidence contradicts KB."`
- Each engineer submits one concise hypothesis block (no structured investigation narrative)
- Riley gives a one-line risk rating instead of a full Testing Impact Assessment
- Morgan's verdict in 3 sentences; no formal debate round
- Emit `[FAST-PATH]` tag in the output so the PDF labels it clearly

State: `Complexity gate: {Fast-path / Full panel} — {one-line reason}`

---

#### Engineering Panel *(Bug tickets only — 7b through 7i)*

**The team:**

| Role | Name | Background | Mandate |
|------|------|-----------|---------|
| **Lead Developer** | **Morgan** | 20 yrs Java, ex-systems architect, deep GWT/Spring/Oracle | Chairs the session. Sets schedule. Reviews all hypotheses. Debates. Gives final verdict. Approves the Root Cause Statement. |
| Senior Engineer 1 | Alex | 12 yrs Java/GWT | Code archaeology & regression forensics |
| Senior Engineer 2 | Sam | 10 yrs full-stack Java, Spring, GWT RPC | Runtime data flow & logic tracing |
| Senior Engineer 3 | Jordan | 15 yrs Java, systems architect background | Defensive patterns & structural anti-patterns |
| **Technical Lead** | **Henk** | Long-tenured system expert; encyclopedic knowledge of business rules and client workflows | Domain authority consulted by Morgan to validate whether a fix is genuinely necessary and whether it delivers real value to existing clients. Attentive to detail; draws on years of hands-on system experience to judge the merit and scope of proposed changes. |
| **Senior Lead Tester** | **Riley** | 18 yrs QA & test architecture, Java enterprise, GWT, regression suites | Assesses testability and impact of each hypothesis. Questions engineer findings. Flags regression risk and edge cases. Riley's concerns are factored into Morgan's verdict and Fix Review. |
| **Scrum Master** | **Bryan** | 15 yrs agile delivery, process optimisation, token & cost efficiency | Silent observer for Steps 0–13. Does not intervene in the investigation. Convenes Step 14 retrospective at the end of every session (Dev and PR Review alike) to audit process friction, token spend, and propose one focused SKILL.md improvement per session. |

Engineers (Alex, Sam, Jordan) are competing for the **Best Analysis** distinction. Morgan is not competing — Morgan arbitrates. Morgan's verdict is binding and may endorse, refine, or override any engineer's hypothesis. Henk is not competing — Henk is the domain authority; Morgan checks in with Henk at key decision points to form a broader picture and validate business necessity before issuing a verdict or approving a fix. Riley is not competing — Riley challenges and assesses from a testing perspective. Bryan is not part of the investigation — Bryan observes the whole session and acts only in Step 14.

---

#### 7b. Morgan Opens — KB Patterns Check + Historical JIRA Search + Lead Briefing

Before briefing the team, Morgan performs two mandatory pre-briefing lookups: a KB patterns cross-reference and a JIRA historical search.

##### 7b-0. Morgan's KB Patterns Cross-Reference

Before any JIRA search, Morgan surfaces the 3 most similar past bugs relative to the current ticket's component and decision tree classification. This grounds the panel in institutional memory before they begin investigating.

**Cortex-first lookup** — if `PRX_CORTEX_RESOLVED_DIR` is set (from Step 0a) AND `facts/patterns.md` was a HIT, grep cortex *instead* of the raw KB. Cortex patterns are pre-sorted by frequency (saves a sort), pre-filtered for stale entries, and typically half the size — Morgan gets the same answer faster:

```bash
SRC_LABEL="(KB)"
if [ -n "$PRX_CORTEX_RESOLVED_DIR" ] && [ -f "$PRX_CORTEX_RESOLVED_DIR/facts/patterns.md" ]; then
  PATTERN_SRC="$PRX_CORTEX_RESOLVED_DIR/facts/patterns.md"
  SRC_LABEL="(cortex)"
  echo "[CORTEX HIT mid-session] step=7b-0 source=facts/patterns.md"
  # Fire-and-forget telemetry — the dashboard activity log will show
  # cortex_referenced events tagged with step=7b-0 alongside the Step 0a one.
  MACHINE=$(hostname 2>/dev/null || echo unknown)
  curl -s -m 2 -X POST "http://localhost:${PRX_SERVER_PORT:-3000}/dashboard/cortex/referenced" \
    -H "Content-Type: application/json" \
    -d "{\"ticketKey\":\"${TICKET_KEY}\",\"hits\":[\"patterns.md\"],\"missCount\":0,\"machine\":\"${MACHINE}\",\"step\":\"7b-0\"}" \
    >/dev/null 2>&1 &
else
  PATTERN_SRC="$KB_WORK_DIR/shared/patterns.md"
fi

grep -i "{COMPONENT}\|{CLASSIFICATION_TYPE}" "$PATTERN_SRC" | head -30
echo "Patterns source: $PATTERN_SRC $SRC_LABEL"
```

Extract up to 3 pattern entries with the highest frequency counter that match the current component or classification. Present them as a **Historical Pattern Context** block:

```
┌─ Morgan — Historical KB Pattern Context ──────────────────────────┐
│ Matching patterns from shared/patterns.md:                        │
│                                                                    │
│ [PAT-002] "flag set, never reset — boolean trap" (freq: 7)        │
│   Component match: CaseManager, AlertCentral                      │
│   Classification match: REGRESSION / DATA ISSUE                   │
│   Verdict question for panel: Is this the same pattern, or a      │
│   genuinely new failure mode?                                      │
│                                                                    │
│ [PAT-007] "GWT async callback lost" (freq: 3)                     │
│   Component match: AlertCentral                                    │
│   …                                                               │
│                                                                    │
│ Panel note: engineers must explicitly state in their hypothesis    │
│ whether this is [SAME PATTERN] / [NEW PATTERN] / [UNRELATED].     │
│ Morgan will not issue a verdict without this classification.       │
└────────────────────────────────────────────────────────────────────┘
```

If no patterns match: state `KB Pattern Context: no matching patterns for {COMPONENT}/{CLASSIFICATION} — proceeding fresh.`

Each engineer must include a `Pattern match: [SAME PAT-NNN / NEW / UNRELATED]` line in their hypothesis block (Step 7e).

##### 7b-i. Morgan's JIRA Historical Search

Before briefing the team, Morgan performs a mandatory JIRA historical investigation to determine whether this issue — or a closely related one — has been encountered and resolved before. Prior resolutions may contain root cause analysis, fix locations, or regression notes that the team can immediately build on.

##### 7b-i. Morgan's JIRA Historical Search

Morgan runs the following JQL queries using `mcp__jira__jira_search` or `mcp__plugin_atlassian_atlassian__searchJiraIssuesUsingJql`:

```
-- Query 1: Same component(s), closed/resolved, keyword match on current summary
project = IV
AND component in ("{COMPONENTS}")
AND status in (Done, Resolved, Closed)
AND summary ~ "{KEY_TERM_1}" OR summary ~ "{KEY_TERM_2}"
ORDER BY updated DESC

-- Query 2: Same label(s), closed/resolved — broader net
project = IV
AND labels in ("{LABELS}")
AND status in (Done, Resolved, Closed)
ORDER BY updated DESC
```

Limit to 10 results per query. For each ticket returned:
1. Retrieve full details (summary, description, comments, resolution note, assignee, fix version).
2. Scan comments for: root cause statements, file:line references to the fix, investigation notes, known regressions introduced by the fix.
3. Classify relevance: **High** (same component + same symptom), **Medium** (same component, different symptom), **Low** (related label only).
4. Emit `[KB+ BIZ]` or `[KB+ ARCH]` markers for any business rule or architecture insight discovered in the historical tickets that is not already in the Prior Knowledge block.

Present the Historical JIRA Precedents block before the team briefing:

```
┌─ Morgan — Historical JIRA Precedents ────────────────────────────────┐
│ Searched  : component={COMPONENTS}, label={LABELS}, status=Closed    │
│ Found     : {N} related past ticket(s)                               │
│                                                                      │
│ [IV-XXXX] ({date}) {summary}  — Relevance: High/Medium/Low          │
│   Status   : {Closed/Resolved} | Fix version: {version}             │
│   Root cause (from comments): {one-line summary or "Not documented"} │
│   Fix area : {file:method:line if mentioned, else "Not documented"}  │
│   Risk note: {any regression warning from comments or "None"}        │
│                                                                      │
│ [IV-YYYY] ...                                                        │
│                                                                      │
│ Team note: {one of:}                                                 │
│   "IV-XXXX is directly relevant — Alex/Jordan, start from that fix." │
│   "Past tickets found but no documented root cause — fresh start."   │
│   "No past tickets found on these components/labels."                │
└──────────────────────────────────────────────────────────────────────┘
```

If JIRA search fails (MCP unavailable): log `JIRA_SEARCH_WARN: historical search unavailable` and continue. Do not block the session.

If no matching tickets are found: state "No historical tickets found on these components/labels — proceeding fresh."

##### 7b-ii. Morgan Lead Briefing (1-minute block)

Morgan reads the ticket summary, the file map from Step 5, the replication guide from Step 6, the decision tree classification, the Prior Knowledge block (Step 0b), and the Historical JIRA Precedents above. Morgan then opens the session:

```
┌─ Morgan — Lead Briefing ────────────────────────────────────────────┐
│ Ticket     : {TICKET_KEY} — {summary}                               │
│ Classification: {Decision tree path}                                │
│ Primary suspect area: {file:line or layer identified in Step 5}     │
│ Prior KB   : {N triggers matched / "none — fresh start"}            │
│ JIRA history: {N past tickets / "none found"}                       │
│                                                                     │
│ Team assignments:                                                   │
│   Alex  → Focus on git history of {primary_file}. Flag anything    │
│            touched in the last 90 days near {method/class}.         │
│            {If relevant past ticket: "Check IV-XXXX fix commit."}   │
│   Sam   → Trace from {entry_point} down. Find the divergence.      │
│   Jordan → Run your pattern checklist. Decision tree says           │
│            {classification}, so lead with patterns {X, Y, Z}.      │
│            {If KB has prior pattern: "PAT-00N seen N× — confirm."}  │
│   Riley → Map the test surface. Identify affected user flows,       │
│            edge cases the engineers may miss, and flag any           │
│            testability concern with the suspected fix direction.     │
│                                                                     │
│ KB annotations: emit [KB+] markers inline whenever you discover a   │
│ business rule, architecture insight, pattern, or regression risk.   │
│                                                                     │
│ Schedule:                                                           │
│   T+2 min : Mid-point check-in (all four report progress)          │
│   T+4 min : Final hypotheses + Riley's assessment due               │
│   T+5 min : Riley's questions + Morgan's cross-examination          │
│   T+6 min : Debate round + my verdict                              │
│                                                                     │
│ Rules: Evidence only. File:line or commit references required.      │
│ Riley — your concerns carry weight. Flag anything that would        │
│ make this fix untestable or hide a regression.                      │
└──────────────────────────────────────────────────────────────────────┘
```

---

#### 7c. Parallel Investigation — Engineers and Tester Investigate (4-minute block)

Each engineer has a **4-minute investigation window**, capped at **8 targeted grep/read operations** before committing to a hypothesis. The budget enforces focus: reach defensible conclusions quickly, not exhaustively.

**Riley — conditional timing:** Riley does NOT run in parallel by default. After the hypothesis round, Morgan checks whether all three engineers converge on the same root cause with High confidence. If yes, Riley gives a **one-line risk rating** only (no full Testing Impact Assessment block). If any engineer diverges or confidence is Medium/Low, Riley runs the full 6-op Testing Impact Assessment before Morgan's cross-examination.

**Budget rules (apply to Alex, Sam, and Jordan):**
- **High-confidence evidence found in ≤ 4 ops?** Stop immediately and go to mid-point check-in. Do not over-investigate.
- **No clear hypothesis after 8 ops?** Commit to the best available hypothesis, rate it Medium or Low confidence, and state explicitly what additional information would confirm it.
- Every claim must be backed by a specific `file:line` or commit reference. Unsupported assertions will be challenged by Morgan.
- Present findings as if briefing a tech lead: precise, brief, right.

**Cortex on-demand consult (optional — counts as 1 op of the 8-op budget):** If an engineer hits a component or flow they don't immediately recognise, one targeted `grep` against `cortex/facts/architecture.md` (when available) returns the curated answer faster than walking core-mental-map files. This is a *substitute* for reading raw KB files, not an addition. Cite the cortex source in the hypothesis: `(cortex/facts/architecture.md)`.

```bash
# Drop-in helper: any panel step can use this to consult cortex on-demand.
# Returns matching lines + 4 lines of context. Empty output = no cortex match,
# fall back to grep on raw KB.  STEP is the step ID for telemetry (5, 7b-0, 7c, etc.).
cortex_consult() {
  local TERM="$1" FACT="$2" STEP="${3:-7c}"
  [ -z "$PRX_CORTEX_RESOLVED_DIR" ] && return 1
  [ ! -f "$PRX_CORTEX_RESOLVED_DIR/facts/$FACT" ] && return 1
  grep -i -B 1 -A 4 "$TERM" "$PRX_CORTEX_RESOLVED_DIR/facts/$FACT" || return 1
  echo "[CORTEX HIT mid-session] step=$STEP source=facts/$FACT term=$TERM"
  # Telemetry — fire-and-forget.
  local MACHINE=$(hostname 2>/dev/null || echo unknown)
  curl -s -m 2 -X POST "http://localhost:${PRX_SERVER_PORT:-3000}/dashboard/cortex/referenced" \
    -H "Content-Type: application/json" \
    -d "{\"ticketKey\":\"${TICKET_KEY}\",\"hits\":[\"$FACT\"],\"missCount\":0,\"machine\":\"${MACHINE}\",\"step\":\"$STEP\"}" \
    >/dev/null 2>&1 &
}

# Examples:
# cortex_consult "AlertCentral" architecture.md 7c-alex
# cortex_consult "case manager" patterns.md 7c-jordan
# cortex_consult "session token" decisions.md 7e
```

If the consult returns nothing, the engineer falls back to a normal grep on the raw KB (still part of their 8-op budget).

**Budget rules (Riley):**
- 6 operations maximum — Riley is mapping impact, not tracing code.
- Operations count reads of the ticket description, Step 2/5/6 outputs, and any targeted grep/file reads.
- Riley does not need to find the root cause — Riley needs to answer: *"If the fix goes where the engineers think, what breaks, what is untestable, and what are the edge cases?"*

---

**Alex — Code History & Regression**
*"Every bug has a birthday. Find the commit, find the cause."*

Operations (in priority order — stop early if High confidence is reached):
1. `git log --oneline -10 -- {primary_file}` for each file in the Step 5 file map
2. `git log --oneline --since="90 days ago" -- {primary_file}` for broader history
3. Identify the most recent commit touching the relevant method or class
4. Inspect the suspect commit: `git show {commit_hash} -- {file}` — read only relevant diff hunks
5. Check if the issue correlates with a version branch merge or cherry-pick
6. For enhancement tickets: confirm no partial implementation exists in git history
7. Cross-reference suspect commit date with related Jira tickets in comments
8. Confirm fix path is clear of conflicting in-progress changes on the branch

**Alex KB annotations:** Emit `[KB+ RISK]` for any widely-coupled area found via git blame. Emit `[KB+ ARCH]` if git history reveals an architectural decision (e.g. "this class was split in commit X because Y"). Emit `[KB+ BIZ]` if a commit message or JIRA cross-reference reveals a business rule that drove a past change.

---

**Sam — Data Flow & Runtime Logic**
*"Follow the data. The divergence point is the bug."*

Operations (in priority order — stop early if High confidence is reached):
1. Locate the entry point from Step 5 (UI event handler, API endpoint, worker trigger)
2. Read the entry method (relevant line range — Grep-First applies)
3. Follow the first significant call in the chain — grep, then read the target method
4. Continue layer by layer: UI → service → DAO/plugin → DB until divergence is found
5. At each hop: is correct data present? Is a null check missing? Is a flag propagated?
6. Identify the exact line where actual state deviates from required state
7. Verify fix direction: confirm the correct value *would* be available if the divergence is patched
8. Note secondary effects downstream of the divergence point

Additional Sam checks at every hop:
- GWT async callback result used outside its callback scope?
- Method return value silently discarded?
- Conditional branch short-circuits before the critical operation executes?
- Service method calling a deprecated path instead of the updated one?

**Sam KB annotations:** Emit `[KB+ BIZ]` for every domain invariant implied by the data flow (e.g. "field X must be set before service Y is called"). Emit `[KB+ ARCH]` when a new layer interaction is discovered (e.g. "plugin workers communicate back to FRAMS via event bus, not direct call"). Emit `[KB+ RISK]` when a widely-used service method or shared state is identified as a potential regression point.

---

**Jordan — Defensive Patterns & Structural Anti-Patterns**
*"I've catalogued every way Java developers shoot themselves in the foot."*

Jordan checks patterns in priority order driven by the decision tree classification:

| Pri | Pattern | What Jordan checks |
|-----|---------|-------------------|
| 1 | **Null Pointer** | Object dereferenced without a prior null guard. Jordan checks all six sub-cases: **(a) Service/RPC return** — result of a service call, RPC, or REST response used directly without null check; **(b) Map.get() result** — `map.get(key)` used without null guard (key may be absent); **(c) Method chain** — `a.getB().getC().getValue()` with no intermediate null guard — any link can be null; **(d) Null unboxing** — `Integer`/`Long`/`Boolean` field auto-unboxed in an arithmetic or boolean expression while the wrapper is null; **(e) String comparison** — `str.equals("literal")` where `str` may be null — should be `"literal".equals(str)` or an explicit null guard; **(f) For-each on null collection** — enhanced `for` loop over a field or return value that could be null (no empty-collection guard, distinct from pattern #5 which covers size/`.get(0)` on a non-null list). |
| 2 | **Boolean Flag Not Reset** | Flag set in one path but never cleared in the complementary path |
| 3 | **GWT Async Callback Lost** | Async callback result used outside its own closure scope |
| 4 | **Silent Exception Swallow** | Catch block empty or logging only — masking the real failure |
| 5 | **Empty Collection Guard** | List iterated or `.get(0)` called without size/null check |
| 6 | **Partial Transaction** | DB write immediately depended upon in the next call without flush |
| 7 | **Missing Method Override** | New overload added to interface/abstract class, not implemented in subclass |
| 8 | **Wrong Layer Call** | UI code directly accessing DAO or utility, bypassing the service layer |
| 9 | **DB Dialect Gap** | `ROWNUM` vs `LIMIT`, `NVL` vs `COALESCE`, `SYSDATE` vs `NOW()` etc. |
| 10 | **Thread Safety** | Shared field read/written from multiple threads without synchronisation |
| 11 | **Wrong Ownership Level** | New fields or methods placed in a concrete class when the abstract base is the correct owner. Check: does the concrete class extend an abstract base that already owns similar infrastructure (e.g. fields, utility methods, config helpers)? `grep "extends {AbstractBase}"` to find all siblings — if siblings exist or would benefit, the new state belongs in the abstract base; only config wiring (`getConfig()` items, `setAttribute()` cases) stays in the concrete class. |
| 12 | **Resource Leak** | `Connection`, `InputStream`, `ResultSet`, or other `Closeable` opened but not closed in a `finally` block or `try-with-resources` — especially in exception paths where the happy-path close is bypassed. |
| 13 | **Mutable Static State** | Static fields that are non-final and mutable — in a servlet container these are shared across requests and threads, causing cross-request contamination. Non-final statics are a silent shared-state bug. |
| 14 | **Leaking Abstraction** | Implementation-specific types (e.g., a DAO exception class, an ORM entity) surfacing in the service or UI layer — the layer boundary was breached at the type level, not just the call level. Complements pattern #8 (Wrong Layer Call). |
| 15 | **Circular Dependency** | Package A imports package B which imports package A — violates clean layering and signals a design split that was never completed. Check for cycles at the package level when a new import is added. |
| 16 | **Breaking API Change** | Public method signature changed (parameter added/removed, type changed, checked exception added) without a backward-compatible overload — any existing caller becomes a compile or runtime failure. |
| 17 | **equals/hashCode Contract Broken** | `equals()` overridden without `hashCode()` (or vice versa), or `hashCode()` includes a mutable field — objects placed in `HashSet` or `HashMap` silently misbehave. |
| 18 | **Serialization Mismatch** | `Serializable` class had fields added or removed without updating `serialVersionUID` — relevant in GWT where DTOs cross the wire and persisted sessions may deserialize stale versions. |
| 19 | **Unchecked Cast Without Guard** | `(SomeType) obj` cast not preceded by an `instanceof` check — a `ClassCastException` waiting on a non-obvious code path, typically in a generic handler or polymorphic dispatch. |
| 20 | **Hardcoded Environment Value** | IP addresses, port numbers, timeouts, or threshold values baked into logic rather than pulled from config — breaks silently when deployed to a different environment. |

Priority order by classification: UI issues → {1, 2, 3, 4}; Data issues → {1, 5, 6, 9, 12, 13}; Async issues → {3, 7, 10}; Regressions → {2, 8, 17, 18}; Enhancements → {11, 7, 16}; Architecture → {14, 15, 19, 20}.

**Jordan KB annotations:** For every pattern match: emit `[KB+ PAT] Pattern #{N}: {description} — {file:line} [NEW]` on first occurrence or `[KB+ PAT] Pattern #{N}: {description} — {file:line} [BUMP]` if already in KB. If a structural anti-pattern (wrong ownership level, circular dependency, leaking abstraction) reveals an architecture insight: also emit `[KB+ ARCH]`.

---

**Riley — Testing Impact & Regression Assessment**
*"A fix that can't be verified is a fix that can't be trusted."*

Operations (in priority order — stop when impact picture is clear):
1. Re-read the ticket's expected behaviour and acceptance criteria (Step 2 problem statement)
2. Review the Step 6 replication guide — assess completeness; identify gaps (missing preconditions, untested data states, concurrent-user scenarios)
3. From the Step 5 file map, identify every user-facing flow that passes through the affected files — not just the primary path
4. For each affected flow: what does a tester do to confirm it works after the fix? Is the fix observable from the UI/API, or does it require DB-level verification?
5. Enumerate edge cases the engineer hypotheses have not addressed: null/empty inputs, DB dialect differences, multi-client data isolation, state at session boundaries
6. Assess the regression surface: list existing behaviours that the proposed fix direction could silently break — focus on shared utilities, common service methods, and anything called by more than one screen

Riley does **not** assert a root cause. Riley asserts impact, risk, and testability.

**Riley KB annotations:** Emit `[KB+ RISK]` for every area identified as fragile (shared methods, widely-used utilities, cross-screen state). Emit `[KB+ BIZ]` if an acceptance criterion implies a domain rule (e.g. "system must not allow X in state Y"). These become regression risk and business rule entries in the KB.

---

#### 7d. Mid-Point Check-In — T+2 minutes

Each engineer submits a brief progress report to Morgan after approximately 4 operations used. Morgan acknowledges, redirects if needed, or issues a targeted follow-up question.

```
─── Mid-Point Check-In ────────────────────────────────────────────

Alex (ops used: N/8):
  Status: [e.g. "Found a suspect commit — diffing now" or "Nothing
           suspicious yet in history — broadening to 90-day range"]

Sam (ops used: N/8):
  Status: [e.g. "Traced to service layer — divergence likely in
           resolveCase(); reading next" or "Entry method is thin —
           tracing into the callback chain"]

Jordan (ops used: N/8):
  Status: [e.g. "Pattern #2 matched early — Boolean Flag Not Reset
           confirmed at CaseManager.java:2272" or "No clear pattern
           yet — continuing through lower-priority checks"]

Riley (ops used: N/6):
  Status: [e.g. "Three affected flows identified — the fix direction
           Sam is heading towards would be testable from the UI.
           Flagging one edge case: the cancel path is not covered
           by the replication guide." or "Impact surface is wider
           than expected — two other screens call the same service
           method. Flagging regression risk."]

─── Morgan's Response ─────────────────────────────────────────────

[Morgan reads all four statuses and responds with one of:]

  ✓ On track — continue as assigned.

  ↻ Redirect: [e.g. "Alex, the commit you're looking at is from
    a different branch — check the merge commit instead." or
    "Sam, skip the DAO layer for now — the UI handler is more
    likely; go back and read resolveCase() directly." or
    "Riley, the cancel path concern is valid — make sure you
    have a test scenario for it in your assessment."]

  ⚡ Early call: [e.g. "Jordan, if you've confirmed that pattern
    at line 2272 with code evidence, stop — that's enough. Write
    your hypothesis now and let the others finish."]
────────────────────────────────────────────────────────────────────
```

---

#### 7e. Hypothesis Submission + Testing Assessment — T+4 minutes

All three engineers submit their final hypotheses. Riley submits a Testing Impact Assessment simultaneously. Each entry must fit the template exactly — no unsupported claims.

```
┌─ Alex — History & Regression Hypothesis ───────────────────────┐
│ Root cause   : [precise statement — what Alex believes]          │
│ Evidence     : [commit hash + file:line, or "no suspect commit — │
│                bug was always present since {first commit}"]     │
│ Fix direction: [how the history finding informs the fix]         │
│ Confidence   : High / Medium / Low                               │
│ Certainty    : [1–5 — 5 = would bet my job on it; 1 = educated  │
│                guess with thin evidence]                         │
│ Pattern match: [SAME PAT-NNN / NEW / UNRELATED — from KB 7b-0]  │
│ Ops used     : [N / 8]                                           │
│ Unknowns     : [what git history alone cannot confirm]           │
│ Change my mind: [only present if Certainty ≤ 2 — what specific  │
│                 evidence, if found, would cause Alex to revise]  │
└────────────────────────────────────────────────────────────────────┘

┌─ Sam — Data Flow & Logic Hypothesis ───────────────────────────┐
│ Root cause   : [precise divergence point — what code does vs.    │
│                what it must do]                                   │
│ Evidence     : [file:line — code snippet showing the divergence] │
│ Fix direction: [what change at the divergence point resolves it] │
│ Confidence   : High / Medium / Low                               │
│ Certainty    : [1–5]                                             │
│ Pattern match: [SAME PAT-NNN / NEW / UNRELATED]                  │
│ Ops used     : [N / 8]                                           │
│ Unknowns     : [what flow tracing alone cannot confirm]          │
│ Change my mind: [only if Certainty ≤ 2]                         │
└───────────────────────────────────────────────────────────────────┘

┌─ Jordan — Defensive Patterns Hypothesis ───────────────────────┐
│ Root cause   : [precise statement — what Jordan believes]        │
│ Pattern match: [which pattern(s) from the table matched]         │
│ Evidence     : [file:line + one-line quote of offending code]    │
│ Fix direction: [how eliminating the pattern resolves the issue]  │
│ Confidence   : High / Medium / Low                               │
│ Certainty    : [1–5]                                             │
│ KB pattern   : [SAME PAT-NNN / NEW / UNRELATED — from KB 7b-0]  │
│ Ops used     : [N / 8]                                           │
│ Unknowns     : [what pattern analysis alone cannot confirm]      │
│ Change my mind: [only if Certainty ≤ 2]                         │
└───────────────────────────────────────────────────────────────────┘

┌─ Riley — Testing Impact Assessment ────────────────────────────┐
│ Hypothesis risk  : [which engineer's fix direction, if adopted,  │
│                    poses the highest regression risk — and why]  │
│ Affected flows   : [user flows / screens that must be smoke-     │
│                    tested after any fix in this area; at least   │
│                    the primary path + one adjacent flow]         │
│ Edge cases       : [boundary conditions, null/empty inputs,      │
│                    multi-client data isolation, session boundary  │
│                    states, or concurrent-user scenarios the       │
│                    engineer hypotheses have not addressed]        │
│ Testability      : [can the fix be verified from the UI/API, or  │
│                    does it require DB-level / log confirmation?  │
│                    Flag if the fix direction is not observable]   │
│ Regression risk  : High / Medium / Low                           │
│ Open question    : [one targeted question Riley directs at a      │
│                    specific engineer or Morgan — must be answered │
│                    before a fix is approved]                      │
│ Ops used         : [N / 6]                                        │
└────────────────────────────────────────────────────────────────────┘
```

Riley's assessment is **not scored** — it is advisory. However, any **High regression risk** or unanswered **Open question** must be explicitly addressed by Morgan in the verdict (7h) and Fix Review (8c).

**Certainty gate:** Before proceeding to 7f, check all three Certainty scores. If any engineer rated Certainty ≤ 2, Morgan must explicitly acknowledge their `Change my mind:` statement and either: (a) direct another engineer to run the specific evidence-gathering op that would resolve it (up to 2 additional ops), or (b) accept the uncertainty and note it in the Root Cause Statement `Team note`. A Certainty ≤ 2 vote does not block the panel — it flags a known gap.

---

#### 7e-ii. Adversarial Falsification Round — T+4.5 minutes

After all hypotheses are submitted, Morgan assigns one engineer to actively try to **falsify** each other engineer's hypothesis before the cross-examination. The goal is to surface blind spots the proposing engineer may have missed — not to win points, but to stress-test reasoning before the verdict.

**Assignment (Morgan rotates to avoid self-reinforcement):**
- Alex falsifies Sam's hypothesis
- Sam falsifies Jordan's hypothesis
- Jordan falsifies Alex's hypothesis

Each falsifier has **2 targeted ops maximum** (grep or read — no new full-file reads) to find evidence that contradicts the assigned hypothesis. They respond with one of:

```
─── Falsification Round ───────────────────────────────────────────

Alex → falsifying Sam's hypothesis:
  Target claim: [one sentence from Sam's root cause]
  Attempt: [what Alex looked for to disprove it — file:line or command]
  Result: [one of the following]
    ✅ HOLDS — could not falsify: [why the evidence supports Sam]
    ⚠️ WEAKENED — partial counter-evidence: [what Alex found + why it doesn't fully disprove]
    ❌ FALSIFIED — contradicting evidence: [file:line + what it shows]

Sam → falsifying Jordan's hypothesis:
  [same structure]

Jordan → falsifying Alex's hypothesis:
  [same structure]

─── Morgan's Falsification Summary ────────────────────────────────
  [Morgan reads all three results and notes:]
  - Any hypothesis marked ❌ FALSIFIED is removed from contention (or engineer must revise)
  - Any ⚠️ WEAKENED hypothesis is flagged in the scoring rubric (7h)
  - ✅ HOLDS results increase the surviving hypothesis's score (+1 in Morgan's rubric)
────────────────────────────────────────────────────────────────────
```

If all three results are ✅ HOLDS: state `Adversarial round: all hypotheses survived falsification — proceeding with full confidence.`

Morgan awards **+1 point** (added to 7h scoring) for each hypothesis that survives a genuine falsification attempt. A falsified hypothesis is not automatically disqualified — the proposing engineer may revise it with up to 2 additional ops, then resubmit a corrected hypothesis block.

---

#### 7f. Riley's Questions + Morgan's Cross-Examination — T+5 minutes

Riley poses the **Open question** from the Testing Impact Assessment directly to the named engineer or Morgan. Then Morgan reads all hypotheses and the testing assessment, and poses **1–2 targeted probing questions** to stress-test reasoning. Engineers respond in one paragraph — direct, evidence-backed.

```
─── Riley's Question ──────────────────────────────────────────────

Riley → {Engineer name or Morgan}:
  "[The Open question from Riley's assessment — e.g. 'Sam, your
   fix touches resolveCase() which is also called from the Alert
   Central panel. Have you confirmed that path is not affected?'
   or 'Jordan, you flagged Boolean Flag Not Reset — does the flag
   have the same reset gap on the cancel path, or only on error?']"

{Engineer} responds:
  [Direct answer — one paragraph, backed by file:line evidence
   or explicit acknowledgement if the concern stands unresolved]

─── Morgan's Questions ────────────────────────────────────────────

[Morgan selects the most important uncertainties across the three
hypotheses and Riley's assessment, then asks them directly. Examples:]

  → To Alex: "You say commit abc1234 is responsible. What was the
    stated reason for that change? Was it deliberate removal or
    accidental? Does the commit message or linked ticket clarify?"

  → To Sam: "You found the divergence at resolveCase():2272. Does
    the flag actually exist in scope at that point, or does the fix
    require introducing a new field entirely?"

  → To Jordan: "You matched Boolean Flag Not Reset. Does the flag
    get reset anywhere else in the class — e.g. on cancel or on
    error? Or is this the only path that should set it?"

─── Engineers Respond ─────────────────────────────────────────────

Alex responds: [direct answer — one paragraph, backed by evidence]

Sam responds: [direct answer — one paragraph, backed by evidence]

Jordan responds: [direct answer — one paragraph, backed by evidence]
────────────────────────────────────────────────────────────────────
```

Morgan uses up to **4 additional targeted reads** (beyond the engineers' budgets) to independently verify any claim that cannot be confirmed from the responses alone.

---

#### 7g. Team Debate — One Round

Morgan opens the floor for one round of cross-challenge. Any engineer **or Riley** may mount one challenge. Engineers challenge on code grounds; Riley challenges on impact or testability grounds. The challenged party responds once. Morgan moderates.

```
─── Debate Round ──────────────────────────────────────────────────

[Each challenge must cite specific evidence. Format:]

  {Engineer A or Riley} challenges {Engineer B}:
  "Your hypothesis says X, but I found Y at {file:line} which
  contradicts that because Z. My reading suggests [alternative]."

  — or, from Riley —

  "Your fix direction touches {file/method} which is also called
  from {other screen/flow}. I flagged this in my assessment.
  Without a guard at {location}, this fix will silently break
  {behaviour} for {scenario}. Have you accounted for that?"

  {Engineer B} responds:
  "That's a fair point. [Agree / Disagree because {evidence}].
  My hypothesis [stands / needs refinement: {updated claim}]."

  [Morgan may accept or reject refinements — one sentence each.]

─── Morgan closes debate ──────────────────────────────────────────
  "We have enough. Let me give my assessment."
────────────────────────────────────────────────────────────────────
```

If no one mounts a challenge, state: "No challenges — team and tester accept each other's findings."

---

#### 7h. Morgan's Verdict — T+6 minutes

Morgan weighs all evidence — original hypotheses, responses to questions, and the debate — then delivers a binding verdict. Morgan scores each hypothesis and declares the adopted root cause.

**Scoring rubric** (Morgan applies this to each hypothesis):

| Criterion | Points |
|-----------|--------|
| Specific `file:line` cited with code evidence | +3 |
| Fix direction is clear and immediately actionable | +2 |
| Explains *why* the bug is intermittent (if applicable) | +2 |
| Self-rated High confidence and evidence supports it | +1 |
| Corroborated by another engineer's independent finding | +2 |
| Found efficiently (≤ 5 ops used) | +1 |
| Survived cross-examination without needing revision | +2 |
| Debate challenge successfully deflected with evidence | +1 |
| Fix direction is testable and Riley raised no High regression risk against it | +1 |
| Hypothesis survived adversarial falsification (7e-ii ✅ HOLDS) | +1 |
| Certainty rated 4–5 and evidence justifies it | +1 |

Maximum score: 17 pts. Morgan applies the rubric, declares the highest scorer the winner, then issues a personal assessment — which **must** include a response to Riley's assessment.

```
─── Morgan's Verdict ──────────────────────────────────────────────

Scores:
  Alex   : {N} / 15 pts — [one-line assessment]
  Sam    : {N} / 15 pts — [one-line assessment]
  Jordan : {N} / 15 pts — [one-line assessment]

Tester's view:
  [Morgan addresses Riley's assessment — one to two sentences.
   Must state whether the adopted root cause and fix direction
   address Riley's regression risk and open question. If a High
   severity concern from Riley is unresolved, Morgan must state
   whether it is accepted risk or a blocker for the fix.]

My assessment:
  [Morgan weighs in personally — 2–4 sentences. Morgan may:
   (a) Endorse the highest-scoring hypothesis unchanged
   (b) Refine it: "Jordan's hypothesis is correct but incomplete —
       Sam's flow trace shows the flag is also missing on the
       cancel path, which explains the intermittent reports."
   (c) Override all three: "None of you went deep enough. I ran
       one more read on {file} and found {what Morgan found}."
   Morgan's assessment takes precedence over the score alone.]

Adopted root cause: [the hypothesis Morgan endorses, possibly
                     refined or Morgan's own if override]
────────────────────────────────────────────────────────────────────
```

**Verdict outcomes:**

| Outcome | Block displayed |
|---------|----------------|
| One engineer's score is clearly highest + Morgan agrees | `🏆 BEST ANALYSIS: {Name}` |
| Two or more engineers independently reached the same cause | `🤝 CONSENSUS: {Name} & {Name}` |
| Morgan refined the winning hypothesis | `🏆 BEST ANALYSIS: {Name}` + `📝 Refined by Morgan` note |
| Morgan overrode all three | `⚡ MORGAN OVERRIDE — independent read required` |

```
╔══════════════════════════════════════════════════════════════════╗
║  🏆  BEST ANALYSIS: {Engineer Name}        Score: {N} / 15 pts  ║
║  Reason: {One sentence — why this analysis was superior}         ║
║  Morgan: "{One sentence endorsement or refinement note}"         ║
║  Riley:  "{One sentence — tester concern status: resolved /      ║
║            accepted risk / flagged for fix review}"              ║
╚══════════════════════════════════════════════════════════════════╝
```

---

#### 7i. Root Cause Statement — Team Sign-Off

Produce the final root cause statement — authored by the winning engineer and approved by Morgan. This anchors Step 8.

```
ROOT CAUSE STATEMENT
────────────────────────────────────────────────────────────────────
Author    : {Winning Engineer Name}  |  Approved by: Morgan
Location  : {file:line}
Mechanism : [How the bug manifests — precise, code-level description]
Trigger   : [What user action or system event makes it observable]
Fix dir.  : [One sentence on the correct fix — detail in Step 8]
Confidence: High / Medium / Low
Team note : [Optional — one sentence capturing any nuance raised in
             the debate that the fix author must not overlook]
Tester note: [Riley's key concern or confirmation — e.g. "Regression
              risk on Alert Central resolve path — must be smoke-tested
              after fix applied" or "Fix is UI-observable; no DB
              verification required" — omit if no concern outstanding]
────────────────────────────────────────────────────────────────────
```

If overall confidence is **Low** after Morgan's verdict (no clear root cause even after debate), **stop and present the competing hypotheses to the developer**. In headless mode, proceed with the highest-scoring hypothesis and flag the ambiguity explicitly.

---

#### 7h-ii. Henk's Check-in — Business Necessity & Client Value

After Morgan issues the verdict, Morgan consults Henk to validate the adopted root cause from a business and client perspective before proceeding to the fix.

Henk draws on first-hand system knowledge to answer two questions:
1. **Is this a genuine defect?** — Does the described behaviour contradict a known business rule, or could it be expected behaviour under certain client configurations?
2. **Does fixing it bring value?** — Which existing clients are affected, and is the effort of a fix justified by the impact?

```
─── Henk's Check-in ──────────────────────────────────────────────

Business necessity : [Is the adopted root cause a true defect under the system's
                     business rules? State the relevant rule or long-standing
                     precedent from system history. "Expected behaviour" is a
                     valid finding — state it explicitly if so.]
Client value       : [Which client segment or workflow is affected?
                     Does a fix deliver tangible, observable improvement?
                     Flag if the impact is limited to edge cases only.]
Verdict            : ✅ PROCEED / ⚠️ QUESTION / ❌ CHALLENGE
  [One sentence — Henk's overall position.
   ✅ PROCEED  — fix is warranted; proceed to Step 8.
   ⚠️ QUESTION — scope or necessity is uncertain; Morgan must acknowledge
                  and address before proceeding (note in Root Cause Statement
                  team note field).
   ❌ CHALLENGE — fix conflicts with a known business rule or brings no
                  client value; Morgan must decide whether to proceed with
                  explicit justification or stop for developer clarification.]
────────────────────────────────────────────────────────────────────
```

**If Henk returns ⚠️ QUESTION or ❌ CHALLENGE:** Morgan must respond in one sentence — either addressing Henk's concern or stating accepted justification — before proceeding. In headless mode, record Morgan's response in the Root Cause Statement `Team note` field.

---

### Step 8 — Propose the Fix

Use the analysis from Step 7 as the mandatory anchor:
- **Bug tickets** — anchor to the Root Cause Statement from Step 7i (authored by the winning engineer, approved by Morgan). Every proposed change must directly address the mechanism stated there.
- **Enhancement tickets** — anchor to the Enhancement Statement from Step 7-ENH-d. Every proposed change must directly implement an insertion point listed there.

#### 8a. Proposed Solution
- Open by quoting the analysis anchor — the Root Cause Statement (bug tickets) or Enhancement Statement (enhancement tickets) — verbatim; do not paraphrase
- Describe the approach in plain language before showing any code
- Show **only the code that needs to change** (diff-style or clear before/after blocks)
- Annotate each change with: *"This addresses the [mechanism / insertion point] identified in Step 7"*
- If the Step 7 Team Note (bug) or Step 7-ENH confidence note (enhancement) flagged a nuance, confirm it is handled by the proposed fix

#### 8b. Alternative Approaches Considered

For each alternative considered and rejected, provide a brief entry:

| Alternative | Why rejected |
|-------------|-------------|
| {approach} | {reason — e.g. higher risk, side effects, does not address root cause mechanism} |

If only one viable approach exists, state: "No viable alternatives identified — single fix path confirmed."

#### 8c. Morgan Reviews the Proposed Fix

Before applying anything, Morgan vetted the proposed fix against the adopted root cause. Morgan checks:

1. **Mechanism alignment** — does the fix directly address the mechanism stated in the Root Cause Statement?
2. **Surgical scope** — is the fix minimal? Does it avoid touching code unrelated to the root cause?
3. **Regression risk** — does the fix introduce any new null risks, flag side effects, or break the complementary code path?
4. **Team note honoured** — if a nuance was flagged in Step 7i, is it handled?
5. **DB safety** *(skip if no schema change included)* — is the change safe on both Oracle and PostgreSQL?
6. **Abstract class ownership** *(skip if no new fields, methods, or getters/setters added to a concrete class)* — confirm whether the abstract base is the correct owner. Run `grep "extends {AbstractBase}" --include="*.java"` to list siblings. Only `getConfig()` registrations and `setAttribute()` switch cases are concrete-class concerns; everything else belongs in the abstract base when a suitable one exists.
7. **Tester concerns** *(skip if Riley raised no High or Medium concerns in Step 7e)* — for each High/Medium concern, confirm the fix addresses it or state accepted risk and why.
8. **Henk's view** — does the proposed fix align with known business rules and client expectations? Is the change genuinely additive or does it risk altering behaviour that clients rely on? *(Skip if Henk returned ✅ PROCEED in Step 7h-ii with no caveats.)*

```
─── Morgan's Fix Review ───────────────────────────────────────────

Mechanism alignment      : [Confirmed / Issue: {what is misaligned}]
Surgical scope           : [Confirmed — N files, M lines changed /
                            Concern: {what is unnecessarily wide}]
Regression risk          : [Low — no new risks introduced /
                            Flag: {specific risk Morgan identified}]
Team note honoured       : [Yes / Not applicable / No — {what is missing}]
DB safety                : [Confirmed / N/A — no schema change /
                            Issue: {dialect problem spotted}]
Abstract class ownership : [N/A — no new fields or methods added /
                            Confirmed — concrete class is correct owner /
                            Moved to {AbstractBase} — {N} sibling subclasses
                            benefit; config wiring stays in concrete class]
Tester concerns          : [N/A — no High or Medium concerns raised /
                            Resolved — {Riley's concern} is addressed by
                            {specific change in the fix} /
                            Accepted risk — {Riley's concern} is not
                            addressed; accepted because {reason}]
Henk's view              : [N/A — Henk returned ✅ PROCEED with no caveats /
                            Confirmed — fix aligns with business rules and
                            client expectations /
                            Note: {Henk's caveat from 7h-ii and how the fix
                            addresses it or accepted justification}]

Morgan's verdict:
  ✅ APPROVED — fix is correct, surgical, and safe to apply.

  — or —

  ⚠️  APPROVED WITH CONDITIONS — apply after addressing:
     [{specific condition Morgan requires before applying}]

  — or —

  🔄 REWORK REQUIRED — [{reason}]. Suggested direction:
     [{Morgan's suggested fix approach — one paragraph}]
────────────────────────────────────────────────────────────────────
```

**If Morgan returns REWORK REQUIRED:**
- Revise the proposed solution in 8a to address Morgan's direction
- Re-run Morgan's review (8c) against the revised fix
- Do not proceed to 8d until Morgan's verdict is Approved or Approved with Conditions

#### 8d. Apply Fix to Feature Branch (Interactive)

After Morgan approves the fix, ask the developer:

> **Would you like me to apply these changes to the feature branch now?**
> - `yes` — apply all proposed changes directly to the files on the current feature branch
> - `no` — skip; the developer will apply manually
> - `partial` — ask which specific changes to apply

If the developer answers **yes** or **partial**:
- Use the Edit tool to apply changes to each identified file
- After each file is modified, confirm: "Applied change to `{file}:{line}`"
- Do NOT commit — leave the changes staged for the developer to review and commit using the suggested message from Step 10c

If the developer answers **no**, continue to Step 9 without modifying any files.

#### 8e. DB Migration (if needed)
If the fix requires schema changes, provide the upgrade script template:
```sql
-- v1.XX.XXX.sql / .pg
-- IV-XXXX: <description>
ALTER TABLE ...
```

---

### Step 9 — Impact Analysis

**Context pruning** — before beginning Step 9, explicitly summarise the Engineering Panel output down to its essential residue for the remaining steps. The verbatim debate, cross-examination, and scoring are preserved in the PDF and do not need to remain active in the context window:

> *Panel summary retained for Steps 9–12: Root Cause Statement + Team Note + Morgan's Fix Review verdict. Full panel transcript is in the PDF.*

This keeps the context window lean for the grep-heavy impact analysis steps.

Assess the full consequences of the proposed fix across the entire application. This step requires active codebase searching — do not rely on assumptions. Use Grep to find every reference to changed symbols before drawing conclusions.

#### 9a. Files Changed
List every file touched by the fix with a one-line description of what changed and why:

| File | Change | Reason |
|------|--------|--------|
| `fcfrontend/.../CaseManager.java` | Added `pendingAlertResolve` flag and async callback chain | Core fix for alert resolution |
| `fcbuild/scripts/upgrades/v1.XX.XXX.sql` | New table / column | Schema required for fix |

#### 9b. Usage Reference Search (mandatory)

For **every method, class, field, or API endpoint** modified by the fix, search the full codebase for all callers and references:

```
Grep: {modified method or class name} → across {REPO_DIR}/
```

For each symbol changed, produce a reference table:

| Symbol Changed | Type | Callers / References Found | Files |
|----------------|------|---------------------------|-------|
| `resolveAlertCentral(...)` | method | 3 callers | `CaseManager.java`, `AlertCentral.java`, `CaseDetailsPanel.java` |
| `pendingAlertResolve` | field | local to `CaseManager` | `CaseManager.java` only |

Rules:
- If a changed method is `private` — **skip the codebase-wide grep**; confirm it is only called within the same class (one targeted read). Do not search the full repo for private symbols — it is redundant and wastes ops.
- If a changed method is `package-private` (no modifier in Java) — grep only within the same package directory, not the full repo.
- If a changed method is `public` or `protected` — grep only the modules likely to call it, derived from the Step 5 file map (e.g. if the fix is in `fcfrontend/`, search `fcfrontend/` and `fcbuild/` first; only expand to the full repo if references are found that suggest broader coupling).
- If a changed interface or abstract method — find all implementing classes.
- If a DB column or table is changed — grep for all SQL references and ORM mappings to that table/column.
- If a GWT RPC service method signature changes — find all client call sites and the corresponding server-side implementation.

#### 9c. Application-Wide Impact

Based on the usage reference search, describe the impact across each application layer:

| Layer | Impact | Detail |
|-------|--------|--------|
| GWT Frontend | e.g. Medium | `CaseManager` change affects resolve flow; 2 other panels call same service |
| Backend API | e.g. Low | No API signature change; internal logic only |
| Plugin / Workers | e.g. None | No worker classes reference changed code |
| DB / Schema | e.g. High | Column rename affects 4 SQL queries across 3 upgrade scripts |
| Shared Utilities | e.g. Low | `RecordHelper` change only affects timed-wait resume path |

If a layer is not affected, state "None — confirmed by grep (0 references found)."

#### 9d. Regression Risks
For each change, identify what existing behaviour could break:
- Which existing flows pass through the modified code?
- Could the DB change affect existing data or other screens that read the same table?
- Flag any race conditions, null pointer risks, or async timing concerns introduced
- Flag any callers found in 9b that may behave differently after the change

#### 9e. Affected Clients / Environments
State whether the fix is:
- **Generic** — affects all clients running this version
- **Client-specific** — only affects a named client (e.g. FNB, VCL, DRC) due to config or data differences
- **DB-specific** — behaviour differs between Oracle and PostgreSQL implementations

#### 9f. Related Areas to Retest
List screens, flows, or features outside the primary fix that should be smoke-tested — derived from the callers found in 9b:
- e.g. "Alert Central resolve button should still work independently"
- e.g. "Case Details tab resolve should behave the same as All Cases tab"

#### 9g. Risk Level

Rate the overall risk of the change based on the usage reference search results:

| Rating | Criteria |
|--------|----------|
| **Low** | Change is isolated; 0–1 callers found; no shared utilities or DB touched; easy to revert |
| **Medium** | 2–5 callers found; touches shared logic or a secondary screen; regression testing recommended |
| **High** | 6+ callers found; modifies a public API, shared utility, or DB schema; thorough QA required before release |

State the rating prominently:

> **Risk Level: Medium** — 3 callers of `resolveAlertCentral` found across 2 screens; existing Alert Central resolve path must be retested.

---

### Step 10 — Change Summary

Produce a concise, developer-friendly summary of everything that was done. This serves as a reference for commit messages, PR descriptions, and handover notes.

#### 10a. Files Touched

List every file modified, created, or deleted by the fix:

| File | Action | Summary of Change |
|------|--------|-------------------|
| `fcfrontend/.../CaseManager.java` | Modified | Added alert resolution chain triggered on case resolve |
| `fcbuild/scripts/upgrades/v1.XX.XXX.sql` | Created | Added new table `B_TR_TASK_RESPONSES` |

#### 10b. What Was Changed and Why

For each file, one short paragraph explaining:
- What was changed (the what)
- Why it was necessary to make this change (the why)
- Any notable decisions or trade-offs made

#### 10c. Suggested Commit Message

Provide a ready-to-use commit message following the project convention:

```
{VERSION}_{TICKET_KEY} {Short description of fix}

- {Bullet point of key change 1}
- {Bullet point of key change 2}
```

Example:
```
IV3672_Resolving_Cases_should_Resolve_Alerts_1.26.064 IV3672 Mustakeem Lee

- Added pendingAlertResolve flag to trigger alert resolution after case save
- Added ScreenCallBackAlertsForResolve to fetch and filter unresolved alerts
- Added ScreenCallBackResolveAlerts to finalise resolution via resolveAlertCentral
```

#### 10d. PR Description Template

Provide a ready-to-paste pull request description:

```
## {TICKET_KEY} — {Ticket Summary}

**Jira:** {JIRA_URL}/browse/{TICKET_KEY}
**Branch:** {feature branch name}
**Base:** {base branch}
**Risk:** {Low / Medium / High} — {one-line justification from Step 9g}

---

## Root Cause
{Root Cause Statement from Step 7d — location, mechanism, trigger}

## What changed
{One paragraph describing the fix — the what and the why}

## Files changed
{Files touched table from Step 10a — abbreviated to file name and one-line summary}

## How to test
{Reproduction steps from Step 6b, rewritten as a verification checklist}

## Retest areas
{Retest checklist from Step 9f}

## DB migration required
{Yes — run v1.XX.XXX.sql/.pg before deploying | No}
```

---

### Step 11 — Session Stats

Retrieve actual token usage from Claude Code's local logs via codeburn, then print the summary line.

**1. Run these two commands:**

```bash
npx --yes codeburn@latest report --from $(date +%Y-%m-%d) --to $(date +%Y-%m-%d) --format json 2>/dev/null
```

```bash
cat /tmp/.prx-session-start-spend 2>/dev/null || echo "none"
```

**2. Compute this session's cost** — `overview.cost` from the first command minus `overview.cost` from the baseline file (second command). If the baseline file is missing, use the full daily total as the session cost.

**3. Print the summary line:**

If codeburn data is available:
```
{TICKET_KEY} | ~{N}m elapsed | ${session_cost} this session (${daily_total} today) | {input_tokens} in / {output_tokens} out (Sonnet 4.6)
```

If codeburn is unavailable (npx not found or command fails), fall back to manual estimation from the volume of content processed (Jira fields, attachments, file reads, analysis). Label estimates with `~`:
```
{TICKET_KEY} | ~{N}m elapsed | ~{X} in / ~{Y} out tokens | est. cost ${Z} (Sonnet 4.6)
```

Manual estimation pricing reference (Sonnet 4.6, fallback only):
- Input: $3.00 / 1M tokens
- Output: $15.00 / 1M tokens

---

### Step 12 — Generate PDF Analysis Report

After Step 10 is complete, generate a full PDF report of the analysis and save it to disk.

#### 12a. Configuration

Resolve the output folder using this priority order:

1. If the environment variable `CLAUDE_REPORT_DIR` is set, use it
2. Otherwise default to: `$HOME/.prevoyant/reports/`

```bash
REPORT_DIR="${CLAUDE_REPORT_DIR:-$HOME/.prevoyant/reports}"
mkdir -p "$REPORT_DIR"
REPORT_SUFFIX="${CLAUDE_REPORT_SUFFIX:-}"
REPORT_BASE="{TICKET_KEY}-analysis"
[ -n "$REPORT_SUFFIX" ] && REPORT_BASE="${REPORT_BASE}-${REPORT_SUFFIX}"
```

> **Filename rule:** The base output name is `{TICKET_KEY}-analysis` (or `-review` in PR Review mode). When `CLAUDE_REPORT_SUFFIX` is set (injected by Prevoyant Server when replaying a ticket that already has a report), append it: e.g. `{TICKET_KEY}-analysis-20260423-112530`. Use `$REPORT_BASE` for all output paths. The dashboard scans for any file matching `{TICKET_KEY}-*.(pdf|html)` so every version remains visible.

**PDF tool pre-check** — before generating Markdown, verify which conversion method is available and report it upfront rather than discovering failures at conversion time:

```bash
PDF_METHOD=""
if command -v pandoc &>/dev/null; then
  PDF_METHOD="pandoc"
elif ls "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" &>/dev/null \
     || command -v google-chrome &>/dev/null \
     || command -v chromium &>/dev/null; then
  PDF_METHOD="chrome"
else
  PDF_METHOD="html-fallback"
fi
echo "PDF method: $PDF_METHOD"
```

State the detected method before proceeding. If `html-fallback`, warn the developer immediately:
> "⚠️ Neither pandoc nor Chrome found — report will be saved as HTML. Install pandoc (`brew install pandoc`) or Chrome to enable PDF output."

#### 12b. Generate Markdown Source

Write `/tmp/{TICKET_KEY}-analysis.md`. Reproduce every step's full output — no summaries, truncation, or omissions. Placeholders below are structural guides; replace each with the actual step content.

````
# {TICKET_KEY} — {Ticket Summary}

| Field | Value |
|-------|-------|
| Date | {today's date} |
| Analyst | Claude (Prevoyant v1.2.3) |
| Ticket type | {Bug / Story / Enhancement} |
| Priority | {priority} |
| Status | {status} |
| Branch | {feature branch name} |
| Base branch | {base branch} |

---

## Step 1 — Jira Ticket

| Field | Value |
|-------|-------|
| Key | {TICKET_KEY} |
| Summary | {summary} |
| Type | {issuetype} |
| Priority | {priority} |
| Status | {status} |
| Assignee | {assignee} |
| Reporter | {reporter} |
| Labels | {labels or "None"} |
| Components | {components or "None"} |
| Fix Version(s) | {fixVersions or "Not set"} |
| Affected Version(s) | {versions or "Not set"} |

### Description

{Full ticket description text — verbatim, preserving all formatting}

### Attachments

{List each attachment by name and type, or "No attachments"}

---

## Step 2 — Problem Understanding

### Problem Statement

**Ticket classification:** {Bug (defect) / Story (enhancement)}

| Dimension | Detail |
|-----------|--------|
| What is broken / missing | {1–2 sentences} |
| Who is affected | {users / roles / clients} |
| Expected behaviour | {what should happen} |
| Actual behaviour | {what currently happens} |
| Acceptance criteria | {bulleted list from ticket} |

{If enhancement, include: "This is an enhancement — the system currently lacks X; we need to add Y."}

### Linked & Associated Tickets

{For each linked ticket: "[KEY] (type, status) — one-sentence relevance and any additional context extracted."
If no linked tickets: "No linked tickets found."
If linked tickets exist but provide no new context: "No additional context from linked ticket [KEY]."}

### Associated PRs (from Linked Tickets)

{Each associated PR: title, status, branch, merge date, one-sentence relevance, code change summary (files, what/why from PR description).
If none: "No associated PRs found."}

### Attachment Analysis

{For each attachment analysed: name, type, and key findings extracted.
If no attachments: "No attachments — analysis skipped."}

### Issue Diagram

{If a draw.io diagram was generated: "Issue diagram generated — see embedded diagram below." Include diagram source or note path.
If skipped: "Diagram skipped — single-file change / no complex data flow identified."}

---

## Step 3 — Comments & Context

### Comment Summary

{Bulleted list of key points from each comment — clarifications from reporter/PO, decisions made, constraints, related tickets, partial fixes.
If no comments: "No comments on ticket — proceeding from description only."}

### Prior Investigation Summary

{Prior Investigation Summary block from Step 3 (root cause, files, attempts, confirmed/unconfirmed, unknowns).
If none: "No prior investigation found in comments."}

---

## Step 4 — Development Branch

| Field | Value |
|-------|-------|
| Base branch | {base branch name} |
| Base branch source | {Fix Version / Affected Version / default: development} |
| Feature branch | {Feature/TICKET_KEY_Title} |
| Branch status | {Created and checked out / Skipped (headless mode)} |

---

## Step 5 — Locate Affected Code

### File Map

| File | Role | Key Location | Recent Git History |
|------|------|-------------|-------------------|
{Reproduce the complete file map table row by row}

**Confidence:** {High / Medium / Low} — {one-line reason}

### Class Hierarchy Analysis

{If performed (mandatory for enhancements adding fields/methods):

  Target class    : {ClassName}
  Extends         : {AbstractBase or "No abstract base"}
  Sibling classes : {list from grep, or "None found"}
  Decision        : {New infrastructure placed in AbstractBase / Concrete class is correct owner — no siblings benefit}

If not applicable: "Class hierarchy check not required — no new fields or methods added."}

---

## Step 6 — Replication Guide

### Prerequisites

{List of required preconditions — user role, test data, feature flags, environment config, etc.}

### Environment

{Which environment to use and any specific setup required}

### Replication Steps

{Numbered step-by-step list to reproduce the issue or trigger the missing feature}

### Expected vs Actual

| | Detail |
|---|--------|
| **Expected** | {what should happen} |
| **Actual** | {what currently happens} |

**Confidence:** {High / Medium / Low} — {one-line reason}

### Service Restart Guidance

{Which services need restarting after a fix is applied, in order — Plugin spawner, backend, GWT frontend, or "Frontend-only / Backend-only change" as applicable}

---

## Step 7 — Root Cause Analysis

{--- FOR BUG TICKETS: reproduce the full Engineering Panel session ---}

### 7a. Decision Tree Classification

**Path:** `{e.g. BUG → UI ISSUE → Service call fails silently}`

### 7b. Morgan's Lead Briefing

{Morgan lead briefing from Step 7b}

### 7c. Investigation — Mid-Point Check-In (T+2)

{Mid-point check-in from Step 7c (Alex, Sam, Jordan, Riley statuses + Morgan's response)}

### 7d. Hypothesis Submission (T+4)

{All 4 hypothesis boxes from Step 7d (Alex, Sam, Jordan, Riley)}

### 7e. Riley's Question + Morgan's Cross-Examination (T+5)

{Cross-examination from Step 7e (Riley's question + engineer response; Morgan's questions + all responses)}

### 7f. Team Debate

{Team debate from Step 7f (each challenge, response, Morgan's close). If no challenges: state so.}

### 7g. Morgan's Verdict (T+6)

{Morgan's verdict from Step 7g (score table, tester's view, personal assessment, adopted root cause, outcome box)}

### 7h. Root Cause Statement

{Root Cause Statement from Step 7h (all fields)}

{--- FOR ENHANCEMENT TICKETS: reproduce the Enhancement Direct Analysis ---}

### Enhancement Statement

{Enhancement Statement from Step 7-ENH (all fields)}

---

## Step 8 — Proposed Fix

### Analysis Anchor

{Reproduce the Root Cause Statement (bug) or Enhancement Statement (enhancement) verbatim — the anchor quoted at the top of the fix}

### 8a. Proposed Solution

{Reproduce the full solution narrative — approach description in plain language, then every before/after code block with annotations}

### 8b. Alternative Approaches Considered

| Alternative | Why rejected |
|-------------|-------------|
{Reproduce each row, or "No viable alternatives identified — single fix path confirmed."}

### 8c. Morgan's Fix Review

{Morgan's Fix Review from Step 8c (all 7 checks + verdict)}

### 8d. DB Migration Scripts

{If schema changes required, reproduce full Oracle (.sql) and PostgreSQL (.pg) scripts.
If not required: "No schema changes — DB migration not required."}

---

## Step 9 — Impact Analysis

### 9a. Files Changed

| File | Change | Reason |
|------|--------|--------|
{Reproduce the complete files-changed table}

### 9b. Usage Reference Search

{Reproduce the full symbol reference table — every changed symbol with type, callers found, and files}

### 9c. Application-Wide Impact

| Layer | Impact | Detail |
|-------|--------|--------|
{Reproduce the complete impact table — GWT Frontend, Backend API, Plugin/Workers, DB/Schema, Shared Utilities}

### 9d. Regression Risks

{Bulleted list of regression risks identified — flows affected, null risks, async timing concerns, flag side effects}

### 9e. Affected Clients / Environments

**Scope:** {Generic — all clients / Client-specific: {name} / DB-specific: Oracle vs PostgreSQL}

{Explanation of why this scope applies}

### 9f. Related Areas to Retest

{Bulleted list of screens, flows, or features to smoke-test after the fix — derived from the caller search}

### 9g. Risk Level

**Overall risk:** {Low / Medium / High}

{One paragraph justifying the risk rating}

---

## Step 10 — Change Summary

### Summary of Changes

{Bulleted summary of every change made — file, what changed, and why}

### Suggested Commit Message

```
{Full commit message block — subject line + body}
```

### Pull Request Description

{Reproduce the full PR description template — Summary bullets, Test plan checklist, labels, risk level}

---

## Step 11 — Session Statistics

| Metric | Value |
|--------|-------|
| Steps completed | {N / 12} |
| Elapsed time | {HH:MM} |
| Estimated token count | {N tokens} |
| Estimated cost (Sonnet 4.6) | {$X.XX} |
| Ticket type | {Bug / Enhancement} |
| RCA path | {Engineering Panel / Direct Analysis (7-ENH)} |
| Fix applied to branch | {Yes / No / Partial} |

````

#### 12c. Convert to PDF

Try each method in order, stopping at the first that succeeds. These methods work reliably on macOS, Linux, and Windows without platform-specific library dependencies.

**Method 1 — `pandoc` (preferred, best cross-platform support):**

Check if pandoc is available:
```bash
which pandoc        # macOS / Linux
where pandoc        # Windows
```

If available, convert directly from Markdown to PDF:
```bash
pandoc /tmp/{TICKET_KEY}-analysis.md \
  -o "${REPORT_DIR}/${REPORT_BASE}.pdf" \
  --pdf-engine=wkhtmltopdf \
  -V geometry:margin=2cm \
  -V fontsize=11pt
```

If `wkhtmltopdf` is not available, try the HTML intermediary instead:
```bash
pandoc /tmp/{TICKET_KEY}-analysis.md \
  -o /tmp/{TICKET_KEY}-analysis.html \
  --standalone --metadata title="{TICKET_KEY} Analysis"
```
Then proceed to Method 2 to print the HTML to PDF.

> **Install pandoc:** https://pandoc.org/installing.html — available via `brew install pandoc` (macOS), `apt install pandoc` (Linux), or the Windows installer.

**Method 2 — Chrome / Chromium headless (no install required if Chrome is present):**

Check for a browser:
```bash
# macOS
which google-chrome || which chromium || \
  ls "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" 2>/dev/null

# Linux
which google-chrome || which chromium-browser || which chromium

# Windows (PowerShell)
where chrome
```

First convert the Markdown to a styled HTML file:
```python
python3 -c "
import markdown2, pathlib
md = pathlib.Path('/tmp/{TICKET_KEY}-analysis.md').read_text()
html = '''<!DOCTYPE html><html><head><meta charset=\"utf-8\">
<style>
  body{font-family:Segoe UI,Arial,sans-serif;margin:40px;line-height:1.7;color:#222}
  h1{color:#1a1a2e}h2{color:#16213e;border-bottom:1px solid #ddd;padding-bottom:4px}
  pre{background:#f4f4f4;padding:12px;border-radius:4px;overflow-x:auto}
  code{background:#f4f4f4;padding:2px 5px;border-radius:3px}
  table{border-collapse:collapse;width:100%}
  th,td{border:1px solid #ccc;padding:8px;text-align:left}
  th{background:#f0f0f0}
  blockquote{border-left:4px solid #ccc;margin:0;padding-left:16px;color:#555}
</style></head><body>''' + markdown2.markdown(md, extras=['fenced-code-blocks','tables','strike']) + '</body></html>'
pathlib.Path('/tmp/{TICKET_KEY}-analysis.html').write_text(html)
"
```

Then print to PDF using Chrome headless:
```bash
# macOS
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless --no-sandbox --disable-gpu \
  --print-to-pdf="${REPORT_DIR}/${REPORT_BASE}.pdf" \
  "file:///tmp/{TICKET_KEY}-analysis.html"

# Linux
google-chrome --headless --no-sandbox --disable-gpu \
  --print-to-pdf="${REPORT_DIR}/${REPORT_BASE}.pdf" \
  "file:///tmp/{TICKET_KEY}-analysis.html"

# Windows (PowerShell)
& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --headless --disable-gpu `
  --print-to-pdf="${REPORT_DIR}\${REPORT_BASE}.pdf" `
  "file:///C:/Users/$env:USERNAME/AppData/Local/Temp/{TICKET_KEY}-analysis.html"
```

**Method 3 — HTML fallback** (if neither pandoc nor Chrome are available):

Save the styled HTML file produced in Method 2 directly to the report folder:
```bash
cp /tmp/{TICKET_KEY}-analysis.html "${REPORT_DIR}/${REPORT_BASE}.html"
```

Inform the developer:
> "PDF generation unavailable (pandoc and Chrome not found). Report saved as HTML instead. Open in any browser and use File → Print → Save as PDF to convert manually."

#### 12d. Archive and Confirm

After saving, display the following to the developer (always show both the folder and the full file path):

```
📄 Analysis Report Generated
   Folder : {REPORT_DIR}/
   File   : ${REPORT_DIR}/${REPORT_BASE}.pdf
   Format : PDF  ← (or "HTML (PDF libraries unavailable)" if Method 3 was used)
```

#### 12e. Email Report

After the report is confirmed saved, send it by email if `PRX_EMAIL_TO` is set.

Resolve the path to `send-report.py` relative to this skill file. The script lives at `scripts/send-report.py` in the plugin repository root. Determine the repo root by running:

```bash
# macOS / Linux
python3 "$(dirname "$(dirname "$(dirname "$0")")")/scripts/send-report.py" \
  "{TICKET_KEY}" "${REPORT_DIR}/${REPORT_BASE}.pdf" "PDF"

# Windows (PowerShell) — use the absolute path resolved at Step 0
python scripts\send-report.py "{TICKET_KEY}" "${REPORT_DIR}\${REPORT_BASE}.pdf" "PDF"
```

If the report was saved as HTML (Method 3 fallback), pass `"HTML"` as the third argument and the `.html` path instead.

The script reads all SMTP configuration from environment variables — no arguments needed beyond the three above. It handles its own error reporting:

| Output line | Meaning |
|-------------|---------|
| `EMAIL_SKIP: ...` | `PRX_EMAIL_TO` not set — skip silently, no error |
| `EMAIL_SENT: ...` | Email delivered successfully |
| `EMAIL_ERROR: ...` | Configuration or connection problem — log the message, do not block the session |

A failed email is **never a blocking error**. Log the `EMAIL_ERROR` line and continue to Step 12f.

After a successful send, append to the confirmation block:

```
📧 Report emailed to {PRX_EMAIL_TO}
```

#### 12f. Temp File Cleanup

After the report is confirmed saved and email (if configured) has been attempted, remove the intermediate temp files:

```bash
rm -f /tmp/{TICKET_KEY}-analysis.md /tmp/{TICKET_KEY}-analysis.html
```

If removal fails, note it but do not treat it as a blocking error.

Then end with:

> **Ready to code.** Branch is created. Start with `{primary file}:{line number}`. Refer to Step 10 for the change summary and suggested commit message when done.

---

### Step 13 — Knowledge Base: Record Learnings

After Step 12 confirms the PDF has been saved, update the knowledge base with everything learned during this session. This step makes the team smarter for the next ticket.

#### 13a. Identify What Is Worth Recording

Scan the **full session output** (all steps) and extract knowledge from two sources:

**Source 1 — `[KB+]` inline annotations** (primary source — collect every marker emitted during the session):

Scan all agent output (Steps 5, 7, 8, 9) for `[KB+]` markers. Each marker is a candidate entry. Morgan reviews the full list and confirms which are genuinely new (not already in the Prior Knowledge block) before writing.

| Marker | Writes to |
|--------|-----------|
| `[KB+ BIZ]` | `shared/business-rules.md` |
| `[KB+ ARCH]` | `shared/architecture.md` |
| `[KB+ PAT] ... [NEW]` | `shared/patterns.md` (new entry, Frequency: 1) |
| `[KB+ PAT] ... [BUMP]` | `shared/patterns.md` (increment existing Frequency) |
| `[KB+ RISK]` | `shared/regression-risks.md` |

**Source 2 — Structured session extracts** (fallback — anything not already captured by `[KB+]` markers):

| Category | Source | What to extract |
|----------|--------|----------------|
| **Root cause / fix** | Step 7i or Step 7-ENH-d | The root cause mechanism, affected file:line, fix applied |
| **Business rules** | Steps 2, 3, 7 | Any domain behaviour that was clarified or confirmed but not yet annotated |
| **Architecture insights** | Steps 5, 7 | Class hierarchy decisions, data flow understanding, ownership rules |
| **Recurring patterns** | Jordan's findings in Step 7 | Which of Jordan's 20 patterns appeared — check against KB to confirm NEW vs BUMP |
| **Regression risks** | Riley's assessment in Steps 7e, 9d | Areas flagged as fragile or widely coupled in Step 9 |
| **Historical JIRA precedents** | Step 7b-i (Morgan's JIRA search) | Any business rule or architecture insight discovered in past closed tickets |
| **Related tickets** | Steps 2, 3, 7b-i | Linked tickets and historical JIRA matches that provided context |

Morgan de-duplicates across both sources — if a `[KB+]` marker and a structured extract describe the same thing, write one entry, not two.

If no new knowledge was found beyond what is already in the KB (e.g. this ticket was very simple with no novel insights), do not skip Step 13 entirely. Instead:
1. Write the ticket entry (13b) — every ticket is worth recording.
2. For each CMM entry that was read during Step 0b and verified as still accurate during the session, emit `[CMM+ ... CONFIRM]` and increment its `confirmed:` counter (Step 13g). Confirmations are a first-class contribution — they signal to future agents that this fact has been independently verified multiple times.
3. State: "No new discoveries — confirming {N} Core Mental Map entries verified against live code."

**A session that writes nothing to the KB — not even a confirmation — is a missed compounding opportunity.** The only exception is if the KB was inaccessible (KB_ERROR in Step 0a).

#### 13b. Write the Ticket Entry

Create or overwrite `{KNOWLEDGE_DIR}/tickets/{TICKET_KEY}.md` using the ticket entry format defined in the Knowledge Base section above. Populate every field — do not leave any section blank; use "None" if genuinely empty.

#### 13c. Update Shared Files

For each extracted item:

**Business rules** (`shared/business-rules.md`):
- Grep the file for the rule's key terms. If an existing entry covers it: append `Confirmed by: {TICKET_KEY} ({today})` to that entry. If it is genuinely new: append a new entry at the bottom following the established format.

**Architecture insights** (`shared/architecture.md`):
- Grep for the class or component name. If an entry exists: update it with new detail (edit the relevant lines). If new: append a new entry.

**Patterns** (`shared/patterns.md`):
- Grep for the pattern name or Jordan pattern number. If an existing entry matches: increment `Frequency: N → N+1` and append `{TICKET_KEY} ({today})` to the Recurrences list. If new: append a new entry with `Frequency: 1`.

**Regression risks** (`shared/regression-risks.md`):
- Grep for the area (class name, method name, or layer). If an existing risk covers it: append the new ticket reference to confirm the risk is still current. If new: append a new entry.

**Stale reference auto-heal** — for every `shared/*.md` entry that contains a `file:line` reference, validate and heal as follows (opportunistically, using only files already read or grepped during this session to avoid extra ops):

> **If the Step 0a sweep ran in graph-aware mode** (`graph.json` present + `graphify` installed), prefer its already-collected `STALE_REF` and `RELOCATED_REF` lists — they're symbol-level accurate. Use the grep walk below only as a fallback or as a confirmation pass for entries the graph couldn't resolve.

```
For each file:line reference encountered in KB entries:
  1. graphify query "node at {file}:{line}" --graph "$REPO_DIR/graph.json"   (preferred)
     OR
     grep -n "{method_or_class_name}" "$REPO_DIR/{file}"                       (fallback)
  2. VALID     → found at same line ± 5   → no change
  3. RELOCATED → found at different line  → update file:line; append [RELOCATED {skill_version}]
  4. MOVED     → not in that file; graph/grep finds it elsewhere
                → update to new file:line; append [RELOCATED {skill_version}]
  5. DELETED   → symbol not found anywhere in REPO_DIR
                → mark entry [DELETED {skill_version}]; retain pattern/rule text
                   (knowledge of why it existed is still valuable even if the symbol is gone)
```

Emit a `[KB+ ARCH]` or `[KB+ RISK]` correction marker for each entry modified so Step 13d picks it up for INDEX.md.

#### 13d. Update INDEX.md — Memory Palace section

For every new or updated knowledge entry produced in 13b–13c:

1. **Determine which room(s)** the entry belongs to using the Room Directory (match the entry's components and labels).
2. **Compose or reuse the trigger phrase** — if the entry has a `trigger:` field, use it. If the trigger already exists in the room's table, skip (do not duplicate). If new, append a row to the room's trigger table under `## Memory Palace`.
3. **Bump pattern frequency** in the relevant trigger line if the entry is a pattern recurrence (update the trigger's entry link to point to the bumped entry).

#### 13e. Update INDEX.md — Master Index section

1. Add or update the ticket row in the `### Ticket Entries` table (include the `trigger:` field in the row).
2. Add rows for any new shared entries created in 13c (updated entries do not get new rows).
3. Update the header counts (`Triggers: N | Ticket entries: N | Shared entries: N`).
4. Update the `Updated:` date.

#### 13f. Publish KB

**If `KB_MODE=local`:** Skip all git and encryption steps. Files are already written to `KNOWLEDGE_DIR` in steps 13b–13e. Display:
```
📚 Knowledge Base Updated (local)
   Location      : {KNOWLEDGE_DIR}/
   Ticket entry  : tickets/{TICKET_KEY}.md — {created / updated}
   Business rules: {N new / N confirmed}
   Architecture  : {N new / N updated}
   Patterns      : {N new / N bumped (PAT-XXX now seen {N}×)}
   Risks         : {N new / N updated}
   INDEX.md (Palace): {N triggers added to rooms: {room names}}
   INDEX.md      : {N rows added}
   Mental Map    : {N new / N confirmed / N corrected} (see Step 13g)
   Lessons       : {N new entries in lessons-learned/{developer}.md} (see Step 13h)
   Git           : local mode — no distribution
```

**If `KB_MODE=distributed`:**

**Step 1 — If encryption is enabled (`PRX_KB_KEY` is set): batch encrypt session files:**

Use the batch encrypt command from the **Encryption Scheme** section above. All `.md` files in `KB_WORK_DIR` are encrypted to `.md.enc` in `KNOWLEDGE_DIR`. Stale `.md.enc` files with no corresponding source are deleted.

If encryption is not enabled, files were written directly to `KNOWLEDGE_DIR` in steps 13b–13e — skip this step.

**Step 2 — Push to the private KB repository (with remote existence check):**

Execute the git push sequence from the **Git Sync Rules** section above. The push step verifies remote reachability and auto-creates `origin/main` on first push using `--set-upstream`. If the remote is unreachable, it logs a warning and skips without failing the session.

**Step 3 — If encryption is enabled: delete the session temp directory:**
```bash
rm -rf "$KB_WORK_DIR"
echo "KB: session temp dir ${KB_WORK_DIR} deleted."
```

On success display (encryption enabled):
```
📚 Knowledge Base Updated & Pushed (encrypted)
   Repository    : {PRX_KB_REPO}
   Location      : {KNOWLEDGE_DIR}/ (.md.enc files)
   Ticket entry  : tickets/{TICKET_KEY}.md.enc — {created / updated}
   Business rules: {N new / N confirmed}
   Architecture  : {N new / N updated}
   Patterns      : {N new / N bumped (PAT-XXX now seen {N}×)}
   Risks         : {N new / N updated}
   INDEX.md (Palace): {N triggers added to rooms: {room names}}
   INDEX.md      : {N rows added / N re-indexed from disk}
   Mental Map    : {N new / N confirmed / N corrected} (see Step 13g)
   Encrypted     : {N} .md.enc files written
   Git           : pushed to origin/main ({short hash}) {or "branch created" on first push}
   Session temp  : {KB_WORK_DIR} deleted
```

On success display (no encryption):
```
📚 Knowledge Base Updated & Pushed
   Repository    : {PRX_KB_REPO}
   Location      : {KNOWLEDGE_DIR}/
   Ticket entry  : tickets/{TICKET_KEY}.md — {created / updated}
   Business rules: {N new / N confirmed}
   Architecture  : {N new / N updated}
   Patterns      : {N new / N bumped (PAT-XXX now seen {N}×)}
   Risks         : {N new / N updated}
   INDEX.md (Palace): {N triggers added to rooms: {room names}}
   INDEX.md      : {N rows added / N re-indexed from disk}
   Mental Map    : {N new / N confirmed / N corrected} (see Step 13g)
   Lessons       : {N new entries in lessons-learned/{developer}.md} (see Step 13h)
   Git           : pushed to origin/main ({short hash}) {or "branch created" on first push}
```

If push fails: replace the `Git` line with `Git: KB_PUSH_WARN — committed locally. Run: cd {KNOWLEDGE_DIR} && git push origin main`. If encryption was enabled, still delete `KB_WORK_DIR`.

#### 13g. Update Core Mental Map

Collect all `[CMM+]` markers emitted during the session (Steps 5, 7, 8, 9) and apply them to the `core-mental-map/` files. Morgan reviews the list and confirms which are genuinely new or corrective (not already reflected in the CMM entries read during Step 0b).

**For each `[CMM+]` marker:**

| Action tag | What to do |
|------------|-----------|
| `NEW` | Assign the next sequential ID for the file (e.g. `CMM-ARCH-004`). Append the compressed entry. Update `core-mental-map/INDEX.md` row (increment entry count, update summary, set Updated date). |
| `CONFIRM` | Increment `confirmed:` counter on the matching entry. Update `Updated:` date in the INDEX.md row. |
| `CORRECT` | Update `KEY:` and/or `ref:` fields with the fresh values from the live code read. Append `[CORRECTED {today}]` tag on its own line. Increment `contributors:`. Update INDEX.md row. |
| `DELETE` | Append `[DELETED {today}]` tag. Retain the entry body — historical knowledge of why something existed is still valuable. Update INDEX.md summary to note the deletion. |

**Stale ref auto-heal for Core Mental Map:** Apply the same auto-heal logic as Step 13c for any `ref:` lines in `core-mental-map/*.md` files where the file no longer exists at that path. Use the STALE_REF list collected in Step 0a.

**Cross-check bonus:** If during Steps 5–9 an agent explicitly verified a CMM entry against live code and found it still accurate, emit `[CMM+ ... CONFIRM]` and increment `confirmed:`. This cross-verification is the map's quality signal — a high `confirmed:` count means the fact has been independently verified by multiple sessions.

**After writing all CMM updates:**

```bash
# Update core-mental-map/INDEX.md — recount entries per file
for f in "$KB_WORK_DIR/core-mental-map/"*.md; do
  [ "$(basename $f)" = "INDEX.md" ] && continue
  count=$(grep -c "^## CMM-" "$f" 2>/dev/null || echo 0)
  fname=$(basename "$f")
  # Update the count and date in INDEX.md row for this file
  echo "CMM_REINDEX: $fname — $count entries"
done
# Update the Total entries count and Updated date in core-mental-map/INDEX.md header
```

Display:
```
🧠 Core Mental Map Updated
   Location     : {KNOWLEDGE_DIR}/core-mental-map/
   New entries  : {N} (CMM-{type}-NNN)
   Confirmed    : {N} entries verified against live code
   Corrected    : {N} entries updated with fresh info
   Deleted      : {N} entries marked obsolete
   Total entries: {N} across {M} files
```

Then close with the ready-to-code message from Step 12.

#### 13h. Save Lessons Learned

Collect all `[LL+]` markers emitted during the session (Steps 5, 7, 8, 9). Identify the current developer:

```bash
DEVELOPER="${PRX_DEVELOPER_NAME:-$(git config user.name | tr '[:upper:]' '[:lower:]' | tr ' ' '-')}"
LL_FILE="$KB_WORK_DIR/lessons-learned/${DEVELOPER}.md"
```

If the file does not exist, create it:
```markdown
# Lessons Learned — {DEVELOPER}
```

For each `[LL+]` marker, append a new entry using the next sequential ID:
```markdown
## LL-{NNN} — {title}
date: {today} | sprint: — | ticket: {TICKET_KEY}
PITFALL: {pitfall from marker}
KEY: {key lesson from marker}
ref: {ref from marker, or "—"}
```

If there are no `[LL+]` markers, skip this step — do not create an empty file.

Display:
```
📝 Lessons Learned
   Developer    : {DEVELOPER}
   File         : lessons-learned/{DEVELOPER}.md
   New entries  : {N} (LL-NNN … LL-NNN)
```

---

#### 13i. Write Agent Personal Memory

Each agent writes a personal memory file for this session. This is the mechanism by which agents get smarter over time — their observations, calibration data, and surprises accumulate across sessions and are read back in Step 0b Layer 5 of every future session.

**Memory file location and naming:**
```bash
MEMORY_DATE=$(date +%Y%m%d)
# One file per session per agent — conflict-free in distributed mode:
# concurrent sessions from different developers each create a unique file.
personas/memory/{agent-name}/${MEMORY_DATE}-{TICKET_KEY}.md
```

For each agent that participated in the session, write a memory file using the template below. An agent "participated" if they contributed a hypothesis, assessment, check-in, or retrospective during the session. Bryan always participates (Step 14). Agents that are skipped (e.g. no panel was convened for an enhancement ticket) do not write a memory file for that session.

**Memory file format:**

```markdown
# {Agent} — Personal Memory: {TICKET_KEY} ({DATE})
<!-- Append-only record. Do not edit. -->
<!-- Distributed mode: each session file is unique — git auto-merges without conflict. -->
session: {TICKET_KEY} | date: {DATE} | ticket-type: {BUG|ENHANCEMENT|PR_REVIEW}

## What I Learned This Session

| # | Observation | Category | Confidence | Outcome |
|---|-------------|----------|------------|---------|
| 1 | {What I observed — one line, specific} | {BIZ/ARCH/PAT/RISK/PROCESS} | {High/Med/Low} | {Confirmed/Refuted/Pending} |

## Predictions I Made

| Claim | Was I right? | Notes |
|-------|-------------|-------|
| {Hypothesis or assertion I advanced during the session} | {Yes/No/Partial/TBD} | {One sentence — actual outcome} |

## Things That Surprised Me

- {Evidence or outcome that contradicted my prior expectations — high-value learnings}

## Notes for Next Session

- {Short-lived context relevant if working in the same area — expires naturally}
```

**What to write (agent-specific):**

| Agent | What to record |
|-------|----------------|
| Morgan | JIRA precedents found (or not); which engineer gave the best analysis and why; whether Henk's or Riley's input changed the verdict; any area where Morgan overrode the team |
| Alex | Which git history finds proved correct; historical couplings that surprised even Alex; areas where blame history was misleading |
| Sam | Flow trace findings; domain invariants confirmed or refuted; async boundaries that proved tricky |
| Jordan | Pattern matches that were confirmed vs. false positives; class hierarchy surprises; new anti-patterns not yet in the 20-pattern checklist |
| Henk | Business rules confirmed, challenged, or newly surfaced; client workflows that were at risk; whether the fix was truly necessary (verdict + outcome) |
| Riley | Regression risks that were confirmed vs. false alarms; test gaps that remain unaddressed; open questions that proved important |
| Bryan | Session cost vs. rolling average; SKILL.md proposal advanced this session; any process friction that blocked an engineer |

**Write the persona memory files last** — after all KB files are updated — so the memory reflects the full, final state of the session.

Display on completion:
```
🧠 Agent Personal Memory
   Session      : {TICKET_KEY} | {DATE}
   Files written: {N} (personas/memory/{agent}/{date}-{ticket}.md × N)
   Agents       : Morgan ({X} sessions total), Alex ({X}), Sam ({X}),
                  Jordan ({X}), Henk ({X}), Riley ({X}), Bryan ({X})
```

---

#### 13j. Review Javed's Pending KB Contributions

**Skip condition:** If `PRX_KBFLOW_ENABLED` is not `Y`/`YES`/`true` (case-insensitive), OR `~/.prevoyant/knowledge-buildup/kbflow-pending.md` does not exist, OR the file contains no entries with `Status: PENDING APPROVAL` — skip entirely. Display: `⏭️  Step 13j skipped — no pending Javed contributions.`

**This step is mandatory when proposals exist.** It was flagged at Step 0. Proposals do not enter the KB automatically — they sit in `~/.prevoyant/knowledge-buildup/kbflow-pending.md` indefinitely until the panel votes here. Each session that skips 13j with pending entries is a session that delays KB growth.

Javed is an optional autonomous analyst who auto-discovers high-incident business flows from recent Jira activity, traces them in the codebase, and proposes Core Mental Map, shared/patterns, and lessons-learned updates. He never writes directly to the KB — proposals live in `~/.prevoyant/knowledge-buildup/` (outside the KB tree, never committed) until the panel promotes them here at Step 13j. This step is the team's approval gate.

**13j-1. Read `~/.prevoyant/knowledge-buildup/kbflow-pending.md`**

Read the file and list all entries with `Status: PENDING APPROVAL`. Display each entry's title, flow, proposed date, type, and action tag.

For each entry whose `Proposed` date is more than 7 days ago, prefix the display with `⏰ OVERDUE —` to make stale proposals visible to the panel.

**13j-2. Panel Vote — Morgan chairs**

For each PENDING APPROVAL entry, Morgan presents it to the full panel. Each team member gives a one-line verdict:

- **Morgan** — is this substantively new vs. already covered elsewhere in the KB? Is the evidence (file:line) still valid?
- **Alex** — does git history support or contradict the claim?
- **Sam** — does the runtime behaviour match what Javed traced statically?
- **Jordan** — is the entry format correct? Does it duplicate an existing CMM entry?
- **Henk** — does it conflict with any recorded business rule in `shared/business-rules.md`?
- **Riley** — does approving this entry introduce or omit any regression risk?

**Decision rule: unanimous approval required.** A single REJECT blocks the entry. A PARTIAL (some members abstain) counts as APPROVED only if the abstaining member explicitly states no objection.

**13j-3. Apply Approved Contributions**

For each APPROVED entry:
- **CMM types** (CMM-ARCH / CMM-BIZ / CMM-DATA / CMM-GOTCHA): determine the target file:
  CMM-ARCH → `core-mental-map/architecture.md`, CMM-BIZ → `core-mental-map/business-logic.md`,
  CMM-DATA → `core-mental-map/data-flows.md`, CMM-GOTCHA → `core-mental-map/gotchas.md`.
  Write the entry following the standard compressed format. Update `core-mental-map/INDEX.md` counts.
- **PATTERN type**: append the `[ESTIMATE-PATTERN]` block to `shared/patterns.md`.
- **LESSON type**: append the lesson entry to `lessons-learned/javed.md` (create if absent).
- In all cases: update `~/.prevoyant/knowledge-buildup/kbflow-pending.md`: change `Status: PENDING APPROVAL` → `Status: APPROVED | {today's date}`.

For each REJECTED entry:
- Update `~/.prevoyant/knowledge-buildup/kbflow-pending.md`: change `Status: PENDING APPROVAL` → `Status: REJECTED | {today's date} | Reason: {one-line reason}`.
- Do not write anything to `core-mental-map/`.

**13j-4. Update `~/.prevoyant/knowledge-buildup/kbflow-sessions.md`**

Find the matching row for the reviewed batch (by flow and date) and update the `Status` column:
- All approved → `APPROVED`
- Partially approved → `PARTIAL ({N}/{M} approved)`
- All rejected → `REJECTED`

Display on completion:
```
🔍 Javed's KB Contributions — Review Complete
   Flow         : {flow name}
   Total entries: {N}
   Approved     : {N} → written to core-mental-map/
   Rejected     : {N} → archived with rejection reason
   Skipped      : {N} INFO entries (no action required)
```

---

### Step 14 — Bryan's Retrospective

**Skip condition:** If `PRX_INCLUDE_SM_IN_SESSIONS_ENABLED` is not set or is not `Y`/`YES`/`true` (case-insensitive), skip this step entirely. Display: `⏭️  Step 14 skipped — set PRX_INCLUDE_SM_IN_SESSIONS_ENABLED=Y in .env to activate Bryan's retrospective.`

Bryan runs after every Dev Mode session, immediately after Step 13j. Bryan is a **silent observer** — he does not interrupt Steps 0–13j. He now convenes a structured retrospective with the team.

#### Bryan's Mandate

| Responsibility | What Bryan does |
|---|---|
| **Token audit** | Records per-ticket token cost; compares against the 5-session rolling average; builds a step-level breakdown; flags hotspots |
| **Token intervention** | When session cost > 150% of rolling avg (**TOKEN_ALERT**) or monthly spend > 80% (**BUDGET_ALERT**), Bryan escalates to Intervention Mode: proposes up to 3 targeted SKILL.md changes aimed directly at the expensive steps, with dollar-savings estimates per change |
| **Process audit** | Identifies friction, unclear instructions, repeated work, or steps that produced low-value output |
| **DoD guardian** | Checks that no required step was silently skipped or abbreviated without justification |
| **Skill sharpening** | Proposes one targeted SKILL.md edit per session (or up to 3 in Intervention Mode) — tighter wording, removed redundancy, collapsed steps — to make the skill sharper and cheaper over time |
| **Backlog management** | Maintains a prioritised improvement backlog in `process-efficiency.md`; recurrent issues get promoted to HIGH and jump the queue |
| **Impact tracking** | After each approved change, measures whether the next session actually cost less; records the delta |
| **Compaction pass** | Every `PRX_SKILL_COMPACTION_INTERVAL` sessions (default: 10), runs a deep SKILL.md review — eliminates dead weight, compresses verbose prose, merges redundant instructions, removes gates that are never triggered; requires full five-member approval |
| **Velocity dashboard** | Tracks rolling 5-session avg cost, monthly cumulative spend vs `PRX_MONTHLY_BUDGET`, token trend, and change acceptance rate; alerts when monthly spend exceeds 80% or 100% |
| **Blocker log** | Records recurring impediments (MCP failures, step skips, unclear outputs); a blocker seen 3+ times is auto-promoted to HIGH backlog priority |
| **Sprint health report** | Every `PRX_SKILL_COMPACTION_INTERVAL` sessions, generates a summary: tickets worked, avg cost, changes shipped, velocity trend, skill health score (0–100) |
| **Push gate** | Controlled by `PRX_SKILL_UPGRADE_MIN_SESSIONS` (default: 3); when the threshold is reached, commits and pushes all queued changes to the plugin repo's main branch |

#### 14a. Pre-session Check — Backlog & Blockers

Before running the audit, Bryan:

**A. Gets realtime token stats from codeburn:**

codeburn reads Claude Code's local JSONL logs — no network call, no auth required. Run this command:

```bash
npx --yes codeburn@latest report --from $(date +%Y-%m-%01) --to $(date +%Y-%m-%d) --format json 2>/dev/null   # month-to-date spend
```

- **Monthly spend** — `overview.cost` from the command output.
- **Session cost** — `overview.cost` from a same-day report minus the session-start baseline written by `scripts/check-budget.sh` to `/tmp/.prx-session-start-spend`. If the baseline file is missing, use the session cost already computed in Step 11 (which ran the same calculation).

If codeburn is unavailable (npx not found or command fails): fall back to the session cost figure from Step 11 and the manual sum of `cost: $N` values from all `[S-NNN]` rows in `shared/process-efficiency.md` for the current month. Label fallback figures with `~`.

**B. Then reads `shared/process-efficiency.md` for:**

1. **Monthly budget** — use the actual codeburn monthly spend (or the manual sum as fallback). If spend > 80% of `PRX_MONTHLY_BUDGET`, flag ⚠️ and note the remaining headroom. If spend ≥ 100%, flag ❌ and state that clearly in the token audit.
2. **Backlog** — note any HIGH-priority items. If the current session produced evidence for a HIGH item, it gets priority over new observations.
3. **Blockers** — increment the count for any blocker that recurred this session. Auto-promote to HIGH backlog if count reaches 3.
4. **Impact check** — if last session had an approved change, compare this session's cost against the pre-change baseline. Record the delta in the backlog row. Also evaluate the **hypothesis accuracy**: retrieve the `Hypothesis:` field from the backlog entry for the approved change, compare the predicted saving to the actual cost delta, and record `[HYPOTHESIS: predicted ~{N}% / actual {M}% — {accurate / over-estimated / under-estimated}]` as an append to the backlog row. Over time this builds a track record of which proposal types actually deliver savings.
5. **Compaction trigger** — if `Sessions tracked % PRX_SKILL_COMPACTION_INTERVAL == 0`, flag this as a compaction session.

**C. Token spike detection — set alert flags before 14b:**

Using the session cost from Step 11 and the rolling average from process-efficiency.md:

- Set **TOKEN_ALERT** if: this session's cost > 150% of the 5-session rolling average, or this is the single most expensive session in the last 10.
- Set **BUDGET_ALERT** if: monthly spend > 80% of `PRX_MONTHLY_BUDGET` (already surfaced in B.1 above). Note exact remaining headroom in dollars and estimated sessions remaining at current avg.

If either flag is set, Bryan enters **Intervention Mode** in 14c instead of the normal single-change proposal. If both are set simultaneously, Bryan leads with a direct budget impact statement before any proposals.

#### 14b. Token & Process Audit

```
── Bryan — Scrum Master Retrospective ────────────────────────────────

📊 TOKEN AUDIT
  Total this session  : ~{N} in / ~{N} out | ${cost}
  vs rolling avg      : ${avg} 5-session avg — this ticket is {Z}% {above ⚠️ / below ✅ / inline with} average
  Monthly budget      : ${spent} spent of ${PRX_MONTHLY_BUDGET:-20.00} ({X}% used, {days} days remaining)
  Status              : ✅ On track / ⚠️ >80% consumed / ❌ Budget exceeded
  Alert               : ✅ Normal / ⚠️ TOKEN_ALERT (session {Z}% above avg) / 🚨 BUDGET_ALERT ({X}% consumed) / 🚨 BOTH
  Rolling 5-session avg: ${avg} ({↓ improving / ↑ degrading / → stable})

  Step breakdown (estimated):
  ┌─────────────────────────────┬──────────┬────────┐
  │ Step                        │ Est. %   │ Flag   │
  ├─────────────────────────────┼──────────┼────────┤
  │ {Step name}                 │ {N}%     │ ✅/⚠️  │
  └─────────────────────────────┴──────────┴────────┘
  Token hotspot this session: {Step name} ({N}%)

🔍 PROCESS OBSERVATIONS
  DoD check   : ✅ All steps completed / ⚠️ {Step N} was skipped — {reason}
  Friction    : {specific observation or "None observed"}
  Redundancy  : {duplicated work or output seen or "None"}
  Clarity gap : {instruction that produced unexpected output or "None"}

🗂️ BACKLOG STATUS
  HIGH  : {item or "—"}
  MEDIUM: {item or "—"}
  (full backlog in shared/process-efficiency.md)
```

#### 14c. Proposed SKILL.md Change

Bryan selects **one** change — either the top HIGH backlog item (if evidence supports it this session) or the sharpest new observation. The change must be concrete: a specific before/after edit, not a vague suggestion.

**Sharpening heuristics Bryan applies:**
- Instructions that can say the same thing in half the words
- Steps that always output "N/A" or "none found" → add a fast-path skip condition
- Duplicate guidance spread across multiple steps → consolidate to one canonical location
- Passive voice or hedging that makes intent ambiguous → rewrite as direct imperatives
- Gates that have never been triggered across the last N sessions → consider removing

```
💡 PROPOSED SKILL.md CHANGE  (or "No change proposed — backlog unchanged")
  Area        : {Step or section}
  Problem     : {what is wasteful, unclear, or redundant}
  Type        : Compress / Remove / Clarify / Merge / Fast-path
  Est. saving : ~{N}% tokens / {clearer output / fewer re-reads}
  Backlog item: {NEW / HIGH-001 / MEDIUM-003}
  Hypothesis  : "{a falsifiable prediction — e.g. 'this will reduce Step 7 token spend
                  by ~15% by eliminating the mandatory full panel when KB confidence is
                  High' — must be measurable against process-efficiency.md after
                  PRX_SKILL_UPGRADE_MIN_SESSIONS sessions}"
  Verify after: {PRX_SKILL_UPGRADE_MIN_SESSIONS} sessions — Bryan will check actual
                cost delta in Step 14a impact check and record accuracy in backlog row.

  Before: "{exact current wording}"
  After : "{proposed replacement}"

🗳️ CONSENSUS
  Morgan    : ✅ / ❌ — {one-line reason}
  Riley     : ✅ / ❌ — {one-line reason}
  {Engineer}: ✅ / ❌ — {one-line reason}

  Result : Consensus reached ✅ / Not reached ❌ — re-queued in backlog

🔒 DEVELOPER CONFIRMATION  (only if consensus reached)
  Skip this block entirely if AUTO_MODE is Y/YES/true — defer the update (do not apply).
  Append [DEFERRED AUTO_MODE: {today}] to the backlog item and close Step 14.
  Otherwise pause and present the following before touching any file:

  ┌── Proposed SKILL.md edit ─────────────────────────────────────────┐
  │ Change type   : {Compress / Remove / Clarify / Merge / Fast-path}  │
  │ Target        : {Step or section name}                             │
  │ Problem solved: {one sentence — what is wasteful, unclear, or      │
  │                  redundant}                                        │
  │ Process impact: {how this concretely improves future sessions —    │
  │                  e.g. "saves ~15% tokens in Step 7", "removes a    │
  │                  gate that has never fired", "eliminates repeated   │
  │                  file reads"}                                      │
  │ Est. saving   : ~{N}% tokens per session / {qualitative benefit}   │
  │                                                                    │
  │ BEFORE: "{exact current wording}"                                  │
  │ AFTER : "{proposed replacement}"                                   │
  │                                                                    │
  │ Approved by: Morgan ✅  Riley ✅  {Engineer} ✅                    │
  └────────────────────────────────────────────────────────────────────┘
  → Proceed with this SKILL.md update? [Y/n]:

  Y or Enter → continue to 📝 SKILL.md UPDATE
  N          → append [DEFERRED by developer: {today}] to the backlog
               item; skip 📝 SKILL.md UPDATE; close Step 14

📝 SKILL.md UPDATE  (only if consensus reached AND developer confirmed)
  Version bumped : {current} → {new patch}
  Skill Change Log row appended to SKILL.md (SC-{NNN})
  Queued for push. Sessions since last push: {N} / {PRX_SKILL_UPGRADE_MIN_SESSIONS}
  {If N >= PRX_SKILL_UPGRADE_MIN_SESSIONS}:
    git commit -m "v{new} — Bryan SC-{NNN}: {one-line description}"
    COMMIT_HASH=$(git rev-parse --short HEAD)
    git push origin main
    → Pushed ✅  commit: {COMMIT_HASH}
    → skill-changelog.md entry written (see Step 14f)
──────────────────────────────────────────────────────────────────────
```

##### Intervention Mode *(TOKEN_ALERT or BUDGET_ALERT only)*

When either flag is set, Bryan replaces the single-change rule with a focused **token reduction intervention**. The normal consensus + developer confirmation gate (14c) applies to each proposal.

If BUDGET_ALERT is active, Bryan opens with a direct budget impact statement:
```
🚨 BUDGET INTERVENTION
  Monthly spend       : ${spent} of ${PRX_MONTHLY_BUDGET} ({X}% used, {days} days remaining)
  Projected next session: ~${avg} — {"on track to close within budget" / "will breach budget in ~{N} sessions at current rate"}
  Immediate action required to stay within budget.
```

Bryan then identifies the top 3 most expensive steps from the step breakdown and proposes a concrete SKILL.md edit for each — fast-path gates, instruction compression, output truncation, or step merging — ordered by estimated token savings:

```
⚡ INTERVENTION PROPOSALS  ({N} changes — ranked by token saving)

  [1] Area        : {Step or section}
      Problem     : {specific reason this step is expensive}
      Change type : Compress / Fast-path / Remove / Merge
      Before      : "{exact current wording}"
      After       : "{proposed replacement}"
      Est. saving : ~{N}% tokens / ~${saving} per session

  [2] ...  [3] ...

  Consensus required for each proposal independently.
  Proposals approved by all five members are committed atomically as a single change-set.
```

If both TOKEN_ALERT and BUDGET_ALERT are active, Bryan presents all three proposals before seeking any consensus votes — the team reviews the full picture before committing to any change.

#### 14c-ii. Cross-Ticket Pattern Synthesis *(runs every PRX_SKILL_COMPACTION_INTERVAL sessions, alongside 14d; or when Bryan observes 3+ sessions sharing a component and root cause type)*

Bryan performs a **pattern synthesis pass** — clustering all ticket records in `KB_WORK_DIR/tickets/*.md` by component and root cause type to surface recurring themes the team has not yet explicitly named. This is distinct from compaction (which tightens SKILL.md text) — synthesis adds new knowledge to `shared/patterns.md`.

**Algorithm (Bryan reads ticket frontmatter only — no full ticket reads):**

```bash
# Extract component + root cause type from each ticket file
for f in "$KB_WORK_DIR/tickets/"*.md; do
  component=$(grep "^components:" "$f" | head -1 | sed 's/components: *//')
  rootcause=$(grep "^root-cause-type:" "$f" | head -1 | sed 's/root-cause-type: *//')
  echo "$component | $rootcause"
done | sort | uniq -c | sort -rn | head -20
```

Clusters with **count ≥ 3** are candidate patterns. For each candidate cluster:
1. Read the 3 most recent ticket files in that cluster (just the `## Root Cause` section, not the full file)
2. Identify whether the pattern is already in `shared/patterns.md` — if yes, increment `frequency:` counter and add the ticket key to `occurrences:`; if no, propose a new pattern entry

Present findings as a **Pattern Synthesis Report**:

```
─── Bryan — Cross-Ticket Pattern Synthesis ────────────────────────
Sessions analysed : {N} tickets in KB
Clusters found    : {M} with count ≥ 3

Cluster 1 — AlertCentral | null-propagation (count: 5)
  Tickets: IV-3412, IV-3556, IV-3672, IV-3801, IV-3915
  Existing pattern: PAT-001 matches → BUMP frequency counter (6 → 11)

Cluster 2 — CaseManager | state-not-refreshed (count: 3)
  Tickets: IV-3480, IV-3701, IV-3880
  No existing pattern covers this exactly.
  → Proposed new pattern: PAT-021 — "case action triggers backend update
    but frontend state not refreshed — GWT panel reload missing"
    Frequency: 3 | first-seen: {earliest ticket date}

─── Proposed actions ───────────────────────────────────────────────
  [BUMP] PAT-001 frequency: 11 (was 10) — append IV-3915 to occurrences
  [NEW]  PAT-021 — draft entry appended to shared/patterns.md backlog
         Requires Morgan ✅ + Jordan ✅ to promote from backlog to active
────────────────────────────────────────────────────────────────────
```

New pattern entries are held in a `## Pattern Backlog` section at the bottom of `shared/patterns.md` until Morgan and Jordan approve them (same consensus gate as SKILL.md changes). Bryan appends the proposed entry with `Status: PENDING APPROVAL` and presents it to the team.

**Skip condition:** If the KB has fewer than 6 ticket files, state `Pattern synthesis: skipped — insufficient history ({N} tickets; minimum 6).`

---

#### 14d. Compaction Pass *(compaction sessions only)*

On compaction sessions, Bryan replaces the single-change rule with a **full SKILL.md review**. Bryan reads the entire file and produces a compaction diff:

- Remove instructions that duplicate content already stated elsewhere
- Compress step preambles to ≤ 2 sentences — if it takes more to explain what a step does, the step is poorly scoped
- Collapse any two consecutive steps that share the same file reads or MCP calls
- Remove or gate any block that has produced zero output across the last `PRX_SKILL_COMPACTION_INTERVAL` sessions (as evidenced by the process-efficiency.md session log)
- Rewrite any instruction where the output format is inconsistently followed

Compaction requires **all five team members** to approve (Morgan + Riley + Alex + Sam + Jordan). Version bump is MINOR (x.Y.0).

Before applying any edits, Bryan presents the same **🔒 DEVELOPER CONFIRMATION** gate as in 14c — listing the full compaction diff summary, total estimated token reduction, and all five approvals — then asks `→ Proceed with compaction? [Y/n]:`. If AUTO_MODE=Y, skip the prompt and defer the compaction: append `[COMPACTION DEFERRED AUTO_MODE: {today}]` to `process-efficiency.md` and skip the commit. If the developer declines interactively, append `[COMPACTION DEFERRED by developer: {today}]` instead.

If confirmed, Bryan commits the compaction as a single atomic commit: `"vX.Y.0 — Bryan: compaction pass #{N} (~{X}% token reduction)"`.

#### 14e. process-efficiency.md Update

`process-efficiency.md` uses an **append-only journal** — never edit existing lines, only append new ones. The header and Velocity Dashboard are auto-generated from the journal on every pull (see rebuild algorithm in the KB Sync section). This guarantees lossless `merge=union` in distributed mode regardless of how many developers push concurrently.

After every Step 14, **append** to `shared/process-efficiency.md`:

**1. New session record** (always):
```markdown
## [S-NNN] Session Record
date: {today} | developer: {DEVELOPER} | ticket: {TICKET_KEY} | type: {Bug/Enh} | cost: ${cost} | budget: ${budget} | status: ✅/⚠️
hotspot: {Step name} ({N}%) | change: {BL-NNN or "—"} | impact: {saving vs prev session or "baseline"}
```

**2. Backlog and blocker updates** — use the `[BL-NNN] Backlog Item` and `[BK-NNN] Blocker` journal entry formats defined in the **Knowledge Base** section. Key rules: new → append new block; recurrence → append `[SEEN+1]`/`[COUNT+1]`; promotion → append `[PROMOTED HIGH]`; applied → append `[APPLIED]`; resolved → append `[RESOLVED]`. Never edit existing lines.

The auto-generated header and Velocity Dashboard are rebuilt from the journal during the next pull (Step 0a) — not written here.

#### 14f. Skill Audit Trail

Run this step only when a change was approved **and** pushed this session (i.e., `N >= PRX_SKILL_UPGRADE_MIN_SESSIONS`).

**1. Append a row to the `## Skill Change Log` table in SKILL.md:**
```markdown
| SC-{NNN} | v{new} | {today} | {COMMIT_HASH} | {Compress/Remove/Clarify/Merge/Fast-path/Compaction} | {one-line summary} | ACTIVE |
```
This row lives in SKILL.md itself — anyone reading the file can see the full change history at a glance.

**2. Append a full entry to `shared/skill-changelog.md` in the KB:**
```markdown
## [SC-{NNN}] v{new} — {one-line summary}
date: {today} | commit: {COMMIT_HASH} | backlog-ref: {BL-NNN or "new"} | type: {type}
PROBLEM: {what was inefficient or unclear}
BEFORE: "{exact old wording — quote verbatim}"
AFTER: "{exact new wording — quote verbatim}"
voters: Morgan ✅ | Riley ✅ | {Engineer} ✅
```

**3. Revert procedure** — if a Bryan change later causes problems, any developer can:
```bash
# 1. Find the commit hash — either from SKILL.md's Skill Change Log table
#    or from shared/skill-changelog.md SC-{NNN} entry
git log --oneline | grep "Bryan SC-"

# 2. Revert the specific commit (safe — creates a new revert commit, no history rewrite)
git revert <COMMIT_HASH>
git push origin main

# 3. Append revert tag to the SC-{NNN} entry in shared/skill-changelog.md:
# [REVERTED: {today} — revert-commit: {revert-hash} — reason: {one-line}]

# 4. Update the row in SKILL.md's Skill Change Log: change Status to REVERTED
#    (this is the only in-place edit Bryan ever makes to the log — acceptable since
#    it is a revert operation, not a new append, and git history preserves the full story)
```

If a compaction pass needs to be reverted, the same procedure applies — the compaction commit hash is recorded in the SC-NNN entry.

#### Consensus Rules

- Regular change: unanimous approval from Morgan + Riley + highest-scoring engineer (or any one engineer for enhancements)
- Compaction pass: unanimous approval from all five team members
- Rejected change: re-queued in backlog with "seen N times" counter incremented; if seen 3+ times, promoted to HIGH
- No change proposed: skip consensus; still update process-efficiency.md

---

---

---

## PR Review Mode

Execute these steps when the invocation triggers **PR Review Mode** (see Mode Selection above). Do not run the Dev Mode steps. Present output for each step as it completes.

---

### Step R0 — Knowledge Base: Initialise & Query

Identical to Step 0 in Dev Mode. Run Phase A (initialise) before Step R1, and Phase B (query by components/labels) after Step R1.

**Apply the server pre-load gate from Step 0** before any disk operations — same check, same fallback behaviour.

The Prior Knowledge block carries into:
- Step R2 (does KB confirm or extend the problem statement and acceptance criteria?)
- Step R5 (reviewers must state whether KB patterns or risks are relevant to the diff — Morgan must reference KB history in the verdict)
- Step R6 (consolidated report must note whether any finding recurs from a KB entry)

---

### Step R1 — Read the Jira Ticket

Identical to Step 1 in Dev Mode. Use `mcp__jira__get_issue` with the ticket key. Request fields: `summary`, `issuetype`, `priority`, `status`, `assignee`, `reporter`, `labels`, `components`, `fixVersions`, `versions`, `description`, `comment`, `attachment`.

Display the same field summary as Step 1.

**If the MCP call fails**, stop and state the error. Do not proceed.

---

### Step R2 — Understand the Problem & Associated Tickets

Execute the full Step 2 from Dev Mode without omission: problem statement, **linked & associated ticket analysis**, attachment analysis, and optional issue diagram.

**Linked tickets are mandatory for review context.** Apply the full **Linked & Associated Tickets** procedure from Step 2 (two-phase lazy fetch; High-relevance tickets get full fetch + PR analysis; Low-relevance get summary only). One review-specific difference: step 3 per linked ticket reads `[KEY] (type, status) — one-sentence relevance to the **code review**` rather than to the ticket generally.

Carry all findings forward into Step R5 — reviewers need the full acceptance context to judge correctness.

---

### Step R3 — Read Comments for Additional Context

Identical to Step 3 in Dev Mode. Fetch all comments and extract any prior investigation, decisions, constraints, or known issues.

Produce a **Prior Investigation Summary** block if applicable. Carry all findings into Step R5 so reviewers have full context.

---

### Step R4 — Identify & Fetch Code Changes

#### R4a. Locate the Feature Branch

Search for the branch associated with this ticket:

```bash
git branch --list "Feature/{TICKET_KEY}*"
git branch -r | grep "Feature/{TICKET_KEY}"
```

If a single matching branch is found, use it. If multiple branches match, list them and ask the developer which one to review. If no branch is found:

```bash
git branch --list "*{TICKET_KEY}*"
git branch -r | grep "{TICKET_KEY}"
```

If still not found, ask the developer to provide the branch name before continuing.

#### R4b. Determine the Base Branch

Use the same base branch logic as Step 4a in Dev Mode (Fix Version → Affected Version → `development`).

#### R4c. Get the Diff

First, extract the list of files touched by this PR and bind it as `CHANGED_FILES` — all subsequent review operations are scoped to this list only:

```bash
git diff {BASE_BRANCH}...{FEATURE_BRANCH} --name-only
```

Store the output as `CHANGED_FILES` (newline-separated paths). This is the authoritative set of files reviewers may read or grep. Any file not in `CHANGED_FILES` must not be read unless it is a direct caller of a changed method identified via grep.

Then fetch the full diff and stats:

```bash
git diff {BASE_BRANCH}...{FEATURE_BRANCH} --stat
git diff {BASE_BRANCH}...{FEATURE_BRANCH}
```

Also get the commit log for the branch:

```bash
git log --oneline {BASE_BRANCH}..{FEATURE_BRANCH}
```

#### R4d. Present the Change Summary

Display:

| Field | Value |
|-------|-------|
| Feature branch | `{feature branch name}` |
| Base branch | `{base branch name}` |
| Commits | `{N commits}` |
| Files changed | `{N files}` |

Then list every changed file with its change type (modified / added / deleted) and lines changed (+X -Y):

| File | Change type | +/- lines |
|------|-------------|-----------|
| `fcfrontend/.../CaseManager.java` | Modified | +42 −18 |

If the diff is empty (no changes found), state: "No code changes found on this branch relative to `{BASE_BRANCH}`. Confirm the branch name and base branch are correct." and stop.

**Large diff handling** — if the total lines changed across all files exceeds **500 lines**, do not read the full diff in one block. Instead:

1. **Pre-read pass**: read the `--stat` output and the commit log only (already done above).
2. **Reviewer file assignment**: assign each changed file to the reviewer whose mandate best covers it:
   - Alex → files with significant git history changes or commit-message anomalies
   - Sam → files containing the core logic change (the primary fix path)
   - Jordan → files with structural changes, new abstractions, or interface modifications
   - Riley → test files; any file touched by more than 3 callers (regression surface)
3. Each reviewer reads **only their assigned files** via targeted reads — not the full diff.
4. State the assignment before review begins:

```
Large diff detected: {N} total lines changed across {M} files.
File assignments:
  Alex  → {file list}
  Sam   → {file list}
  Jordan → {file list}
  Riley → {file list}
```

---

### Step R5 — Engineering Panel Code Review

The same team from Dev Mode convenes to review the code changes, with adjusted mandates:

| Role | Name | Review Focus |
|------|------|-------------|
| **Lead Reviewer** | **Morgan** | Chairs. Sets review schedule. Cross-examines. Scores engineers. Gives binding verdict: Approve / Request Changes / Reject. |
| Senior Reviewer | Alex | Code quality, readability, commit hygiene, architecture alignment, adherence to project conventions |
| Senior Reviewer | Sam | Logic correctness, data flow accuracy, correct fix for the stated root cause / enhancement |
| Senior Reviewer | Jordan | Defensive patterns (full 20-pattern checklist), structural anti-patterns, class hierarchy ownership |
| **Technical Lead** | **Henk** | Business rule alignment; whether the change is truly necessary and delivers client value; whether it alters behaviour existing clients depend on |
| **Lead QA Reviewer** | **Riley** | Test coverage assessment, testability of the changes, regression surface, missing edge cases, acceptance criteria coverage |

Engineers (Alex, Sam, Jordan) are competing for **Best Review** distinction. Henk and Riley and Morgan are not competing. Morgan checks in with Henk when evaluating whether a reviewed change is warranted and client-safe.

#### R5a. Morgan Opens — Historical JIRA Search + Lead Briefing

Before briefing the review team, Morgan runs a mandatory JIRA historical search identical to the one performed in Dev Mode Step 7b-i. This surfaces any past resolutions, known regression notes, or prior investigations on the same component/label that inform the review.

**R5a-i. Morgan's JIRA Historical Search**

Run the same JQL queries as Step 7b-i (component match + label match, status Done/Resolved/Closed). For each result:
1. Retrieve full ticket details and scan comments for root cause, fix location, regression warnings.
2. Emit `[KB+ BIZ]` or `[KB+ ARCH]` markers for any newly discovered business knowledge.
3. Present the Historical JIRA Precedents block (same format as Step 7b-i) before the review briefing.

If no matching tickets found: state "No historical tickets found — proceeding fresh."
If JIRA search fails: log `JIRA_SEARCH_WARN:` and continue.

**R5a-ii. Morgan Lead Review Briefing**

```
┌─ Morgan — Review Briefing ──────────────────────────────────────────┐
│ Ticket     : {TICKET_KEY} — {summary}                               │
│ Type       : {Bug fix / Enhancement}                                │
│ Branch     : {feature branch}                                       │
│ Changes    : {N files, N commits}                                   │
│ Prior KB   : {N triggers matched / "none — fresh start"}            │
│ JIRA history: {N past tickets / "none found"}                       │
│                                                                     │
│ Review assignments:                                                 │
│   Alex  → Code quality, naming, structure, commit messages.         │
│            Flag anything that violates project conventions or       │
│            is harder to read/maintain than it needs to be.          │
│   Sam   → Logic correctness. Does the fix actually address the      │
│            root cause / acceptance criteria? Trace the data         │
│            flow through the changed code.                           │
│   Jordan → Run your full 20-pattern checklist on every changed      │
│            file. Emit [KB+ PAT] for every match.                    │
│   Riley → Test coverage. Does the change have tests? Are the        │
│            acceptance criteria verifiable? What regression          │
│            surface is introduced? Emit [KB+ RISK] for every         │
│            fragile area identified.                                 │
│                                                                     │
│ KB annotations: emit [KB+] markers inline whenever you discover a   │
│ business rule, architecture insight, pattern, or regression risk.   │
│                                                                     │
│ Schedule:                                                           │
│   T+2 min : Mid-point check-in (all four report progress)          │
│   T+4 min : Final findings due                                      │
│   T+5 min : Riley's questions + Morgan's cross-examination          │
│   T+6 min : Debate round + verdict                                 │
│                                                                     │
│ Rules: Cite file:line for every finding. Unsupported claims         │
│ will be challenged. Focus on the diff — do not re-investigate       │
│ the root cause from scratch.                                        │
└──────────────────────────────────────────────────────────────────────┘
```

#### R5b. Parallel Review — All Four Reviewers (4-minute block)

Each reviewer has a **4-minute window** capped at **8 targeted operations** (reads of specific diff hunks, greps for callers/usages, reads of surrounding context for a changed method). Riley is capped at **6 operations**. The Grep-First, Read-Second rule applies.

**Scope constraint:** All read and grep operations are restricted to files in `CHANGED_FILES` (derived in R4c). Reviewers must not open or search files outside this set unless a grep reveals a direct caller of a changed method in another file — in which case that file may be read once, counts as one operation, and must be noted as "outside CHANGED_FILES".

---

**Alex — Code Quality & Conventions**
*"Clean code is code your team can still understand in six months."*

Alex reviews in priority order (stop early on High confidence findings):
1. Naming conventions — do new classes, methods, and fields follow the project's existing naming style?
2. Code structure — is the change well-organised? Is logic in the right layer?
3. Duplication — does the change introduce duplicated logic that should be extracted?
4. Commit hygiene — do commit messages follow the project format? Are there unnecessary or partial commits?
5. Dead code — are there commented-out lines, unused variables, or TODO markers left in the diff?
6. Readability — are complex sections adequately clear given the existing comment style in the codebase?
7. Consistency — does the code style (spacing, bracket style, logging pattern) match the surrounding file?
8. Architecture alignment — does the change fit the established layering and responsibility model?

**Alex KB annotations (Review):** Emit `[KB+ ARCH]` if the diff reveals a layer interaction or ownership decision (e.g. "config wiring belongs in concrete subclass per this pattern"). Emit `[KB+ RISK]` if a shared utility or widely-used method was modified.

---

**Sam — Logic Correctness & Root Cause Alignment**
*"The fix must actually fix the thing. Follow the data to confirm it does."*

Sam reviews in priority order:
1. Re-read the Enhancement Statement or Root Cause Statement from Step R2/R3 — what was the fix supposed to do?
2. Trace the changed code path — does the new logic produce the correct outcome for the primary case?
3. Check boundary conditions in the diff — does the fix handle nulls, empty collections, and edge values?
4. Check whether the fix is complete — are there other call sites or paths where the same issue could still occur?
5. Check for unintended side effects — does any changed method affect behaviour for callers not related to the reported issue?
6. Check the data flow end-to-end through the diff — is the correct value produced at each transition?
7. Verify acceptance criteria coverage — for each criterion listed in Step R2, confirm a code path exists that satisfies it
8. Confirm the fix does not silently degrade any related functionality

**Sam KB annotations (Review):** Emit `[KB+ BIZ]` for any domain rule confirmed or violated by the diff (e.g. "fix correctly sets pendingAlertResolve before save — BIZ-001 confirmed"). Emit `[KB+ ARCH]` for any data flow interaction made visible by reading the diff.

---

**Jordan — Defensive Patterns & Structural Anti-Patterns**
*"I've catalogued every way Java developers shoot themselves in the foot."*

Jordan applies the full 20-pattern checklist (same table as Step 7) to every changed file in the diff. For each pattern, Jordan checks only the changed code (additions and modifications) — not unchanged surrounding code, unless it is called by the new code.

Report findings in this format:
```
Pattern N — {Pattern Name}: {Finding}
  File: {file:line}
  Code: {one-line quote from diff}
  Severity: Critical / Major / Minor
  Recommendation: {what to change}
```

If a pattern has no finding in the diff, state: `Pattern N — {Pattern Name}: No issue found in diff.`

**Jordan KB annotations (Review):** Emit `[KB+ PAT] Pattern #{N}: {description} — {file:line} [NEW]` for first occurrences or `[BUMP]` for recurrences, exactly as in Dev Mode. Emit `[KB+ ARCH]` for any structural insight from the diff.

---

**Riley — Test Coverage & Acceptance Criteria**
*"A fix that can't be verified is a fix that can't be trusted."*

Riley reviews in priority order (stop when impact picture is clear):
1. Are there any new or modified tests in the diff? If yes, do they cover the primary fix path?
2. Do the tests cover at least one negative case (null input, empty input, error path)?
3. For each acceptance criterion from Step R2 — is there a test that would catch a regression of that criterion?
4. What is the regression surface of the change? List flows that pass through the changed code that are not covered by the tests in the diff.
5. Identify any edge cases that are not tested: concurrent access, DB dialect differences, multi-client data isolation, session boundaries.
6. Assess testability: can the fix be verified from the UI/API, or does it require DB-level verification? Flag anything that is not observable without internal access.

**Riley KB annotations (Review):** Emit `[KB+ RISK]` for every fragile area or untested regression surface identified. Emit `[KB+ BIZ]` if an acceptance criterion implies a domain rule not yet in the KB.

Riley submits a **Test Coverage Assessment** in this format:
```
┌─ Riley — Test Coverage Assessment ─────────────────────────────┐
│ Tests in diff      : {Yes — N tests / No — none added}          │
│ Primary path       : {Covered / Not covered}                    │
│ Negative cases     : {Covered / Not covered / Partial}          │
│ Acceptance criteria: {All covered / N of M covered / None}      │
│ Regression surface : {list of flows not covered by diff tests}  │
│ Edge cases missing : {list or "None identified"}                │
│ Testability        : {UI-observable / Requires DB verification / │
│                      Requires log analysis}                     │
│ Coverage rating    : Adequate / Partial / Insufficient          │
│ Open question      : {one targeted question to a named reviewer  │
│                      or Morgan — must be answered before        │
│                      the review is approved}                    │
│ Ops used           : [N / 6]                                    │
└────────────────────────────────────────────────────────────────────┘
```

---

#### R5c. Mid-Point Check-In — T+2 minutes

```
─── Mid-Point Check-In ────────────────────────────────────────────

Alex (ops used: N/8):
  Status: [e.g. "Found dead code in the diff — commented-out block
           at CaseManager.java:2310. Checking naming next." or
           "No quality issues so far — moving to architecture check."]

Sam (ops used: N/8):
  Status: [e.g. "Logic traces correctly for the primary case.
           Checking null handling on the new callback chain." or
           "Fix addresses root cause. Verifying acceptance criteria."]

Jordan (ops used: N/8):
  Status: [e.g. "Pattern #1b matched — Map.get() result used without
           null guard at AlertHelper.java:88. Checking remaining
           patterns." or "Patterns 1–10 clear on this diff.
           Continuing to 11–20."]

Riley (ops used: N/6):
  Status: [e.g. "No tests added. Primary path is not covered.
           Flagging coverage gap." or "Two tests added — primary
           path covered. Checking negative cases now."]

─── Morgan's Response ─────────────────────────────────────────────

[Morgan reads all four statuses and responds — same format as Step 7d]

────────────────────────────────────────────────────────────────────
```

---

#### R5d. Final Review Submissions — T+4 minutes

```
┌─ Alex — Code Quality Findings ─────────────────────────────────┐
│ Issues found : {N issues — list each with file:line, severity,  │
│                and one-line description}                        │
│ Positives    : {what is well done — e.g. "clean separation of   │
│                callback chain, consistent naming"}              │
│ Recommendation: Approve / Request Changes                       │
│ Ops used     : [N / 8]                                          │
└────────────────────────────────────────────────────────────────────┘

┌─ Sam — Logic Correctness Findings ─────────────────────────────┐
│ Root cause addressed : {Yes / No / Partially — explanation}     │
│ Acceptance criteria  : {All met / N of M met — which are not}   │
│ Issues found : {N issues — list each with file:line, severity,  │
│                and one-line description}                        │
│ Recommendation: Approve / Request Changes                       │
│ Ops used     : [N / 8]                                          │
└────────────────────────────────────────────────────────────────────┘

┌─ Jordan — Defensive Pattern Findings ──────────────────────────┐
│ Patterns checked : 20                                           │
│ Issues found     : {N issues — reproduce each Pattern N report  │
│                   block from the investigation above}           │
│ Recommendation   : Approve / Request Changes                    │
│ Ops used         : [N / 8]                                      │
└────────────────────────────────────────────────────────────────────┘

[Reproduce Riley's Test Coverage Assessment block from R5b]
```

---

#### R5e. Riley's Question + Morgan's Cross-Examination — T+5 minutes

Same format as Step 7f in Dev Mode. Riley poses the Open question. Morgan cross-examines the most important uncertainties across all four submissions. Engineers/Riley respond in one paragraph backed by evidence.

---

#### R5f. Debate Round — One Round

Same format as Step 7g in Dev Mode. Any reviewer or Riley may mount one challenge on code or coverage grounds. The challenged party responds once. Morgan moderates and closes.

---

#### R5g. Morgan's Review Verdict — T+6 minutes

Morgan weighs all findings and delivers a binding verdict using this scoring rubric:

| Criterion | Points |
|-----------|--------|
| Specific `file:line` cited with code evidence | +3 |
| Finding is directly actionable (clear recommendation) | +2 |
| Finding survived cross-examination without revision | +2 |
| Finding is corroborated by another reviewer independently | +2 |
| Found efficiently (≤ 5 ops used) | +1 |
| Debate challenge successfully deflected with evidence | +1 |
| Finding is testability-relevant and Riley corroborates it | +1 |

Maximum score: 12 pts per reviewer. Morgan scores Alex, Sam, and Jordan. Riley is not scored.

```
─── Morgan's Review Verdict ───────────────────────────────────────

Scores:
  Alex   : {N} / 12 pts — [one-line assessment]
  Sam    : {N} / 12 pts — [one-line assessment]
  Jordan : {N} / 12 pts — [one-line assessment]

Coverage view (Riley):
  [Morgan addresses Riley's coverage assessment — one to two sentences.
   Must state whether any Insufficient coverage concerns block approval.]

My assessment:
  [Morgan weighs in personally — 2–4 sentences. Morgan may endorse
   the highest-scoring reviewer's findings, refine them, or add
   independent findings from up to 4 additional targeted reads.]

Overall verdict:
  ✅ APPROVED — changes are correct, clean, and safe to merge.

  — or —

  ⚠️  APPROVED WITH CONDITIONS — merge after addressing:
     [{list of specific conditions — file:line and what to change}]

  — or —

  🔄 REQUEST CHANGES — [{summary of blocking issues}].
     Required before re-review:
     [{bulleted list of required changes with file:line references}]

  — or —

  ❌ REJECT — [{reason — fundamental approach is wrong or introduces
     unacceptable risk}]. Recommended path:
     [{what should be done instead}]
────────────────────────────────────────────────────────────────────
```

**Best Review** distinction:

```
╔══════════════════════════════════════════════════════════════════╗
║  🏆  BEST REVIEW: {Reviewer Name}        Score: {N} / 12 pts    ║
║  Reason: {One sentence — why this review was superior}           ║
║  Morgan: "{One sentence endorsement or refinement note}"         ║
║  Riley:  "{Coverage status: Adequate / Partial / Insufficient}"  ║
╚══════════════════════════════════════════════════════════════════╝
```

---

### Step R6 — Consolidated Review Report

Produce a structured findings and recommendations block consolidating all reviewer input:

```
REVIEW FINDINGS
────────────────────────────────────────────────────────────────────
Ticket      : {TICKET_KEY} — {summary}
Branch      : {feature branch}
Reviewed by : Claude Review Panel (Morgan, Alex, Sam, Jordan, Riley)
Date        : {today's date}
Verdict     : ✅ APPROVED / ⚠️ APPROVED WITH CONDITIONS /
              🔄 REQUEST CHANGES / ❌ REJECT
────────────────────────────────────────────────────────────────────

CRITICAL ISSUES  ({N} — must be resolved before merge)
────────────────────────────────────────────────────────────────────
{For each Critical issue:}
[C{N}] {Pattern or category name}
  File     : {file:line}
  Finding  : {description of the issue}
  Fix      : {specific recommended change}
  Raised by: {Alex / Sam / Jordan / Riley}

MAJOR ISSUES  ({N} — should be resolved before merge)
────────────────────────────────────────────────────────────────────
{For each Major issue:}
[M{N}] {Pattern or category name}
  File     : {file:line}
  Finding  : {description of the issue}
  Fix      : {specific recommended change}
  Raised by: {Alex / Sam / Jordan / Riley}

MINOR ISSUES  ({N} — recommended improvements)
────────────────────────────────────────────────────────────────────
{For each Minor issue:}
[m{N}] {Pattern or category name}
  File     : {file:line}
  Finding  : {description of the issue}
  Fix      : {specific recommended change}
  Raised by: {Alex / Sam / Jordan / Riley}

POSITIVES
────────────────────────────────────────────────────────────────────
{Bulleted list of what was done well — specific and constructive}

TEST COVERAGE SUMMARY
────────────────────────────────────────────────────────────────────
{Reproduce Riley's Test Coverage Assessment block from R5b verbatim}

CONDITIONS FOR APPROVAL  (if verdict is not ✅ APPROVED)
────────────────────────────────────────────────────────────────────
{Numbered list of required changes before the PR can be merged,
 ordered by priority — Critical first, then Major}

1. {Issue reference [C1/M1/etc.]} — {file:line} — {what to change}
2. ...

{If verdict is APPROVED: "No conditions — ready to merge."}
────────────────────────────────────────────────────────────────────
```

If there are **zero Critical and zero Major issues**, and coverage is Adequate or Partial, confirm:
> **This change is ready to merge** subject to any listed conditions.

If there are **Critical issues**, confirm:
> **This change must not be merged** until all Critical issues are resolved. Re-review recommended after changes are applied.

---

### Step R7 — Session Stats

Same procedure as Step 11 in Dev Mode — use codeburn daily data and the session-start baseline, falling back to manual estimation if unavailable. Print the summary line in the same format.

---

### Step R8 — Generate PDF Review Report

After Step R6 is complete, generate a PDF review report and save it to disk.

#### R8a. Configuration

Same as Step 12a in Dev Mode:

```bash
REPORT_DIR="${CLAUDE_REPORT_DIR:-$HOME/.prevoyant/reports}"
mkdir -p "$REPORT_DIR"
REPORT_SUFFIX="${CLAUDE_REPORT_SUFFIX:-}"
REPORT_BASE="{TICKET_KEY}-review"
[ -n "$REPORT_SUFFIX" ] && REPORT_BASE="${REPORT_BASE}-${REPORT_SUFFIX}"
```

#### R8b. Generate Markdown Source

Write `/tmp/{TICKET_KEY}-review.md`. Reproduce every step's full output — no summaries or omissions. Placeholders below are structural guides.

````
# {TICKET_KEY} — PR Review Report

| Field | Value |
|-------|-------|
| Date | {today's date} |
| Reviewer | Claude Review Panel (Prevoyant v1.2.3) |
| Ticket type | {Bug fix / Enhancement} |
| Priority | {priority} |
| Status | {status} |
| Feature branch | {feature branch name} |
| Base branch | {base branch} |
| Verdict | {✅ APPROVED / ⚠️ APPROVED WITH CONDITIONS / 🔄 REQUEST CHANGES / ❌ REJECT} |

---

## Step R1 — Jira Ticket

| Field | Value |
|-------|-------|
| Key | {TICKET_KEY} |
| Summary | {summary} |
| Type | {issuetype} |
| Priority | {priority} |
| Status | {status} |
| Assignee | {assignee} |
| Reporter | {reporter} |
| Labels | {labels or "None"} |
| Components | {components or "None"} |
| Fix Version(s) | {fixVersions or "Not set"} |
| Affected Version(s) | {versions or "Not set"} |

### Description

{Full ticket description — verbatim}

### Attachments

{List each attachment by name and type, or "No attachments"}

---

## Step R2 — Problem Understanding

### Problem Statement

{Reproduce the problem statement table from Step R2 — What/Who/Expected/Actual/Acceptance criteria}

### Linked Tickets

{Reproduce linked ticket summaries, or "No linked tickets found."}

### Attachment Analysis

{Reproduce attachment findings, or "No attachments — analysis skipped."}

---

## Step R3 — Comments & Context

### Comment Summary

{Reproduce comment summary bullets, or "No comments on ticket."}

### Prior Investigation Summary

{Reproduce Prior Investigation Summary block if found, or "No prior investigation found."}

---

## Step R4 — Code Changes

### Branch & Diff Summary

| Field | Value |
|-------|-------|
| Feature branch | {feature branch name} |
| Base branch | {base branch name} |
| Commits | {N commits} |
| Files changed | {N files} |

### Commit Log

{Reproduce git log output — one line per commit}

### Files Changed

| File | Change type | +/- lines |
|------|-------------|-----------|
{Reproduce the complete files-changed table from Step R4d}

---

## Step R5 — Engineering Panel Code Review

### R5a-i. Historical JIRA Precedents

{Reproduce the full Historical JIRA Precedents block verbatim from Step R5a-i, or "No historical tickets found."}

### R5a-ii. Morgan's Review Briefing

{Reproduce the full Morgan Review Briefing box verbatim from Step R5a-ii}

### R5b. Mid-Point Check-In (T+2)

{Mid-point check-in from Step R5b (Alex, Sam, Jordan, Riley statuses + Morgan's response)}

### R5c. Final Review Submissions (T+4)

{All 4 final review submissions from Step R5c (Alex, Sam, Jordan, Riley)}

### R5d. Riley's Question + Morgan's Cross-Examination (T+5)

{Reproduce the full cross-examination block verbatim}

### R5e. Debate Round

{Reproduce the full debate round verbatim, or "No challenges."}

### R5f. Morgan's Review Verdict (T+6)

{Morgan's Review Verdict from Step R5f (scores, coverage view, assessment, overall verdict, Best Review box)}

---

## Step R6 — Consolidated Review Report

{Full REVIEW FINDINGS block from Step R6 (Critical Issues, Major Issues, Minor Issues, Positives, Test Coverage Summary, Conditions for Approval)}

---

## Step R7 — Session Statistics

| Metric | Value |
|--------|-------|
| Steps completed | {N / 8} |
| Elapsed time | {HH:MM} |
| Estimated token count | {N tokens} |
| Estimated cost (Sonnet 4.6) | {$X.XX} |
| Ticket type | {Bug fix / Enhancement} |
| Verdict | {✅ APPROVED / ⚠️ APPROVED WITH CONDITIONS / 🔄 REQUEST CHANGES / ❌ REJECT} |
| Issues found | Critical: {N} / Major: {N} / Minor: {N} |

````

#### R8c. Convert to PDF

Same three-method sequence as Step 12c in Dev Mode (pandoc → Chrome headless → HTML fallback). Use `$REPORT_BASE` (already set to `{TICKET_KEY}-review` or `{TICKET_KEY}-review-{SUFFIX}`) for all output paths:

```bash
pandoc /tmp/{TICKET_KEY}-review.md \
  -o "${REPORT_DIR}/${REPORT_BASE}.pdf" \
  --pdf-engine=wkhtmltopdf \
  -V geometry:margin=2cm \
  -V fontsize=11pt
```

#### R8d. Archive and Confirm

```
📄 Review Report Generated
   Folder : {REPORT_DIR}/
   File   : ${REPORT_DIR}/${REPORT_BASE}.pdf
   Format : PDF  ← (or "HTML (PDF libraries unavailable)" if fallback used)
   Verdict: {✅ APPROVED / ⚠️ APPROVED WITH CONDITIONS / 🔄 REQUEST CHANGES / ❌ REJECT}
   Issues : Critical: {N}  Major: {N}  Minor: {N}
```

#### R8e. Temp File Cleanup

```bash
rm -f /tmp/{TICKET_KEY}-review.md /tmp/{TICKET_KEY}-review.html
```

Then end with:

> **Review complete.** See `${REPORT_DIR}/${REPORT_BASE}.pdf` for the full findings. {If REQUEST CHANGES or REJECT: "Share the report with the developer and request re-review after issues are addressed."}

---

### Step R9 — Knowledge Base: Record Review Learnings

After Step R8 confirms the PDF has been saved, update the knowledge base with what the review panel discovered. This ensures review findings are available to future Dev and Review sessions on related tickets.

#### R9a. Identify What Is Worth Recording

Scan the **full review session output** (all steps) and extract knowledge from two sources:

**Source 1 — `[KB+]` inline annotations** (primary source):

Scan all reviewer output (Steps R4, R5) for `[KB+]` markers emitted during the review. Same markers and target files as Step 13a. Morgan confirms which are genuinely new before writing. Note: `[KB+ BIZ]` in Review Mode may capture both confirmations and violations of business rules.

**Source 2 — Structured review extracts** (fallback — anything not already annotated):

| Category | Source | What to extract |
|----------|--------|----------------|
| **Confirmed / refuted root causes** | Steps R2, R3 | Does the code fix actually match the stated root cause? Record the confirmation. |
| **Business rules confirmed** | Steps R2, R5 (Sam) | Any business rule validated by seeing it correctly implemented in the diff |
| **Business rules violated** | Step R5 (Sam, Morgan) | Any business rule the diff violated — record with `⚠️ VIOLATION` tag |
| **Architecture insights** | Step R5 (Morgan, Sam) | Class hierarchy, ownership, layer responsibilities visible in the diff |
| **Patterns in the review** | Step R5 (Jordan) | Which of Jordan's 20 patterns appeared — check KB for NEW vs BUMP |
| **Regression risks confirmed** | Step R5 (Riley, Morgan) | Fragile areas Riley identified that future changes must protect |
| **QA gaps discovered** | Step R5 (Riley) | Missing test coverage — record so future tickets know to test these paths |
| **Historical JIRA precedents** | Step R5a Morgan JIRA search | Any business rule or architecture insight from past closed tickets |

Morgan de-duplicates across both sources before writing.

If the verdict is **APPROVED** with no noteworthy findings, state: "No new knowledge beyond ticket confirmation — recording ticket result only." and write only the ticket entry (R9b).

#### R9b. Write the Ticket Entry

Create or overwrite `{KNOWLEDGE_DIR}/tickets/{TICKET_KEY}.md`. For review sessions, use `type: bug-fix-reviewed` or `type: enhancement-reviewed` and populate the `verdict` field with the Morgan verdict.

Include a **Review Findings Summary** section in the file:
```markdown
## Review Findings Summary
Verdict: {✅ APPROVED / ⚠️ APPROVED WITH CONDITIONS / 🔄 REQUEST CHANGES / ❌ REJECT}
Critical issues: {N} | Major: {N} | Minor: {N}

{bulleted list of the most significant findings — Critical and Major only}
```

#### R9c. Update Shared Files

Apply the same rules as Step 13c in Dev Mode:
- **Confirm** existing business rules that the diff correctly implements (add `Confirmed by: {TICKET_KEY} review`)
- **Flag violations** of existing business rules as new entries in `shared/business-rules.md` with a `⚠️ VIOLATION` tag, citing the review finding
- Bump pattern frequency counters in `shared/patterns.md` for any Jordan patterns found in the diff
- Add or update regression risks identified by Riley in `shared/regression-risks.md`
- Append architecture insights discovered from reading the diff to `shared/architecture.md`

#### R9d. Update INDEX.md — Memory Palace section

Same process as Step 13d — for each new or updated entry, add triggers to the matched room(s) in the `## Memory Palace` section of INDEX.md, bump frequency counters for recurring patterns.

#### R9e. Update INDEX.md — Master Index section

Same as Step 13e — add/update the ticket row in `### Ticket Entries`, add new shared entries to `### Shared Knowledge Entries`, update header counts and date.

#### R9f. Publish KB

Follow the same publish procedure as Step 13f (encrypt if `PRX_KB_KEY` is set → git push → delete temp dir; same failure handling). Use the review-specific display formats below instead of the Dev Mode formats.

**If `KB_MODE=local`:**
```
📚 Knowledge Base Updated (local)
   Location      : {KNOWLEDGE_DIR}/
   Ticket entry  : tickets/{TICKET_KEY}.md — {created / updated}
   Verdict       : {✅ / ⚠️ / 🔄 / ❌} recorded
   Rules confirmed   : {N}  |  Rules violated: {N}
   Patterns bumped   : {list or "None"}
   Risks             : {N new / N updated}
   Architecture      : {N new / N updated}
   Palace            : {N triggers added to rooms: {room names}}
   INDEX.md          : {N rows added}
   Mental Map        : {N new / N confirmed / N corrected} (see Step R9g)
   Lessons           : {N new entries in lessons-learned/{developer}.md} (see Step R9h)
   Git               : local mode — no distribution
```

**If `KB_MODE=distributed`, on success (encryption enabled):**
```
📚 Knowledge Base Updated & Pushed (encrypted)
   Repository    : {PRX_KB_REPO}
   Location      : {KNOWLEDGE_DIR}/ (.md.enc files)
   Ticket entry  : tickets/{TICKET_KEY}.md.enc — {created / updated}
   Verdict       : {✅ / ⚠️ / 🔄 / ❌} recorded
   Rules confirmed   : {N}  |  Rules violated: {N}
   Patterns bumped   : {list or "None"}
   Risks             : {N new / N updated}
   Architecture      : {N new / N updated}
   Palace            : {N triggers added to rooms: {room names}}
   INDEX.md          : {N rows added / N re-indexed from disk}
   Mental Map        : {N new / N confirmed / N corrected} (see Step R9g)
   Encrypted     : {N} .md.enc files written
   Git           : pushed to origin/main ({short hash}) {or "branch created" on first push}
   Session temp  : {KB_WORK_DIR} deleted
```

**If `KB_MODE=distributed`, on success (no encryption):**
```
📚 Knowledge Base Updated & Pushed
   Repository    : {PRX_KB_REPO}
   Location      : {KNOWLEDGE_DIR}/
   Ticket entry  : tickets/{TICKET_KEY}.md — {created / updated}
   Verdict       : {✅ / ⚠️ / 🔄 / ❌} recorded
   Rules confirmed   : {N}  |  Rules violated: {N}
   Patterns bumped   : {list or "None"}
   Risks             : {N new / N updated}
   Architecture      : {N new / N updated}
   Palace            : {N triggers added to rooms: {room names}}
   INDEX.md          : {N rows added / N re-indexed from disk}
   Mental Map        : {N new / N confirmed / N corrected} (see Step R9g)
   Git           : pushed to origin/main ({short hash}) {or "branch created" on first push}
```

#### R9g. Update Core Mental Map

Apply the same process as Step 13g in Dev Mode. Scan all `[CMM+]` markers emitted during Steps R4 and R5 (reviewers may discover architecture facts, gotchas, or stale CMM entries while reading the code diff). Apply NEW / CONFIRM / CORRECT / DELETE actions and update `core-mental-map/INDEX.md` counts.

PR Review sessions are especially well-suited to confirming (or correcting) existing CMM entries because reviewers read the actual code changes — they can verify whether a CMM fact is still accurate in the patched version.

#### R9h. Save Lessons Learned

Apply the same process as Step 13h in Dev Mode. Collect `[LL+]` markers emitted during Steps R4 and R5, and append them to `lessons-learned/{developer}.md`.

#### R9i. Review Javed's Pending KB Contributions

Apply the same process as Step 13j in Dev Mode. Skip condition is identical: if `PRX_KBFLOW_ENABLED` is not `Y`/`YES`/`true` or `~/.prevoyant/knowledge-buildup/kbflow-pending.md` has no `Status: PENDING APPROVAL` entries, skip entirely.

PR Review sessions are especially well-positioned to evaluate Javed's contributions because reviewers have just read the code changes — they can verify whether a proposed CMM fact reflects the current state of the patched code.

---

### Step R10 — Bryan's Retrospective

**Skip condition:** Same as Step 14 — if `PRX_INCLUDE_SM_IN_SESSIONS_ENABLED` is not `Y`/`YES`/`true`, skip entirely.

Identical to Step 14 in Dev Mode with these differences:
- Token audit uses Step R7 session stats
- DoD check covers Steps R0–R9h (not Steps 0–13h)
- Consensus panel: Morgan + Riley + the reviewer from Step R5 whose findings were most substantive
- `process-efficiency.md` Session Log row records the review verdict (✅ / ⚠️ / 🔄 / ❌) in the `Status` column instead of budget status
- Compaction pass eligibility counts PR Review sessions in the same `Sessions tracked` counter as Dev Mode sessions
- Token spike detection (TOKEN_ALERT / BUDGET_ALERT) and Intervention Mode apply exactly as in 14c — review sessions are included in the rolling average and monthly spend calculations

---

---

## Estimate Mode

Execute these steps when the invocation triggers **Estimate Mode** (see Mode Selection above). Do not run Dev Mode or PR Review Mode steps. Present output for each step as it completes.

Story points measure **effort** — not hours. Each point reflects three combined factors:
- **Complexity** — how technically difficult or unclear the work is
- **Risk** — uncertainty, third-party dependencies, regression exposure, unknowns
- **Repetition** — how familiar the team is with this type of work (high familiarity = fewer points)

Scale (modified Fibonacci): **1 · 2 · 3 · 5 · 8 · 13 · 20 · ?**

| Points | Meaning |
|--------|---------|
| 1 | Trivial — very low complexity, minimal risk, team has done this many times |
| 2 | Simple — low complexity, low risk, familiar territory |
| 3 | Small — one area of moderate complexity or some risk or limited familiarity |
| 5 | Medium — notable complexity + some risk, or one meaningful unknown |
| 8 | Large — high complexity or significant risk or unfamiliar system area |
| 13 | Very large — multiple complex areas, several risks, needs careful planning |
| 20 | Epic — too broad; strong recommendation to split before committing |
| ? | Cannot estimate — spike required to resolve critical unknowns first |

Points are **relative**: a 4-point task is twice the effort of a 2-point task. They are never converted to hours.

Each engineer draws on their **acquired knowledge of the system** — the KB (`core-mental-map/`, `shared/patterns.md`, `shared/gotchas.md`, past ticket records, `lessons-learned/`) and their domain expertise — to score all three dimensions before committing to a vote. The KB is the team's shared memory; it must be actively consulted, not just acknowledged.

Bryan observes silently and runs Step E7 if `PRX_INCLUDE_SM_IN_SESSIONS_ENABLED=Y`. The session ends only when the full team reaches a single agreed story point.

---

### Step E0 — KB Initialisation & System Knowledge Load

Same process as Step 0 in Dev Mode. Pull KB and surface prior knowledge on the ticket's components and labels.

**Apply the server pre-load gate from Step 0** before any disk operations — same check, same fallback behaviour.

**Additionally**, each engineer reads the following before E2 begins — this is the system knowledge that will drive their estimates:

- `core-mental-map/architecture.md` — component boundaries, ownership, coupling hotspots
- `core-mental-map/gotchas.md` — non-obvious footguns and edge-case traps in the affected area
- `core-mental-map/data-flows.md` — write paths, RPC contracts, side-effects
- `shared/patterns.md` — search for `[ESTIMATE-PATTERN]` entries on the affected components
- `tickets/` — scan for `## Estimation` sections on past tickets touching the same components
- `lessons-learned/` — any developer-recorded pitfalls relevant to this area
- `shared/process-efficiency.md` — check for past estimation accuracy notes

Present the Prior Knowledge block (same format as Step 0) and append an **Estimation-relevant KB findings** subsection:

```
── Estimation KB Findings ────────────────────────────────────────────
  Past estimates on similar work:
  • {TICKET_KEY}: {N}pts — {one-line reason} (accuracy: {over/under/accurate} vs actual)
  • {or "none found"}

  Known complexity patterns (from patterns.md / gotchas.md):
  • {pattern 1 relevant to this ticket}
  • {or "none found"}

  Relevant lessons learned:
  • {lesson entry or "none found"}
─────────────────────────────────────────────────────────────────────
```

#### E0-b. Jira Cycle Time Query *(runs after E1 — components known)*

After ingesting the ticket in E1, query Jira for historical cycle time on the same components. This gives the team a throughput anchor — actual clock time it took to complete similar past work — before casting any votes.

**JQL query (run via `mcp__jira__jira_search` or equivalent):**

```
project = {PROJECT_KEY}
AND component in ("{COMPONENTS}")
AND status in (Done, Resolved, Closed)
AND issuetype in ({ISSUE_TYPE}, Bug, Story, Task)
AND resolutiondate >= -{LOOKBACK_DAYS}d
ORDER BY resolutiondate DESC
```

Use `LOOKBACK_DAYS = 180` (6 months). Limit to 30 results. Request fields: `key`, `summary`, `created`, `resolutiondate`, `story_points` (or `customfield_10016`), `issuetype`, `components`.

**Cycle time computation per ticket:**

```
cycle_time_days = (resolutiondate - created).total_days
```

Exclude any ticket where `cycle_time_days > 180` (outlier — abandoned and re-opened) or `cycle_time_days < 0` (data error).

**Compute percentiles from the valid set:**

```
Sort cycle times ascending.
P50 = value at the 50th percentile (median).
P90 = value at the 90th percentile (slowest 10%).
N   = count of valid tickets used.
```

If fewer than 5 valid tickets are found: widen to all issue types and all time. If still fewer than 5: state `Cycle time: insufficient history ({N} tickets) — anchoring on KB estimates only.`

**Surface as a Historical Throughput block** — append to the Estimation KB Findings block:

```
── Historical Throughput (Jira cycle time — same components) ─────────
  Tickets analysed: {N} closed tickets on {COMPONENTS} (last 180 days)
  Cycle time P50  : {X} days   ← half of similar tickets finished within this
  Cycle time P90  : {Y} days   ← 90% finished within this; outliers took longer

  Reference points for the team:
  • Shortest recent:  {min} days  ({TICKET_KEY} — "{summary excerpt}")
  • Longest recent:   {max} days  ({TICKET_KEY} — "{summary excerpt}")
  • Most similar:     {TICKET_KEY} ({N}pts if set) — {one-line summary, cycle time}

  Throughput note: {one sentence interpreting the data — e.g. "P50 of 4 days
    suggests this component class typically closes in under a week; a vote of
    8+ pts should be backed by concrete complexity evidence, not just caution."
    or "P90 of 22 days flags this component as historically unpredictable —
    unknowns are real; a spike or split is worth considering."}
─────────────────────────────────────────────────────────────────────
```

Engineers **must reference the throughput anchor** in their E3 vote rationale. A vote significantly above P90's implied effort should state why this ticket is an outlier. A vote well below P50 should confirm the simplifying factors. Silence on the anchor is not allowed.

If the Jira MCP call fails: log `CYCLE_TIME_WARN: Jira query unavailable — throughput anchor skipped.` and continue without it.

---

### Step E1 — Ingest Ticket

Same as Step 1 in Dev Mode. Fetch all standard Jira fields. Also surface:
- The current **Story Points** field value if already set — show it as context only; instruct the team not to anchor on it during voting
- Any **sub-tasks** already linked (they reduce scope of the parent)
- Explicit **acceptance criteria** — the team estimates the full AC, not just the description

---

### Step E2 — Scope & Dimension Analysis

Before any individual votes are cast, the full Engineering Panel jointly maps the ticket against the three story point dimensions, drawing explicitly on the KB findings from E0 and each engineer's system knowledge.

#### E2-a. Dependency Graph Scoring *(runs before the dimension table)*

Before filling in the Risk dimension, Morgan quantifies **how many other files in the codebase import or call into the affected module(s)**. Dependent count is an objective proxy for regression surface — more dependents means a change here can silently break more callers.

Identify the primary affected files from the ticket description and Step E1 context (the same files that would land in Step 5's file map in Dev Mode). Then count their dependents:

```bash
# Preferred — graphify (single query, transitive-aware)
which graphify >/dev/null 2>&1 && [ -f "$REPO_DIR/graph.json" ] && \
  graphify get-neighbors "{PrimaryClass}" \
    --edges imports,calls --direction incoming --depth 1 \
    --graph "$REPO_DIR/graph.json" | wc -l

# Fallback — grep for import statements referencing the primary class
grep -rn "import.*{PrimaryClass}\|import.*{PrimaryPackage}" \
  --include="*.java" "$REPO_DIR/" | wc -l
```

Run for each primary affected class (cap at 3 classes; use the highest dependent count as the score).

**Dependency Risk Scale:**

| Dependent count | Risk contribution | Label |
|----------------|-------------------|-------|
| 0–2 | Negligible — isolated change | `DEP-LOW` |
| 3–8 | Moderate — a handful of callers to smoke-test | `DEP-MED` |
| 9–20 | High — widely-used; regression surface is real | `DEP-HIGH` |
| 21+ | Critical — system-wide coupling; treat as architectural risk | `DEP-CRITICAL` |

Surface as a **Dependency Score block** (fed directly into the dimension table):

```
── Dependency Score ──────────────────────────────────────────────────
  Primary class   : {ClassName}  ({file path})
  Dependent count : {N} files import or call this class
  Risk label      : DEP-{LOW/MED/HIGH/CRITICAL}
  Top dependents  : {up to 5 caller file names — module-level only, no line numbers}
  Graph source    : graphify / grep fallback / unavailable

  Jordan's risk multiplier: {see table above — carried into dimension table below}
─────────────────────────────────────────────────────────────────────
```

If neither graphify nor grep is feasible (no `REPO_DIR` access): state `Dependency score: skipped — REPO_DIR unavailable; Jordan applies qualitative judgement.`

Emit `[KB+ RISK]` for any class labelled `DEP-HIGH` or `DEP-CRITICAL` that is not already in `shared/regression-risks.md`.

#### E2-b. Scope & Dimension Table

```
── Scope & Dimension Analysis ────────────────────────────────────────
  Ticket type : {Bug / Story / Enhancement / Spike}
  Delivers    : {one-line restatement of what must be done to close the ticket}

  Work areas:
  ┌──────────────────────┬──────────────────────────────────┬──────────┐
  │ Area                 │ What changes                     │ Effort   │
  ├──────────────────────┼──────────────────────────────────┼──────────┤
  │ Backend              │ {what changes or "—"}            │ Low/Med/High │
  │ Frontend             │ {what changes or "—"}            │ Low/Med/High │
  │ Database             │ {schema/migration or "—"}        │ Low/Med/High │
  │ Infrastructure       │ {config/env/deploy or "—"}       │ Low/Med/High │
  │ Tests                │ {unit/integration/e2e scope}     │ Low/Med/High │
  └──────────────────────┴──────────────────────────────────┴──────────┘

  Dimension drivers:
  ┌─────────────────┬──────────────┬───────────────────────────────────┐
  │ Dimension       │ Level        │ Evidence                          │
  ├─────────────────┼──────────────┼───────────────────────────────────┤
  │ Complexity      │ Low/Med/High │ {what makes it hard or simple — cite KB} │
  │ Risk            │ Low/Med/High │ {DEP-{LABEL} ({N} dependents) + unknowns │
  │                 │              │  + regression surface — cite E2-a score} │
  │ Repetition      │ Familiar/Partial/New │ {KB patterns / past tickets / new territory} │
  └─────────────────┴──────────────┴───────────────────────────────────┘

  Cycle time anchor (from E0-b):
  • P50: {X} days | P90: {Y} days | N={Z} past tickets
  • {Throughput note — one sentence}

  Unknowns  : {things that, if unresolved, make any estimate unreliable}
  Dependencies: {external services, teams, or tickets that must land first}
─────────────────────────────────────────────────────────────────────
```

**Spike gate:** If there are critical unknowns that make the Complexity or Risk dimension impossible to assess, recommend a spike and stop — do not proceed to E3 unless the developer overrides.

**Split gate:** If the ticket spans 4+ areas at Medium/High effort, recommend splitting into sub-tasks and offer to estimate each separately.

---

### Step E3 — Planning Poker: Round 1

Each engineer independently scores all three dimensions through their domain lens, then commits to a single Fibonacci vote **before** seeing others' numbers. All five votes are revealed simultaneously.

**Domain focus per engineer:**

| Engineer | Complexity lens | Risk lens | Repetition lens |
|----------|----------------|-----------|-----------------|
| **Morgan** | Architectural complexity; system design decisions required | System-wide regression risk; dependency chain risk | Has the team solved a structurally similar problem before? |
| **Alex** | Backend algorithm complexity; API surface changes; data model impact | Data migration risk; third-party API reliability | Are the affected services well-understood by the backend team? |
| **Sam** | Business logic complexity; cross-layer integration; AC ambiguity | Stakeholder/domain rule uncertainty; acceptance criteria gaps | Has this class of feature been built before in this codebase? |
| **Jordan** | Infrastructure/config complexity; cross-service protocol changes | **Dependency score from E2-a is Jordan's primary Risk input.** DEP-LOW → Risk Low; DEP-MED → Risk Medium; DEP-HIGH → Risk High; DEP-CRITICAL → Risk High + mandatory split discussion. Jordan may adjust one level up or down based on qualitative factors, but must state the reason. | Is this deployment pattern routine or novel for the team? |
| **Henk** | Business rule complexity; known exceptions or client-specific behaviours that must be preserved | Risk of altering behaviour existing clients depend on; undocumented business rule conflicts | Has this business rule area been touched before without regression? |
| **Riley** | Test complexity; observable edge-case surface area | Regression risk; unknown coverage gaps; flaky test likelihood | Does a test harness already exist for this area? |

**Vote card format (each engineer, stated after the simultaneous reveal):**

```
{Name} — {N} pts
  Complexity  : {Low/Med/High} — {specific reason, citing system knowledge or KB entry}
  Risk        : {Low/Med/High} — {specific uncertainty or dependency driving this}
               {Jordan only: "DEP-{LABEL} ({N} dependents) → base Risk {level};
                adjusted {up/down/unchanged} because {reason}" or
                "Dependency score unavailable — qualitative: {reason}"}
  Repetition  : {Familiar/Partial/New} — {KB pattern or past ticket reference, or "no prior art found"}
  Throughput  : {one sentence anchoring against P50/P90 — e.g. "P50 is 4 days; my
                 vote of 5 reflects one unknown that could push past P50" or
                 "Cycle time data unavailable — no anchor"}
  Key unknown : {the single thing that, if resolved, would most change their vote}
```

**Reveal format:**

```
── Planning Poker — Round 1 ──────────────────────────────────────────
  🃏  Morgan   │  Alex   │  Sam   │  Jordan  │  Riley
      {N}      │  {N}    │  {N}   │   {N}    │   {N}

  Range: {min}–{max}   Spread: {max − min} points
─────────────────────────────────────────────────────────────────────
```

Immediately print all five vote cards.

If all five votes are identical → skip E4, proceed to E5 with confidence **High**.

---

### Step E4 — Debate & Consensus

Run only when votes differ after any round. Maximum **3 debate rounds** before Morgan makes a binding final call.

Debates must be grounded in the three dimensions — not just "your number feels high." When an engineer challenges another's vote, they must name which dimension they disagree on and cite system knowledge or KB evidence.

#### Debate structure (each round)

1. **Highest voter speaks first** — which dimension(s) are others underweighting, and what system knowledge or KB evidence supports their assessment?
2. **Lowest voter responds** — which simplifying factors apply, and what KB entries or past patterns support a lower score?
3. **Remaining engineers react** — one paragraph each: which argument moved them (if any) and why? Are they revising their vote?
4. **Re-vote** — simultaneous reveal, same format as E3. Label it Round 2, Round 3, etc.

After each re-vote:
- All votes match → consensus reached; proceed to E5
  - Round 2 → confidence **Medium**
  - Round 3 → confidence **Low**
- Still differ → continue (up to Round 3)

#### Morgan's binding final call (after Round 3 without consensus)

```
── Morgan — Binding Final Call ───────────────────────────────────────
  After {N} rounds without consensus:
  Final estimate : {N} story points
  Deciding factor: {which dimension was the sticking point and how Morgan
                    resolved the disagreement — cite specific system
                    knowledge or KB evidence that tipped the balance}
  Dissenting view: {who voted differently, their dimension argument, and
                    why it was not adopted — recorded for transparency}
  Confidence     : Low — revisit if {specific condition or unknown} changes
─────────────────────────────────────────────────────────────────────
```

---

### Step E5 — Final Estimate

```
══ ESTIMATE RESULT ════════════════════════════════════════════════════

  Story Points : {N}
  Confidence   : High / Medium / Low
  Consensus    : Unanimous (Round {N}) / Morgan final call (after Round {N})
  Ticket       : {TICKET_KEY} — {summary}

  Dimension summary:
  • Complexity  : {Low/Med/High} — {key driver}
  • Risk        : {Low/Med/High} — {key driver}
  • Repetition  : {Familiar/Partial/New} — {key driver}

  Key assumptions:
  • {assumption 1}
  • {assumption 2}

  What would change this estimate:
  • {if X is resolved/discovered} → could shift to {N} pts
  • {if scope expands to Y} → recommend splitting

  Recommended action:
  • ✅  Proceed as estimated
  • ⚠️   Spike first — resolve: {specific unknown}
  • 🔀  Split recommended — {suggested sub-task breakdown}

══════════════════════════════════════════════════════════════════════
```

---

### Step E5b — Generate Estimate Report

#### E5b-a. Configuration

```bash
REPORT_DIR="${CLAUDE_REPORT_DIR:-$HOME/.prevoyant/reports}"
mkdir -p "$REPORT_DIR"
REPORT_SUFFIX="${CLAUDE_REPORT_SUFFIX:-}"
REPORT_BASE="{TICKET_KEY}-estimate"
[ -n "$REPORT_SUFFIX" ] && REPORT_BASE="${REPORT_BASE}-${REPORT_SUFFIX}"
```

> **Filename rule:** Base name is `{TICKET_KEY}-estimate`. Appends `CLAUDE_REPORT_SUFFIX` when set (injected by Prevoyant Server on replay). Use `$REPORT_BASE` for all output paths.

**PDF tool pre-check** — same as Step 12a: detect `pandoc`, Chrome/Chromium, or fall back to HTML.

#### E5b-b. Generate Markdown Source

Write `/tmp/{TICKET_KEY}-estimate.md` with the full estimation session output:

````
# {TICKET_KEY} — Story Point Estimate

| Field | Value |
|-------|-------|
| Date | {today's date} |
| Analyst | Claude (Prevoyant v1.2.3) |
| Ticket | {TICKET_KEY} — {summary} |
| Story Points | **{N}** |
| Confidence | {High / Medium / Low} |
| Consensus | {Unanimous (Round N) / Morgan final call (Round N)} |

---

## Step E1 — Ticket Summary

{Full ticket description, type, priority, status, and any relevant context from Step E1}

---

## Step E2 — Scope & Dimension Analysis

### Complexity — {Low / Med / High}
{Reasoning}

### Risk — {Low / Med / High}
{Reasoning}

### Repetition — {Familiar / Partial / New}
{Reasoning}

---

## Step E3–E4 — Planning Poker

{For each round: engineer votes and brief rationale, dimension driving disagreement, debate summary}

---

## Step E5 — Final Estimate

{Reproduce the full ESTIMATE RESULT block verbatim}

### Key Assumptions
{bullet list}

### What Would Change This Estimate
{bullet list}

### Recommended Action
{✅ Proceed / ⚠️ Spike / 🔀 Split — with details}
````

#### E5b-c. Convert to PDF

Same three-method sequence as Step 12c in Dev Mode. Use `$REPORT_BASE` for all output paths:

```bash
pandoc /tmp/{TICKET_KEY}-estimate.md \
  -o "${REPORT_DIR}/${REPORT_BASE}.pdf" \
  --pdf-engine=wkhtmltopdf \
  -V geometry:margin=2cm \
  -V fontsize=11pt
```

Chrome headless and HTML fallback follow the same pattern as Step 12c — substitute `{TICKET_KEY}-estimate` for `{TICKET_KEY}-analysis` in all paths.

#### E5b-d. Archive and Confirm

```
📄 Estimate Report Generated
   Folder : {REPORT_DIR}/
   File   : ${REPORT_DIR}/${REPORT_BASE}.pdf
   Format : PDF  ← (or "HTML (PDF libraries unavailable)" if fallback used)
   Points : {N} pts ({confidence}, {consensus})
```

#### E5b-e. Temp File Cleanup

```bash
rm -f /tmp/{TICKET_KEY}-estimate.md /tmp/{TICKET_KEY}-estimate.html
```

---

### Step E6 — KB Update

Record the estimation session so future sessions can reference past sizing decisions for similar work.

**1. Ticket file** (`tickets/{TICKET_KEY}.md`) — append an `## Estimation` section:
```markdown
## Estimation
date: {today} | estimate: {N}pts | confidence: {High/Med/Low} | rounds: {N} | consensus: {Unanimous/Morgan call}
complexity: {Low/Med/High} | risk: {Low/Med/High} | repetition: {Familiar/Partial/New}
assumptions: {key assumptions, comma-separated}
what-would-change: {conditions that would shift the estimate}
```

**2. Shared patterns** (`shared/patterns.md`) — if any dimension driver will recur on future similar tickets, append an `[ESTIMATE-PATTERN]` annotation:
```markdown
[ESTIMATE-PATTERN] {component/area}: {insight — e.g. "DB migrations in the X service always push complexity to High due to dual-write requirement"} — first seen: {TICKET_KEY} ({N}pts)
```

**3. INDEX.md** — add triggers to the relevant Memory Palace rooms for the components touched during estimation.

---

### Step E7 — Bryan's Retrospective (Estimate Mode)

**Skip condition:** Same as Step 14 — if `PRX_INCLUDE_SM_IN_SESSIONS_ENABLED` is not `Y`/`YES`/`true`, skip entirely.

Identical to Step 14 in Dev Mode with these differences:
- Token audit: run `npx --yes codeburn@latest report --from $(date +%Y-%m-%d) --to $(date +%Y-%m-%d) --format json` and compute session delta from baseline (same as Step 11)
- DoD check covers Steps E0–E7
- Process audit focuses on estimation quality: Did engineers cite KB evidence or rely on gut feel? Were the dimension drivers grounded in system knowledge? Were debate rounds substantive or circular? Did the existing Jira value anchor any votes?
- Session Log row format:
  ```
  date: {today} | developer: {DEVELOPER} | ticket: {TICKET_KEY} | type: Estimate | cost: ${cost} | estimate: {N}pts ({confidence}, {N} rounds) | status: ✅
  ```
- No branch creation or code changes — Bryan's SKILL.md improvement proposals focus on the estimation workflow itself
- Token spike detection (TOKEN_ALERT / BUDGET_ALERT) and Intervention Mode apply exactly as in 14c — estimate sessions count toward the rolling average and monthly spend

---

---

---

## Watch Mode

Watch Mode is invoked automatically by the Prevoyant Server ticket watcher. It runs headlessly (`AUTO_MODE=Y`) and produces a structured progress digest that is emailed to `PRX_EMAIL_TO`.

### Step W0 — KB Query

Query the knowledge base for any prior context on the ticket.

Announce: `### Step W0 — KB Query`

- Load `${PRX_KNOWLEDGE_DIR}` (or the distributed KB clone if configured).
- Search for any existing entries related to `${TICKET_KEY}`.
- Summarise prior context in 2–3 sentences. If nothing found, output "No prior KB context found."

---

### Step W1 — Fetch Ticket

Announce: `### Step W1 — Fetch Ticket`

Using the Jira MCP tools:
1. Fetch the full ticket details for `${TICKET_KEY}` (summary, description, assignee, status, priority, labels, fix version).
2. Fetch all comments on the ticket, newest first.
3. Fetch attachment metadata (names, sizes, upload dates) if available.

Output a concise **Ticket Snapshot**:

```
Ticket   : {KEY} — {Summary}
Status   : {Status}
Assignee : {Assignee}
Priority : {Priority}
Created  : {Created date}
Updated  : {Last updated}
Comments : {N} comment(s)
```

---

### Step W2 — Progress Analysis

Announce: `### Step W2 — Progress Analysis`

Analyse the full ticket content — description, all comments, and attachment names — to assess current progress.

Evaluate:
- What work has already been done?
- Is the team moving forward, stalled, or blocked?
- Are there open questions or unresolved blockers?
- Are commitments or deadlines mentioned? Are they at risk?
- What is the overall trajectory?

---

### Step W3 — Digest Output

Announce: `### Step W3 — Digest Output`

Produce the final digest using **exactly** these section headers (the server parses them for the email):

---

## Ticket Summary

What is this ticket about? 2–3 sentences covering the purpose, scope, and business context. Written for a reader who has not seen the ticket before.

---

## Progress Assessment

What has been accomplished so far? Is work moving forward at a reasonable pace?

---

## Blockers & Concerns

What is blocking progress or causing concern? List specific issues, unanswered questions, or risks.

---

## What Should Happen Next

Concrete, actionable next steps — who should do what and by when where possible.

---

## Overall Verdict

**ONE OF: ON TRACK | NEEDS ATTENTION | BLOCKED | STALLED**

Brief explanation (1–2 sentences) of your verdict.

---

Keep each section under 100 words. Be direct and actionable. Do not include pleasantries or meta-commentary.

---

## Output Format

Present output in clearly labelled sections. Use markdown headings. Keep each section concise but complete.

**Step announcements (mandatory):** You **must** output the step header on its own line as the very first thing when beginning each step, before any content. Use exactly this format:

```
### Step N — {Step Label}
```

Examples: `### Step 3 — Understand the Problem`, `### Step R5 — Engineering Panel`, `### Step E2 — Scope & Dimension Analysis`, `### Step E5b — Generate Estimate Report`.

The Prevoyant Server dashboard detects these markers in real time to drive the pipeline progress display. Without them the pipeline section stays blank.

**Dev Mode:** Step 0 (KB query) → Steps 1–12 → Step 13 (KB update) → Step 14 (Bryan retrospective). Step 12 produces the PDF confirmation; Step 13 produces the KB update confirmation; Step 14 closes the session. When `FORCE_FULL_RUN_ON=1`, all steps 1–12 must run in full — never condense or jump ahead.

**PR Review Mode:** Step R0 (KB query) → Steps R1–R8 → Step R9 (KB update) → Step R10 (Bryan retrospective). Step R8 produces the PDF confirmation; Step R9 produces the KB update confirmation; Step R10 closes the session.

**Estimate Mode:** Step E0 (KB query) → Steps E1–E5 (scope → planning poker → debate → consensus) → Step E5b (PDF report) → Step E6 (KB update) → Step E7 (Bryan retrospective). Step E5 produces the final estimate block; Step E5b produces the PDF; Step E6 produces the KB update confirmation; Step E7 closes the session.

**Watch Mode:** Step W0 (KB query) → Step W1 (fetch ticket + all comments) → Step W2 (progress analysis) → Step W3 (digest output). Runs headlessly; output is consumed by the Prevoyant Server ticket watcher, which emails the digest automatically. Always announce each step header exactly as `### Step W{N} — {Label}` before any content.

---

## Project Context

- **Repository:** `{REPO_DIR}/` (configured via `REPO_DIR` in `SKILL.md` Configuration section)
- **Main branch:** `development` (or as configured in your repo)
- **Branch format:** `Feature/{TICKET_KEY}_{Title}`
- **Jira instance:** `{JIRA_URL}` (from env var)
- **Tech stack:** Adapt the file path patterns in steps 5–8 to match your project's directory structure.
