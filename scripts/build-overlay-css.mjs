import { readFileSync, writeFileSync } from "node:fs";

const css = readFileSync("remotion/overlay.source.css", "utf8");
const regular = readFileSync("remotion/assets/fonts/Monocraft.ttf").toString("base64");
const bold = readFileSync("remotion/assets/fonts/Monocraft-Bold.ttf").toString("base64");

const output = css.replaceAll("__FONT_REGULAR_B64__", regular).replaceAll("__FONT_BOLD_B64__", bold);

writeFileSync("remotion/overlay.css", output);
// stderr, not stdout: every `npm run <x>` script in package.json chains this in front of the
// real command with `&&`, and `studioWorker.ts`'s `renderTcThumbs` is now a caller that parses
// `npm run --silent tc-thumbs`'s stdout as JSON — this status line landing on stdout first broke
// that parse on every single invocation (review fix, 8 Oct 2026).
console.error(`remotion/overlay.css written (${output.length.toLocaleString()} bytes)`);
