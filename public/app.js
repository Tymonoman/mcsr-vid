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
  // The morning's number: finished MP4s nobody has published. Hidden matches are out of it, so
  // parking an old one keeps the count honest.
  const ready = matches.filter((m) => !m.hidden && m.exported && !m.uploaded).length;
  $("#tab-matches").textContent = ready ? `Rendered (${ready} ready)` : "Rendered";
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
        ${m.uploaded ? '<div class="state">published</div>' : m.exported ? '<div class="state ready">ready to publish</div>' : ""}
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
    c.addEventListener("click", () => select(Number(c.dataset.id), { open: true })),
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
 * `open` is set only when a human asked for this match -- a tapped card, or a render they just
 * started. Below 860px the list and the detail are two screens (see app.css), so opening one
 * hides the other; on the two-column desktop layout the class is inert. First load asks for
 * nothing, which is how the phone stays on the list while the desktop still auto-selects.
 */
async function select(id, { open = false } = {}) {
  selected = id;
  if (open) showMatch();
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

    <div class="checklist" id="checklist"></div>

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

    <h2>Publish kit</h2>
    <div id="publishkit"><div class="empty">loading&hellip;</div></div>

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

  loadChecklist(id);
  loadVariants(id);
  loadSplits(id, meta);
  loadPreview(id);
  loadShort(id);
  loadYoutube(id, meta);
  loadPublishKit(id, meta);
  watch(id, true);
}

/**
 * The publish checklist, in the order the work actually happens. Uploading is manual until the
 * YouTube compliance audit clears, so this row is the only place that knows whether a rendered
 * match ever left the box. Five pills are facts read off disk and are not clickable; the three
 * that happen in Studio or in a DM are buttons.
 */
const CHECKLIST = [
  ["rendered", "rendered"],
  ["hookPicked", "hook"],
  ["thumbnailChosen", "thumbnail"],
  ["uploaded", "uploaded", true],
  ["shortRendered", "Short rendered"],
  ["chatSaved", "chat saved"],
  ["shortUploaded", "Short uploaded", true],
  ["relatedLinkSet", "related link", true],
  ["endScreenSet", "end screen", true],
  ["playersNotified", "players notified", true],
];

async function loadChecklist(id) {
  const el = $("#checklist");
  if (!el) return;

  // Repainted from whatever the server last returned — including the PUT reply, which is the
  // whole merged object, so a toggle needs no follow-up GET.
  const paint = (state) => {
    el.innerHTML = CHECKLIST.map(([key, label, manual]) => {
      const on = state[key] === true;
      // The tick is not decoration: filled-vs-outlined is a colour difference, and this row is
      // read at a glance on a phone. It also gives the read-only pills something to announce.
      const text = `${on ? "✓" : "·"} ${label}`;
      return manual
        ? `<button type="button" class="pill${on ? " on" : ""}" data-key="${key}" aria-pressed="${on}">${text}</button>`
        : `<span class="pill${on ? " on" : ""}">${text}</span>`;
    }).join("");

    el.querySelectorAll("button[data-key]").forEach((btn) =>
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        try {
          paint(
            await api(`/api/publish/${id}`, {
              method: "PUT",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                key: btn.dataset.key,
                value: btn.getAttribute("aria-pressed") !== "true",
              }),
            }),
          );
        } catch (err) {
          btn.disabled = false;
          alert(err.message);
        }
      }),
    );
  };

  try {
    paint(await api(`/api/publish/${id}`));
  } catch (err) {
    el.innerHTML = `<span class="pill">checklist unavailable: ${esc(err.message)}</span>`;
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

  // The headline the strip was rendered with — every variant except any marked control. Not
  // visible in the shrunken previews once it wraps, and it is the whole reason a re-render
  // happens.
  const headline = data.hookText
    ? `<div class="counter">headline: &ldquo;${esc(data.hookText)}&rdquo;</div>`
    : "";

  el.innerHTML =
    headline +
    `<div class="strip">${data.variants
      .map((v) => {
        const fellBack = v.leftProvider === "nmsr" || v.rightProvider === "nmsr";
        return `
      <figure class="variant ${v.key === data.chosen ? "chosen" : ""}" data-key="${esc(v.key)}">
        <img src="/api/thumbnail/${id}?v=${encodeURIComponent(v.key)}" alt="${esc(v.key)}" loading="lazy">
        <figcaption>
          <span class="key">${esc(v.leftPose)} / ${esc(v.rightPose)}${v.hook === false ? " · no text (control)" : ""}</span>
          ${fellBack ? '<span class="fallback" title="This pose name has no camera, so it is the default NMSR view -- not the pose it is named after">static fallback</span>' : ""}
          ${v.key === data.chosen ? '<span class="is-chosen">in use</span>' : '<button type="button" class="use">Use this</button>'}
        </figcaption>
      </figure>`;
      })
      .join("")}</div>` +
    '<button type="button" class="ghost" id="rerender">Re-render with hook</button>';

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

  // The pipeline renders thumbnails before anyone has watched the match, so the headline in the
  // image is only its first guess. This is how it catches up with the hook the title editor got.
  // That field lives in the metadata panel, which is absent when the match has no metadata yet.
  $("#rerender").addEventListener("click", async (ev) => {
    const btn = ev.currentTarget;
    const hookText = $("#hook")?.value.trim() ?? "";
    btn.disabled = true;
    btn.textContent = "Rendering\u2026";
    try {
      await api(`/api/thumbnails/${id}/rerender`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hookText }),
      });
      // 202 only means it started. The manifest's hookText is the one thing that says it
      // finished, so poll that rather than guessing at a duration.
      const want = hookText || null;
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const m = await api(`/api/thumbnails/${id}`).catch(() => null);
        if (m && m.hookText === want) break;
      }
    } catch (e) {
      btn.textContent = e.message;
      return;
    }
    await loadVariants(id);
    await refresh();
  });
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
    // The one-pass encode the nightly runs, on demand. ~10 minutes on the lab, so the button
    // hands over to a bar fed by the same progress stream the nightly's encode writes to.
    el.innerHTML = `
      <div class="row">
        <button id="encode" ${meta.running ? "disabled" : ""}>Encode MP4 (~10 min)</button>
        <span id="encodestate" class="muted">${meta.running ? "encoding…" : "not exported yet"}</span>
      </div>
      <div class="bar exportbar${meta.running ? "" : " hidden"}"><i style="width:${meta.percent ?? 0}%"></i></div>`;
    $("#encode").addEventListener("click", async () => {
      const btn = $("#encode");
      btn.disabled = true;
      try {
        await api(`/api/export/fast/${id}`, { method: "POST" });
        $("#encodestate").textContent = "encoding…";
        $(".exportbar").classList.remove("hidden");
        watchExport(id);
      } catch (e) {
        $("#encodestate").textContent = e.message;
        btn.disabled = false;
      }
    });
    if (meta.running) watchExport(id);
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

/** Follows one encode to its end, then swaps the bar for the player. The stream replays what
    the encode has said so far, so a phone that comes back late is not blind. */
function watchExport(id) {
  const src = new EventSource(`/api/export/progress/${id}`);
  const state = () => $("#encodestate");
  src.onmessage = (e) => {
    const ev = JSON.parse(e.data);
    const bar = document.querySelector(".exportbar > i");
    if (ev.percent !== undefined && bar) {
      bar.style.width = ev.percent + "%";
      if (state()) state().textContent = `encoding… ${ev.percent}%`;
    }
    if (ev.done) {
      src.close();
      if (ev.error) {
        if (state()) {
          state().textContent = ev.error;
          state().className = "bad";
        }
        const btn = $("#encode");
        if (btn) btn.disabled = false;
      } else {
        loadPreview(id);
      }
    }
  };
  src.onerror = () => src.close();
}

/** m:ss, for moment boundaries measured from the start of the run. */
/**
 * Every paste a manual publish needs, in the order it gets used.
 *
 * Uploading is manual while the YouTube compliance audit is pending, and two parts of it stay
 * manual afterwards: a Short's Related Video link has no API, and telling the two players their
 * match is up is a DM. Today those pastes are transcribed by hand out of four different panels,
 * which is exactly how a title picks up a stray newline. Nothing here is stored -- every block
 * is derived from the metadata already on the page plus /api/publishkit.
 */
async function loadPublishKit(id, meta) {
  const el = $("#publishkit");
  if (!el) return;

  let kit;
  try {
    kit = await api(`/api/publishkit/${id}`);
  } catch (e) {
    el.innerHTML = `<div class="scanline bad">${esc(e.message)}</div>`;
    return;
  }

  const [left, right] = kit.players;
  const url = kit.videoUrl ?? "<link once uploaded>";
  // Plain, and it offers the takedown in the same breath: this goes to someone who never asked
  // to be on the channel, and one line of "just say" is cheaper than a strike.
  const dm = (who, opponent) =>
    `Hey ${who} — your ranked match vs ${opponent} is up on MCSR Replayoffs, both POVs synced with the split timer: ${url}. Happy to take it down if you'd rather, just say.`;

  // The YouTube panel's field is the one an operator may have edited by hand, so it wins while
  // it is on the page; otherwise the generated first line with the hook substituted in. Never
  // the whole file: the lines under it are guidance for the terminal (src/title.ts).
  const titleText = () => {
    const field = $("#ytTitle");
    if (field) return field.value;
    const firstLine = (meta.title ?? "").split("\n")[0] ?? "";
    const hook = $("#hook")?.value.trim();
    return hook ? firstLine.replace("<HOOK>", hook) : firstLine;
  };

  const counter = (text, over) => `<span class="counter${over ? " over" : ""}">${esc(text)}</span>`;
  const block = (label, text, rows, note = "") => `
    <div class="kit">
      <div class="kithead">
        <span class="kitlabel">${esc(label)}</span>${note}
        <button type="button" class="ghost copy">Copy</button>
      </div>
      <textarea readonly rows="${rows}">${esc(text)}</textarea>
    </div>`;

  // The slot, in the operator's own zone with the UTC hour beside it. Studio's scheduler takes
  // local time; the upload form below gets the same value as its default, so a scheduled upload
  // through the dashboard and a paste into Studio land on the same minute.
  const slot = kit.publishAt ? new Date(kit.publishAt) : null;
  const slotText = slot
    ? `${slot.toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })} (${String(kit.publishHourUtc).padStart(2, "0")}:00 UTC)`
    : "";
  const when = $("#ytWhen");
  if (slot && when && !when.value) {
    const pad = (n) => String(n).padStart(2, "0");
    when.value = `${slot.getFullYear()}-${pad(slot.getMonth() + 1)}-${pad(slot.getDate())}T${pad(slot.getHours())}:${pad(slot.getMinutes())}`;
  }

  const paint = () => {
    const title = titleText();
    const tags = (meta.tags ?? []).join(", ");
    el.innerHTML = [
      block("Title", title, 2, counter(`${title.length} / 100 chars`, title.length > 100)),
      slot ? block("Publish at", slotText, 1) : "",
      block("Description", meta.description ?? "", 10),
      // Both numbers, because YouTube caps the list twice over: 500 characters across the whole
      // field, and the count is what tells you the pipeline wrote a tags file at all.
      block(
        "Tags",
        tags,
        3,
        counter(`${meta.tags?.length ?? 0} tags · ${tags.length} / 500 chars`, tags.length > 500),
      ),
      kit.shortTitle
        ? block("Short title", kit.shortTitle, 2)
        : `<div class="kit"><div class="kithead"><span class="kitlabel">Short title</span></div>
             <div class="empty">no Short title yet</div></div>`,
      kit.shortDescription ? block("Short description", kit.shortDescription, 4) : "",
      block(`Message to ${left ?? "left player"}`, dm(left ?? "there", right ?? "your opponent"), 3),
      block(`Message to ${right ?? "right player"}`, dm(right ?? "there", left ?? "your opponent"), 3),
    ].join("");
  };
  paint();

  el.addEventListener("click", (ev) => {
    const btn = ev.target.closest("button.copy");
    if (!btn) return;
    navigator.clipboard
      ?.writeText(btn.closest(".kit").querySelector("textarea").value)
      .then(
        () => (btn.textContent = "copied"),
        () => (btn.textContent = "blocked"),
      )
      .finally(() => setTimeout(() => (btn.textContent = "Copy"), 1500));
  });

  // The hook is typed after this panel paints, and the YouTube panel rewrites #ytTitle from the
  // same event. Deferring a tick means this reads that field after it has been rewritten,
  // whichever of the two panels happened to register its listener first.
  $("#hook")?.addEventListener("input", () => setTimeout(paint, 0));
}

function runClock(ms) {
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * The candidate windows, best first, and a button to cut one.
 *
 * Ranked rather than chosen for you: the scorer is a set of informed guesses about what makes a
 * Short watchable (see src/shortMoment.ts) and has no retention data behind it yet, so the top
 * pick is a strong default and not a verdict. Each row shows why it won and the line it would
 * carry if nothing better existed, which is the part worth disagreeing with.
 *
 * `data.hook` is the line that will actually be burned in — the edited title's hook, or the
 * top-ranked suggestion, and only then the per-row one. The rows used to be the only hook on
 * screen, which meant the panel showed a line no render would ever use.
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
    ${
      data.title
        ? `<div class="previewmeta">
             <span id="shorttitle">${esc(data.title)}</span>
             <button type="button" id="shorttitlecopy" class="ghost">Copy title</button>
           </div>`
        : ""
    }
    ${data.hook ? `<div class="previewmeta"><span>burns in: &ldquo;${esc(data.hook)}&rdquo;</span></div>` : ""}
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

  // The Short's title is typed into Studio by hand, and retyping a line the render already
  // wrote is how a hook picks up a typo the burned-in one doesn't have.
  const copyTitle = $("#shorttitlecopy");
  if (copyTitle) {
    copyTitle.addEventListener("click", () => {
      navigator.clipboard?.writeText(data.title);
      copyTitle.textContent = "Copied";
    });
  }

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
  // A card whose match just landed on the shelf switches from render buttons to "open".
  if (suggestData) renderSuggestions(suggestData);
}

/* --- Nightly render strip ---------------------------------------------------------------------
   The scheduler is a setTimeout and a log line, both invisible by morning, so "trust the timer"
   was the only option. This is the whole of its UI: what it will pick tonight, what the last run
   did, and a button that stops you waiting for 03:00 UTC to find out.

   It rides at the top of the Suggestions panel rather than being its own element, because
   renderSuggestions() rebuilds that panel on every scan poll and a sibling would have to be
   hidden and shown in step with the tab. The payload is cached so the repaint costs no request. */

let nightly = null;

function nightlyInner() {
  if (!nightly) return '<div class="lines"><span class="muted">nightly&hellip;</span></div>';
  if (nightly.stale) {
    return `<div class="lines"><span class="bad">The server is running older code than this page</span> &middot; <code>docker restart mcsr-dashboard</code> on the lab enables the nightly render and the newer panels.</div>`;
  }
  if (nightly.error) return `<div class="lines"><span class="bad">${esc(nightly.error)}</span></div>`;

  const { enabled, hourUtc, nextRunAt, candidate, lastRun } = nightly;
  // The browser knows the operator's zone; the config only knows UTC. Both, so "03:00" is not
  // mistaken for a small-hours render when it is 05:00 where the operator sleeps.
  const local =
    nextRunAt && new Date().getTimezoneOffset() !== 0
      ? new Date(nextRunAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : null;
  const at = `Next ${local ? `${local} local (` : ""}${String(hourUtc).padStart(2, "0")}:00 UTC${local ? ")" : ""}`;
  const plan = !enabled
    ? '<span class="muted">nightly off</span>'
    : candidate
      ? `${esc(at)} &middot; will render <b>${esc(candidate.players[0])} vs ${esc(candidate.players[1])}</b>`
      : `${esc(at)} &middot; <span class="muted">nothing eligible</span>`;

  // "Last run", not "last night": the Run now button records here too, and a label that lied
  // about when it happened would be worse than a slightly duller one.
  let last = '<span class="muted">Last run: never</span>';
  if (lastRun) {
    // The morning click: the record names a match that is (usually) on the shelf now, and the
    // strip is the first thing the operator reads. A match that has since been deleted stays
    // plain text rather than a link to a 404.
    const label = lastRun.matchId ? `#${lastRun.matchId} ${esc(lastRun.players.join(" vs "))}` : "";
    const onShelf = lastRun.matchId && matches.some((m) => m.matchId === lastRun.matchId);
    const who = !label
      ? ""
      : onShelf
        ? `<a href="#" data-act="nightly-open" data-id="${lastRun.matchId}">${label}</a> &mdash; `
        : `${label} &mdash; `;
    const why = lastRun.reason ? `: ${lastRun.reason}` : "";
    const short =
      lastRun.short === "done"
        ? ' <span class="ok">+ Short rendered</span>'
        : lastRun.short === "failed"
          ? ' <span class="bad">+ Short failed</span>'
          : "";
    const exported =
      lastRun.export === "done"
        ? ' <span class="ok">+ exported</span>'
        : lastRun.export === "failed"
          ? ' <span class="bad">+ export failed</span>'
          : "";
    const cls = lastRun.outcome === "done" ? "ok" : lastRun.outcome === "failed" ? "bad" : "muted";
    last = `Last run: ${who}<span class="${cls}">${esc(lastRun.outcome + why)}</span>${short}${exported}`;
  }

  return `<div class="lines">
      <div class="plan" title="${esc(nextRunAt ?? "no schedule")}">${plan}</div>
      <div class="last" title="${esc(lastRun ? lastRun.startedAt : "")}">${last}</div>
    </div>
    <button data-act="nightly-run">Run now</button>`;
}

function paintNightly() {
  const el = $("#nightly");
  if (!el) return;
  el.innerHTML = nightlyInner();
  const btn = el.querySelector('[data-act="nightly-run"]');
  if (btn) btn.addEventListener("click", () => runNightlyNow(btn));
  const open = el.querySelector('[data-act="nightly-open"]');
  if (open) {
    open.addEventListener("click", (ev) => {
      ev.preventDefault();
      void select(Number(open.dataset.id), { open: true });
    });
  }
}

async function loadNightly() {
  try {
    nightly = await api("/api/nightly");
  } catch (e) {
    // public/ is served from disk and src/ is read at boot, so after a pull this page is newer
    // than the server until the container restarts. The old server answers this route with
    // "match id must be digits" (no nightly route: the id parser gets "nightly"); say what that
    // means instead of showing it.
    const stale = /must be digits|not found/i.test(e.message);
    nightly = { error: e.message, stale };
  }
  paintNightly();
}

/** The same body the clock runs. A skip repaints the strip with its reason; a start is watched
    like any other render, so it lands in the list exactly as a card's render would. */
async function runNightlyNow(btn) {
  btn.disabled = true;
  btn.textContent = "starting…";
  try {
    const out = await api("/api/nightly/run", { method: "POST" });
    await loadNightly();
    if (out.matchId) {
      await refresh();
      await select(out.matchId, { open: true });
      watch(out.matchId, true);
    }
  } catch (e) {
    nightly = { error: e.message };
    paintNightly();
  }
}

/* --- Suggestions ------------------------------------------------------------------------- */

let suggestPoll = null;
/** The last card dismissed, until it is restored or another goes: the undo line's subject. */
let lastDismissed = null;
/** The last payload painted, so a shelf change can repaint the cards without a request. */
let suggestData = null;

function renderSuggestions(data) {
  suggestData = data;
  const el = $("#suggestions");
  $("#tab-suggestions").textContent =
    `Suggestions${data.suggestions.length ? ` (${data.suggestions.length})` : ""}`;
  updateBackLabel();

  // A failed scan keeps whatever list it had: a stale suggestion is still a renderable match.
  // Settled, the line says what was scanned and offers a rescan — the list refreshes itself
  // every suggestCacheTtlMin, and until now there was no way to ask sooner from the browser.
  const scan = data.scanning
    ? `<div class="scanline">scanning&hellip; ${data.scanned} matches, ${data.candidates} with two VODs</div>`
    : data.error
      ? `<div class="scanline bad">scan failed: ${esc(data.error)}</div>`
      : `<div class="scanline">${data.scanned ? `${data.scanned} scanned, ${data.candidates} with two VODs` : "list from the last scan"}${data.note ? ` &middot; ${esc(data.note)}` : ""} &middot; <a href="#" data-act="rescan" title="Scan again now (~340 MCSR API calls). The list refreshes itself every 30 minutes.">rescan</a></div>`;

  // The two words on every card, explained once. The stage strip had the same gap: labels that
  // are obvious to whoever wrote the scorer and to nobody else.
  const legend = data.suggestions.length
    ? `<div class="bucketlegend"><span class="bucket close">CLOSE</span><span>decided by seconds at the finish</span><span class="bucket chaos">CHAOS</span><span>lead changes, deaths, the mess</span></div>`
    : "";

  // Dismiss is next to Render on a phone, and used to be permanent. One line, above the cards,
  // until it is used or the next dismiss replaces it.
  const undo = lastDismissed
    ? `<div class="scanline">Dismissed <b>${esc(lastDismissed.who)}</b> &middot; <a href="#" data-act="undo">undo</a>${lastDismissed.note ? ` <span class="muted">${esc(lastDismissed.note)}</span>` : ""}</div>`
    : "";

  const cards = !data.suggestions.length
    ? `<div class="empty">${data.scanning ? "" : "Nothing suggested yet."}</div>`
    : data.suggestions
        .map((s) => {
          // Rendered since the list was scored — by the nightly, or a click: the card stays, since
          // the list is the operator's reading order, but its verb changes. Pressing render on a
          // finished match was the morning's easiest mistake. The full chain is the primary
          // button: it is what the nightly does, and a finished MP4 is what "render" means to
          // the operator; "Render only" is the Kdenlive round-trip's first half.
          const onShelf = matches.some((m) => m.matchId === s.matchId);
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
          ${
            onShelf
              ? `<button data-act="open">Rendered &middot; open</button>`
              : `<button data-act="render-short">Render + Short + MP4</button>
          <button data-act="render" class="ghost">Render only</button>`
          }
          <button data-act="dismiss" class="ghost">Dismiss</button>
        </div>
      </div>`;
        })
        .join("");

  el.innerHTML = '<div id="nightly" class="nightly"></div>' + undo + scan + legend + cards;
  paintNightly();
  el.querySelector('[data-act="rescan"]')?.addEventListener("click", async (ev) => {
    ev.preventDefault();
    renderSuggestions(await api("/api/suggestions/rescan", { method: "POST" }));
    clearTimeout(suggestPoll);
    suggestPoll = setTimeout(pollSuggestions, 2000);
  });
  el.querySelector('[data-act="undo"]')?.addEventListener("click", async (ev) => {
    ev.preventDefault();
    const { id, who } = lastDismissed;
    const out = await api(`/api/suggestions/${id}/restore`, { method: "POST" });
    // A restart since the dismiss means the row is gone from memory; it returns at the next scan.
    lastDismissed = out.now ? null : { id, who, note: "back after the next scan" };
    renderSuggestions(out);
  });
  // First paint fetches it; every later paint reuses the cache, so polling a running scan does
  // not also poll the scheduler.
  if (nightly === null) void loadNightly();
  if (!data.suggestions.length) return;

  el.querySelectorAll(".sugg").forEach((row) => {
    const id = Number(row.dataset.id);
    row.querySelector('[data-act="render"]')?.addEventListener("click", () => startRender(String(id)));
    row.querySelector('[data-act="render-short"]')?.addEventListener("click", () => startRenderWithShort(id));
    row.querySelector('[data-act="open"]')?.addEventListener("click", () => select(id, { open: true }));
    row.querySelector('[data-act="dismiss"]').addEventListener("click", async () => {
      const s = data.suggestions.find((x) => x.matchId === id);
      const out = await api(`/api/suggestions/${id}`, { method: "DELETE" });
      lastDismissed = { id, who: s ? `${s.players[0]} vs ${s.players[1]}` : `#${id}` };
      renderSuggestions(out);
    });
  });
}

/** "Render + Short + MP4": the same start as "Render only", plus the flags the server's one
    completion poll reads — so the Short and the encode come from the nightly's own code, not a
    second copy of it. What the nightly does at 03:00, by hand, for a match you want today. */
async function startRenderWithShort(id) {
  const err = $("#entryerr");
  err.textContent = "";
  try {
    await api(`/api/render/${id}?short=1&export=1`, { method: "POST" });
    await refresh();
    await select(id, { open: true });
    watch(id);
  } catch (e) {
    err.textContent = e.message;
  }
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

/** The entry box's render is the full chain — a pasted match URL means "I want this video" —
    while a card's "Render only" is the plain pipeline, for a match headed to Kdenlive. */
async function startRender(input, full = false) {
  const err = $("#entryerr");
  err.textContent = "";
  try {
    const { matchId } = await api(`/api/render${full ? "?short=1&export=1" : ""}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input }),
    });
    // The match may have no working directory yet, so it is not in `matches` — refresh first so
    // select() can find it, then fall back to watching the id directly.
    await refresh();
    await select(matchId, { open: true });
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
  updateBackLabel();
  if (which === "abtest") loadAbTest();
}

/* --- List screen / match screen -------------------------------------------------------------
   Only the class moves. Whether it means anything is the @media (max-width: 860px) block's
   business, so there is no width test in here to drift out of step with the CSS. */

/** The tab's own label already carries the count, so the way back names where it goes. */
function updateBackLabel() {
  const tab = $('.tabs [aria-selected="true"]');
  $("#backtolist").textContent = `\u2190 Back to ${tab ? tab.textContent : "list"}`;
}

function showMatch() {
  document.body.classList.add("view-match");
  updateBackLabel();
  // Only when the CSS actually swapped screens: hiding the list shortens the page, and the
  // browser would leave you clamped somewhere in the middle of the detail. Asking the back
  // bar whether it is on screen beats re-testing the width the stylesheet already tested.
  if ($("#backtolist").offsetParent) window.scrollTo(0, 0);
}

function showList() {
  document.body.classList.remove("view-match");
  window.scrollTo(0, 0);
}

(async function init() {
  $("#hostmeta").textContent = location.host;
  STAGES = await api("/api/stages");

  $("#entry").addEventListener("submit", (e) => {
    e.preventDefault();
    const value = $("#entryinput").value.trim();
    if (value) startRender(value, true);
  });
  $("#tab-suggestions").addEventListener("click", () => showTab("suggestions"));
  $("#tab-matches").addEventListener("click", () => showTab("matches"));
  $("#tab-abtest").addEventListener("click", () => showTab("abtest"));
  $("#backtolist").addEventListener("click", showList);

  await refresh();
  if (matches.length) select(matches[0].matchId);
  // Not awaited: the first scan can take a minute against a cold cache, and the rendered-match
  // list is usable immediately.
  pollSuggestions().catch(
    (e) => ($("#suggestions").innerHTML = `<div class="scanline bad">${esc(e.message)}</div>`),
  );
})();
