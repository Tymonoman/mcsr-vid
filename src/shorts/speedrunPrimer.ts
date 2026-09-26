/**
 * What the Short's picker knows about the game before it watches a match (videoPick.ts puts it in
 * every pick prompt). The operator, 26 Sept 2026: "the model (agy) doesnt have the concept of
 * hunger resetting and it suggested a moment where both runners hunger reset and nothing else
 * happens. the model should have deep knowledge of speedrunning mechanics add it to the prompt."
 *
 * Every line is sourced or measured on our own matches; the notes are
 * `~/.claude/projects/-app/research/resume-2026-09-26/pick-mechanics-api.md` and the job's
 * `web.md` / `corpus.md` (minecraft.wiki, mcsr.miraheze.org, wiki.mcsrranked.com/gameplay/rng,
 * the MCSR Ranked site's own event labels, 78 matches on disk), corrected line by line by the
 * adversarial fact-check beside them (`pick-mechanics-factcheck.md`: the Nether anchor reset, the
 * death message, the usual 25–40 s End). Add nothing without a source: a wrong "fact" here is
 * repeated in every hook and DM the model writes. It rides on every pick: keep it near 1,200
 * tokens, and cut a weaker line before growing it.
 */
export const SPEEDRUN_PRIMER = `WHAT YOU ARE WATCHING: Minecraft Java 1.16.1, random seed, any%, as MCSR Ranked plays it. Judge every moment against this.

THE RACE
- Both players get the same seed, each in their own copy of the world: they never meet and cannot touch each other's game. Ranked feeds both the same random rolls in the same order (barters, blaze and enderman drops, blaze-spawner timing, eye breaks, pre-filled frames, the dragon's perch and strafe rolls). What each does still changes what the rolls give (gold traded, blazes blocked, crystals broken), so most of a gap is play, not luck.
- The route, every run: loot a village, shipwreck, temple, ruined portal or buried treasure; enter the Nether through a portal cast from lava with a bucket (a lava pool or a magma ravine), or one finished from a ruined portal or chest obsidian; route the bastion for gold and barter it with piglins (pearls, obsidian, string for beds, fire resistance); find the fortress (the F3 pie chart), drink fire resistance, kill blazes for rods; leave the Nether by a portal toward the stronghold (the Blind split); throw eyes of ender and measure them (F3+C and a calculator) to triangulate the stronghold; dig in, find the portal room, fill the frame, jump in; kill the dragon with bed or respawn-anchor explosions (stronger than TNT).
- The dragon: a zero cycle blows it up from a setup on a pillar without waiting for a perch. A one cycle kills it in a single perch: the beds go off as it comes down onto the fountain. If it settles first, more than 50 damage sends it off again — a failed one cycle.

ROUTINE — part of nearly every run, never the moment by itself
- The hunger reset (runners also say "death reset"): set a spawn point at a bed or anchor ("Respawn point set"), die on purpose — a fall, pearls, lava or fire — respawn with full health and full hunger, pick the items back up, go on. It is done instead of eating: at a respawn anchor in the Nether, at the blind portal, or in the portal room, usually about 10 s before jumping into the End. Nearly every bed or anchor death is one. The death message tells them apart: "hit the ground too hard", burning or lava just after "Respawn point set" is the reset; a mob kill ("shot by Skeleton") is an accident.
- Ranked's death screen always shows "Forfeit the Match" and "Reset World": seeing them is neither a forfeit nor a restart.
- Both players doing the same routine thing at nearly the same time — both resetting, both measuring eyes, both jumping into the portal — is not drama. It is the race going to plan; the only news in it is the gap.
- Also routine: looting chests, building portals, bartering, pearling (2.5 hearts a throw) and pillaring, the blaze fight, wading through lava on fire resistance (it does no damage) and drinking it again after a reset, measuring eyes (the stream may turn into a tall stretched strip or a zoomed crosshair, often in a boat), the F3 screen or its pie chart over the picture, going back into the Nether to build a second portal nearer the stronghold (double travel), digging down, an endermite from a pearl, filling the portal, hearts lost to their own beds in the End, waiting for the perch, eating.
- A zero cycle is the usual kill: the End usually takes 25–40 s from entry to the killing blow. Much longer means something went wrong (a failed setup, a perch wait, a death).

REMARKABLE — what a viewer clips
- A real death: no spawn point set, so back to world spawn with nothing; or any death in the End, where no bed sets a spawn. In the End it usually costs the race.
- A hunger reset gone wrong: the bed too far or blocked, no spawn set, and the death is real.
- A bed or anchor that kills its own runner; a failed one cycle; a long End.
- A restart of the seed; a portal built in the wrong place from a bad measurement; a long hunt for the portal room.
- An overtake at a real split, a lead opening or closing fast, a comeback from far behind, splits a second or two apart, a near-death that survives (a long fall, lava without fire resistance).
- Loud chat is not proof of an event: chat also gets loud when a runner reaches the portal room ("W NAV", "PLEASE", "BANG"). A disaster reads "NOOO", "WHAT", "gg", "nt".
- A stream's transcript can be Whisper inventing words over silence ("Thank you for watching!", "Undertexter av…"): trust the picture.

TITLE HOOKS AND PLAYER MOMENTS
- They reach pro runners and their fans. Never praise or dramatise a routine action ("you set a bed spawn", "they both died in the stronghold"): to a runner it reads as not knowing the game. Name what they did better than usual — a fast split, a quick End, a gap made up, a save — and claim only what the footage or the facts show: never an eye count, a barter haul or a number you did not read.`;
