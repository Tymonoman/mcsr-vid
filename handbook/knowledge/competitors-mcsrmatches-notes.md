# @mcsrmatches — competitor research notes (2026-09-28)

Scope: read-only. No writes to /media, no repo/config edits, no posts. YouTube Data API used
read-only through the repo's own client (`dataApiGet`, `/app/src/youtube/youtube.ts`), total
~10 units spent (1 `channels.list` + 3 `playlistItems.list` pages + 3 `videos.list` batches of
50), well under the 500-unit budget. `search.list` was not needed at all.

## 1. The channel (measured, YouTube Data API, 2026-09-28)

- Name: **MCSR Matches**, handle `@mcsrmatches`, channel id `UCD4mMby1i-Lz2huxfMMWfLA`.
- Created: **2025-09-13T16:47:10Z** (`snippet.publishedAt`).
- Current stats: **1,640 subscribers**, **422,692 total views**, **129 videos** (`statistics`, live).
- Description: "Contact me: mcsrmatches@gmail.com … Minecraft Speedrunning Ranked …" — a
  one-person/small operator channel, not obviously a studio.
- Uploads playlist: `UUD4mMby1i-Lz2huxfMMWfLA`.

## 2. Every upload

Saved in full to `mcsrmatches-uploads.json` (129 rows: id, publishedAt, title, durationSec,
views, likes, comments, isShort) — measured via `playlistItems.list` (uploads playlist) →
`videos.list` (`part=snippet,statistics,contentDetails`, batches of 50). `isShort` = duration
≤180s or "#shorts" in title/description. Only **3 of 129 uploads are Shorts**
(2025-11-22, 2025-12-31, 2026-01-15) — this channel is almost entirely long-form, unlike the
Shorts-heavy competitor set the operator asked about elsewhere.

## 3. Subscriber history since creation — data gap, stated plainly

**There is no usable free historical subscriber chart for this channel.** I checked every
source the brief named and all came back empty or near-empty; this is a genuinely new, small
channel and it was barely archived:

- **Social Blade**: I checked `socialblade.com/youtube/channel/<id>`, `/youtube/handle/mcsrmatches`,
  `/youtube/user/mcsrmatches`, and the `www.` variant against the Wayback Machine's CDX API
  (`web.archive.org/cdx/search/cdx?url=...`) and the availability API
  (`archive.org/wayback/available?url=...`). **Zero snapshots exist for any of them, ever.**
  Fetching the live Social Blade page directly also fails (HTTP 403, bot-blocked) — no way to
  even confirm today's number from Social Blade specifically.
- **youtube.com/@mcsrmatches**: CDX shows exactly **one** real (HTTP 200) snapshot in the
  channel's entire history: **2026-06-28T14:19:38Z**. Three earlier hits
  (2026-01-09, 2026-01-29, 2026-05-22) are all HTTP 301 redirect captures with no page content.
  `/@mcsrmatches/about`, `/@mcsrmatches/community` and `/channel/<id>` have **no snapshots at
  all** (availability API confirms `archived_snapshots: {}` for each).
- **Playboard.co** (free, live page): current numbers match the Data API
  (`subscriberCount:1640, playCount:422692`) but its embedded historical trend array is
  explicitly empty (`subscriberTrend={rows:[],...}`) without a paid account.
- **NoxInfluencer** (free, live page): loads but is a client-rendered SPA with no historical
  series embedded in the HTML I could fetch.

So the only dated subscriber points I can defend are:

| date | subscribers | source | measured/estimated |
| --- | --- | --- | --- |
| 2025-09-13 | 0 | channel creation timestamp, Data API `snippet.publishedAt` | estimated (every channel starts at 0; not independently observed) |
| 2026-06-28 | ~1,100 ("1.1k") | Wayback snapshot `web.archive.org/web/20260628141938/https://www.youtube.com/@MCSRMatches` (saved as `snapshot-20260628.html`), YouTube's own rounded on-page counter | measured, but YouTube rounds to 3 significant digits as stated in the brief — "1.1k" could be anywhere ~1,050–1,149 |
| 2026-09-28 | 1,640 | YouTube Data API, `channels.list.statistics.subscriberCount`, live | measured, exact |

Full series (3 points) in `mcsrmatches-subscriber-series.json`. **I could not identify or
investigate individual subscriber-count spikes** for this channel — there is no dated series
granular enough to show one. What follows is the best available substitute: per-video **view**
counts (which I have in full, all 129 videos, exact) read against the channel's own format
changes and the MCSR community calendar — a defensible proxy for "what likely drove growth,"
clearly labeled as a proxy, not a measured subscriber effect.

## 4. Community posts

**None found.** The live Community tab (fetched 2026-09-28) returns YouTube's own message
"Ta Społeczność jest niedostępna" ("This Community is unavailable" — served in Polish by
region default) — the channel has no Community tab content, or it is disabled. Wayback has no
snapshots of `/community` to check historically either. Saved raw fetch as
`community-live.html` for the operator to re-check by hand if the tab is region- or
login-gated in a way I couldn't see.

## 5. Channel & format changes — from the upload list itself (measured) + one snapshot

No name/handle/avatar/banner change is visible in the one Wayback snapshot vs. today (channel
title "MCSR Matches" / handle `@mcsrmatches` match on both). The real, measurable changes are
in **upload cadence and title/thumbnail-hook style**, read straight off `mcsrmatches-uploads.json`:

- **2025-09-13** channel created — 6 days after MCSR Ranked **Season 8 Playoffs** (Aug 31–Sep 7,
  2026 event calendar entry `events.json`, sourced separately). Plausible trigger for starting
  the channel, though the first video didn't post for another **7 weeks**.
- **2025-11-04**: first upload, plain format "`X vs Y MCSR Ranked Season 9 #N`", sequentially
  numbered, near-daily through late November.
- **2025-12-27 → 2026-02-05**: numbering restarts loosely, titles drift to "Latest Match" /
  "Speedrunning Minecraft" phrasing; season tag dropped once **Season 9** ended
  (per the community events file, Season 9 Playoffs ran 2026-01-11–01-19, matching when the
  "Season 9" tag disappears from titles around Jan 5).
- **Two outsized spikes in this early window, both explained by a name, not a format**: the
  channel's two highest-viewed videos before September were **"Private Match Ludwig vs
  Feinberg"** (2026-01-25, 11,171 views) and the untitled follow-up **"A Fun Match Between
  Feinberg / Infume / Doogile"** (2026-01-30, 18,149 views — the single highest-viewed video in
  the channel's history). "Ludwig" reads as a crossover appearance by a much larger streamer
  (the video title names him ahead of the MCSR players); that one collaboration produced the
  channel's two best-performing videos to date, well above the ~2,000-view baseline of the
  surrounding uploads. I could not verify independently (best-effort, no X/Twitter or Discord
  access) whether this is *the* Ludwig or a namesake — flagging as **estimated**, not confirmed.
- **2026-02-05 → 2026-05-02**: a near-total **hiatus** — 1 video in March, 0 in April, 1 in May.
  This gap spans the **Season 10 Playoffs** (May 9–17, 2026) entirely; the channel posted
  nothing around them and missed that traffic window.
- **2026-06-03**: uploads resume, ~2.5 weeks after Season 10 Playoffs ended — cadence restarts
  at a lower baseline (views mostly 100s–1,000s through June/July), title format now
  "MCSR Ranked X vs Y Minecraft Speedrun #N", still no emoji/hook.
- **2026-08-06** ("Feinberg vs Infume | MCSR Ranked | Minecraft Speedrun"): titles move to the
  `HOOK | X vs Y | MCSR Ranked | Minecraft Speedrun` pattern with capitalized emoji hooks
  ("CRAZY ENDING !!", "6:42 🤯", "SUB 7") from mid-August on. This is the clearest, best-evidenced
  change in the whole dataset: **average views per long-form video roughly 2.5x'd**, from
  ~2,150 (82 videos before 2026-08-06) to ~5,440 (44 videos from 2026-08-06 on), sustained for
  seven-plus weeks through the data's end (2026-09-27), not a one-off. This lines up with almost
  exactly the same finding our own channel's Sept 2026 audits made about rivalry/hook-style
  titles outperforming descriptive ones — it looks like an independent discovery of the same
  lever, roughly a month or two after MCSR Replayoffs applied it.
- **No upload names or covers the Season 11 Playoffs (2026-09-12–09-27) as playoffs** — no
  bracket, round or "playoffs" language anywhere in the 129 titles; every September 2026 upload
  reads as an ordinary ranked match. Views through that window (2,664–13,325) sit inside the
  post-Aug-6 baseline, no distinguishable playoff bump. Playoffs branding is not this
  channel's territory the way it is ours.
- **Thumbnail style**: not independently checked (Data API doesn't return thumbnail *content*,
  only URLs, and reading a thumbnail's visual style at scale was out of the read-only/low-unit
  budget here) — worth a manual look if the operator wants it.

## Files in this directory (mine)

- `mcsrmatches-uploads.json` — all 129 uploads, full fields.
- `mcsrmatches-subscriber-series.json` — the 3-point series above.
- `snapshot-20260628.html` — the one Wayback capture of the channel page (raw HTML, "1.1k
  subscribers" confirmed by grep).
- `community-live.html` — raw fetch of the live Community tab showing "unavailable."
- `events.json`, `MCSRReplay-*`, `MCSR_Vault-*` — other competitors' files from sibling research
  jobs in this same directory; not mine, left untouched.
