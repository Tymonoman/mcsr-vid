# Setting up X posts

Once this is done, the dashboard posts one clip a day to the channel's X account: the hand-cut
Short of the newest public long-form, its hook and the pair, and the YouTube link. What it posts
and what it refuses: CLAUDE.md "X posts", and `handbook/claude-md-reference.md` "X posts" for the
long version. Nothing posts until step 7.

**Cost first.** X has no free API tier any more (checked 14 Oct 2026). It runs on prepaid
credits, and a post with a link costs $0.20, so one a day is about $6 a month. Saving your first
card gives a one-time $20 credit if you qualify, which covers about three months, but it expires
three months after it's granted.

## 1. Create the account

Make the channel's X account (MCSR Replayoffs) as usual. Everything below is done signed in **as
that account**: the access token you generate in step 4 belongs to whichever account owns the app.

## 2. Developer account

Go to [console.x.com](https://console.x.com), sign in as the channel account, and accept the
Developer Agreement. For the use case, write something like: "Posts one short clip a day from
our own YouTube channel's videos, with a link to the full video. No reading of other users'
data, no DMs."

## 3. Billing

Under billing, add a card (that's when the $20 credit is granted, if you qualify) and set a
**spending limit** per billing cycle, e.g. $10. Auto-recharge is optional. Without it, posts
stop when the credits run out, and the dashboard logs X's refusal once a day.

## 4. The app and its keys

1. Create an app (any name, e.g. `mcsr-replayoffs-poster`).
2. In its user authentication / permissions settings, set **App permissions: Read and write**
   (not the DM level). If it asks for a callback or website URL, use
   `https://mcsr.sezamki.site`.
3. Under **Keys and tokens**: copy the **API Key** and **API Key Secret**, then generate the
   **Access Token** and **Access Token Secret**. Check that the token says *Read and Write*. A
   token generated before step 2 stays read-only, so regenerate it after changing the
   permissions.

The console only shows each secret once. Keep them in your password manager.

## 5. Put the four keys in `/app/.env`

Add these four lines to `/app/.env` (the file that already holds the Twitch and Telegram keys):

```
X_API_KEY=<API Key>
X_API_SECRET=<API Key Secret>
X_ACCESS_TOKEN=<Access Token>
X_ACCESS_SECRET=<Access Token Secret>
```

Then check from the Claude container (it prints the key names, never the values):

```
npm run x -- status
```

You should see `keys: all four set`, plus the next match it would post.

## 6. One post by hand

Preview first. This shows the exact text and signs nothing:

```
npm run x -- post <matchId> --dry-run
```

Then post it for real and check the link it prints:

```
npm run x -- post <matchId>
```

That writes `x.json` into the match's folder, and that match is never posted again.

## 7. Turn on the daily post

In `/app/mcsr-vid.config.json`, add `"xAutoPost": true`. It's deliberately not in the Settings
tab, like `nightlyUpload`. Then restart the dashboard when it's idle
(`POST /api/restart-when-idle`, or ask a session to), because both the config file and `.env`
are read at boot.

From then on the dashboard's 15-minute tick posts at most one clip per UTC day, as soon as a
long-form with a hand-cut Short is public. To stop it, set `"xAutoPost": false` and restart when
idle. To skip one match for good, hide it on the dashboard.
