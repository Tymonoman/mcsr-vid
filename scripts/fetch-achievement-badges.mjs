// One-time vendoring script (run manually, like branding/generate_brand_assets.py) —
// not wired into any npm script. Downloads every achievement badge PNG from the
// MCSR-Ranked/Wiki repo into remotion/assets/achievements/. See that dir's README
// for why these are vendored instead of hotlinked.
import { mkdirSync, writeFileSync } from "node:fs";

const REPO = "MCSR-Ranked/Wiki";
const TREE_PATH = "docs/gameplay/img/achievement/";
const OUT_DIR = "remotion/assets/achievements";

const treeRes = await fetch(`https://api.github.com/repos/${REPO}/git/trees/main?recursive=1`);
if (!treeRes.ok) throw new Error(`GitHub tree fetch failed: ${treeRes.status}`);
const tree = await treeRes.json();
const files = tree.tree.filter((t) => t.path.startsWith(TREE_PATH) && t.path.endsWith(".png"));

mkdirSync(OUT_DIR, { recursive: true });

for (const file of files) {
  const name = file.path.slice(TREE_PATH.length);
  const rawUrl = `https://raw.githubusercontent.com/${REPO}/main/${file.path}`;
  const res = await fetch(rawUrl);
  if (!res.ok) throw new Error(`Failed to download ${name}: ${res.status}`);
  writeFileSync(`${OUT_DIR}/${name}`, Buffer.from(await res.arrayBuffer()));
  console.log(`  ${name}`);
}

console.log(`Downloaded ${files.length} achievement badges into ${OUT_DIR}/`);
