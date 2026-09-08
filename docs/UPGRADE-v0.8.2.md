# v0.8.2 upgrade verification

## Scope

- Upstream stable tag: v0.8.2, peeled commit `9eb521456ac0d19d3ab3d9d7cea3cca10baa8a4c`.
- Five initiative patches retained. Upstream owns native Windows attach, endpoint ownership, cancellable transport, SSH config precedence, Windows clipboard decoding, and release checksum validation.
- Custom combined probe, timing, optional TCP relay, predictive echo, software-cursor support, hcode, bounded Linux clipboard FIFO, input/theme fixes, and binary self-update safeguard retained.
- Wire protocol remains 20, matching official Linux v0.8.2.
- Windows archive now bundles the pinned ConPTY runtime through upstream's checksum/signature-verified packager.

## Validation on Windows (2026-09-07)

- Rust 1.96.1; Zig 0.15.2; libghostty ReleaseSafe, SIMD disabled.
- `cargo fmt --all -- --check` and Windows `cargo clippy --locked --bin herdr -- -D warnings` passed.
- `cargo build --release --locked --target x86_64-pc-windows-msvc` passed.
- Windows package reports `herdr 0.8.2`; `herdr update` refuses replacement with the official binary and points to this repository's releases.
- ConPTY archive checksum, NuGet signature, per-file hashes, and Microsoft Authenticode signatures verified by upstream packaging scripts.
- Focused unit filters passed: remote (81), client (212), windows (176), server client transport (25), config (151), protocol framing (55), updater safeguard (1), default config (2), pane terminal (143). Counts overlap between filters.
- Test builds emitted upstream Windows test-only dead-code warnings. The production Clippy check was clean.
- Fresh v0.8.2 worktree applied all five exported patches with `git am`. Its tree exactly matches the built source: `c81e809749f3d87bd44bd69ae90886ee4d1f68a4`.

## Runtime verification against deb1

A separate `codex-upgrade-20260907` session used the existing official Linux Herdr v0.8.2 (protocol 20).

- Windows packaged client attached and reattached through Windows Terminal, WezTerm, and VS Code's local integrated terminal.
- WezTerm CLI input traversed the real Windows client and SSH bridge; output included `WEZTERM_INPUT_OK`.
- A temporary 32×24 Windows clipboard bitmap pasted through the Windows client became a valid 134-byte RGBA PNG under `/tmp/herdr-wr/`; the path appeared in the remote pane. Previous clipboard data was restored by the test harness.
- Linux shell syntax checks passed. A helper test with two five-byte images and an eight-byte FIFO budget retained only the second image, bytes `66 67 68 69 6a`, with mode 0600.
- The hcode shim opened `/tmp/herdr-upgrade-20260907/verification.txt` in local VS Code over SSH to deb1. Computer Use visually confirmed its contents; hcode returned 0.
- Computer Use launched the packaged Windows binary from VS Code's local terminal, pasted and executed a command via Edit > Paste and Return (`VSCODE_CUA_OK`), opened the Herdr context menu, and split the remote pane with the mouse. Rendering and pane geometry were inspected.

## Environment repair and limits

The deb1 LAN alias initially timed out. Its Tailscale exit node had LAN access disabled, directing LAN replies through tailscale0. Enabling only `exit-node-allow-lan-access` on deb1 restored `ssh deb1`; its exit-node selection was preserved.

Computer Use omitted standalone Windows Terminal and WezTerm from its app/window inventories. VS Code provided a targetable integrated terminal. Automated modifier chords were not reliable even in the initial PowerShell prompt; menu paste and unmodified keys were used. This does not establish physical-keyboard shortcut behavior. Predictive/software-cursor cases have unit coverage; no live AI-TUI/high-RTT latency benchmark was run.

An additional Linux-target Clippy attempt from Windows stopped during Zig dependency extraction: creating libxml2 test-data symlinks returned `AccessDenied`. It did not reach Rust source checking. Native Linux build/Clippy validation remains outstanding; the successful Windows checks above are unaffected.

No release or branch was pushed. Test binaries, logs, portable WezTerm, and the Windows archive remain in ignored `checkouts/upgrade-merge/`. The test session and test files on deb1 remain available for inspection.
