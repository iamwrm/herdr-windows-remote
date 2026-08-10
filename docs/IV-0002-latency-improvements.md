# IV-0002: Remote-attach latency improvements for high-RTT links

## Record

- **Status:** implemented in ownership patch `0002` of the current four-patch
  `v0.8.0` representation; the latest publication is `v0.8.0-win.04` (the
  initial latency stack shipped in `v0.7.5-win.01`); live deb1 verification
  and the W1 packet-capture verdict remain pending
- **Upstream:** `checkouts/herdr`
  ([herdrdev/herdr](https://github.com/herdrdev/herdr))
- **Deliverables:** ownership patch `patches/herdr/0002-*-IV-0002.patch`,
  plus the deb1 network-simulation harness below
- **Implementation base:** `v0.8.0` (`346411fa`), stacked on
  [IV-0001](IV-0001-windows-remote.md)'s ownership patch `0001`
- **Consumer compatibility:** [IV-0006](IV-0006-software-cursor-predictive-echo.md)
  owns automatic hidden software-cursor support for Prime Agent and pi;
  [IV-0003](IV-0003-pi-predictive-echo.md) retains the superseded pi-side
  adapter for older builds
- **Related initiative:** [IV-0004](IV-0004-vscode-remote-open.md) owns the
  following patch, `0003`; no IV-0004 changes are mixed into this patch

## Purpose

Make `herdr --remote` usable and pleasant on high-latency links (Asia ↔ US,
~200 ms RTT, occasional packet loss). Today every keystroke costs at least a
full RTT before it echoes, attach takes many seconds, and several avoidable
delays stack on top of the RTT. Reduce everything that is *not* the physical
RTT, and hide the RTT itself where possible (predictive echo).

## Constraint that shapes every design below

**The remote server is the *official* Linux binary.** The launcher installs
official assets from `https://herdr.dev/latest.json` (kept deliberately by
IV-0001 patch `0001`). Therefore:

- Server-side changes only help fork-vs-fork setups and are at most
  defense-in-depth (IV-0001's theme fix set this precedent).
- The wire protocol (`src/protocol/wire.rs`, `CURRENT_PROTOCOL`) must not
  change. No new `ServerMessage`/`ClientMessage` variants, no field changes.
- All improvements must live in the **client**, the **launcher/bridge**, or
  the **ssh transport layer** — all of which run locally.

## Current data path (reference)

```
keystroke → herdr client (thin, terminal-ansi) → named pipe
  → pump_client_to_ssh (blocking read; CancelIoEx at shutdown) [src/remote/windows.rs]
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
| combined setup probe | `probe::probe_remote` (platform, PATH/candidates, version/protocol, server status) | 1 |
| bridge | `SshStdioBridge` (persistent) | 1 |

The cold happy path is **1 probe connection + 1 persistent bridge**. A warm
cache uses the same single probe connection but verifies only the cached path.
Windows OpenSSH has no ControlMaster, so these remain fresh authenticated
connections; `HERDR_REMOTE_TIMING=1` (IV-0001 patch `0001`) labels each phase.

What already helps at high RTT (do not regress):

- thin client + server-side rendering → steady state is exactly 1 RTT/echo
- `BlitEncoder` diff frames + skip-identical (`prepare_frame`)
- **single-slot render queue** (`ClientWriterQueueState.render:
  Option<Vec<u8>>`): latest-frame-wins, no stale-frame backlog on slow links
- `TerminalFrame.seq` + `full` flag for resync

## Workstreams

Implementation order was W0 → W2 → W1 → W4 → W3 (measure first, cheapest
wins next). W5 is exploration only. All landed workstreams now form ownership
patch `0002`; the headings retain their design boundaries inside that patch.

### W0 — measurement: keystroke-echo latency probe (landed)

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
- **As landed:** `src/client/echo_timing.rs`; on Windows only key
  presses/repeats and pastes start probes (mouse/focus filtered via
  `is_key_or_paste_event`). `=1` prints one summary on exit;
  `=verbose` adds rolling reports every 25 samples (the rolling lines were
  too noisy to be the default during live testing).

### W1 — TCP_NODELAY via ProxyCommand relay (landed; verification pending)

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
- **As landed:** `src/remote/tcp_relay.rs` (`herdr remote-tcp-relay <host>
  <port>`, hidden subcommand) + injection in
  `src/remote/windows.rs::apply_managed_ssh_options`. **Opt-in**:
  `remote.tcp_relay = true` (default false, requires `manage_ssh_config`),
  env override `HERDR_REMOTE_TCP_RELAY=1|0`. Landed ahead of the packet
  capture because it is inert by default — the capture verdict decides
  whether to recommend enabling it, not whether the code ships. Fixes only
  the client→server leg; measure both directions with W0.

### W2 — batch the setup probes + verified-host cache (landed)

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
- **As landed:** `src/remote/probe.rs` — one `ssh /bin/sh -s` script emits a
  sentinel-tagged blob (`__HERDR_PROBE__ <tag> …`) with uname, login-shell
  PATH lookup plus a `/bin/sh` fallback for non-POSIX login shells,
  known-location scan, per-candidate `--version` + `status
  client --json`, and `status server --json` from the best candidate.
  `ensure_remote_server_ready` consumes the probed status and only does a
  live round trip when the blob had none (fresh install). Happy path is
  **1+1** connections (better than the 2+1 projected: the server-status
  probe folded in too). Cache entries use a readable sanitized target prefix
  plus the SHA-256 of the complete, unsanitized target, preventing punctuation
  and truncation collisions; each entry also stores the platform, so warm
  reattaches skip `uname` and the login-shell spawn. Deviation: the kill switch is env
  `HERDR_REMOTE_NO_CACHE=1`, not a `--remote-no-cache` flag.

### W3 — predictive local echo, mosh-style (landed)

The biggest UX win and the hardest. Hide the RTT for the common case: typing
printable characters (and backspace) into a shell/editor.

- **Prerequisite — client-side screen model:** the
  terminal-ansi client today blits server bytes without understanding them.
  Prediction requires knowing cursor position and cell contents. Feed every
  received `TerminalFrame.bytes` into a local terminal model to mirror what
  is on screen. **libghostty-vt is already vendored** (`vendor/`, used by the
  server's panes) — reuse it in the client as the model. This model layer has
  no visible behavior by itself; add an env-gated debug assert mode that its
  cursor matches reality after `full` frames.
- **Prediction engine:** on printable-char/backspace input in
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
- **As landed (screen model):** `src/client/screen_model.rs` — instead of a full
  libghostty-vt integration, a dedicated parser for `BlitEncoder`'s narrow
  vocabulary (no scrolling or relative motion; cell runs start with CUP).
  Upstream versions since v0.7.5 may batch adjacent cells into one printable
  run, so the model splits every run at Unicode extended grapheme boundaries. ASCII-leading
  decomposed clusters such as `e` plus a combining acute accent remain one
  cell. It tracks symbols, plain-vs-styled pen, hyperlinks, cursor, and touched
  cells. Round-trip tests cover real `BlitEncoder` full and diff frames,
  contiguous ASCII-prefix/decomposed runs, wide chars, and hyperlinks.
- **As landed (prediction engine):** `src/client/predict.rs` — `remote.predictive_echo
  = "off"|"auto"|"always"` (default `auto`), env `HERDR_PREDICTIVE_ECHO`.
  Conservatism as shipped: width-1 printable chars only (±shift), max 8
  outstanding, target *and* right-neighbor cells must be plain, same-row,
  visible cursor; backspace only over own predictions; any other key
  repaints server truth; 5 s unconfirmed → flush; `auto` draws only after
  2 confirmations with ≥60 ms echo delay (fast links never see underlines).
  Typed-ahead predictions surviving a frame are re-drawn and the host
  cursor re-anchored past them. Active only for remote full-app
  terminal-ansi clients.

#### Software-cursor consumers

The original W3 gates excluded stock pi and Prime Agent because they hide the
hardware cursor and paint a reverse-video software caret. Automatic,
style-preserving support now lives in
[IV-0006](IV-0006-software-cursor-predictive-echo.md) and ownership patch
`0004`. This initiative continues to own the base predictor and reconciliation
behavior. [IV-0003](IV-0003-pi-predictive-echo.md)'s pi-side rendering adapter
is retained only for older herdr builds.

### W3 follow-up — cursor-only reconciliation and input batching

Live pi typing exposed a deterministic hole in the original reconciliation
rule. Typing a space over an already blank cell changes no cell, so the server
emits only cursor movement. The initial predictor required the predicted cell
to appear in the current frame's `touched` list; the untouched space therefore blocked
later `d/e/f` acknowledgements in `abc def`. Pi also writes changed content and
its hardware-cursor position separately, making a content frame followed by a
cursor-only frame normal rather than exceptional.

The reconciliation follow-up makes observations cumulative and accepts
same-row authoritative cursor progress as acknowledgement when the modeled
symbol matches.
Cursor-only confirmations explicitly remove their local underline. Matching
server writes remove overlays even while an older prediction is pending;
mismatches preserve the server's styling. Unsafe/untracked input, actionable
Windows mouse input (including a mouse event before a later key in one batch),
hidden or cross-row cursors, capacity exhaustion, resize, and timeout now flush
and suspend prediction until a fresh frame; harmless key releases remain
ignored. The 100 ms client timer enforces the
existing 5 s timeout even when no more frames arrive. Frame corrections are
buffered, inserted before synchronized-output ends, and replace Linux's stale
post-sync IME cursor repeat, producing one atomic stdout flush instead of a
visible frame-then-correction pair.

The input-batching follow-up reduces upload packetization without a timer or
wire change: each length-prefixed protocol message is built and written
contiguously, and all
events already returned by one `ReadConsoleInputW` batch become one ordered
`InputEvents` message. This removes avoidable tiny prefix/payload and
per-console-record writes; whether TCP Nagle still adds material delay remains
a packet-capture question for W1.

Confirmation is expected after roughly **one full RTT**, not half an RTT:
input must travel to the server and the rendered echo must return. Local
underlined prediction should remain immediate.

### W4 — event-driven upload pump (landed)

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
- **As landed:** neither overlapped I/O nor a shorter poll — the pump does a
  plain **blocking read**, and shutdown cancels the in-flight read with
  `CancelIoEx` on the pipe handle (retried until the stop flag is
  observed). Zero idle latency, zero CPU. Finding worth keeping:
  `CancelSynchronousIo` does **not** work here — interprocess implements
  "sync" named-pipe reads as internally-awaited overlapped I/O, invisible
  to the synchronous cancel API (a test hung with it, passes with
  `CancelIoEx`). Requires `windows-sys` feature `Win32_System_IO`.

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

## Files affected (as landed)

| Workstream | Ownership patch | Files |
|---|---|---|
| W0 echo probe | `0002` | `src/client/echo_timing.rs` (new), `src/client/mod.rs` |
| W2 batched probes + cache | `0002` | `src/remote/probe.rs` (new), `src/remote/launcher.rs` (probe funcs replaced), `src/remote.rs` |
| W1 tcp relay | `0002` | `src/remote/tcp_relay.rs` (new), `src/remote/windows.rs`, `src/remote/unix.rs` (signature parity), `src/main.rs`, `src/config/model.rs` |
| W4 blocking pump + CancelIoEx | `0002` | `src/remote/windows.rs`, `src/ipc.rs`, `Cargo.toml` (`Win32_System_IO`) |
| W3 screen model | `0002` | `src/client/screen_model.rs` (new), `src/client/mod.rs`, `Cargo.toml`, `Cargo.lock` |
| W3 prediction and reconciliation | `0002` | `src/client/predict.rs` (new), `src/client/screen_model.rs`, `src/client/mod.rs`, `src/config/model.rs` |
| Input packetization | `0002` | `src/protocol/wire.rs`, `src/client/input/windows_vti.rs` |

## Non-goals

- No wire-protocol changes; no server-side requirements beyond the official
  Linux binary (see the constraint section).
- No custom UDP/QUIC protocol in this initiative (W5 is exploration only).
- No Unix-side transport changes (Unix has ControlMaster; keep the diff
  Windows-scoped where the problem is Windows-scoped).
- Not chasing sub-RTT for anything other than typing echo (W3); command
  output fundamentally arrives after 1 RTT.

## Evidence and reproduction

Done at landing time (Windows dev machine, Zig 0.15.2 via `ZIG=`):

- `cargo clippy --bin herdr -- -D warnings` clean on every patch.
- Test filters all green: `remote::` (75), `client::` (133), `windows_`
  (121), `server::client_transport::tests` (19), `config::` (120) —
  including new suites: `echo_timing` (4), `probe` (9), `tcp_relay` (3),
  pump (2), `screen_model` (9, round-trip against real `BlitEncoder`),
  `predict` (13, full confirm/mispredict/typeahead/auto-unlock matrix).
- Follow-up reconciliation/input-batching verification: `client::` (164),
  `protocol::wire::tests` (51), predictor regressions (23), and Clippy with
  `-D warnings` are green. Coverage includes coalesced and split `abc def`,
  cursor-only space confirmation, timeout, hidden/cross-row/full frames,
  stale IME-anchor replacement, one-write framing, and one-message console
  batches.
- Clean-room: the complete four-patch series `git am` applies to a fresh
  `v0.8.0` worktree and reproduces the refreshed implementation tree exactly;
  the fork-era CI workflow remains deliberately outside the series.

Still pending (record results in the check log):

- Live attach + typing against deb1 with the netem matrix; W0 baseline
  numbers before/after enabling `remote.tcp_relay` and with
  `predictive_echo` off/auto/always.
- W1 packet capture (both directions) for the Nagle verdict.
- `HERDR_REMOTE_TIMING=1` cold vs warm-cache attach timing.

## Decisions and deferred work

- **Client-side only** — locked in by the official-server constraint; held
  throughout, no wire-protocol change in any patch.
- The workstreams were originally exported as separate, interleaved patches.
  They are now recombined into patch `0002`, so the ownership boundary matches
  this IV and IV-0004 follows cleanly as patch `0003`.
- W1 landed inert-by-default ahead of its packet-capture verification (see
  workstream note); the capture decides the *recommendation*, not the code.
- Deferred: W5 transport swap; symmetric-loss ifb recipe; widening W3
  prediction contexts beyond plain-text typing (wide chars, backspace over
  committed text); a `--remote-no-cache` CLI flag (env var shipped
  instead); upstreaming (W0/W3 are platform-generic and may be worth
  offering upstream once proven, under the same policy as IV-0001's
  platform-generic input and theme fixes).
- The shared 256-event queue, direct TCP Nagle behavior, and dense-frame model
  cost remain measurement hypotheses, not reasons for speculative transport
  changes. `HERDR_ECHO_TIMING` starts after its blocking send and ends at the
  next frame, so use packet capture or capture-to-stable-flush tracing before
  attributing any remaining delay.

## Evidence log

- 2026-07-19: the initial latency workstreams (then separate patch exports)
  landed on `v0.7.4`;
  clippy + full test filters green; clean-room apply verified. Pending: W1
  Nagle packet-capture verdict, W0 baseline numbers at 200 ms netem, cold
  vs warm-cache attach timing on deb1.
- 2026-07-20: reproduced the pi `abc def` stuck-underline/cursor failure as
  an untouched-space FIFO block followed by pi's cursor-only frame. The
  follow-ups implement cumulative cursor acknowledgement, idle timeout
  repair, atomic frame correction, contiguous protocol writes, and Windows
  console-event batching. Clippy, 164 client tests, 51 wire tests, and a
  clean-room apply was green; live high-RTT retest pending.
- 2026-07-22: refreshed the complete stack onto `v0.7.5` / protocol 17.
  Upstream now batches adjacent terminal-diff cells, so the screen model was
  updated to replay contiguous ASCII and mixed ASCII/Unicode runs
  correctly; regression tests cover both shapes. Clippy is clean, and the
  filtered suites pass: remote 76, client 170, Windows 126, client transport 21,
  config 128, and wire 51. After review remediation, focused remote-probe
  (12), screen-model (16), predictor (27), updater (1), and generated-config
  (2) regressions pass; private-item rustdoc has no broken intra-doc links.
  The regenerated clean-room stack reproduced the implementation tree; the
  nine known test-only unused-code/import warnings remain.
- 2026-08-01: recombined all IV-0002 workstreams into ownership patch `0002`;
  the four-patch `v0.7.5` clean-room apply reproduced the same final
  implementation tree as the former unconsolidated stack.
- 2026-08-04: refreshed onto `v0.8.0` / protocol 19 and preserved upstream's
  `/bin/sh` fallback for login shells that reject `command -v`. Adapted
  prediction and echo timing to the expanded Windows input events
  (`TextCommit`, physical-source metadata, and repeat counts). Clippy is clean;
  filtered suites pass: remote 78, client 187, Windows 151, client transport
  22, config 130, and wire 53. The then-three-patch clean-room apply reproduced
  the implementation tree.
- 2026-08-10: IV-0006 added automatic hidden reverse-video software-cursor
  support as ownership patch `0004`. Prime-shaped real-encoder regressions,
  all 193 client tests, and production Clippy pass; Prime Agent and pi require
  no extension in `v0.8.0-win.02`.
