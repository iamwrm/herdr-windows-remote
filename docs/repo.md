# Repo layout & workflow

This repo tracks work against upstream projects **without** forks or submodules.

## Upstreams

- https://github.com/ogulcancelik/herdr

## Layout

```
checkouts/     # plain git clones of upstreams (gitignored, disposable)
patches/       # durable artifacts: patch files against upstreams (checked in)
docs/          # documentation
.github/       # release workflow (build upstream + patches into a Windows binary)
```

## Why not forks or submodules?

- Forks add a remote-management burden and drift from upstream.
- Submodules pin SHAs, are easy to break, and are painful for everyone.
- Plain clones in `checkouts/` are disposable; the durable objects are the
  patch files in `patches/`, which are small, reviewable, and rebased easily.

This repo replaces the earlier fork `iamwrm/herdr` for exactly these reasons.

## Setup

```bash
mkdir -p checkouts
git clone https://github.com/ogulcancelik/herdr checkouts/herdr
cd checkouts/herdr
git checkout "$(cat ../../patches/herdr/BASE)"   # pinned upstream release tag
git am ../../patches/herdr/*.patch
```

`checkouts/` is in `.gitignore` — delete and re-clone freely.

`patches/herdr/BASE` pins the upstream **release tag** the patch series is
based on. The release workflow reads it; keep it in sync with the patches.

## Working on a change

1. Hack inside `checkouts/herdr/` on a branch or dirty tree.
2. Export the change as a patch into `patches/herdr/`:

   ```bash
   cd checkouts/herdr
   git format-patch "$(cat ../../patches/herdr/BASE)" -o ../../patches/herdr/
   ```

3. Commit the patch in this repo.

## Refreshing against upstream

> **Rebase onto the upstream release tag, not `master`.** Master is usually
> ahead of the release; building from master can embed a version/protocol that
> is not in `https://herdr.dev/latest.json` yet, breaking remote auto-install.
> Full runbook: [i0001](i0001_windows-remote.md#upstream-version-bump-runbook).

```bash
cd checkouts/herdr
git fetch origin --tags
git checkout vX.Y.Z
git am ../../patches/herdr/*.patch   # fix conflicts, re-export patches
```

Then update `patches/herdr/BASE` and commit the refreshed patches.

## Releases

`.github/workflows/release-windows.yml` clones upstream at `BASE`, applies the
patch series with `git am`, builds `x86_64-pc-windows-msvc` with upstream's
pinned steps, and publishes a prerelease with `herdr-windows-x86_64.exe` +
`BUILD_INFO.txt` (repo commit, upstream base, patched tree sha256).

- **Trigger by tag:** `git tag vX.Y.Z-win.<n> && git push origin <tag>` →
  release under that tag. The `vX.Y.Z` part must match `patches/herdr/BASE`
  (the workflow enforces this).
- **Trigger manually:** `gh workflow run release-windows.yml` → rolling
  `windows-remote-latest` prerelease.

## Initiative docs

Every initiative gets its own doc in `docs/`, following the pattern of
[`docs/i0001_windows-remote.md`](i0001_windows-remote.md):

- **Naming:** `docs/iNNNN_short-slug.md` — a sequential initiative number
  (`i0001`, `i0002`, …) plus a short descriptive slug.
- **Header:** title `# iNNNN: <goal in one line>`, then status, the upstream
  checkouts involved, the deliverable (usually a patch series under
  `patches/<project>/`), and the implementation branch/base commit.
- **Body:** goal, reference material (how upstream already solves it),
  integration points found during exploration, the implemented patch series
  (one section per numbered patch), a files-affected summary table,
  explicit non-goals, verification performed, handoff notes
  (requirements to preserve, gotchas, maintenance state), and
  decisions/deferred work.

The initiative doc is the durable narrative that ties the numbered patches
together — keep it updated as the patch series evolves.

## Conventions

- One directory per upstream under `patches/` (`patches/herdr/`).
- One doc per initiative under `docs/` (`iNNNN_slug.md`), as described above.
- Number patches (`0001-...`, `0002-...`) so apply order is explicit.
- If a patch stops applying cleanly, fix it and commit the updated patch —
  the patch files are the source of truth, not the checkouts.
