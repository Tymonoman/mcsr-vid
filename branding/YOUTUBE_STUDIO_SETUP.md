# MCSR Replayoffs — YouTube Studio setup guide

Step-by-step channel configuration to do in YouTube Studio (studio.youtube.com)
before publishing the first video. Menu labels below match YouTube's current
layout as of 2026 — if a menu has moved, search Studio's own search bar for
the setting name, it's faster than hunting through tabs.

Everything referenced below (`logo.png`, `banner.png`, About copy, title/
description templates) lives in this repo's `branding/` folder or the
published brand plan: https://claude.ai/code/artifact/82c863d6-1bf5-4e01-b679-a2a3c40fcc80

---

## 0. Before you start

Have these ready in a folder on your machine:

- [ ] `branding/logo.png` (800×800) — profile picture
- [ ] `branding/banner.png` (2560×1440) — channel banner
- [ ] This document open, or the artifact link above, for copy-paste text

---

## 1. Claim the handle and set channel identity

**Studio → Customization → Basic info**

- [ ] **Name:** `MCSR Replayoffs`
- [x] **Handle:** `@MCSRReplayoffs` — confirmed claimed and live (channel ID
      `UCm2mAyONTHlmIxZzNmi388w`). No fallback needed.
- [ ] **Description:** paste the About copy below.
- [ ] **Links** (up to 5 shown on the channel page): add
      `mcsrranked.com` labeled "Match data source." Nothing else at
      launch — distribution plan is YouTube-only for now (Discord/Twitter/
      Reddit get added once there's a backlog of ~10 videos, not before).
- [ ] **Contact info / business email:** add one if you want runners or
      press able to reach you directly; optional at launch.

### About copy (paste verbatim into the Description field)

```
MCSR Replayoffs replays the MCSR Ranked matches that earn it.

Every upload is a full, uncut 1v1 pulled from the top of the MCSR
Ranked ladder — synced dual-POV, live split comparison, ELO and
head-to-head record overlaid in real time as the race happens.
No commentary track, no filler. Just two of the best speedrunners
in the world on the same seed, and the numbers that tell you who's
actually ahead.

New races most days of the week. Every runner featured is named
and linked in the video description — go support them directly.

Match data via mcsrranked.com. MCSR Replayoffs is an independent,
fan-run project — not affiliated with or endorsed by MCSR Ranked
or the MCSR Ranked Playoffs tournament series.
```

Keep that last paragraph intact even if you edit the rest — the
independence disclaimer is there deliberately: the name sits close to both
an existing channel (`@MCSRReplay`) and MCSR Ranked's own official
"Playoffs" tournament brand, so it needs to be explicit and repeated,
not just implied by good faith.

---

## 2. Upload branding assets

**Studio → Customization → Branding**

- [ ] **Picture:** upload `branding/logo.png`. YouTube will let you
      reposition/crop for the circular mask — the badge is centered with
      even padding on all sides, so default centering should already work.
- [ ] **Banner:** upload `branding/banner.png`. Use YouTube's live preview
      to check the "safe area" crop on TV/mobile/desktop — the badge and
      wordmark are positioned left-of-center in the source file specifically
      so they survive the aggressive mobile crop, but double-check anyway
      before saving.
- [ ] **Video watermark:** optional. If you want a subscribe-prompt bubble
      in the corner of every video, upload `branding/logo.png` here too and
      set it to display for the "Entire video" — skip this if you'd rather
      keep the frame clean (the overlay already fills most of it).

---

## 3. Verify your channel (do this early — it gates features you need)

**Studio → Settings → Channel → Feature eligibility**, or Studio will
prompt you when you hit a gated action.

- [ ] Verify with phone number. This is required for:
  - **Custom thumbnails** — the entire Phase 6 thumbnail generator output
    is useless without this being enabled. Do this before your first
    upload, not after.
  - Videos longer than 15 minutes (some races will run past this)
  - External links in video descriptions (the runner-credit links)
  - Appeals/Content ID tools, if it's ever needed

Verification is usually instant. If it's not, don't schedule the first
video until it clears — you need custom thumbnails from upload #1.

---

## 4. Upload defaults

**Studio → Settings → Upload defaults**

This is boilerplate applied to every new upload as a starting point — you
still edit per-video, but it saves retyping the constant parts.

- [ ] **Description:** leave this **empty**. The pipeline now generates
      the entire description — opening, chapters, VOD links, disclaimer and
      hashtags — so anything set here only has to be deleted per upload.
- [ ] **Hashtags: never use Studio's hashtag chip field.** This is the one
      that makes you pick each tag from a dropdown. It also lowercases what
      you enter and double-spaces it into the description, which is exactly
      what the first four live uploads show
      (`#mcsrranked  #minecraftspeedrun  ...`). Hashtags typed as plain text
      in the description body are auto-linked by YouTube with no clicking at
      all, and the first three still render above the title. The generated
      description already ends with the three that matter:
      ```
      #MCSRRanked #MCSR #MinecraftSpeedrunning
      ```
      Three, not ten: over 15 YouTube voids every hashtag on the video, 3-5
      is the optimum, and only the first three are ever visible. Per-player
      tags (`#edcr`) were dropped — a nickname hashtag has no search volume
      of its own and was consuming two of the three visible slots.
- [ ] **Tags:** `mcsr ranked, minecraft speedrun, minecraft randomizer,
      speedrunning, minecraft 1v1, ranked speedrun`
- [ ] **Category:** Gaming
- [ ] **Language:** English
- [ ] **Visibility default:** set to **Private**. This is a safety net —
      it means a finished upload never goes live by accident before you've
      set the real title, thumbnail, and schedule time. You flip it to
      Public/Scheduled manually every time.
- [ ] **License:** Standard YouTube License (not Creative Commons) — you're
      publishing edited/overlaid footage of other players' recorded
      matches, not original footage you'd want freely reusable. If you're
      ever unsure about a rights question specific to a match, that's a
      real legal judgment call, not something to default your way past.
- [ ] **Comments:** Allow all, hold potentially inappropriate comments for
      review (Studio's default moderation filter). Revisit if spam becomes
      an issue.
- [ ] **Automatic captions:** leave on. Free accessibility, no extra work.

---

## 5. Audience setting (every video, not just a channel default)

YouTube asks this per upload, but the channel default matters too:

- [ ] **"Is this video made for kids?"** → **No.** This is a real
      determination under YouTube's/COPPA's actual criteria (not legal
      advice from me) — but competitive ranked speedrun analysis content
      aimed at an adult/teen ladder-following audience is squarely
      general-audience, not child-directed, regardless of Minecraft being
      the game. Saying "yes" here disables comments, notifications, and
      personalization on the video, which would break the "credit + notify
      runners" policy this channel is built around.

---

## 6. Monetization (check status, nothing to configure yet)

**Studio → Monetization**

- [ ] Confirm you're not yet eligible (expect this at launch): current
      YouTube Partner Program threshold is roughly 1,000 subscribers **and**
      4,000 public watch hours in the trailing 12 months — **re-verify the
      exact numbers in Studio directly**, YouTube adjusts these periodically
      and this isn't guaranteed current.
- [ ] Nothing to do here now. Revisit once Studio shows you as eligible;
      apply then. No memberships/sponsorships/Patreon at launch per the
      brand plan — ads-only, later.

---

## 7. Playlists

One playlist, **`MCSR Ranked 1v1 — Full Races`**, holding every upload in
chronological order. Add each new video to it at publish time (Studio's
upload flow has a Playlist picker on the Details step — set it there rather
than going back afterwards).

This reverses the original "skip playlists at launch" call. The channel
audit found 77% of views arriving from a single source and no mechanism to
chain one video into the next; a playlist is what turns an ended video into
a started one, and session continuation is itself a satisfaction signal.

A second "top bracket" playlist is deliberately deferred — with five uploads
it would hold one or two videos and chain nothing. Revisit at ~15.

---

## 8. Publishing the first video

Once the pipeline (`fetch-match` → `download-vods` → `validate-sync` →
`render-overlay` → `generate-project`) has produced a final export and the
thumbnail generator has produced a thumbnail:

- [ ] **Upload** the video file in Studio.
- [ ] **Title**, following the fixed template (revised from the original
      plain version below — both live uploads already drifted to a
      hook-driven title on their own, and a live competitor check
      [artifact](https://claude.ai/code/artifact/82c863d6-1bf5-4e01-b679-a2a3c40fcc80)
      confirms hook-driven outperforms plain-functional in this niche):
      ```
      [HOOK, one clause] | [PlayerA] vs [PlayerB] | MCSR Ranked 1v1
      ```
      Front-load "MCSR Ranked 1v1" + both names within the first ~45
      characters (mobile truncation window). Target 70-100 characters
      total — `match-<matchId>.title.txt` generates the names-and-format
      half and prints the hook budget plus where the finished title lands
      (e.g. "Replace <HOOK> with 31-47 characters (title lands at
      70-86)"). Write a hook inside that range; the live titles so far sit
      at 45-61, under the band that outperforms by 10-14%. Lock this construction pattern instead of reinventing the
      hook's voice per video — upload #1 ("WANNABE vs REAL GOAT...") and
      #2 ("They REALLY think they'll get RANK #1...") already differ in
      style from each other.
- [ ] **Thumbnail:** upload the generated PNG (requires verification from
      step 3 above).
- [ ] **Description:** paste
      `media/<matchId>/match-<matchId>.description.txt` as the entire
      description and edit nothing. Do not add hashtags in Studio (see
      step 4), and do not hand-write an opening above it.

      This replaces the old split where the pipeline generated only the
      lower half and you hand-wrote a keyword-rich block on top. That block
      was never written once across five uploads, so every live description
      opened with two raw Twitch URLs — which is the whole 150-200 character
      "Show more" preview, carrying zero keywords, on a channel where search
      delivers 1.9% of views. The generator now produces the opening itself:

      ```
      BeefSalad vs v_strid — MCSR Ranked 1v1, 1788 vs 1765 elo. Full
      same-seed race, synced dual-POV with live split comparison.
      Result: v_strid 11:12.
      ```

      Both nicknames land in the first ~20 characters (they are the search
      terms in this niche) and "MCSR Ranked 1v1" clears the ~50-character
      mobile truncation. The elo figures are each player's rating *going
      into that match*, read from `changes[].eloRate - changes[].change`,
      not their rating today — the same fix §02 of the channel audit
      applied to the overlay.

      Below the opening: chapters, then the VOD deep links (`?t=Ns`, seeking
      to the exact match moment in each player's own Twitch VOD), the match
      data link, the independence disclaimer, the feedback-invite line, and
      the three hashtags. The "synced dual-POV with live split comparison"
      clause is load-bearing beyond SEO — it is the only place the
      description states what the channel *adds*, which is what a YPP
      reviewer looks for.
- [ ] **Playlist:** add to `MCSR Ranked 1v1 — Full Races` (see step 7).
- [ ] **Made for kids:** No (see step 5).
- [ ] **Visibility:** Schedule (not Publish now) for **Tuesday, 17:00 UTC**
      — the launch anchor time, chosen to land at EU evening prime-time and
      US late-morning/lunch simultaneously. Regional read at that anchor:

      | Region | Local time |
      |---|---|
      | US Eastern | 1:00 PM EDT / 12:00 PM EST |
      | US Central | 12:00 PM CDT / 11:00 AM CST |
      | US Pacific | 10:00 AM PDT / 9:00 AM PST |
      | UK | 6:00 PM BST / 5:00 PM GMT |
      | Central Europe | 7:00 PM CEST / 6:00 PM CET |

      US and EU shift clocks on different dates each spring/fall — the
      17:00 UTC anchor itself doesn't move, only these local labels drift
      by an hour for a couple weeks twice a year. Not worth pre-solving.
- [ ] **After it goes live:** credit and notify both featured runners
      (Discord/Twitter, whichever they're reachable on) — this channel's
      policy is notify-always, no opt-in gate required before publishing,
      but always notify after.

Cadence: revised down to **Tuesday / Thursday** (2/week), from the original
Tuesday/Thursday/Saturday (3/week) plan. Both live uploads already slipped
off that plan (#1 published Monday, #2 scheduled Thursday), and the manual
pipeline steps (VOD download, sync validation, Kdenlive pass) still haven't
been timed for real — so 3/week was provisional and hasn't held up. Scale to
3/week only after 3-4 consecutive weeks of consistently hitting 2/week, not
before. Don't chase competitor cadence either: a live check found MCSR
Matches and MCSR Vault both publishing near-daily right now, which proves
the niche supports that volume but isn't a reason to match it — see the
[brand plan artifact](https://claude.ai/code/artifact/82c863d6-1bf5-4e01-b679-a2a3c40fcc80)
for the full comparison.

---

## 9. First two weeks — full checklist

1. [ ] Claim `@MCSRReplayoffs` (or a fallback handle) in Studio — step 1.
2. [ ] Upload logo + banner — step 2.
3. [ ] Verify the channel (phone) — step 3, do this first, it gates
       thumbnails.
4. [ ] Set upload defaults — step 4.
5. [ ] Pick 3–5 candidate top-bracket matches and run them fully through
       the pipeline end to end, **timing each stage** — this is what turns
       the 3–5/week cadence target from a guess into a real number.
6. [ ] Publish video #1 using the full template above, at the Tuesday
       17:00 UTC anchor.
7. [ ] After each of the first several uploads, check Studio Analytics for
       actual audience geography/watch-time-by-hour once it has enough
       data — that real data should replace the 17:00 UTC estimate above,
       not just supplement it.

---

## 10. Explicitly deferred — don't do these at launch

- **Cross-posting to Discord/Reddit/Twitter** — revisit once there's a
  backlog of ~10 videos; YouTube-only distribution at launch is deliberate.
- **Shorts / highlight clips** — full uncut races only, by design; MCSR
  Vault's Shorts-heavy approach is the biggest available growth lever but
  is explicitly out of scope until a 90-day review, not before.
- **Applying for monetization** — wait until Studio shows actual
  eligibility.
- **A channel trailer** — with no on-camera presence, video #1 already
  functions as the introduction; a separate trailer isn't worth the
  production time yet.
