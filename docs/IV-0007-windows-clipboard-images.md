# IV-0007: Copy Windows clipboard images into remote Linux panes

## Record

- **Status:** implemented in ownership patch `0005` of the current `v0.8.0`
  representation
- **Upstream:** `checkouts/herdr`
  ([herdrdev/herdr](https://github.com/herdrdev/herdr))
- **Deliverable:** `patches/herdr/0005-*-IV-0007.patch`
- **Implementation base:** `v0.8.0` (`346411fa`), stacked after ownership
  patches `0001`–`0004`
- **Dependency:** [IV-0001](IV-0001-windows-remote.md) supplies the native
  Windows SSH/named-pipe bridge; the upstream v19 protocol already supplies
  `ClientMessage::ClipboardImage`

## Purpose

While using the native Windows client with `herdr --remote <linux-host>`, make
an image in the Windows clipboard behave like an image paste:

1. press the configured `keys.remote_image_paste` binding (default `ctrl+v`),
   or receive an empty host paste event;
2. normalize the clipboard image to PNG;
3. store it on Linux as
   `/tmp/herdr-<unix-username>/clipboard-<random>.png`;
4. paste that absolute path into the active remote pane.

Files form a FIFO shared by every Herdr client for the same Unix account. The
aggregate default budget is 64 MiB; configure it locally before launching the
remote session:

```toml
[remote]
clipboard_image_buffer_mb = 64
```

The value must be between 1 and 1,048,576 MiB. A single image remains bounded
by upstream's 16 MiB `MAX_CLIPBOARD_IMAGE_PAYLOAD` and by the configured FIFO
capacity.

## Design

### Windows clipboard capture

The Windows platform layer tries formats in fidelity order:

1. the registered `PNG` clipboard format (bytes preserved);
2. `CF_DIBV5`;
3. `CF_DIB`.

Packed 24-bit BI_RGB and 32-bit BI_RGB/BI_BITFIELDS DIBs are decoded with
bottom-up/top-down row handling, stride validation, color masks, and the common
all-zero reserved-alpha correction, then encoded as RGBA PNG. Parsing is kept
platform-neutral so Linux CI can exercise synthetic DIB fixtures.

The Windows console input batch is split at the image-paste trigger. Events
before and after it retain their order; the configured key press/release is
consumed only when an image was actually read. If the clipboard has no image,
the original key batch continues unchanged, preserving ordinary text paste.

### Linux store without a patched server

The official Linux v0.8.0 server already understands `ClipboardImage`, but its
staging directory and lifetime do not implement this initiative's per-user
FIFO. Shipping a forked Linux server solely for storage policy would also make
remote install/version management substantially heavier.

Instead, the Windows SSH bridge inspects complete length-prefixed client
frames. Ordinary frames are forwarded byte-for-byte. For the rare
`ClipboardImage` frame it lazily opens a persistent second `ssh -T` channel to
an embedded POSIX-sh helper, streams the length-delimited bytes, receives the
new path, and rewrites only that frame as a normal structured `Paste` event.
This keeps the keystroke hot path free of deserialization and additional SSH
traffic.

If the side channel cannot start or disappears, the original image frame is
forwarded to upstream's server staging path and the fallback is reported on
stderr. A policy rejection from a running helper is not bypassed.

### FIFO and filesystem rules

The helper runs as the SSH account and derives the directory from `id -un`.
It:

- accepts only conventional Linux username characters and the known image
  extensions;
- rejects a symlinked, non-directory, or differently owned staging path;
- enforces directory mode `0700` and file mode `0600`;
- creates collision-resistant files with `mktemp`;
- serializes the shared scan/delete transaction with `flock`;
- computes total bytes across `clipboard-*` files and removes oldest files
  first, never evicting the image currently being committed;
- returns only a fixed protocol response. The Windows side separately checks
  that the returned path is exactly under `/tmp/herdr-<safe-user>/` before
  pasting it.

Files intentionally survive client disconnects. The per-user FIFO, rather
than a connection lifetime, owns their retention.

## Non-goals

- Copying images from Linux back to the Windows clipboard.
- Patching or replacing the official Linux Herdr server.
- General-purpose file transfer or arbitrary remote command execution.
- Decoding every legacy Windows bitmap compression/palette format; modern PNG,
  DIBV5, 24-bit DIB, and 32-bit DIB clipboard producers are covered.
- Changing the wire protocol or its 16 MiB single-image ceiling.

## Evidence and reproduction

Patch and source checks:

```sh
sh -n checkouts/herdr/src/remote/linux_clipboard_image_store.sh
git -C checkouts/herdr diff --check
```

The helper FIFO smoke test streams two five-byte images through one process
with an eight-byte capacity and verifies that only the second file remains.
The automated suite additionally covers:

- bottom-up padded 24-bit DIB, top-down DIBV5 bitfields/alpha, zero-alpha
  BI_RGB, and invalid compression;
- Windows trigger detection, empty-paste detection, and event-batch ordering;
- raw-frame preservation, image-to-paste rewriting, unavailable-store
  fallback, and strict returned-path validation;
- default/override/invalid FIFO configuration.

CI applies all ownership patches to a clean pinned upstream tree, runs Linux
format/clippy/focused tests plus the helper smoke test, then runs Windows
clippy, focused tests, and the release-equivalent MSVC build.

## Handoff

- Preserve byte-for-byte forwarding for every non-image client frame; this is
  part of IV-0002's input-latency contract.
- Keep the helper lazy. Windows OpenSSH lacks ControlMaster, so opening the
  second connection at attach time would add an unnecessary authentication
  hop for users who never paste an image.
- Keep the remote path derived from the authenticated Unix account, never from
  clipboard data or the SSH target string.
- Keep FIFO enforcement cross-client and locked. Per-process accounting is not
  sufficient for the per-user budget.
