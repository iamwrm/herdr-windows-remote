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
test "$(git rev-parse HEAD)" = "$(cat ../../patches/herdr/BASE_COMMIT)"
git am ../../patches/herdr/*.patch
```

`checkouts/` is in `.gitignore` — delete and re-clone freely.

`patches/herdr/BASE` pins the upstream **release tag** the patch series is
based on, while `patches/herdr/BASE_COMMIT` pins that tag's peeled commit so a
moved upstream tag cannot silently change a release build. The release workflow
verifies both; keep them in sync with the patches.

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
> Full runbook: [IV-0001](IV-0001-windows-remote.md#upstream-version-bump-runbook).

```bash
cd checkouts/herdr
git fetch origin --tags
git checkout vX.Y.Z
git am ../../patches/herdr/*.patch   # fix conflicts, re-export patches
```

Then update `patches/herdr/BASE` and `patches/herdr/BASE_COMMIT` and commit the
refreshed patches.

## Releases

`.github/workflows/release-windows.yml` clones upstream at `BASE`, verifies the
peeled tag against `BASE_COMMIT`, applies the patch series with `git am`, and
builds `x86_64-pc-windows-msvc` with upstream's
pinned steps, and publishes a prerelease with `herdr-windows-x86_64.exe`, the
Linux `hcode` shim, and `BUILD_INFO.html` (repo/upstream/patched commits and
artifact SHA-256 checksums).

- **Trigger by tag:** `git tag vX.Y.Z-win.NN && git push origin <tag>` →
  release under that tag. The `vX.Y.Z` part must match `patches/herdr/BASE`,
  and `NN` is a per-upstream-version two-digit counter starting at `01` (the
  workflow enforces the tag shape and base).
- **Trigger manually:** `gh workflow run release-windows.yml` → rolling
  `windows-remote-latest` prerelease.

## Initiative docs

Use the [IV/DC workspace doctrine](IV-DC.md). Every initiative gets a root IV
in `docs/`, following
[`docs/IV-0001-windows-remote.md`](IV-0001-windows-remote.md):

- **Naming:** `docs/IV-NNNN-short-slug.md` — a sequential four-digit
  initiative number plus a short kebab-case slug.
- **Header:** title `# IV-NNNN: <purpose in one line>`, followed by a
  `## Record` section with status, upstreams, deliverables, implementation
  base, and annotated dependency or consumer links.
- **Body:** preserve the facts needed to understand and maintain the work:
  purpose, requirements and assumptions, integration points, decisions,
  implementation locations, known consumers, explicit non-goals, evidence
  with reproduction methods, handoff constraints, deferred work, and
  retirement criteria where applicable.
- **Links:** use annotated links to route attention between related IVs, code,
  evidence, and replacement work. Split child documents only when a root IV
  no longer fits one coherent working context, and link every child back to
  its root.

The root IV is the durable lifecycle narrative that explains why its patches
and other repository artifacts exist. Keep it consistent as they evolve.

## Conventions

- One directory per upstream under `patches/` (`patches/herdr/`).
- One root IV per initiative under `docs/` (`IV-NNNN-short-slug.md`), as
  described above.
- Number patches (`0001-...`, `0002-...`) so apply order is explicit.
- If a patch stops applying cleanly, fix it and commit the updated patch —
  the patch files are the source of truth, not the checkouts.
- Patch files are format-patch mailboxes, whose context and `-- ` footer
  contain intentional trailing spaces. `.gitattributes` excludes only those
  artifacts from whitespace checks; validate their applied source separately.
