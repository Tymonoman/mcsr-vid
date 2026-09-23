// Writes mcsr-vid.config.example.json from src/config.ts DEFAULTS, so the example can never
// drift from the code again (it had: seven keys were missing by 22 Sept 2026). The one value
// that is not a default is reasonerCommand, shown as the lab's Antigravity argv (LAB_REASONER_COMMAND).
// Run: npm run config:example
import { writeFileSync } from "node:fs";
import { DEFAULTS, LAB_REASONER_COMMAND } from "../src/config.js";

const example = { ...DEFAULTS, reasonerCommand: LAB_REASONER_COMMAND };
writeFileSync("mcsr-vid.config.example.json", `${JSON.stringify(example, null, 2)}\n`, "utf8");
console.log(`mcsr-vid.config.example.json: ${Object.keys(example).length} keys`);
