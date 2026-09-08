/**
 * How the Short's hook is broken into lines and sized.
 *
 * A CSS-free leaf module so Node tests can import it (see layout.ts).
 */
import { SHORT_WIDTH } from "./layout.js";

/**
 * The widest a hook line's *glyphs* may run. The .short-hook box is inset 24px each side, and
 * the eight-way outline plus the crimson drop reach a further ~22px past the last glyph — budget
 * for the ink, not the box, or a full-width line puts its shadow on the frame edge.
 */
const HOOK_LINE_WIDTH = SHORT_WIDTH - 2 * (24 + 22);
/** Monocraft's 0.662em advance (measured for the thumbnail) plus the 0.02em letter-spacing. */
const HOOK_ADVANCE_EM = 0.682;
/**
 * Font-size steps, largest first. 96 is the floor for anything the title budget normally
 * produces: below that the hook stops reading at 270px wide, which is the size the Shorts feed
 * shows it at, and a hook nobody can read in the feed is not a hook.
 */
const HOOK_SIZES = [120, 108, 96];

const charBudget = (fontSize: number): number => Math.floor(HOOK_LINE_WIDTH / (fontSize * HOOK_ADVANCE_EM));

/** The two-line split with the smallest longest line; a greedy wrap orphans the last word. */
function balancedPair(words: string[]): string[] {
  let best = { longest: Infinity, lines: [words.join(" ")] };
  for (let i = 1; i < words.length; i++) {
    const lines = [words.slice(0, i).join(" "), words.slice(i).join(" ")];
    const longest = Math.max(lines[0]!.length, lines[1]!.length);
    if (longest < best.longest) best = { longest, lines };
  }
  return best.lines;
}

/**
 * Lines and font size for one hook: the largest step at which it fits on one line, else on two.
 *
 * A step function in JS rather than a CSS `clamp`, for the same reason the thumbnail's is: the
 * board renders once at a fixed 1080x1920, so a size that depends on the viewport is not
 * reproducible from the props alone, and two renders of the same hook must give the same image.
 *
 * Never a third line. The hook straddles the seam between the top pane and the lower nameplate,
 * so a third line would bury a player's name outright; a hook too long even at the floor is
 * shrunk to exactly what two lines hold instead. Only hooks near the 47-character title cap
 * reach that, and the alternative — clipping one at the frame edge — is worse than small type.
 */
export function layoutShortHook(text: string): { lines: string[]; fontSize: number } {
  const words = text.trim().split(/\s+/);
  const single = words.join(" ");
  const pair = words.length > 1 ? balancedPair(words) : [single];
  const longest = Math.max(...pair.map((l) => l.length));

  for (const fontSize of HOOK_SIZES) {
    if (single.length <= charBudget(fontSize)) return { lines: [single], fontSize };
    if (words.length > 1 && longest <= charBudget(fontSize)) return { lines: pair, fontSize };
  }
  return { lines: pair, fontSize: Math.floor(HOOK_LINE_WIDTH / (longest * HOOK_ADVANCE_EM)) };
}
