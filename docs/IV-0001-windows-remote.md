# IV-0001: Native Windows `herdr --remote` support

## Record

- **Status:** implemented as the current five-patch `v0.8.0` representation;
  the latest publication is `v0.8.0-win.05`
- **Upstream:** `checkouts/herdr`
  ([herdrdev/herdr](https://github.com/herdrdev/herdr))
- **Deliverables:** ownership patch `patches/herdr/0001-*-IV-0001.patch` and
  `.github/workflows/release-windows.yml`
- **Implementation base:** upstream release tag `v0.8.0` (`346411fa`), pinned
  in `patches/herdr/BASE` and `patches/herdr/BASE_COMMIT`
- **Consumers:** [IV-0002](IV-0002-latency-improvements.md) builds latency
  improvements on this transport; [IV-0004](IV-0004-vscode-remote-open.md)
  adds remote-to-local VS Code opening

## Purpose

`herdr --remote <ssh-target>` from the **native Windows binary**, which
upstream ships as unsupported in the Windows beta ("Native Windows
`herdr --remote` is not part of the beta", upstream
`website/src/content/docs/windows-beta.mdx`). Retire this initiative — and
this repo — as soon as upstream supports it natively (see
[When to retire](#when-to-retire)).

This work previously lived in the fork `iamwrm/herdr` (branch
`windows-remote`, releases `fork-v0.7.4-win.1` … `fork-v0.7.4-win.5`, notes in
its issue #1). The fork is replaced by this patches repo; the series here is
the fork's commits minus the CI commit, which became this repo's own workflow.

## How upstream's `--remote` works (reference)

All local-side: install/verify a matching `herdr` on the server over ssh →
run an **stdio bridge** (local socket ⇄ `ssh -T host "exec herdr
remote-client-bridge"`) → spawn the local thin client (`herdr client`)
pointed at that socket. Only a thin platform layer was Unix-only.

## The port (design)

- `src/remote/unix.rs` → `src/remote/launcher.rs` (platform-neutral launcher,
  ~95% of the code, imports the platform layer as `sys`)
- `src/remote/unix.rs` (new, small): original Unix bits verbatim — `AF_UNIX`
  bridge socket, managed ssh config with ControlMaster, remote-side client bridge
- `src/remote/windows.rs` (new): the actual port
  - bridge socket is a **named pipe** served through `crate::ipc` (same
    transport the Windows client already speaks for local attach)
  - named pipes have no half-close ⇒ the client→ssh pump uses a blocking read
    for immediate forwarding; when ssh dies, shutdown cancels the in-flight
    read with `CancelIoEx`, then drops the whole pipe so the client observes loss
  - shutdown wake: the throwaway connection that unblocks the blocking
    `accept` must **stay open until the accept thread joins** — interprocess
    clears already-disconnected clients as "empty connections"
    (`ERROR_NO_DATA` loop) and keeps blocking otherwise
  - Windows OpenSSH has **no ControlMaster/mux** ⇒ no managed ssh config;
    `-o ServerAliveInterval=15 -o ServerAliveCountMax=4` injected as CLI flags
    (note: these override user-config `ServerAlive*`, unlike Unix). Every ssh
    hop is a fresh connection — keep your key in `ssh-agent`
- small un-gates: `checksum` module,
  `update::is_package_manager_managed_exe_path`, the 60s remote handshake
  timeout in `client/mod.rs`, `platform::capabilities().remote_attach`

## Implemented ownership patch

Patch `0001` contains the complete IV-0001 ownership boundary. The changes below
were developed separately, but are maintained together because they jointly
provide and safeguard the native Windows remote client.

### Native Windows remote transport

The port described above: `launcher.rs` split, new `unix.rs`/`windows.rs`
platform layers, `crate::ipc` named-pipe bridge, un-gated modules.

### Win32-input-mode paste fix

Multi-line pastes into a remote Linux pane inserted literal
`[13;28;13;1;0;0;1_` after every line end. Two client-side defects in
`src/client/input/windows_vti.rs`, both upstream code — not introduced by the
port:

1. `parse_win32_input_mode_key_record` was stricter than the reference
   decoder (`InputStateMachineEngine::_GenerateWin32Key` in
   microsoft/terminal): it required all six `Vk;Sc;Uc;Kd;Cs;Rc` parameters and
   rejected extras. The reference treats every parameter as optional (Rc
   defaults to 1) and ignores extra trailing parameters. Some ConPTY hosts
   emit a seven-field variant for synthesized keys (Enter between pasted
   lines); the failed parse fell through to raw-byte passthrough.
2. Inside a bracketed paste that began as plain text, a decoded win32 key
   record pushed its **raw sequence bytes** instead of its paste payload.

Only remote panes showed it: local Windows panes feed input back into their
own ConPTY, which re-parses the leaked sequences leniently and absorbs them.
Linux PTYs display the bytes verbatim.

**Worth upstreaming:** both fixes are platform-generic client input handling
(upstream can hit defect 2 via WSL panes or any non-ConPTY sink). One upstream
test (`vti_win32_input_mode_sequence_inside_bracketed_paste_stays_payload`)
deliberately asserted the raw-preservation behavior and was updated to expect
the decoded payload — flag this if submitting a PR upstream.

### Fork self-update safeguard

`herdr update` and the background version check are **hard-disabled**
(`FORK_BUILD` in `src/update.rs`): both compare against the official herdr.dev
manifests and would replace the patched binary with an upstream build lacking
Windows `--remote`. `herdr update` now exits with an error pointing at this
repo's releases page.

Kept enabled on purpose: the agent-manifest background check (agent detection
data only) and the remote-install manifest lookup — installing the matching
official *Linux* binary on the ssh target is exactly what `--remote` needs.

### Host terminal theme and inverse-video rendering fix

TUIs that hide the native cursor and draw their own as reverse video over
default colors (pi's editor does exactly `\x1b[7m<char>\x1b[27m`) showed a
**white block** in remote Linux panes.

Root cause: pane rendering happens **server-side**, and the server resolves
`SGR 7` cells with default colors into concrete swapped colors using the
pane's palette, seeded from the client's host terminal theme (OSC 10/11
defaults). The Windows client had the theme query hard-disabled
(`should_query_host_terminal_theme() = !cfg!(windows)`) *and* dropped
`HostDefaultColor` events, so the server fell back to libghostty's built-in
white-on-black palette.

Fix, two layers:

1. **Client** (works with *official* Linux servers — important since
   `--remote` installs official binaries): enable the OSC 10/11 query on
   Windows; the response comes back through ConPTY as console input; the
   console reader reconstructs the report sequences and forwards them as raw
   `ClientMessage::Input` bytes — the same shape Unix clients send. Re-queries
   on color-scheme-change reports.
2. **Server** (defense in depth, fork builds only): when an inverse cell would
   need an untrustworthy resolve color, emit `Modifier::REVERSED` with default
   colors and let the host terminal reverse its real palette.

Verified against Windows Terminal 1.24 → official herdr 0.7.4 Linux server by
screenshot pixel sampling (`#CCCCCC`/`#0C0C0C` instead of pure
`#FFFFFF`/`#000000`). Caveat: terminals that never answer OSC 10/11 (legacy
conhost) still show the fallback unless the server also has fix 2. Both layers
are platform-generic quality fixes; no protocol change was needed.

### Remote attach timing diagnostics

`HERDR_REMOTE_TIMING=1` prints per-phase attach timing (each ssh round-trip
labelled) for diagnosing slow attaches.

## Files affected (summary)

| Repo | File | Change |
|------|------|--------|
| herdr | `src/remote/launcher.rs` | **new** — platform-neutral launcher (from `unix.rs`) |
| herdr | `src/remote/unix.rs` | rewritten small — Unix platform bits only |
| herdr | `src/remote/windows.rs` | **new** — named-pipe bridge, ssh keepalive flags |
| herdr | `src/remote.rs`, `src/main.rs`, `src/platform/mod.rs`, `src/ipc.rs`, `src/client/mod.rs` | un-gates, `remote_attach` capability, generated cross-platform ssh guidance |
| herdr | `src/client/input/windows_vti.rs`, `src/client/input.rs` | win32-input-mode paste fix; OSC 10/11 theme forwarding |
| herdr | `src/pane/terminal.rs` | inverse-cell fallback rendering |
| herdr | `src/update.rs` | `FORK_BUILD` self-update disable |
| this repo | `patches/herdr/0001-*-IV-0001.patch`, `patches/herdr/BASE*` | durable ownership patch + pinned release tag/commit |
| this repo | `.github/workflows/release-windows.yml` | fetch `BASE`, verify `BASE_COMMIT` → `git am` → build → release |

## Known limitations / non-goals

- no ssh multiplexing on Windows; the happy path uses one combined setup probe
  plus the persistent bridge, and any additional path still opens fresh ssh
  connections (keep your key in `ssh-agent`)
- the bridge pump is event-driven, but normal ssh/TCP transport latency remains
- `--handoff` untested from Windows
- `remote-client-bridge` still stubbed on Windows (Windows hosts can't be
  `--remote` *targets* — not needed, the target is Linux)
- no upstreaming of the port itself (patches stay local per `docs/repo.md`);
  the input and theme fixes are platform-generic and worth offering upstream

## Evidence and reproduction

- attach, keystroke/output round trip, TUI rendering
- remote server survives client loss; reattach restores scrollback + missed
  output
- **remote auto-update** (v0.7.3 → v0.7.4 on the server): the launcher
  prompts, downloads the official Linux asset from
  `https://herdr.dev/latest.json` **on the local Windows machine**, and
  streams it to the server over ssh (`tee`). Because the download is local,
  this works even when the remote host's own TLS/cert setup is broken.
- expected cosmetic warning if the remote login shell's PATH lacks
  `~/.local/bin`: *"remote shell does not resolve `herdr` to that path"* —
  harmless, the launcher always uses the absolute path
- clean-room: the complete five-patch series applies with `git am` to a fresh
  worktree at `v0.8.0` and reproduces the implementation tree exactly; the
  obsolete fork CI workflow remains intentionally outside the series

## Handoff

### Release workflow

`.github/workflows/release-windows.yml` verifies the `BASE` tag resolves to
`BASE_COMMIT`, then builds `x86_64-pc-windows-msvc` with upstream's pinned
steps (Rust toolchain per `rust-toolchain.toml`, Zig 0.15.2,
`cargo build --release --locked`) and publishes a prerelease with
`herdr-windows-x86_64.exe`, the Linux `hcode` shim, and `BUILD_INFO.html`
(shipped as HTML so the asset renders in the browser without downloading).

- **Trigger by tag:** `git tag vX.Y.Z-win.NN && git push origin <tag>`.
  The `vX.Y.Z` part must match `patches/herdr/BASE` (enforced by the
  workflow). `NN` starts at `01` for each new upstream version and is always
  two digits so GitHub sorts numbered releases correctly.
- **Trigger manually:** `gh workflow run release-windows.yml` → rolling
  `windows-remote-latest` prerelease.
- Legacy `v0.7.4` tags continued the fork's unpadded counter. Starting with
  `v0.7.5`, each upstream version has its own two-digit counter: `win.01`,
  `win.02`, and so on.

### Update policy

Fork builds never self-update (the safeguard is owned by patch `0001`). To
update, download from this repo's releases. The remote-install path deliberately still uses the official
manifests — that is how `--remote` provisions the matching official *Linux*
binary on the ssh target.

### Upstream version bump runbook

Run this whenever upstream tags a new `v*` release — **even docs-only
releases**: the launcher's exact-version match means old builds will prompt to
reinstall/refuse against a newer manifest, so a matching build is always
needed.

```bash
cd checkouts/herdr
git fetch origin --tags
git log --oneline vOLD..vX.Y.Z -- src/   # eyeball src changes, esp. src/remote/, src/ipc.rs
git checkout vX.Y.Z
git am ../../patches/herdr/*.patch       # fix conflicts if any
```

> **Base on the release tag, not `master`.** Master is usually ahead of the
> release; building from master would embed a version/protocol that may not
> exist in `https://herdr.dev/latest.json` yet, breaking remote auto-install.

Then validate (Windows; needs Zig ≥ 0.15.2 via `ZIG=<path>` for the vendored
libghostty-vt):

```bash
cargo clippy --locked --bin herdr -- -D warnings
cargo test --locked --bin herdr remote::
cargo test --locked --bin herdr client::
cargo test --locked --bin herdr windows_
cargo test --locked --bin herdr server::client_transport::tests
cargo test --locked --bin herdr config::
cargo test --locked --bin herdr protocol::wire::tests
cargo test --locked --bin herdr fork_self_update_error_points_to_current_releases
cargo test --locked --bin herdr default_config_
RUSTDOCFLAGS="-D rustdoc::broken_intra_doc_links" \
  cargo doc --locked --no-deps --document-private-items
# do NOT run --all-targets: the tests/ integration suite is Unix-only upstream
```

Known-noisy: 5 `detect::manifest_update` tests fail on some Windows dev
machines with and without these patches (pre-existing, env-dependent;
upstream's Windows CI only runs the `windows_` and `server::client_transport`
filters). Not related to this series.

Check the protocol still matches the manifest:
`grep PROTOCOL_VERSION src/protocol/wire.rs` vs
`curl -s https://herdr.dev/latest.json | head`. If upstream bumped the
protocol, old builds cannot attach to newly installed servers — release
promptly.

Publish:

```bash
patch_stage=$(mktemp -d)
git format-patch --filename-max-length=100 vX.Y.Z -o "$patch_stage"
test "$(find "$patch_stage" -maxdepth 1 -name '00*.patch' | wc -l)" -eq 4
rm ../../patches/herdr/*.patch
cp "$patch_stage"/*.patch ../../patches/herdr/
rm -rf "$patch_stage"
echo vX.Y.Z > ../../patches/herdr/BASE
git rev-parse 'vX.Y.Z^{commit}' > ../../patches/herdr/BASE_COMMIT
cd ../..
test "$(find patches/herdr -maxdepth 1 -name '00*.patch' | wc -l)" -eq 4
tmp=$(mktemp -d)
git -C checkouts/herdr worktree add --detach "$tmp" vX.Y.Z
git -C "$tmp" am "$PWD"/patches/herdr/*.patch
test "$(git -C "$tmp" rev-parse 'HEAD^{tree}')" = \
  "$(git -C checkouts/herdr rev-parse 'HEAD^{tree}')"
git -C checkouts/herdr worktree remove --force "$tmp"
git diff --check
git add patches docs && git commit -m "bump base to vX.Y.Z"
git push origin master
git fetch origin --prune --tags
test -z "$(git status --porcelain)"
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/master)"
tag=vX.Y.Z-win.NN  # NN = 01 for a new upstream version; otherwise increment that version's counter
git tag "$tag"
git push origin "$tag"
gh run watch --exit-status <run-id>
```

Also update the [check log](#when-to-retire) below.

### Rebase/`git am` conflict hotspots

If upstream touched the remote code: upstream changes to `src/remote/unix.rs`
belong in `launcher.rs` (shared logic) or the new `unix.rs` (platform bits);
also watch the blocking named-pipe pump and its `CancelIoEx` shutdown in
`remote/windows.rs`, plus the `#[cfg]` gates this series removed (`checksum`,
`is_package_manager_managed_exe_path`, remote handshake timeout). Upstream
churn in the updater (`src/update.rs`) is the most likely conflict site for
the `FORK_BUILD` gate — verify it survives every bump.

## When to retire

Watch upstream for native Windows `--remote` support:

- upstream changelog / releases mentioning Windows remote attach
- `src/platform/mod.rs` `capabilities()` gaining `remote_attach` on Windows
- the "Not supported on Windows beta" table in
  `website/src/content/docs/windows-beta.mdx` dropping the `herdr --remote` row
- upstream issue tracker for the Windows-beta remote roadmap

**Evidence log** (update on every version bump):

- `v0.7.4` (2026-07-16): still unsupported — `src/` diff vs v0.7.3 is empty
  except the version bump; windows-beta docs still list `herdr --remote` as
  unsupported
- `v0.7.5` (2026-07-22): still unsupported — Windows beta docs still list
  native `herdr --remote` as unsupported. Upstream protocol advanced from 16
  to 17 and matches `https://herdr.dev/latest.json`; the patch stack was
  refreshed onto the release tag, preserving upstream's new mise install path
  discovery and hidden-console curl spawning
- `v0.8.0` (2026-08-03): still unsupported — `platform::capabilities()` keeps
  `remote_attach: cfg!(unix)`, and current/preview Windows docs still call
  native Windows `herdr --remote` unsupported. Protocol 19 matches
  `https://herdr.dev/latest.json`. The stack was refreshed to three patches;
  the former IV-0005 patch retired because upstream now supplies Windows
  system notifications

Once upstream supports it: switch back to official binaries
(`irm https://herdr.dev/install.ps1 | iex`), delete this repo's releases/tags,
and archive or delete this repo. Everything worth keeping is the patch series
and this doc.

## History (fork era)

| Fork tag | Upstream base | Notes |
| --- | --- | --- |
| `fork-v0.7.3-win.1` | `v0.7.3` (`a0678a3`) | initial port |
| `fork-v0.7.4-win.1` | `v0.7.4` (`50aaa2e`) | docs-only upstream release; clean rebase; auto-update path verified live |
| `fork-v0.7.4-win.2` | `v0.7.4` | win32-input-mode paste fix |
| `fork-v0.7.4-win.3` | `v0.7.4` | self-update disabled |
| `fork-v0.7.4-win.4` | `v0.7.4` | host terminal theme / inverse-video fix |
| `fork-v0.7.4-win.5` | `v0.7.4` | `HERDR_REMOTE_TIMING` |
