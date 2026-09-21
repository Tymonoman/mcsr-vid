# mcsr-vid

Turns an [MCSR Ranked](https://mcsrranked.com) match into a finished race video, and a
playoff series into one. It pulls the match, player and head-to-head stats from the MCSR
Ranked API, downloads a trimmed window of each player's Twitch VOD, aligns the two POVs on
the pre-match countdown, renders an overlay of nicknames, elo, PBs and live split times,
and writes a finished MP4 (or a `.kdenlive` project to open when a match needs a human). A
Short, four thumbnails, the title, description and tags come with it, and a web dashboard
runs the morning: check the sync, pick a hook, upload, finish on YouTube.

The videos go up as [MCSR Replayoffs](https://www.youtube.com/channel/UCm2mAyONTHlmIxZzNmi388w).

## Requirements

- Node.js 20.12+ (the container image is Node 24)
- [`yt-dlp`](https://github.com/yt-dlp/yt-dlp) and `ffmpeg`/`ffprobe` on `PATH`
- MLT (`melt-7`) / [Kdenlive](https://kdenlive.org) only to open or validate a generated
  project — the headless `export:fast` path needs neither
- `npm install`

## The dashboard

`npm run dashboard` (`PORT`, default 8080). Two screens: the list — Suggestions (ranked
matches worth a video, the playoff bracket, tonight's queue and the nightly strip), Rendered,
A/B, Settings — and the match, laid out in the order the morning happens: **Check** (final
video, sync check, fix the sync by hand) · **Package** (hook, thumbnails, splits, title and
description) · **Publish** (upload or adopt a Studio draft, finish on YouTube, the publish kit)
· **After** (the Short, manage). The nightly renders the first card in dashboard order at
03:00 UTC (`nightlyRenderHourUtc`), the Short and the MP4 with it.

On the lab both containers share one image and bind-mount the repo and `/media`: server
code (`src/`) is read at boot, so `docker restart mcsr-dashboard` after pulling; the browser
files (`public/`) are served from disk and need only a reload.

## Commands

Pass a match page URL (magmamcsr.com) or a bare match id; extra arguments go after `--`.
Every stage reuses what is already under `<mediaDir>/<id>/`.

| Command | What it does |
| --- | --- |
| `npm run export:fast -- <id>` | The finished MP4 in one ffmpeg pass (Intel VAAPI on the lab). Renders first if it must. |
| `npm run generate-project -- <id>` | The full pipeline to `match-<id>.kdenlive`, for a match that needs a human. |
| `npm run short -- <id> [--pick=N \| --at=<ms>]` | The vertical ~22 s Short of the match's best moment, plus its title and description. |
| `npm run series -- <id \| all> [--join-only]` | A playoff series as one video: every game rendered, joined into game 1's `series-<id>.mp4`, the Short from the best game. |
| `npm run download-vods -- <id>` | Both POV windows and the chat, ahead of a render (Twitch keeps archives 14 days). |
| `npm run sync-status -- [id]` | Where a match's POV clips are placed; with an id, derives `sync.json` from the project. |
| `npm run validate-sync -- <id>` | Check or refine the alignment and render a preview clip. |
| `npm run render-overlay -- <id>` | The overlay stills and the timer strip only. |
| `npm run generate-thumbnail -- <id>` | The default-pose `thumbnail.png` only. |
| `npm run status` | Per-match stage table for the media directory. |
| `npm run score -- <id>` | Split-by-split breakdown plus the closeness/chaos score. |
| `npm run batch -- <file>` | The full pipeline over one URL/id per line. |
| `npm start` | The terminal UI. |
| `npm run remotion:studio` | Remotion Studio, to preview the compositions live. |

`CLAUDE.md` lists the rest — `still`, `bench`, `validate-project`, `chat`, `reason`,
`analytics`, the browser checks — and says what each render produces.

## Config

Copy `mcsr-vid.config.example.json` to `mcsr-vid.config.json` (gitignored) to override any
subset of its fields; absent keys fall back to the defaults. The example lists every key at
its default value, and `src/config.ts` says what each one does. The dashboard's Settings tab
edits the handful worth changing without an ssh session.

The Twitch-follower signal in the match suggestions needs a Twitch app. Put its credentials
in a `.env` at the repo root (gitignored, read via Node's `process.loadEnvFile`); without
them, popularity falls back to how often a player turns up streaming ranked matches.

```sh
TWITCH_CLIENT_ID=your_client_id
TWITCH_CLIENT_SECRET=your_client_secret
```

`reasonerCommand` hands one question (which 22 seconds the Short cuts) to an LLM CLI; the
example names Antigravity (`agy`). It has to be in the container image and authenticate
with an API key (`modelProvider: gemini` in `~/.gemini/antigravity-cli/settings.json`,
`GEMINI_API_KEY=…` in the repo's `.env`), because the interactive sign-in caches into a
keyring no container has. A match is asked once; the answer lives in `short-reason.json`.
Null or absent, everything keeps its heuristic.

YouTube: `npm run youtube-auth` once (the token file is `youtube-token.json`); the
dashboard's YouTube panel does the rest. `scripts/preflight.sh` runs at session start and
says when a credential is missing or expiring.

## Tests

Plain assertion scripts, no framework. `npm run test:unit` runs every `*.test.ts` under
`src/` and `remotion/` except the two that drive Chromium and ffmpeg; `npm test` adds those.
Run one directly: `npx tsx src/pipeline/kdenliveProject.test.ts`.
`bash scripts/browser-checks/run-all.sh <url>` drives the dashboard in a real browser.

## Layout

```
src/
  api/          MCSR Ranked and Twitch clients, the API types, avatar renders
  pipeline/     a match to a video: fetch, VODs, sync, overlay, project, export, the text
  thumbnails/   the variant strip
  shorts/       the moment scorer, the reasoner, the vertical render
  playoffs/     the bracket and its games; a series as one video
  youtube/      the Data API client and auth, uploads, the channel pairing, the publish slot
  dashboard/    the server, its routes, jobs, the nightly, suggestions, the shelf
  cli/          batch, status, score, chat, bench, the TUI
  fixtures/     saved API responses the tests read
remotion/       the overlay, thumbnail and Short compositions (React + Remotion)
public/         the dashboard's browser files, served from disk — no build step
scripts/        the browser checks, the overlay CSS build, preflight, the subreaper
handbook/       the operator's pages: the Studio routine, the API review, the domain
branding/       the logo and banner and their generator
docs/           the GitHub Pages site for mcsr.sezamki.site (not repo docs)
deploy/         the lab's systemd user unit
```

Tests sit beside what they test.
