# i0003: Predictive echo inside pi's input prompt

**Status:** PoC implemented and deployed to deb1; escape-level verification
done, live typing test pending
**Upstream:** [earendil-works/pi](https://github.com/earendil-works/pi)
(pi-tui) — no herdr changes, no pi-core changes
**Deliverable:** [`extras/pi-extensions/predictive-echo-cursor.ts`](../extras/pi-extensions/predictive-echo-cursor.ts)
(a pi extension installed on the machine that runs pi, i.e. the herdr
*server*)
**Depends on:** i0002 W3 (herdr client predictive echo, patches 0010/0011)

## Goal

herdr's predictive echo works in vim but not in pi's input prompt. Make
typing into pi over a 200 ms link feel local, without weakening the
predictor's safety gates.

## Root cause

The predictor (i0002 patch 0011) refuses to predict unless the **hardware
cursor is visible** and the **target cell is unstyled**. pi fails both by
design: pi-tui hides the hardware cursor and draws its caret as an
inverse-video cell (`ESC[7m<char>ESC[0m`,
`pi-tui/dist/components/editor.js`). The gates are correct — pi's rendering
is just opaque to them.

## Options considered

| | Approach | Verdict |
|---|---|---|
| A | herdr client heuristic: treat a reversed cell as a drawn cursor and predict by shifting the block | Rejected: cannot distinguish the caret from selections/status cells, and the server's *moving* block breaks typeahead — the block repainted at x+1 (reversed `" "`) arrives before the echo of the second typed char, which the reconciler correctly flags as a misprediction → flush storm |
| B | **pi extension** that makes pi's rendering prediction-friendly | **Chosen** (this initiative) |
| C | Upstream pi change: `showHardwareCursor` also suppresses the software caret | The long-term home; B is the PoC of C (see [Upstream path](#upstream-path)) |
| D | Local echo inside pi | Impossible: pi runs on the far side of the RTT; only the thin client can beat it |

## Design

Two pi-tui facts make this a ~15-line extension:

1. **pi already positions the hardware cursor at the caret on every
   render** — the editor emits a zero-width APC marker
   (`CURSOR_MARKER = ESC _ pi:c BEL`, `pi-tui/dist/tui.js`), which the TUI
   extracts, strips, and uses to move the real cursor (built for IME
   candidate placement). Visibility is a separate flag
   (`tui.showHardwareCursor`, settings `showHardwareCursor` /
   `PI_HARDWARE_CURSOR=1`), false by default.
2. Extensions can replace the editor component
   (`ctx.ui.setEditorComponent`), and the factory receives the live `tui`
   instance.

The extension therefore:

- sets `tui.showHardwareCursor = true` → real cursor visible at the caret
  → predictor gate 1 passes;
- subclasses `CustomEditor` and, in `render()`, strips the inverse-video
  wrapper that immediately follows the cursor marker
  (`/(\x1b_pi:c\x07)\x1b\[7m([\s\S]*?)\x1b\[0m/` → `$1$2`), keeping the
  marker (positioning intact) and the grapheme/space (line width intact)
  → caret cell unstyled → predictor gate 2 passes.

Typeahead works precisely because the block is *gone*: the server's echo
then touches only the typed cell, so still-pending predictions to its
right are never falsely invalidated.

Side benefit independent of herdr: fixes pi's double-cursor when users
enable `showHardwareCursor` manually (hardware cursor + software block at
the same cell today).

## PoC verification

- Transform unit-checked in node: marker preserved, block stripped,
  cursor-on-char and cursor-at-end-of-line cases width-preserving,
  non-caret lines untouched.
- Deployed to deb1 (`~/.pi/agent/extensions/predictive-echo-cursor.ts`,
  pi 0.80.10 via pnpm). pi starts with the extension listed and no errors.
- Escape-level check over a pty: with the extension active and text in the
  editor, pi's output contains `ESC[?25h` (cursor shown) and **zero**
  `ESC[7m` sequences — both predictor gates confirmed passable.
- Pending: live typing test through `herdr --remote deb1` at 200 ms netem
  (record in the i0002 check log).

## Install

Copy `extras/pi-extensions/predictive-echo-cursor.ts` to
`~/.pi/agent/extensions/` on every host you attach to with
`herdr --remote`, then `/reload` or restart pi. Remove the file to restore
pi's stock block caret.

## Known caveats

- First char into an empty editor may not predict: the dim placeholder
  text is a styled cell. Subsequent chars predict.
- The caret look changes from pi's block to the host terminal's real
  cursor (shape/blink follow the terminal).
- Completion accept / line rewrap rewrite cells under pending predictions
  → one self-healing repaint (≤1 RTT), by design of i0002 W3.
- The extension unconditionally forces the hardware cursor visible; users
  who want pi's stock look should not install it (per-host opt-in by
  file placement).

## Upstream path

Offer pi a PR implementing option C: when `showHardwareCursor` is enabled,
skip drawing the software caret in `pi-tui` editor/input components (the
hardware cursor is already positioned correctly; drawing both is
redundant). Once upstream ships that, this extension reduces to
`showHardwareCursor: true` in settings and this initiative retires —
same pattern as i0001's [When to retire](i0001_windows-remote.md#when-to-retire).

**Check log:**

- 2026-07-19: PoC built and deployed against pi 0.80.10; escape-level
  verification green; live 200 ms typing test pending.
