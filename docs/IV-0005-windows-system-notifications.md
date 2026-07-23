# IV-0005: Windows system toast notifications via uv + windows-toasts

## Record

- **Status:** implemented and exported as patch `0017`; unreleased
- **Upstream:** `checkouts/herdr`
  ([ogulcancelik/herdr](https://github.com/ogulcancelik/herdr))
- **Deliverables:** `patches/herdr/0017-*`
- **Implementation base:** `v0.7.5` (`ef4c23f`), stacked on patches
  `0001`–`0016`
- **Dependencies:** [IV-0001](IV-0001-windows-remote.md) supplies the native
  Windows remote client that receives forwarded notifications

## Purpose

With `[ui.toast] delivery = "system"`, herdr asks the OS notification service
to show background workspace events (agent finished / needs attention).
Upstream stubs the Windows implementation
(`src/platform/windows.rs` `show_desktop_notification` returned `Ok(false)`),
so Windows clients silently dropped every system notification — including the
primary fork scenario, `herdr --remote <linux-box>`.

## How the notification flows (remote attach)

The delivery decision is server-side; the delivery itself is client-side. No
protocol or server change is needed — `NotifyKind::SystemToast` exists in
upstream v0.7.5 (`src/protocol/wire.rs`), and the **official Linux server**
already forwards it:

```text
Linux server: agent state change
  → reads ITS config: [ui.toast] delivery = "system"
  → ServerMessage::Notify(NotifyKind::SystemToast) to the foreground client
Windows client: client::handle_notify
  → platform::show_desktop_notification   (runs locally on Windows)
```

`herdr notification show <title>` from inside a pane follows the same
forwarding path.

**Config requirement:** `delivery = "system"` must be set in the **server's**
config — on the remote Linux box for `--remote` sessions. The local Windows
config's toast setting is irrelevant during a remote session.

## Implemented design (patch 0017)

`src/platform/windows.rs` implements `show_desktop_notification` by spawning
the verified working call:

```text
uv run --no-project --with windows-toasts python -c <fixed script> <title> <body>
```

- The Python script is a fixed constant (`WINDOWS_TOAST_PYTHON_SCRIPT`) that
  reads title/body from `sys.argv` — notification text rides as process
  arguments and is **never interpolated into code** (no injection).
- `--no-project` keeps `uv run` from syncing an unrelated `pyproject.toml`
  in the client's working directory.
- Spawned with `CREATE_NO_WINDOW` (existing
  `configure_background_command_platform`) so no console window flashes.
- **Fire-and-forget:** `handle_notify` runs on the client event loop and
  `uv run` can take seconds on a cold cache (first run downloads a managed
  CPython and the `windows-toasts` package), so the helper is never awaited.
  Spawn success returns `Ok(true)`; script failures are best-effort.
- `uv` missing from `PATH` (`ErrorKind::NotFound`) returns `Ok(false)` — the
  same graceful no-op as a missing `notify-send` on Linux.

This mirrors the Linux (`notify-send`) and macOS
(`terminal-notifier`/`osascript`) shell-out pattern.

## Requirements and assumptions

- [`uv`](https://github.com/astral-sh/uv) must be on the Windows client's
  `PATH`. uv provisions Python and `windows-toasts` itself; no separate
  Python installation is needed.
- The toast shows under Python's app identity unless a `herdr` AUMID is
  registered; `WindowsToaster('herdr')` supplies the display name.
- The default Windows toast sound may play in addition to herdr's own sound
  notifications if both are enabled server-side.

## Non-goals

- No native WinRT toast implementation in Rust (kept dependency-free and
  matching the user-verified delivery mechanism).
- No pinning of the `windows-toasts` package version; `uv run --with` resolves
  the latest compatible release.
- No waiting/timeout supervision of the spawned helper; a hung `uv` process
  lingers until it exits on its own.

## Evidence and reproduction

Completed on Windows (Zig 0.15.2 via `ZIG=<path>`):

- `cargo clippy --locked --bin herdr -- -D warnings` — clean;
- `cargo test --locked --bin herdr windows_` — 130 passed (4 new:
  argv construction, empty-body placeholder, missing-`uv` → not shown,
  spawn success → shown);
- `cargo test --locked --bin herdr client::` — 174 passed;
- `cargo test --locked --bin herdr config::` — 128 passed;
- direct smoke test of the exact spawned command line delivered a visible
  Windows toast (`uv 0.10.6`, exit 0);
- clean-room: all 17 patches applied with `git am` to a fresh `v0.7.5`
  worktree reproduce the implementation tree exactly.

Live remote reproduction (when needed): set `delivery = "system"` in the
Linux target's herdr config, attach with `herdr --remote <target>`, then run
`herdr notification show "test" --body "hello"` inside a remote pane or let a
background agent finish.

## Handoff

- Keep title/body as argv when changing the helper; never build Python code
  from notification text.
- Keep the spawn fire-and-forget; the caller is the client event loop.
- Upstream churn in `src/platform/windows.rs` around the former stub is the
  conflict site on version bumps.
- Retire this patch if upstream implements Windows
  `show_desktop_notification` natively.
