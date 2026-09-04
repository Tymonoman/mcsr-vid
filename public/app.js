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
      <input type="text" id="hook" placeholder="The one part worth writing by hand">
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

    <h2>Chapters</h2>
    <pre>${esc(meta.chapters ?? "not generated yet")}</pre>`;

  if (meta.hook) {
    $("#hook").addEventListener("input", () => hookCounter(meta));
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

  watch(id, true);
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

(async function init() {
  $("#hostmeta").textContent = location.host;
  STAGES = await api("/api/stages");
  await refresh();
  if (matches.length) select(matches[0].matchId);
})();
