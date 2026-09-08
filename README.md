# herdr-windows-remote

[![Latest version](https://img.shields.io/github/v/tag/iamwrm/herdr-windows-remote?filter=v%2A-win.%2A&sort=date&label=latest%20version)](https://github.com/iamwrm/herdr-windows-remote/releases)

Patches and tooling on top of [herdrdev/herdr](https://github.com/herdrdev/herdr),
based on stable **v0.9.0**. Upstream now supplies native Windows remote attach;
this repository retains the custom predictive echo, attach diagnostics and
remote-shell `hcode`, and bounded clipboard-image FIFO in the patched server.
The FIFO setting now lives on the server; native image paste also works with stock servers.
See [v0.9.0 verification and migration](docs/UPGRADE-v0.9.0.md).

Windows builds ship as **`herdr-windows-x86_64.zip`** with the pinned app-local
ConPTY runtime. Extract the whole archive and run `herdr.exe`. The same release
includes the Linux `hcode` shim. Patched builds do not self-update; download
updates from this repository's Releases.

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
and paste the resulting `/tmp/herdr-clipboard-images-<uid>/...` path into the active pane.
The former [pi-side cursor adapter](docs/IV-0003-pi-predictive-echo.md) remains
only for older builds.
Native Windows system notifications were retired from this patch stack after
upstream implemented them in v0.8.0.

This repo replaces the retired fork `iamwrm/herdr` (see its issue #1 for the
original fork-era notes; everything durable now lives here).
