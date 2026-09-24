/**
 * Geometry shared by the Remotion compositions and the Node-side render/NLE code.
 *
 * Deliberately free of CSS and JSX imports: `src/pipeline/pipeline.ts` and `src/pipeline/overlayRender.ts` import
 * these under plain Node, where a transitive `import "./overlay.css"` is a hard crash
 * (ERR_UNKNOWN_FILE_EXTENSION) — webpack only resolves that inside the Remotion bundle.
 */

export const STAGE_WIDTH = 1920;
export const STAGE_HEIGHT = 1080;

/** Each POV gets its own half of the stage; 16:9 then fixes its height at half the stage. */
export const POV_WIDTH = STAGE_WIDTH / 2;
export const POV_HEIGHT = (POV_WIDTH * 9) / 16;

/**
 * The bands are sized so the transparent gap between them is exactly POV_HEIGHT. Get this wrong
 * and a 16:9 POV either letterboxes into a short slot or bleeds under a band, over the hotbar or
 * the boss bar. TOP_BAND_HEIGHT + BOTTOM_BAND_HEIGHT must equal STAGE_HEIGHT - POV_HEIGHT;
 * layout.test.ts fails if that drifts.
 *
 * Literal px, mirrored in overlay.source.css (.row1 97 + .row2 97 = 194, .splits 346);
 * percentages rounded to a 15px overshoot.
 */
export const TOP_BAND_HEIGHT = 194;
export const BOTTOM_BAND_HEIGHT = 346;
export const BOTTOM_BAND_Y = STAGE_HEIGHT - BOTTOM_BAND_HEIGHT;

/** "x y w h opacity" rects placing each POV exactly in the gap, so no NLE nudging is needed. */
export const LEFT_POV_RECT = `0 ${TOP_BAND_HEIGHT} ${POV_WIDTH} ${POV_HEIGHT} 1`;
export const RIGHT_POV_RECT = `${POV_WIDTH} ${TOP_BAND_HEIGHT} ${POV_WIDTH} ${POV_HEIGHT} 1`;

/**
 * Bottom-band column geometry, in px, mirroring .col-meta/.col-splits/.col-rta in
 * overlay.source.css (layout.test.ts pins the two together).
 *
 * These exist because only the RTA column changes from frame to frame (see CLAUDE.md), so the
 * left region renders as stills and the RTA column is the only thing rendered per frame.
 *
 * Fixed px rather than flex percentages, so long content cannot move the boundary the crop
 * depends on.
 */
export const META_COL_WIDTH = 384;
export const SPLITS_COL_WIDTH = 1056;
export const RTA_COL_WIDTH = 480;
/** Left edge of the RTA column — the crop seam between the static stills and the timer video. */
export const RTA_COL_X = META_COL_WIDTH + SPLITS_COL_WIDTH;
/** Width of the static (meta + splits) region rendered as stills. */
export const STATIC_COL_WIDTH = RTA_COL_X;

/** The intro card's default length; `config.introSec` (2-7) shortens it. */
export const INTRO_SECONDS = 7;
/** The intro composition's length in frames. The card's entrance is done by 1.05 s and its wipe
 *  takes the last 0.6 s, so any length from 2 s up plays the whole card, just held for less. */
export const introFrameCount = (fps: number, introSec: number = INTRO_SECONDS) => Math.round(fps * introSec);

/**
 * Shorts board: 1080x1920, two stacked POV panes.
 *
 * The band proportions follow the layout @MCSR-Vault uses (measured off a 42k-view Short): a
 * nameplate above each pane and a persistent channel bar along the bottom. What is deliberately
 * *not* copied is their source — both they and @MCSR_Ranked centre-crop a finished 16:9
 * broadcast, which slices the right edge off every stat panel and truncates handles and Elo
 * readouts. Rendering the board natively at 1080x1920 from match data costs nothing extra here
 * and has none of that.
 */
export const SHORT_WIDTH = 1080;
export const SHORT_HEIGHT = 1920;
/** A 16:9 POV pane at full board width. */
export const SHORT_POV_WIDTH = SHORT_WIDTH;
export const SHORT_POV_HEIGHT = Math.round((SHORT_POV_WIDTH * 9) / 16);
export const SHORT_NAMEPLATE_HEIGHT = 220;
/**
 * Whatever is left. Derived rather than chosen so the five bands tile 1920 exactly by
 * construction — a few pixels of drift here is a black stripe across a vertical video, and it
 * would only show up on the published Short.
 *
 * Note the panes are true 16:9 at full width (608px), unlike the reference layout's 653/700px,
 * which are the shape they are because a 16:9 broadcast was cropped to fit rather than composed.
 */
export const SHORT_BRAND_BAR_HEIGHT = SHORT_HEIGHT - SHORT_NAMEPLATE_HEIGHT * 2 - SHORT_POV_HEIGHT * 2;

/** Top of each element, so the Remotion board and any NLE placement agree by construction. */
export const SHORT_TOP_POV_Y = SHORT_NAMEPLATE_HEIGHT;
export const SHORT_BOTTOM_NAMEPLATE_Y = SHORT_TOP_POV_Y + SHORT_POV_HEIGHT;

/**
 * Seconds the hook line stays on screen.
 *
 * Four (the operator's call, 23 Sept 2026): the steepest loss on our own Shorts is 4.6–9 s in,
 * right after a 3 s hook left the frame bare. With captions the first one replaces the hook at
 * this second rather than letting it fade to nothing, so no second of the Short is without text.
 */
export const SHORT_HOOK_SEC = 4;

/**
 * Seconds of result card at the end — the closing beat every reference Short stamps, held to a
 * hard cut (1.2s on one, 4.3s on another; 2.5 is the middle of what they hold).
 */
export const SHORT_RESULT_SEC = 2.5;

/** Seconds of the closing card that replaces the result card (`endCard`): long enough to read one question. */
export const SHORT_END_CARD_SEC = 1.5;

/**
 * The caption strip: a full-width band of board furniture the data captions sit on, so they
 * never cover footage. With both POVs it takes the top of the lower nameplate — directly under
 * the top pane, where the hook's last line was — and the lower plate is compacted into the rest.
 * Alone, it sits under the one nameplate, where the hook's first line was.
 */
export const SHORT_CAPTION_HEIGHT = 90;
/** The compacted lower nameplate under the strip (both POVs with captions). */
export const SHORT_COMPACT_NAMEPLATE_HEIGHT = SHORT_NAMEPLATE_HEIGHT - SHORT_CAPTION_HEIGHT;

/**
 * One player's POV alone: nameplate, caption strip, one tall pane, the brand bar. The pane is
 * whatever height is left, so the bands tile 1920 by construction. At 1080x1346 a 16:9 stream is
 * centre-cropped to its middle ~867px of 1920: the crosshair, the 728px hotbar (GUI scale 4) and
 * the hearts stay, the webcam, the chat and the streamer's own timer at the frame edges go.
 */
export const SHORT_SOLO_CAPTION_Y = SHORT_NAMEPLATE_HEIGHT;
export const SHORT_SOLO_POV_Y = SHORT_SOLO_CAPTION_Y + SHORT_CAPTION_HEIGHT;
export const SHORT_SOLO_POV_HEIGHT = SHORT_HEIGHT - SHORT_SOLO_POV_Y - SHORT_BRAND_BAR_HEIGHT;

/** Where the caption strip starts, per layout. */
export const shortCaptionY = (pov: "both" | "left" | "right"): number =>
  pov === "both" ? SHORT_BOTTOM_NAMEPLATE_Y : SHORT_SOLO_CAPTION_Y;

/** Monocraft's advance: 720 units on a 1080 em, the same in both weights (hmtx). */
const MONOCRAFT_ADVANCE_EM = 720 / 1080;

/**
 * The running clock, drawn by ffmpeg (not the board still) on the right of the TOP nameplate —
 * both layouts. It sat in the bottom bar until 23 Sept 2026, which is where YouTube's own title
 * and channel row cover the bottom ~20% of a Short. Its centre is in the plate's lower half, level
 * with the elo line, which keeps it under the Shorts player's own top-right icons.
 */
export const SHORT_CLOCK_FONT_PX = 52;
export const SHORT_CLOCK_MARGIN_PX = 40;
export const SHORT_CLOCK_Y = SHORT_NAMEPLATE_HEIGHT - 64;
/**
 * What the top plate keeps free on its right for the clock: "10:00.00" (Monocraft is
 * monospaced, so 8 x 0.667em), its margin and a gap — a long name ellipses short of it.
 */
export const SHORT_CLOCK_RESERVE_PX =
  Math.ceil(8 * SHORT_CLOCK_FONT_PX * MONOCRAFT_ADVANCE_EM) + SHORT_CLOCK_MARGIN_PX + 24;
const CAPTION_MAX_PX = 60;
const CAPTION_LETTER_SPACING_EM = 0.02;

/**
 * A caption's font size: the largest up to 60px at which it fits the strip on one line. Never a
 * second line — the strip is one line tall — so a long caption gets smaller type instead.
 */
export function shortCaptionFontSize(text: string): number {
  const width = SHORT_WIDTH - 2 * 40;
  const chars = Math.max(1, text.trim().length);
  return Math.min(
    CAPTION_MAX_PX,
    Math.floor(width / (chars * (MONOCRAFT_ADVANCE_EM + CAPTION_LETTER_SPACING_EM))),
  );
}
