# i0002: Remote-attach latency improvements for high-RTT links

**Status:** proposed — doc only, no patches landed yet
**Upstream:** `checkouts/herdr` ([ogulcancelik/herdr](https://github.com/ogulcancelik/herdr))
**Deliverable:** patch series continuing `patches/herdr/` at `0006-*` (numbers
reserved per workstream below) + a deb1 network-simulation test harness
**Implementation base:** whatever `patches/herdr/BASE` pins at landing time
(currently `v0.7.4`); patches stack on top of the i0001 series (0001–0005)

## Goal

Make `herdr --remote` usable and pleasant on high-latency links (Asia ↔ US,
~200 ms RTT, occasional packet loss). Today every keystroke costs at least a
full RTT before it echoes, attach takes many seconds, and several avoidable
delays stack on top of the RTT. Reduce everything that is *not* the physical
RTT, and hide the RTT itself where possible (predictive echo).

## Constraint that shapes every design below

**The remote server is the *official* Linux binary.** The launcher installs
official assets from `https://herdr.dev/latest.json` (kept deliberately, see
i0001 patch 0003). Therefore:

- Server-side changes only help fork-vs-fork setups and are at most
  defense-in-depth (i0001 patch 0004 set this precedent).
- The wire protocol (`src/protocol/wire.rs`, `CURRENT_PROTOCOL`) must not
  change. No new `ServerMessage`/`ClientMessage` variants, no field changes.
- All improvements must live in the **client**, the **launcher/bridge**, or
  the **ssh transport layer** — all of which run locally.

## Current data path (reference)

```
keystroke → herdr client (thin, terminal-ansi) → named pipe
  → pump_client_to_ssh (PeekNamedPipe, 10 ms poll)   [src/remote/windows.rs]
  → ssh -T stdin ──~RTT/2──→ remote-client-bridge → server socket
  → server event loop → PTY → app echoes → server renders
  → BlitEncoder diff [src/server/render_stream.rs]
  → 1-slot render queue [ClientWriterQueue, src/server/client_transport.rs]
  → ssh stdout ──~RTT/2──→ copy_flush → named pipe → client stdout
```

Setup path (before the client starts), all in
`src/remote/launcher.rs::run_remote`:

| Step | Function | ssh connections (Windows, no mux) |
|---|---|---|
| platform probe | `detect_remote_platform` (`uname`) | 1 |
| PATH probe | `remote_binary_on_path_any` (`command -v herdr`) | 1 |
| known-path scan | `remote_binary_candidates` script | 1 |
| version/protocol check | `remote_binary_matches` (per candidate, ≥1) | 1+ |
| server status | `ensure_remote_server_ready` → `remote_server_status` | 1 |
| bridge | `SshStdioBridge` (persistent) | 1 |

Happy path ≈ **5 sequential fresh connections + 1 persistent**. Windows
OpenSSH has no ControlMaster, so each fresh connection pays TCP + kex + auth
(~5–7 RTTs ≈ 1–1.5 s at 200 ms) → attach ≈ **6–9 s**. `HERDR_REMOTE_TIMING=1`
(i0001 patch 0005) already labels each phase.

What already helps at high RTT (do not regress):

- thin client + server-side rendering → steady state is exactly 1 RTT/echo
- `BlitEncoder` diff frames + skip-identical (`prepare_frame`)
- **single-slot render queue** (`ClientWriterQueueState.render:
  Option<Vec<u8>>`): latest-frame-wins, no stale-frame backlog on slow links
- `TerminalFrame.seq` + `full` flag for resync

## Workstreams

Landing order = W0 → W2 → W1 → W4 → W3 (measure first, cheapest wins next).
W5 is exploration only. Each workstream is one patch unless noted.

### W0 — measurement: keystroke-echo latency probe (reserved patch `0006`)

Everything else needs before/after numbers. `HERDR_REMOTE_TIMING` only covers
attach; add a steady-state probe.

- **Design:** env-gated (`HERDR_ECHO_TIMING=1`), client-side only. In the
  terminal-ansi client loop (`src/client/mod.rs`, the loop that writes
  `ServerMessage::Terminal` bytes to stdout), record `Instant` when an input
  chunk is sent (`ClientMessage::Input`) and match it to the next received
  frame; print rolling p50/p95 input→frame latency to stderr on detach (or
  every N seconds).
- **Anchors:** `src/client/mod.rs` (`run_client_with_mode`, the
  `ClientLoopEvent` select loop), `write_to_server`.
- **Acceptance:** with deb1 netem at 200 ms, reported echo latency ≈ RTT +
  small constant; numbers stable across runs.
- **Non-invasive:** no protocol change, no behavior change when env var unset.

### W1 — TCP_NODELAY via ProxyCommand relay (reserved patch `0008`)

**Hypothesis to verify first, not assume:** OpenSSH sets `TCP_NODELAY` only
for interactive (tty) sessions; the bridge uses `ssh -T` (no tty), so Nagle +
delayed-ACK can add up to one extra RTT when a small keystroke packet is sent
while a previous one is unacked (typing fast ⇒ perceived ~2×RTT).

- **Verify:** packet capture (Wireshark on the Windows side / `tcpdump` on
  deb1) while typing at >5 keys/s through the bridge; look for small segments
  delayed until the previous ACK. Compare W0 numbers typing slow vs fast.
  Check **both** directions — the server→client leg is sshd's socket and a
  ProxyCommand cannot fix it; measure whether render frames (often <100 bytes)
  stall too. Record findings in this doc's check log below.
- **Design (if confirmed):** new hidden subcommand `herdr remote-tcp-relay
  <host> <port>`: resolve, connect, set `TCP_NODELAY` (and disable
  `SIO_KEEPALIVE` defaults as needed), splice stdin/stdout ⇄ socket. Inject
  `-o ProxyCommand=<current-exe> remote-tcp-relay %h %p` next to the
  keepalive flags in `src/remote/windows.rs::apply_managed_ssh_options`
  (gated by the same `remote.manage_ssh_config = true` default, so users can
  opt out). ~50–80 lines + arg plumbing in `src/main.rs`/`src/cli.rs`.
- **Anchors:** `src/remote/windows.rs` (`apply_managed_ssh_options`,
  `ManagedSshOptions`), `src/main.rs` (subcommand dispatch).
- **Risks:** ProxyCommand bypasses the user's own `ProxyJump`/`ProxyCommand`
  config — must **not** inject when the user's ssh config defines a proxy for
  the target. Simplest rule: make it opt-in-by-default but add config
  `remote.tcp_relay = true|false`, and document the interaction.
  Non-Windows: keep Unix untouched (it has ControlMaster mux; scope the patch
  to `windows.rs` for upstreamability).
- **Acceptance:** fast-typing p95 echo latency ≈ slow-typing p95 (no Nagle
  step); no regression when ssh config uses jump hosts (auto-disabled).

### W2 — batch the setup probes + verified-host cache (reserved patch `0007`)

Collapse the 4–5 sequential probe connections into 1, and skip probing
entirely on reattach.

- **Design, part A (batch):** one `sh_output` script that emits everything
  the current probes need in a single delimited blob: `uname -s`, `uname -m`,
  login-shell `command -v herdr` (via `$SHELL -l -c`, mirroring
  `user_shell_output`), the `known_remote_binary_candidate_script` results,
  and for each discovered candidate `--version` + `status client --json`
  (what `remote_binary_matches` runs), plus the server-status probe from
  `remote_server_status`. Parse the blob locally and feed the existing
  decision logic in `prepare_remote_herdr` / `ensure_remote_server_ready`
  unchanged — the refactor is "gather inputs in one round trip", not new
  logic. Reduces happy path from 5+1 to **2+1** connections (probe blob,
  then bridge; install/stop paths still take their extra connections).
- **Design, part B (cache):** after a successful attach, record
  `{target, remote_path, herdr_version, protocol}` in the local state dir
  (same location the client uses for its own state). On the next attach with
  a cache hit, skip parts of the probe: run only the cheap combined
  `--version && status client --json` check against the cached path (1
  connection, which part A already provides). Invalidate on version change,
  probe failure, or `--remote-no-cache`. Cache is a pure fast-path: any miss
  falls back to the full part-A probe.
- **Anchors:** `src/remote/launcher.rs` — `prepare_remote_herdr`,
  `detect_remote_platform`, `remote_binary_candidates`,
  `remote_binary_on_path_any`, `remote_binary_matches`,
  `remote_server_status`, `ensure_remote_server_ready`, `RemoteSsh::sh_output`.
- **Risks:** the combined script must stay POSIX-`sh` safe and handle hosts
  where `$SHELL -l` prints noise (the existing PATH-warning logic tolerates
  this — keep parsing line-delimited with sentinels, not positional).
  Interactive prompts (install confirmation, server stop) stay exactly where
  they are.
- **Acceptance:** `HERDR_REMOTE_TIMING=1` shows "phase: setup before client"
  dropping from ~6–9 s to ~2–3 s at 200 ms RTT (cold) and ~1.5 s (warm
  cache); all existing `remote::` tests pass; install and restart flows
  unchanged.

### W3 — predictive local echo, mosh-style (reserved patches `0010`+, multi-patch)

The biggest UX win and the hardest. Hide the RTT for the common case: typing
printable characters (and backspace) into a shell/editor.

- **Prerequisite — client-side screen model (patch `0010`):** the
  terminal-ansi client today blits server bytes without understanding them.
  Prediction requires knowing cursor position and cell contents. Feed every
  received `TerminalFrame.bytes` into a local terminal model to mirror what
  is on screen. **libghostty-vt is already vendored** (`vendor/`, used by the
  server's panes) — reuse it in the client as the model. No visible behavior
  change in this patch; add an env-gated debug assert mode that the model's
  cursor matches reality after `full` frames.
- **Prediction engine (patch `0011`):** on printable-char/backspace input in
  a predictable context, immediately write the char at the model's cursor
  with a distinguishing style (underline, like mosh), advance a local
  predicted-cursor, and record the prediction with the `seq` in flight.
  Reconcile: when a frame arrives, replay it into the model; predictions
  confirmed (server frame writes the same cell) disappear naturally;
  mispredictions are repaired by repainting the affected cells **from the
  model** (this is why the model must be authoritative — the server's
  `BlitEncoder` diffs against *its* idea of the screen and will not
  necessarily touch a wrongly-predicted cell).
- **Conservatism rules (start narrow, widen later):**
  - only predict when recent history confirms echo (mosh's approach: predict
    tentatively, display only once one prediction was confirmed at this
    cursor line);
  - never predict over styled/nondefault cells, near the right margin, in
    alternate-screen apps that moved the cursor unexpectedly, or while a
    bracketed paste is active;
  - flush all predictions on any frame with `full = true`, on resize, and on
    cursor jumps.
- **Anchors:** `src/client/mod.rs` (terminal-ansi receive path, stdin input
  path, `AttachEscapeState` shows where input already gets inspected);
  `src/protocol/wire.rs::TerminalFrame` (read-only — `seq`/`full` used for
  reconciliation, no wire change); vendored libghostty-vt bindings under the
  existing `ghostty` module.
- **Risks:** visual artifacts if reconciliation is buggy — must be
  killable at runtime (`remote.predictive_echo = off|auto|always`, default
  `auto` = mosh heuristic; env override for testing). CPU: parsing frame
  bytes through a vt model on every frame — measure, but frames are diffs
  and small.
- **Acceptance:** at 200 ms netem, typed characters appear <16 ms locally
  with underline and are confirmed (underline drops) after ~1 RTT;
  mispredictions self-heal ≤1 RTT; `off` restores today's behavior
  byte-for-byte.

### W4 — event-driven upload pump (reserved patch `0009`)

Remove the 0–10 ms polling jitter on the keystroke path.

- **Design:** replace the `PeekNamedPipe`-poll loop in
  `src/remote/windows.rs::pump_client_to_ssh` (`CLIENT_READ_POLL = 10ms`)
  with overlapped I/O: issue `ReadFile` with an `OVERLAPPED` + event handle,
  `WaitForMultipleObjects` on {read-event, stop-event}. The stop path
  (`SshStdioBridge::Drop`) signals the stop event instead of relying on the
  poll observing the flag. Keep the invariant documented in the module
  header: the whole pipe must remain droppable/observable when ssh dies.
- **Anchors:** `src/remote/windows.rs` (`pump_client_to_ssh`,
  `bridge_connection`, `CLIENT_READ_POLL`,
  `crate::ipc::windows_named_pipe_available`).
- **Risks:** interprocess's `LocalStream` may not expose the raw handle for
  overlapped use — may need `AsRawHandle` + a manually-opened handle, or
  fall back to shrinking the poll to 1 ms as a cheap variant. Decide during
  implementation; the cheap variant is an acceptable landing.
- **Acceptance:** W0 probe shows jitter floor drops by ~5 ms median; bridge
  drop/reconnect tests (`bridge_drop_wakes_blocking_accept_without_spawning_ssh`
  and the `remote::` suite) still pass.

### W5 — lossy-link transport (exploration only, no patch reserved)

TCP head-of-line blocking means one lost packet freezes everything for ≥1
RTT. The real fix is an unreliable-tolerant transport (mosh SSP, QUIC
datagrams, Eternal Terminal's resilient TCP).

- The bridge abstraction is transport-shaped already:
  `bridge_connection` splices a local stream onto a child process's stdio.
  Anything that presents stdio (e.g. `et -c "herdr remote-client-bridge"`,
  a QUIC tunnel binary) can slot in behind a config option
  (`remote.transport = ssh|command:<template>`).
- **Not building a custom protocol now.** First measure how bad TCP actually
  is at 1–3 % loss with deb1 netem (W0 + the harness below). If stalls
  dominate, the cheapest experiment is documenting an Eternal Terminal
  recipe; QUIC in-binary is a separate future initiative.
- Predictive echo (W3) independently masks most loss-stall pain for typing.

## deb1 network-simulation harness

deb1 (Debian, LAN) simulates the Asia↔US link with `tc netem`. **Shape only
traffic to the Windows client IP** so the control ssh session from elsewhere
(or a console) stays usable — and note the herdr bridge itself *is* traffic
to the Windows client, which is exactly what we want shaped.

```bash
# on deb1 — delay + jitter + correlated loss toward the Windows client only
WIN_IP=<windows-client-ip>
sudo tc qdisc add dev eth0 root handle 1: prio
sudo tc qdisc add dev eth0 parent 1:3 handle 30: netem delay 200ms 30ms loss 2% 25%
sudo tc filter add dev eth0 parent 1: protocol ip u32 \
    match ip dst ${WIN_IP}/32 flowid 1:3

# cleanup
sudo tc qdisc del dev eth0 root
```

Notes:

- Egress-only shaping (server→client) yields the full 200 ms RTT and
  one-directional loss — sufficient for echo-latency and frame-stall tests.
  For symmetric loss, add ingress shaping via an `ifb` device (document the
  exact commands in the test log when first needed).
- Self-lockout guard when configuring from the shaped client:
  `sudo bash -c 'tc qdisc add ...; sleep 600; tc qdisc del dev eth0 root' &`
- Windows-side alternative needing no deb1 changes: **clumsy**
  (WinDivert-based lag/drop injector).

Test matrix (used by every workstream's acceptance):

| Scenario | netem |
|---|---|
| Asia↔US baseline | `delay 200ms 20ms` |
| + mild loss | `delay 200ms 20ms loss 1%` |
| bad wifi + WAN | `delay 200ms 50ms loss 3% 25% reorder 1%` |
| thin pipe | above + `rate 5mbit` |

Standard measurements per scenario: `HERDR_REMOTE_TIMING=1` attach phases,
W0 echo p50/p95 (slow typing ~2 key/s and fast ~8 key/s), subjective TUI
feel (pi editor, `htop`), `cat` of a large file (frame-skip behavior).

## Files affected (planned summary)

| Workstream | Patch | Files |
|---|---|---|
| W0 echo probe | `0006` | `src/client/mod.rs` |
| W2 batched probes + cache | `0007` | `src/remote/launcher.rs` (+ small state-file module) |
| W1 tcp relay | `0008` | `src/remote/windows.rs`, `src/main.rs`, `src/cli.rs`, `src/config/model.rs` |
| W4 event pump | `0009` | `src/remote/windows.rs`, possibly `src/ipc.rs` |
| W3 screen model | `0010` | `src/client/mod.rs`, `src/client/` new module, ghostty-vt bindings |
| W3 prediction | `0011` | `src/client/` prediction module, `src/config/model.rs` |

## Non-goals

- No wire-protocol changes; no server-side requirements beyond the official
  Linux binary (see the constraint section).
- No custom UDP/QUIC protocol in this initiative (W5 is exploration only).
- No Unix-side transport changes (Unix has ControlMaster; keep the diff
  Windows-scoped where the problem is Windows-scoped).
- Not chasing sub-RTT for anything other than typing echo (W3); command
  output fundamentally arrives after 1 RTT.

## Verification plan

- Per-workstream acceptance criteria above, all run against the deb1 netem
  matrix, with W0 numbers recorded in this doc per landing.
- Test filters (same as i0001): `cargo test --bin herdr remote::`,
  `cargo test --bin herdr windows_`,
  `cargo test --bin herdr server::client_transport::tests`, plus
  `cargo clippy --bin herdr -- -D warnings`.
- W1 requires the packet-capture findings logged below **before** the patch
  lands.

## Decisions & deferred

- **Client-side only** — locked in by the official-server constraint.
- Patch numbers `0006`–`0011` reserved as above; landing order
  W0 → W2 → W1 → W4 → W3; renumber only if a workstream is dropped.
- Deferred: W5 transport swap; symmetric-loss ifb recipe; widening W3
  prediction contexts beyond plain-text typing; upstreaming (W0/W3 are
  platform-generic and may be worth offering upstream once proven, same
  policy as i0001 patches 0002/0004).

## Check log

- (empty — first entry should be the W1 Nagle packet-capture verdict and the
  W0 baseline numbers at 200 ms netem)
