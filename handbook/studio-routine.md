# MCSR Replayoffs — the Studio routine (the fallback)

The dashboard uploads since the API review cleared (15 Sept 2026): Package → Publish →
**Upload** sends the file, title, description, tags and thumbnail, schedules it, and **Finish
on YouTube** adds the playlists, the channel's comment and the tags. This page is for the other
two cases: a video uploaded by hand in Studio (paste the 11-character id into **Adopt this
draft** and the dashboard writes the rest), and what only Studio can do (pinning the comment,
the Short's related-video link, an end screen) when the Studio worker could not do it.

Everything you paste is pre-generated. Open the match in the dashboard and use
the **Publish kit** panel — it has a copy button per field below, with the
`<HOOK>` already substituted — rather than opening the files by hand. The files
are `/media/<matchId>/match-<matchId>.{title,description,tags}.txt` and the
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
      `HASHTAGS` in `src/pipeline/description.ts`). Do not hand-write an opening above
      it, and **never use Studio's hashtag chip field** — it lowercases what
      you type and double-spaces it into the description; plain-text hashtags
      in the body are auto-linked with no clicking.
- [ ] **Tags:** the lines of `match-<matchId>.tags.txt`, comma-joined
      (`buildTags` in `src/pipeline/description.ts` keeps them inside a 450-character
      budget against YouTube's 500).
- [ ] **Thumbnail:** upload the chosen variant's PNG.
- [ ] **Playlists** — three, all of which the API path would add automatically:
      - `MCSR Ranked matches` (the season playlist, `youtubePlaylistTitle` in
        `src/config.ts`; it exists as `PLHG-jSA-dWDo`)
      - `<A> vs <B> · MCSR Ranked` — the matchup, names sorted
        case-insensitively (`matchupPlaylistTitle` in `src/youtube/youtube.ts`)
      - `<nickname> · MCSR Ranked matches` — one per player, the link a runner
        shares (`playerPlaylistTitle`)
- [ ] **Made for kids:** **No.** Competitive ranked speedrun content aimed at a
      ladder-following adult/teen audience is general-audience, Minecraft
      notwithstanding. "Yes" disables comments, notifications and
      personalisation, all of which the channel needs.
- [ ] **Visibility:** **Schedule** (not Publish now) for **19:00 UTC** —
      `publishHourUtc` in `src/config.ts`, measured on the active competitor
      (`src/youtube/publishSlot.ts`). The publish kit prints the next slot; it skips one
      less than an hour out, because a scheduled time YouTube has already passed
      rejects the upload and an 800 MB file is not on the platform in five
      minutes.

## After it goes live

- [ ] Upload the Short (`short-<matchId>.mp4`, with its own `.title.txt` /
      `.description.txt`) only if the chain did not: the match's Short up step
      failed, or it never ran.
- [ ] The pinned comment, the end screen and the Short's related link: the
      Studio worker does these (`npm run studio -- worker`). By hand only when
      it reports `needsHuman`, or the worker is off.
- [ ] Tick the five toggles on the dashboard's publish checklist so the Rendered
      tab stops counting the match as ready.

## Community poll (supervised first run)

The worker posts a "WHO TAKES IT?" poll on each long-form public in the last 36 h once
`communityPolls` is `true` in `mcsr-vid.config.json` (`src/youtube/studioCommunity.ts`). Its
selectors for the Community tab's composer are guesses until you have watched one run, so:

1. Pick a long-form that is public, not blocked, not a DNF, posted today — the CLI refuses the
   other three. From the mcsr container, with the worker stopped (one browser at a time):
   `npm run studio -- poll <matchId> --dry-run`. It opens
   `youtube.com/channel/<id>/community`, picks Poll, fills the question, the two names and the link,
   and stops before Post. Read the three `studio-community-*.png` screenshots in the match
   directory: opened (is the composer there, is it our channel?), filled (two lines of text, both
   options). A `{ error }` names the element it could not find; fix that one selector in
   `SELECTORS` and run the dry run again.
2. Live: `npm run studio -- poll <matchId>`. It clicks Post and waits for the new post on the tab;
   check the channel's Community tab by hand once. A second run on the same video must answer
   `already-posted`.
3. Set `communityPolls: true` on the box. The worker takes it from there, at most two a cycle; a
   video that fails three cycles running shows up in the morning report's Needs you, and
   `.community-posts.json` in `/media` is the record. Nothing is ever removed or edited here: a
   wrong poll is deleted by hand in Studio.
