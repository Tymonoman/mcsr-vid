import { readFileSync, writeFileSync } from "node:fs";

const css = readFileSync("remotion/overlay.source.css", "utf8");
const regular = readFileSync("remotion/assets/fonts/Monocraft.ttf").toString("base64");
const bold = readFileSync("remotion/assets/fonts/Monocraft-Bold.ttf").toString("base64");

const output = css
  .replaceAll("__FONT_REGULAR_B64__", regular)
  .replaceAll("__FONT_BOLD_B64__", bold);

writeFileSync("remotion/overlay.css", output);
console.log(`remotion/overlay.css written (${output.length.toLocaleString()} bytes)`);
