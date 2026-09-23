# First-minute "COMING UP" teaser — handoff (23 Sept 2026)

The operator approved it ("and yeah you can do the teaser or whatever"): a card in the long-form's
meta column during the first minute promising a moment later in the race, aimed at the 16–22
retention points every video loses between 3% and 10%. Stopped mid-task at the usage limit.

## DONE (compiles: `npx tsc --noEmit` exit 0; tests NOT run yet)

- `src/pipeline/teaser.ts` (new): `chooseTeaser(match) → { momentMs, text } | null`, from
  `match.timelines` only (reuses `raceStateAt`, `decidedAtMs`, `MILESTONES`, `formatGap` from
  `src/shorts/raceGap.ts`). Order: an unplanned death (furthest rung, then earliest) →
  "A DEATH AT THE BASTION"; else the lead change that overturned the biggest deficit →
  "THE LEAD CHANGES AT THE FORTRESS"; else the closest split under 2 s → "1.0 S APART AT THE
  FORTRESS"; else null. Window: moment >= 60 s and <= decidedAtMs − 60 s; null decided → none.
  Names no player. Longest line 34 chars.
- `src/pipeline/splitStates.ts`: `windowOf` helper (midRollFramesOf now uses it) and
  `teaserFramesOf(props)` — null if off, forSec <= 0, past the run end, still up when the moment
  arrives, or overlapping the mid-roll SUBSCRIBE window (mid-roll wins). Fingerprint and
  candidate frames include the teaser's two edges, so it is two more stills; export:fast needs
  no change (it reads overlay-splits.json).
- `remotion/types.ts`: `teaser?: { atSec, forSec, momentMs, text }` on OverlayProps.
- `src/pipeline/overlayProps.ts`: exported `teaserProp(match)` spread into computeOverlayProps
  (empty when `teaserAtSec` is null or nothing qualifies). A series game is its own match, so its
  teaser never points past its own decision — nothing series-specific needed.
- `remotion/Overlay.tsx`: meta column branch — gold "COMING UP" (`.cta-value`), "AT 5:22"
  (`.teaser-at`, formatShortTime of momentMs = the RTA the timer will read), the line
  (`.teaser-what`). `remotion/overlay.source.css`: `.teaser-at` 24px, `.teaser-what` 16px.
- `src/config.ts`: `teaserAtSec: 10` (seconds after match start, like midRollCtaAtSec; video 0:20
  = 3% of a 10-min match's video, 13 s after the intro card), `teaserSec: 5`; validation shares
  the midRoll branch (0–3600, AtSec nullable).
- `src/dashboard/settings.ts`: field `teaserAtSec` (Publishing group, int 0–50, nullable = off).
- Scratch (outside repo, not committed): `/tmp/teaser/` — `match-<id>.json` for the 5 matches,
  `props-<id>.json` (real overlay props, timerStartFrame 300, fps 30), scripts `choose.mts`,
  `props.mts`, `arrivals.mts`. Teaser frames for all four with a teaser: [600, 750).

## IN PROGRESS

- Nothing half-edited. No stills rendered yet; no tests written; `npm run config:example` not
  run (so `mcsr-vid.config.example.json` lacks the two keys — the config-example test may fail).

## TODO (in order)

1. `npm run config:example` (adds teaserAtSec/teaserSec to mcsr-vid.config.example.json).
2. `src/pipeline/teaser.test.ts`: fixtures — 12929221 → "A DEATH AT THE BASTION" @196454;
   12730175 → "0.7 S APART ON BLIND TRAVEL" (its death_spawnpoints are ignored); 12898432 and
   12902901 → null. Synthetic: a death at decided−59 s is refused; no text contains a nickname,
   "DRAGON", "WIN", "FINISH"; every text <= 34 chars; moment < 60 s refused; no dragon and
   result.time 0 → null.
3. `splitStates.test.ts`: teaser is two stills at the right frames; null when it overlaps the
   mid-roll, when it would still be up at the moment, past the run end, and when absent.
4. `overlayProps.test.ts`: `teaserProp` empty when `config.teaserAtSec` is null.
5. Config validation test (where midRoll's is, likely `src/config.test.ts`): teaserAtSec null ok,
   -1 / "10" rejected; teaserSec null rejected.
6. Render: `nice -n 19 npm run still -- OverlaySplits /tmp/teaser/still-13549300.png --frame=650
   --props=/tmp/teaser/props-13549300.json` and the same for 13559245; read the PNGs, check the
   card fits the 384px meta column (two lines max for the 34-char line). Adjust CSS if not.
7. Smoke composite: no `export:fast --seconds` on a real match (writes into /media/<id>/).
   Composite the still over a frame with ffmpeg in /tmp/teaser instead.
8. `npm run test:unit`, then `npm test` (render tests).
9. CLAUDE.md: a bullet beside the mid-roll one ("A COMING UP card in the first minute",
   `teaserAtSec`, `teaserFramesOf`, `src/pipeline/teaser.ts`, death_spawnpoint note).
10. Commit (attribution lines), do not push. Report to the coordinator.

## NOTES

- Teaser lines for the 5 real matches (default config):
  - 13549300 hackingnoises vs BeefSalad → COMING UP · AT 5:14 · THE LEAD CHANGES ON BLIND TRAVEL
  - 13559245 doogile vs Aquacorde → COMING UP · AT 4:32 · THE LEAD CHANGES AT THE FORTRESS
  - 13473906 Feinberg vs silverrruns → COMING UP · AT 5:23 · THE LEAD CHANGES AT THE FORTRESS
  - 13448958 Infume vs bbiddd → COMING UP · AT 5:22 · THE LEAD CHANGES AT THE FORTRESS
  - 13446429 Infume vs Feinberg → none (led wire to wire; its deaths are in the last minute)
- `projectelo.timeline.death_spawnpoint` is NOT an accident: it is the routine death warp —
  bed set in the portal room, then a deliberate fall (VOD 13446429 Infume at RTA 6:25: "Respawn
  point set", "Infume hit the ground too hard", 7 s before the End; same pattern in 12730175 and
  12898432). The teaser ignores it. matchScore.ts, shortHook.ts and raceGap.ts still count it as a
  death (chaos score, "DIES" captions) — worth fixing separately; not this task's files.
- Operator decisions: (a) a wire-to-wire match gets no teaser (3 of 9 checked) — add a fourth
  fallback (the smallest gap at any split, e.g. "8.7 S APART INTO THE NETHER")? (b) default on
  at RTA 0:10 for 5 s changes what the nightly renders — approved as "the teaser test on the next
  5 videos"; switch off in Settings → Publishing (empty field) after comparing retention.
