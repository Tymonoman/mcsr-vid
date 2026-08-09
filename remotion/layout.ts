/**
 * Geometry shared by the Remotion compositions and the Node-side render/NLE code.
 *
 * Deliberately free of CSS and JSX imports: `src/pipeline.ts` and `src/overlayRender.ts` import
 * these under plain Node, where a transitive `import "./overlay.css"` is a hard crash
 * (ERR_UNKNOWN_FILE_EXTENSION) — webpack only resolves that inside the Remotion bundle.
 */

export const STAGE_WIDTH = 1920;
export const STAGE_HEIGHT = 1080;

/** row1 (9%) + row2 (10.4%) = 209.5px, and the badge hangs to 173px — 210 covers both. */
export const TOP_BAND_HEIGHT = 210;
/** .splits is `bottom: 0; height: 32%` = the last 345.6px. */
export const BOTTOM_BAND_HEIGHT = 346;
export const BOTTOM_BAND_Y = STAGE_HEIGHT - BOTTOM_BAND_HEIGHT;

export const INTRO_SECONDS = 5;
