# MCSR Vault — competitor research notes (28 Sept 2026)

## Channel identification
Searched `search.list(type=channel, q="MCSR Vault")` (YouTube Data API). Top result:
- **UCNRyfqtXreM3CkdtjRy_Sqw**, title "MCSR Vault", description "The Best of Minecraft
  Speedrunning. #MCSR #MinecraftSpeedrunning #MinecraftPvP #1v1 #Ranked #MCSRduel #MCSRvault" —
  unambiguous MCSR branding, picked over 9 other results (a Ludwig VODs channel, a PeteZahHutt
  VODs channel, etc. — irrelevant).
- Handle: `@mcsr-vault`. Created **2025-11-05** (`channels.list` snippet.publishedAt).
- Current (28 Sept 2026, Data API, exact): 9,290 subscribers, 2,963,365 views, 104 videos.

## Files
- `MCSR_Vault-channel.json` — raw `channels.list` response.
- `MCSR_Vault-uploads-raw.json` — raw `videos.list` for all 104 uploads.
- `MCSR_Vault-uploads.json` — simplified, sorted oldest→newest: id, publishedAt, title,
  durationSec, views, likes, comments, isShort (≤180s or #shorts).

## Subscriber history (free sources)
Social Blade's channel page returned HTTP 403 to a direct fetch (blocked outside a browser) and
its own CDX-indexed pages were not found in Wayback either — **no Social Blade data available**.
Fell back entirely to **Wayback Machine snapshots of youtube.com/@mcsr-vault** (its
`archive.org/wayback/available` endpoint; the `web.archive.org/cdx/search/cdx` API itself was
returning connection timeouts/an IA outage page for the whole research window — a genuine IA-side
degradation, confirmed by `archive.org`'s "Temporarily Offline" banner on other calls, not a
sandbox network issue). Read YouTube's own rounded "N subscribers" string baked into each
snapshot's page data (`ytInitialData`). YouTube rounds to 3 significant digits, recorded as
shown — every point below except the 28 Sept live one is **rounded, not exact**.

| Date | Subscribers (as YouTube showed it) | Source |
|---|---|---|
| 2025-11-15 | 326 | Wayback snapshot of channel page |
| 2025-12-19 | 1.79K | Wayback snapshot |
| 2025-12-27 | 1.98K | Wayback snapshot |
| 2026-01-04 | 2.85K | Wayback snapshot |
| 2026-02-15 | 4.92K | Wayback snapshot |
| 2026-02-24 | 5.13K | Wayback snapshot |
| 2026-03-09 | 5.97K | Wayback snapshot |
| 2026-04-13 | 8.05K | Wayback snapshot |
| 2026-05-16 | 8.45K | Wayback snapshot |
| 2026-06-23 | 8.61K | Wayback snapshot |
| 2026-08-01 | 8.73K | Wayback snapshot |
| 2026-08-25 | 9.09K | Wayback snapshot |
| 2026-09-17 | 9.26K | Wayback snapshot |
| 2026-09-28 | 9,290 (exact) | YouTube Data API, live, today |

No earlier snapshot exists before 2025-11-15 (channel was created 2025-11-05, so this is close to
day 10). No snapshot found between the listed dates and later gaps (e.g. nothing between
04-13 and 05-16, or 06-23 and 08-01) — those months' curve shape inside the gap is interpolation,
not measurement.

## Spike investigation — cross-referenced against the upload list
The subscriber curve has one clear regime change: **explosive growth from creation through
mid-April 2026 (326 → ~8.05K, +7.7K in 5 months), then a plateau (8.05K → 9.29K, +1.24K in the
following 5.5 months — roughly 6x slower)**. Matching this against per-video view counts and
monthly averages (computed from `MCSR_Vault-uploads.json`) points to one driver:

- **Ludwig Ahgren crossover content.** Every month with outsized average views (Dec 2025 – Mar
  2026: 30–78K avg views/video, vs 5–13K in the ranked-only months) contains a video with "Ludwig"
  in the title, all far above the channel's typical few-thousand-view ranked upload:
  - 2025-12-26 "The FUNNIEST Game Ever | Ludwig vs Slenderman (ft. Feinberg)" — 360,531 views,
    11,543 likes (the single biggest outlier in the whole upload history, ~30x a typical video).
  - 2026-01-28 "Ludwig Gets an INSANE NEW PB (ft Infume & Feinberg)" — 226,462 views.
  - 2026-02-06 "LUDWIG FINALLY GETS GOLD IN MCSR RANKED" — 201,807 views.
  - Also 2026-01-05, 01-09 (via "MCSR ASS-OFFS" branding tied to the same crossover), 01-26,
    01-28 (a second Ludwig video same day), 02-10 (a Ludwig Short, 41,013 views).
  - These cluster exactly in the five months the subscriber curve climbs steepest (late Dec
    through mid-March/April), and every one of them dwarfs the channel's normal ranked-1v1
    upload (typically 5K–20K views). The subscriber count roughly 6x'd (1.4K→8K) across this
    window.
  - The last Ludwig-titled upload is 2026-04-06 ("THE CRAZIEST MATCH OF MCSR | Supertf VS Liam
    (ft Feinberg) | LUDWIG'S..."). From April onward no more Ludwig content appears, and the
    subscriber growth rate drops sharply the same month.
- **A second, smaller celebrity-crossover spike**: 2026-08-29 "Grian Becomes a SPEEDRUN PRODIGY
  (FULL MOVIE)" — 103,077 views (Grian is a major Minecraft YouTuber). This lands inside the
  Aug 2025→Aug 2026-08-25 window (9.09K) and the 09-17 point (9.26K) shows only ~170 net new
  subscribers in the following three weeks — a far lower apparent conversion than the Ludwig
  videos got, though this is a smaller sample (one snapshot before, one after) and conversion may
  simply lag past 09-17; **this comparison is suggestive, not conclusive** — no snapshot exists
  between the two to see the shape of that response.
- Upload cadence itself also tracks the same curve: 26 uploads in Nov 2025 (near-daily) down to
  3–4/month May–July 2026, ticking back up to 12 in August (coinciding with the Grian video and a
  short revival in views). The plateau in subscribers lines up with both the loss of celebrity
  crossover content *and* a much lower upload cadence, so cadence and crossover-content are
  confounded in this data — the research can't cleanly separate how much each contributed.
- No MCSR-community-calendar event (a season launch, a Playoffs bracket date, etc.) lines up with
  the timing of these spikes as well as the Ludwig/Grian uploads do; the spikes read as
  streamer-crossover-driven, not scene-driven. (This channel's own competitive-scene coverage —
  Round of 16 from a "PLAYOFFS AT HOME" video on 2026-09-15 — is comparatively low-view, 6,347.)

## Channel changes (from Wayback snapshots + the upload list)
- **Name/handle**: unchanged throughout — "MCSR Vault" / `@MCSR-Vault` in every snapshot from
  2025-11-15 to 2026-09-17.
- **Description** changed three times:
  1. 2025-11-15: "Archiving the best of Minecraft Speedrun PvP & Ranked."
  2. 2025-12-19 – 2026-01-04: "The best of Minecraft Ranked 1v1s."
  3. 2026-02-24 – 2026-06-23: "The best of Minecraft SpeedRunning."
  4. 2026-09-17 (current): "The Best of Minecraft Speedrunning." (near-identical to #3, just
     recapitalized)
  The drift from "Ranked 1v1s"/"PvP" framing to plain "Speedrunning" lands right as the
  Ludwig-crossover growth took off (Dec–Feb) — consistent with broadening the channel's pitch for
  a bigger, non-MCSR-native audience arriving from crossover content.
- **Avatar**: unchanged (same image hash `1pkRpv_EE...`) from 2025-11-15 through at least
  2026-06-23, then a **new avatar** (`oi50kARs_Jx...`) is in place by 2026-08-25. Exact change
  date is inside the 06-23→08-25 gap — no snapshot lands closer than that.
- **Format**: first Short is 2025-12-30 ("Ludwig Loses it while playing..."). Shorts stayed rare
  throughout — only 4 of 104 uploads (≈4%) — this channel is almost entirely long-form, unlike a
  typical Shorts-driven growth channel.
- **Community posts / banner**: not captured — the `/community` page's Wayback lookup hit a
  429 (rate-limited) repeatedly during this session and I did not want to keep hammering IA's API
  after already seeing it degrade; this is a genuine gap, best-effort per the brief. Re-run
  `archive.org/wayback/available?url=youtube.com/@mcsr-vault/community` later to fill it in.
  Banner image likewise not checked (brandingSettings image URLs would need a similar Wayback
  pull the community-tab rate limit interrupted).

## What's measured vs estimated
- **Measured (exact)**: everything from the Data API — channel creation date, current stats,
  every upload's id/date/title/duration/views/likes/comments (`MCSR_Vault-uploads.json`).
- **Estimated/rounded**: every subscriber-count point except 2026-09-28 — these are YouTube's own
  3-significant-digit display, read out of archived HTML, not exact counts. The shape of the
  curve (explosive → plateau) is solid; the exact week a threshold was crossed is not.
- **Not obtained**: Social Blade history (blocked/not archived), community posts, banner image
  history — flagged above as gaps for the operator to fill from Discord/inside knowledge or a
  retried Wayback pull.
