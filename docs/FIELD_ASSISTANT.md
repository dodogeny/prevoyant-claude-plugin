# Field Assistant — Nabeel's Interface to the Team

> The Field Assistant is a dashboard tab at `/dashboard/field` that gives Nabeel (Senior Site Engineer) a direct line to the team's accumulated knowledge — and a write path back into the KB from the field.

---

## Why it exists

The dev team's knowledge lives in the KB and Cortex. Nabeel has a different kind of knowledge: what actually happens at client installations — alarm sequences, hardware quirks, provisioning edge cases. Neither knowledge base is complete without the other.

The Field Assistant closes this gap in both directions:

| Direction | What happens |
|-----------|-------------|
| **Team → Nabeel** | Nabeel asks a question; the server synthesises an answer from Cortex facts, shared KB files, and P2P mesh observations — instantly, without waiting for a dev to be online |
| **Nabeel → Team** | Nabeel logs a field finding (symptom / root cause / fix); it is written to `shared/field-intel.md` and broadcast to all connected dev machines via the P2P mesh |

---

## The UI

Four tabs at `/dashboard/field`:

| Tab | What it does |
|-----|-------------|
| **Ask the Team** | Chat-style question box. Ctrl+Enter / Cmd+Enter to submit. Answer cites which knowledge source it came from. Save the session for later reference. |
| **Log Field Finding** | Structured form: symptom, root cause, fix, optional site ID, component, and tags. One click saves to KB and broadcasts over P2P. |
| **Session History** | All Q&A sessions saved from this machine, newest first. Click to expand the answer. |
| **Field Intel KB** | Live read of `shared/field-intel.md` — all findings ever logged by Nabeel. Refresh button to pull latest. |

---

## Knowledge sources

When Nabeel asks a question, the server reads three sources and fuses them into a single prompt:

```
Question
   │
   ▼
┌─────────────────────────────────────────────────────────┐
│  fieldIntelAgent.buildQueryContext()                     │
│                                                         │
│  1. Cortex facts (PRX_CORTEX_ENABLED=Y)                 │
│     architecture.md, patterns.md, decisions.md,         │
│     business-rules.md, hotspots.md, glossary.md         │
│     → ~600–2000 tokens, always local                    │
│                                                         │
│  2. KB shared files                                     │
│     shared/field-intel.md  ← past Nabeel findings      │
│     shared/patterns.md                                  │
│     shared/architecture.md                             │
│     shared/business-rules.md                           │
│     shared/glossary.md                                  │
│                                                         │
│  3. P2P mesh observations (PRX_CORTEX_P2P_ENABLED=Y)   │
│     Top 30 confirmed observations, sorted by           │
│     confirmCount desc — cross-node verified first      │
└─────────────────────────────────────────────────────────┘
   │
   ▼
claude --print <fused-prompt> --output-format text
   │
   ▼
Answer + sources cited
```

**Offline behaviour:** Sources 1 and 2 are entirely local. As long as Cortex has been synthesised recently and the KB is present, Nabeel can get answers with no internet connection.

---

## Field Intel write path

When Nabeel submits a field finding:

```
Log Field Finding form
   │
   ├─► shared/field-intel.md (prepended, KB cache invalidated)
   │
   └─► cortexLayer.memory().observe()   (tag: field-intel, persona: nabeel)
          │
          └─► serverEvents.emit('cortex-obs-broadcast')
                 │
                 └─► P2P mesh broadcast to all connected peers
                        │
                        └─► Each peer's Cortex refresh picks up the new observation
```

The finding is also recorded in the activity log (`field_intel_logged`, actor=nabeel) so the team can see when Nabeel logged something.

---

## Session persistence

Q&A sessions that Nabeel saves are written to `~/.prevoyant/field-sessions/session-<timestamp>.json`. These are:

- **Local only** — they do not sync via P2P (they are Nabeel's personal history)
- **Visible in the Session History tab** — paginated, click to expand
- **Not in the KB** — only the Log Field Finding form writes to the KB

---

## Nabeel's persona

Nabeel's profile is at `plugin/config/personas/nabeel.md`. Key attributes:

- Senior Site Engineer, txswitch hub events expert
- Reads symptoms before hypotheses — always provides alarm code + timestamp
- Labels fixes as `[FIELD VERIFIED]` after they hold for a full traffic cycle
- Flags when a KB answer doesn't match field reality (that discrepancy is valuable data)
- Has his own `basic-memory` instance when `PRX_BASIC_MEMORY_ENABLED=Y`

---

## Activity log events

| Event type | Actor | Logged when |
|------------|-------|-------------|
| `field_query` | nabeel | Nabeel submits a question (records questionLen and sourceCount) |
| `field_intel_logged` | nabeel | Nabeel saves a field finding (records siteId, component, tagCount) |

Both events appear in the Activity Log page with the Nabeel actor badge (purple).

---

## Configuration

No new environment variables required. The feature uses existing infrastructure:

| Variable | Required for | Default |
|----------|-------------|---------|
| `PRX_CORTEX_ENABLED=Y` | Cortex facts source | Recommended |
| `PRX_P2P_ENABLED=Y` | P2P broadcast of field intel | Optional |
| `PRX_CORTEX_P2P_ENABLED=Y` | Mesh observations source + broadcast | Optional |
| `PRX_BASIC_MEMORY_ENABLED=Y` | Nabeel's personal memory (adds `basic-memory-nabeel` MCP) | Optional |

---

## See also

- [Nabeel's persona definition](../plugin/config/personas/nabeel.md)
- [fieldIntelAgent.js](../server/runner/fieldIntelAgent.js) — context builder, KB writer, session store
- [P2P.md](P2P.md) — how field intel observations propagate across the mesh
- [CORTEX.md](CORTEX.md) — how Cortex facts are synthesised and consumed
- [Field Assistant UI](http://localhost:3000/dashboard/field) — live dashboard tab
