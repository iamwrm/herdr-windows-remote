# IV-0005: Native Windows system toast notifications

## Record

- **Status:** implemented in ownership patch `0004`; this representation
  postdates the release, while its identical implementation tree shipped in
  `v0.7.5-win.05`
- **Upstream:** `checkouts/herdr`
  ([ogulcancelik/herdr](https://github.com/ogulcancelik/herdr))
- **Deliverables:** `patches/herdr/0004-*-IV-0005.patch`
- **Implementation base:** `v0.7.5` (`ef4c23f`), stacked on ownership patches
  `0001`–`0003`
- **Dependencies:** [IV-0001](IV-0001-windows-remote.md) supplies the native
  Windows remote client that receives forwarded notifications
- **History:** `v0.7.5-win.02` and `v0.7.5-win.03` used an interim
  `uv` + Python `windows-toasts` helper; `v0.7.5-win.04` replaced it with
  WinRT compiled into `herdr.exe`; `v0.7.5-win.05` adds layered diagnostic UI

## Purpose

With `[ui.toast] delivery = "system"`, herdr asks the OS notification service
to show background workspace events (agent finished / needs attention).
Upstream stubs the Windows implementation
(`src/platform/windows.rs` `show_desktop_notification` returned `Ok(false)`),
so Windows clients silently dropped every system notification — including the
primary fork scenario, `herdr --remote <linux-box>`.

The implementation must remain usable as a portable, non-elevated Windows
binary. It must not require an installer, administrator privileges, Python,
`uv`, package downloads, registry writes, or a helper script.

## How the notification flows (remote attach)

The delivery decision is server-side; the delivery itself is client-side. No
protocol or server change is needed — `NotifyKind::SystemToast` exists in
upstream v0.7.5 (`src/protocol/wire.rs`), and the official Linux server already
forwards it:

```text
Linux server: agent state change
  → reads ITS config: [ui.toast] delivery = "system"
  → ServerMessage::Notify(NotifyKind::SystemToast) to the foreground client
Windows client: client::handle_notify
  → platform::show_desktop_notification
  → current user's Windows Runtime notification service
```

`herdr notification show <title>` from inside a pane follows the same
forwarding path.

**Config requirement:** `delivery = "system"` must be set in the **server's**
config — on the remote Linux box for `--remote` sessions. The local Windows
config's toast setting is irrelevant during a remote session.

## Implemented design (ownership patch `0004`)

`src/platform/windows.rs` uses the native Windows Runtime APIs projected by
the target-specific `windows` Rust dependency:

```text
XmlDocument (ToastGeneric content)
  → ToastNotification::CreateToastNotification
  → ToastNotificationManager::CreateToastNotifierWithId("herdr")
  → ToastNotifier::Show
```

- The XML document is assembled through DOM methods. Title and body are set
  with `XmlElement::SetInnerText`, so notification text remains data and XML
  metacharacters cannot alter the toast structure.
- The title is always the first text element. A missing or empty body is
  omitted, matching the previous helper's visible behavior.
- `CreateToastNotifierWithId("herdr")` submits through the current user's
  notification service. The implementation performs no elevated operation,
  registry write, Start Menu shortcut creation, AUMID registration, package
  installation, or machine-wide configuration.
- The call is local and synchronous. There is no process spawn, interpreter,
  package resolution, first-use download, network access, or cold-cache delay.
- WinRT errors retain the exact failing stage and HRESULT before conversion to
  `std::io::Error` and the existing client notification logging path.
- Each attempt reads both `ToastNotifier.Setting()` and
  `SHQueryUserNotificationState()`. These distinguish application/user/policy
  disablement from shell suppression such as a locked session, presentation
  mode, full-screen activity, or quiet time.
- `windows = 0.62.2` is Windows-target-only and locked in `Cargo.lock`; the
  Linux server and remote protocol are unchanged.

The notifier API accepting a toast does not guarantee that Windows displayed
it. Windows can still suppress notifications after `Show()` returns success;
the diagnostic mode below exposes the relevant state without changing the
remote protocol.

## Layered diagnostic UI

Set the environment variable before launching the Windows binary:

```powershell
$env:HERDR_WINDOWS_TOAST_DEBUG = "1"
.\herdr-windows-x86_64.exe --remote <ssh-target>
```

The mode uses topmost dialogs from the local `herdr.exe` process and is
strictly opt-in:

1. A startup dialog confirms that the thin Windows client inherited the debug
   flag and completed its connection/terminal setup.
2. After dismissing it, trigger a notification in a remote pane:

   ```bash
   herdr notification show "test" --body "hello"
   ```

3. A result dialog confirms that the Windows system-toast backend was invoked.
   For a remote session, this proves the Linux server forwarded
   `NotifyKind::SystemToast` to the Windows client. It then reports:
   - the failing WinRT stage and HRESULT, or `ToastNotifier.Show` success;
   - `ToastNotifier.Setting` (`Enabled`, disabled for application/user/policy,
     or disabled by manifest);
   - the Windows shell state (`AcceptsNotifications`, `UserNotPresent`,
     `Busy`, full-screen, presentation mode, quiet time, or app mode);
   - the exact client log path.

Interpretation:

- startup dialog only, no result dialog → the Linux server did not forward a
  `SystemToast` to this foreground client (check the remote config/delivery
  layer);
- a WinRT stage/HRESULT failure → the result dialog identifies the native API
  layer;
- disabled notifier setting → Windows disabled this notifier;
- shell state other than `AcceptsNotifications` → Windows is suppressing the
  popup at the shell layer;
- setting `Enabled`, shell `AcceptsNotifications`, and `Show` success but no
  popup → portable application identity is the likely remaining layer.

Dialogs intentionally block the client while open. Disable the mode after the
single diagnostic run:

```powershell
Remove-Item Env:HERDR_WINDOWS_TOAST_DEBUG
```

## Requirements and assumptions

- Windows 10 or Windows 11 with notifications enabled for the current user.
- No administrator privileges. The live smoke test ran from a medium-integrity
  token (`S-1-16-8192`).
- No `uv`, Python, `windows-toasts`, external script, or runtime package is
  required.
- The portable build supplies `"herdr"` as the notifier ID but does not
  register a full application identity. Basic toasts work without that setup;
  richer branding and activation would require separate per-user identity
  work.
- The default Windows toast sound may play in addition to herdr's own sound
  notifications if both are enabled server-side.

## Non-goals

- Click activation, buttons, replies, progress updates, custom icons, or a COM
  activator.
- MSIX packaging, an installer, machine-wide registration, or any privileged
  setup.
- A fallback helper process if WinRT rejects a notification.
- A client-to-server acknowledgement proving that Windows rendered the toast.

## Evidence and reproduction

Completed on Windows with Rust 1.96.1 and Zig 0.15.2:

- `cargo clippy --locked --bin herdr -- -D warnings` — clean;
- `cargo test --locked --bin herdr windows_` — 133 passed, 1 intentionally
  ignored live-toast test;
- `cargo test --locked --bin herdr client::` — 174 passed;
- `cargo test --locked --bin herdr config::` — 128 passed;
- `cargo test --locked --bin herdr remote::` — 78 passed;
- `cargo test --locked --bin herdr server::client_transport::tests` — 21
  passed;
- `cargo test --locked --bin herdr protocol::wire::tests` — 51 passed;
- fork self-update and default-config filters — 3 passed;
- release-equivalent `cargo build --release --locked --target
  x86_64-pc-windows-msvc` — clean;
- DOM tests verify exact title/body round trips including `<`, `>`, and `&`,
  and verify omission of absent/empty bodies;
- explicit ignored-test run with `HERDR_WINDOWS_TOAST_DEBUG=1` submitted a
  real toast from a non-elevated, medium-integrity process and displayed the
  diagnostic UI; it reported notifier setting `Enabled`, shell state
  `UserNotPresent`, and successful `Show()`, correctly locating suppression in
  the locked/unavailable Windows shell session;
- the release binary contains none of the old `windows-toasts`, `uv run`, or
  embedded Python-helper strings;
- clean-room patch application reproduces the implementation tree exactly.

Live remote reproduction: set `delivery = "system"` in the Linux target's
herdr config, attach with `herdr --remote <target>`, then run
`herdr notification show "test" --body "hello"` inside a remote pane or let a
background agent finish.

## Handoff

- Keep notification content in DOM text nodes; never concatenate title/body
  into XML source.
- Keep the `windows` dependency target-specific so Linux builds do not acquire
  a Windows runtime dependency.
- Do not add registration or installation as an implicit side effect of
  showing a toast. Any future identity setup must remain explicit and
  per-user.
- Keep `HERDR_WINDOWS_TOAST_DEBUG` opt-in and client-local. Do not add a new
  protocol message: remote sessions must remain compatible with official Linux
  servers.
- The Windows test that launches PowerShell shares the integration environment
  lock because integration tests temporarily replace process-global `PATH`;
  retain that serialization so the `windows_` filter remains parallel-safe.
- Upstream churn in `src/platform/windows.rs` around the former stub is the
  conflict site on version bumps.
- Retire this patch if upstream implements Windows
  `show_desktop_notification` natively.
