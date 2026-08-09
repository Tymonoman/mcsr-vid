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
npm run generate-project -- <url-or-id>  # full pipeline -> media/<id>/match-<id>.kdenlive
npm run batch -- <file>                  # run the full pipeline over a list of matches
npm run status                           # per-match stage completion table for media/
```

`npm start` opens the TUI; press <kbd>Tab</kbd> on the input screen for recent
matches, to reopen a finished project or resume an incomplete one.

`<file>` for `batch` is one match URL/ID per line; blank lines and `#` comments
are skipped, and one failing match doesn't abort the rest.

`npm run remotion:studio` opens the Remotion Studio to preview and tweak the overlay live.

## Config

Copy `mcsr-vid.config.example.json` to `mcsr-vid.config.json` (gitignored) to
override any of: `leftPose`/`rightPose` (avatar poses), `syncConfidenceThreshold`,
`preRollSec`/`postRollSec`/`defaultRunSec` (VOD trim window), `mediaDir`. Absent
keys fall back to the defaults in `src/config.ts`.

## Project structure

```
src/          Pipeline scripts, MCSR Ranked API client, sync/overlay/Kdenlive logic
remotion/     Overlay video template (React + Remotion)
scripts/      Build helpers (inlines overlay fonts into overlay.css)
media/        Per-match working directory (VODs, renders, project files) — gitignored
```

## Tests

Plain assertion scripts, no test framework:

```sh
npx tsx remotion/resolveSplitSide.test.ts
npx tsx src/kdenliveProject.test.ts
```
