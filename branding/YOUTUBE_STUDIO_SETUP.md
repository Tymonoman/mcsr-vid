# MCSR Replayoffs — the per-upload Studio routine

The one-time channel setup (handle, logo, banner, phone verification, upload
defaults) is done. What is left is this: the manual steps in YouTube Studio for
each video, until the API upload audit clears and the dashboard can do it.

Everything you paste is pre-generated. Open the match in the dashboard and use
the **Publish kit** panel — it has a copy button per field below, with the
`<HOOK>` already substituted — rather than opening the files by hand. The files
are `media/<matchId>/match-<matchId>.{title,description,tags}.txt` and the
thumbnail PNGs beside them.

Menu labels match Studio's 2026 layout; if one has moved, its own search bar is
faster than hunting through tabs.

---

## Upload

- [ ] **Video file:** the finished MP4 (`npm run export:fast`, or the nightly
      render's output).
- [ ] **Title:** the first line of `match-<matchId>.title.txt`, with `<HOOK>`
      replaced. The file prints the hook budget and where the finished title
      lands (e.g. "Replace `<HOOK>` with 31-47 characters (title lands at
      70-86)"); write inside that range. Both the dashboard and the upload API
      refuse a title still containing `<HOOK>`.
- [ ] **Description:** paste `match-<matchId>.description.txt` as the entire
      description and edit nothing. It already carries the opening, chapters,
      the VOD deep links, the match-data link, the disclaimer and the three
      hashtags (`#MCSRRanked #MCSR #MinecraftSpeedrunning`, from
      `HASHTAGS` in `src/description.ts`). Do not hand-write an opening above
      it, and **never use Studio's hashtag chip field** — it lowercases what
      you type and double-spaces it into the description; plain-text hashtags
      in the body are auto-linked with no clicking.
- [ ] **Tags:** the lines of `match-<matchId>.tags.txt`, comma-joined
      (`buildTags` in `src/description.ts` keeps them inside a 450-character
      budget against YouTube's 500).
- [ ] **Thumbnail:** upload the chosen variant's PNG.
- [ ] **Playlists** — three, all of which the API path would add automatically:
      - `MCSR Ranked matches` (the season playlist, `youtubePlaylistTitle` in
        `src/config.ts`; it exists as `PLHG-jSA-dWDo`)
      - `<A> vs <B> · MCSR Ranked` — the matchup, names sorted
        case-insensitively (`matchupPlaylistTitle` in `src/youtube.ts`)
      - `<nickname> · MCSR Ranked matches` — one per player, the link a runner
        shares (`playerPlaylistTitle`)
- [ ] **Made for kids:** **No.** Competitive ranked speedrun content aimed at a
      ladder-following adult/teen audience is general-audience, Minecraft
      notwithstanding. "Yes" disables comments, notifications and
      personalisation, which breaks the credit-and-notify policy this channel
      runs on.
- [ ] **Visibility:** **Schedule** (not Publish now) for **19:00 UTC** —
      `publishHourUtc` in `src/config.ts`, measured on the active competitor
      (`src/publishSlot.ts`). The publish kit prints the next slot; it skips one
      less than an hour out, because a scheduled time YouTube has already passed
      rejects the upload and an 800 MB file is not on the platform in five
      minutes.

## After it goes live

- [ ] Upload the Short (`short-<matchId>.mp4`, with its own
      `.title.txt` / `.description.txt`).
- [ ] Add the related link and the end screen.
- [ ] Notify both runners — the publish kit has a DM per player with the
      `youtu.be` link. Notify-always, no opt-in gate before publishing.
- [ ] Tick the five toggles on the dashboard's publish checklist so the Rendered
      tab stops counting the match as ready.
