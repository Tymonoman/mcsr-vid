# Experiments — the week of 8–14 Oct 2026

The operator, 7 Oct 2026 (his /goal): "get the YPP ETA back to last week's pace. 'Last week's pace' = subscribers
and public watch hours gained 30 Sept–6 Oct. Measure that first from Analytics and write the baseline into
handbook/knowledge/experiments.md before changing anything." This file is the readable ledger (the bot's /ask reads
it); the data is `<mediaDir>/.experiments.json`, which the dashboard's experiment engine writes.

## Baseline (measured 7 Oct 2026, before any change)

Source: YouTube Analytics API, own channel. Last complete Analytics day: 5 Oct, so the baseline week has 6 of its 7
days. Rates are per present day, the same convention as `windowStats.ts`. Independently re-derived by a second agent,
and both numbers matched exactly.

| Window | net subs | subs/day | long-form watch h | h/day | views | engaged views | subs per 1k engaged |
|---|---|---|---|---|---|---|---|
| 16–22 Sept | 14 | 2.0 | 373 | 53.3 | 17,658 | 6,174 | 2.27 |
| 23–29 Sept | 28 | 4.0 | 857 | 122.4 | 49,482 | 14,975 | 1.87 |
| **30 Sept–6 Oct (baseline, 6/7 days)** | **24** | **4.0** | **610** | **101.7** | 31,433 | 12,123 | 1.98 |

Position on 7 Oct: **123 subscribers**, **2,268 public long-form watch hours** (365 days), 9,404 Shorts views.
Subscribers are the only thing holding up YPP:

| Gate | At the baseline pace | At the 28-day pace (/ypp) |
|---|---|---|
| 500 subs (expanded tier) | ~94 days → **9 Jan 2027** | ~129 days → 13 Feb |
| 1,000 subs (full tier) | ~219 days → 14 May 2027 | ~300 days → 3 Aug |
| 3,000 watch hours | ~7 days → 14 Oct | ~10 days → 17 Oct |
| 4,000 watch hours | ~17 days → 24 Oct | ~24 days → 30 Oct |

**The week's bar: ≥ 4.0 net subscribers a day across 8–14 Oct** (≥ 28 for the week), which keeps the 500 ETA on or
before 9 Jan. Watch hours are on course either way.

**10 Oct 2026, the target moved to the full tier.** The operator: "we only focus on hitting the full ypp." The goal
is 1,000 subscribers; the final report compares the full-tier ETA with the baseline's **~14 May 2027** (4.0 a day from
123 on 7 Oct). Applying on or after 1 Feb 2027 needs 8,000 public watch hours (or 20M Shorts views) instead of 4,000;
at ~82 h a day the channel passes 8,000 around 15 Dec 2026, so subscribers stay the only gate. On 10 Oct: 136
subscribers at 3.07 a day over 28 days → ~19 Jul 2027. The ranked plan:
https://claude.ai/artifact/ADK2WTTzP732w87GgpwXzC.

## How tests are run

- **Test & Compare** (Studio, driven by the browser automation): thumbnails and titles, up to 3 variants. YouTube's own
  verdict (watch-time share) is the result. Every title variant passes `hookProblem`, `hookLabelProblem` and
  `spoilsTheResult`: no winner, no nickname, label or epithet for a runner, no seed/rank/elo, and an upset hook is
  a question. Live titles and thumbnails change only through Test & Compare and its winner.
- **Between-video arms** (the dashboard's experiment engine): one variable per video, alternating by day: the publish
  hour, the Short's delay, `explainMovesSec`, `countdownTeaser`, `introSec`, and cadence (two long-forms a day when the
  nightly finds two known-player candidates).
- **Metrics:** impressions CTR (Reporting API `channel_reach_basic_a1`), engaged views, average view %, subscribers
  per 1,000 views.
- **Verdicts:** an arm under ~1,000 impressions is "inconclusive", never a guess. CTR is compared with a
  two-proportion z-test (|z| ≥ 1.96). A retention metric reports numbers only, unless every video of one arm beats
  every video of the other with ≥ 3 per arm. Winners become defaults, and every decision is written below with its
  numbers.

## Test & Compare targets: the 10 public long-forms with the most impressions, 8 Sept–5 Oct

| # | matchId | Title hook | Impressions | CTR | Avg view % | Live thumbnail |
|---|---|---|---|---|---|---|
| 1 | 13673240 | THE DUALITY OF MAN | 36,597 | 4.47% | 42.7 | default-default (operator) |
| 2 | 13395245 | CAN A MINUTE LEAD HOLD? | 36,127 | 4.02% | 47.2 | walking-crossed (operator) |
| 3 | 13473906 | GONE BY THE FORTRESS | 29,733 | 2.48% | 44.3 | default-default (operator) |
| 4 | 13672776 | A DRAGON FIGHT FOR TWO | 28,401 | 5.90% | 49.0 | walking-crossed (auto) |
| 5 | 13705853 | A RESET, THEN A PHOTO FINISH | 21,520 | 3.82% | 33.3 | walking-crossed (auto) |
| 6 | 13704828 | 58 MILLISECONDS | 19,948 | 3.95% | 41.6 | walking-crossed (auto) |
| 7 | 13305732 | 1 HEART AT THE FOUNTAIN | 14,829 | 3.51% | 13.9 | walking-crossed (auto) |
| 8 | 13223455 | BACK AND FORTH TO THE END | 13,687 | 4.36% | 41.0 | marching-crouching (operator) |
| 9 | 13766294 | THE FORTRESS RUNBACK | 12,874 | 3.50% | 41.4 | walking-crossed (auto) |
| 10 | 13391780 | NEITHER LEAD LASTED | 11,928 | 3.55% | 38.3 | walking-crossed (operator) |

All ten match directories hold all four pose variants (walking-crossed, default-default, cheering-relaxing,
marching-crouching). The lowest of the ten still drew ~3,000 impressions a week, so each can reach a verdict.

## Ledger

The live state is in `<mediaDir>/.experiments.json` and the generated "experiments-live" doc /ask also reads.
Decisions are copied here at each day's end.

### Between-video tests (the dashboard's experiment engine)

| id | variable | arms | when | metric |
|---|---|---|---|---|
| x1-two-a-day-hour | publish hour on two-a-day days | 19:00 vs 23:00 UTC (control 19:00) | publish days 9–15 Oct, `rankedHoursUtc [19, 23]` | CTR |
| x2-explain-moves | `explainMovesSec` 8 vs off | on / off by render night: on 8, off 9, on 10, off 11, on 12 Oct | renders 8–12 Oct, verdict by 17 Oct | average view % |
| x3-countdown-teaser | `countdownTeaser` | off 13, on 14, off 15, on 16 Oct | renders 13–16 Oct, verdict by 21 Oct | average view % |

The other render switches stay fixed during these (`introSec` 3, `countdownTeaser` on during x2, `explainMovesSec`
8 during x3). The Short's delay stays at 18 h. A Short-delay test would put a second variable on the same long-forms
as x1, so it waits for next week. `introSec` 3 vs 7 is read from history once the first 3 s exports have been up a week.

### A/B tests in Studio (Test & Compare, "A/B Testing" on this channel)

Started 8 Oct 01:1x UTC: **LUI5E7yF0zE** THE DUALITY OF MAN, thumbnail, default-default (live) vs walking-crossed.
Queued for the Studio worker (planned 8 Oct, started from 07:30 UTC, ≤ 2 per 20-minute cycle):

- **Thumbnails** (control = the live one): vASY6MzFRNM, f4Z2Dvg9ihc, 7UcG1Y-k9dY, RGqLQ1kT7GI, oEYCRfER4A4,
  ZqI4Cf1g3_w, tT8Uj2HOF1o, OBTSpSjRGN8, AnMlE3NnVcA. Challengers: a different pose pair, never the celebrating one;
  plus, where the judge passed it, the same thumbnail with a short caption (SUB-9, SUB-10, 58 MS).
- **Titles** (live vs one challenger; every challenger passes the three hook checks and is true on screen):
  FtJ-VEv6pgk DECIDED BY 1 SECOND · jIH_RuqxbDU / -tQ4UDI9Sng / gvNE1jxzLzY / a-mimffZSlg / d_fi9zEqcFc /
  _2EOkOOX0PQ A SUB-9 TO WIN IT · KN0SKIRKUPk DECIDED BY 9.1 SECONDS · r0F15RPC0nE A SUB-8 TO WIN IT ·
  lzNX_AG8Gwg DOES THE LEAD EVER SETTLE? · 358mpZeBqFo A SUB-10 TO WIN IT · la_h_HmMuF8 DECIDED BY 9.4 SECONDS ·
  s7R5FUKU0KQ NOT A SINGLE DEATH. (1f6fOD3KiMI's "CAN A 0:37 LEAD SURVIVE?" was refused by `spoilsTheResult`.)
- **Every long-form uploaded from 8 Oct** gets a thumbnail test from the worker: the live thumbnail vs the most
  different non-celebrating pose, plus a caption when one of ≤ 6 characters passes the checks.

YouTube's own verdict (watch-time share) is the result. It applies the winner itself, and a test runs up to 14 days.

### End screens

Every long-form gets the editor's "1 video, 1 subscribe" starter layout, the closest to the operator's own (subscribe
+ 2 videos). "Import from video" can't be used, because its picker searches the account's default (personal) channel.
Done 8 Oct: s7R5FUKU0KQ, la_h_HmMuF8. The worker then works back through the public catalogue, 3 per cycle, skipping
any video that already has one (his 8 custom ones included).

## Decisions

- **13 Oct 2026 — x1 interim flipped (still not the decision):** with 10 videos, 19:00 UTC now leads on impressions CTR,
  5.27% vs 4.19% (z = -3.49), but 23:00 drew 2.25x the impressions (14,672 vs 6,508) and more views (2,997 vs 1,768),
  subs 3 vs 2. The 12 Oct reading below was early noise; the evaluator decides on 15 Oct.
- **12 Oct 2026 — x1 interim (not the decision):** 23:00 UTC leads 19:00 UTC on impressions CTR, 8.27% vs 5.98%
  (z = 2.49, 9 videos enrolled). The experiment ends 15 Oct; the evaluator writes the decision then. Two-a-day
  continues past it either way (`cadence-two-a-day`, 16 Oct–15 Nov), so the reading only decides which hour leads.
- **11 Oct 2026 — second Test & Compare verdict: no winner on the "DECIDED BY 4.2 SECONDS" title test
  (`358mpZeBqFo`, hackingnoises vs romuxii, 10:09).** Studio's report: "They all performed well" — the live title
  "DECIDED BY 4.2 SECONDS" **50.1%** of watch time share against "A SUB-10 TO WIN IT" **49.9%**; ran 8 Oct 11:11 AM →
  11 Oct 6:52 PM (Studio's clock). Nothing changed on the channel. Read with the GF test: a pace-number title lost
  62/38 on a 36-minute series and tied 50/50 against a margin title on a 10-minute match, so the pace chip is not
  worse than a fact title in general; the GF gap was likely the "one fast game" promise on a series. Keep the chip
  order. The reader first logged this as "control wins" (it took "Now visible to all viewers" for a win); fixed —
  only Studio's own "Winner" mark counts, and the verdict keeps Studio's headline.
- **11 Oct 2026 — first Test & Compare verdict: the Grand Finals title test (`_2EOkOOX0PQ`, lowkey vs Infume, 35:46).**
  Studio's report: "We have a winner!" — the live title "IT ALL COMES DOWN TO THE END | … | Grand Finals" took **62.1%**
  of watch time share against "A SUB-9 TO WIN IT | … | Grand Finals" at **37.9%**; ran 8 Oct 23:00 → 11 Oct 11:31 UTC
  (~60 h from going public; 1,765 views to date). Studio keeps the winner, which was already live — nothing changed.
  Read: a story/stakes title beat a pace-number title on the same video, same thumbnail, same hours. One video, and a
  series: a "sub-9" promise describes one fast game, and the video is a 36-minute series, so part of the gap may be
  that mismatch. Hold the auto-hooks chip order until 2–3 more title tests agree (12 still running). The worker's
  reader missed it: Studio says "Results ready", not "winner", in the title box — fix `readTestAndCompare`.
- **11 Oct 2026 — two long-forms a day continue after x1 (16 Oct–15 Nov).** x1's slot entries ended on 15 Oct, and
  with no slot entry a date falls back to the single `publishHourUtc` slot while `nightlyMaxRenders` 2 keeps
  rendering two a night — a backlog of one video a day. The plan for the full tier says to keep two a day (it also
  carries the watch hours past 8,000 by mid-December), so `.experiments.json` now has a `cadence-two-a-day` slot
  entry (`rankedHoursUtc: [19, 23]`) for every date 16 Oct–15 Nov. It is data, not an experiment: no experiment has
  that id, so nothing enrols into it. Revisit by 15 Nov.
- **11 Oct 2026 — x4-record-pace scheduled** (render arms 17–24 Oct, `recordPaceBoostSec` 480 vs null, metric CTR,
  `adoptWinner: false`): idea 7 of the full-tier plan, merged default-off in `9da0e68`.

## Earlier reads this builds on

- `titles-nicknames-vs-facts-2026-10-07.md`: nickname/label titles vs match-fact titles show no measurable
  difference, and the house rule stands regardless.
- The 1 Oct audit: the early hook-style CTR gap (9.36% vs 2.25% at 4,590 impressions) was a wash at 126,745
  (2.77% vs 2.59%). Small samples mislead, which is why the 1,000-impression floor exists.
