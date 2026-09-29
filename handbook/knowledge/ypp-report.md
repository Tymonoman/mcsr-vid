# YPP math for MCSR Replayoffs, 23 Sept 2026

The relayed request asked for other agy uses. This track works out which YPP number binds and how far each lever has to move. Where agy could help with those levers is covered in §6.

**Data sources.** The Analytics API has complete days through **21 Sept**. The Data API was read at 23 Sept 21:05 UTC. Both reads are own-channel and read-only. The scripts and raw data are in `/home/node/.claude/jobs/8d7d95a1/tmp/night1/research/` (`ypp-pull.mts`, `ypp-daily.mts`, `ypp-src.mts`, `ypp-edcr.mts`, `ypp-now.mts`, `ypp-data.json`, `ypp-daily.json`).

## 1. The rules, from YouTube's own pages (read 23 Sept 2026)

- **Expanded tier (fan funding).** The channel needs 500 subscribers and 3 public uploads in the last 90 days. It also needs either 3,000 qualified long-form watch hours in the last 12 months or 3M qualified Shorts views in the last 90 days.
  - It unlocks memberships, Super Chat, Super Thanks, gifts and Shopping. It pays **no ad revenue**.
  - **Poland is on the eligible list.** Source: [Overview of the expanded YPP](https://support.google.com/youtube/answer/13429240?hl=en).
- **Full tier (ads and Premium), current rules.** 1,000 subscribers plus either 4,000 qualified watch hours in 12 months or 10M Shorts views in 90 days.
  - "Watch hours from Shorts views in the Shorts Feed won't count." Private, unlisted and deleted videos don't count either. Source: [YPP overview & eligibility](https://support.google.com/youtube/answer/72851?hl=en).
- **New since the last audit: the ads threshold doubles on 1 Feb 2027.** From that date, new applicants need **1,000 subscribers plus 8,000 watch hours in 365 days, or 20M Shorts views in 90 days**.
  - The fan-funding tier does not change: it stays at 500 subscribers plus 3,000 hours or 3M Shorts views.
  - Also from that date, a channel needs 10M Shorts views per 90 days to earn from the Shorts pool at all. Source: [Changes to the YouTube Partner Program](https://support.google.com/youtube/answer/12843009?hl=en).
- **Applying.** Review takes about a month. A rejection means a 30-day wait before re-applying, and 90 days after the second one. The channel also needs 2-Step Verification, advanced features and an AdSense for YouTube account. I have not checked whether the channel has these.

## 2. Where the channel stands

| | Now | 7-day rate (15–21 Sept) | 14-day rate (8–21 Sept) |
|---|---|---|---|
| Subscribers | **73** (Data API; the Analytics net was 65 through 21 Sept) | +2.14 net/day | +1.71/day |
| Public long-form hours, trailing 365 days (the channel dates from 9 Aug 2026, so this is its whole life) | **766 h** (45,984 min; Shorts add 4.7 h, which don't count) | 52.9 h/day | 37.9 h/day |
| Shorts views, trailing 90 days | **3,146** (all from 17–21 Sept) | ~630/day | — |
| Public uploads, last 90 days | 20 | — | — |
| Views/day, all types | — | 2,734 | 1,739 |
| Net subscribers per 1k views | 2.07 lifetime | **0.78** | 0.99 |

**Per upload** (Analytics through 21 Sept):

| Type | n | Views/upload | Qualifying hours/upload | Subs/upload | Subs per 1k views |
|---|---|---|---|---|---|
| Ranked long-form, all | 14 | 2,013 | 55 h | 3.5 | 1.74 (1.0 without edcr–doogile's 26) |
| Ranked long-form, daily cadence (14–19 Sept) | 4 | 3,685 (3–8 days in) | 75 h | 1.5 | **0.41** |
| Playoff series (46.9 min) | 1 | 72 views in 22 h (Data API); the same pair's ranked video had 1,843 in 26 h | n/a yet | n/a | n/a |
| Shorts | 3 | 1,049 | 0 (Shorts-feed hours don't count; 1.6 h raw) | **0** | **0** |

Two more facts about where subscribers come from:
- **28 of the 77 gross subscribers** can't be traced to any video. They came from the channel page and other surfaces.
- **Only 1.8% of views come from subscribers** (563 of 31,323). Almost all reach is non-subscribers seeing the channel in the home feed ("browse").

## 3. Projection: when each threshold falls at current rates

The range is between the 7-day and 14-day rates. Subscriber dates count from 23 Sept; hour dates count from 21 Sept.

| Gate | Lands at current rate | Needed by 22 Nov (60 days) | Needed by 22 Dec (90 days) |
|---|---|---|---|
| **Expanded: 500 subscribers** | **10 Apr – 30 May 2027** | 7.1/day (3.3x now) | 4.7/day (2.2x now) |
| Expanded: 3,000 hours | **2 – 18 Nov 2026** | 37 h/day, already met | 25 h/day, already met |
| Expanded: 3 uploads in 90 days | already met | — | — |
| Expanded, Shorts route: 3M views | never. At 630/day the 90-day total levels off near 57k (1.9%) | 50k/day | 33k/day |
| Full: 1,000 subscribers | 30 Nov 2027 – 18 Mar 2028 | — | — |
| Full: 4,000 hours (valid for applications up to 31 Jan 2027) | 21 Nov – 15 Dec 2026 | — | — |
| Full: 8,000 hours (from 1 Feb 2027) | 4 Feb – 30 Mar 2027. The rate would level off near 19k h/yr, so it is reachable | — | — |

**Your guess is right: subscribers are the binding constraint on both tiers.** Hours clear the expanded tier within about 60 days without any help.

- The doubling to 8,000 hours does not move the ads date, because 1,000 subscribers lands 8–12 months after 8,000 hours at this rate.
- The 4,000-hour route would need 1,000 subscribers by 31 Jan. That means 7.1/day, which is out of reach, so plan on 8,000.
- One question is open: would joining the expanded tier before 1 Feb keep the old 4,000-hour threshold for ads? The page says members "already in YPP" are "not impacted", but it doesn't say this. It only matters if the channel reaches 500 subscribers by 31 Jan, which needs 3.3/day.

## 4. How far each lever must move for the expanded tier

Each row holds the other levers at today's values. The target is 427 more subscribers.

| Lever | Now | For 60 days | For 90 days | For 31 Jan (130 days) |
|---|---|---|---|---|
| Net subscribers/day | 2.14 | 7.1 | 4.7 | 3.3 |
| Subscribers per 1k views (at 2,734 views/day) | 0.78 | **2.60** | **1.74** | **1.20** |
| Views/day (at 0.78 per 1k) | 2,734 | 9,120 | 6,080 | 4,210 |
| Long-form uploads/day, if views scale linearly (~4k views/day per daily slot) | 0.57 in the measured week | ~2.1 | ~1.4 | ~0.9 |
| Subscribers/day from Shorts alone, to close the gap | 0 | 5.0 | 2.6 | 1.1 |
| Series watch hours | Don't move the date: hours already land 2–18 Nov | — | — | — |

**Is the conversion target plausible?** 1.74 per 1k is below the channel's own lifetime rate (2.07). It is well below the 25 Aug–7 Sept fortnight (5.5) and the nearest competitor, MCSR Matches (1,530 subscribers from 285k views = 5.4 per 1k, read 8 Sept). But MCSR Matches still took a year of daily uploads to reach 1,530.

**The linear volume model is contradicted by the data.**
- From the 25 Aug–7 Sept fortnight to 8–21 Sept, views went **7,060 → 24,341 (3.4x)** while net subscribers went **39 → 24**.
- Daily subscribers stayed at about 2 while views/day rose 2.4x.
- So the extra views arrived at close to zero subscribers each.
- At the new daily cadence, the linear model says ~3.6/day and 500 by about 19 Jan 2027. The measured trend says April–May.

## 5. The three levers that move the date most

**1. Watch depth per long-form view.**
- Across the 14 long-forms, minutes watched per view correlates with subscribers per 1k views: r = 0.70 (Spearman 0.69).
- Videos watched **≥2 min per view convert at 3.68 per 1k** (2.4 without edcr–doogile). Videos **under 2 min convert at 0.57 per 1k**.
- As home-feed views grew 3.3x, minutes per view from that feed fell from 1.61 to 1.16. Suggested-video viewers watch 3.6–3.75 min.
- opWF0g2VCP0 is the extreme case: 6,440 views at 0.72 min each, 3 subscribers.
- The measured loss is the first minute: 16–22 points gone between 3% and 10% of the video, before the 90 s subscribe line. That line reaches only 50–60% of viewers.
- Early sign: the subscribe line went live on 22 Sept, and subscribers went 65 → 73 in about two days (4/day). If that holds, 500 lands about **7 Jan 2027**. Two days of data prove nothing; re-read around 30 Sept before crediting it.
- This is the only lever that moves both gates.

**2. Shorts converting at all.**
- 3,146 Shorts views, 0 subscribers.
- About 2.6k Shorts views/day at 1 subscriber per 1k would close the whole 90-day gap on its own.
- The Short redesign's success measure already includes subscribers from Shorts. Give it a number: subscribers per 1k Shorts views, target at least 0.5–1.

**3. Volume (daily ranked uploads plus series), but only after lever 1.**
- The linear model says daily uploads bring 500 to about January. Measured, extra home-feed views bring close to zero subscribers.
- Series are 47 minutes long and would be hours-rich, but hours are not binding. The first series had 72 views in 22 h. Series help only if they reach viewers who then subscribe.
- More volume also raises the "inauthentic/mass-produced" review risk (see below).

**Review risk, which sits beyond the numbers.** Meeting the thresholds doesn't guarantee acceptance. The [reused-content policy](https://support.google.com/youtube/answer/1311392?hl=en) allows "replays of a sports tournament where you explain the moves" and "edited footage… that demonstrates substantive editing". The channel has substantive editing but no commentary. A rejection costs 30 days.

## 6. Where agy fits these levers (the relayed request)

- **Lever 1: find the dead first minute.** Add a field to the existing pick call on the proxy the Short pick already builds (an extra field is about 1–2k tokens; a new call is about 80k). It would mark where nothing happens in the first minute.
  - It could also propose a spoiler-free, mid-race cold open of about 5 s before the intro card. That goes in the editable region before the match and cuts no footage.
  - A cold open is a format change, so it is the operator's decision.
- **Lever 1 plus review risk: race captions in the long-form.** Reuse `raceCaptions` to "explain the moves" in the long-form. This lifts depth and speaks to the policy's own allowed example.
  - Every number read off the picture must be checked in code first. The Pro model has already made up a heart count.
- **Lever 2** is the Short redesign already in progress.
- **The YPP math itself stays in code.** Keep Analytics rows out of prompts: the Developer Policies allow authorized data only for the operator or agents the operator has expressly approved, so this stays out until the operator decides (the rule `agy-uses.md` already follows).

## 7. Bug found in the repo (read-only, nothing changed)

The dashboard's YPP panel, `src/youtube/yppProgress.ts`, is wrong in three ways:
- **Line 15** mixes the two tiers: it pairs 500 subscribers with 4,000 hours and 10M Shorts views.
- **Line 130** compares against `"SHORTS"`, but the API returns `"shorts"`, so the Shorts gate always reads 0.
- **Lines 112–121** count Shorts minutes as watch hours (4.7 h today, so trivial now, but wrong by definition).

Correct targets: expanded is 500 / 3,000 / 3M; full is 1,000 / 4,000 / 10M until 31 Jan 2027, then 8,000 / 20M.

I didn't save this report as a `.md` file, because the harness rule says to return findings as text. The scripts and data are in the research folder above.