# herdr-windows-remote

Patches and tooling on top of [ogulcancelik/herdr](https://github.com/ogulcancelik/herdr)
for exactly one feature: **`herdr --remote <ssh-target>` from the native Windows
binary**, which upstream ships as unsupported in the Windows beta. Retire this
repo as soon as upstream supports it natively.

Download builds from this repo's **Releases** (`herdr-windows-x86_64.exe`).
Fork builds do not self-update — update by downloading from Releases.

See [docs/repo.md](docs/repo.md) for the repo layout and workflow
(plain clones in `checkouts/`, durable patches in `patches/` — no forks, no
submodules), and [docs/i0001_windows-remote.md](docs/i0001_windows-remote.md)
for the port itself: design, patch series, version-bump runbook, and
retirement criteria.

This repo replaces the retired fork `iamwrm/herdr` (see its issue #1 for the
original fork-era notes; everything durable now lives here).
