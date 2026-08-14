# herdr-windows-remote

[![Latest version](https://img.shields.io/github/v/tag/iamwrm/herdr-windows-remote?filter=v%2A-win.%2A&sort=date&label=latest%20version)](https://github.com/iamwrm/herdr-windows-remote/releases)

Patches and tooling on top of [herdrdev/herdr](https://github.com/herdrdev/herdr)
centered on **`herdr --remote <ssh-target>` from the native Windows binary**,
which upstream ships as unsupported in the Windows beta, plus client-side
quality-of-life improvements for that workflow. Retire this repo as soon as
upstream supports the required Windows remote functionality natively.

Download builds from this repo's **Releases** (`herdr-windows-x86_64.exe`).
The same release includes the Linux `hcode` shim for opening local VS Code
Remote-SSH. Fork builds do not self-update — update by downloading from Releases.

See [docs/repo.md](docs/repo.md) for the repo layout and workflow
(plain clones in `checkouts/`, durable patches in `patches/` — no forks, no
submodules), and
[IV-0001](docs/IV-0001-windows-remote.md) for the port itself: design, patch
series, version-bump runbook, and retirement criteria. Additional initiatives
cover [remote latency/predictive echo](docs/IV-0002-latency-improvements.md),
[automatic software-cursor compatibility for Prime Agent and pi](docs/IV-0006-software-cursor-predictive-echo.md),
and [`hcode .` → local VS Code Remote-SSH](docs/IV-0004-vscode-remote-open.md).
The Windows remote client can also
[copy clipboard images into a bounded per-user Linux FIFO](docs/IV-0007-windows-clipboard-images.md)
and paste the resulting `/tmp/herdr-<user>/...` path into the active pane.
The former [pi-side cursor adapter](docs/IV-0003-pi-predictive-echo.md) remains
only for older builds.
Native Windows system notifications were retired from this patch stack after
upstream implemented them in v0.8.0.

This repo replaces the retired fork `iamwrm/herdr` (see its issue #1 for the
original fork-era notes; everything durable now lives here).
