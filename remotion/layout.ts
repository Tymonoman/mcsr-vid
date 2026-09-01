/**
 * Geometry shared by the Remotion compositions and the Node-side render/NLE code.
 *
 * Deliberately free of CSS and JSX imports: `src/pipeline.ts` and `src/overlayRender.ts` import
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
 * and a 16:9 POV either letterboxes into a short slot or bleeds under a band — which is what put
 * the splits panel over the hotbar and the info bar over the boss-bar/"Ender Dragon" text.
 * TOP_BAND_HEIGHT + BOTTOM_BAND_HEIGHT must equal STAGE_HEIGHT - POV_HEIGHT; layout.test.ts
 * fails if that ever drifts again.
 *
 * Mirrored in overlay.source.css as literal px (.row1 97 + .row2 97 = 194, .splits 346). These
 * were percentages (9% / 10.4% / 32% -> 209.5px + 345.6px = 555px against a 540px POV), and that
 * 15px overshoot is precisely the overlap viewers reported.
 */
export const TOP_BAND_HEIGHT = 194;
export const BOTTOM_BAND_HEIGHT = 346;
export const BOTTOM_BAND_Y = STAGE_HEIGHT - BOTTOM_BAND_HEIGHT;

/** "x y w h opacity" rects placing each POV exactly in the gap, so no NLE nudging is needed. */
export const LEFT_POV_RECT = `0 ${TOP_BAND_HEIGHT} ${POV_WIDTH} ${POV_HEIGHT} 1`;
export const RIGHT_POV_RECT = `${POV_WIDTH} ${TOP_BAND_HEIGHT} ${POV_WIDTH} ${POV_HEIGHT} 1`;

export const INTRO_SECONDS = 7;
