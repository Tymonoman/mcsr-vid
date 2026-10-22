# Setting up X posts through the browser

The same one post a day as `handbook/x-setup.md` (the hand-cut Short of the newest public
long-form, its hook and the pair, the YouTube link), but through a real Chrome signed into the
channel's X account instead of the paid API. No developer account, no card, no keys. What is
posted and what is refused is unchanged: CLAUDE.md "X posts".

Nothing posts until step 5. Nothing here ever types a password, answers 2FA or solves a CAPTCHA:
you do every sign-in by hand, over the remote screen.

## 1. The account

Make the channel's X account (MCSR Replayoffs, @mcsrreplayoffs) as usual, with a phone or email
you can reach from the lab: X asks for a code on a new device now and then, and the worker stops
and tells you when that happens rather than guess. The browser only ever posts as
`@mcsrreplayoffs` (`"xHandle"` in `/app/mcsr-vid.config.json` if the handle ever changes, without
the "@"): signed in as anyone else, it does nothing and says so.

## 2. The one-time login, over the remote screen

From the mcsr (Claude) container, which has Chrome:

```
npm run x -- login
```

It prints a URL (`http://<host>:6080/vnc.html?autoconnect=1`), a one-time password and an expiry
(15 minutes), exactly like the Studio login. Open the URL on your phone or laptop over Tailscale,
enter the password, and you see Chrome on `x.com/login`. Sign in there yourself. Tick nothing
that says "remember this browser" off: the point is that the cookies stay. Back in the terminal,
press Enter. It prints one word:

- `ok` — the timeline loaded with the composer; the login is saved in `/app/.x-profile`
  (`X_PROFILE_DIR` moves it; the folder is private, mode 700, and gitignored).
- `signed-out` — X still shows the login page; run `login` again.
- `verify` — X wants a code or a check, or has a sheet over the timeline; finish it over the
  same screen and run `login` again.
- `wrong-account` — the browser is signed in, but not as @mcsrreplayoffs (the line ends with
  the handle it read); sign that account out over the same screen and sign in as the channel.

Check at any time without the screen: `npm run x -- probe` (loads the timeline, prints the same
word) and `npm run x -- status` (the profile, the last probe, the last post, the next candidate).

## 3. One post by hand, dry first

```
npm run x -- post <matchId> --dry-run
```

This opens the composer, types the text, checks the composer holds exactly that text, saves
`x-compose-<time>.png` in the match folder, empties the composer again (so X keeps no draft) and
closes. It does not attach the Short: an upload to X is not a dry run. Look at the screenshot.
Then:

```
npm run x -- post <matchId>
```

It types and checks the text, attaches the Short, waits for X to process it, checks the text
again, writes `x.json` into the match folder (marked pending), clicks Post, and waits for "Your
post was sent" or the post on the timeline. Then it saves `x-posted-<time>.png` and puts X's
post id into `x.json`. That match is never posted again, even if the confirmation never came
(see "unconfirmed" below). If the four API keys are also in `/app/.env`, the API path is used
unless you add `--via browser`.

## 4. What gets posted, and what never does

The clip is always `short-<id>.mp4` from `npm run short:hand`; the text is
`<hook> | <left> vs <right>`, the `youtu.be` link, `#mcsr #minecraft`. Refused outright, before
the browser opens: a blocked player, a long-form not public yet, no hand-cut Short or "No Short
for this one", a hook that fails the spoiler/label/seed check, over 280 characters, a DNF match,
a match already on X. Exactly the API poster's list (`planXPost`); the browser adds no rule and
removes none.

## 5. Turn on the automatic posts

In `/app/mcsr-vid.config.json` add `"xBrowserPost": true`. Like `xAutoPost` and `nightlyUpload`
it is deliberately not in the Settings tab: it posts in public on another platform. The Studio
worker (`scripts/studio-worker.sh`, the supervised `npm run studio -- worker --enable`) reads it
on its next start; restart the worker after the edit.

From then on, at the end of each ~20-minute worker cycle (never during the nightly blackout,
02:50–07:30 UTC), once its own Studio browser is closed, the worker opens Chrome on the X profile,
probes, and posts the newest candidate: at most **one post per UTC day, and none within 40 hours
of the last** (`"xMinHoursBetweenPosts"` in the config file, default 40), shared with the API
poster. A newer `x.json` than that means nothing goes out. While the API poster is on
(`xAutoPost` and its four keys), the browser poster stays idle: never two at once. A failed
attempt waits for the next UTC day. A worker started with `--dry-run` does the dry run above
(nothing attached, nothing clicked), at most once a UTC day.

To stop it: set `"xBrowserPost": false` and restart the worker. To skip one match for good: hide
it on the dashboard. To sign out: delete `/app/.x-profile`.

## 6. What the morning report's "Needs you" lines mean

Only while `xBrowserPost` is on, from `/media/.x-browser.json`:

- **X: signed out, sign in with npm run x -- login** — the cookies expired or X logged the
  browser out. Nothing was posted; nothing retries until you sign in again.
- **X: verification prompt, clear it over npm run x -- login** — X put a code, a check or a
  sheet in front of the timeline. Same fix; the worker never answers it.
- **X: the browser is not signed in as @mcsrreplayoffs, sign in with npm run x -- login** —
  another account is signed in (or the page no longer shows whose). Nothing was posted.
- **X: post may have gone out unconfirmed, check x.com/mcsrreplayoffs (match N)** — Post was
  clicked but X showed neither "Your post was sent" nor the post. Look at the profile. If the
  post is there, nothing to do: the line goes with the next post (or at once if you put its id,
  the number after `/status/` in its link, in that match's `x.json` as `postId`). If it is not,
  delete that `x.json`: the line goes on the worker's next cycle and the match is posted again
  once the 40-hour gap allows.
- **X post failed: …** — the composer did not behave (the video never finished processing, the
  text came out different from the plan, a changed page) and Post was never clicked. The
  screenshots in the match folder show what it saw. A failed post waits for the next UTC day;
  `npm run x -- post <id>` once you have looked, to try at once.

A clean day has no line.

## 7. Limits, and why it is slow on purpose

- One post every 40 hours at most, and only ever our own clip with our own link. Nothing is
  read, liked, followed or replied to.
- The browser is human-paced: 2–6 second pauses between steps, the text typed a few words at a
  time. X's rules allow automation of your own account's posting but act on bursts and on
  anything that looks like a script; one slow post a day from a browser that stays signed in is
  as close to a person as a tool gets. Do not raise the cadence.
- X changes its page markup without notice. The selectors are those of 22 Oct 2026
  (`src/x/xBrowser.ts`); when a post starts failing with the same error every day, that is the
  first place to look, and the compose screenshot is the evidence.
- The worker runs one browser at a time: the X session only opens after the Studio one has
  closed, and `npm run x -- post` refuses while any Studio job holds Chrome.
- The API route (`handbook/x-setup.md`) stays available; with keys present it is preferred,
  since a signed-in session is the more fragile of the two.
