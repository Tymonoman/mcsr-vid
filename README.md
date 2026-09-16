# mcsr-vid

Turns an [MCSR Ranked](https://mcsrranked.com) 1v1 into a finished race video.
It pulls the match, player and head-to-head stats from the MCSR Ranked API,
downloads a trimmed window of each player's Twitch VOD, aligns the two POVs on
the pre-match countdown, renders an overlay of nicknames, elo, PBs and live
split times, and writes either a `.kdenlive` project to open or a finished MP4.

The videos go up as [MCSR Replayoffs](https://www.youtube.com/channel/UCm2mAyONTHlmIxZzNmi388w).

## Requirements

- Node.js 20.12+ (the container image is Node 24)
- [`yt-dlp`](https://github.com/yt-dlp/yt-dlp) and `ffmpeg`/`ffprobe` on `PATH`
- MLT (`melt-7`) / [Kdenlive](https://kdenlive.org) to open or validate a
  generated project — not needed for the headless `export:fast` path
- `npm install`

## Commands

Pass a full match page URL (magmamcsr.com) or a bare match ID; extra arguments go
after `--`. Each stage can be run standalone against an already-downloaded
match — existing files under `media/<id>/` are reused instead of re-fetched.

| Command | What it does |
| --- | --- |
| `npm run generate-project -- <id>` | Full pipeline → `media/<id>/match-<id>.kdenlive` |
| `npm run export:fast -- <id>` | The same video as one finished MP4, no Kdenlive |
| `npm run short -- <id>` | A vertical ~22s Short of the match's best moment |
| `npm run generate-thumbnail -- <id>` | The default-pose `thumbnail.png` only, no hook; the pipeline's thumbnail stage renders the configured A/B variants |
| `npm run dashboard` | Web UI: match suggestions, render, publish kit (`PORT`, default 8080) |
| `npm start` | Terminal UI: pick a match, resume one, reopen a finished project |
| `npm run fetch-match -- <id>` | Match/player/versus JSON |
| `npm run download-vods -- <id>` | Trimmed VODs into `media/<id>/` |
| `npm run validate-sync -- <id>` | Check/refine alignment, render a preview clip |
| `npm run render-overlay -- <id>` | Overlay stills and the timer strip |
| `npm run batch -- <file>` | The full pipeline over one URL/ID per line (`#` comments skipped) |
| `npm run status` | Per-match stage completion table for `media/` |
| `npm run score -- <id>` | Split-by-split breakdown plus closeness/chaos score |
| `npm run remotion:studio` | Remotion Studio, to preview and tweak the compositions live |

`CLAUDE.md` documents the rest — `still`, `bench`, `export:nvenc`,
`validate-project`, `chat`, `analytics` — and exactly what each render produces.

## Config

Copy `mcsr-vid.config.example.json` to `mcsr-vid.config.json` (gitignored) to
override any subset of its fields; absent keys fall back to the defaults. The
example lists every key at its default value, and `src/config.ts` says what each
one does.

The Twitch-follower signal in the match suggestions needs a Twitch app. Put its
credentials in a `.env` at the repo root (also gitignored, read via Node's
built-in `process.loadEnvFile`); without them, popularity falls back to how
often a player turns up streaming ranked matches.

```sh
TWITCH_CLIENT_ID=your_client_id
TWITCH_CLIENT_SECRET=your_client_secret
```

`reasonerCommand` hands reasoning questions (today: which 22 seconds the Short
cuts) to an LLM CLI; the example names Antigravity. Install it on the lab host
with `curl -fsSL https://antigravity.google/cli/install.sh | bash` (lands in
`~/.local/bin/agy`), then sign in once interactively or set an API key with
`modelProvider gemini`; `agy` exits 1 until it has auth. A match is asked about
once: the answer lives in `<mediaDir>/<id>/short-reason.json`, read by the
dashboard and the Short CLI alike so a clicked row is the window that gets cut.
`npm run reason -- <id>` prints the candidates, the prompt and the answer, asks
afresh and saves it. Null or absent, everything keeps its heuristic.

The dashboard runs in a container, and that is where this has to work — not on
the host. Two things follow. The binary must be *in the image* (add the install
line to the `Dockerfile`; installing it on the lab host puts it somewhere the
container cannot see), and it must authenticate with an API key rather than the
interactive sign-in: `agy`'s OAuth caches into the host's keyring
(Secret Service/dbus), which no container has. Set `modelProvider: gemini` in
`~/.gemini/antigravity-cli/settings.json` and put the key in the repo's `.env`
as `GEMINI_API_KEY=…` — `.env` is inside the bind mount, so both containers read
it, and `src/reasoner.ts` loads it before spawning the command.

## Tests

Plain assertion scripts, no test framework — `npm test` runs every `*.test.ts`
under `src/` and `remotion/`. Run one directly with `npx tsx src/kdenliveProject.test.ts`.

## Project structure

```
src/          Pipeline stages, MCSR Ranked API client, sync/overlay/project logic, dashboard server
remotion/     Overlay, thumbnail and Short compositions (React + Remotion)
public/       Dashboard client, served from disk — no build step
scripts/      Build, export, preflight, asset vendoring, the subreaper
docs/         GitHub Pages site for mcsr.sezamki.site
branding/     Channel art and the per-upload YouTube Studio routine
deploy/       The lab host's systemd user unit
media/        Per-match working directory (VODs, renders, project files) — gitignored
```
