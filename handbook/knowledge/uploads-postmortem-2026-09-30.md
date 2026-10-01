# Every upload so far: what we did wrong (30 Sept 2026)

Scope: the 33 long-forms and 20 Shorts on the channel (53 videos, 44 public) on 30 Sept 2026, about 22:30 UTC. Analytics and the CTR report end on 28 Sept and count Pacific days; "day 0" is the Pacific day a video went public and "day 1" the next. Seven analysts wrote 44 findings and verification stopped at a usage limit, so I recomputed every number below from the night's dataset. **Checked** means my script reproduced it. **Unverified** means I could not, or the number holds and its cause is a reading of the data. One skeptic verdict exists (subscribers with no video) and is applied.

## The short version

Ranked by cost, largest first. Cost estimates are my arithmetic on small samples.

1. **Empty days.** 11 of the first 21 days of September had no long-form. From 9 to 28 Sept a launch day averaged 3.79 gross subscribers and 3,575 views; the 6 days without one, 2.17 and 2,180. Cost: about 15 subscribers and 13,000 to 18,000 views in September (estimate). Fix: keep the queue two deep, save hooks in one sitting, `nightlyMaxRenders` 2. Who: operator, a setting. Counts checked; cost unverified.
2. **The second slot went to series.** Eight series, 22 Sept to 1 Oct. Since 14 Sept a ranked launch returned 2.0 subscribers and 3,513 views (11 launches), a series 1.2 and 1,046 (5). Four of five series drew 600 impressions or fewer on day 0 (ranked median 2,235). Cost: at most about 6 subscribers and 20,000 views across the eight. Fix: series only for named players; the 23:00 slot to a second ranked match or nothing. Who: operator (`nightlySkip`), code (`publishSlotFor`). Figures checked; cause unverified.
3. **We steered by views.** Weekly views rose 10.4 times from 24-30 Aug to 21-27 Sept, gross subscribers 1.5 times; subscribers per 1,000 views fell from 7.0 to 0.98. Browse (Home and the subscriptions feed) went from 67% of views on the August uploads to 90% since 14 Sept, at 1.0 minute a view instead of 1.9. Cost: reach read as progress; at the 28-day pace 1,000 lands 3 Nov 2027. Fix: the morning report and `/stats` lead with weekly net subscribers and subscribers per 1,000 engaged views. Who: code. Checked; the audience change is an inference.
4. **One event paid for 23% of all subscribers.** FtJ-VEv6pgk (edcr vs doogile, 26 Aug) brought 26 of 111 gross subscribers, in a breakout driven from outside the channel (its top Suggested source was another channel's video). The 19 shares on 26 long-forms are 0.32 per 1,000 views, and the analysts found no runner DM sent (unverified). Cost: one more event that size is about 25 subscribers (one case). Fix: send the kit's DMs, two or three a week, and ask each runner's OK to keep posting. Who: operator. Unverified.
5. **Nothing sends a viewer onward.** On the 26 long-forms with Analytics, end screens brought 34 views and playlists 42; Suggested viewers watch 4.1 minutes a view, Browse viewers 1.15. 36 of 111 gross subscribers (32%) are credited to no video, which points at the channel page. Cost: unmeasured, a few subscribers a month at best. Fix: end screens on public long-forms and a Related video link on each live Short (Studio); the pair's playlist in the description and pinned comment (code). Who: operator, code. Traffic and attribution checked; that no end screen exists is unverified.
6. **Two weeks of packaging work for numbers it does not move.** Since 14 Sept the 90 s subscribe line shows 13 subscribers on 9 long-forms (2.3 per 1,000 engaged views) against 15 on 7 without (1.9); the teaser, 5 s intro and new thumbnails show nothing yet either. With 28 events, effects under about 2 times are invisible. Cost: render time and operator decisions. Fix: stop iterating on meta-column stills; compare groups of 5 or more videos at a matched engaged share. Who: operator. Groups checked; each change's effect unverified.
7. **Shorts judged on views.** 11 Shorts with Analytics: 11,711 views, 4 subscribers (0.34 per 1,000; long-forms 1.21). On 17-28 Sept they were 22% of channel views, 9% of subscribers and 1.7% of watch minutes. No long-form view is credited to a Short. The 4 is a floor: a channel-page subscribe has no video to credit. Cost: operator minutes and a model watch per match. Fix: keep cutting for reach, drop Shorts from every YPP projection, set Related video on live Shorts. Who: code, operator in Studio. Checked.
8. **Lifetime CTR read as a verdict on titles.** Ranked uploads since 9 Sept have a median CTR of 7.6% on day 0 and 3.4% on day 1, so the top lifetime CTR (8.28%) sits on a video with 4,566 impressions. 58 MILLISECONDS looked like a flop on 2,610 impressions, which is 12 hours of data; on that window it is 5th of 14 evening launches and at the median CTR. Cost: decisions. Fix: print the age beside every CTR and rank only matched windows; do not retitle 58 MILLISECONDS. Who: code. Checked.
9. **Plans built on numbers that do not hold.** The panel and the 07:00 report project subscribers from the last 7 days (a 12-upload week): 1,000 on 21 May 2027, against 3 Nov 2027 on the 28-day pace. 1 Feb 2027 does not bind: 8,000 hours land 2 Dec 2026 to 13 Feb 2027, and no pace the channel has run puts 1,000 before 8 Apr 2027. The 1.8 per 1,000 views target is about twice the last two full weeks' rate (1.05 and 0.98). Fix: project from the 28-day pace or print the range; replace the 7.3-a-day paragraph and the 1.8 target in `channel.md` and `chat-analyses.md`. Who: code, docs. Checked.
10. **Nickname hooks a cold viewer cannot read.** "LOVERBOY vs TAS" sits on two videos with different second players; read by position, "TAS" stands for four players across seven titles since 9 Sept. 12 of the 14 ranked titles from 9 to 28 Sept are nickname pairs. Cost: unmeasured, because players and hooks changed together. Fix: one nickname per player and a line about the match beside it. Who: operator at hook time; code (`hookProblem` warns on reuse). Reuse checked; effect unverified.
11. **Debris from a deleted video.** TN0_s3y0HH8, a public Short with 780 views, says "the whole match: https://youtu.be/Edj_-c7lK38", a long-form deleted on 26 Sept; the analysts report the upload record still counts that match as uploaded. Cost: a dead end on a Short that draws search views. Fix, with the operator's OK: repoint or privatise the Short and clear the record. Who: operator, then code. Short checked; record unverified.

## The numbers that matter

Weeks run Monday to Sunday (Pacific days). Gross counts subscribers gained before losses. The Data API read 102 subscribers on 30 Sept at 22:30 UTC.

| Week | Views | Engaged share | Subscribers gained (lost) | Gained per 1,000 views | Long uploads |
|---|---|---|---|---|---|
| 17-23 Aug | 30 | 100% | 1 (1) | n/a | 3 |
| 24-30 Aug | 3,137 | 48% | 22 (1) | 7.01 | 1 |
| 31 Aug-6 Sept | 3,683 | 42% | 20 (1) | 5.43 | 3 |
| 7-13 Sept | 4,371 | 46% | 11 (4) | 2.52 | 3 |
| 14-20 Sept | 18,964 | 34% | 20 (5) | 1.05 | 4 |
| 21-27 Sept | 32,555 | 31% | 32 (5) | 0.98 | 10 |
| 28 Sept (one day) | 7,633 | 28% | 3 (2) | 0.39 | 2 |

Whole period to 28 Sept: 70,373 views, 111 gained, 19 lost, 92 net. All checked.

- The 24-30 Aug rate rests on one day: 16 of its 22 gains came on 30 Aug, the FtJ-VEv6pgk wave. Per 1,000 engaged views the fall is 14.6 to 3.1.
- The mix moved. Browse (the API's `SUBSCRIBER` row) was 67% of views on the four August uploads, 76% on the six of 2-12 Sept and 90% on the eleven ranked uploads since 14 Sept. Suggested went 25%, 16%, 6%; minutes per view 2.46, 1.82, 1.22.
- Weekly net subscribers rose 7, 15, 27 (weeks of 7, 14, 21 Sept) as long uploads rose 3, 4, 10. The Browse move came with the first rise, so uploads as the cause is unverified.

## Findings by area

### Conversion

- 36 of 111 gross subscribers (32%) have no video behind them, 33 of 108 (31%) since the channel had views; the channel page is the likeliest surface, an inference. Skeptic corrections: the weekly count is not flat (8, 5, 1, 11, 5 in the weeks of 24 Aug to 21 Sept), the daily correlations are noise, and "+5 a week if visits double" has no support. Judge it as a share over 3 to 4 weeks. Checked.
- FtJ-VEv6pgk and aAX_ML4rHdo hold 33 of the 71 long-form subscribers (46%) on 11.5% of long-form views; the other 24 convert at 0.73 per 1,000 views. Since 14 Sept, 23 of 28 long-form subscribers came on day 0 or 1; the ten uploads before 14 Sept were the reverse (38 of 43 after day 1). Checked.
- doogile, lowkey and Aquacorde convert at 4 to 7 per 1,000 engaged views, Infume and Feinberg at about 2; without FtJ-VEv6pgk doogile's other four are at 3.0. Unverified: small n, era.

### Click

- First-test size runs from 2 impressions on day 0 (d_fi9zEqcFc, 22 Aug) to 10,662 (FtJ-VEv6pgk). The same Infume and Feinberg pair got 1,175 on 24 Sept and 7,130 two days later, so names alone do not set it. FtJ-VEv6pgk's 0.58% day-0 CTR was called the channel's worst; gRjV1jG4-Ng had 0.58% too. Checked.
- Series click like ranked uploads (3.91% over days 0 and 1 on 15,410 impressions, against 3.93% on 144,375); they lose on test size and a 6 to 21% average view. Checked.
- The 26 Sept thumbnail swap cannot be read: videos older than 20 Sept drew 2,147 to 2,837 impressions a day in total on 24-28 Sept, no bump. Test and compare belongs on new uploads. Impressions checked; effect unverified.

### Retention

- 21 ranked curves (to 28 Sept): 91% still watching at 0:10, 60% at 1:00, 43% at 5:00; 8.6% of views end before 0:10 and 33.9% between 0:10 and 1:00. The 22 and 24 Sept audits put half the first-minute loss before the race; here it is 9 of 40 points, and the leak is the 20 seconds after match start (91% to 69%). A 5 s intro card (3 videos) and a 7 s one (18) read 60.8% and 60.0% at 1:00. Checked.
- Engaged share runs 24% to 68% and correlates -0.66 with retention at 1:00 (n = 21): compare videos at an equal engaged share. The newest uploads are 94 to 96% Browse. Checked.
- The finish is the second peak (40.7% at 80% of the video, 47.9% at 95%) and the post-roll, where the subscribe card sits, falls to 27.5%. Asking during the End fight is untested. Checked; effect unverified.

### Shorts

- The 8 Shorts that show the finish returned 1 subscriber (0.12 per 1,000), the 3 that stop before it 3 (0.95): 4 in all, a hint only. A name in the title brings search: HZMx38dwSSE drew 282 of 719 views from search with Feinberg and Infume in it, zSon9yOTYpM (no names) 24 of 1,097. Checked.
- The 3 model-picked Shorts with Analytics returned 2 subscribers on 2,635 views; the four cut on 29-30 Sept have none yet. Re-read on 3 Oct against 0.5 per 1,000. No long-form has a Shorts traffic row. Unverified.

### Timing

- Hour and weekday cannot be read: every hour is an era (17:00 UTC until 5 Sept, 19:00 from 9 Sept, 23:00 for series). 19:00 UTC is not contradicted. Series beside a same-player ranked video drew 2,911 and 1,940 impressions; the two without drew 9,816 and 13,244 (2 against 2, different names: a lead only). Unverified.

### SEO

- Search is 1.8% of long-form views; the terms are player names (infume 65, edcr 55, feinberg 23) and "mcsr ranked" 25, and "minecraft speedrun" has 0 in the top-10 lists (338 of 1,071 search views). The genre words in the title tail look useless: partial lists, unverified. JcDsBWo49U0 is the only series title with that tail (99 characters; the others 74 to 93). Checked.
- The Feinberg statement clip went up from Studio with no match link, no playlist, no tip jar line and 8 generic tags. Checked. 23 of 39 playlists hold one video (analysts, unverified); playlists bring 42 views (checked).

### YPP

- The ETA code reads 7 days for subscribers and 28 for watch hours, and switches the full tier to 8,000 hours on 1 Feb 2027 (`src/youtube/yppProgress.ts`). Churn: 19 of 111 gross lost (17%). Shorts add about 0.4 subscribers a day. Checked. The table and the money line follow.

## The path to 1,000

From 102 subscribers (Data API, 30 Sept 22:30 UTC), straight-line, dates good to about two days. Pace is net subscribers a day.

| Scenario | Net a day | 500 subscribers | 1,000 subscribers |
|---|---|---|---|
| Last 7 days, 22-28 Sept (27 net, 12 long uploads) | 3.86 | 11 Jan 2027 | 21 May 2027 |
| Last 14 days, 15-28 Sept (42 net) | 3.00 | 10 Feb 2027 | 26 Jul 2027 |
| Last 28 days, 1-28 Sept (63 net) | 2.25 | 26 Mar 2027 | 3 Nov 2027 |
| Data API count, 24 Sept 06:12 to 30 Sept 22:30 UTC (74 to 102) | 4.19 | 3 Jan 2027 | 2 May 2027 |
| Best 7 days on record, 30 Aug-5 Sept (33 net, the FtJ-VEv6pgk week) | 4.71 | 23 Dec 2026 | 8 Apr 2027 |
| One long-form a day at 3.75 net per upload (14-20 Sept: 15 net on 4 uploads) | 3.75 | 14 Jan 2027 | 27 May 2027 |
| 1.8 net per 1,000 views at the last 28 days' views (2,369 a day) | 4.26 | 1 Jan 2027 | 29 Apr 2027 |
| 1.8 net per 1,000 views at the last 7 days' views (5,583 a day) | 10.05 | 9 Nov 2026 | 28 Dec 2026 |
| Needed for 1,000 by 31 Jan 2027 | 7.30 | n/a | 31 Jan 2027 |
| Needed for 500 by 31 Jan 2027 | 3.24 | 31 Jan 2027 | n/a |

- The channel converts 0.69 net subscribers per 1,000 views over 7 days (27 net on 39,078 views), 0.72 over 14 and 0.95 over 28. The 1.8 target came from 7.3 a day at 4,000 views a day; only the weeks of 24 Aug and 31 Aug held it, both under 3,700 views. The 7-day row is a 12-upload week; at one long-form a day, plan on 2.25 to 3.75.
- From 1 Feb 2027 a new applicant needs 8,000 public long-form hours (or 20 million Shorts views) instead of 4,000 (10 million). Source: `channel.md`, read from YouTube's pages on 23 Sept 2026. Long-form hours were 1,456 through 28 Sept. At the last 7, 14 and 28 days' pace (100, 77 and 47 hours a day) 8,000 lands on 2 Dec 2026, 22 Dec 2026 and 13 Feb 2027, so the new rule costs no days. 1,000 by 31 Jan would need 7.30 net a day, 1.55 times the best 7 days on record. The expanded tier (500, no ads) does not change on 1 Feb; the 7-day pace reaches it before 31 Jan, the 14-day and 28-day paces miss it.
- Money (unverified): ads need the full tier. The earliest 1,000 date above is 8 Apr 2027 and review takes about a month (`channel.md`), so ads start in May 2027 at the soonest. At $1 to $3.50 per 1,000 views (the 29 Sept competitor estimate) the full tier would pay about $59 to $205 a month at the 28-day long-form rate (1,951 views a day) and $131 to $458 at the 7-day rate (4,358). Until then income is Ko-fi.

## Every long-form, one line each

Oldest first. Titles are hook / pair; the live title is "hook | pair | tail" (ranked tail "| MCSR Ranked 1v1 | Minecraft Speedrun", series tail "| MCSR Ranked Season 11 Playoffs | Round of 16"). (S) marks a series. Views are live Data API counts on 30 Sept at 22:30 UTC. The rest is Analytics through 28 Sept; * means under 3 days of data, n/a means none yet.

| Date (UTC) | Title | Views | Engaged | CTR of impressions | Avg view | Subs (lost) | Verdict |
|---|---|---|---|---|---|---|---|
| 17 Aug | WANNABE vs REAL GOAT / lowkey vs Aquacorde | 1,234 | 68% | 6.41% of 7,767 | 54.5% | 7 (1) | Never launched: 2 views in its first 48 h on a channel with almost no subscribers. Found later through Suggested. 8.7 subscribers per 1,000 engaged views, the highest of any video with over 500 engaged views. |
| 20 Aug | They REALLY think they'll get RANK #1 / ANJOUU vs silverrruns | 940 | 31% | 2.15% of 7,471 | 44.2% | 2 | First Browse test: 864 impressions on day 0 at 0.58%, then 302 at 0.66%. The title is exactly 100 characters. Lowest CTR of the ranked uploads. |
| 22 Aug | UNC vs CATBOY / Feinberg vs Infume | 562 | 61% | 5.53% of 2,677 | 55.1% | 1 | Feinberg and Infume went up at 05:00 UTC on a Saturday: 2 impressions on day 0, 26 on day 1, 2 views in 48 h. Viewers who found it later watched 55%. |
| 26 Aug | YN vs TAS / edcr vs doogile | 5,604 | 54% | 2.97% of 70,189 | 41.7% | 26 | The breakout, 26 subscribers. Day 0 was a 10,662-impression test at 0.58%. Growth came from a 29 Aug to 1 Sept wave (1,729 views on 30 Aug alone); 70% of its views were Browse. Nothing was posted for the next 7 days. |
| 2 Sep | INSANELY CLOSE MATCHUP / bbiddd vs BadGamer | 488 | 43% | 3.85% of 3,198 | 48.4% | 0 | 0 subscribers from 474 views. Search gave 24% of views and those viewers stayed 0.43 minutes. 151 impressions on day 0 at 11.9%, then 179 on day 1. |
| 3 Sep | SILENT ACCEPTANCE / BeefSalad vs v_strid | 943 | 29% | 3.25% of 5,514 | 43.3% | 2 | One Browse burst: 3,590 impressions on day 1 at 2.2%, then under 25 views a day. 84% of views came in the first 48 h. |
| 5 Sep | DON'T DIG STRAIGHT DOWN KIDS / nahhann vs Aquacorde | 1,056 | 40% | 2.73% of 8,898 | 47.1% | 1 | 2,933 impressions on day 0 at 2.0%. 1 subscriber from 999 views. The title sells one event, a death, which the analysts say tells viewers the turning point (unverified). |
| 9 Sep | LOVERBOY vs TAS / Infume vs BeefSalad | 2,729 | 39% | 2.19% of 33,362 | 39.4% | 1 (1) | 16,240 impressions on day 1 at 1.5%, the biggest single day on the channel to that point. 1 gained, 1 lost. The uploaded file's sync was 1 to 2 s off (analysts, unverified). |
| 10 Sep | TAS vs UNC / doogile vs Feinberg | 1,258 | 63% | 4.16% of 12,334 | 38.8% | 2 | Public at 20:45 UTC, 1 h 45 min after the slot, under a stat hook later retitled (analysts). 63% engaged, 25% Suggested. Sync about 2 s off in the upload (analysts, unverified). |
| 12 Sep | LOVERBOY VS ROBLOX KID / Infume vs NoHacsJustRoblox | 313 | 53% | 5.16% of 1,975 | 57.9% | 1 | Highest average view on the channel (57.9%) and almost never shown: 1,975 impressions in all, 188 on day 0 at 9.0%. An unknown opponent in the title is one candidate cause (unverified). |
| 14 Sep | LOVERBOY vs AWKWARD / Aquacorde vs Infume | 6,739 | 24% | 4.14% of 27,181 | 37.0% | 3 (2) | Most-viewed upload before 22 Sept: 94% Browse, 24% engaged (the lowest on the channel), 0.45 subscribers per 1,000 views. 3 gained, 2 lost. |
| 16 Sep | LOVERBOY vs TAS / Infume vs Feinberg | 3,509 | 56% | 3.89% of 34,313 | 46.6% | 3 | 34,313 impressions, 56% engaged, 18% Suggested, 3 subscribers. Same hook text as 5sWhxhYESf0 with a different second player. Its Short, 18 h later, showed the finish. |
| 17 Sep | CARNIVORE vs VEGAN / BeefSalad vs silverrruns | 4,052 | 27% | 2.99% of 24,697 | 38.6% | 1 | 11,969 impressions on day 1 at 3.4%, then 10,466 at 1.25 to 1.81% a day on 19-23 Sept. 92% Browse, 27% engaged, 1 subscriber from 4,035 views. |
| 19 Sep | TAS vs IKEA GUY / doogile vs v_strid | 2,208 | 27% | 3.59% of 11,669 | 37.1% | 0 | 0 subscribers from 2,202 views and 602 engaged. Impressions fell from 1,000 on 22 Sept to 150 to 200 a day from 23 Sept. |
| 22 Sep | TAS vs SWEPT / doogile vs Aquacorde | 4,726 | 26% | 2.89% of 28,259 | 44.6% | 5 | 5 subscribers, all in its first two days (4.1 per 1,000 engaged), joint most of any upload since 14 Sept. The hook word SWEPT is on the repo's result-word list. The same pair's series went public 4 h later. |
| 22 Sep | AWKWARD vs TAS / Aquacorde vs doogile (S) | 359 | 30% | 2.13% of 2,911 | 15.8% | 1 | First series: 2,911 impressions (166 on day 0), 4 h behind the same pair's ranked upload. Lowest CTR of the 26 with data. Average view 15.8% of a 47-minute file. |
| 23 Sep | UNC vs OG / Feinberg vs silverrruns | 2,742 | 35% | 2.36% of 27,055 | 43.0% | 1 | 14,297 impressions on day 1 at 2.2%, then 1.3%. The first ranked upload with the 90 s subscribe line: 1 subscriber from 2,668 views. |
| 23 Sep | WASHED vs IKEA GUY / silverrruns vs v_strid (S) | 196 | 72% | 4.59% of 1,940 | 20.9% | 0 | 1,940 impressions, 187 views. The 135 engaged viewers watched 8.4 minutes each, the most on the channel, and none subscribed. |
| 24 Sep | LOVERBOY vs UNC / Infume vs Feinberg | 971 | 55% | 8.28% of 4,566 | 54.8% | 2 | Highest CTR on the channel and 55% engaged, on only 4,566 impressions. Two days later the same pair got 32,250. The cause of the small test is not in the data. |
| 24 Sep | LCQ vs YN / lauveer vs edcr (S) | 1,900 | 34% | 4.17% of 9,816 | 6.1% | 2 | 9,816 impressions; 26 of its 91 search views were for edcr. Average view 6.1% of a 50-minute file, the lowest on the channel. 2 subscribers. |
| 25 Sep | ASIAN VS CARNIVORE / hackingnoises vs BeefSalad | 2,849 | 31% | 2.49% of 23,032 | 38.0% | 1 | Biggest day-0 test since 14 Sept at the time (6,212 impressions, 3.3%), then 2.3%. 1 subscriber. The rival channel posted this match three days earlier (24 Sept audit, unverified). |
| 25 Sep | TAS vs DOG / lowkey vs woofdoggo_ (S) | 3,001 | 24% | 3.54% of 13,244 | 13.8% | 3 | The series Browse pushed: 11,030 impressions on day 1, 2,259 views. 93% Browse at 0.93 minutes a view. 3 subscribers, 4.5 per 1,000 engaged. |
| 26 Sep | THE DUALITY OF MAN / Infume vs Feinberg | 8,307 | 26% | 4.63% of 32,250 | 43.4% | 5 | Widest reach: 32,250 impressions, 4,162 views in 48 h, 96% Browse, 26% engaged. 28 Sept brought 3,527 views and 0 subscribers. Posted from Studio 23 h before its slot. |
| 27 Sep | LOVERBOY vs OG / Infume vs silverrruns | 4,674 | 27% | 4.81% of 11,905* | 36.5% | 1 | Above-median click (6.0% on day 0, 4,942 impressions) but the lowest average view of the ranked uploads since 22 Sept (36.5%), on the longest one (13:04). 1 subscriber. |
| 28 Sep | 58 MILLISECONDS / v_strid vs silverrruns | 3,209 | 38% | 7.28% of 2,610* | 50.8% | 0 | Read as a flop on 12 hours of data. On the same window it is 5th of 14 evening launches by impressions and at the median CTR. 3,209 views by 30 Sept. |
| 28 Sep | WHO BLINKS FIRST? / BlazeMind vs bbiddd (S) | 254 | 65% | 5.03% of 597* | 14.1% | 0 | Public 15 days after the games, two names that rarely appear in search terms: 597 impressions on day 0, 254 views by 30 Sept. Average view 14.1% of a 39-minute file. |
| 29 Sep | LOCKED IN vs UNC / Feinberg vs Infume | 5,420 | n/a | n/a | n/a | n/a | 5,420 live views in 27 h; no earlier upload's first-48 h Analytics count passed 4,162 (different counters). The third Infume and Feinberg upload in 6 days; the four before it returned 0.9 subscribers per 1,000 views. |
| 29 Sep | Feinberg on the edcr Situation (clip) | 133 | n/a | n/a | n/a | n/a | A clip, not a match: no match link, no playlist, no tip jar line, 8 generic tags. 133 views in 25 h, posted between a ranked upload and a series. |
| 29 Sep | THE CALM BEFORE THE STORM / Infume vs steez (S) | 509 | n/a | n/a | n/a | n/a | 509 views in 23 h, 16 days after the games, carried by Infume's name (analysts, unverified). |
| 30 Sep | WR HOLDER vs THE GRINDER / romuxii vs Skycrab | 68 | n/a | n/a | n/a | n/a | 68 views in 3.5 h, too early to read. The title reads the first-named player as the world-record holder; the analysts could not confirm that (unverified, worth a look). |
| 30 Sep | CRAB vs CROW / 7rowl vs Skycrab (S) | private | n/a | n/a | n/a | n/a | Went public 30 Sept 23:00 UTC, after the read. Weakest sync of any upload (confidence 0.753, one POV read from the camera freeze alone). The only series title with a trailing Minecraft Speedrun segment, 99 characters. 17 days after the games. |
| 1 Oct (sched.) | THE FORTRESS RUNBACK / silverrruns vs dandannyboy | private | n/a | n/a | n/a | n/a | Scheduled for 1 Oct 19:00 UTC. silverrruns converts at 0.44 subscribers per 1,000 views across 6 videos; dandannyboy appears in no search term list. |
| 1 Oct (sched.) | UNC GOES TO THE PLAYOFFS / nahhann vs Feinberg (S) | private | n/a | n/a | n/a | n/a | Scheduled for 1 Oct 23:00 UTC, 18 days after the games. The model's Short window landed in the wrong game, so the heuristic's Short stands. |

## Data notes

- Verification did not run (a usage limit); one skeptic verdict exists. Analytics ends 28 Sept. These have none: 7UcG1Y-k9dY, ZbP3WTzJPOE, -tQ4UDI9Sng and lzNX_AG8Gwg (public 29-30 Sept), JcDsBWo49U0 (public 30 Sept 23:00 UTC), AnMlE3NnVcA and A3F5FHkMYjc (scheduled for 1 Oct), and the Shorts cut on 29-30 Sept. The last day is partial for attribution: 28 Sept shows 3 subscribers gained and 0 credited to a video.
- The traffic key `SUBSCRIBER` is YouTube's name for Browse features, the Home page and the subscriptions feed. It is not views from subscribers. The analysts wrote "Browse" almost everywhere, but two claims leaned on a subscriber reading: "subscriber-heavy impressions" for the 7 Sept hook comparison (9.36% against 2.25% on 4,590 impressions; the phrase is also in `channel.md`, line 56) and "a small first test goes to subscribers". I dropped both; the data cannot show who sees early impressions. With 102 subscribers the subscriptions feed cannot produce thousands of Browse views, so Home is the bulk (inference).
- Dropped or corrected as wrong: "worst day-0 CTR on the channel, next worst 3.28%" (gRjV1jG4-Ng also had 0.58%); "every BeefSalad upload under 2.8%" (4evKn5k0_p8 clicked 4.07%); unattributed subscribers "flat at about 5 a week" (the skeptic); opWF0g2VCP0 "converted worst" (4evKn5k0_p8 and OBTSpSjRGN8 converted worse); and "end screens work when they exist", since the 22 end-screen views on jIH_RuqxbDU do not say whose end screen.
- Not opened: the `sync.json` files behind the sync remarks, Studio (end screens, Related video links, playlists), the runner DMs, and the rival channel's figures. Those lines say "unverified" or name the analysts. A different audience found the August uploads than the September ones, which confounds every comparison across them.
