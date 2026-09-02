# mcsr-vid

Turns an [MCSR Ranked](https://mcsrranked.com) match into a ready-to-edit Kdenlive project: fetches match data, downloads trimmed dual-POV VODs, syncs them precisely via audio cross-correlation, renders a stat overlay, and assembles it all into a `.kdenlive` timeline.

## Pipeline

1. **fetch-match** — pulls match, player, and head-to-head stats from the MCSR Ranked API.
2. **download-vods** — uses `yt-dlp` to download a trimmed window of each player's VOD around the match, instead of the full broadcast.
3. **validate-sync** — cross-correlates the audio of both clips to verify/refine alignment and renders a side-by-side preview to eyeball.
4. **render-overlay** — renders a 1920x1080 Remotion overlay (nicknames, Elo, PB, head-to-head, live split times) as a transparent ProRes 4444 `.mov`.
5. **generate-project** — runs the full pipeline end-to-end and writes a `.kdenlive` project with both POVs and the overlay on synced tracks, ready to open.

Each step can also be run standalone against an already-downloaded match (existing files under `media/<matchId>/` are reused instead of re-fetched).

## Requirements

- Node.js 20+
- [`yt-dlp`](https://github.com/yt-dlp/yt-dlp) and `ffmpeg`/`ffprobe` on `PATH`
- [Kdenlive](https://kdenlive.org) to open the generated project

## Setup

```sh
npm install
```

## Usage

Pass either a full `mcsrranked.com` match URL or a bare match ID to any command.

```sh
npm run fetch-match -- <url-or-id>       # print match/player/versus JSON
npm run download-vods -- <url-or-id>     # download trimmed VODs to media/<id>/
npm run validate-sync -- <url-or-id>     # check/refine sync, render a preview clip
npm run render-overlay -- <url-or-id>    # render the stat overlay
npm run generate-thumbnail -- <url-or-id> # render the video thumbnail
npm run generate-project -- <url-or-id>  # full pipeline -> media/<id>/match-<id>.kdenlive
npm run batch -- <file>                  # run the full pipeline over a list of matches
npm run status                           # per-match stage completion table for media/
npm run score -- <url-or-id>             # split-by-split breakdown + closeness/chaos score
```

`npm start` opens the TUI; press <kbd>Tab</kbd> on the input screen for recent
matches, to reopen a finished project or resume an incomplete one.

## Match suggestions

`npm start` also scans for matches worth rendering, in the background, so the
input prompt stays usable immediately. Press <kbd>Shift</kbd>+<kbd>Tab</kbd> for
the list; <kbd>Enter</kbd> shows the full split breakdown before committing to a
render, <kbd>d</kbd> hides a suggestion for good, <kbd>r</kbd> forces a rescan.

Suggestions come in two buckets, because a good video is one of two things:

- **CLOSE** (8 slots) — ranked on the finish margin, how many splits stayed
  within 3 seconds, how small the biggest lead was, and how fast the run was.
- **CHAOS** (2 slots) — ranked on deaths, lead changes, and the biggest swing in
  the lead.

Only ranked, non-forfeited matches where **both** players have a Twitch VOD are
eligible, since the pipeline needs two POVs. That is 0.5–2% of the feed depending
on the hour, and it also does the work of picking out players worth watching:
only streamers have VODs, across a wide Elo range rather than just the top of the
leaderboard.

A match where the loser never killed the dragon can't hold a CLOSE slot — there
is no finish to be close at — but stays eligible for CHAOS. Unfilled close slots
roll over, so the list still comes back full.

Matches that already have a `media/<id>/` directory are never suggested, nor are
ones dismissed with <kbd>d</kbd>.

### Why suggestions accumulate

Genuinely close races are *rare*. A measured scan of 4,000 ranked matches (about
five hours of play) turned up 26 with two VODs and exactly **one** with a
comparable finish. Eight of them cannot come out of a single scan — and some
five-hour windows don't contain eight at all.

So `media/.suggest-cache.json` keeps a pool of every match scored so far, and the
buckets select from that pool. Each launch does a short catch-up pass over new
matches, then pushes a frontier further back through the feed, adding to the
pool. In practice the close bucket fills within a handful of launches. Pool
entries expire after 10 days, because Twitch VODs do.

### Popularity

Two signals, added together:

- **Streaming frequency** — how often a player turns up in dual-VOD matches,
  accumulated across scans. Always available, no credentials.
- **Twitch followers** — `suggestFollowerWeight × log10(1 + followers)`. Log
  scale because follower counts are heavy-tailed; added raw, one large streamer
  would drown out every other signal.

Followers need a Twitch app. Put its credentials in a `.env` at the repo root
(already gitignored; read via Node's built-in `process.loadEnvFile`, no
dependency):

```sh
TWITCH_CLIENT_ID=your_client_id
TWITCH_CLIENT_SECRET=your_client_secret
```

Without them — or if Twitch errors — popularity falls back to streaming
frequency alone and the suggestions screen says so. The scan is never blocked by
Twitch being unavailable.

### Scoring notes

The finish margin is the gap between the two `projectelo.timeline.dragon_death`
events. That event, not `end.kill_dragon`, is authoritative: the official
`result.time` is the winner's `dragon_death` plus ~9.96s in every match checked,
and **`end.kill_dragon` is missing for some players**. Keying on it makes match
`12898432` look like a 10.4s blowout when the real finish was 3.5s — see
`src/matchScore.test.ts`, which pins that case.

`<file>` for `batch` is one match URL/ID per line; blank lines and `#` comments
are skipped, and one failing match doesn't abort the rest.

`npm run remotion:studio` opens the Remotion Studio to preview and tweak the overlay live.

## Overlay render

The overlay ships as three layers rather than one full-frame video, because
rendering 1920x1080 was mostly rendering empty space:

| Layer | Size | Why |
| --- | --- | --- |
| `overlay-top.png` | 1920x210 | Names/Elo/PB/WR never change — one still, held on the timeline |
| `overlay.mov` | 1920x346 | The only animated part: RTA timer + splits revealing |
| `overlay-intro.mov` | 1920x1080 | Full-frame and opaque, so it stays its own 5s clip |

The strips are pixel-identical to the corresponding regions of the full-frame
composition (`MatchOverlay`, still available in `remotion:studio` for previewing
the whole thing at once). Geometry lives in `remotion/layout.ts`.

Transparency depends on `imageFormat: "png"` **and**
`pixelFormat: "yuva444p10le"` in `src/overlayRender.ts` — with either missing,
Remotion captures JPEG frames, alpha is silently discarded, and ffmpeg quietly
downgrades the output to opaque ProRes 422 HQ.

## Config

Copy `mcsr-vid.config.example.json` to `mcsr-vid.config.json` (gitignored) to
override any subset of its fields — see that file for the current defaults and
`src/config.ts` for what each one does. Absent keys fall back to the defaults.

## Project structure

```
src/          Pipeline scripts, MCSR Ranked API client, sync/overlay/Kdenlive logic
remotion/     Overlay video template (React + Remotion)
scripts/      Build helpers (inlines overlay fonts into overlay.css)
media/        Per-match working directory (VODs, renders, project files) — gitignored
```

## Tests

Plain assertion scripts, no test framework — `npm test` runs every
`*.test.ts` under `src/` and `remotion/`. Run one directly with
`npx tsx src/kdenliveProject.test.ts` etc.
