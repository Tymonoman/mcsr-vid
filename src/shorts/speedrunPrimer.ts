/**
 * What the Short's picker knows about the game before it watches a match (videoPick.ts puts it in
 * every pick prompt). The operator, 26 Sept 2026: "the model (agy) doesnt have the concept of
 * hunger resetting and it suggested a moment where both runners hunger reset and nothing else
 * happens. the model should have deep knowledge of speedrunning mechanics add it to the prompt."
 *
 * Every line is sourced or measured on our own matches; the notes are
 * `~/.claude/projects/-app/research/resume-2026-09-26/pick-mechanics-api.md` and the job's
 * `web.md` / `corpus.md` (minecraft.wiki, mcsr.miraheze.org, wiki.mcsrranked.com/gameplay/rng,
 * the MCSR Ranked site's own event labels, 78 matches on disk). Add nothing without a source:
 * a wrong "fact" here is repeated in every hook and DM the model writes.
 */
export const SPEEDRUN_PRIMER = `WHAT YOU ARE WATCHING: Minecraft Java 1.16.1, random seed, any%, as MCSR Ranked plays it. Judge every moment against this.

THE RACE
- Both players get the same seed, each in their own copy of the world: they never meet and cannot touch each other's game. Ranked also deals both the same luck in the same order — piglin barters, blaze drops and spawns, eyes of ender breaking, eyes already in the portal frame, the dragon's perches. A gap between them is routing, decisions and execution, not luck.
- The route, every run: loot a village, shipwreck, temple, ruined portal or buried treasure; build a Nether portal with a bucket at a lava pool; route the bastion for gold and barter it with piglins (pearls, obsidian, string for beds, fire resistance); find the fortress (the F3 pie chart), drink fire resistance, kill blazes for rods; leave the Nether by a portal toward the stronghold (the Blind split); throw eyes of ender and measure them (F3+C and a calculator) to triangulate the stronghold; dig in, find the portal room, fill the frame, jump in; kill the dragon with bed or respawn-anchor explosions (stronger than TNT).
- The dragon: a one cycle kills it during a single perch on the fountain (four explosives at least; over 50 damage while perched and it flies off — a failed one cycle). A zero cycle blows it up from a setup on a pillar without waiting for a perch.

ROUTINE — part of nearly every run, never the moment by itself
- The hunger reset (runners also say "death reset"): set a spawn point at a bed or anchor ("Respawn point set"), die on purpose — a fall, pearls, lava or fire — and respawn with full health, full hunger and saturation, pick the dropped items back up, go on. It is done instead of eating, at the blind portal or in the portal room just before the End. The death screen ("hit the ground too hard") is part of it. On our matches 112 of 118 bed-spawn deaths were this, and from the portal room the runner is usually in the End within about 10 s.
- Both players doing the same routine thing at nearly the same time — both resetting, both measuring eyes, both jumping into the portal — is not drama. It is the race going to plan; the only news in it is the gap.
- Also routine: looting chests, building portals, bartering (6 s a barter), pearling, pillaring and bridging, the blaze fight, throwing and measuring eyes, digging down to the stronghold, filling the portal, placing beds, waiting for the perch, eating, drinking fire resistance.

REMARKABLE — what a viewer clips
- A real death: no spawn point set, so back to world spawn with nothing. In the End it usually costs the race.
- A hunger reset gone wrong: the bed too far or blocked, no spawn set, and the death is real.
- A bed or anchor that blows up its own runner; a failed one cycle; a clean zero cycle.
- A restart of the seed; a portal built in the wrong place from a bad measurement; a long hunt for the portal room.
- An overtake at a real split, a lead opening or closing fast, a comeback from far behind, splits a second or two apart, a near-death that survives (knockback into lava, a long fall).
- Loud chat is not proof of an event: chat is loudest when a runner reaches the portal room ("W NAV", "PLEASE", "BANG"). A disaster reads "NOOO", "WHAT", "gg", "nt".
- A stream's transcript can be Whisper inventing words over silence ("Thank you for watching!", "Undertexter av…"): trust the picture.

TITLE HOOKS AND PLAYER MOMENTS
- They reach pro runners and their fans. Never praise or dramatise a routine action ("you set a bed spawn", "they both died in the stronghold"): to a runner it reads as not knowing the game. Name what they did better than usual — a fast split, a clean cycle, a gap made up, a save — and claim only what the footage or the facts show: never an eye count, a barter haul or a number you did not read.`;
