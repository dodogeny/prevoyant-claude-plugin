# P2P Intelligence Network — KB Sync & Collective Intelligence Mesh

> P2P turns Prevoyant from a per-developer tool into a living, self-organising team brain. Every node contributes its observations; the network validates them; the strongest signals propagate to every connected developer automatically.

---

## Overview

Prevoyant's P2P layer is a two-tier architecture built on [js-libp2p](https://github.com/libp2p/js-libp2p):

| Tier | What it does | Enabled by |
|------|-------------|-----------|
| **Tier 1 — KB Sync** | Propagates raw KB files (`.md`) between nodes. Same knowledge base on every machine. | `PRX_P2P_ENABLED=Y` |
| **Tier 2 — Collective Intelligence Mesh** | Propagates Cortex *observations* (distilled facts, patterns, decisions) between nodes. Shared intelligence layer on top of the shared KB. | `PRX_CORTEX_P2P_ENABLED=Y` (requires Tier 1) |

Both tiers are optional and independently toggleable. Many teams run Tier 1 alone for simple file sync. Tier 2 is what makes the system genuinely distributed intelligence rather than distributed storage.

---

## Why this matters: democratising Cortex

### Before P2P

```
Developer A                     Developer B
┌─────────────────┐             ┌─────────────────┐
│ Local KB        │             │ Local KB        │
│ local cortex    │      ✗      │ local cortex    │
│ 3 months of     │             │ started today   │
│ observations    │             │ zero context    │
└─────────────────┘             └─────────────────┘
```

Developer B joins the team. Their first session has no Cortex intelligence — no architecture facts, no accumulated patterns, no confirmed decisions. It takes weeks of sessions before their local Cortex reaches the same depth as A's.

### With P2P (Tier 1 only — distributed KB)

```
Developer A          git / KB sync          Developer B
┌─────────────┐  ──────────────────────►  ┌─────────────┐
│ Shared KB   │  ◄──────────────────────  │ Shared KB   │
│ tickets/    │                           │ tickets/    │
│ shared/     │                           │ shared/     │
│ core-mental │                           │ core-mental │
│   -map/     │                           │   -map/     │
└─────────────┘                           └─────────────┘
Local cortex facts        ✗               Local cortex facts
still diverge                             still diverge
```

KB files are shared. Cortex synthesis still happens independently on each machine from the same source files — so the *facts* converge, but the *observations* (what each node's Cortex has learned from actual sessions) stay local.

### With P2P (Tier 1 + Tier 2 — Collective Intelligence Mesh)

```
Developer A             GossipSub mesh              Developer B
┌─────────────────┐  ◄─────────────────────────►  ┌─────────────────┐
│ Shared KB       │                               │ Shared KB       │
│ Shared Cortex   │                               │ Shared Cortex   │
│                 │                               │                 │
│ observations:   │   cortex-observe broadcast    │ observations:   │
│   local (312)   │  ─────────────────────────►   │   local (0)     │
│   network (0)   │  ◄─────────────────────────   │   network (312) │
│                 │   cortex-query/1 on connect    │                 │
│ confirmCount    │                               │ confirmCount    │
│ reflects both   │                               │ reflects both   │
│ nodes' evidence │                               │ nodes' evidence │
└─────────────────┘                               └─────────────────┘
```

Developer B connects for the first time. Within 3.5 seconds, their node automatically requests A's entire observation cache via the `/prevoyant/cortex-query/1` stream protocol. They start their first session with 312 observations, the same architecture insights, the same confirmed patterns — the full accumulated intelligence of the network. No manual sync, no waiting.

This is the democratisation: **every node that joins the mesh inherits the collective intelligence of all connected nodes, instantly.**

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         PREVOYANT NODE (each machine)                   │
│                                                                         │
│  ┌─────────────┐    ┌─────────────────┐    ┌───────────────────────┐  │
│  │  SKILL.md   │    │  Cortex Worker  │    │  KB Files             │  │
│  │  Step 0a    │    │  (synthesis)    │    │  shared/              │  │
│  │  Step 0c    │    │                 │    │  core-mental-map/     │  │
│  │  (network   │    │  facts/*.md     │    │  tickets/             │  │
│  │   query)    │    │                 │    │  personas/            │  │
│  └──────┬──────┘    └────────┬────────┘    └──────────┬────────────┘  │
│         │                    │                         │               │
│         │                    ▼                         ▼               │
│         │           ┌─────────────────┐      ┌─────────────────────┐  │
│         │           │  CortexMemory   │      │  kbP2pWorker        │  │
│         │           │  (LMDB / JSONL) │      │  (worker_threads)   │  │
│         │           │                 │ ◄──► │                     │  │
│         │           │  observation    │      │  cortex cache       │  │
│         │           │  store          │      │  (Map, 2000 entries) │  │
│         │           └────────┬────────┘      └──────────┬──────────┘  │
│         │                    │                           │             │
│  ┌──────▼──────┐             │                           │             │
│  │  REST API   │◄────────────┘                           │             │
│  │  /dashboard/│                                         │             │
│  │  cortex/    │                                         │             │
│  │  network/   │                                         │             │
│  │  query      │                                         │             │
│  └─────────────┘                                         │             │
└───────────────────────────────────────────────────────── │ ────────────┘
                                                           │
                                              ┌────────────▼────────────┐
                                              │    libp2p node          │
                                              │                         │
                                              │  Transport: TCP         │
                                              │  Security:  Noise       │
                                              │  Muxer:     Yamux       │
                                              │  Pubsub:    GossipSub   │
                                              └────────────┬────────────┘
                                                           │
                          ┌────────────────────────────────┤
                          │           GossipSub topics     │
                          │                                │
               ┌──────────▼──────────┐      ┌─────────────▼─────────────┐
               │  prevoyant/         │      │  prevoyant/               │
               │  kb-sync/1          │      │  cortex-sync/             │
               │                     │      │  observations/1           │
               │  KB file content    │      │                           │
               │  (bulk or trickle)  │      │  prevoyant/               │
               │                     │      │  cortex-sync/sessions/1   │
               └─────────────────────┘      └───────────────────────────┘
                                                           │
                          ┌────────────────────────────────┤
                          │        Stream protocols        │
                          │                                │
               ┌──────────▼──────────┐      ┌─────────────▼─────────────┐
               │  /prevoyant/        │      │  /prevoyant/              │
               │  kb-sync-req/1      │      │  cortex-query/1           │
               │                     │      │                           │
               │  Delta / full KB    │      │  Full observation cache   │
               │  file sync on       │      │  dump on first connect    │
               │  connect            │      │                           │
               └─────────────────────┘      └───────────────────────────┘
```

### Peer discovery stack

```
New node comes online
        │
        ▼
1. mDNS (LAN, UDP 5353)         ──► finds peers on local subnet instantly
        │ (if no LAN peers found)
        ▼
2. IPFS public bootstrap nodes  ──► finds peers via DHT on the public internet
        │ (if Upstash configured)
        ▼
3. Upstash peer registry        ──► finds known Prevoyant nodes by team secret
```

Upstash peer presence keys (`prx:p2p:peer:<peerId>`) are refreshed every reconcile cycle (default 60 min) and expire after 2 hours. Nodes that go offline are automatically de-listed.

---

## Tier 1 — KB File Sync

### How it works

1. A developer completes a session. KB files are written to disk.
2. The `cortex-observation-written` event (or filesystem watcher in `filesystem` trigger mode) fires.
3. `kbP2pWorker` reads changed files since the last sync timestamp.
4. Files are packaged into a signed GossipSub message (or trickle batches) on the `prevoyant/kb-sync/1` topic.
5. All subscribed peers receive the message and write the files locally (conflict resolution: newest `lastModifiedMs` wins).

### Transfer modes

| Mode | How it works | Best for |
|------|-------------|----------|
| **Bulk** (default) | All changed files in one or two large GossipSub messages (max 750 KB per message, split if needed) | Small KBs or fast networks |
| **Trickle** (`PRX_P2P_TRICKLE=Y`) | Files sent in adaptive batches; batch size (1–10 files) and delay (100 ms–10 s) self-adjust based on measured RTT | Large KBs or congested/slow networks |

Trickle mode self-tunes: fast links converge quickly (10 files/batch, 100 ms gaps); slow or congested links back off automatically (1 file/batch, up to 10 s gaps). No configuration needed beyond the on/off toggle.

### Conflict resolution

When two nodes edit the same KB file concurrently, the file with the most recent `lastModifiedMs` wins. This is a last-write-wins strategy anchored to actual filesystem timestamps — not arrival order.

### Full sync on first connect

When a node connects to a peer for the first time (or after a restart with no persisted sync timestamp), it dials the `/prevoyant/kb-sync-req/1` stream protocol and requests all files (`sinceMs=0`). Subsequent reconnects only request files changed since the last sync timestamp (`sinceMs=<last-sync-ts>`), making reconnects fast.

Failed dials retry with exponential backoff: 2 s → 4 s → 8 s (3 attempts).

### Periodic reconcile

Every `PRX_P2P_RECONCILE_MINS` (default 60), each node broadcasts a **manifest fingerprint** (SHA-256 of all file paths and timestamps) on the KB sync topic. Peers compare against their own manifest and pull any deltas they're missing. This is the safety net for messages lost due to network interruption.

---

## Tier 2 — Collective Intelligence Mesh

### What is an observation?

An **observation** is a structured fact that a Cortex agent recorded during a real session — not a static KB entry, but a live finding:

```json
{
  "key":        "pattern::null-check::authMiddleware",
  "value": {
    "type":         "pattern",
    "summary":      "Missing null-check on session cookie causes 500 in auth middleware",
    "evidence":     ["PROJ-1234 root cause", "PROJ-1238 regression"],
    "confirmCount": 3,
    "promoted":     true,
    "ts":           1748123456789
  },
  "tags":       ["auth", "pattern", "hotspot"],
  "sourceNode": "alice-macbook"
}
```

Observations flow through four lifecycle stages:

```
RECORDED  ──►  BROADCAST  ──►  CONFIRMED  ──►  PROMOTED
(local)        (network)       (cross-node)    (KB entry)
```

1. **Recorded** — Cortex writes an observation to LMDB after a session.
2. **Broadcast** — `kbP2pWorker` receives a `cortex-broadcast` message from the main thread and publishes it to `prevoyant/cortex-sync/observations/1` via GossipSub.
3. **Confirmed** — When another node independently records the same observation (matching key), both nodes increment `confirmCount`. Observations confirmed by 2+ independent nodes carry stronger evidential weight.
4. **Promoted** — When `confirmCount` reaches `PRX_CORTEX_AUTO_PROMOTE_THRESHOLD` (default 3) AND the observation is ≥ `PRX_CORTEX_AUTO_PROMOTE_MIN_AGE_DAYS` (default 2 days) old, it is queued for KB promotion after a `PRX_CORTEX_AUTO_PROMOTE_DELAY_HOURS` (default 24h) review window. With `PRX_CORTEX_P2P_CONSENSUS_PROMOTE_PCT` set, promotion also requires confirmation from that percentage of connected peers.

### GossipSub topics

| Topic | Content | When published |
|-------|---------|----------------|
| `prevoyant/cortex-sync/observations/1` | Single observation (context, pattern, decision, hotspot) | On every `cortex-observation-written` event (deduplicated with `fromNetwork` guard) |
| `prevoyant/cortex-sync/sessions/1` | Session summary (larger, infrequent) | At session end when session type is `session-summary` |
| `prevoyant/cortex-sync/1` (legacy) | All observation types | Backward compat with pre-v1.3.5 nodes — all nodes subscribe and publish on this topic for 2 versions |

Routing session summaries to their own topic prevents per-session large blobs from saturating the observations topic that agents subscribe to mid-session.

### The cortex-query stream (organic network growth)

When a new node connects to a peer for the first time, it waits 3.5 seconds (to let GossipSub mesh stabilise) then dials the `/prevoyant/cortex-query/1` stream protocol:

```
New node                                  Existing peer
    │                                          │
    │  { sinceMs: 0, machine: "bob-laptop",   │
    │    sig: "<hmac>" }  ──────────────────► │
    │                                          │
    │  ◄──────────────────────────────────────│
    │  { machine: "alice-macbook",             │
    │    observations: [ ...312 obs... ] }     │
    │                                          │
    │  mergeObservation() × 312                │
    │  → local confirmCounts updated           │
    │  → promoted observations inherited       │
```

The new node merges all 312 observations into its local CortexMemory, taking `max(confirmCount)` when an observation exists on both sides. Promoted observations are immediately available to agents in the new node's next session — no warmup period required.

### Infinite-loop guard

When a node receives an observation from the network and writes it to its local CortexMemory, the write triggers a `cortex-observation-written` event. Without a guard, this would re-broadcast the observation back to the network, which would re-trigger the event on other nodes, and so on.

The guard: observations received from the network are written with `fromNetwork: true`. The broadcast handler in `kbP2pWorker.js` only fires for events where `fromNetwork !== true`. Network-sourced observations propagate once and stop.

### confirmCount mechanics

`confirmCount` reflects the number of independent sources that have recorded the same observation — it is never decremented and never overridden downward:

```
Node A records observation key "pattern::null-check::auth" → confirmCount: 1
Node A broadcasts to network
Node B receives → confirmCount: 1 (from A)
Node B independently records same observation → confirmCount: 2
Node B broadcasts confirm to network
Node A receives → confirmCount: max(1, 2) = 2
```

The `max(confirmCount)` merge rule means the strongest confirmed signal always wins, regardless of message arrival order.

### Layer 0c — Collective Intelligence Network Query (SKILL.md)

When `PRX_CORTEX_P2P_ENABLED=Y`, every dev/review/estimate session includes a new pass at Step 0:

```
Step 0a — Cortex Pass       reads local facts/*.md
Step 0b — KB relevance      reads raw KB for ticket-specific context
Step 0c — Network Query     GET /dashboard/cortex/network/query
                             ?minConfirms=2&limit=20
```

The Layer 0c response is injected into the Prior Knowledge block under a `NETWORK INTELLIGENCE` heading:

```markdown
## NETWORK INTELLIGENCE (2 nodes, 312 observations, 47 confirmed ≥2)

**pattern::retry-exhaustion::payment-service** [3 nodes] [promoted]
> Payment service retry loop exhausts thread pool when gateway is down.
> Evidence: PROJ-1201, PROJ-1238, PROJ-1244

**decision::database::always-use-readonly-replica** [2 nodes]
> All SELECT queries in the reporting module must target the read replica.
> Evidence: PROJ-1189 incident, PROJ-1203 regression
```

Observations confirmed by 3+ nodes and promoted carry the same authority as local Cortex facts. Agents cite `[NETWORK INTELLIGENCE]` in their reasoning so you can trace where cross-node signals influenced the analysis.

---

## Security model

### HMAC-SHA256 message authentication

Every GossipSub message (KB sync, cortex-observe, cortex-confirm, cortex-retract, cortex-ping) is wrapped in a signed envelope:

```json
{
  "v": 2,
  "payload": "<json-stringified-message>",
  "sig": "<hmac-sha256-hex-of-payload-using-PRX_P2P_SECRET>"
}
```

Messages with a missing or invalid signature are **silently dropped**. A node that doesn't share your `PRX_P2P_SECRET` can discover your node via DHT (peer IDs are public on the libp2p network) but cannot inject observations or KB files.

> **Change the default secret.** `.env` ships with `PRX_P2P_SECRET=LetMeInPrevoyant@2026`. Every team must change this before sharing their setup — any node with the default secret can write to your KB.

### AES-256-GCM content encryption (`PRX_P2P_ENCRYPT=Y`)

When content encryption is enabled, the *payload* of every KB file transfer is encrypted:

```
key  = HKDF-SHA256(PRX_P2P_SECRET, salt="prevoyant-p2p-v1")
iv   = 12 random bytes (generated per file, per message)
ct   = AES-256-GCM(key, iv, file-content)
wire = { path, encrypted: true, iv: "<hex>", content: "<ct-hex>", tag: "<auth-tag-hex>" }
```

Cortex observations are transmitted as JSON and do not use AES-GCM encryption — they are protected by HMAC authentication only. Content encryption is intended for teams on untrusted networks (public bootstrap routing) who want the KB file bytes to be unreadable to passive observers.

### RSA-2048 node identity (`PRX_P2P_RSA_PRIVATE_KEY` / `PRX_P2P_RSA_PUBLIC_KEY`)

Each node can generate a persistent RSA-2048 key pair from **Settings → P2P KB Sync → Generate RSA Key Pair**. The key pair is generated in-browser using the Web Crypto API and stored in `.env` as `\n`-escaped PEM. These keys are reserved for future per-peer key exchange (replacing the shared-secret model with per-pair asymmetric encryption) and do not currently affect message security.

### Peer identity persistence

Each node's libp2p peer ID is derived from a persistent Ed25519 key stored at `~/.prevoyant/server/p2p-key.b64`. The same peer ID is used across restarts so other nodes recognise the node without re-doing discovery.

---

## Setup guide

### Minimal setup (two machines, same LAN)

**Both machines:**

```bash
# 1. Set in .env
PRX_KB_MODE=distributed
PRX_P2P_ENABLED=Y
PRX_P2P_SECRET=change-me-to-a-strong-secret   # same on both
PRX_P2P_MDNS_ENABLED=Y                         # auto-discovers LAN peers

# 2. Start the server
bash server/scripts/start.sh      # macOS / Linux
.\server\scripts\start.ps1        # Windows

# 3. Verify — open dashboard and check P2P panel
# Peer count should reach 1 within ~5 seconds
```

That's it for LAN sync. mDNS handles peer discovery automatically.

### Adding Collective Intelligence Mesh

```bash
# Add to .env on both machines
PRX_CORTEX_ENABLED=Y
PRX_CORTEX_P2P_ENABLED=Y
PRX_CORTEX_QUERY_ENABLED=Y   # expose network/query API to agents

# Restart the server
bash server/scripts/start.sh
```

### WAN setup (two machines on different networks)

```bash
# Machine A — find its multiaddr from the dashboard P2P panel
# Example: /ip4/1.2.3.4/tcp/7001/p2p/12D3KooWAbc...

# Machine B — set the bootstrap node
PRX_P2P_BOOTSTRAP_NODES=/ip4/1.2.3.4/tcp/7001/p2p/12D3KooWAbc...
PRX_P2P_MDNS_ENABLED=N   # not useful across internet boundaries
```

Alternatively, configure Upstash for automatic WAN peer registration — nodes publish their multiaddr to `prx:p2p:peer:<peerId>` on every reconcile cycle and discover each other on startup.

### Team setup (3+ developers)

```bash
# Everyone sets the same PRX_P2P_SECRET in their .env.
# One machine acts as the always-on bootstrap node (e.g. the server running the webhook receiver).
# Others set PRX_P2P_BOOTSTRAP_NODES to that machine's multiaddr.
# mDNS handles discovery for devs on the same office LAN automatically.
```

No central coordinator is required once nodes are connected — every peer can relay to every other peer through the GossipSub mesh.

---

## Configuration reference

| Variable | Default | Description |
|----------|---------|-------------|
| `PRX_P2P_ENABLED` | `N` | Start the libp2p node and enable KB sync. Hot-toggled from Settings — no restart required. |
| `PRX_P2P_PORT` | `7001` | TCP port the libp2p node binds. Must be reachable by peers. |
| `PRX_P2P_SECRET` | `LetMeInPrevoyant@2026` | HMAC-SHA256 signing key. **Change before sharing with teammates.** All nodes in the mesh must use the same value. |
| `PRX_P2P_MDNS_ENABLED` | `Y` | mDNS LAN peer discovery. Disable on networks where UDP 5353 multicast is blocked (most corporate Wi-Fi) or in Docker. |
| `PRX_P2P_BOOTSTRAP_NODES` | IPFS defaults | Comma-separated multiaddrs for WAN peer seeding, e.g. `/ip4/1.2.3.4/tcp/7001/p2p/<peerId>`. Falls back to public IPFS bootstrap nodes if blank. |
| `PRX_P2P_RECONCILE_MINS` | `60` | Interval between full manifest reconcile broadcasts. Immediate delta sync on change is unaffected. |
| `PRX_P2P_TRICKLE` | `N` | Trickle transfer mode — files sent in adaptive batches rather than one bulk message. Self-tunes batch size and delay based on RTT. |
| `PRX_P2P_ENCRYPT` | `N` | AES-256-GCM file content encryption. Protects KB bytes on untrusted networks. Key derived from `PRX_P2P_SECRET`. |
| `PRX_P2P_RSA_PRIVATE_KEY` | — | PEM RSA-2048 private key (node identity, future per-peer encryption). Generate from Settings. |
| `PRX_P2P_RSA_PUBLIC_KEY` | — | Matching RSA-2048 public key. |
| `PRX_CORTEX_P2P_ENABLED` | `N` | Enable the Collective Intelligence Mesh (Tier 2). Requires `PRX_P2P_ENABLED=Y` and `PRX_CORTEX_ENABLED=Y`. |
| `PRX_CORTEX_QUERY_ENABLED` | `N` | Expose `GET /dashboard/cortex/network/query` for agent Layer 0c queries. |
| `PRX_CORTEX_P2P_CONSENSUS_PROMOTE_PCT` | `0` | Minimum percentage of connected peers that must have confirmed an observation before it can auto-promote to KB. `0` disables the peer-consensus gate. |

The following variables are shared with the KB sync layer and apply to both Tier 1 and Tier 2:

| Variable | Default | Description |
|----------|---------|-------------|
| `PRX_KB_SYNC_TRIGGER` | `session` | `session` — sync at end of session. `filesystem` — sync on any `.md` file change. `both` — both triggers. |
| `PRX_KB_SYNC_MACHINE` | `hostname` | Label shown in sync logs and observation `sourceNode` fields. Set to a recognisable developer name. |
| `PRX_KB_SYNC_DEBOUNCE_SECS` | `3` | Seconds to wait after the last file change before triggering sync (filesystem mode). |

---

## Dashboard

The Prevoyant Server dashboard surfaces the P2P layer through three panels:

### P2P Network panel (main dashboard)

Shows the live mesh topology as an animated SVG:

| State | Indicator | Meaning |
|-------|-----------|---------|
| **Connected** | Cyan 3-node triangle, pulsing edges, data packet traversal | ≥1 peer connected, mesh active |
| **Searching** | Amber single node, expanding sonar rings | Node started, no peers found yet |
| **Off / Starting** | Grey single node, slow pulse | P2P disabled or libp2p not yet initialised |

Metrics shown: self peer ID, connected peer count, sync-in count, sync-out count, last sync timestamp.

### Dashboard header badges

| Badge | Colour | Condition |
|-------|--------|-----------|
| **P2P** | Cyan, pulsing | `PRX_P2P_ENABLED=Y` and node is running |
| **Mesh** | Violet, animated 4-node diamond | `PRX_CORTEX_P2P_ENABLED=Y` and P2P active |

### Settings — P2P KB Sync section

All P2P variables editable from the UI. Changes take effect immediately via the `settings-saved` event — no restart needed. When P2P is enabled, the Redis/Upstash sync fields are automatically greyed out with an explanatory banner.

### Settings — Collective Intelligence Mesh section

Live stats panel: connected peers, observations received from network, observations sent to network, last mesh sync timestamp. Three controls: enable/disable mesh, enable/disable agent query API, consensus promotion threshold.

### REST API

| Endpoint | Description |
|----------|-------------|
| `GET /dashboard/p2p/peers` | `{ enabled, selfId, addrs, peers[], topic, syncsIn, syncsOut, lastSync }` |
| `GET /dashboard/cortex/network/peers` | Mesh health + stats from bridge state |
| `GET /dashboard/cortex/network/query` | Filtered observation list. Parameters: `type`, `tag`, `minConfirms`, `limit` |

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| Peer count stays 0 on LAN | mDNS blocked by network profile | Windows: set adapter to **Private** network. Linux: check UDP 5353 not firewalled. macOS: allow incoming in System Settings → Firewall. |
| Peer count stays 0 on WAN | Bootstrap nodes unreachable or wrong multiaddr | Verify `PRX_P2P_BOOTSTRAP_NODES` format: `/ip4/<ip>/tcp/<port>/p2p/<peerId>`. Check port `PRX_P2P_PORT` is open on the remote machine. |
| KB files not arriving | `PRX_KB_MODE=local` on one or both machines | P2P requires `PRX_KB_MODE=distributed`. Worker exits immediately in local mode. |
| `PRX_KB_MODE` mismatch | Nodes with different KB modes can't exchange files | Set `PRX_KB_MODE=distributed` on all nodes in the mesh. |
| Messages silently dropped | Wrong `PRX_P2P_SECRET` | All nodes must share the same secret. Tampered or unsigned messages are dropped without error logs on the receiver. Check `[p2p/warn] Dropping …: HMAC failed` in `prevoyant-server.log`. |
| Network observations never appear | `PRX_CORTEX_P2P_ENABLED=N` on sender or receiver | Enable Tier 2 on both sides. Also verify `PRX_CORTEX_ENABLED=Y`. |
| New node gets 0 observations on join | Peer connected but cortex-query stream failed | Check `prevoyant-server.log` for `[p2p/warn] Cortex dump request` errors. Usually a port or firewall issue on the responding peer. |
| `gyp ERR` during npm install | Missing native build tools (for lmdb) | See [P2P / libp2p prerequisites](../README.md#p2p-kb-sync--libp2p-prerequisites-prx_p2p_enabledy-only) in the README. lmdb ships prebuilts for common platforms — compilation is usually only needed on unusual architectures. |
| P2P badge missing after enabling | libp2p failed to start (port in use, or npm install incomplete) | Check `prevoyant-server.log` for `[p2p/error]` lines. Common cause: `npm install` in `server/` wasn't run. Run: `npm --prefix server install`. Also verify port `PRX_P2P_PORT` is not in use: `lsof -i :<port>` (macOS/Linux) or `netstat -ano | findstr :<port>` (Windows). |
| Trickle mode sends nothing | Batch 0 always empty | Usually means KB directory is empty or `PRX_KB_SYNC_TRIGGER=session` and no session has run. Run a session or switch to `filesystem` trigger. |
| Cortex facts diverge between nodes | One node is Cortex builder in distributed mode; others are readers | Only the builder synthesises facts. Check `PRX_CORTEX_DISTRIBUTED=Y` is set on all nodes and the builder heartbeat is fresh (dashboard Cortex page). |

---

## See also

- [CORTEX.md](CORTEX.md) — the Cortex intelligence layer in depth
- [AUTONOMY.md](AUTONOMY.md) — how Cortex autonomy levels control auto-promotion
- [prevoyant-server.md](prevoyant-server.md) — full server documentation
- [README.md — P2P configuration reference](../README.md#p2p-kb-sync-optional) — all `.env` variables
- [README.md — P2P libp2p prerequisites](../README.md#p2p-kb-sync--libp2p-prerequisites-prx_p2p_enabledy-only) — platform-specific build tool and firewall setup
- [server/workers/kbP2pWorker.js](../server/workers/kbP2pWorker.js) — the full P2P worker implementation
- [server/runner/cortexMemory.js](../server/runner/cortexMemory.js) — observation store and merge logic
- [server/runner/p2pBridge.js](../server/runner/p2pBridge.js) — in-process state bridge (peer list, sync counters)
