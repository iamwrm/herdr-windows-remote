# v0.9.0 upgrade verification

Base: upstream v0.9.0, commit b99002ac99b09e00b4ca692436cb15a6b0d676f1. Initial local verification on 2026-09-08; follow-up PR review is recorded below.

## Changes

The initial upgrade reduced the stack to four patches (previously five), with 4,536 inserted lines across 30 source files (25% fewer inserted lines than the 6,067-line v0.8.2 stack). Follow-up review retains those four ownership patches. Prediction, software cursor support and echo timing share one client lifecycle. Prediction is scoped to endpoint plus pane identity and resets on endpoint transitions. Native frame/graphics presentation remains authoritative.

Removed the combined remote probe/cache, broad paste override, custom SSH clipboard helper, image-frame rewriting, and duplicate image transport. v0.9 now owns probing, multiline paste and target-aware image transfer. The frozen generation-1 endpoint codecs remain unchanged (private protocol 22).

The clipboard FIFO is a server-side policy now: set remote.clipboard_image_buffer_mb on the Linux server (default 64 MiB). A patched Linux server is required for this retention policy; stock compatible servers still support native clipboard image paste. Files are per-user, locked across named sessions and retained across disconnects until FIFO eviction. Oversized uploads are rejected before eviction. Paths use /tmp/herdr-clipboard-images-<uid>/client-*.

hcode remains supported for one-shot --remote targets. Saved-machine hcode is deliberately not routed to the initial SSH host; support for that path remains pending.

## Windows release regression

Official Windows v0.9.0 against an official Linux v0.9.0 server completed its handshake but displayed no workspace. The same Linux server worked with its native Linux client. Byte-count tracing showed the Windows bridge stalled when forwarding a 16 KiB download after the welcome.

The bridge attempted 4 KiB nonblocking writes against interprocess's default 512-byte named-pipe buffer. With a peer polling PeekNamedPipe, the oversized write could make no progress indefinitely. Limiting Windows write chunks to 512 bytes restored the workspace immediately. The same bound covers queued endpoint input, including large pastes; Unix uses 4 KiB chunks. Cancellation and partial-write accounting remain unchanged. No diagnostic tracing is included in the patches.

Two regression tests use actual local streams with polling peers and transfer 32 KiB client input and 64 KiB server output. Both pass on Windows. Existing tests used blocking readers and missed this condition.

## Initial validation (before follow-up review)

- Four patches replayed cleanly from the pinned release; resulting source tree cb0cab42b4593b0e1c6b38592d92b6ab10c23509 matches the candidate.
- Windows production Clippy with warnings denied passed. Final Windows release build and app-local ConPTY package verification passed.
- Windows pre-fix suites: client 493, remote 73, config 162, pane terminal 152, wire 67, clipboard storage 2, fork updater 1 passed; the two additional pipe regression tests passed.
- Linux native Clippy, release build and suites passed before the pipe fix: client 524, remote 78, config 162, pane terminal 135, wire 68, clipboard storage 2, fork updater 1. Final Linux rebuild and both pipe regression tests passed.
- Render scale profile passed at fixed geometry with 1 and 15 panes; final composition median 1.304/1.673 ms (1.28x), p95 2.065/2.379 ms (1.15x). This is a local debug benchmark, not a high-RTT latency measurement.
- deb1 is reachable over SSH at 192.168.50.38. The isolated session codex-upgrade-20260908 uses protocol 22 and endpoint generation 1. Existing sessions were preserved.

## Remaining interactive verification

Computer Use initially reproduced the blank workspace in VS Code. It subsequently failed both screen capture and window activation, so UI input stopped. WezTerm CLI text inspection confirmed the pipe fix restores the workspace and shell. That is terminal diagnostics, not completed visual verification. The final release client successfully executed an 8 KiB paste including Chinese text (reported byte count 8192). Detach and reattach preserved the shell output. hcode reached the local VS Code URL broker without an error. Clipboard image interaction and visual confirmation of the editor remain pending desktop access.

## Local artifacts

Initial build outputs are ignored under checkouts/upgrade-v0.9.0/: herdr-windows-x86_64.zip (extract the complete app-local ConPTY bundle) and herdr-linux-x86_64. These hashes describe the initial candidate, before the follow-up fixes below. No release was published.

SHA-256:

- Windows ZIP: fe099adeaeac518013e6b08286cf44b9c97ee8b4299fe67351223f9bb4fc474c
- Linux executable: bfafbec3ce932e9f9d4065a0a8e623a452f4de03e6e236298cf4603cdab45625

## Follow-up PR review (2026-09-08)

- Fixed a remaining large-upload timeout in patch 0002: the five-second endpoint
  write limit now measures inactivity since the last successful partial write.
  With 512-byte Windows pipe chunks and a polling reader, a valid large paste or
  image can take longer than five seconds while continuing to make progress.
  Stalled peers still time out, and the existing cancellation path is preserved.
- Added deterministic clock-driven tests for sustained progress past the timeout
  and for a peer that stops consuming data (both zero-byte writes and WouldBlock).
  Both tests fail with the original deadline and pass with the renewed deadline.
- CI now exercises the verified ConPTY packager and packaged Windows runtime
  smoke test, plus the upstream Python packaging tests. The release workflow
  removes the obsolete bare executable only after the replacement ZIP uploads
  successfully, and its notes explain how to extract the complete bundle.
- Corrected release-history claims, the four-patch runbook, and the server-side
  clipboard configuration instructions.
- Removed the obsolete Windows timing-event helper left behind by the new
  prediction adapter. This eliminates the custom patch's unused-function
  warning; the four timing unit tests still pass.

All four refreshed patches replay cleanly from the pinned release. The resulting
source tree `6d44c17c468d72af8934c246cb0ddf3478cc2b92` matches the edited checkout.

Local validation used Rust 1.96.1 to compile the actual writer functions in an
isolated standard-library harness; both new tests and the existing partial-write
and cancellation tests passed. The four
upstream ConPTY packaging tests, rustfmt for the changed Rust file, actionlint
1.7.12 for both workflows, and whitespace checks passed. Full Cargo/Clippy and
Windows runtime verification run in PR CI; this review environment has no
complete Cargo/Zig or Windows toolchain, so it cannot run upstream `just check`.
The initial desktop observations and artifact hashes above are historical and
do not establish interactive verification of the revised candidate.

The initial CI logs also contain upstream Windows test-only dead-code warnings
and an intentional upstream contributor-policy build message. Those are
distinct from production Clippy errors and from GitHub Actions runtime
deprecations; this review does not claim warning-free upstream test builds.
