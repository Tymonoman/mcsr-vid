# Nickname/label titles vs match-fact titles — 7 Oct 2026

The operator, 7 Oct 2026: "you will compare the titles we use now to the nicknames we used earlier."
Data: 80 videos (47 long-forms, 33 Shorts), Reporting API impressions/CTR and Analytics views per video per
day through 5 Oct 2026; the 31 titles renamed on 2 Oct (label hook → match-fact hook). Read-only. Code and
numbers: `~/.claude/jobs/8d7d95a1/tmp/titles1007/` (`analyze.py`, `results.json`, `dataset.json`).

## Answer

**No measurable difference either way.** Every comparison's 95% interval includes zero, or flips sign with the
choice of control. The same thing happened to the 1 Oct audit's early CTR gap (9.36% vs 2.25% at 4,590
impressions), which shrank to 2.77% vs 2.59% at 126,745.

| Comparison | n | Result |
|---|---|---|
| Same video, before vs after the 2 Oct rename (diff-in-diff) | 14 long-forms | CTR −1.10 pp [−2.26, +0.04] against same-calendar-day controls, but +1.12 pp [−0.02, +2.17] against same-age controls. The sign flips, and there are only 3 days after the rename |
| First week at upload, label vs fact, long-forms | 21 vs 7 | normalised CTR +0.05 [−0.28, +0.36]; OLS with draw: label coefficient smaller than its own SE |
| First week at upload, label vs fact, Shorts | 6 vs 11 | normalised CTR −0.05 [−0.38, +0.30], views −0.06 [−0.31, +0.22] — centred on zero |

What would settle it: 15–20 days after the rename (rerun around 20–25 Oct) and 3–4x more fact-hook long-forms
with a complete first week.

**The house rule stands regardless.** A label or nickname title cost the channel a runner (Aquacorde, 2 Oct).
A future read in its favour would still not bring it back. Titles are tested from here on through Test &
Compare, with registers that are all about the match (stake, question, pace): see `experiments.md`.

Caveats: the label/fact classification is a heuristic built for this read; the skeptic pass of that workflow
returned nothing usable, so these numbers are one agent's, spot-checked; three BeefSalad videos went dark on
4 Oct (his withdrawal) and were left out.
