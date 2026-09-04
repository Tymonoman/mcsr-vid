const $ = (s, r = document) => r.querySelector(s);
let STAGES = { order: [], labels: {} };
let matches = [];
let selected = null;
let stream = null;

/** Per-stage timing for the run being watched, keyed by stage id. Rebuilt on every select. */
let stageState = {};
let elapsedTimer = null;

const esc = (s) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.json();
}

/** mm:ss, or h:mm:ss once a render runs past the hour — overlay renders routinely do. */
function formatDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function renderList() {
  const el = $("#list");
  if (!matches.length) {
    el.innerHTML = '<div class="empty">No matches in mediaDir yet.</div>';
    return;
  }
  // Named once here rather than as a title= on every pip: a tooltip is unreachable on a phone,
  // which is exactly where this dashboard gets used.
  const legend = `<div class="legend">${STAGES.order
    .map((s) => `<span>${esc(STAGES.labels[s])}</span>`)
    .join("")}</div>`;

  el.innerHTML =
    legend +
    matches
      .map(
        (m) => `
    <div class="card" data-id="${m.matchId}" aria-selected="${selected === m.matchId}">
      <img src="/api/thumbnail/${m.matchId}" alt="" loading="lazy"
           onerror="this.style.visibility='hidden'">
      <div>
        <div class="who">${esc(m.leftNickname)} vs ${esc(m.rightNickname)}</div>
        <div class="id">#${m.matchId}</div>
        ${m.error ? `<div class="degraded" title="${esc(m.error)}">names from filenames &mdash; API lookup failed</div>` : ""}
        <div class="stages">${STAGES.order
          .map(
            (s) =>
              `<span class="pip ${m.stages[s] ? "done" : ""}" role="img"
                     aria-label="${esc(STAGES.labels[s])}: ${m.stages[s] ? "done" : "not done"}"
                     title="${esc(STAGES.labels[s])}"></span>`,
          )
          .join("")}</div>
      </div>
    </div>`,
      )
      .join("");

  el.querySelectorAll(".card").forEach((c) =>
    c.addEventListener("click", () => select(Number(c.dataset.id))),
  );
}

function hookCounter(meta) {
  const input = $("#hook"),
    out = $("#hookcount");
  if (!input || !meta.hook) return;
  const n = input.value.length;
  const { min, max } = meta.hook;
  out.textContent = `${n} / ${min}-${max} chars`;
  out.className = "counter" + (n > max ? " over" : n >= min ? " good" : "");
  $("#hookpreview").textContent = input.value ? `${input.value} | ${meta.hook.generated}` : meta.hook.placeholder;
}

async function select(id) {
  selected = id;
  renderList();
  const meta = await api(`/api/meta/${id}`);
  const m = matches.find((x) => x.matchId === id);
  const rendered = m && m.stages.render;

  $("#detail").innerHTML = `
    <div class="row">
      <button id="run">${rendered ? "Re-run pipeline" : "Run pipeline"}</button>
      <button id="stop" class="ghost">Stop</button>
      <span class="id">#${id} &mdash; ${esc(meta.leftNickname)} vs ${esc(meta.rightNickname)}</span>
    </div>

    <div id="progress">
      ${STAGES.order
        .map(
          (s) => `
        <div class="stagerow" data-stage="${s}">
          <span class="label">${esc(STAGES.labels[s])}</span>
          <span class="bar"><i></i></span>
          <span class="pct"></span>
          <span class="elapsed"></span>
        </div>`,
        )
        .join("")}
      <div class="msg" id="msg"></div>
    </div>

    <div id="failure">
      <div class="title" id="failtitle"></div>
      <pre id="failtext"></pre>
      <div class="actions"><button id="failcopy" class="ghost">Copy error</button></div>
    </div>

    ${
      meta.hook
        ? `
      <h2>Hook <span class="counter" id="hookcount"></span></h2>
      <input type="text" id="hook" placeholder="${esc(meta.hook.suggestions[0] ?? "The one part worth writing by hand")}">
      ${
        meta.hook.suggestions.length
          ? `<div class="chips">${meta.hook.suggestions
              .map((s) => `<button type="button" class="chip">${esc(s)}</button>`)
              .join("")}</div>`
          : ""
      }
      <pre id="hookpreview" style="margin-top:8px"></pre>`
        : ""
    }

    <h2>Title ${meta.titleEdited ? '<span class="saved">(edited)</span>' : ""}</h2>
    <textarea id="title" rows="4">${esc(meta.title ?? "")}</textarea>

    <h2>Description ${meta.descriptionEdited ? '<span class="saved">(edited)</span>' : ""}</h2>
    <textarea id="description" rows="14">${esc(meta.description ?? "")}</textarea>

    <div class="row" style="margin-top:12px">
      <button id="save">Save edits</button><span class="saved" id="savedmsg"></span>
    </div>

    <h2>Thumbnail</h2>
    <div id="variants"><div class="empty">loading&hellip;</div></div>

    <h2>Chapters</h2>
    <pre>${esc(meta.chapters ?? "not generated yet")}</pre>

    <h2>YouTube</h2>
    <div id="youtube"><div class="empty">loading&hellip;</div></div>

    <h2>Outputs</h2>
    ${outputsHtml(meta.outputs)}`;

  if (meta.hook) {
    $("#hook").addEventListener("input", () => hookCounter(meta));
    // A chip fills the field rather than committing anything: the suggestion is a starting
    // point to edit, which is the whole reason the hook is hand-written in the first place.
    $("#detail")
      .querySelectorAll(".chip")
      .forEach((chip) =>
        chip.addEventListener("click", () => {
          $("#hook").value = chip.textContent;
          hookCounter(meta);
          $("#hook").focus();
        }),
      );
    hookCounter(meta);
  }

  $("#run").addEventListener("click", async () => {
    await api(`/api/render/${id}`, { method: "POST" });
    watch(id);
  });
  $("#stop").addEventListener("click", () => api(`/api/render/${id}`, { method: "DELETE" }));
  $("#failcopy").addEventListener("click", () => navigator.clipboard?.writeText($("#failtext").textContent));
  $("#save").addEventListener("click", async () => {
    await api(`/api/meta/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: $("#title").value, description: $("#description").value }),
    });
    $("#savedmsg").textContent = "saved";
    setTimeout(() => ($("#savedmsg").textContent = ""), 2000);
  });

  loadVariants(id);
  loadYoutube(id, meta);
  watch(id, true);
}

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
      <div class="row"><button id="loadcomments" class="ghost">Unanswered comments</button></div>
      <div id="comments"></div>
    </div>`;
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
 * The rendered pose variants, one per configured pair. Picking one copies it over
 * thumbnail.png, which is the file that gets uploaded.
 *
 * A variant whose avatars came from NMSR is labelled as a fallback rather than shown as a
 * distinct pose: NMSR has no pose support, so during a Starlight Skins outage every variant is
 * the same image, and calling them three poses would make the eventual CTR comparison a lie.
 */
async function loadVariants(id) {
  const el = $("#variants");
  if (!el) return;
  let data;
  try {
    data = await api(`/api/thumbnails/${id}`);
  } catch (e) {
    el.innerHTML = `<div class="scanline bad">${esc(e.message)}</div>`;
    return;
  }
  if (!data.variants.length) {
    el.innerHTML = '<div class="empty">no variants rendered yet</div>';
    return;
  }

  el.innerHTML = `<div class="strip">${data.variants
    .map((v) => {
      const fellBack = v.leftProvider !== "starlight" || v.rightProvider !== "starlight";
      return `
      <figure class="variant ${v.key === data.chosen ? "chosen" : ""}" data-key="${esc(v.key)}">
        <img src="/api/thumbnail/${id}?v=${encodeURIComponent(v.key)}" alt="${esc(v.key)}" loading="lazy">
        <figcaption>
          <span class="key">${esc(v.leftPose)} / ${esc(v.rightPose)}</span>
          ${fellBack ? '<span class="fallback" title="Starlight Skins was unavailable, so this is the static NMSR render -- not the pose it is named after">static fallback</span>' : ""}
          ${v.key === data.chosen ? '<span class="is-chosen">in use</span>' : '<button type="button" class="use">Use this</button>'}
        </figcaption>
      </figure>`;
    })
    .join("")}</div>`;

  el.querySelectorAll(".variant .use").forEach((btn) =>
    btn.addEventListener("click", async () => {
      await api(`/api/thumbnails/${id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chosen: btn.closest(".variant").dataset.key }),
      });
      await loadVariants(id);
      await refresh();
    }),
  );
}

/**
 * Where the run put things. The TUI's success summary lists all of these; the dashboard listed
 * none, so the one file you actually open by hand — the Kdenlive project — had no visible path.
 * These are container-side paths, hence text rather than links.
 */
const OUTPUT_LABELS = {
  project: "Kdenlive",
  overlay: "Overlay",
  thumbnail: "Thumbnail",
  title: "Title",
  description: "Description",
  chapters: "Chapters",
  syncPreview: "Sync preview",
};

function outputsHtml(outputs) {
  if (!outputs) return '<div class="empty">nothing written yet</div>';
  return `<div class="outputs">${Object.entries(OUTPUT_LABELS)
    .map(
      ([key, label]) =>
        `<div><span class="k">${label}</span><span class="v${outputs[key] ? "" : " missing"}">${
          outputs[key] ? esc(outputs[key]) : "&mdash;"
        }</span></div>`,
    )
    .join("")}</div>`;
}

function showFailure(title, text) {
  const box = $("#failure");
  if (!box) return;
  $("#failtitle").textContent = title;
  $("#failtext").textContent = text;
  box.classList.add("live");
}

/**
 * Repaints the elapsed column. Stages that finished show the duration the server measured;
 * the one still running counts up from its own start, which is the only way to tell a slow
 * render from a wedged one without watching the container's logs.
 */
function paintElapsed() {
  for (const [stage, st] of Object.entries(stageState)) {
    const cell = document.querySelector(`.stagerow[data-stage="${stage}"] .elapsed`);
    if (!cell) continue;
    if (st.durationMs !== undefined) cell.textContent = formatDuration(st.durationMs);
    else if (st.running && st.startedAtMs !== undefined)
      cell.textContent = formatDuration(Date.now() - st.startedAtMs);
    else if (st.settled) cell.textContent = "cached";
  }
}

function watch(id, quiet) {
  if (stream) {
    stream.close();
    stream = null;
  }
  clearInterval(elapsedTimer);
  stageState = {};
  const box = $("#progress");
  if (!box) return;

  const src = new EventSource(`/api/progress/${id}`);
  stream = src;
  elapsedTimer = setInterval(paintElapsed, 1000);

  src.onmessage = (e) => {
    box.classList.add("live");
    const ev = JSON.parse(e.data);
    const row = box.querySelector(`[data-stage="${ev.stage}"]`);
    if (!row) return;

    const st = (stageState[ev.stage] ??= {});
    if (ev.startedAtMs !== undefined) st.startedAtMs = ev.startedAtMs;
    if (ev.durationMs !== undefined) st.durationMs = ev.durationMs;
    st.running = ev.status === "active";
    st.settled = ev.status !== "active";

    row.classList.toggle("active", ev.status === "active");
    row.classList.toggle("warn", ev.status === "warn");
    row.classList.toggle("error", ev.status === "error");

    const pct = ev.status === "done" ? 100 : (ev.percent ?? 0);
    row.querySelector("i").style.width = pct + "%";
    row.querySelector(".pct").textContent = pct ? pct + "%" : "";
    if (ev.message) $("#msg").textContent = `${ev.stage}: ${ev.message}`;
    // The pipeline now names the failing stage, so the full text can go somewhere it is
    // readable rather than being truncated into the status line.
    if (ev.status === "error" && ev.message) showFailure(`${STAGES.labels[ev.stage]} failed`, ev.message);
    paintElapsed();
  };

  src.addEventListener("end", (e) => {
    const { error, stage, aborted } = JSON.parse(e.data);
    $("#msg").textContent = aborted ? "stopped" : error ? "failed" : "done";
    if (error) showFailure(stage ? `${STAGES.labels[stage]} failed` : "Pipeline failed", error);
    src.close();
    stream = null;
    clearInterval(elapsedTimer);
    paintElapsed();
    refresh();
  });

  // A 404 just means nothing is running for this match, which is the normal case.
  src.onerror = () => {
    src.close();
    if (stream === src) stream = null;
    clearInterval(elapsedTimer);
    if (quiet) box.classList.remove("live");
  };
}

async function refresh() {
  matches = (await api("/api/matches")).matches;
  renderList();
}

/* --- Suggestions ------------------------------------------------------------------------- */

let suggestPoll = null;

const clock = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;

function renderSuggestions(data) {
  const el = $("#suggestions");
  $("#tab-suggestions").textContent = `Suggestions${data.suggestions.length ? ` (${data.suggestions.length})` : ""}`;

  // A failed scan keeps whatever list it had: a stale suggestion is still a renderable match.
  const scan = data.scanning
    ? `<div class="scanline">scanning&hellip; ${data.scanned} matches, ${data.candidates} with two VODs</div>`
    : data.error
      ? `<div class="scanline bad">scan failed: ${esc(data.error)}</div>`
      : data.note
        ? `<div class="scanline">${esc(data.note)}</div>`
        : "";

  if (!data.suggestions.length) {
    el.innerHTML = scan + `<div class="empty">${data.scanning ? "" : "Nothing suggested yet."}</div>`;
    return;
  }

  el.innerHTML =
    scan +
    data.suggestions
      .map((s) => {
        // DNF: the loser usually stops once the winner is done, so there is no gap to report.
        const margin =
          s.finishMarginMs === null
            ? "DNF"
            : `${(s.finishMarginMs / 1000).toFixed(1)}s${s.finishEstimated ? "*" : ""}`;
        return `
      <div class="sugg" data-id="${s.matchId}">
        <div class="top">
          <span class="bucket ${s.bucket}">${s.bucket.toUpperCase()}</span>
          <span class="who">${esc(s.players[0])} vs ${esc(s.players[1])}</span>
        </div>
        <div class="facts">
          ${clock(s.resultMs)} &middot; &Delta;${margin} &middot; ${s.leadChanges} lead changes
          &middot; &#9760;${s.deaths} &middot; score ${s.score.toFixed(2)}
        </div>
        <div class="links">
          <a href="${esc(s.matchUrl)}" target="_blank" rel="noopener">mcsrranked #${s.matchId}</a>
          ${s.vodUrls.map((u, i) => `<a href="${esc(u)}" target="_blank" rel="noopener">VOD ${i + 1}</a>`).join("")}
        </div>
        <div class="acts">
          <button data-act="render">Render this</button>
          <button data-act="dismiss" class="ghost">Dismiss</button>
        </div>
      </div>`;
      })
      .join("");

  el.querySelectorAll(".sugg").forEach((row) => {
    const id = Number(row.dataset.id);
    row.querySelector('[data-act="render"]').addEventListener("click", () => startRender(String(id)));
    row.querySelector('[data-act="dismiss"]').addEventListener("click", async () => {
      renderSuggestions(await api(`/api/suggestions/${id}`, { method: "DELETE" }));
    });
  });
}

async function pollSuggestions() {
  const data = await api("/api/suggestions");
  renderSuggestions(data);
  clearTimeout(suggestPoll);
  // Only while a scan is in flight — the result is cached for suggestCacheTtlMin afterwards,
  // so polling a settled list would just burn requests.
  if (data.scanning) suggestPoll = setTimeout(pollSuggestions, 2000);
}

/* --- Starting a match by id ---------------------------------------------------------------- */

async function startRender(input) {
  const err = $("#entryerr");
  err.textContent = "";
  try {
    const { matchId } = await api("/api/render", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input }),
    });
    // The match may have no working directory yet, so it is not in `matches` — refresh first so
    // select() can find it, then fall back to watching the id directly.
    await refresh();
    await select(matchId);
    watch(matchId);
  } catch (e) {
    err.textContent = e.message;
  }
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

const PANELS = { suggestions: "#suggestions", matches: "#list", abtest: "#abtest" };

function showTab(which) {
  for (const [name, selector] of Object.entries(PANELS)) {
    $(selector).hidden = name !== which;
    $(`#tab-${name === "matches" ? "matches" : name}`).setAttribute("aria-selected", String(name === which));
  }
  if (which === "abtest") loadAbTest();
}

(async function init() {
  $("#hostmeta").textContent = location.host;
  STAGES = await api("/api/stages");

  $("#entry").addEventListener("submit", (e) => {
    e.preventDefault();
    const value = $("#entryinput").value.trim();
    if (value) startRender(value);
  });
  $("#tab-suggestions").addEventListener("click", () => showTab("suggestions"));
  $("#tab-matches").addEventListener("click", () => showTab("matches"));
  $("#tab-abtest").addEventListener("click", () => showTab("abtest"));

  await refresh();
  if (matches.length) select(matches[0].matchId);
  // Not awaited: the first scan can take a minute against a cold cache, and the rendered-match
  // list is usable immediately.
  pollSuggestions().catch((e) => ($("#suggestions").innerHTML = `<div class="scanline bad">${esc(e.message)}</div>`));
})();
