# Review-readiness drafts (11 Oct 2026)

Idea 3 of the full-tier plan (https://claude.ai/artifact/ADK2WTTzP732w87GgpwXzC): the full YPP tier (ads) has a human
review for reused content, and a channel of only other people's footage is its riskiest shape. These are drafts for
the operator — nothing here is published; the About section and the explainer are his to post.

## About section (channel description)

> MCSR Replayoffs puts both players of an MCSR Ranked match on one screen, synced to the same countdown, with a live
> split timer, the race's splits and a short line on what each split means, so you can see who is ahead and why. New
> matches every day from the ladder's best runners, and the playoffs as whole series. Every video credits and links
> both runners' streams. If you're a runner and want a match taken down, message us and it comes down.

Why these words: they name what the channel adds to the footage (the sync, the timer, the splits, the explanations,
the series), which is what the reused-content review looks for, and they keep the takedown offer every runner DM
already makes.

## Explainer #1: "what is MCSR Ranked, and why a 6:40 run is absurd" (3–5 min)

Built from what the channel already renders (overlay stills, split timer, explain-the-moves lines) plus footage from
runners who said yes. The operator writes or voices it; no winner of any race named; no seed/rank/elo hooks.

1. Cold open (0:00–0:15): one finish from a consenting runner's match, the timer stopping at a single-digit minute
   count. "This is someone beating Minecraft. From a new world. In under ten minutes."
2. What it is (0:15–0:45): two players, the same random world, a race to kill the dragon; a ladder of thousands of
   runners; matches every few minutes.
3. The route in six splits (0:45–3:00), one card each, using the overlay's own lines (`MOVE_LINES`,
   src/pipeline/explainMoves.ts): the Nether (blaze rods, ender pearls, explosives); the bastion (trading gold to
   piglins for pearls); the fortress (blazes spawn only here, each drops a rod half the time); blind travel (out of
   the Nether roughly where the stronghold should be); the stronghold (finding the portal room); the End (beds that
   explode, the dragon in one cycle).
4. Why it's absurd (3:00–3:45): the clock next to the route — the top ladder runners average about 9–10 minutes
   (the season averages on our own nameplates), the record is 6:39.813 (Any% Glitchless, 27 July 2026). What a normal
   survival world takes by comparison.
5. Close (3:45–4:00): "every race on this channel shows both players at once — pick one and watch who gets there."

Production: Remotion compositions reusing `remotion/` assets (Monocraft, the palette, the overlay stills); voice or
on-screen text. Footage only from runners with a recorded yes (the consent round, idea 4).
