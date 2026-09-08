/**
 * What a Twitch chat-replay panel shows at a given second, and in what colour.
 *
 * Its own module, not part of ChatPanel.tsx, for the same reason shortHookLayout.ts and
 * resolveSplitSide.ts are: ChatPanel.tsx does `import "./overlay.css"`, which only webpack
 * resolves, so anything a Node test needs to call has to live outside it.
 *
 * Everything here is measured in *characters*, not pixels. Monocraft is monospaced, so a line's
 * width is its length times one advance — which means the wrap the panel renders can be computed
 * without a browser, and the line count the panel is capped at is exact rather than a guess.
 */
import type { ChatMessage } from "../src/twitchChat.js";

/** Monocraft's advance, in em. Measured for the thumbnail; shortHookLayout.ts uses the same. */
const ADVANCE_EM = 0.662;

export const CHAT_FONT_SIZE = 18;
export const CHAT_LINE_HEIGHT = 22;
/** The nickname header, which is not part of the message area. */
export const CHAT_HEADER_HEIGHT = 30;
export const CHAT_PAD = 14;
/**
 * How far a wrapped continuation line is indented under its message. Without it a 4-line message
 * and four one-line messages look identical, which is the one thing a chat panel has to make
 * obvious. Charged to the character budget so the indent can never push a line off the panel.
 */
export const CHAT_HANGING_INDENT = 12;

/** How many characters fit on one line of the message area at this panel width. */
export function chatCharsPerLine(widthPx: number, fontSize: number = CHAT_FONT_SIZE): number {
  const usable = widthPx - 2 * CHAT_PAD - CHAT_HANGING_INDENT;
  return Math.max(8, Math.floor(usable / (fontSize * ADVANCE_EM)));
}

/** How many lines the message area holds at this panel height. */
export function chatMaxLines(heightPx: number, lineHeight: number = CHAT_LINE_HEIGHT): number {
  return Math.max(1, Math.floor((heightPx - CHAT_HEADER_HEIGHT - 2 * CHAT_PAD) / lineHeight));
}

/**
 * Greedy word wrap with a shorter first line, because the first line also carries `name: `.
 *
 * A word longer than a whole line — a pasted link, or the emote spam a hype moment produces — is
 * cut mid-word rather than left to overflow, since the panel has no horizontal room to give.
 */
function wrapText(text: string, first: number, rest: number): string[] {
  const lines: string[] = [];
  let line = "";
  const budget = () => (lines.length === 0 ? first : rest);

  for (const word of text.trim().split(/\s+/).filter(Boolean)) {
    let w = word;
    while (w.length > budget()) {
      const room = budget() - (line ? line.length + 1 : 0);
      if (room <= 0) {
        lines.push(line);
        line = "";
        continue;
      }
      lines.push(line ? `${line} ${w.slice(0, room)}` : w.slice(0, room));
      line = "";
      w = w.slice(room);
    }
    if (!line) line = w;
    else if (line.length + 1 + w.length <= budget()) line += ` ${w}`;
    else {
      lines.push(line);
      line = w;
    }
  }
  if (line || lines.length === 0) lines.push(line);
  return lines;
}

/** One message as the panel draws it: a coloured name, then its text already broken into lines. */
export interface ChatPanelLine {
  name: string;
  /** Always a readable colour — never the raw Twitch one. See readableColor. */
  color: string;
  /** The text, wrapped. The first entry sits on the same line as the name. */
  lines: string[];
}

/**
 * The messages on screen at `nowSec`, oldest first (newest last, at the bottom, as chat reads).
 *
 * Capped by *lines*, not messages: one 136-character message is four lines of the panel and has
 * to displace four one-liners, or the panel overflows on exactly the moments worth watching.
 * A message that does not fit whole is dropped whole — a message cut off at its top edge reads
 * as a rendering fault.
 */
export function visibleMessages(
  messages: ChatMessage[],
  nowSec: number,
  maxLines: number,
  charsPerLine: number,
): ChatPanelLine[] {
  const out: ChatPanelLine[] = [];
  let used = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.atSec > nowSec) continue;
    // `name: ` eats into the first line only. The floor matters for the 25-character display
    // names Twitch allows, which on a narrow panel would otherwise leave no room at all.
    let lines = wrapText(m.text, Math.max(4, charsPerLine - (m.name.length + 2)), charsPerLine);
    if (used + lines.length > maxLines) {
      // ...unless it is the only thing there is to show, in which case a truncated newest
      // message beats an empty panel.
      if (out.length > 0) break;
      lines = lines.slice(0, maxLines);
    }
    used += lines.length;
    out.push({ name: m.name, color: readableColor(m.color), lines });
  }
  return out.reverse();
}

/* ===== colour ===== */

/** The panel's own background — what a name has to be readable against. Mirrors --panel-2. */
const PANEL_BG = "#1a1820";
/** Fallback for the users who never picked a colour. Mirrors --muted, which clears the floor. */
const MUTED = "#8d8695";
/** WCAG AA for body text. Twitch's own dark palette entries land well under it on this panel. */
const MIN_CONTRAST = 4.5;

function parseHex(hex: string): [number, number, number] | null {
  const h = hex.trim().replace(/^#/, "");
  const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as [number, number, number];
}

const toHex = (rgb: number[]): string =>
  `#${rgb.map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`;

/** WCAG relative luminance. */
function luminance([r, g, b]: [number, number, number]): number {
  const lin = [r, g, b].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

function contrast(a: [number, number, number], b: [number, number, number]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/**
 * A Twitch colour, lightened until it is legible on the panel.
 *
 * Twitch's own preset palette contains #000000, #008000 and #0000FF, and users pick worse; on a
 * near-black panel those are a name nobody can read. Blending toward white rather than swapping
 * the colour out keeps the user identifiable — chat regulars are recognised by their colour —
 * while monotonically raising luminance, so the first step that clears the floor is the one that
 * changes the colour least.
 */
export function readableColor(color: string | null): string {
  if (!color) return MUTED;
  const rgb = parseHex(color);
  const bg = parseHex(PANEL_BG)!;
  if (!rgb) return MUTED;
  if (contrast(rgb, bg) >= MIN_CONTRAST) return toHex(rgb);
  for (let t = 0.05; t <= 1; t += 0.05) {
    const lifted = rgb.map((c) => c + (255 - c) * t) as [number, number, number];
    if (contrast(lifted, bg) >= MIN_CONTRAST) return toHex(lifted);
  }
  return "#ffffff";
}
