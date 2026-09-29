# MCSR replay channels: what moved subscribers, and the playbook for MCSR Replayoffs

Research date 28 Sept 2026. Competitors: MCSR Matches (@mcsrmatches), MCSR Replays (@mcsrreplay), MCSR Vault (@mcsr-vault).
Working files: `~/.claude/projects/-app/research/competitors-2026-09-28/` (below, `R/`). "Measured" = YouTube Data API or a
Wayback capture of YouTube's own count. "Estimated" = inferred from views, rounded displays or upload dates.

Our channel on the same day (Data API, measured): **90 subscribers, 53,392 views, 35 videos**, created 2026-08-09. That is
about 1.7 subscribers per 1,000 views and about 1.8 a day.

## 1. Summary: the findings that matter most

1. **The genre's biggest subscriber spikes came from one outside moment: Ludwig Ahgren's MCSR Ranked arc** (late Dec 2025
   to Feb 2026, coached by Feinberg). All three competitors had their fastest growth in the same weeks. Vault went to
   109 subs/day (27 Dec to 4 Jan, measured endpoints) with a 360K-view Ludwig video. Replays had its best rate, 46.5/day
   (25 Jan to 2 Feb, measured), from plain Feinberg vs Infume replays. Matches got nearly all of its first ~1,060
   subscribers in that window. No official MCSR event produced a spike of that size on any of the three channels.
2. **Subscribers come from new uploads, and going quiet stops growth outright.** Replays has been silent since 18 Apr and
   gained +30 in five months while its catalogue kept drawing views. Matches, after four months off, grew about 1.1 a day
   and came back to a smaller audience. Vault grew about 60 a day on 19 uploads a month and 3 to 12 a day on 3 to 7.
   Every growth phase in this data lines up with a period of heavy posting.
3. **Official MCSR events did not move any competitor's subscriber curve, because none of them covered those events when
   they happened.** S10 playoffs, the first LAN, the World Championship and S11 all passed with nothing, late coverage,
   or unbranded coverage. Vault's S10, World Championship and WR-holder videos drew 3.7 to 7.4K views and changed nothing.
   A creator event covered six weeks late (the Jerk-Offs final) earned little. The one thing an official event did
   produce was a knock-on effect. When @MCSR_Ranked released Feinberg vs Doogile at 125K views, the same pair's ranked
   matches became Matches' best videos for about two weeks.
4. **Titles are a measured lever.** Matches' median views went 292 → 1,858 (about 6x) when it switched to name-first
   titles with a fixed "MCSR Ranked | Minecraft Speedrun" tail (6 Jul). They went 1,858 → 3,868 (about 2x more) when it
   added a hook in front (6 Aug), and the lift held for seven weeks. Our title format
   (`<hook> | <names> | MCSR Ranked 1v1 | Minecraft Speedrun`, `src/pipeline/title.ts`) already matches the winning form.
5. **Reach grows faster than loyalty on every channel.** Vault earned about 6.5 subs per 1K views from its MCSR-native
   November audience, about 2.4 during the Ludwig arc and about 1.2 from a Grian one-off (103K views). Matches fell from
   ≥7.7 to about 1.9 per 1K. We measured the same drop on our own channel (24 Sept audit: 4.3 → 2.5 → 0.96 per 1K by
   week). People who arrive through a crossover subscribe when the channel has a recurring MCSR storyline for them to
   follow. One-off crossover videos brought views but few subscribers.
6. **The channels depend on a few players.** Feinberg is in 23 of Replays' 93 videos and those hold 56% of its views.
   Its growth fell away the month he left its uploads. Vault's Rekrap2 videos (2.57M-sub creator playing ranked as an
   ordinary competitor) hold 14.3% of its views at 3.4x its median. That was a draw that kept recurring after Ludwig
   stopped.
7. **The field is open.** Replays is dormant. Vault posts 3 to 12 videos a month and never covered an official playoff
   live. Matches is the only active rival: daily at 19:00 UTC (our slot too), name/hook titles, no playoff branding.
   Nobody publishes an official playoff as it happens.

## 2. Per channel: growth shape and spikes

### MCSR Matches (@mcsrmatches, UCD4mMby1i-Lz2huxfMMWfLA)
Created 2025-09-13; 1,640 subs / 422,692 views / 129 videos (3 Shorts) on 2026-09-28 (Data API). Measured subscriber
points: 0 (creation), ~950 (2026-02-02, channel shelf in a Wayback capture of another page), 1.06K (2026-05-23, Wayback
watch page lLE8RykRN7c), 1.1K (2026-06-28, Wayback 20260628141938), 1,640 (live). Only four intervals can be measured.
Everything inside them uses views as a proxy, by the date each video was published.
Shape: the Ludwig/Feinberg wave (Nov to early Feb), then a hiatus that stalled growth (Feb to early Jul), then a rebuild
through two title changes (Jul 6, Aug 6), then more reach with lower engagement (Aug 26 onward).

| Window | Subs gain (rate) | Cause | Confidence |
|---|---|---|---|
| 2025-09-13 → 2026-05-23 | +1,065 (~10/day while active, inferred) | Near-daily Feinberg-heavy replays during Ludwig's MCSR arc (Ludwig's first stream with coach Feinberg 24 Nov 2025, VOD 44jMyyF1ve0; Mavrik Edits clips at 271K and 152K). Feinberg is in 11 of the top 15 videos from this period | medium |
| 2025-11-04 → 11-12 (view proxy) | n/a | The first and sixth uploads, both Feinberg matches, sit at ~10.5K views against a median of ~500 | low |
| 2025-12-29 → 2026-01-08 (view proxy) | n/a | Feinberg vs Infume uploads at 5 to 6x the median, alongside the Ludwig clip wave (Sal's Clips 23 Dec; Mavrik 271K on 7 Jan). Shorts drew views with a 0.6% like rate | medium |
| 2026-01-25 → 02-02 (view proxy) | n/a | "Private Match Ludwig vs Feinberg" (11,171) and the Feinberg/Infume/Doogile private-room trilogy (18,149, the channel's top video). The Ludwig S9 co-stream re-upload flopped at 891 | medium |
| 2026-02-06 → 06-28 | +40 (~1.1/day, measured) | Hiatus: 2 uploads in 4 months. The channel missed the LAN (24 to 26 Apr), the S10 playoffs, the WC qualifiers and Couriway's 10K run. It came back on 3 Jun with generic titles (median 292) | high |
| 2026-06-18 → 06-30 (view proxy) | n/a | Uploads during the World Championship (20 to 21 Jun) and the 10K NRI: the next-day NRI repost ran at 6.7x the median | low |
| 2026-07-06 → 08-05 (view proxy) | n/a | Name-first titles with the "MCSR Ranked \| Minecraft Speedrun" tail, every other day. Median 292 → 1,858. The official channel's daily match VODs started 19 Jul | medium |
| 2026-08-06 → 08-25 (view proxy) | n/a | Hook-first titles, a fixed 19:00 UTC slot (41 of 44 uploads), richer descriptions. Median 1,858 → 3,868 with the like rate holding at 2.4% | high |
| 2026-08-26 → 09-27 (view proxy) | +540 over 06-28 → 09-28 (~5.8/day, measured endpoints) | Official WC VODs (Feinberg vs Doogile 125K) made that pair suggested-video bait: "WHAT A MATCH Feinberg vs Doogile" 13,325. Ludwig's return around 19 to 20 Sep. Median ~6,000, but the like rate fell to ~1% and conversion to ~1.9 per 1K | medium |

Sources: `R/mcsrmatches-uploads.json`, `R/mcsrmatches-subscriber-series-v2.json`, `R/mcsrmatches-keyvideos.json`,
`R/mcsrranked-official-recent.json`, `R/snapshot-20260628.html`.

### MCSR Replays (@mcsrreplay, UCVwi8UAeS2o_5HpVuDlH4uw)
Created 2025-12-16; 3,060 subs / 750,166 views / 93 videos, all long-form, on 2026-09-28 (Data API). Last upload
2026-04-18. Measured series: 974 (2026-01-25), ~1,310 (2026-02-02), ~2,740 (2026-03-25), ~3,030 (2026-04-25), 3,060
(live) (`R/MCSRReplay-subscriber-series-corrected.json`).
Shape: a quiet launch, then the Feinberg breakout, a peak, a high plateau, a decline, and dormancy. Titles
(`<A> vs <B> | MCSR Ranked | <Seed> Seed`) and descriptions never changed. The channel posted no Shorts and no Community
posts. **Correction:** the earlier "handle @mcsrreplays → @mcsrreplay and avatar change" was wrong. @mcsrreplays was a
different, now deleted channel with the same name (UC6C2LGg5c-WkpvZVpZxfPuQ, hook-titled xQc/Ludwig content). Evidence:
`R/wayback-20260202-at-mcsrreplays-OTHER-channel.html`.

| Window | Subs gain (rate) | Cause | Confidence |
|---|---|---|---|
| 2025-12-28 → 2026-01-01 | ~+430 (estimated, from 4.1 subs per 1K views) | Two same-day Feinberg vs Infume replays (APoNTWAPtZ0 66,319, the channel's top video; RN8lK8ye8nU 29,715), then two Feinberg videos on 1 Jan. Posted during Ludwig's first ranked streams, probably hours ahead of Vault (12-29 12:37) and Matches (12-29 20:00) | medium |
| 2026-01-25 → 02-02 | +336 (46.5/day, measured; 2x the baseline) | "Infume vs Feinberg \| Village Seed" (58,791), plus the back catalogue lifting. Older Feinberg videos earned more than half their lifetime views after 01-25. This was Ludwig's peak week (13-hour stream, new PB) | high |
| 2026-02-02 → 03-25 | +1,430 (28/day, measured) | The best month for views per upload (Feb: 10,875 across 17 uploads), with Feinberg/Infume/doogile matches at 13 to 26K. Overlaps Ludwig's Gold, Mid-Offs S3 and the Jerk-Offs | medium |
| 2026-03-25 → 04-25 | +290 (9.1/day, measured) | Uploads fell to 6 and Feinberg is absent after 03-28. The Ludwig arc ended (Jack-Offs, early Apr) | medium |
| 2026-04-25 → 09-28 | +30 (0.19/day, measured) | Dormant through the S10 playoffs, the WC and S11. The catalogue still draws ~100 views/day at ≤2 subs per 1K | high |

### MCSR Vault (@mcsr-vault, UCNRyfqtXreM3CkdtjRy_Sqw)
Created 2025-11-05; 9,290 subs / 2,963,365 views / 104 videos (4 Shorts) on 2026-09-28 (Data API). There are 13 Wayback
captures of the channel page, all read (rounded, ±10). These are edited personality videos, not full replays. 69% of
views go to Ludwig, Feinberg and Mid-Offs/Grian videos, 14.3% to Rekrap2. Changes: the description changed twice
(Ranked/PvP → "Ranked 1v1s" by 19 Dec → "Minecraft SpeedRunning" by 24 Feb) and the avatar between 23 Jun and 25 Aug.
It posts to Community (polls: a Nov 2025 post with 1.1K votes on upload frequency vs quality, and a May 2026 content
poll with 3.7K votes; `R/MCSR_Vault-posts-live.html`).
Shape: a daily launch, then the Ludwig phase, cadence plus Rekrap2, a stall, a revival, and a plateau.

| Window | Subs gain (rate) | Cause | Confidence |
|---|---|---|---|
| 2025-11-05 → 12-19 | +1,790 (40.7/day) | 26 Feinberg-centred edits in 18 days ("The Most SCUFFED Game Ever \| Feinberg vs Infume" 89,585). Growth held at 43/day through a month without uploads, on the back catalogue and search | medium |
| 2025-12-27 → 2026-01-04 | +870 (108.8/day, fastest) | Clipped Ludwig's first MCSR Ranked streams within a day: "The FUNNIEST Game Ever \| Ludwig vs Slenderman (ft. Feinberg)" 360,531 (30x the median) | high |
| 2026-01-04 → 02-15 | +2,070 (49.3/day) | Ludwig's climb to Gold followed video by video (226K PB, 202K "FINALLY GETS GOLD"), plus Feinberg vs Rekrap2 at 107K. About 2.4 subs per 1K views | medium |
| 2026-02-15 → 02-24 | +210 (23.3/day, a dip) | Mid-Offs 3 and the Jerk-Offs happened during this window. Vault posted only the draft, and the Jerk-Offs final six weeks late | low |
| 2026-02-24 → 04-13 | +2,920 (60.8/day) | No Ludwig ranked content. The drivers were 19 uploads in March and Rekrap2/lowkey games (Rekrap2 vs Lowk3y 104K, Feinberg vs Rekrap2 89K) | medium |
| 2026-04-13 → 08-01 | 12 → 4 → 3/day | 3 to 4 uploads a month. S10, WC and WR-holder videos at 3.7 to 7.4K moved nothing | medium |
| 2026-08-01 → 08-25 | +360 (15/day) | Back to 10 uploads in two weeks: Rekrap2 vs silverrruns 36K, a same-day Mid-Offs 4 video, a new avatar | medium |
| 2026-08-25 → 09-17 | +170 (7.4/day, the baseline) | The Grian Mid-Offs movie drew 103K views and no subscriber bump (about 1.2 per 1K). The "PLAYOFFS AT HOME" video was a ladder game, not S11 | medium |

Sources: `R/MCSR_Vault-uploads.json`, `R/MCSR_Vault-spike-rates.json`, `R/MCSR_Vault-notes.md`, Wayback captures of
youtube.com/@MCSR-Vault 20251115231909 through 20260917034913.

## 3. Cross-channel patterns

**What moved subscribers**
- **A mainstream creator inside MCSR, covered within a day.** Ludwig's arc lifted all three channels at once. The fastest
  channel won: Vault clipped within 24 h (109/day), and Replays probably posted the key Feinberg vs Infume match hours
  before the others (46.5/day peak). Speed mattered more than packaging: Replays used plain titles.
- **A long storyline, not a single viral video.** Ludwig's run to Gold (PB after PB) held Vault at about 50/day for six
  weeks. The one-off Grian movie (103K) converted about 1.2 per 1K. Matches' playoff co-stream re-upload got 891 views.
- **Creators who play ranked every week.** Rekrap2's games are a repeatable draw because they come up every week. A
  one-off celebrity appearance cannot be repeated.
- **Cadence.** Every channel's high-growth phase is also its high-upload phase: Vault 60/day at 19 a month, Replays
  28 to 46/day at 17 to 22 a month. Every stall matches a drop in uploads. Cadence and crossover content happen together
  in this data, so their effects cannot be fully separated.
- **Title form (views, measured).** Name-first plus a genre tail gave about 6x. A hook in front gave about 2x more. Vault's
  best-performing kind of title is "an emotion word + the players" ("SCUFFED", "MAN VS MACHINE", "Unc vs GOAT").
- **Pairs the official channel has just made famous.** For about two weeks after @MCSR_Ranked posts a star matchup at
  100K+, that pair's ranked matches do well in suggested videos.

**What did not move them**
- Official playoffs, LANs, the World Championship and a WR, when a channel covered them late, without branding, or not
  at all. No channel's spike lines up with an official MCSR event. Not one of them posted a playoff as it happened, so this
  shows that *absent or late* coverage did not help. It does not show that timely playoff coverage cannot help.
- Shorts. Matches made 3 (10.7K views at a 0.6% like rate) and dropped them. Vault made 4 (one reached 43K). Replays made
  none. We have made 0 subscribers from 3,197 Shorts views (audit, 24 Sept).
- Returning with generic titles after a break ("Top Players in a Minecraft Speedrun Match": median 292).
- A back catalogue alone. Replays still gets views and gains about 0.2 subs a day.

**Timing against the MCSR calendar.** Ranked season boundaries and playoff weeks line up with no spike on any channel
(`R/events.json`). The spikes line up with the calendar of creator-hosted streams and events (Ludwig's streams,
ASS-OFFS/Jerk-Offs/Jack-Offs, Mid-Offs, Rekrap2's sessions) and with the official channel's VOD releases. A fresh season
start (S10 in Jan 2026) overlapped Replays' peak week, so it may have helped, but that cannot be separated from Ludwig.

## 4. Playbook for MCSR Replayoffs, ranked by likely impact

1. **Keep posting every day through Oct to Dec, and never go quiet.** This is the best-supported lesson in the data (all
   three channels). The nightly produces one match a night, but nothing uploads until the operator saves the hooks, so the
   hooks are where a gap would open. If he is away, set `nightlyMaxRenders` to 2 before he goes and save several hooks in
   one sitting. Don't let a week pass with nothing scheduled.
2. **A crossover watch, and "post tonight" on crossover days.** When a big creator plays ranked or streams with a runner
   (Ludwig came back around 19 to 20 Sep, per Mavrik Edits MNX6guvVv7o, 139K), queue that runner's ranked matches the same
   day with "Queue for tonight" / Run now, and use the kit's editable Publish at to go out the next day instead of the next
   free 19:00 slot. Today a match takes about 40 h from being played to going public (render 03:00, hooks, next 19:00
   slot), and Replays' edge was hours. The only code needed is optional: add the official @MCSR_Ranked channel (and
   Ludwig's clip channels) to what the suggestions read, next to `rivalChannelHandle`, and raise the score of pairs that
   just appeared there.
3. **Put the recognisable players first, and cover more than one of them.** Choose matches by player recognition
   (Feinberg, Infume, doogile, edcr, lowkey/Skycrab, silverrruns, and Rekrap2 whenever both POVs are on Twitch) ahead of
   raw elo closeness. Keep at least four names in rotation so one player's break does not stall the channel, as it did
   for Replays. This is consistent with our own data: edcr vs doogile brought 26 of 49 long-form subscribers.
4. **Follow the official channel's releases.** When @MCSR_Ranked posts a 100K+ VOD of a pair, have that pair's latest
   ranked match up within about 3 days. In the hook, point to the rivalry ("REMATCH", "AFTER THE QUARTERFINAL"), without
   a result.
5. **Turn the reach into subscribers.** The whole genre loses conversion as reach grows. What converted was recurring
   storylines, so build them. Matchup playlists already exist (created on a pair's second video); make those the
   end-screen target and the pinned comment's "next match of this rivalry" link. Keep the mid-roll subscribe line and the
   first-minute fixes from the 24 Sept audit. End screens are still undone, and that is Studio work.
6. **Keep the title form and test hook styles one at a time.** Our format already matches Matches' 6x + 2x form. Use
   Studio Test & Compare for the hook style, not the structure. Don't copy Matches' `#ludwig #xqc` hashtag stuffing on
   videos those players are not in: it is misleading metadata and a policy risk.
7. **Playoffs: post the day after each game day, or accept that the series is not a growth play.** Nobody in the genre
   has covered an official playoff promptly. The S11 series went up two weeks after the Round of 16, and the audit
   measured series videos at 84 views against 2,095 for the pair's ranked video. For the S12 playoffs, render each game
   night's series the next morning (`npm run series` in the daytime), keep the no-score rule, and post them at the series
   slot while the bracket is live. The Jerk-Offs final, posted six weeks late, is the example of what late posting earns.
8. **Treat Shorts as extra reach.** No channel in this genre has converted Shorts into subscribers. Keep the automated
   chain, but don't spend operator time on Shorts that could go to long-form hooks.
9. **Cheap extras:** one Community poll a month ("which rivalry next?"; Vault's drew 1.1K to 3.7K votes). A creator-event
   video ("every death at Mid-Offs") only if it goes up during the event weekend.

**Avoid:** multi-week breaks; generic titles; re-uploading someone else's co-stream or clipping their stream (891-view
flop, and a reused-content risk for YPP); relying on one player; name-dropping creators who are not in the video.

**Next 3 months (Oct to Dec 2026), the calendar as far as it is known:**
- S12 ranked ladder: running now, presumably, after S11 ended on 27 Sept (estimated; the day is not confirmed). Ladder
  matches are the whole supply.
- S12 playoffs: probably about mid-Jan 2027, outside the window (estimated from the four-month cycle: S9 Jan 11 to 19,
  S10 May 9 to 17, S11 Sep 12 to 27). Prepare the day-after-each-game-day series flow in December.
- Ludwig: back on ranked around 19 to 20 Sep. Whether this becomes an arc is the biggest unknown and the biggest upside
  (see gaps). Late December is the anniversary of his 2025 arc, which is not evidence it will repeat.
- Mid-Offs 5: probably about Feb 2027 (estimated from Feb and Aug 2026). The World Championship was in June 2026; the
  2027 one is unannounced.
- Rival slots: Matches publishes daily at 19:00 UTC, the same slot as ours, and often posts the same top pairs. The rival
  posts check already moves a match Matches has posted down our list. Keep that on.

## 5. Gaps for the operator to fill

1. Is Ludwig's September return a one-off or a new arc? Did anyone (Feinberg, Ludwig, Rekrap2) share a Vault, Replays or
   Matches video on Discord, X or on stream around 26 Dec to 4 Jan or 25 Jan to 6 Feb?
2. Who runs each channel (Vault: Discord "mcsrvault", editor @legendarygw; Matches: mcsrmatches@gmail.com), and are they
   connected to Feinberg's community?
3. Why did Replays stop on 18 Apr and Matches go quiet Feb to May: burnout, claims, strikes, or runners asking for
   removal? If it was claims or strikes, we face the same risk.
4. Does the MCSR Ranked team or Discord have a policy on third-party replay channels using players' POVs?
5. Dates at the day level for the S12 playoffs, Mid-Offs 5, and anything Ludwig or Rekrap2 plan to host this autumn.
6. Is the Skycrab 6:39 WR (~27 Jul) right? It comes from an aggregator only.
7. Did Feinberg really play less ranked from April to July 2026?

## 6. Data caveats

- **Free data only.** Social Blade blocks direct fetches (403) and was never archived for any of the three. Playboard and
  NoxInfluencer keep their history behind a paywall. So there is **no daily subscriber series** for any channel.
- **Subscriber points** are YouTube's rounded display (3 significant figures, ±10) read from Wayback captures of channel
  pages, watch pages and channel shelves. Only the 28 Sept figures are exact (Data API). Windows between points are 8 to
  42 days wide (Vault) or months wide (Matches), so where a spike falls inside a window is **inferred** from upload dates.
- **View proxies:** a video's view count today is its lifetime total, not its launch-week total. "Spikes" on Matches are
  measured in views and are not measured subscriber effects.
- **Estimated points:** Replays' ~+430 for 28 Dec to 1 Jan (views × lifetime conversion), Matches' ~10/day during its
  active run, the date of Vault's avatar change, and the "8.29K" Google snippet for Vault.
- **Confounding:** cadence and crossover content rose and fell together on every channel.
- Community-tab history exists only for Vault (live). Matches' and Replays' tabs read "unavailable". Some event dates
  (Mid-Offs, Jerk-Offs, WC 2026 details, the Skycrab WR) come from search summaries because Liquipedia returned 403.
- Our figures: channels.list on 2026-09-28. Earlier rates come from the 24 Sept audit
  (`~/.claude/projects/-app/research/audit-2026-09-24/`).
- API use across all jobs: about 25 units. search.list was not used.
