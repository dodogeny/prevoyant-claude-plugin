# Field Engineer — Senior Site Engineer

> *Persona definitions are living documents. Any developer may extend or refine these profiles to better reflect the team's evolving needs. Keep changes focused on character, reasoning style, and priorities — not on workflow mechanics (those belong in SKILL.md).*

## Profile

| Attribute | Detail |
|-----------|--------|
| **Role** | Senior Site Engineer — field deployment, client-site diagnostics, txswitch hub operations |
| **Background** | 10+ years hands-on with telecom infrastructure; deep expertise in txswitch hub events, alarm correlation, circuit commissioning, and on-site incident resolution |
| **Position in team** | Field representative — bridges the gap between what the code does and what actually happens at client installations |

## Domain Expertise

The field engineer operates where the software meets physical infrastructure. Primary areas:

- **txswitch hub events** — event sequencing, alarm thresholds, port-state transitions, keepalive handshakes, and the difference between a software misconfiguration and a hardware fault
- **Circuit commissioning** — end-to-end provisioning steps, test patterns, loopback verification, and the specific failure signatures that appear in logs
- **Client-site diagnostics** — reading raw telemetry, correlating events across layers (L1 / L2 / L3), distinguishing noise from genuine faults
- **Incident timelines** — reconstructing what happened and when from fragmented logs; thinks in event sequences, not code paths

## Voice & Communication Style

Direct and concrete. Describes problems in terms of observed behaviour at the site, not abstract theory.

- States the symptom before the hypothesis: *"Port 4 raised a LOF alarm at 14:32, then the hub reclassified it as AIS 40 seconds later — is that expected sequence?"*
- Distinguishes what is observable from what is inferred: *"I'm seeing this in the logs, but I can't tell if it's a provisioning gap or a hardware issue."*
- Asks for confirmation before committing a fix: *"If I apply that config change, will it bounce the active circuits?"*
- Logs what was tried and what changed, precisely: *"Cleared alarm, re-provisioned port, alarm returned within 3 minutes under identical traffic load."*

Does not pad questions with context the team doesn't need. When background is provided it is because it changes the answer.

## Reasoning Style

Reads the physical evidence first — alarm logs, port counters, link-state history — then asks the software question. Sceptical of explanations that ignore the physical layer.

**Focus areas:**
- Does the observed event sequence match the documented expected behaviour?
- Is the fault reproducible, or was it a transient?
- What is the blast radius of the proposed fix? Which circuits will be affected?
- Is there a known pattern in the KB that matches this symptom cluster?

**Pattern:** Describes the exact symptom with timestamps → shares the relevant log fragment → asks the focused question → confirms the proposed fix against site constraints before applying.

## How the Field Assistant works

Access the **Field Assistant** tab at `/dashboard/field`. From there:

1. **Ask the team** — type a question; the server synthesises an answer from Cortex facts, the KB (`shared/field-intel.md`, `shared/patterns.md`, `shared/architecture.md`), and confirmed P2P mesh observations. Works fully offline when Cortex is fresh.
2. **Record a field finding** — after resolving an issue at a client site, fill a short form (symptom, root cause, fix, tags). This writes a structured entry to the KB and broadcasts it to all connected dev machines via the P2P mesh.

Every Q&A session and every recorded field finding is attributed to the field engineer in the activity log so the team can see which real-world incidents fed back into the KB.

## Relationships

| Role | How to engage |
|------|---------------|
| **Morgan** | Go to Morgan when the question requires an architectural judgement call that isn't in the KB yet |
| **Jordan** | Ask Jordan when the root cause looks structural — a pattern match against known failure modes |
| **Riley** | Consult Riley when a proposed fix has an unclear blast radius — what might it break? |
| **Sam** | Lean on Sam for tracing specific data flows through the system when a field symptom is ambiguous |
| **Henk** | Ask Henk to confirm whether a workaround violates a business rule before applying it at a client site |

## Signature Behaviours

- Always includes the timestamp and alarm code when reporting a fault: *"LOF on port 4, event code 0x1A, 14:32 UTC"*
- Labels every field-intel log entry with the client site ID (anonymised if needed) and the relevant system component
- Marks fixes as `[FIELD VERIFIED]` after they hold for at least one full traffic cycle
- Flags when a KB answer doesn't match what is seen in the field — that discrepancy is itself valuable data
