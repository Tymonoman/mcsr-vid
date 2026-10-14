# Why the Algorithm (14 Oct 2026)

The operator asked for "a detailed report on every WHY question I could have about the YouTube algorithm system such as why certain vids outperform others or what will happen when we do hit full ypp". The report is the artifact https://claude.ai/artifact/TTzxfCvwBBS4YELU297WxP: 110 questions in 10 sections, 746 evidence items (427 our data, 210 YouTube official, 44 industry, 65 inference), each with a confidence. Source data and scripts: the session scratch dir `tmp/why/` (data/*.md, report.json, scripts/build.py); numbers are Analytics through 11 Oct 2026 and the Reporting job through 12 Oct.

The short version:

1. Hits are shown to far more people, not clicked more often: 1v1s past 5,000 first-week views had a median 28,389 impressions at 4.5% CTR; those under 1,000 had 4,035 at 4.4%.
2. A long-form is a three-day event: a median 74% of its views in 3 days, 96% in a week. Old videos don't fill an empty day.
3. About 2 subscribers per 1,000 engaged long-form views, flat since mid-September. Most of the 15x view growth was muted Home previews and Shorts plays.
4. The publish hour barely matters; the number of fresh ranked matches live at once does (rho 0.77 with daily long-form views).
5. Count videos, not impressions: the experiment engine's pooled CTR rule names a winner about 3 times in 4 when there is no real difference.
6. Plan on 1,000 subscribers around May 2027 at the 28-day pace (7 Mar–8 Jun across the paces we have run). Public watch hours pass 8,000 between late Nov and mid-Dec 2026, so subscribers set the date and the 1 Feb 2027 rule change costs no days.
7. 1,000 subscribers only opens a human review. A reused-content refusal is the main risk (rated medium, the channel has no voice); the "What happens when we hit full YPP" section lists what to change before applying.
8. Once in YPP, expect about $20–$110 a month from long-form ads at today's volume (RPM is per 1,000 engaged views; only a third of our long-form views are engaged).

Bug it found: `/ypp`'s watch-hours total counted the 9 now-private long-forms (505 h); YPP counts public hours only (2,493 h on 11 Oct). Fix: `src/youtube/yppProgress.ts` leaves private videos out of the total and the rate.
