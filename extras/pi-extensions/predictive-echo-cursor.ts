/**
 * predictive-echo-cursor — make pi's input prompt compatible with
 * client-side predictive echo (herdr --remote, mosh, and friends).
 *
 * Why: pi normally hides the hardware terminal cursor and draws its own
 * caret as an inverse-video cell (`ESC[7m<char>ESC[0m`). Remote thin
 * clients that implement predictive local echo (herdr IV-0002 W3) refuse to
 * predict when the hardware cursor is hidden or the target cell is styled,
 * so typing into pi over a high-RTT link feels like the full round trip.
 *
 * What this does:
 *  1. Forces the TUI's hardware cursor visible (`tui.showHardwareCursor`).
 *     pi already positions it at the caret on every render (it uses the
 *     zero-width `ESC _ pi:c BEL` marker for IME candidate placement).
 *  2. Wraps the editor and strips the inverse-video caret cell from the
 *     rendered lines, keeping the marker and the character itself. The
 *     real terminal cursor becomes the visible caret, and the cell under
 *     it stays unstyled.
 *
 * Result: a predictive-echo client sees a visible cursor over plain cells
 * and can echo keystrokes locally; the underline confirmation flow works
 * exactly like in vim.
 *
 * Install: copy to ~/.pi/agent/extensions/ on the machine that runs pi
 * (the ssh/herdr *server*), then /reload or restart pi.
 */
import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * The editor renders the caret as CURSOR_MARKER (`\x1b_pi:c\x07`, zero
 * width) immediately followed by the caret cell wrapped in inverse video:
 * `\x1b[7m<grapheme>\x1b[0m` on a character, `\x1b[7m \x1b[0m` at end of
 * line. Strip the wrapper, keep the marker and the grapheme (or space, so
 * line width is preserved).
 */
const SOFTWARE_CURSOR = /(\x1b_pi:c\x07)\x1b\[7m([\s\S]*?)\x1b\[0m/;

class HardwareCursorEditor extends CustomEditor {
  override render(width: number): string[] {
    return super.render(width).map((line) => line.replace(SOFTWARE_CURSOR, "$1$2"));
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      // The real terminal cursor is the caret now; make it visible.
      (tui as { showHardwareCursor?: boolean }).showHardwareCursor = true;
      return new HardwareCursorEditor(tui, theme, keybindings);
    });
  });
}
