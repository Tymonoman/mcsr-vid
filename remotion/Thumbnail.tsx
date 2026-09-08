import type { FC } from "react";
import { AbsoluteFill, Img } from "remotion";
import "./overlay.css";
import type { ThumbnailProps, ThumbnailPlayer } from "./types.js";
import { PixelBadge } from "./PixelBadge.js";

/**
 * The widest a hook line may render before it reads as touching the frame. The band's own
 * padding is wider than this on purpose: a line at the limit may bleed into it.
 */
const HOOK_LINE_WIDTH = 1248;
/**
 * Monocraft is monospace. Measured off two renders (a 6-glyph line at 150px and a 10-glyph one
 * at 120px, solving out the ink bearings and the outline): 0.662em advance plus the 0.02em
 * letter-spacing .thumb-hook sets.
 */
const HOOK_ADVANCE_EM = 0.682;
/** Font-size steps, largest first. 96 is the floor: below it the hook stops reading at 246px wide. */
const HOOK_SIZES = [150, 120, 108, 96];
/** Two lines at 150 would eat half the frame, so only a single line gets the largest step. */
const HOOK_TWO_LINE_MAX = 120;
/** Padding above and below the hook inside the band. */
const HOOK_PAD = 18;
/** How far the avatars are allowed to run up behind the band's lower edge. */
const HOOK_OVERLAP = 40;

const charBudget = (fontSize: number): number => Math.floor(HOOK_LINE_WIDTH / (fontSize * HOOK_ADVANCE_EM));

/** Greedy wrap, one word per line minimum. Only reached by hooks too long for two lines at 96px. */
function wrapWords(words: string[], maxChars: number): string[] {
  const lines: string[] = [];
  for (const word of words) {
    const last = lines[lines.length - 1];
    if (last !== undefined && last.length + 1 + word.length <= maxChars) {
      lines[lines.length - 1] = `${last} ${word}`;
    } else {
      lines.push(word);
    }
  }
  return lines;
}

/** The two-line split with the smallest longest line: a greedy wrap orphans the last word. */
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
 * A step function decided in JS rather than CSS `clamp`/`vw`: this renders once at a fixed
 * 1280x720, so a size that depends on the viewport is not reproducible from the props alone,
 * and two renders of the same hook must be the same image.
 *
 * ponytail: a hook too long for two lines even at the 96px floor wraps to three rather than
 * shrinking past legibility — the title budget allows ~47 characters and 96px fits 19 a line.
 * If those ever need to stay at two lines, condense the text, not the type.
 */
function layoutHook(text: string): { lines: string[]; fontSize: number } {
  const words = text.trim().split(/\s+/);
  const single = words.join(" ");

  for (const fontSize of HOOK_SIZES) {
    if (single.length <= charBudget(fontSize)) return { lines: [single], fontSize };
    if (fontSize > HOOK_TWO_LINE_MAX || words.length < 2) continue;
    const pair = balancedPair(words);
    if (Math.max(...pair.map((l) => l.length)) <= charBudget(fontSize)) return { lines: pair, fontSize };
  }
  return { lines: wrapWords(words, charBudget(96)), fontSize: 96 };
}

/** Band height and the body offset that keeps the avatars mostly clear of it. */
function hookLayout(lines: string[], fontSize: number) {
  const bandHeight = HOOK_PAD * 2 + lines.length * Math.round(fontSize * 1.04);
  return { bandHeight, bodyTop: bandHeight - HOOK_OVERLAP };
}

function PlayerRender({ player, side }: { player: ThumbnailPlayer; side: "left" | "right" }) {
  return (
    <div className={`thumb-player ${side}`}>
      <Img src={player.avatarUrl} />
    </div>
  );
}

function PlayerTag({ player, side }: { player: ThumbnailPlayer; side: "left" | "right" }) {
  return (
    <div className={`thumb-tag ${side}`}>
      <span className="elo">[{player.eloRate}]</span>
      <span className="nick">{player.nickname}</span>
    </div>
  );
}

export const Thumbnail: FC<ThumbnailProps> = (props) => {
  const hook = props.hookText?.trim() ? layoutHook(props.hookText) : null;
  const layout = hook ? hookLayout(hook.lines, hook.fontSize) : null;

  return (
    <AbsoluteFill className="thumb">
      <div
        className={`thumb-header${hook ? " has-hook" : ""}`}
        style={layout ? { height: layout.bandHeight } : undefined}
      >
        {hook ? (
          <div className="thumb-hook" style={{ fontSize: hook.fontSize }}>
            {hook.lines.map((line) => (
              <div key={line}>{line}</div>
            ))}
          </div>
        ) : (
          <span className="label">{props.headerLabel}</span>
        )}
      </div>
      {/* The body is pushed down by the band it would otherwise be hidden behind: everything
          inside it (avatars, VS, nameplates, badge) is positioned against the body, so one
          offset moves the whole face-off rather than four. */}
      <div className="thumb-body" style={layout ? { top: layout.bodyTop } : undefined}>
        <PlayerRender player={props.left} side="left" />
        <PlayerRender player={props.right} side="right" />
        <span className="thumb-vs">VS</span>
        <PlayerTag player={props.left} side="left" />
        <PlayerTag player={props.right} side="right" />
        <div className="thumb-logo">
          <PixelBadge />
        </div>
      </div>
    </AbsoluteFill>
  );
};
