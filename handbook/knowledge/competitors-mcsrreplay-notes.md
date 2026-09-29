# @MCSRReplay research notes (2026-09-28)

Scope: read-only research on one competitor, "MCSR Replays" (YouTube channel id
`UCVwi8UAeS2o_5HpVuDlH4uw`, handle `@mcsrreplay`). All calls were reads through the repo's
`dataApiGet` client plus free public web sources (Wayback Machine, live YouTube page fetches,
one WebSearch). No writes, no posts, no config/repo edits. API usage: `channels.list` x2,
`playlistItems.list` x2, `videos.list` x2 = 6 units, well under the 500-unit budget.

## 1. Channel facts (measured, YouTube Data API, 2026-09-28)
- Title: "MCSR Replays" · handle `@mcsrreplay` · id `UCVwi8UAeS2o_5HpVuDlH4uw`
- Created: 2025-12-16T04:06:52Z
- Subscribers: 3,060 · Total views: 750,166 · Videos: 93
- Description (unchanged in every reading, live and archived): "Channel meant to archive 1v1
  MCSR speedruns of high level players who are streaming. The videos, thumbnails, stats, and
  overlay are all automatically generated. If there is any runner that I have posted and wish
  to be removed, please contact me and I'll happily delete all videos featuring you..." -- i.e.
  it is explicitly framed as an automated archive channel, not a curated/produced one, and
  content is opt-out on request rather than opt-in.
- Community tab: live-fetched 2026-09-28, returns "This Community isn't available" -- the
  channel has never used Community posts. `posts` is empty for this reason, not for lack of
  searching.
- No custom banner image found in any snapshot (grepped for banner URLs in three separate
  Wayback captures, none present) -- likely running YouTube's default banner throughout.
- No dedicated X/Twitter account found (one WebSearch, best effort); MCSR's community X presence
  (`@MCSR_Ranked`, `@mcsr_chatters`, etc.) is the mod/community's, not this channel's.

## 2. Uploads (measured, 93/93 videos via uploads playlist -> videos.list)
File: `MCSRReplay-uploads.json` (id, publishedAt, title, durationSec, views, likes, comments,
isShort). All 93 are long-form (durationSec 447-1553s, i.e. ~7:30-25:50); **zero Shorts** --
no video under 180s, none tagged `#shorts` in title or description. This channel has never
tried Shorts.

Cadence by month:
| Month | Uploads |
|---|---|
| 2025-12 | 26 |
| 2026-01 | 22 |
| 2026-02 | 17 |
| 2026-03 | 22 |
| 2026-04 | 6 |
| 2026-05 .. 09 | **0** |

**The channel has posted nothing since 2026-04-18** (its 93rd and last upload, "Infume vs
silverrruns | Shipwreck Seed"). That is over five months of silence as of this report
(2026-09-28). Format never changed in the active period: same title pattern throughout
(`<Player A> vs <Player B> | MCSR Ranked | <Seed> Seed`), same automated-overlay style the
description promises, no visible pivot to Shorts, series branding, or thumbnail-style change
detectable from the metadata alone (thumbnail *images* were not pulled -- see Data gaps).

## 3. Subscriber history (mixed measured/estimated -- see `MCSRReplay-subscriber-series.json`)
Free sources checked:
- **Social Blade**: blocked. Live page returns HTTP 403 (bot-walled); Wayback Machine has
  **zero** archived snapshots of Social Blade's page for this channel (`socialblade.com/youtube/
  channel/UCVwi8UAeS2o_5HpVuDlH4uw` and the `/handle/mcsrreplay` variant both return empty CDX
  results) -- the channel is too small/new for Social Blade to have been crawled there. No data
  available from this source at all.
- **ViewStats / Playboard / Noxinfluencer**: not queried this pass (budget/time; flagged as a
  gap below) -- worth a follow-up if the operator wants a second free source cross-checked.
- **Wayback Machine snapshots of the channel page itself** (`web.archive.org/cdx/search/cdx`,
  then reading each snapshot's embedded `subscriberCountText`): this is where the series in
  `MCSRReplay-subscriber-series.json` comes from. Only **6 crawls total exist**, spanning
  2026-01-25 to 2026-04-25 -- nothing before (the channel is not covered further back than 40
  days after its creation) and **nothing since 2026-04-25**, i.e. Wayback stopped bothering to
  recrawl it at roughly the same time the channel stopped uploading.

Best-available series (oldest first): 974 subs (2026-01-25, 45 videos) -> [189 subs / 12 videos
under the *old* handle `@mcsrreplays`, flagged unreliable for its Feb-2 timestamp, see the JSON
note -- it almost certainly reflects a much earlier state, plausibly mid/late December 2025] ->
2,740 subs (2026-03-25, 85 videos) -> 3,030 subs (2026-04-25, 93 videos) -> 3,060 subs
(2026-09-28, measured now, still 93 videos).

## 4. Channel changes found
- **Handle changed**: `@mcsrreplays` (plural) -> `@mcsrreplay` (singular), some time before
  2026-01-25 (the earliest snapshot already shows the new singular handle). The plural handle
  404'd by 2026-03-08 (Wayback: `web.archive.org/web/20260308042820/https://www.youtube.com/
  @mcsrreplays` -> HTTP 404), confirming the old handle was released/retired, not just aliased.
- **Avatar changed** alongside the handle: the `nZm7NHon...` avatar (seen only in the anomalous
  Feb-2/old-handle snapshot) was replaced by the `f6kL3YIQ...` avatar that appears in every
  snapshot from 2026-01-25 onward and is still the current avatar today. Consistent with a
  rebrand done very early, close to launch.
- **No description change** detected in any reading (live today vs. three separate archived
  snapshots, verbatim identical).
- **No format change** detected across the upload log: no Shorts introduced, no title-pattern
  change, no visible cadence policy change other than the outright stop after April.
- **The channel went dormant on 2026-04-18** and has stayed dormant for over 5 months --
  this is the single largest "change" and almost certainly the most important fact for a
  growth-playbook comparison: whatever caused the stop (operator burnout, a tooling/legal issue,
  the runner opt-out clause being invoked repeatedly, or something else) is not visible from
  public data. Flagged as a question for the operator / Discord follow-up.

## 5. Spikes -- investigated against the upload log
The clearest "spikes" are in views per video, not in any independent traffic-source data (no paid
Analytics access to a channel we don't own, so this is inference from public view counts only):
- **2025-12-28**: two uploads the same day, "Feinberg vs Infume | Ruined Portal Seed" (66,319
  views, the channel's all-time top video) and "Feinberg vs Infume | Desert Temple Seed" (29,715
  views) -- together ~13% of the channel's lifetime views from one day's uploads, 12 days after
  launch. This is almost certainly the channel's breakout moment and plausibly drove the bulk of
  its December->January subscriber growth (974 by Jan 25 from a presumably much smaller December
  base -- exact December-end count is not recoverable, no snapshot exists for it).
- **2026-01-27**: "Infume vs Feinberg | Village Seed" (58,791 views) -- a second Feinberg/Infume
  matchup, second-highest video on the channel. The same pairing (Feinberg vs Infume) accounts for
  3 of the channel's top 4 videos by views, suggesting matchup/player recognisability (not seed or
  format) is this channel's main traffic driver.
- **Subscriber growth is heavily front-loaded**: the largest jump in the trusted series is
  Jan25->Mar25 (974 -> 2,740, +1,766 over 2 months), tapering to Mar25->Apr25 (+290 over 1 month)
  and then flat Apr25->Sep28 (+30 over 5 months, i.e. essentially zero growth once uploads
  stopped). This tracks the upload cadence almost exactly (22, 17, 22, then 6-and-stop uploads/
  month) -- there is no evidence of a spike disconnected from upload activity; growth here looks
  upload-driven, not virality- or platform-driven, apart from the two December/January outlier
  videos above.
- No MCSR community event (a specific tournament, patch, or Ranked season boundary) was
  correlated to these dates in this pass -- that cross-reference needs the community-events
  research the parent task is assembling separately; this subagent only had budget/scope for the
  @MCSRReplay channel itself.

## 6. Data gaps / what is estimated vs measured
- **Measured** (Data API, live, cite-able to this run): channel snippet/statistics/branding,
  every upload's id/date/title/duration/views/likes/comments, current subscriber count.
- **Measured** (Wayback snapshot content, verbatim numbers as YouTube rounded them): the 4
  trustworthy points in the subscriber series (Jan 25, Mar 25, Apr 25, plus today).
- **Estimated / flagged uncertain**: the Feb 2, 2026 reading (189 subs / 12 videos) -- kept in
  the series file with an explicit `estimated: true` and a note, rather than silently dropped or
  silently trusted.
- **Not obtained this pass** (gaps, not silently assumed):
  - No subscriber count for the true launch window (2025-12-16 to 2026-01-24) -- no snapshot
    exists; the actual December growth curve is unrecoverable from free public sources.
  - Social Blade has no data for this channel at all (blocked live, empty in Wayback).
  - ViewStats/Playboard/Noxinfluencer were not checked this pass.
  - Thumbnail *images* were not downloaded/diffed for a style-change read; only titles/metadata
    were compared.
  - No banner image was found anywhere, so "did the banner ever change" is answered as "not
    found in any capture," not "confirmed never changed."
  - No X/Twitter account found for the channel itself (one search, best effort per the
    operator's brief).
