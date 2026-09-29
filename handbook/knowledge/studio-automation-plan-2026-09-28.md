# Studio automation plan: MCSR Replayoffs

## 0. Summary

On-demand, a real Google Chrome runs headed on a virtual screen inside `mcsr-dashboard`, using a login profile saved on disk. The automation connects to the Chrome that is already running (connectOverCDP) and never launches it through Playwright, so Chrome shows none of the automation markers Google checks for. The automation never types into a Google login form. You log in once, by hand, on a Tailscale-only remote screen, and whenever Google asks again. Each Studio action becomes one more step in the Finish on YouTube ledger, the same as playlists and tags today. Each one writes a log line and a screenshot into the match's Details fold. If Google signs the browser out or asks for verification, the step stops, a red line appears on the nightly strip, and nothing retries until you log in again. None of this is a Data API call. The 15 Sept audit neither covers it nor is affected by it, but Google's anti-abuse systems still apply to it.

## 1. What you do first

### 1a. Turn on 2FA (before the first login)

| Method | Use it? | Why |
|---|---|---|
| Google prompt on your phone | **Yes, primary** | Works over the remote screen. You tap Yes on your phone. |
| Authenticator app (TOTP) | **Yes, backup** | Works over the remote screen when the phone prompt doesn't arrive. |
| Backup codes | **Yes, print them** | They are the way back in if you lose your phone. This is the owner account. |
| Passkey on your phone | Not for the container | Signing in with a phone's passkey needs Bluetooth on the machine running the browser. The container has none. |

1. myaccount.google.com → Security → 2-Step Verification → turn it on with the phone prompt.
2. Add an authenticator app and print the backup codes.
3. Check that the channel has **Advanced features** turned on (Studio → Settings → Channel → Feature eligibility). Pinning, related video, end screens and Test & Compare may need it, and turning it on can take 24 h.

### 1b. The one-time login (after phase 1 ships)

1. Dashboard → YouTube panel → **Studio login**. The server starts Chrome, the remote screen, and a one-use password. It shows a link like `http://<tailscale-ip>:6080/vnc.html`.
2. Open the link from your PC or phone on Tailscale.
3. Sign in to the owner account by hand, approve 2FA, and wait until Studio's dashboard loads.
4. Press **Done** in the dashboard. It stops the screen, checks the session, and the strip line goes green. The screen also shuts itself down after 15 minutes.

## 2. The build

Every phase is off by default behind `studioAutomation: false`. Turning it on changes what the chain does, so it is your edit on the box, like `nightlyUpload`.

### Phase 1: browser, login screen, pin the comment

**Adds**

1. `Dockerfile`: `google-chrome-stable` (from Google's apt repo), `x11vnc`, `novnc`, `websockify`, `fonts-liberation`. xvfb is already installed.
2. `compose.yaml`, dashboard service only:
   - a named volume `studio-profile` mounted at `/home/node/.studio-profile`, mode 700;
   - port `"<tailscale-ip>:6080:6080"`, bound to the Tailscale IP and not `0.0.0.0`.
3. `src/youtube/studioBrowser.ts`:
   - Starts Xvfb and Chrome (`--user-data-dir=<profile> --remote-debugging-port=9222`, with neither `--headless` nor `--enable-automation`), then connects with `connectOverCDP`.
   - Stops Chrome with SIGTERM so the cookies are flushed.
   - Allows one browser at a time: an in-process lock, plus Chrome's own `SingletonLock` on the profile.
   - `probe()` reports `ok`, `signed-out`, `verify` (a challenge or CAPTCHA page) or `wrong-channel` (the Studio channel id is not ours).
   - `shot(matchId, label)` saves `studio-<step>-<ts>.png` into the match directory.
4. `src/youtube/studioActions.ts` → `pinComment(videoId)`:
   - Opens the video's comments in Studio and finds the channel's own comment, which the API step already posted.
   - Pins it only if no comment is pinned yet.
   - Takes a screenshot before and after.
   - Waits a random human-like pause (2–6 s) between clicks.
5. `src/dashboard/studioLogin.ts` plus a route in `server.ts`: `POST /api/studio/login` (start the screen), `POST /api/studio/login/done`, `GET /api/studio/status`.

**Changes**

- `src/youtube/youtubeStore.ts`: `FinishedSteps` gains `pin`.
- `src/youtube/youtubeUpload.ts`: after the `comment` step succeeds, `pin` runs in the same `todo()`/`attempt()` shape. `retryPendingComments` also covers `pin`, because a scheduled video only allows comments once it is public.
- `src/shorts/shortPlan.ts`: the step union gains `"studio"`, `ShortLogLine` gains `shot?`, and `NightlyShortSummary` gains `studio: { ok, message? }`.
- `src/shorts/shortLog.ts`: passes `shot` through.
- `server.ts`: `GET /api/matches/:id/studio-shot/:file`, built the same way as the thumbnail route.
- `public/app.js`: a thumbnail image in the Details fold next to a line that has a shot, and one `.bad` child of `#nightly` (the same pattern as the picker line).
- `src/config.ts`: `studioAutomation` (default `false`), then `npm run config:example`.
- `package.json`: `npm run studio -- <probe|pin> <matchId> [--dry-run]`.

**Tests (nothing on the live channel)**

- `npm run test:unit`: the ledger gating is covered by unit tests. `pin` is skipped while the video is private, skipped when a pin already exists, recorded as an error on `verify` or `signed-out`, and never retried in the same run.
- `npm run studio -- probe`: checks the session only.
- `--dry-run`: opens the page, screenshots it, and stops before the final click.
- One real run on **an unlisted test video you name**. It has to be unlisted, because a private video has comments off.

**What you see:** a **Studio login** button, and a Studio line on the strip (red only when something is wrong). In a match's Details fold, lines like "studio · pinned the channel comment", each with a screenshot.

### Phase 2: the Short's related video and end screens

1. `studioActions.ts` gains `linkRelatedVideo(shortId, longId)`:
   - It runs once the long-form is **public or unlisted**. While the long-form is still scheduled it is private, and it would not appear in the related-video picker.
   - The long-form goes public at 19:00 or 23:00 and the Short 18 h later. The nightly tick fills that gap, the same way it posts the first comment today.
2. `studioActions.ts` gains `importEndScreen(videoId)`:
   - It uses Studio's **Import from video**, pointed at one template video that you set up by hand once.
   - Nothing about the layout is hard-coded. It runs right after upload, since it works on a private video too.
   - It is skipped if the video already has an end screen.
3. The ledger gains `related` (on the Short's record) and `endScreen`. `nightly.ts` calls one `retryPendingStudio()` that does every Studio step still pending, in **one browser session** per tick.
4. Test with an unlisted test Short linked to the unlisted test long-form, plus `--dry-run` screenshots of the end-screen editor.
5. You see "linked to the full match" and "end screen imported from <template>" in the Details fold, with screenshots.

### Phase 3: Test & Compare

1. `studioActions.ts` gains `startTestCompare(videoId, variants)`:
   - It runs once the video is **public**. Scheduled videos and Shorts are not eligible.
   - It uses three of the thumbnail strip's variants: your chosen one plus the next two.
   - It never starts if a test is already running, and it never stops or applies a test.
2. The ledger gains `abTest`. The dashboard's A/B tab adds "Test & Compare running since <date>".
3. There is no safe test for this, because it needs a public video. The **first real run waits for you to press Start** on one video. After that it runs on its own.

### Phase 4: later, ranked by value

| # | Feature | How | Runs |
|---|---|---|---|
| 1 | Copyright/Checks status: claims from music on the streamers' VODs | Studio, read-only, in the daily probe | Automatic (it only reads), red line on a new claim |
| 2 | Held-for-review comments | **Data API** (`comments.setModerationStatus`), no browser | Automatic (read) |
| 3 | Community post: the kit already writes one | Studio | **Your press**, per post |
| 4 | YPP application status next to the engaged-views gate | Studio, read-only | Automatic (it only reads) |
| 5 | Captions | **Data API** (`captions.insert`) | Your word first |
| 6 | Channel trailer and Home sections | Studio | Your press, per change |
| 7 | Shorts remix setting | Studio | Your word, once |

Where the Data API can do the job, it is used instead of the browser.

## 3. Session, expiry and the red line

1. **The probe** opens studio.youtube.com and confirms the channel id is ours. It runs at the start of every Studio job and once at each nightly tick. The tick is a short launch that also keeps the session in regular use.

| Probe result | Strip line (`.bad`, also shown on the phone's match screen) | What happens |
|---|---|---|
| `ok` | nothing, or "Studio: signed in" | Pending steps run |
| `signed-out` | "Studio signed out: log in again (YouTube panel → Studio login)" | All Studio steps wait in the ledger |
| `verify` | "Google wants verification: log in by hand, nothing will retry" | Stops at once. **No retry loop.** |
| `wrong-channel` | "Studio is on another channel: nothing was done" | Stops at once |

2. A successful **Done** after you log in clears the line, and the pending steps run on the next tick.
3. Nothing else alerts you: no notification URL and no email, per your answer 9.

## 4. Safety rails

1. **The automation never** types a password, answers 2FA, solves a CAPTCHA, or opens accounts.google.com on its own.
2. **It never** deletes, unpins, or replaces a pin, end screen or test that someone set by hand. It never changes a title or description in Studio (the API does that), never uploads through Studio, never touches monetization or account settings, and never acts on any channel but ours.
3. **Irreversible actions** (deleting a comment or video, stopping a test, changing the trailer) only happen through a per-item press in the dashboard that names the item, per your answer 4.
4. **One browser at a time** (a lock plus `SingletonLock`). One video per action. At most 10 Studio actions per tick, with a 2–6 s random pause between clicks.
5. **If a click fails, the step fails.** Its screenshot is kept, and the step is retried once per tick at most. A `verify` result is never retried.
6. **The profile is a credential.** It lives only in the `studio-profile` volume (700). It is not in `/media`, not in git, and not in a backup that leaves the box.
7. **The remote screen** is bound to the Tailscale IP, uses a one-time password, and shuts itself down after 15 minutes.
8. **CLAUDE.md house rules** gain one line: Studio automation stays inside the audit's own rule (own channel, own data, nothing shown to anyone else), plus the list in rail 2.

## 5. Risks and unknowns

- **The owner account runs in a container:** if Google flags it, the owner is the account locked out. The mitigation is 2FA with printed backup codes, no stored password, human pacing, and a kill switch at myaccount.google.com → Security → Your devices. If you ever have another *existing* Google account, making it an Editor under Channel permissions would keep the owner out of harm's way. That is optional, and your choice stands.
- **On-demand launches:** Google reacts to changes in the environment, not to Chrome restarting. So the profile directory, the lab's IP and the Chrome build stay the same. Chrome's automatic updates happen only when the image is rebuilt, and after a rebuild the first action is a probe.
- **No 2FA yet:** anyone who gets the profile gets the owner account, and Google challenges accounts without 2FA more often. The mitigation is step 1a, done before the first login.
- **Device-bound sessions (DBSC)** are rolling out, and whether they apply on Linux or in a container is unknown. Sessions might expire more often than expected. The red line covers this.
- **Google's Terms of Service** have no written allowance for automating your own Studio. The risk is lowest with this setup: a real Chrome, a home IP, few actions, and a person doing every login.
- **Studio's pages change without notice.** Button labels and selectors will break sometimes. The screenshot on each failure shows what changed, and the fix is one line in `studioActions.ts`.
- **Resources:** Chrome takes about 400 MB of RAM next to an export. Studio jobs wait while `export:fast` is running.

## 6. Decisions I need from you

1. **A test video:** name one unlisted long-form and one unlisted Short on the channel. Or say "upload them", and I send two short unlisted test clips through the API.
2. **The end-screen template:** build the end screen by hand on one video (it has to fit the 15–30 s tail around our subscribe card), then tell me which video it is.
3. **Test & Compare:** thumbnails only, or titles too (using the model's `titleHooks`)? Please also confirm that starting a live test automatically after your first press is what you want.
4. **The Tailscale IP and port** for the login screen: `tailscale ip -4` on actimel. Is 6080 fine?
5. **Switching it on:** after phase 1 passes on the test video, you set `studioAutomation: true` on the box.