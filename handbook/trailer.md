# Channel trailer

The clip YouTube shows an unsubscribed visitor on the channel page: a 45-60 s montage of moments
cut from our own exports, overlay and splits included, no music. The operator, 22 Oct 2026: "you
can draft some insane finishes or moment into a clip as a channel trailer".

## Re-run

```
nice -n 19 python3 scripts/trailer/build.py <dir>/trailer.json
```

The spec lists `segments` (`matchId`, `from`/`to` in match seconds, the RTA column's clock,
`pov` `both|left|right`, `caption`) plus `endCard.line1`/`line2` and `out`. It reads
`final-<id>.mp4` and `final-<id>.json` (`matchStartSec`) from `/media/<id>/`, else `/archive/<id>/`
(a public match's export moves to the NAS after 48 h). Each segment: the frame scaled to
1920x1080 (`left`/`right` fills it with that POV's game half), the caption on a plate for the first
3.5 s, audio `loudnorm` to -14 LUFS; segments cross-fade 0.3 s; the end card is 5 s of silence.
Output: h264+aac 1080p60, plus `check-sheet.png` beside it (the middle of every segment, then the
end card). Look at the sheet before sending anything.

Pick segments from public long-forms only (`youtube.json` present, `publishAt` in the past), never
a blocked player (`blockedPlayers`), and verify each window against frames before trusting a
caption. Finishes may be in; cut before the game's own Victory/Defeat screen and keep the caption
to the pair and what is happening: no winner, score, nickname, elo or rank. The hand-Short specs
are a good source of windows that were already watched.

The first cut (22 Oct 2026) is the spec at `tmp/growth/trailer/trailer.json` of that session's
job directory: 8 moments, ~52 s.

## Setting it in Studio

By hand, like every upload: upload `trailer.mp4` as an ordinary video (unlisted is fine; it has
to be on the channel), then Studio → Customisation → Layout → "Video spotlight" → "Channel
trailer for people who haven't subscribed" → Add → pick it. The "Featured video for returning
subscribers" slot stays as it is. Nothing in the pipeline uploads or sets this.
