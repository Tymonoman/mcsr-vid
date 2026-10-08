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

(none yet)

## Earlier reads this builds on

- `titles-nicknames-vs-facts-2026-10-07.md`: nickname/label titles vs match-fact titles show no measurable
  difference, and the house rule stands regardless.
- The 1 Oct audit: the early hook-style CTR gap (9.36% vs 2.25% at 4,590 impressions) was a wash at 126,745
  (2.77% vs 2.59%). Small samples mislead, which is why the 1,000-impression floor exists.
