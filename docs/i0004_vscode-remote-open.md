# i0004: Open local VS Code Remote-SSH from a remote herdr shell

**Status:** implemented and exported as patch `0012`; automated tests and live deb1 request transport verification complete
**Upstream:** `checkouts/herdr` ([ogulcancelik/herdr](https://github.com/ogulcancelik/herdr))
**Deliverable:** `patches/herdr/0012-*` + [`extras/remote-bin/code`](../extras/remote-bin/code)
**Implementation base:** `v0.7.4` (`50aaa2e`), stacked on patches `0001`–`0011`

## Goal

While attached from Windows with `herdr --remote deb1`, make this remote-shell workflow:

```sh
cd /some/project
code .
```

launch Windows VS Code in Remote-SSH mode, connected through the same ssh target (`deb1`) and opening `/some/project` as its remote folder.

## Constraint and integration point

The remote server remains the **official Linux herdr binary**. Patch 0012 makes no server or wire-protocol changes.

The official server already provides the needed remote-to-local side-effect channel:

```text
pane child OSC 52 write
  → src/pane/osc.rs parses and base64-decodes it
  → AppEvent::ClipboardWrite
  → headless server sends ServerMessage::Clipboard to foreground client
  → local client normally writes it to the host clipboard
```

A remote `code` shim emits an OSC 52 write containing a recognizable JSON request. The patched local client intercepts that request before ordinary clipboard forwarding, validates it, and starts local VS Code. Every non-magic OSC 52 payload follows the existing clipboard path unchanged.

## Implemented design

### Remote shim

[`extras/remote-bin/code`](../extras/remote-bin/code) is a POSIX-sh script installed as `~/.local/bin/code` on each Linux target.

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
vscode://vscode-remote/ssh-remote+deb1/home/user/project/
```

Directories get a trailing slash; files do not. Paths are required to be absolute and control-character-free, then UTF-8 percent-encoded. The ssh authority always comes from the local launcher's target, never from remote payload data.

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
scp extras/remote-bin/code deb1:~/.local/bin/code
ssh deb1 'chmod +x ~/.local/bin/code'
```

Ensure `~/.local/bin` precedes any other `code` command in the remote login shell's `PATH`. Then start the patched Windows build:

```powershell
herdr --remote deb1
```

Inside its Linux shell:

```sh
cd /some/project
code .
```

VS Code's Remote-SSH extension must be installed locally, and the target should be a normal ssh alias/host accepted by both herdr and VS Code (for example `deb1` or `user@deb1`). Workspace Trust remains governed by VS Code.

## Patch 0012 — `feat(fork): open local VS Code from remote shells`

| File | Change |
|---|---|
| `src/client/code_open.rs` | **new** — payload recognition/validation, URL encoding, rate limiting, platform URL opening, unit tests |
| `src/client/mod.rs` | intercept magic clipboard payloads before ordinary OSC 52 forwarding |
| `src/remote/launcher.rs`, `src/remote.rs` | pass/re-export `HERDR_REMOTE_TARGET` for the spawned local client |
| `src/config/model.rs` | `remote.code_open` (default true) and config tests |

Repository-only file:

| File | Change |
|---|---|
| `extras/remote-bin/code` | installable Linux-side command shim |

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

- VS Code normally asks for confirmation before opening a remote protocol link. This adds one local confirmation to `code .`; users can govern it with VS Code's `security.promptForRemoteFileProtocolHandling` setting.
- The official server shows its normal **“copied to clipboard”** toast when it receives the shim's OSC 52 request, even though the patched client intercepts the magic payload and does not modify the Windows clipboard. Suppressing that server-side cosmetic toast would require an official-server change or a new wire message, both intentionally out of scope.

## Non-goals

- No automatic shim installation or PATH modification on the target.
- No arbitrary local command or executable selection from remote data.
- No VS Code flags such as `--goto`, `--new-window`, or extension management in v1.
- No support for exotic ssh target syntax (simple host aliases and `user@host` are supported; use an ssh config alias for IPv6/proxy complexity).
- No server-side patch and no protocol change.

## Verification

Completed on Windows with Zig 0.15.2:

- `cargo clippy --bin herdr -- -D warnings` — clean;
- `cargo test --bin herdr client::` — 148 passed after the platform URL-opener refactor;
- `cargo test --bin herdr remote::` — 75 passed;
- `cargo test --bin herdr windows_` — 121 passed;
- `cargo test --bin herdr server::client_transport::tests` — 19 passed;
- `cargo test --bin herdr config::` — 121 passed;
- focused `client::code_open::tests` — 15 passed after refactoring to the platform URL opener, including URL encoding, folder/file URLs, validation/rate limiting, and disabled-request consumption;
- shim payload decoded and inspected successfully;
- clean-room: all 12 patches applied with `git am` to a fresh `v0.7.4` worktree; `src/` exactly matches the implementation checkout (the only whole-tree difference is the known fork-era CI workflow intentionally excluded from the series);
- `git diff --check` — clean.

Test binaries report nine pre-existing test-only unused-code/import warnings; production clippy with warnings denied is clean.

Live deb1 verification:

- installed the shim as `~/.cargo/bin/code` because that is deb1's first user-writable PATH directory;
- through the official Linux v0.7.4 server, `cd /tmp && code .` reached a temporary local capture executable as exactly `--folder-uri` + `vscode-remote://ssh-remote+deb1/tmp`;
- before the URL-opener refactor, VS Code Remote-SSH activated its resolver for `ssh-remote+deb1`; current launch plumbing reuses herdr's existing Windows `ShellExecuteW` URL opener and the machine's registered `vscode` handler (`Code.exe --open-url -- "%1"`);
- VS Code's documented remote protocol-link format was checked against `vscode://vscode-remote/ssh-remote+[USER@]HOST[:PORT]/path`.

## Handoff

- Preserve ordinary clipboard fallback for every non-magic payload.
- Preserve the official-Linux-server/no-protocol-change constraint.
- Keep launch delegation on the platform URL opener; do not route remote-derived values through a command shell.
- Patch `0012` applies after i0002's `0011`.

## Decisions and deferred work

- Manual shim install was chosen over modifying the remote herdr installation. It keeps the feature explicit and avoids placing unrelated commands on every target.
- OSC 52 was chosen because the official server already forwards it as a typed protocol message; arbitrary terminal escape passthrough would not survive server-side rendering.
- Auto-provisioning the shim and broader VS Code CLI compatibility are deferred until live usage demonstrates they are needed.

## Check log

- 2026-07-20: patch `0012` implemented/exported; automated tests green; live deb1 OSC 52 request transport verified `/tmp`; VS Code Remote-SSH resolver launch verified. Launch code was then simplified to herdr's existing platform URL opener using VS Code's documented remote protocol URL. deb1 shim installed at `~/.cargo/bin/code`.
