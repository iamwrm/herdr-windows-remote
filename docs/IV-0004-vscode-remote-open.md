# IV-0004: Open local VS Code Remote-SSH from a remote herdr shell

## Record

- **Status:** implemented in ownership patch `0003` of the current `v0.8.0`
  representation; the latest publication is `v0.8.0-win.05` (`hcode` first
  shipped in `v0.7.5-win.01`); automated tests, isolated Windows launch
  verification, and live deb1 request-transport verification complete
- **Upstream:** `checkouts/herdr`
  ([herdrdev/herdr](https://github.com/herdrdev/herdr))
- **Deliverables:** `patches/herdr/0003-*-IV-0004.patch`,
  [`extras/remote-bin/hcode`](../extras/remote-bin/hcode), and the `hcode`
  release asset
- **Implementation base:** `v0.8.0` (`346411fa`), stacked on ownership
  patches `0001`–`0002`
- **Dependencies:** [IV-0001](IV-0001-windows-remote.md) supplies the native
  Windows remote client; [IV-0002](IV-0002-latency-improvements.md) owns the
  preceding client/transport latency patch

## Purpose

While attached from Windows with `herdr --remote deb1`, make this remote-shell workflow:

```sh
cd /some/project
hcode .
```

launch Windows VS Code in Remote-SSH mode, connected through the same ssh target (`deb1`) and opening `/some/project` as its remote folder.

## Constraint and integration point

The remote server remains the **official Linux herdr binary**. Ownership patch
`0003` makes no server or wire-protocol changes.

The official server already provides a terminal-safe remote-to-local control
channel:

```text
hcode invokes `herdr terminal title set <magic-chunk>`
  → official server API validates and caps the title message
  → ServerMessage::WindowTitle reaches the foreground client reliably
  → patched client consumes magic chunks before host-title rendering
```

The request is chunked because the official API caps titles at 200 characters.
The client validates and reassembles the chunks, validates the decoded JSON,
and starts local VS Code. Ordinary window-title messages remain unchanged.
Older OSC 52 requests remain accepted so an already-installed legacy `hcode`
continues to work, but current shims no longer trigger the server's clipboard
feedback toast.

## Implemented design

### Remote shim

[`extras/remote-bin/hcode`](../extras/remote-bin/hcode) is a POSIX-sh script
installed as `~/.local/bin/hcode` on each Linux target. The distinct name
avoids shadowing the official VS Code `code` CLI. Numbered Windows releases
also publish this script as the `hcode` asset.

- requires `HERDR_ENV=1` (exported by herdr panes), so invoking the shim in a plain ssh shell fails with an explanation;
- treats no arguments as `.`, resolves each argument with `realpath -m`, and marks existing directories as folders (other paths as files);
- accepts at most eight paths;
- base64-encodes and splits the JSON into 128-character chunks, then sends
  each with `herdr terminal title set`; for example, the decoded payload is:

  ```json
  {"herdr":"code-open","v":1,"paths":[{"p":"/home/user/project","dir":true}]}
  ```

### Local launcher and client

The remote launcher passes the original ssh target to its child client as
`HERDR_REMOTE_TARGET`. The client creates a code-open handler only for such
remote clients. Magic title chunks are intercepted before `write_window_title`,
so neither protocol data nor launch failures can overwrite the terminal UI.
Incomplete, stale, oversized, malformed, and out-of-order chunk sequences are
consumed and discarded. Legacy magic clipboard payloads are still intercepted
before ordinary clipboard forwarding.

For a valid request, `src/client/code_open.rs` builds a registered VS Code Remote-SSH URL:

```text
vscode://vscode-remote/ssh-remote+deb1/home/user/project/?windowId=_blank
```

Directories get a trailing slash and `windowId=_blank`. Files get a `:1`
line marker, which VS Code removes before opening the file; this is required
for its remote protocol parser to classify the path as a file. Paths are
required to be absolute and control-character-free, then UTF-8 percent-encoded.
The ssh authority always comes from the local launcher's target, never from
remote payload data.

For folders, `windowId=_blank` is a new-window **fallback**: VS Code first
focuses an already-open window whose remote workspace URI exactly matches; if
there is no match, it opens a new window instead of replacing an unrelated
active workspace. This also keeps multiple requested folders from collapsing
into one repeatedly replaced window. File links naturally select an existing
window containing the file, or open a new one when no workspace contains it.

The interactive client does not invoke the registered handler directly.
Instead it starts the current herdr executable in a hidden broker mode with
null stdin/stdout/stderr and, on Windows, `CREATE_NO_WINDOW`. The broker
revalidates the fixed `vscode://vscode-remote/ssh-remote+` prefix and then
invokes the platform URL opener. This prevents VS Code, Electron, and extension
hosts from attaching to or inheriting the client's raw alternate-screen
console. The client monitors the broker and reports launch or handler failures
with a rate-limited native notification while retaining details in
`herdr-client.log`.

On Windows the broker uses `ShellExecuteExW` with `SEE_MASK_FLAG_NO_UI` to
suppress shell-generated association/error dialogs and `SEE_MASK_NOASYNC` so
launch delegation finishes before the short-lived broker exits. VS Code's own
remote-link confirmation and Workspace Trust UI remain enabled. The registered
`vscode` protocol handler is still selected directly—no `cmd.exe`, `code.cmd`,
install-path discovery, or shell-built command is involved.

### Config and kill switches

Enabled by default:

```toml
[remote]
code_open = true
```

Overrides:

- `HERDR_REMOTE_CODE_OPEN=0` disables launches;
- `HERDR_REMOTE_CODE_OPEN=1` forces them on.

Disabled, malformed, unsupported-version, invalid-target, invalid-path, and
rate-limited magic requests are consumed rather than displayed as a terminal
title or copied into the real clipboard. Rejections and launch failures produce
at most one native failure notification per 30 seconds; normal success stays
silent. Default info logs record only the ssh target and path count, not remote
absolute paths or complete VS Code URLs.

## Install the remote shim

From this repository:

```sh
ssh deb1 'mkdir -p ~/.local/bin'
scp extras/remote-bin/hcode deb1:~/.local/bin/hcode
ssh deb1 'chmod +x ~/.local/bin/hcode'
```

Alternatively, download the `hcode` asset from the same numbered GitHub
release as the Windows executable and install it with mode `0755`. Ensure
`~/.local/bin` is in the remote login shell's `PATH`. Then start the patched
Windows build:

```powershell
herdr --remote deb1
```

Inside its Linux shell:

```sh
cd /some/project
hcode .
```

VS Code's Remote-SSH extension must be installed locally, and the target should be a normal ssh alias/host accepted by both herdr and VS Code (for example `deb1` or `user@deb1`). Workspace Trust remains governed by VS Code.

## Ownership patch `0003` — `feat(fork): open local VS Code from remote shells (IV-0004)`

This patch contains the complete IV-0004 boundary: the initial integration,
the final `hcode` naming, and VS Code window-preservation behavior.

| File | Change |
|---|---|
| `src/client/code_open.rs` | **new** — title-chunk reassembly, legacy clipboard recognition, payload validation, URL encoding, rate limiting, isolated broker launch, unit tests |
| `src/client/mod.rs` | intercept magic title chunks and legacy clipboard payloads before host rendering/forwarding; expose the hidden broker dispatcher |
| `src/main.rs` | dispatch the hidden broker before ordinary CLI parsing and log broker failures only to `herdr-client.log` |
| `src/platform/mod.rs`, `src/platform/windows.rs`, `Cargo.toml` | broker-specific no-UI `ShellExecuteExW` delegation and required Windows API feature |
| `src/remote/launcher.rs`, `src/remote.rs` | pass/re-export `HERDR_REMOTE_TARGET` for the spawned local client |
| `src/config/model.rs` | `remote.code_open` (default true) and config tests |

Repository-only file:

| File | Change |
|---|---|
| `extras/remote-bin/hcode` | installable Linux-side command shim and release asset |

### Included `hcode` naming

The patch's final-tree source comments and generated-config guidance
to use `hcode`. The wire payload (`code-open`), Rust identifiers,
`remote.code_open`, and `HERDR_REMOTE_CODE_OPEN` remain unchanged for backward
compatibility; they are internal integration names and do not claim the Linux
`code` command.

### Included VS Code window preservation

The patch adds VS Code's `windowId=_blank` URL parameter to folder links.
Exact matching workspaces are still reused and focused; unmatched folders open
separately instead of replacing an existing workspace. It also adds the `:1`
marker required for VS Code to route file links to a containing window.

## Security properties

A process running in the remote pane can invoke the local herdr API, so it can
attempt a code-open request. The client limits that capability:

- host is fixed to the current local ssh target;
- only absolute remote paths are accepted;
- host/path data cannot change the fixed `vscode://vscode-remote/ssh-remote+` scheme or add shell syntax;
- no remote data is interpreted by a command shell;
- the hidden broker accepts only the fixed VS Code Remote-SSH URL prefix and
  has no console or terminal-facing standard handles;
- at most eight paths per request;
- requests are limited to one per second;
- VS Code's remote protocol-link confirmation and Workspace Trust still apply;
- `remote.code_open = false` disables launching.

This is intentionally not a general remote-to-local command execution mechanism.

## Known caveats

- VS Code normally asks for confirmation before opening a remote protocol link. This adds one local confirmation to `hcode .`; users can govern it with VS Code's `security.promptForRemoteFileProtocolHandling` setting.
- `hcode` treats a successful API exchange with `changed = false` as a delivery
  failure, reports the bounded sanitized response, and exits nonzero instead of
  claiming that a detached client accepted the request.
- Up to eight title requests can be reassembled concurrently. Additional
  in-flight requests are rejected and notified rather than allowing an
  unbounded remote process to consume client memory.
- Legacy installed shims still use OSC 52 and therefore still cause the
  official server's “copied to clipboard” feedback. Replace the shim with the
  current release asset to use the title-control transport.

## Non-goals

- No automatic shim installation or PATH modification on the target.
- No arbitrary local command or executable selection from remote data.
- No VS Code flags such as `--goto`, `--new-window`, or extension management in v1.
- No support for exotic ssh target syntax (simple host aliases and `user@host` are supported; use an ssh config alias for IPv6/proxy complexity).
- No server-side patch and no protocol change.

## Evidence and reproduction

Completed on Windows with Zig 0.15.2:

- `cargo clippy --locked --bin herdr -- -D warnings` — clean;
- `cargo test --locked --bin herdr client::` — 200 passed;
- `cargo test --locked --bin herdr remote::` — 78 passed;
- `cargo test --locked --bin herdr windows_` — 151 passed;
- `cargo test --locked --bin herdr server::client_transport::tests` — 22 passed;
- `cargo test --locked --bin herdr config::` — 130 passed;
- release-equivalent `cargo build --release --locked --target
  x86_64-pc-windows-msvc` — clean;
- focused `client::code_open::tests` — 26 passed after the failure-visibility
  follow-up, including interleaved bounded chunk reassembly/reset/timeout,
  final magic-chunk consumption, broker URL/argv validation, notification
  throttling, ordinary title passthrough, URL encoding, folder/file new-window
  fallbacks, validation/rate limiting, and disabled-request consumption;
- shim payload decoded and inspected successfully; `sh -n` passes, and a
  failing fake `herdr terminal title set` produces no stdout and only hcode's
  single stable delivery error;
- clean-room: all four ownership patches apply with `git am` to a fresh
  `v0.8.0` worktree and exactly match the implementation checkout; the known
  fork-era CI workflow is intentionally excluded from both;
- `git diff --check` — clean.

Test binaries report nine pre-existing test-only unused-code/import warnings; production clippy with warnings denied is clean.

Live deb1 verification:

- before the rename, the identical shim was installed as `~/.cargo/bin/code`
  because that is deb1's first user-writable PATH directory;
- through the official Linux v0.7.4 server, `cd /tmp && code .` reached a
  temporary local capture executable as exactly `--folder-uri` +
  `vscode-remote://ssh-remote+deb1/tmp`;
- the renamed `hcode` script produces the same validated payload and is now
  installed as `~/.cargo/bin/hcode`;
- before the URL-opener refactor, VS Code Remote-SSH activated its resolver for `ssh-remote+deb1`; current launch plumbing uses the machine's registered `vscode` handler (`Code.exe --open-url -- "%1"`) through the isolated broker;
- the local VS Code 1.130.0 executable was observed emitting Node
  `DEP0169` deprecation warnings, `[AgentHost:stderr]` lines, and `Unknown
  channel` errors when attached to a caller's output; launching the same
  `deb1/tmp` Remote-SSH URL from a `CREATE_NO_WINDOW` broker exited zero with
  zero captured stdout and stderr bytes, after which the smoke-test Code
  processes were removed;
- VS Code's documented remote protocol-link format was checked against `vscode://vscode-remote/ssh-remote+[USER@]HOST[:PORT]/path`.

## Handoff

- Preserve ordinary title rendering and clipboard fallback for every
  non-magic payload.
- Preserve the official-Linux-server/no-protocol-change constraint.
- Keep launch delegation inside the no-console broker; never invoke VS Code
  directly from the raw-screen client or route remote-derived values through a
  command shell.
- Ownership patch `0003` applies after IV-0002 patch `0002`; keep all
  code-open behavior, naming, and window-preservation changes together.

## Decisions and deferred work

- Manual shim install was chosen over modifying the remote herdr installation. It keeps the feature explicit and avoids placing unrelated commands on every target.
- OSC 52 was initially chosen because the official server forwards it as a
  typed protocol message, but its unavoidable clipboard-feedback toast
  disturbed the terminal interface. The existing title API is also a reliable
  typed control path, has no feedback toast, and requires only client-side
  chunk reassembly; OSC 52 remains a backward-compatibility input.
- Auto-provisioning the shim and broader VS Code CLI compatibility are deferred until live usage demonstrates they are needed.

## Evidence log

- 2026-07-20: the integration was implemented/exported; automated tests
  green; live deb1 OSC 52 request transport verified `/tmp`; VS Code
  Remote-SSH resolver launch verified. Launch code was then simplified to
  herdr's existing platform URL opener using VS Code's documented remote
  protocol URL.
- 2026-07-20: renamed the Linux command from `code` to `hcode` so it cannot
  shadow the official VS Code CLI; added `hcode` to release assets and
  installed it on deb1 at `~/.cargo/bin/hcode`.
- 2026-07-21: added the `windowId=_blank` fallback so exact existing
  workspaces are focused while unmatched folders cannot replace unrelated
  VS Code windows.
- 2026-08-01: recombined the implementation, naming, and window-preservation
  follow-ups into ownership patch `0003`; clean-room application preserves the
  former stack's final tree.
- 2026-08-04: refreshed patch `0003` onto `v0.8.0`; the then-three-patch
  clean-room apply and current filtered test suites were green.
- 2026-08-10: replaced the current shim's OSC 52 transport with chunked
  `client.window_title` control messages. This removes the server clipboard
  feedback while preserving legacy shim compatibility.
- 2026-08-10: confirmed that the Windows VS Code handler can emit Electron,
  Node deprecation, and agent-host diagnostics into its caller's console.
  Moved protocol-handler invocation behind a null-stdio, `CREATE_NO_WINDOW`
  broker; suppressed only shell-generated error UI; and made every prefixed
  title chunk terminal-private. Focused tests (22), the broker launch smoke,
  script syntax, production Clippy, and clean-room reproduction are green.
- 2026-08-13: hardened failure visibility and concurrency. `hcode` now rejects
  `changed = false` API responses and preserves bounded sanitized transport
  errors; the client monitors broker exit, emits rate-limited native failure
  notifications, avoids logging full remote paths at info, and reassembles up
  to eight interleaved request IDs independently. Focused tests (26), shim
  success/no-client/transport-failure smoke cases, production Clippy with
  warnings denied, formatting, clean-room reproduction, and whitespace checks
  are green.
