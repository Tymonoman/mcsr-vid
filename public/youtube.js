/**
 * The dashboard's YouTube panel: upload form, live stats, comment triage, and the
 * thumbnail A/B table.
 *
 * A sibling of app.js, split by feature. Both are classic scripts sharing one global scope, so this one is loaded first and only
 * declares functions -- app.js's init IIFE is the only thing that runs at parse time.
 */

/* --- YouTube -------------------------------------------------------------------------------- */

let uploadPoll = null;

const mib = (bytes) => `${(bytes / 1024 / 1024).toFixed(0)} MiB`;

/**
 * Upload form for a match that has not been published, or its live stats if it has.
 *
 * No title or description here: the upload reads the match's own files server-side — the same
 * `.edited.txt` the title editor writes and the publish kit pastes from — so there is one copy
 * of the text. The form is visibility, the publish time and the button, and while uploads are
 * off (`youtubeUploadEnabled`) it is only the "check the channel" line.
 */
async function loadYoutube(id, meta) {
  const el = $("#youtube");
  if (!el) return;

  let status;
  try {
    status = await api("/api/youtube/status");
  } catch (e) {
    el.innerHTML = `<div class="scanline bad">${esc(e.message)}</div>`;
    return;
  }
  if (!status.connected) {
    el.innerHTML =
      '<div class="scanline">Not connected. Run <code>npm run youtube-auth</code> on a machine with a browser, then copy <code>youtube-token.json</code> into the repo root.</div>';
    return;
  }

  const all = await api("/api/youtube/uploads").catch(() => ({ uploads: [], statsError: null }));
  const mine = all.uploads.find((u) => u.matchId === id);

  if (mine) {
    el.innerHTML = uploadedHtml(mine, all.statsError);
    $("#loadcomments")?.addEventListener("click", () => loadComments(id));
    $("#runaudit")?.addEventListener("click", () => requestAudit(id));
    $("#ytFinish")?.addEventListener("click", (ev) => finishOnYouTube(id, meta, ev.currentTarget));
    loadAudit(id);
    return;
  }

  // Back from Studio: list the channel now, then repaint everything that says "published".
  const checkChannel = async (link) => {
    link.textContent = "checking…";
    try {
      const all = await api("/api/youtube/uploads?fresh=1");
      if (!all.uploads.some((u) => u.matchId === id)) {
        link.textContent = "not on the channel yet — check again";
        return;
      }
    } catch (e) {
      link.textContent = `could not check: ${e.message}`;
      return;
    }
    await refresh();
    loadYoutube(id, meta);
    loadPublishKit(id, meta);
    loadChecklist(id);
  };

  el.innerHTML = `
    <div class="scanline">Uploaded it in Studio already? <a href="#" data-act="checkchannel">check the channel</a> <span class="muted">(otherwise it is noticed within six hours)</span></div>
    <div class="scanline">
      Or drop the file into Studio and leave every box empty &mdash; paste its id here and the
      title, description, tags, thumbnail, playlists and first comment all go on from here.
      <div class="row">
        <input id="ytAdoptId" type="text" placeholder="video id from the Studio URL" maxlength="11" size="14" spellcheck="false">
        <button id="ytAdopt" class="ghost">Adopt this draft</button>
        <span class="msg" id="ytAdoptMsg"></span>
      </div>
    </div>
    ${
      status.uploadsEnabled
        ? `<div class="upload">
      <div class="scanline muted">Sends the title, description and tags from the match's files &mdash; edit them in the title editor above.</div>
      <div class="row">
        <label>Visibility
          <select id="ytPrivacy">
            <option value="private">private</option>
            <option value="unlisted">unlisted</option>
            <option value="public">public</option>
          </select>
        </label>
        <label>Publish at <input type="datetime-local" id="ytWhen"></label>
      </div>
      <div class="row">
        <button id="ytUpload">Upload</button>
        <span class="msg" id="ytMsg"></span>
      </div>
      <div class="bar" id="ytBarWrap" hidden><i id="ytBar"></i></div>
    </div>`
        : ""
    }`;
  $('#youtube [data-act="checkchannel"]')?.addEventListener("click", (ev) => {
    ev.preventDefault();
    void checkChannel(ev.currentTarget);
  });
  // Adopting is videos.update, not videos.insert, so it works with uploads still switched off —
  // it is the whole point of the control, and it must not sit behind the audit's flag.
  $("#ytAdopt")?.addEventListener("click", async () => {
    const videoId = $("#ytAdoptId").value.trim();
    const msg = $("#ytAdoptMsg");
    clearFailAt("#ytAdoptId");
    msg.textContent = "writing…";
    try {
      const r = await api(`/api/youtube/adopt/${id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ videoId }),
      });
      const failed = Object.entries(r.finished ?? {}).filter(([, err]) => err);
      await refresh();
      // After the repaint, or the panel this message hangs under is replaced from under it.
      await loadYoutube(id, meta);
      loadPublishKit(id, meta);
      loadChecklist(id);
      if (failed.length)
        failAt("#ytFinish", "Adopted, with a problem", failed.map(([k, v]) => `${k}: ${v}`).join("\n"));
    } catch (e) {
      msg.textContent = "";
      failAt("#ytAdoptId", "Could not adopt that video", e.message);
    }
  });

  if (!status.uploadsEnabled) return;

  // The kit may have fetched the slot before this form existed (app.js prefillPublishAt).
  if (typeof prefillPublishAt === "function") prefillPublishAt();
  // And the sync check may have found the export stale before this button existed (app.js
  // guardUpload): the same refusal the server gives, under the button, before the press.
  guardUpload();

  // No client-side hook gate. The server resolves `<HOOK>` from the edited title and, failing
  // that, the thumbnail manifest's headline — a rule this file cannot see, and every copy of it
  // here disagreed in both directions (a typed-but-unsaved hook enabled a button that 400s; a
  // manifest headline with an empty input disabled one that would have worked). The refusal is
  // free — it happens before a byte is sent — and lands under the button with the reason.
  $("#ytUpload").addEventListener("click", async () => {
    const when = $("#ytWhen").value;
    clearFailAt("#ytUpload");
    $("#ytMsg").textContent = "starting…";
    try {
      await api(`/api/youtube/upload/${id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "video",
          privacyStatus: $("#ytPrivacy").value,
          // datetime-local has no zone; the browser's own offset is what the operator meant.
          publishAt: when ? new Date(when).toISOString() : "",
        }),
      });
      $("#ytBarWrap").hidden = false;
      pollUpload(id, meta);
    } catch (e) {
      $("#ytMsg").textContent = "";
      failAt("#ytUpload", "Upload rejected", e.message);
    }
  });
}

async function pollUpload(id, meta) {
  clearTimeout(uploadPoll);
  const p = await api(`/api/youtube/upload/${id}`);
  const bar = $("#ytBar");
  if (bar && p.total) bar.style.width = `${Math.round((p.uploaded / p.total) * 100)}%`;
  const msg = $("#ytMsg");
  if (msg) {
    msg.textContent = p.total ? `${mib(p.uploaded)} / ${mib(p.total)}` : "preparing…";
  }
  if (!p.done) {
    uploadPoll = setTimeout(() => pollUpload(id, meta), 2000);
    return;
  }
  // The video is up when there is an id; a rejected thumbnail or playlist after that is a
  // problem to fix in Studio, not a failed upload to retry.
  await loadYoutube(id, meta);
  // The Short followed the long-form by itself (src/youtube/youtubeUpload.ts `shortAfterUpload`) and
  // says so in one line of the warnings: scheduled when, or why it was skipped. Its own line,
  // because "short uploaded" is not a problem and must not be reported as one.
  const shortLine = (p.warnings ?? []).find((w) => w.startsWith("short "));
  const problems = (p.warnings ?? []).filter((w) => w !== shortLine);
  if (shortLine)
    $("#youtube .published")?.insertAdjacentHTML(
      "afterbegin",
      `<div class="scanline${/skipped|failed/.test(shortLine) ? " bad" : ""}">${esc(shortLine)}</div>`,
    );
  // After the repaint: the panel has just become the published view, and #ytFinish is the row
  // these problems are about -- a thumbnail or a playlist that did not take.
  if (p.error) failAt("#ytFinish", "Upload failed", p.error);
  else if (problems.length) failAt("#ytFinish", "Uploaded, with a problem", problems.join("\n"));
}

/**
 * The four steps a Studio upload still needs — the chosen thumbnail, its playlists, the first
 * comment and its tags — done by the API. None of them is `videos.insert`, so none is gated by
 * the compliance audit. Safe to press twice: the server skips any step its record already
 * marks done (src/youtube/youtubeUpload.ts), because a second comment and a second playlist join are
 * writes to the live channel that only Studio can undo.
 */
async function finishOnYouTube(id, meta, btn) {
  clearFailAt("#ytFinish");
  btn.disabled = true;
  btn.textContent = "finishing…";
  try {
    const r = await api(`/api/youtube/finish/${id}`, { method: "POST" });
    const failed = Object.entries(r.finished).filter(([, err]) => err);
    await loadYoutube(id, meta);
    if (failed.length)
      failAt("#ytFinish", "Finished, with a problem", failed.map(([s, e]) => `${s}: ${e}`).join("\n"));
    return;
  } catch (e) {
    await loadYoutube(id, meta);
    failAt("#ytFinish", "Finish failed", e.message);
  }
}

function uploadedHtml(u, statsError) {
  const s = u.stats;
  const scheduled = u.publishAt ? `scheduled for ${new Date(u.publishAt).toLocaleString()}` : u.privacyStatus;
  // What "Finish on YouTube" has done, per step; nothing yet reads as all four still to do.
  const f = u.finished ?? {};
  const stepLabel = (step) => (f[step] === null ? `${step} ✓` : f[step] ? `${step} ✗` : step);
  const finishLine = `<span class="id" title="${esc(
    Object.values(f).filter(Boolean).join("\n"),
  )}">${["thumbnail", "playlists", "comment", "tags"].map(stepLabel).join(" · ")}</span>`;
  return `
    <div class="published">
      <div class="row">
        <a href="https://www.youtube.com/watch?v=${esc(u.videoId)}" target="_blank" rel="noopener">${esc(u.videoId)}</a>
        <span class="id">${esc(scheduled)}</span>
        ${
          // A Studio upload was recognised by the match link in its description, so there is no
          // youtube.json and no record of which thumbnail variant went out with it.
          u.source === "channel" || u.source === "studio"
            ? '<span class="id">found on the channel &mdash; uploaded from Studio</span>'
            : u.thumbnailVariant
              ? `<span class="id">thumbnail: ${esc(u.thumbnailVariant)}</span>`
              : ""
        }
      </div>
      <div class="row">
        <button id="ytFinish" class="ghost">Finish on YouTube: thumbnail &middot; playlists &middot; first comment &middot; tags</button>
        ${finishLine}
      </div>
      ${
        // Both of these are facts about a video already on the channel, and both are what the
        // button above exists to repair — so they belong here, next to it. They were written
        // against `u` and sat in the pre-upload form, where `u` does not exist: dead until
        // `uploadsEnabled` went true, and a ReferenceError the moment it did.
        u.inSeasonPlaylist === false
          ? '<div class="scanline bad">not in the season playlist &mdash; which its own description links to</div>'
          : ""
      }
      ${
        // The pipeline writes eleven tags per match — both nicknames and the seed among them —
        // and a Studio upload only carries what was typed into the box.
        u.missingTags && u.missingTags.length
          ? `<div class="scanline bad">this upload is missing ${u.missingTags.length} of its tags &mdash; ${esc(u.missingTags.slice(0, 3).join(", "))}${u.missingTags.length > 3 ? "&hellip;" : ""} &middot; Finish on YouTube adds them</div>`
          : ""
      }
      ${
        s
          ? `<div class="stats">
               <span><b>${s.views.toLocaleString()}</b> views</span>
               <span><b>${s.likes.toLocaleString()}</b> likes</span>
               <span><b>${s.comments.toLocaleString()}</b> comments</span>
             </div>`
          : `<div class="scanline bad">${esc(statsError ?? "no stats")}</div>`
      }
      <div class="row">
        <button id="loadcomments" class="ghost">Unanswered comments</button>
        <button id="runaudit" class="ghost">Audit this upload</button>
        <span class="id">audit runs /watch in a Claude session &mdash; minutes and tokens, on demand only</span>
      </div>
      <div id="comments"></div>
      <div id="audit"></div>
    </div>`;
}

/* --- Audit ---------------------------------------------------------------------------------- */

let auditPoll = null;

/**
 * Runs the /watch review, or shows the last one.
 *
 * Confirmed before starting because it spends real money and takes minutes; nothing here is
 * scheduled or automatic, which is the whole point of the feature being "on demand".
 */
async function requestAudit(id) {
  if (!confirm("Run a /watch audit? This spawns a Claude session and can take several minutes.")) return;
  const el = $("#audit");
  el.innerHTML = '<div class="scanline">starting&hellip;</div>';
  try {
    await api(`/api/youtube/audit/${id}`, { method: "POST" });
  } catch (e) {
    el.innerHTML = "";
    failAt("#runaudit", "Audit could not start", e.message);
    return;
  }
  pollAudit(id);
}

async function pollAudit(id) {
  clearTimeout(auditPoll);
  const state = await api(`/api/youtube/audit/${id}`);
  const el = $("#audit");
  if (!el) return;

  // The command's own output is shown while it runs: a /watch run prints its progress, and a
  // silent ten-minute wait is indistinguishable from a hang.
  const body = state.report ?? state.output;
  el.innerHTML = `
    <div class="scanline">${state.running ? "auditing&hellip; this takes a few minutes" : state.error ? "failed" : "done"}</div>
    ${state.error ? `<div class="scanline bad">${esc(state.error)}</div>` : ""}
    ${body ? `<pre class="auditout">${esc(body)}</pre>` : ""}`;

  if (state.running) auditPoll = setTimeout(() => pollAudit(id), 3000);
}

/** Shows an existing report on load, without starting anything. */
async function loadAudit(id) {
  const state = await api(`/api/youtube/audit/${id}`).catch(() => null);
  if (state && (state.running || state.report)) pollAudit(id);
}

async function loadComments(id) {
  const el = $("#comments");
  el.innerHTML = '<div class="empty">loading…</div>';
  let data;
  try {
    data = await api(`/api/youtube/comments/${id}`);
  } catch (e) {
    el.innerHTML = `<div class="scanline bad">${esc(e.message)}</div>`;
    return;
  }
  // Unanswered first: that is the list you are actually here to clear.
  const threads = data.threads.slice().sort((a, b) => Number(b.unanswered) - Number(a.unanswered));
  // The kit writes a pinned comment for every video and there is no artifact that would show it
  // was posted — so the only honest check is whether the channel has said anything under its own
  // video at all. None of them ever had one.
  const pinned = threads.some((t) => t.byChannel)
    ? ""
    : '<div class="scanline bad">no comment from the channel on this video &mdash; the kit has one written under "Pinned comment"</div>';
  if (!threads.length) {
    el.innerHTML = pinned + '<div class="empty">no comments yet</div>';
    return;
  }
  el.innerHTML =
    pinned +
    threads
      .map(
        (t) => `
      <div class="comment ${t.unanswered ? "unanswered" : ""}" data-thread="${esc(t.threadId)}">
        <div class="who">${esc(t.author)} ${t.unanswered ? '<span class="badge">unanswered</span>' : ""}</div>
        <div class="body">${esc(t.text)}</div>
        ${t.unanswered ? '<div class="row"><input type="text" class="replytext" placeholder="Reply…"><button class="reply">Send</button></div>' : ""}
      </div>`,
      )
      .join("");

  el.querySelectorAll(".comment .reply").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const box = btn.closest(".comment");
      const text = box.querySelector(".replytext").value.trim();
      if (!text) return;
      try {
        await api("/api/youtube/reply", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ threadId: box.dataset.thread, text }),
        });
        loadComments(id);
      } catch (e) {
        failAt(btn, "Reply failed", e.message);
      }
    }),
  );
}

/** The three numeric cells both A/B tables share; CTR is a rate, so a missing one is not zero. */
const reachCells = (r) =>
  `<td>${r.videos}</td><td>${r.impressions.toLocaleString()}</td>` +
  `<td>${r.ctr === null ? "&mdash;" : (r.ctr * 100).toFixed(2) + "%"}</td>`;

const HOOK_LABEL = { true: "Hook text", false: "No text", null: "Unknown" };

/**
 * Which thumbnail earns clicks, once there is enough data to say.
 *
 * Two tables: text vs no text first, because that is the question the hook change was made to
 * answer, and pose second, which barely moves CTR. Channel-wide rather than per-match, so it
 * lives in the left column beside the lists. The server refuses to name a winner from two
 * uploads; this just renders what it says.
 */
/** The three Partner Programme gates: where the channel is, the rate, and the date at that rate. */
function yppInner(ypp) {
  if (!ypp) return '<div class="ypp"><div class="empty">channel numbers&hellip;</div></div>';
  if (!ypp.progress) {
    return `<div class="ypp"><div class="empty">${esc(ypp.error ?? "channel numbers…")}</div></div>`;
  }
  const p = ypp.progress;
  const fmt = (n) =>
    n >= 1e6
      ? `${(n / 1e6).toFixed(1)}M`
      : n >= 1e4
        ? `${(n / 1e3).toFixed(0)}k`
        : Math.round(n).toLocaleString();
  // A rolling-window gate with a ceiling under it never lands at this rate; say what rate would.
  const when = (g) =>
    g.have >= g.need
      ? '<span class="ok">reached</span>'
      : g.eta
        ? `at this rate ${esc(new Date(g.eta).toLocaleDateString([], { month: "short", year: "numeric" }))}`
        : g.ceiling !== undefined && g.ratePerDay > 0
          ? `<span class="bad">levels off near ${fmt(g.ceiling)}</span> &middot; needs ${fmt(g.needPerDay)} / day`
          : '<span class="muted">no rate yet</span>';
  const gate = (label, g, unit, rateLabel) => `
    <div class="gate">
      <div class="gatehead"><b>${esc(label)}</b><span>${fmt(g.have)} / ${fmt(g.need)}${unit}</span></div>
      <div class="bar"><i style="width:${Math.min(100, (100 * g.have) / g.need).toFixed(1)}%"></i></div>
      <div class="gatefoot"><span>${esc(rateLabel(g.ratePerDay))}</span><span>${when(g)}</span></div>
    </div>`;
  return `<div class="ypp">
    <div class="ypphead">Partner programme &middot; 500 subscribers and either 4,000 watch hours or 10M Shorts views</div>
    ${gate("Subscribers", p.subscribers, "", (r) => `+${(r * 7).toFixed(0)} / week`)}
    ${gate("Watch hours, last 365 days", p.watchHours, " h", (r) => `+${(r * 28).toFixed(0)} h / 28 days`)}
    ${gate("Shorts views, last 90 days", p.shortsViews, "", (r) => (r > 0 ? `+${fmt(r * 28)} / 28 days` : "no Shorts published yet"))}
    <div class="muted small">numbers as of ${esc(new Date(p.fetchedAt).toLocaleString())}; refreshed every six hours</div>
  </div>`;
}

async function loadYpp(el) {
  let ypp = null;
  try {
    ypp = await api("/api/youtube/ypp");
  } catch (e) {
    ypp = { progress: null, error: e.message, stale: false };
  }
  const slot = el.querySelector("#yppslot");
  if (slot) slot.innerHTML = yppInner(ypp);
  // The first answer after boot is "fetching"; the numbers are a few seconds behind it.
  if (ypp && !ypp.progress && ypp.stale) setTimeout(() => loadYpp(el), 3000);
}

async function loadAbTest() {
  const el = $("#abtest");
  let data;
  try {
    data = await api("/api/youtube/abtest");
  } catch (e) {
    el.innerHTML = `<div id="yppslot"></div><div class="scanline bad">${esc(e.message)}</div>`;
    void loadYpp(el);
    return;
  }
  const note = data.note ? `<div class="scanline">${esc(data.note)}</div>` : "";
  const err = data.impressionsError ? `<div class="scanline bad">${esc(data.impressionsError)}</div>` : "";
  if (!data.rows.length) {
    el.innerHTML =
      '<div id="yppslot"></div>' + note + err + '<div class="empty">nothing to compare yet</div>';
    void loadYpp(el);
    return;
  }
  const byHook = data.byHook ?? [];
  const hookTable = !byHook.length
    ? ""
    : `<table class="abtable">
      <thead><tr><th>Thumbnail text</th><th>Videos</th><th>Impressions</th><th>CTR</th></tr></thead>
      <tbody>${byHook
        .map((r) => `<tr><td>${HOOK_LABEL[String(r.hook)]}</td>${reachCells(r)}</tr>`)
        .join("")}</tbody>
    </table>`;
  el.innerHTML = `<div id="yppslot"></div>${note}${err}${hookTable}
    <table class="abtable">
      <thead><tr><th>Variant</th><th>Videos</th><th>Impressions</th><th>CTR</th></tr></thead>
      <tbody>${data.rows
        .map(
          (r) => `<tr class="${r.fellBack ? "warn" : ""}">
            <td>${esc(r.variant)}${r.fellBack ? " *" : ""}</td>
            ${reachCells(r)}
          </tr>`,
        )
        .join("")}</tbody>
    </table>
    ${data.rows.some((r) => r.fellBack) ? '<div class="scanline">* avatars fell back to the static NMSR render, so this row is not a distinct pose.</div>' : ""}`;
  void loadYpp(el);
}
