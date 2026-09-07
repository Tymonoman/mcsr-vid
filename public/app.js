const $ = (s, r = document) => r.querySelector(s);
let STAGES = { order: [], labels: {}, short: {} };
/** Hidden matches are filtered out of the list until this is toggled on. */
let showHidden = false;
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
    .map((s) => `<span title="${esc(STAGES.labels[s])}">${esc(STAGES.short[s] ?? STAGES.labels[s])}</span>`)
    .join("")}</div>`;

  const visible = showHidden ? matches : matches.filter((m) => !m.hidden);
  const hiddenCount = matches.filter((m) => m.hidden).length;
  const toggle = hiddenCount
    ? `<button type="button" id="showhidden" class="ghost">${showHidden ? "Hide" : "Show"} ${hiddenCount} hidden</button>`
    : "";

  el.innerHTML =
    toggle +
    legend +
    visible
      .map(
        (m) => `
    <div class="card" data-id="${m.matchId}" aria-selected="${selected === m.matchId}">
      <img src="/api/thumbnail/${m.matchId}" alt="" loading="lazy"
           onerror="this.style.visibility='hidden'">
      <div>
        <div class="who">${esc(m.leftNickname)} vs ${esc(m.rightNickname)}</div>
        <div class="id">#${m.matchId}</div>
        ${m.error ? `<div class="degraded" title="${esc(m.error)}">names from filenames &mdash; API lookup failed</div>` : ""}
        <div class="rowacts">
          <button type="button" class="hide ghost">${m.hidden ? "Unhide" : "Hide"}</button>
          <button type="button" class="del ghost" data-armed="0">Delete</button>
        </div>
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
    c.addEventListener("click", () => select(Number(c.dataset.id), { scroll: true })),
  );

  $("#showhidden")?.addEventListener("click", (e) => {
    e.stopPropagation();
    showHidden = !showHidden;
    renderList();
  });

  // stopPropagation on every row control: the card itself is a click target that selects the
  // match, and hiding a match you did not mean to open is a poor trade.
  el.querySelectorAll(".card .hide").forEach((btn) =>
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const card = btn.closest(".card");
      const id = Number(card.dataset.id);
      const nowHidden = btn.textContent === "Hide";
      await api(`/api/hidden/${id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hidden: nowHidden }),
      });
      await refresh();
    }),
  );

  // Two-step rather than a confirm(): the second click is the confirmation, and the button says
  // what it is about to cost. An unarchived match has no copy anywhere, so it says so.
  el.querySelectorAll(".card .del").forEach((btn) =>
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const card = btn.closest(".card");
      const id = Number(card.dataset.id);
      const m = matches.find((x) => x.matchId === id);
      if (btn.dataset.armed !== "1") {
        btn.dataset.armed = "1";
        btn.classList.remove("ghost");
        btn.classList.add("danger");
        btn.textContent = m && m.archived ? "Delete (archived)" : "Delete forever?";
        setTimeout(() => {
          if (!btn.isConnected || btn.dataset.armed !== "1") return;
          btn.dataset.armed = "0";
          btn.classList.add("ghost");
          btn.classList.remove("danger");
          btn.textContent = "Delete";
        }, 5000);
        return;
      }
      btn.disabled = true;
      btn.textContent = "deleting";
      try {
        const out = await api(`/api/match/${id}`, { method: "DELETE" });
        const mb = (out.bytesFreed / 1073741824).toFixed(1);
        $("#entryerr").textContent =
          `deleted #${id}, freed ${mb} GB${out.archived ? "" : " (no archived copy)"}`;
      } catch (err) {
        $("#entryerr").textContent = err.message;
        btn.disabled = false;
        btn.textContent = "Delete";
      }
      if (selected === id) selected = null;
      await refresh();
    }),
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
  $("#hookpreview").textContent = input.value
    ? `${input.value} | ${meta.hook.generated}`
    : meta.hook.placeholder;
}

/**
 * `scroll` is set only when a human tapped a card. Below 860px the detail pane is a row under
 * the whole list, so on a phone a tap changes something a thousand pixels off-screen and reads
 * as nothing happening. On the two-column desktop layout the pane is already in view and
 * scrolling would just be jarring, and on first load nothing was tapped at all.
 */
async function select(id, { scroll = false } = {}) {
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

    <h2>Splits</h2>
    <div id="splits"><div class="empty">loading&hellip;</div></div>

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

    <h2>Final video</h2>
    <div id="preview"><div class="empty">loading&hellip;</div></div>

    <h2>Short</h2>
    <div id="short"><div class="empty">loading&hellip;</div></div>

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
  loadSplits(id, meta);
  loadPreview(id);
  loadShort(id);
  loadYoutube(id, meta);
  watch(id, true);

  if (scroll && matchMedia("(max-width: 860px)").matches) {
    $("#detail").scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

/**
 * The rendered pose variants, one per configured pair. Picking one copies it over
 * thumbnail.png, which is the file that gets uploaded.
 *
 * A variant whose avatars came back un-posed is labelled as a fallback rather than shown as a
 * distinct pose: it is the default NMSR view, so every such variant is the same image, and
 * calling them three poses would make the eventual CTR comparison a lie.
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
      const fellBack = v.leftProvider === "nmsr" || v.rightProvider === "nmsr";
      return `
      <figure class="variant ${v.key === data.chosen ? "chosen" : ""}" data-key="${esc(v.key)}">
        <img src="/api/thumbnail/${id}?v=${encodeURIComponent(v.key)}" alt="${esc(v.key)}" loading="lazy">
        <figcaption>
          <span class="key">${esc(v.leftPose)} / ${esc(v.rightPose)}</span>
          ${fellBack ? '<span class="fallback" title="This pose name has no camera, so it is the default NMSR view -- not the pose it is named after">static fallback</span>' : ""}
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
 * The finished export, playable in place.
 *
 * `preload="metadata"` on purpose: the file is several hundred megabytes and the point of the
 * panel is to check a render at a glance, so it fetches the header and the poster frame and
 * nothing else until you press play. Seeking works because the route serves byte ranges.
 */
/**
 * The same chart the suggestion cards carry, full size. Fetched separately rather than folded
 * into /api/meta: the metrics need the full match (timelines), which is one more API request,
 * and the metadata editor above must not wait on it or block when the API is down.
 */
async function loadSplits(id, meta) {
  const el = $("#splits");
  if (!el) return;
  try {
    const data = await api(`/api/splits/${id}`);
    const svg = splitsChart(data.splits, {
      left: meta.leftNickname,
      right: meta.rightNickname,
      compact: false,
    });
    el.innerHTML =
      svg || '<div class="empty">no comparable splits &mdash; this match has no timeline events</div>';
  } catch (e) {
    el.innerHTML = `<div class="scanline bad">${esc(e.message)}</div>`;
  }
}

async function loadPreview(id) {
  const el = $("#preview");
  if (!el) return;
  let meta;
  try {
    meta = await api(`/api/export/preview-meta/${id}`);
  } catch (e) {
    el.innerHTML = `<div class="scanline bad">${esc(e.message)}</div>`;
    return;
  }
  if (!meta.exported) {
    el.innerHTML = '<div class="empty">not exported yet &mdash; run the export, then reload</div>';
    return;
  }
  const mb = (meta.bytes / 1048576).toFixed(0);
  el.innerHTML = `
    <video id="finalvideo" controls preload="metadata" playsinline
           src="/api/export/preview/${id}" poster="/api/thumbnail/${id}"></video>
    <div class="previewmeta">
      <span>${esc(meta.name)}</span>
      <span>${mb} MB</span>
      <a href="/api/export/final/${id}" download>Download</a>
    </div>`;
}

/** m:ss, for moment boundaries measured from the start of the run. */
function runClock(ms) {
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * The candidate 30-second windows, best first, and a button to cut one.
 *
 * Ranked rather than chosen for you: the scorer is a set of informed guesses about what makes a
 * Short watchable (see src/shortMoment.ts) and has no retention data behind it yet, so the top
 * pick is a strong default and not a verdict. Each row shows why it won and the hook line it
 * would carry, which is the part worth disagreeing with.
 */
async function loadShort(id) {
  const el = $("#short");
  if (!el) return;
  let data;
  try {
    data = await api(`/api/shorts/moments/${id}`);
  } catch (e) {
    el.innerHTML = `<div class="scanline bad">${esc(e.message)}</div>`;
    return;
  }
  if (!data.moments.length) {
    el.innerHTML =
      '<div class="empty">no moment worth cutting &mdash; this match has no scored timeline events</div>';
    return;
  }

  el.innerHTML = `
    ${
      data.rendered
        ? `<div class="shortplayer">
             <video id="shortvideo" controls preload="metadata" playsinline
                    src="/api/shorts/preview/${id}"></video>
             <div class="previewmeta">
               <span>${esc(data.rendered)}</span>
               <a href="/api/shorts/preview/${id}" download>Download</a>
             </div>
           </div>`
        : ""
    }
    <div class="moments">${data.moments
      .map(
        (m) => `
      <div class="moment" data-pick="${m.index}">
        <span class="when">${runClock(m.startMs)}&ndash;${runClock(m.endMs)}</span>
        <span class="why">${esc(m.reason)}</span>
        <span class="hook">&ldquo;${esc(m.hook)}&rdquo;</span>
        <button type="button" class="cut">Cut this</button>
      </div>`,
      )
      .join("")}</div>
    <pre id="shortlog" class="hidden"></pre>`;

  el.querySelectorAll(".moment .cut").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const pick = Number(btn.closest(".moment").dataset.pick);
      el.querySelectorAll(".cut").forEach((b) => (b.disabled = true));
      const log = $("#shortlog");
      log.classList.remove("hidden");
      log.textContent = "starting\n";
      await api(`/api/shorts/render/${id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pick }),
      });
      // Same SSE shape as the export panel, so a phone that reconnects mid-render replays the
      // whole run rather than joining blind.
      const es = new EventSource(`/api/shorts/progress/${id}`);
      es.onmessage = (ev) => {
        const payload = JSON.parse(ev.data);
        if (payload.line) {
          log.textContent += `${payload.line}\n`;
          log.scrollTop = log.scrollHeight;
        }
        if (payload.done) {
          es.close();
          log.textContent += payload.error ? `failed: ${payload.error}\n` : "done\n";
          loadShort(id);
        }
      };
      es.onerror = () => es.close();
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

/** Stop is a no-op when nothing is running and destructive when something is, so it looks it. */
function armStop(on) {
  const btn = $("#stop");
  if (!btn) return;
  btn.classList.toggle("danger", on);
  btn.classList.toggle("ghost", !on);
  btn.disabled = !on;
  btn.title = on ? "Abort the running pipeline" : "Nothing is running";
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
  armStop(false);

  const src = new EventSource(`/api/progress/${id}`);
  stream = src;
  elapsedTimer = setInterval(paintElapsed, 1000);

  src.onmessage = (e) => {
    box.classList.add("live");
    const ev = JSON.parse(e.data);
    if (ev.status === "active") armStop(true);
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
    armStop(false);
    $("#msg").textContent = aborted ? "stopped" : error ? "failed" : "done";
    if (error) showFailure(stage ? `${STAGES.labels[stage]} failed` : "Pipeline failed", error);
    src.close();
    stream = null;
    clearInterval(elapsedTimer);
    paintElapsed();
    refresh();
  });

  // A 204 (no job) closes the stream without a console error; that is the normal case.
  src.onerror = () => {
    src.close();
    if (stream === src) stream = null;
    clearInterval(elapsedTimer);
    armStop(false);
    if (quiet) box.classList.remove("live");
  };
}

async function refresh() {
  matches = (await api("/api/matches")).matches;
  renderList();
}

/* --- Suggestions ------------------------------------------------------------------------- */

let suggestPoll = null;

function renderSuggestions(data) {
  const el = $("#suggestions");
  $("#tab-suggestions").textContent =
    `Suggestions${data.suggestions.length ? ` (${data.suggestions.length})` : ""}`;

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
        // Every line but the chart and the links is prose the server assembled, so it all goes
        // through esc() — including `bucket`, which reaches a class attribute.
        return `
      <div class="sugg" data-id="${s.matchId}">
        <div class="top">
          <span class="bucket ${esc(s.bucket)}">${esc(s.bucket.toUpperCase())}</span>
          <span class="who">${esc(s.players[0])} vs ${esc(s.players[1])}</span>
        </div>
        ${s.story ? `<div class="story">${esc(s.story)}</div>` : ""}
        <div class="facts">${esc(s.facts)}</div>
        ${splitsChart(s.splits, { left: s.players[0], right: s.players[1], compact: true })}
        <div class="expiry${s.expiring ? " warn" : ""}">${esc(s.expiryLabel)}</div>
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
  pollSuggestions().catch(
    (e) => ($("#suggestions").innerHTML = `<div class="scanline bad">${esc(e.message)}</div>`),
  );
})();
