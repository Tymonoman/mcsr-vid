/**
 * The dashboard's YouTube panel: upload form, live stats, comment triage, and the
 * thumbnail A/B table.
 *
 * A sibling of app.js rather than part of it, because that file crossed the 500-line cap.
 * Both are classic scripts sharing one global scope, so this one is loaded first and only
 * declares functions -- app.js's init IIFE is the only thing that runs at parse time.
 */

/* --- YouTube -------------------------------------------------------------------------------- */

let uploadPoll = null;

const mib = (bytes) => `${(bytes / 1024 / 1024).toFixed(0)} MiB`;

/**
 * Upload form for a match that has not been published, or its live stats if it has.
 *
 * The title and description default to whatever the pipeline generated (or your saved edits),
 * so the common case is: glance at it, pick a publish time, press the button.
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
    loadAudit(id);
    return;
  }

  // The generated title still carries the <HOOK> placeholder plus the guidance lines that
  // formatTitle writes for the terminal; neither belongs in a YouTube title, so take the first
  // line and let the hook you picked replace the placeholder.
  const firstLine = (meta.title ?? "").split("\n")[0] ?? "";
  const hook = $("#hook")?.value.trim();
  const suggestedTitle = hook ? firstLine.replace("<HOOK>", hook) : firstLine;

  el.innerHTML = `
    <div class="upload">
      <label>Title <input type="text" id="ytTitle" value="${esc(suggestedTitle)}"></label>
      <label>Description <textarea id="ytDesc" rows="6">${esc(meta.description ?? "")}</textarea></label>
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
      <label>Video file <input type="text" id="ytPath" placeholder="auto-detected from the match folder"></label>
      <div class="row">
        <button id="ytUpload">Upload</button>
        <span class="msg" id="ytMsg"></span>
      </div>
      <div class="bar" id="ytBarWrap" hidden><i id="ytBar"></i></div>
    </div>`;

  $("#ytUpload").addEventListener("click", async () => {
    const when = $("#ytWhen").value;
    $("#ytMsg").textContent = "starting…";
    try {
      await api(`/api/youtube/upload/${id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: $("#ytTitle").value,
          description: $("#ytDesc").value,
          privacyStatus: $("#ytPrivacy").value,
          // datetime-local has no zone; the browser's own offset is what the operator meant.
          publishAt: when ? new Date(when).toISOString() : "",
          videoPath: $("#ytPath").value.trim(),
        }),
      });
      $("#ytBarWrap").hidden = false;
      pollUpload(id, meta);
    } catch (e) {
      $("#ytMsg").textContent = "";
      showFailure("Upload rejected", e.message);
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
  if (p.error) showFailure("Upload failed", p.error);
  loadYoutube(id, meta);
}

function uploadedHtml(u, statsError) {
  const s = u.stats;
  const scheduled = u.publishAt ? `scheduled for ${new Date(u.publishAt).toLocaleString()}` : u.privacyStatus;
  return `
    <div class="published">
      <div class="row">
        <a href="https://www.youtube.com/watch?v=${esc(u.videoId)}" target="_blank" rel="noopener">${esc(u.videoId)}</a>
        <span class="id">${esc(scheduled)}</span>
        ${u.thumbnailVariant ? `<span class="id">thumbnail: ${esc(u.thumbnailVariant)}</span>` : ""}
      </div>
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
    showFailure("Audit could not start", e.message);
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
  if (!threads.length) {
    el.innerHTML = '<div class="empty">no comments yet</div>';
    return;
  }
  el.innerHTML = threads
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
        showFailure("Reply failed", e.message);
      }
    }),
  );
}

/**
 * Which thumbnail variant earns clicks, once there is enough data to say.
 *
 * Channel-wide rather than per-match, so it lives in the left column beside the lists. The
 * server refuses to name a winner from two uploads; this just renders what it says.
 */
async function loadAbTest() {
  const el = $("#abtest");
  let data;
  try {
    data = await api("/api/youtube/abtest");
  } catch (e) {
    el.innerHTML = `<div class="scanline bad">${esc(e.message)}</div>`;
    return;
  }
  const note = data.note ? `<div class="scanline">${esc(data.note)}</div>` : "";
  const err = data.impressionsError ? `<div class="scanline bad">${esc(data.impressionsError)}</div>` : "";
  if (!data.rows.length) {
    el.innerHTML = note + err + '<div class="empty">nothing to compare yet</div>';
    return;
  }
  el.innerHTML = `${note}${err}
    <table class="abtable">
      <thead><tr><th>Variant</th><th>Videos</th><th>Impressions</th><th>CTR</th></tr></thead>
      <tbody>${data.rows
        .map(
          (r) => `<tr class="${r.fellBack ? "warn" : ""}">
            <td>${esc(r.variant)}${r.fellBack ? " *" : ""}</td>
            <td>${r.videos}</td>
            <td>${r.impressions.toLocaleString()}</td>
            <td>${r.ctr === null ? "&mdash;" : (r.ctr * 100).toFixed(2) + "%"}</td>
          </tr>`,
        )
        .join("")}</tbody>
    </table>
    ${data.rows.some((r) => r.fellBack) ? '<div class="scanline">* avatars fell back to the static NMSR render, so this row is not a distinct pose.</div>' : ""}`;
}
