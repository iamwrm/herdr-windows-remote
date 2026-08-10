# IV-0006: Predictive echo for software-cursor terminal agents

## Record

- **Status:** implemented; first published in `v0.8.0-win.02`
- **Upstreams:** `checkouts/herdr`
  ([herdrdev/herdr](https://github.com/herdrdev/herdr)) and read-only behavior
  reference [PrimeIntellect-ai/prime-agent](https://github.com/PrimeIntellect-ai/prime-agent)
  at `a18809e0`
- **Deliverable:** ownership patch
  `patches/herdr/0004-*-IV-0006.patch`
- **Implementation base:** upstream herdr `v0.8.0` (`346411fa`), stacked after
  [IV-0002](IV-0002-latency-improvements.md)'s predictive-echo implementation
- **Supersedes for current builds:** [IV-0003](IV-0003-pi-predictive-echo.md)'s
  pi-side cursor adapter; that extension remains only for older herdr releases

## Purpose

Make herdr's client-side predictive echo work automatically in terminal agents
that hide the hardware cursor and paint a reverse-video software caret. Prime
Agent uses this rendering model in its normal daemon-backed client, so the
original IV-0002 safety gate rejected its prompt and every character incurred a
full network round trip.

The compatibility belongs in herdr: Prime Agent needs no source patch,
extension, setting, or native-terminal mode. This also handles stock pi's
software caret and removes the current-build requirement for the IV-0003 pi
extension.

## Root cause and constraints

Prime Agent's TUI defaults to fullscreen alternate-screen rendering, but the
alternate screen is not the blocker. Herdr already receives the active screen
and authoritative cursor coordinates. The blocker is the cursor presentation:

- Prime Agent leaves the terminal hardware cursor hidden;
- its editor draws the caret by adding reverse video to one cell over the
  editor's colored background;
- IV-0002 originally required a visible hardware cursor and two plain cells.

A Prime Agent extension is not a reliable integration point. In normal daemon
mode its extension binding implements `setEditorComponent` as a no-op, so an
editor replacement cannot change the client-side cursor renderer. Patching
Prime Agent would also put transport latency behavior in the wrong upstream.

The herdr wire protocol must remain unchanged. The official Linux server still
supplies ordinary semantic frames; detection and prediction remain entirely in
the local terminal-ansi client.

## Design

### Style-aware screen model

`src/client/screen_model.rs` now retains the canonical SGR emitted by
`BlitEncoder` and a prediction-safe style interpretation. Safe styles contain
colors plus either no modifier or reverse video alone. Bold, underline, other
modifiers, hyperlinks, wide-cell continuations, malformed SGR, and
unrepresentable output remain ineligible.

Styles use shared `Arc<str>` values so a colored full-screen frame does not
allocate duplicate SGR strings for every cell. The model can repaint server
truth with the original colors instead of forcing default colors.

### Strict software-caret recognition

A new prediction chain may use a hidden cursor only when:

1. the authoritative cursor cell is reverse-video-only;
2. its right neighbor is non-reversed and prediction-safe;
3. both cells have exactly the same base foreground/background style;
4. the existing width, row, margin, capacity, and input-kind gates pass.

Multiple adjacent reverse cells and reverse combined with any other modifier
are rejected. A single reverse selection cell is visually indistinguishable
from a software caret if an application also reports its hidden logical cursor
there; mismatch reconciliation and the runtime kill switch remain the final
safety net.

### Prediction and reconciliation

For a recognized software cursor, herdr:

- draws typed cells immediately with underline over the editor's base colors;
- moves a local reverse-video caret after the predicted suffix while keeping
  the hardware cursor hidden;
- treats the server's reverse cell at the first pending position as a moving
  caret, not as a character mismatch;
- redraws the outstanding suffix after partial acknowledgements;
- handles cursor-progress acknowledgement for an unchanged space;
- restores exact server symbols and colors on mismatch, timeout, backspace,
  resize, or unsafe input.

The prior visible-hardware-cursor path is unchanged.

## Files affected

| Repo | File | Ownership |
|---|---|---|
| herdr | `src/client/screen_model.rs` | safe color/reverse style model and exact repaint SGR |
| herdr | `src/client/predict.rs` | software-caret detection, local caret rendering, reconciliation, regressions |
| this repo | `patches/herdr/0004-*-IV-0006.patch` | durable implementation patch |
| this repo | `docs/IV-0006-software-cursor-predictive-echo.md` | lifecycle and evidence record |

## Non-goals

- No Prime Agent or pi source patch.
- No Prime Agent or pi extension requirement.
- No wire-protocol or remote-server change.
- No prediction over arbitrary styled selections, hyperlinks, wide cells, or
  modifier combinations.
- No attempt to predict completion acceptance, line reflow, or other
  application rewrites; the existing self-healing flush behavior applies.

## Evidence and reproduction

The regression harness drives semantic `FrameData` through the real
`BlitEncoder`, then feeds the resulting `TerminalFrame` bytes into the real
screen model and predictor. Its Prime-shaped fixture uses a hidden hardware
cursor, reverse-video caret, and indexed-color editor background.

From an applied checkout on Windows (Zig 0.15.2 available via `ZIG=`):

```bash
cargo test --locked --bin herdr client::predict::tests -- --nocapture
cargo test --locked --bin herdr client::screen_model::tests -- --nocapture
cargo test --locked --bin herdr client:: -- --nocapture
cargo clippy --locked --bin herdr -- -D warnings
```

Landing results:

- predictor: 32 passed, including one-at-a-time `a`/`ab`/`abc`
  acknowledgements, coalesced `abc def`, unchanged-space cleanup, colored
  mismatch restoration, and false-positive guards;
- screen model: 17 passed, including RGB foreground plus indexed background
  round-trip through the real encoder;
- complete client filter: 193 passed;
- production Clippy: clean with `-D warnings`;
- the complete four-patch series applies to a fresh detached `v0.8.0`
  worktree and reproduces the implementation tree exactly.

The disposable Prime Agent checkout remained unmodified. A live installed
Prime Agent PTY capture was not required for the implementation proof; its
checked-in renderer and daemon extension binding established the frame shape,
and the regression fixture exercises that shape through herdr's production
encoder/parser boundary.

## Configuration and handoff

No new configuration exists. The existing IV-0002 control remains authoritative:

```text
remote.predictive_echo = "off" | "auto" | "always"
HERDR_PREDICTIVE_ECHO=off|auto|always
```

`auto` remains the default. Use `always` for deterministic manual latency
checks and `off` as the immediate runtime kill switch.

When rebasing, inspect changes to `render_ansi::build_sgr`, modifier bit
assignments, and Prime Agent's cursor renderer. The parser intentionally accepts
only the canonical complete SGR vocabulary emitted by herdr's own
`BlitEncoder`.

## Retirement criteria

Retire this initiative's compatibility branch when IV-0002 predictive echo is
retired, or when herdr upstream provides equivalent safe software-cursor
prediction. Prime Agent changing to a visible native cursor alone is not enough
to delete the support because stock pi and other TUIs consume the same behavior.

## Evidence log

- 2026-08-10: Prime Agent renderer and daemon extension path inspected;
  herdr-only prototype passed 32 predictor tests, 17 screen-model tests, the
  193-test client filter, and production Clippy. Ownership exported as patch
  `0004` for `v0.8.0-win.02`.
