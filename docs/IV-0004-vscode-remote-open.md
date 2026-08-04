# IV-0004: Open local VS Code Remote-SSH from a remote herdr shell

## Record

- **Status:** implemented in ownership patch `0003` of the current `v0.8.0`
  representation; the latest published implementation remains
  `v0.7.5-win.05` (`hcode` first shipped in `v0.7.5-win.01`); automated tests
  and live deb1 request-transport verification complete
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

The official server already provides the needed remote-to-local side-effect channel:

```text
pane child OSC 52 write
  → src/pane/osc.rs parses and base64-decodes it
  → AppEvent::ClipboardWrite
  → headless server sends ServerMessage::Clipboard to foreground client
  → local client normally writes it to the host clipboard
```

A remote `hcode` shim emits an OSC 52 write containing a recognizable JSON request. The patched local client intercepts that request before ordinary clipboard forwarding, validates it, and starts local VS Code. Every non-magic OSC 52 payload follows the existing clipboard path unchanged.

## Implemented design

### Remote shim

[`extras/remote-bin/hcode`](../extras/remote-bin/hcode) is a POSIX-sh script
installed as `~/.local/bin/hcode` on each Linux target. The distinct name
avoids shadowing the official VS Code `code` CLI. Numbered Windows releases
also publish this script as the `hcode` asset.

- requires `HERDR_ENV=1` (exported by herdr panes), so invoking the shim in a plain ssh shell fails with an explanation;
- treats no arguments as `.`, resolves each argument with `realpath -m`, and marks existing directories as folders (other paths as files);
- accepts at most eight paths;
- emits `OSC 52 ; c ; <base64 JSON> BEL`, for example:

  ```json
  {"herdr":"code-open","v":1,"paths":[{"p":"/home/user/project","dir":true}]}
  ```

### Local launcher and client

The remote launcher passes the original ssh target to its child client as `HERDR_REMOTE_TARGET`. The client creates a code-open handler only for such remote clients.

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

The client passes each URL to herdr's existing platform URL opener. On Windows that is `ShellExecuteW`, which invokes the registered `vscode` protocol handler directly—no `cmd.exe`, `code.cmd`, install-path discovery, or shell-built command is involved. This is VS Code's documented remote file/workspace protocol and lets the OS select the registered installation.

### Config and kill switches

Enabled by default:

```toml
[remote]
code_open = true
```

Overrides:

- `HERDR_REMOTE_CODE_OPEN=0` disables launches;
- `HERDR_REMOTE_CODE_OPEN=1` forces them on.

Disabled, malformed, unsupported-version, invalid-target, invalid-path, and rate-limited magic requests are consumed rather than copied into the real clipboard.

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
| `src/client/code_open.rs` | **new** — payload recognition/validation, URL encoding, rate limiting, platform URL opening, unit tests |
| `src/client/mod.rs` | intercept magic clipboard payloads before ordinary OSC 52 forwarding |
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

A process running in the remote pane can emit OSC 52, so it can attempt a code-open request. The client limits that capability:

- host is fixed to the current local ssh target;
- only absolute remote paths are accepted;
- host/path data cannot change the fixed `vscode://vscode-remote/ssh-remote+` scheme or add shell syntax;
- no remote data is interpreted by a command shell;
- at most eight paths per request;
- requests are limited to one per second;
- VS Code's remote protocol-link confirmation and Workspace Trust still apply;
- `remote.code_open = false` disables launching.

This is intentionally not a general remote-to-local command execution mechanism.

## Known caveats

- VS Code normally asks for confirmation before opening a remote protocol link. This adds one local confirmation to `hcode .`; users can govern it with VS Code's `security.promptForRemoteFileProtocolHandling` setting.
- The official server shows its normal **“copied to clipboard”** toast when it receives the shim's OSC 52 request, even though the patched client intercepts the magic payload and does not modify the Windows clipboard. Suppressing that server-side cosmetic toast would require an official-server change or a new wire message, both intentionally out of scope.

## Non-goals

- No automatic shim installation or PATH modification on the target.
- No arbitrary local command or executable selection from remote data.
- No VS Code flags such as `--goto`, `--new-window`, or extension management in v1.
- No support for exotic ssh target syntax (simple host aliases and `user@host` are supported; use an ssh config alias for IPv6/proxy complexity).
- No server-side patch and no protocol change.

## Evidence and reproduction

Completed on Windows with Zig 0.15.2:

- `cargo clippy --locked --bin herdr -- -D warnings` — clean;
- `cargo test --locked --bin herdr client::` — 187 passed;
- `cargo test --locked --bin herdr remote::` — 78 passed;
- `cargo test --locked --bin herdr windows_` — 151 passed;
- `cargo test --locked --bin herdr server::client_transport::tests` — 22 passed;
- `cargo test --locked --bin herdr config::` — 130 passed;
- release-equivalent `cargo build --release --locked --target
  x86_64-pc-windows-msvc` — clean;
- focused `client::code_open::tests` — 15 passed after the
  window-preservation follow-up, including URL encoding, folder/file
  new-window fallbacks, validation/rate limiting, and disabled-request
  consumption;
- shim payload decoded and inspected successfully;
- clean-room: all three ownership patches applied with `git am` to a fresh
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
- before the URL-opener refactor, VS Code Remote-SSH activated its resolver for `ssh-remote+deb1`; current launch plumbing reuses herdr's existing Windows `ShellExecuteW` URL opener and the machine's registered `vscode` handler (`Code.exe --open-url -- "%1"`);
- VS Code's documented remote protocol-link format was checked against `vscode://vscode-remote/ssh-remote+[USER@]HOST[:PORT]/path`.

## Handoff

- Preserve ordinary clipboard fallback for every non-magic payload.
- Preserve the official-Linux-server/no-protocol-change constraint.
- Keep launch delegation on the platform URL opener; do not route remote-derived values through a command shell.
- Ownership patch `0003` applies after IV-0002 patch `0002`; keep all
  code-open behavior, naming, and window-preservation changes together.

## Decisions and deferred work

- Manual shim install was chosen over modifying the remote herdr installation. It keeps the feature explicit and avoids placing unrelated commands on every target.
- OSC 52 was chosen because the official server already forwards it as a typed protocol message; arbitrary terminal escape passthrough would not survive server-side rendering.
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
- 2026-08-04: refreshed patch `0003` onto `v0.8.0`; the three-patch
  clean-room apply and current filtered test suites are green.
