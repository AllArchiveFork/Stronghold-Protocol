# Bounded WebSocket compression

This page describes the transport policy, not a deployed release or completed
acceptance. Keep actual commit/image pairs and checks in local private records;
see [record boundaries](releases/README.md).

`SP_WS_COMPRESSION=on` opts this game process into the bounded transport preset. The default is `off`; any other value is refused before workers or listeners start. This is not an HTTP gzip setting or a hot reload.

Preset: level 6, memLevel 5, server window 12 (4 KiB), 512-byte threshold, both directions without context takeover, and a ws zlib concurrency limit of 8. Leave the process-wide libuv pool at its existing/default size 4; this limit does not create eight threads or change the independently configured combat/trial Worker pool.

Only the large, low-rate state frames are eligible for server compression: `m.public`, `m.private`, `m.unitStats`, `m.field`, `m.damage` and `b.damage`. The high-rate battle stream (`b.snap`, `b.ev`: about fifteen frames per watcher per second, mostly under 1 KiB) stays plain; in offline replays of recorded matches, deflating each of those frames cost more CPU than the bytes it saved, while the public/private state frames shrink several-fold. None of the eligible frames carries a credential, and each is compressed on its own (no context takeover). Credential-bearing `welcome`, unknown/control messages, presence, lobby/room state and saved result replay (`m.result`) default to `compress: false`, even if large. Already-encoded Worker frames retain the trusted message-type decision without parsing JSON again. Backpressure, inbound decompressed 64 KiB maximum, admission, rate limits and session behavior remain unchanged. Clients without the extension still receive ordinary messages.

In the cluster only the ingress compresses (its `wsCompression`, default `on`); game nodes and the coordinator send plain frames on the private hops. The ingress relays the received UTF-8 bytes of game and control frames unchanged, decodes only the leading type, parses only what it must (`m.public` phase, `welcome`, `cluster.*`, `queue.state` before start), and applies the same eligibility over direct control sockets and the multiplexed link (`--ingress-link`). Frames for one browser in the same event-loop turn leave in one socket write (cork until the next turn); their order and backpressure accounting do not change.

## Verification boundaries

Measure deterministic transport fixtures separately from real game simulation.
Report compressed frame bytes, main and total CPU, delivery latency and RSS together;
do not infer capacity from one transport replay. TLS, WAN, WG, player identity count
and full-game work are separate dimensions. Short runs do not prove long-term zlib
fragmentation or stability. Eligible frames smaller than512 bytes must remain plain.

The original scheduling/security policy stays unchanged: only Main is nice=-20
with SCHED_OTHER/reset-on-fork; all other threads remain0, with no container
CAP_SYS_NICE or game CPU/memory hard caps. A test command or this document does not
claim that any production verification passed.

## Activation and rollback

Use a fixed tested commit/image pair, record the actual deployed image ID and append only its approved pair to the approved owned profile. Add the flag to the fixed runtime.env and Compose environment with byte/hash CAS and fresh backups. Stop/start only the approved core manager; stopping it closes its own WG lease and stops its own game. Do not stop/restart WG, other managers, auth, resolver, OpenResty or unrelated services.

A game restart loses in-memory matches. Immediate maintenance requires explicit user authorization; an approval to develop or push is not that authorization. Old image/configuration and its allowlist pair remain rollback materials, not recovery of lost matches. The flag may be returned tooff in a later authorized restart, or the matched old image/config restored.

No frontend, package/lock, shared/data or public resource changes are required by this feature. Existing private JS/CSS and assets may be reused only after fixed-commit byte/tree equality is proved; do not upload or overwrite immutable resources merely to change this server-only option. Authentication keys, verifier and TLS are a separate unchanged release line.
