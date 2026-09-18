const $ = (s, r = document) => r.querySelector(s);
let STAGES = { order: [], labels: {}, short: {} };
/** Hidden matches are filtered out of the list until this is toggled on. */
let showHidden = false;
let matches = [];
let selected = null;
// The competitor's handle as the suggestions payload names it; the Rendered rows' state line reads it too.
let rivalHandle = null;
const rivalHandleOrDefault = () => rivalHandle ?? "mcsrmatches";
let stream = null;
/** The encode progress stream for the selected match; closed when another match is opened. */
let exportStream = null;
/** The next publish slot the kit last fetched; prefilled into the upload form whenever it renders. */
let publishSlotAt = null;

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
  // In the order the morning asks its question: what do I upload next? Ready first, the ready
  // ones the competitor already posted after them, then what is still in progress, and what is
  // published last — newest first within each. The server's newest-first order was right for
  // finding what just rendered and wrong for a shelf of four finished MP4s and a published one.
  const stage = (m) => (m.uploaded ? 3 : m.exported ? (m.rivalPosted ? 1 : 0) : 2);
  const visible = (showHidden ? matches : matches.filter((m) => !m.hidden))
    .slice()
    .sort((a, b) => stage(a) - stage(b) || b.matchId - a.matchId);
  const hiddenCount = matches.filter((m) => m.hidden).length;
  // The morning's number: finished MP4s nobody has published. Hidden matches are out of it, so
  // parking an old one keeps the count honest.
  const ready = matches.filter((m) => !m.hidden && m.exported && !m.uploaded).length;
  $("#tab-matches small").textContent = ready ? `${ready} ready` : "";
  updateBackLabel();
  // One line naming the next action. The six stage pips and their legend used to say the same
  // thing in a code the operator had to decode; the match screen's Check group has the detail.
  const state = (m) => {
    if (m.uploaded) return '<div class="state">published</div>';
    if (m.exported && m.rivalPosted)
      return `<div class="state rival" title="${esc(m.rivalPosted.title)}">@${esc(rivalHandleOrDefault())} posted this ${m.rivalPosted.daysAgo === 0 ? "today" : `${m.rivalPosted.daysAgo}d ago`}</div>`;
    if (m.exported) return '<div class="state ready">ready &mdash; check &middot; pick &middot; upload</div>';
    const next = STAGES.order.find((s) => !m.stages[s]);
    return `<div class="state">in progress${next ? ` &middot; ${esc(STAGES.short?.[next] ?? STAGES.labels[next] ?? next).toLowerCase()}` : ""}</div>`;
  };
  const toggle = hiddenCount
    ? `<button type="button" id="showhidden" class="ghost">${showHidden ? "Hide" : "Show"} ${hiddenCount} hidden</button>`
    : "";

  el.innerHTML =
    toggle +
    visible
      .map(
        (m) => `
    <div class="card" data-id="${m.matchId}" aria-selected="${selected === m.matchId}" role="button" tabindex="0">
      ${
        // Only when one exists: the payload already knows, and asking for a thumbnail a match
        // never rendered costs a 404 and a console error on every list paint. onerror still
        // covers the race where the file is deleted between the scan and the paint.
        m.stages.thumbnail
          ? `<img src="/api/thumbnail/${m.matchId}" alt="" loading="lazy"
           onerror="this.style.visibility='hidden'">`
          : '<div class="nothumb" aria-hidden="true"></div>'
      }
      <div>
        <div class="who">${esc(m.leftNickname)} vs ${esc(m.rightNickname)}<span class="id">#${m.matchId}</span></div>
        ${state(m)}
        ${m.error ? `<div class="degraded" title="${esc(m.error)}">names from filenames &mdash; API lookup failed</div>` : ""}
      </div>
      <div class="rowacts">
        <button type="button" class="hide ghost">${m.hidden ? "Unhide" : "Hide"}</button>
        <button type="button" class="del ghost" data-armed="0">Delete</button>
      </div>
    </div>`,
      )
      .join("");

  el.querySelectorAll(".card").forEach((c) => {
    c.addEventListener("click", () => select(Number(c.dataset.id), { open: true }));
    // A row is a button in everything but markup; Enter and Space open it from the keyboard.
    c.addEventListener("keydown", (e) => {
      if (e.target !== c || (e.key !== "Enter" && e.key !== " ")) return;
      e.preventDefault();
      select(Number(c.dataset.id), { open: true });
    });
  });

  $("#showhidden")?.addEventListener("click", (e) => {
    e.stopPropagation();
    showHidden = !showHidden;
    renderList();
  });

  // stopPropagation on every row control: the card itself is a click target that selects the
  // match, and hiding a match you did not mean to open is a poor trade.
  el.querySelectorAll(".card .hide").forEach((btn) => wireHide(btn, Number(btn.closest(".card").dataset.id)));
  el.querySelectorAll(".card .del").forEach((btn) =>
    wireDelete(btn, Number(btn.closest(".card").dataset.id)),
  );
}

function wireHide(btn, id) {
  btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    const nowHidden = btn.textContent === "Hide";
    await api(`/api/hidden/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hidden: nowHidden }),
    });
    await refresh();
  });
}

/** Two-step rather than a confirm(): the second click is the confirmation, and the button says
    what it is about to cost. An unarchived match has no copy anywhere, so it says so. The row's
    button and the match screen's (the phone's only one — a row's sits inside the tap target that
    opens the match) share this. */
function wireDelete(btn, id) {
  btn.addEventListener("click", async (e) => {
    e.stopPropagation();
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
    if (selected === id) {
      selected = null;
      // On a phone this button is on the match screen, which has just been deleted from under it.
      document.body.classList.remove("view-match");
    }
    await refresh();
  });
}

/**
 * The title's first line carrying the hook that has been typed into the field.
 *
 * Two shapes, because the pipeline now writes its own first suggestion into the title file
 * (src/title.ts): a line still holding the placeholder, and a line that already has a hook in
 * front of the generated half. Either way the hook is everything before that half, so replacing
 * it is one rule. A line whose tail has been edited by hand is left exactly as it is.
 */
function titleWithHook(firstLine, hook, generated) {
  if (!hook) return firstLine;
  if (firstLine.includes("<HOOK>")) return firstLine.replace("<HOOK>", hook);
  return generated && firstLine.endsWith(generated) ? `${hook} | ${generated}` : firstLine;
}

function hookCounter(meta) {
  const input = $("#hook"),
    out = $("#hookcount");
  if (!input || !meta.hook) return;
  const n = input.value.length;
  const { min, max } = meta.hook;
  // A zero budget means the generated half alone has hit the 100-character ceiling (a playoff
  // suffix plus two long nicknames), not that a zero-length hook is wanted. "0 / 0-0 chars"
  // would read as the latter.
  out.textContent =
    max === 0
      ? `no room: ${meta.hook.placeholder.length - "<HOOK>".length} of 100 chars without a hook`
      : `${n} / ${min}-${max} chars`;
  out.className = "counter" + (n > max ? " over" : n >= min ? " good" : "");
}

/**
 * `open` is set only when a human asked for this match -- a tapped card, or a render they just
 * started. The list and the detail are two screens at every width (see app.css), so opening one
 * hides the other. First load asks for nothing: the detail is painted behind the list, and the
 * strip's last-run link or a row is the tap that shows it.
 *
 * The match screen is a head and four groups in the order the morning happens: Check (the
 * video, the sync frames, the sync editor), Package (hook, thumbnails; splits and the title
 * editors folded), Publish (YouTube, then the kit), After (the Short, then Manage). Two columns
 * on a desktop, one group at a time below 860px, switched by the .jump bar.
 */
async function select(id, { open = false } = {}) {
  // Re-selecting the match on screen (the strip's last-run link, a card's "Rendered · open")
  // rebuilds the markup; the group the operator was in must survive it, or a phone drops back to
  // Check mid-Package.
  const keepPanel = selected === id ? $("#detail .panel.on")?.dataset.panel : undefined;
  selected = id;
  if (exportStream) {
    exportStream.close();
    exportStream = null;
  }
  if (open) showMatch();
  renderList();
  const meta = await api(`/api/meta/${id}`);
  if (selected !== id) return; // the operator moved on while this was in flight
  const m = matches.find((x) => x.matchId === id);
  const rendered = m && m.stages.render;
  // Only the first line of the title file is a title; the rest is guidance formatTitle writes
  // for the terminal (src/title.ts). The box shows the line, Save puts the guidance back, so
  // the file keeps saying how long a hook may be.
  const [titleLine, ...titleRest] = (meta.title ?? "").split("\n");

  const runButtons = `<button id="run" class="${rendered ? "ghost" : ""}">${rendered ? "Re-run pipeline" : "Run pipeline"}</button>
      <button id="stop" class="danger" title="Abort the running pipeline" hidden>Stop</button>`;
  $("#detail").innerHTML = `
    <div class="head">
      <div class="row">
        ${rendered ? "" : runButtons}
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
      <div id="headwarn">${syncLine(meta)}</div>
      <nav class="jump">
        <a href="#h-preview" data-panel="check" aria-current="page">Check</a>
        <a href="#h-hook" data-panel="package">Package</a>
        <a href="#h-youtube" data-panel="publish">Publish</a>
        <a href="#h-short" data-panel="after">After</a>
      </nav>
    </div>

    <div class="cols">
      <div class="col">
        <section class="panel on" data-panel="check">
          <h2 id="h-preview">Final video</h2>
          <div id="preview"><div class="empty">loading&hellip;</div></div>
          <div id="synccheck"></div>
          <details id="syncedit" class="syncedit"><summary>Fix the sync by hand</summary><div class="empty">loading&hellip;</div></details>
        </section>
        <section class="panel" data-panel="after">
          <h2 id="h-short">Short</h2>
          <div id="short"><div class="empty">loading&hellip;</div></div>
          ${manageHtml(id, rendered ? runButtons : "", meta.outputs)}
        </section>
      </div>
      <div class="col">
        <section class="panel" data-panel="package">
          <h2 id="h-hook">Hook ${meta.hook ? '<span class="counter" id="hookcount"></span>' : ""}</h2>
          <div class="row hookrow">
            ${
              meta.hook
                ? `<input type="text" id="hook" placeholder="${esc(meta.hook.suggestions[0] ?? "The one part worth writing by hand")}">`
                : '<span class="muted">no hook data for this match</span>'
            }
            <button id="save" title="Commit the hook into the title, and save the title and description">Save</button>
          </div>
          <div id="savedmsg"></div>
          ${
            meta.hook?.suggestions.length
              ? `<div class="chips">${meta.hook.suggestions
                  .map((s) => `<button type="button" class="chip">${esc(s)}</button>`)
                  .join("")}</div>`
              : ""
          }

          <h2>Thumbnail</h2>
          <div id="variants"><div class="empty">loading&hellip;</div></div>

          <details class="fold"><summary>Splits</summary>
            <div id="splits"><div class="empty">loading&hellip;</div></div>
          </details>
          <details class="fold"><summary>Title &amp; description ${meta.titleEdited || meta.descriptionEdited ? '<span class="saved">(edited)</span>' : ""}</summary>
            <h2>Title ${meta.titleEdited ? '<span class="saved">(edited)</span>' : ""}</h2>
            <textarea id="title" rows="2">${esc(titleLine)}</textarea>
            <h2>Description ${meta.descriptionEdited ? '<span class="saved">(edited)</span>' : ""}</h2>
            <textarea id="description" rows="14">${esc(meta.description ?? "")}</textarea>
          </details>
        </section>
        <section class="panel" data-panel="publish">
          <h2 id="h-youtube">YouTube</h2>
          <div id="youtube"><div class="empty">loading&hellip;</div></div>

          <h2 id="h-publishkit">Publish kit</h2>
          <div id="publishkit"><div class="empty">loading&hellip;</div></div>

          <h2>Done by hand</h2>
          <div class="checklist" id="checklist"></div>
        </section>
      </div>
    </div>`;

  // The section bar: the group is the whole screen and the head above it is short, so a tap
  // lands at the top -- the hash scroll would put the head, and #headwarn with it, under the
  // back bar on the very panels that hold Upload and Adopt.
  $("#detail .jump").addEventListener("click", (ev) => {
    const a = ev.target.closest("a[data-panel]");
    if (!a) return;
    ev.preventDefault();
    showPanel(a.dataset.panel);
    window.scrollTo(0, 0);
  });
  showPanel(keepPanel ?? "check");

  $("#mhide") && wireHide($("#mhide"), id);
  $("#mdel") && wireDelete($("#mdel"), id);

  if (meta.hook) {
    $("#hook").addEventListener("input", () => {
      hookCounter(meta);
      // Typed is not saved: the upload and the Short read the title file, which Save writes.
      $("#savedmsg").textContent = "not saved \u2014 Upload sends the saved title";
      $("#savedmsg").className = "muted";
    });
    // A chip fills the field rather than committing anything: the suggestion is a starting
    // point to edit, which is the whole reason the hook is hand-written in the first place.
    $("#detail")
      .querySelectorAll(".chip")
      .forEach((chip) =>
        chip.addEventListener("click", () => {
          $("#hook").value = chip.textContent;
          // Through the same event a keystroke raises: the YouTube title and the publish kit
          // follow the field from that, and a chip that only set the value left both behind.
          $("#hook").dispatchEvent(new Event("input"));
          $("#hook").focus();
        }),
      );
    hookCounter(meta);
  }

  // Both live in the head for an unrendered match and in the Manage fold once it is rendered;
  // neither exists when the match has no directory on the shelf yet.
  $("#run")?.addEventListener("click", async () => {
    await api(`/api/render/${id}`, { method: "POST" });
    watch(id);
  });
  $("#stop")?.addEventListener("click", () => api(`/api/render/${id}`, { method: "DELETE" }));
  $("#failcopy").addEventListener("click", async () => {
    const ok = await copyText($("#failtext").textContent);
    $("#failcopy").textContent = ok ? "Copied" : "Blocked — select it by hand";
  });
  $("#save").addEventListener("click", async () => {
    // The hook field is where the headline is written, and Save is where it is committed: the
    // hook slot in the title's first line takes it here, so the file on disk — what the
    // checklist reads and what the Short's hook resolves from — carries the operator's line and
    // not the placeholder or the pipeline's own first suggestion.
    const hook = $("#hook")?.value.trim();
    // The box holds one line now, and the title it holds already carries the pipeline's own
    // hook far more often than the placeholder — so a clicked chip has to replace whichever of
    // the two is there. titleWithHook does both.
    $("#title").value = titleWithHook($("#title").value, hook, meta.hook?.generated);
    let saved;
    try {
      saved = await api(`/api/meta/${id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: [$("#title").value, ...titleRest].join("\n"),
          description: $("#description").value,
        }),
      });
    } catch (e) {
      $("#savedmsg").textContent = e.message;
      $("#savedmsg").className = "bad";
      return;
    }
    $("#savedmsg").textContent = "saved";
    $("#savedmsg").className = "saved";
    setTimeout(() => {
      if ($("#savedmsg")?.textContent === "saved") $("#savedmsg").textContent = "";
    }, 2000);
    // The panels that quote the title and description were painted from the meta this detail
    // opened with; after a save they would still show the old text until the match was reopened.
    // The PUT answers with the merged meta, so no follow-up GET.
    Object.assign(meta, saved);
    loadChecklist(id);
    loadYoutube(id, meta);
    loadPublishKit(id, meta);
  });

  loadChecklist(id);
  loadVariants(id);
  loadSplits(id, meta);
  loadPreview(id);
  loadSyncEdit(id);
  loadShort(id);
  loadYoutube(id, meta);
  loadPublishKit(id, meta);
  watch(id, true);
}

/**
 * The publish checklist, in the order the work actually happens. Uploading was manual while the
 * YouTube compliance audit was pending (cleared 15 Sept 2026), so this row is the only place that
 * knows whether a Studio-era match ever left the box. Pills that are facts read off disk are not clickable; the ones that
 * happen in Studio or in a DM are buttons.
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
          // "uploaded" changes the list's ready count.
          void refresh();
        } catch (err) {
          btn.disabled = false;
          // Where it was clicked, like every other failure on this page: a blocking alert() was
          // the only thing on the dashboard that had to be dismissed before reading anything.
          el.querySelector(".pillfail")?.remove();
          el.insertAdjacentHTML("beforeend", `<span class="pill bad pillfail">${esc(err.message)}</span>`);
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
 * The rendered pose variants, a column per configured pair: the plain render above its hooked
 * twin. Picking one copies it over thumbnail.png, which is the file that gets uploaded.
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

  // The headline the hooked twins were rendered with. Not visible in the shrunken previews once
  // it wraps, and it is the whole reason a re-render happens.

  const tile = (v) => {
    const fellBack = v.leftProvider === "nmsr" || v.rightProvider === "nmsr";
    const chosen = v.key === data.chosen;
    // The variant the render picked needs a button too, or the operator who looks at all
    // six and likes the default has no way to say so: the checklist pill means "chosen",
    // not "rendered" (chosenBy in src/matchShelf.ts), and PUT on the key already in use is
    // what stamps it. `chosenBy !== "auto"` mirrors the checklist exactly, so a manifest
    // from before the field still reads as chosen and asks for no second click.
    const confirmed = chosen && data.chosenBy !== "auto";
    return `
      <figure class="variant ${chosen ? "chosen" : ""}" data-key="${esc(v.key)}">
        <img src="/api/thumbnail/${id}?v=${encodeURIComponent(v.key)}" alt="${esc(v.key)}" loading="lazy">
        <figcaption>
          <span class="key">${esc(v.leftPose)} / ${esc(v.rightPose)}${v.hook ? " · with hook" : ""}</span>
          ${fellBack ? '<span class="fallback" title="This pose name has no camera, so it is the default NMSR view -- not the pose it is named after">static fallback</span>' : ""}
          ${confirmed ? '<span class="is-chosen">in use</span>' : `<button type="button" class="use">${chosen ? "Keep this" : "Use this"}</button>`}
        </figcaption>
      </figure>`;
  };

  // One column per pose pair, in manifest order. The hooked twins a match rendered before
  // 18 Sept 2026 still has on disk are not offered: the text came off the thumbnails.
  const columns = new Map();
  for (const v of data.variants.filter((v) => !v.hook)) {
    const pair = `${v.leftPose}-${v.rightPose}`;
    columns.set(pair, [...(columns.get(pair) ?? []), v]);
  }

  el.innerHTML = `<div class="strip">${[...columns.values()]
    .map((column) => `<div class="poses">${column.map(tile).join("")}</div>`)
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
    if (selected === id) el.innerHTML = `<div class="scanline bad">${esc(e.message)}</div>`;
    return;
  }
  // The operator may have opened another match while this was in flight; a late reply must not
  // paint its bar into that match's panel, nor close its live export stream via watchExport.
  if (selected !== id) return;
  // The one-pass encode the nightly runs, on demand. ~10 minutes on the lab, so the button
  // hands over to a bar fed by the same progress stream the nightly's encode writes to. Offered
  // on an exported match too: a sync fixed by hand needs exactly this re-run, and "Save and
  // re-export" presses this button — which, for the exported case, used to not exist.
  const encode = (label, idle) => `
      <div class="row">
        <button id="encode" ${meta.running ? "disabled" : ""}>${label}</button>
        <span id="encodestate" class="muted">${meta.running ? "encoding…" : idle}</span>
      </div>
      <div class="bar exportbar${meta.running ? "" : " hidden"}"><i style="width:${meta.percent ?? 0}%"></i></div>`;
  if (!meta.exported) {
    el.innerHTML = encode("Encode MP4 (~10 min)", "not exported yet");
  } else {
    const mb = (meta.bytes / 1048576).toFixed(0);
    el.innerHTML =
      `<video id="finalvideo" controls preload="metadata" playsinline
           src="/api/export/preview/${id}" poster="/api/thumbnail/${id}"></video>
    <div class="previewmeta">
      <span>${esc(meta.name)}</span>
      <span>${mb} MB</span>
      <a href="/api/export/final/${id}" download>Download</a>
      <a href="/api/export/bundle/${id}" download>Bundle (.tar)</a>
    </div>` + encode("Re-encode MP4 (~10 min)", "");
  }
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
}

/** Follows one encode to its end, then swaps the bar for the player. The stream replays what
    the encode has said so far, so a phone that comes back late is not blind. */
function watchExport(id) {
  if (exportStream) exportStream.close();
  const src = new EventSource(`/api/export/progress/${id}`);
  exportStream = src;
  const state = () => $("#encodestate");
  src.onmessage = (e) => {
    // The operator may have opened another match meanwhile; this stream's bar and player belong
    // to the one it was started for, and must not be painted into whatever is on screen now.
    if (selected !== id) {
      src.close();
      if (exportStream === src) exportStream = null;
      return;
    }
    const ev = JSON.parse(e.data);
    const bar = document.querySelector(".exportbar > i");
    if (ev.percent !== undefined && bar) {
      bar.style.width = ev.percent + "%";
      if (state()) state().textContent = `encoding… ${ev.percent}%`;
    }
    if (ev.done) {
      src.close();
      if (exportStream === src) exportStream = null;
      if (ev.error) {
        if (state()) {
          state().textContent = ev.error;
          state().className = "bad";
        }
        const btn = $("#encode");
        if (btn) btn.disabled = false;
      } else {
        loadPreview(id);
        // A fresh export is not stale: the sync check and the Upload button read that from here.
        void loadSyncEdit(id);
        // The Short panel's seek controls only render once the final video exists.
        void loadShort(id);
        // The list's "ready to publish" badge and count read the same file.
        void refresh();
      }
    }
  };
  src.onerror = () => {
    src.close();
    if (exportStream === src) exportStream = null;
  };
}

/**
 * Fills the upload form's "Publish at" with the kit's slot, if the field is empty. Called from
 * both sides of a race: the kit (which knows the slot) and the YouTube panel (which owns the
 * field) render independently, and whichever finishes second gets to do it.
 */
function prefillPublishAt() {
  const when = $("#ytWhen");
  if (!publishSlotAt || !when || when.value) return;
  const pad = (n) => String(n).padStart(2, "0");
  const s = publishSlotAt;
  when.value = `${s.getFullYear()}-${pad(s.getMonth() + 1)}-${pad(s.getDate())}T${pad(s.getHours())}:${pad(s.getMinutes())}`;
}

/** m:ss, for moment boundaries measured from the start of the run. */
/**
 * Every paste a manual publish needs, in the order it gets used.
 *
 * Uploading was manual while the YouTube compliance audit was pending, and two parts of it stay
 * manual now it has cleared: a Short's Related Video link has no API, and telling the two players their
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
  // to be on the channel, and one line of "say so" is cheaper than a strike. No ask to share.
  const dm = (who, opponent) =>
    `hi ${who}, your ranked match vs ${opponent} is up on MCSR Replayoffs, both streams side by side with the split timer: ${url}\nif youd rather it wasnt up say so and ill take it down`;

  // The YouTube panel's field is the one an operator may have edited by hand, so it wins while
  // it is on the page; otherwise the generated first line with the hook substituted in. Never
  // the whole file: the lines under it are guidance for the terminal (src/title.ts).
  const titleText = () => {
    const field = $("#ytTitle");
    if (field) return field.value;
    const firstLine = (meta.title ?? "").split("\n")[0] ?? "";
    return titleWithHook(firstLine, $("#hook")?.value.trim(), meta.hook?.generated);
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
  publishSlotAt = slot;
  prefillPublishAt();

  // Getting the files onto the PC that publishes, which is step zero of the Studio phase and the
  // only part of this panel that is a command rather than a paste. Pull, not push
  // (src/publishSet.ts). Absent unless `pullSource` is configured.
  // The per-match line is the morning's; the other two are pasted once and then never again,
  // so they fold away rather than push the title down the page every day.
  const pull = kit.pull
    ? `${block("Pull this match to your PC", kit.pull.one, 3)}
      <details class="kitmore">
        <summary>everything ready at once, or every 10 minutes</summary>
        ${block("Pull everything ready, once", kit.pull.all, 3)}
        ${block("…or every 10 minutes (crontab -e)", kit.pull.cron, 3)}
      </details>`
    : "";

  const paint = () => {
    const title = titleText();
    const tags = (meta.tags ?? []).join(", ");
    el.innerHTML = [
      pull,
      block(
        "Title",
        title,
        2,
        counter(
          title.includes("<HOOK>") ? "pick a hook first" : `${title.length} / 100 chars`,
          title.length > 100 || title.includes("<HOOK>"),
        ),
      ),
      slot ? block("Publish at", slotText, 1) : "",
      // Pasted once each, into Studio, after the title: folded so the morning's three blocks stay
      // above the fold on a phone.
      `<details class="kitmore more"${el.querySelector("details.more")?.open ? " open" : ""}>
         <summary>description &middot; tags</summary>`,
      // A server one restart behind still writes "Result: X 9:47." into the file (removed in
      // 10f584a); what gets pasted into Studio must never say who won, whichever build wrote it.
      block("Description", (meta.description ?? "").replace(/ Result: [^.\n]*\./, ""), 10),
      // Both numbers, because YouTube caps the list twice over: 500 characters across the whole
      // field, and the count is what tells you the pipeline wrote a tags file at all.
      block(
        "Tags",
        tags,
        3,
        counter(`${meta.tags?.length ?? 0} tags · ${tags.length} / 500 chars`, tags.length > 500),
      ),
      `</details>`,
      // Everything below is pasted after the video is up, so it folds away: at 390px the kit was
      // eleven copy blocks tall and the title — the first thing pasted — was the only one above
      // the fold that mattered. The Copy handler is delegated from the panel, so it reaches in.
      // Once the video is on the channel this half is the morning, so the fold opens itself.
      `<details class="kitmore after"${(el.querySelector("details.after")?.open ?? !!kit.videoUrl) ? " open" : ""}>
         <summary>after the upload &mdash; Short, pinned comment, community post, DMs</summary>`,
      kit.shortTitle
        ? block("Short title", kit.shortTitle, 2)
        : `<div class="kit"><div class="kithead"><span class="kitlabel">Short title</span></div>
             <div class="empty">no Short title yet</div></div>`,
      kit.shortDescription ? block("Short description", kit.shortDescription, 4) : "",
      // A first comment to pin: what the video is and where to report a sync slip, in the
      // operator's voice. The server's line wins; the fallback is the same text for a server one
      // restart behind (src/youtubeStore.ts).
      block(
        "Pinned comment",
        kit.pinnedComment ??
          "both povs are the players own streams, synced on the countdown. if the timer looks off anywhere drop the timestamp here and ill fix it",
        3,
      ),
      // The Community tab is open to every channel now, and a post per upload is the cheapest
      // reach a 41-subscriber channel has: the title, one line on what it is, the link.
      block(
        "Community post",
        `new video: ${title}\nboth streams side by side with the split timer in the middle\n${url}`,
        3,
        // The same flag as the Title block: this quotes the title, so it carries the same hole.
        title.includes("<HOOK>") ? counter("pick a hook first", true) : "",
      ),
      block(`Message to ${left ?? "left player"}`, dm(left ?? "there", right ?? "your opponent"), 3),
      block(`Message to ${right ?? "right player"}`, dm(right ?? "there", left ?? "your opponent"), 3),
      `</details>`,
    ].join("");
  };
  paint();

  el.addEventListener("click", async (ev) => {
    const btn = ev.target.closest("button.copy");
    if (!btn) return;
    const ok = await copyText(btn.closest(".kit").querySelector("textarea").value);
    btn.textContent = ok ? "copied" : "blocked";
    setTimeout(() => (btn.textContent = "Copy"), 1500);
  });

  // The hook is typed after this panel paints, and the YouTube panel rewrites #ytTitle from the
  // same event. Deferring a tick means this reads that field after it has been rewritten,
  // whichever of the two panels happened to register its listener first.
  $("#hook")?.addEventListener("input", () => setTimeout(paint, 0));
}

/** The maintenance fold at the bottom of After: Re-run (for a rendered match -- it is the head's
    primary button until then), Hide and Delete, and the output paths. The row has Hide/Delete on
    a desktop; on a phone the row is one tap target and carries nothing destructive (panels.css),
    so this is where they live. */
function manageHtml(id, runButtons, outputs) {
  const m = matches.find((x) => x.matchId === id);
  if (!m) return "";
  return `
    <details class="fold manage-fold"><summary>Manage</summary>
      <div class="manage">
        ${runButtons}
        <button type="button" class="ghost" id="mhide">${m.hidden ? "Unhide" : "Hide"}</button>
        <button type="button" class="ghost" id="mdel" data-armed="0">Delete</button>
        <span class="muted">${m.archived ? "archived on the NAS" : "no archived copy"}</span>
      </div>
      ${outputsHtml(outputs, id)}
    </details>`;
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
 * top-ranked suggestion, and only then the per-row one.
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
    ${
      // Operator-only: `why` is the model's unfiltered text and may name who finished. It is
      // never published — keep it off the publish kit, the title and the description.
      data.reasoner?.applied || data.reasoner?.why
        ? `<div class="previewmeta"><span>reasoner: ${esc(data.reasoner.why || "(no reason given)")}</span></div>`
        : ""
    }
    <div class="moments">${data.moments
      .map(
        (m) => `
      <div class="moment" data-pick="${m.index}">
        <span class="when">${runClock(m.startMs)}&ndash;${runClock(m.endMs)}${
          data.finalVideo
            ? `<button type="button" class="seek" title="play this window in the final video">&#9654; ${runClock(data.finalOffsetSec * 1000 + m.startMs)}</button>`
            : ""
        }</span>
        <span class="why">${esc(m.reason)}</span>
        <span class="hook">&ldquo;${esc(m.hook)}&rdquo;</span>
        <button type="button" class="cut">Cut this</button>
      </div>`,
      )
      .join("")}</div>
    ${
      // Only with a video to read a position from: without one there is nothing to be "here".
      data.finalVideo
        ? `<button type="button" id="cuthere" class="ghost" title="Cut a Short starting where the final video is paused">Cut from where I am watching</button>`
        : ""
    }
    <pre id="shortlog" class="hidden"></pre>`;

  // A thumbnail re-rendered with a new headline leaves the Short burned with the old one — the
  // two halves of a match then disagree, which is the one thing the shared hook exists to
  // prevent. `hook` is what a cut would use now; `title` is what the last cut wrote.
  if (data.rendered && data.title && data.hook && !data.title.startsWith(data.hook)) {
    const burned = data.title.replace(/\s*#minecraft #mcsr$/, "");
    el.insertAdjacentHTML(
      "afterbegin",
      `<div class="scanline bad">The Short still says &ldquo;${esc(burned)}&rdquo;; the thumbnail now says &ldquo;${esc(data.hook)}&rdquo; &middot; <a href="#" data-act="recut">re-cut it</a></div>`,
    );
    el.querySelector('[data-act="recut"]')?.addEventListener("click", (ev) => {
      ev.preventDefault();
      el.querySelector(".moment .cut")?.click();
    });
  }

  // What a cut would actually contain, before pressing "Cut this": the final video seeks to the
  // window and stops at its end, so exactly the Short's 22 s play. The player sits above the
  // Short panel, off-screen on a phone, hence the scroll.
  for (const btn of el.querySelectorAll(".moment .seek")) {
    btn.addEventListener("click", () => {
      const v = $("#finalvideo");
      if (!v) return;
      const m = data.moments[Number(btn.closest(".moment").dataset.pick)];
      const end = data.finalOffsetSec + m.endMs / 1000;
      const stopAtEnd = () => {
        if (v.currentTime < end) return;
        v.pause();
        v.removeEventListener("timeupdate", stopAtEnd);
      };
      // One window at a time: a previous click's listener still waiting for its own end would
      // pause this window at the wrong second (the player outlives this panel's re-renders,
      // so the handler lives on the element, not in this closure).
      if (v.stopAtEnd) v.removeEventListener("timeupdate", v.stopAtEnd);
      v.stopAtEnd = stopAtEnd;
      v.currentTime = data.finalOffsetSec + m.startMs / 1000;
      v.addEventListener("timeupdate", stopAtEnd);
      $("#h-preview").scrollIntoView({ behavior: "smooth" });
      v.play()?.catch(() => {});
    });
  }

  // The Short's title is typed into Studio by hand, and retyping a line the render already
  // wrote is how a hook picks up a typo the burned-in one doesn't have.
  const copyTitle = $("#shorttitlecopy");
  if (copyTitle) {
    copyTitle.addEventListener("click", async () => {
      // Reporting the attempt rather than the outcome is how this said "Copied" on every machine
      // that cannot copy. Select the text yourself when it says blocked.
      copyTitle.textContent = (await copyText(data.title)) ? "Copied" : "Blocked";
      setTimeout(() => (copyTitle.textContent = "Copy title"), 1500);
    });
  }

  // One path for both ways of asking: a ranked row by index, or a window the operator picked by
  // watching. The server takes `at` over `pick` when both could apply.
  const startCut = async (body) => {
    el.querySelectorAll(".cut, .cuthere").forEach((b) => (b.disabled = true));
    const log = $("#shortlog");
    log.classList.remove("hidden");
    log.textContent = "starting\n";
    await api(`/api/shorts/render/${id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
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
  };

  el.querySelectorAll(".moment .cut").forEach((btn) =>
    btn.addEventListener("click", () => startCut({ pick: Number(btn.closest(".moment").dataset.pick) })),
  );

  // Cut from where you are watching. The seek buttons above let you see a window; this is the
  // other half — none of the five ranked windows has to be the one you want, and the player's
  // position is already the answer. Final-video seconds minus the anchor is match time.
  $("#cuthere")?.addEventListener("click", () => {
    const v = $("#finalvideo");
    if (!v) return;
    const atMs = Math.max(0, Math.round((v.currentTime - data.finalOffsetSec) * 1000));
    startCut({ at: atMs });
  });
}

/**
 * Where the run put things. The TUI's success summary lists all of these; the dashboard listed
 * none, so the one file you actually open by hand — the Kdenlive project — had no visible path.
 * These are container-side paths, hence text rather than links — except the project, which the
 * server serves (GET /api/export/project/:id) and the rsync publish set leaves out, so on the
 * PC that opens Kdenlive the path alone was useless.
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

/**
 * Where the two POVs were placed, and how sure the detector was.
 *
 * Worth a line because a half-synced match is invisible otherwise: when the countdown freeze is
 * found for one player and not the other, the found side is corrected and the other keeps the
 * coarse estimate, so the POVs can sit seconds apart in a video that looks ready to publish.
 * Silent on a clean sync — the only interesting states are "partly" and "not at all".
 */
/* --- Manual sync -------------------------------------------------------------------------------
   The detector reads the countdown off the picture and says how sure it is; when it is not sure
   there is nothing more to compute, and a person reading two digits settles it in seconds. Both
   POVs freeze through the same 10-second countdown, so a frame from each at the SAME point on the
   finished timeline has to show the same number. That is the whole instrument: two frames, four
   nudges, save, re-export. */
let syncEditState = null;

async function loadSyncEdit(id) {
  const el = $("#syncedit");
  if (!el) return;
  try {
    const d = await api(`/api/sync/${id}`);
    syncEditState = {
      id,
      t: 5,
      left: d.sync ? d.sync.left : d.fallback,
      right: d.sync ? d.sync.right : d.fallback,
      data: d,
    };
  } catch (e) {
    el.innerHTML = `<summary>Fix the sync by hand</summary><div class="scanline bad">${esc(e.message)}</div>`;
    return;
  }
  paintSyncEdit();
  paintSyncCheck();
}

function syncFrameUrl(side, t = syncEditState.t, offset = null) {
  const s = syncEditState;
  if (offset === null) offset = side === "left" ? s.left : s.right;
  // `v` busts the browser cache: the same match, side and t answer differently once nudged.
  return `/api/sync/frame?match=${s.id}&side=${side}&t=${t}&offset=${offset}&v=${offset}`;
}

/* --- Sync check ----------------------------------------------------------------------------------
   The mandatory look before an upload. Two videos reached the channel out of sync; one of them
   because the offsets were corrected by hand after the MP4 was exported and nobody re-exported.
   So, whenever an export exists: the last countdown digit out of each POV at the offsets on disk,
   side by side above the YouTube panel, and a red line — plus a disabled Upload button — when
   sync.json is newer than the export. Painted from the same answer the editor uses. */
const SYNC_CHECK_SEC = 9.6;

function paintSyncCheck() {
  const el = $("#synccheck");
  const s = syncEditState;
  if (!el || !s) return;
  const d = s.data;
  if (!d.exported) {
    el.innerHTML = "";
    guardUpload();
    return;
  }
  // What is on disk, not the editor's unsaved nudges: this is what the export was — or was
  // not — made from.
  const offset = (side) => (d.sync ? d.sync[side] : d.fallback);
  const side = (name, nickname) => `
    <div class="syncside">
      <div class="who">${esc(nickname ?? name)}</div>
      <img src="${esc(syncFrameUrl(name, SYNC_CHECK_SEC, offset(name)))}" alt="${esc(nickname ?? name)} at ${SYNC_CHECK_SEC}s" loading="lazy">
    </div>`;
  el.innerHTML = `<h2>Sync check</h2>
    ${
      d.left.clip && d.right.clip
        ? `<div class="syncsides">${side("left", d.left.nickname)}${side("right", d.right.nickname)}</div>`
        : '<div class="scanline">The POV clips are not on disk any more, so there is nothing to compare.</div>'
    }
    <div class="scanline">Both should show the same countdown digit. If they do not, <a href="#syncedit" data-act="fixsync">fix the sync</a> below and re-export before uploading.</div>
    ${d.syncStale ? `<div class="scanline bad" id="syncstale">${esc(d.staleMessage)}</div>` : ""}`;
  el.querySelector('[data-act="fixsync"]')?.addEventListener("click", () => {
    const fold = $("#syncedit");
    if (fold) fold.open = true;
  });
  // The same line in the head, above the groups: Package, Publish and After hide the Check group
  // on a phone, and this is the one warning that must survive the switch.
  const head = $("#headwarn");
  if (head) {
    head.querySelector(".stale")?.remove();
    if (d.syncStale)
      head.insertAdjacentHTML("beforeend", `<div class="scanline bad stale">${esc(d.staleMessage)}</div>`);
  }
  guardUpload();
}

/**
 * The Upload button, held while the export is stale — with the server's own refusal under it,
 * so a press that would 400 is explained before it is made. Called from both sides of a race:
 * the YouTube panel (which owns the button) and the sync check (which knows the answer) render
 * independently, and whichever finishes second gets to do it.
 */
function guardUpload() {
  const btn = $("#ytUpload");
  const d = syncEditState?.data;
  if (!btn || !d || d.matchId !== selected) return;
  clearFailAt("#ytUpload");
  btn.disabled = !!d.syncStale;
  if (d.syncStale) failAt("#ytUpload", "Sync changed after this export", d.staleMessage);
}

function paintSyncEdit() {
  const el = $("#syncedit");
  const s = syncEditState;
  if (!el || !s) return;
  const d = s.data;
  const open = el.open;
  if (!d.left.clip || !d.right.clip) {
    el.innerHTML = `<summary>Fix the sync by hand</summary>
      <div class="scanline">The POV clips are not on disk any more, so there is nothing to compare. Re-run the pipeline to fetch them, if the VODs have not expired.</div>`;
    el.open = open;
    return;
  }
  const side = (name, nickname) => `
    <div class="syncside">
      <div class="who">${esc(nickname ?? name)}</div>
      <img src="${esc(syncFrameUrl(name))}" alt="${esc(nickname ?? name)} at ${s.t}s" loading="lazy">
      <div class="row">
        <button data-nudge="${name}:-1">-1s</button>
        <button data-nudge="${name}:-0.1">-0.1</button>
        <input type="number" step="0.1" data-off="${name}" value="${(name === "left" ? s.left : s.right).toFixed(2)}">
        <button data-nudge="${name}:0.1">+0.1</button>
        <button data-nudge="${name}:1">+1s</button>
      </div>
    </div>`;
  el.innerHTML = `<summary>Fix the sync by hand</summary>
    <div class="scanline">
      Both players freeze through the countdown, so at the same moment of the finished video the
      two frames below must show <strong>the same number</strong>. Nudge until they do, save, then
      re-export &mdash; the overlay does not need re-rendering, only the clip placement changes.
    </div>
    <div class="row">
      <label>Finished-video second
        <input type="number" id="synct" min="0" max="10" step="1" value="${s.t}">
      </label>
      <span class="muted">match start is at ${d.anchorSec}s, so 0&ndash;${d.anchorSec} is the countdown</span>
    </div>
    <div class="syncsides">${side("left", d.left.nickname)}${side("right", d.right.nickname)}</div>
    <div class="row">
      <button id="syncsave">Save these offsets</button>
      <button id="syncexport" class="ghost">Save and re-export</button>
      <span class="msg" id="syncmsg">${d.sync ? esc(`now: ${d.sync.left}s / ${d.sync.right}s, ${d.sync.source}`) : "no sync.json yet"}</span>
    </div>`;
  el.open = open;
  el.querySelectorAll("[data-nudge]").forEach((b) =>
    b.addEventListener("click", () => {
      const [which, by] = b.dataset.nudge.split(":");
      const next = Math.max(0, (which === "left" ? s.left : s.right) + Number(by));
      if (which === "left") s.left = next;
      else s.right = next;
      paintSyncEdit();
    }),
  );
  el.querySelectorAll("[data-off]").forEach((i) =>
    i.addEventListener("change", () => {
      const v = Number(i.value);
      if (!Number.isFinite(v) || v < 0) return;
      if (i.dataset.off === "left") s.left = v;
      else s.right = v;
      paintSyncEdit();
    }),
  );
  $("#synct").addEventListener("change", () => {
    const v = Number($("#synct").value);
    if (Number.isFinite(v) && v >= 0) s.t = v;
    paintSyncEdit();
  });
  $("#syncsave").addEventListener("click", () => saveSync(false));
  $("#syncexport").addEventListener("click", () => saveSync(true));
}

async function saveSync(thenExport) {
  const s = syncEditState;
  const msg = $("#syncmsg");
  clearFailAt("#syncsave");
  msg.textContent = "saving…";
  try {
    const r = await api(`/api/sync/${s.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ left: s.left, right: s.right }),
    });
    // The PUT answers with the GET's shape: the save is what just made the export stale, and the
    // sync check and the Upload button follow it from here.
    s.data = r;
    paintSyncEdit();
    paintSyncCheck();
    $("#syncmsg").textContent = `saved ${r.sync.left}s / ${r.sync.right}s`;
    // The Encode button is the same call; press it rather than keep a second copy of the flow.
    // It sits in the Final video panel above this fold, so say here that it was pressed.
    if (thenExport) {
      const btn = $("#encode");
      if (btn && !btn.disabled) {
        btn.click();
        $("#syncmsg").textContent += " · re-encoding, ~10 min (Final video above)";
      } else {
        $("#syncmsg").textContent += btn
          ? " · an encode is already running"
          : " · open Final video to encode";
      }
    }
  } catch (e) {
    msg.textContent = "";
    failAt("#syncsave", "Sync not saved", e.message);
  }
}

/**
 * Copy text, on an origin that has no Clipboard API.
 *
 * `navigator.clipboard` exists only in a secure context — https, or localhost. The dashboard is
 * served over plain http from the lab, so on every machine except the lab's own browser it is
 * undefined, and `navigator.clipboard?.writeText(...)` short-circuits to nothing: the publish
 * kit's Copy buttons did nothing at all, and the Short's said "Copied" while copying nothing.
 * `document.execCommand("copy")` is deprecated but works on an insecure origin, which is exactly
 * where it is needed. Returns whether the text actually got there — never claim it did otherwise.
 */
async function copyText(text) {
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Denied permission or a detached document: fall through to the old way rather than give up.
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    // Off-screen but not display:none, which would make it unselectable.
    ta.style.cssText = "position:fixed;top:-1000px;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

function syncLine(meta) {
  const s = meta.sync;
  if (!s) return "";
  const drift = Math.abs(s.left - s.right);
  const weak = s.confidence < (meta.syncThreshold ?? 0.15);
  if (!weak && drift < 0.5) return "";
  const why = weak
    ? "the estimate was kept — verify the alignment before publishing"
    : `the two POVs sit ${drift.toFixed(1)}s apart`;
  return `<div class="scanline bad" title="${esc(s.detail ?? "")}">sync ${Math.round(
    s.confidence * 100,
  )}% &middot; ${esc(why)}</div>`;
}

function outputsHtml(outputs, id) {
  if (!outputs) return '<div class="empty">nothing written yet</div>';
  return `<div class="outputs">${Object.entries(OUTPUT_LABELS)
    .map(([key, label]) => {
      // The project is the one output you take somewhere else, so its path is its download.
      const value = !outputs[key]
        ? "&mdash;"
        : key === "project"
          ? `<a href="/api/export/project/${id}" download>${esc(outputs[key])}</a>`
          : esc(outputs[key]);
      return `<div><span class="k">${label}</span><span class="v${outputs[key] ? "" : " missing"}">${value}</span></div>`;
    })
    .join("")}</div>`;
}

function showFailure(title, text) {
  const box = $("#failure");
  if (!box) return;
  $("#failtitle").textContent = title;
  $("#failtext").textContent = text;
  box.classList.add("live");
}

/* --- Failures, where they happened -------------------------------------------------------------
   #failure sits near the top of the match pane, above the hook, the title editor, the preview, the
   sync editor, the publish kit, the Short and the YouTube panel. A press at the bottom of that
   column reported itself a screen and a half away, often off-view entirely: the button went quiet
   and the reason was somewhere you had to go looking for. The panels.css note about the undo line
   being sticky rather than "1,200px up at the top of the panel" is the same complaint.

   So a failure reports next to the control that caused it. The banner is kept for the two that
   have no control -- a stage or pipeline error arriving over SSE -- and as the fallback when the
   anchor has been repainted away, because a message in the wrong place still beats none. */

/** The element an inline failure hangs under: the control's own row, else the control itself. */
function failHost(anchor) {
  const el = typeof anchor === "string" ? $(anchor) : anchor;
  return el ? (el.closest(".row, .setrow, .syncside, .kit, .comment") ?? el) : null;
}

/** Removes the inline failure under `anchor`, if there is one. */
function clearFailAt(anchor) {
  const next = failHost(anchor)?.nextElementSibling;
  if (next?.classList.contains("inlinefail")) next.remove();
}

/**
 * Reports `title`/`text` immediately under the control named by `anchor`.
 *
 * Falls back to the top banner when the anchor is not on the page -- several of these fire after
 * the panel has been repainted, and a failure that lands nowhere is the bug being fixed.
 */
function failAt(anchor, title, text) {
  const host = failHost(anchor);
  if (!host) {
    showFailure(title, text);
    return;
  }
  clearFailAt(anchor);
  const box = document.createElement("div");
  box.className = "inlinefail";
  box.innerHTML = `<div class="head"><span></span><button type="button" class="ghost dismiss">dismiss</button></div><pre></pre>`;
  // textContent, not innerHTML: this is server text and an API error can carry anything.
  box.querySelector(".head span").textContent = title;
  box.querySelector("pre").textContent = text;
  box.querySelector(".dismiss").addEventListener("click", () => box.remove());
  host.after(box);
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

/** Stop exists only while a run does: a permanently disabled button is furniture on every card. */
function armStop(on) {
  const btn = $("#stop");
  if (!btn) return;
  btn.hidden = !on;
  // A rendered match keeps Stop in the Manage fold; a run that is on must be stoppable without
  // hunting for it.
  if (on) btn.closest("details")?.setAttribute("open", "");
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
   The whole of the scheduler's UI: what it will pick tonight, what the last run did, and a
   button that stops you waiting for 03:00 UTC to find out.

   A static element under the header (index.html), on every screen: its warnings -- a failed run,
   a server one restart behind -- are the first thing the morning reads. Those are direct children
   with the `bad` class, which is what lets the phone match screen keep exactly them (panels.css).
   The payload is cached so a repaint costs no request. */

let nightly = null;

/** "16h ago" — coarse on purpose: the question is thirty minutes or three days, not the minute. */
function ago(t) {
  const m = Math.max(0, Math.round((Date.now() - new Date(t).getTime()) / 60000));
  return m < 60 ? `${m}m ago` : m < 2880 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
}

/** 1-based position of a match in tonight's queue, or 0. */
const queued = (id) => (nightly?.queue ?? []).findIndex((q) => q.matchId === id) + 1;

/** The whole list, then the strip and the cards repaint from the server's answer. */
async function putQueue(ids) {
  const out = await api("/api/nightly/queue", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ queue: ids }),
  });
  // Names come with the next /api/nightly; until then keep the ones already known.
  const known = new Map((nightly?.queue ?? []).map((q) => [q.matchId, q.players]));
  nightly = {
    ...nightly,
    queue: out.queue.map((matchId) => ({ matchId, players: known.get(matchId) ?? null })),
  };
  paintNightly();
  void loadNightly();
}

function queueHtml() {
  const q = nightly?.queue ?? [];
  if (!q.length) return "";
  return `<ol class="queue">${q
    .map(
      (e, i) => `<li data-id="${e.matchId}">
        <span>${e.players ? esc(`${e.players[0]} vs ${e.players[1]}`) : `#${e.matchId} <span class="muted">(not on the list any more)</span>`}</span>
        ${i > 0 ? `<a href="#" data-act="queue-up" title="earlier">&uarr;</a>` : ""}
        <a href="#" data-act="queue-drop" title="remove">&times;</a>
      </li>`,
    )
    .join("")}</ol>`;
}

function nightlyInner() {
  if (!nightly) return '<div class="lines"><span class="muted">nightly&hellip;</span></div>';
  if (nightly.stale) {
    return `<div class="bad">The server is running older code than this page &middot; <code>docker restart mcsr-dashboard</code> on the lab enables the nightly render and the newer panels.</div>`;
  }
  if (nightly.error) return `<div class="bad">${esc(nightly.error)}</div>`;
  // One restart behind is invisible otherwise: the page is served from disk and looks current,
  // the server still writes yesterday's descriptions and hooks.
  const { boot, now } = nightly.code ?? {};
  const behind =
    boot && now && boot !== now
      ? `<div class="bad">The server is running <code>${esc(boot)}</code>; the repo is at <code>${esc(now)}</code> &middot; <code>docker restart mcsr-dashboard</code> picks it up.</div>`
      : "";

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
      ? `${esc(at)} &middot; will render <b>${esc(candidate.players[0])} vs ${esc(candidate.players[1])}</b>${queued(candidate.matchId) ? " (queued)" : ""}`
      : `${esc(at)} &middot; <span class="muted">nothing eligible</span>`;

  // "Last run", not "last night": the Run now button records here too, and a label that lied
  // about when it happened would be worse than a slightly duller one.
  let last = '<span class="muted">Last run: never</span>';
  // With its age in the line: "done" from last night and "done" from a week ago looked the same.
  const lastLabel = lastRun ? `Last run ${ago(lastRun.startedAt)}:` : "Last run:";
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
    // "started" with no later record is a render the server did not live to finish.
    const said = lastRun.outcome === "started" ? "started, not finished" : lastRun.outcome;
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
    last = `${lastLabel} ${who}<span class="${cls}">${esc(said + why)}</span>${short}${exported}`;
  }

  const failed = nightly.runError ? `<div class="bad">Run now failed: ${esc(nightly.runError)}</div>` : "";
  return `${behind}${failed}<div class="lines">
      <div class="plan" title="${esc(nextRunAt ?? "no schedule")}">${plan}</div>
      <div class="last" title="${esc(lastRun ? lastRun.startedAt : "")}">${last}</div>
      ${queueHtml()}
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
  el.querySelectorAll('[data-act="queue-up"], [data-act="queue-drop"]').forEach((a) =>
    a.addEventListener("click", async (ev) => {
      ev.preventDefault();
      const id = Number(a.closest("li").dataset.id);
      const ids = (nightly?.queue ?? []).map((q) => q.matchId);
      const i = ids.indexOf(id);
      if (a.dataset.act === "queue-drop") ids.splice(i, 1);
      else if (i > 0) [ids[i - 1], ids[i]] = [ids[i], ids[i - 1]];
      try {
        await putQueue(ids);
      } catch (e) {
        $("#entryerr").textContent = `queue: ${e.message}`;
        return;
      }
      // The cards' Queue buttons carry the position.
      if (suggestData) renderSuggestions(suggestData);
    }),
  );
}

async function loadNightly() {
  const before = JSON.stringify((nightly?.queue ?? []).map((q) => q.matchId));
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
  // The cards' Queue buttons carry the position, so they repaint when the queue is news to them.
  if (suggestData && JSON.stringify((nightly?.queue ?? []).map((q) => q.matchId)) !== before)
    renderSuggestions(suggestData);
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
    // The strip stays — plan, last run, and the button to try again — with the failure on its
    // own line. Replacing the whole strip with the error also removed the only way to retry.
    await loadNightly();
    if (nightly) nightly.runError = e.message;
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
  if (data.rivalHandle) rivalHandle = data.rivalHandle;
  suggestData = data;
  const el = $("#suggestions");
  $("#tab-suggestions small").textContent = data.suggestions.length ? String(data.suggestions.length) : "";
  updateBackLabel();

  // A failed scan keeps whatever list it had: a stale suggestion is still a renderable match.
  // Settled, the line says what was scanned and offers a rescan — the list refreshes itself
  // every suggestCacheTtlMin, and until now there was no way to ask sooner from the browser.
  const scan = data.scanning
    ? `<div class="scanline">scanning&hellip; ${data.scanned} matches, ${data.candidates} with two VODs</div>`
    : data.error
      ? `<div class="scanline bad">${data.scannedAtMs ? `list from ${ago(data.scannedAtMs)} &middot; ` : ""}scan failed: ${esc(data.error)} &middot; <a href="#" data-act="rescan">try again</a></div>`
      : // How old the list is, in the line: at 22:00 the question is whether this is tonight's
        // feed or last week's, and the answer was only in a tooltip. The server scans at boot and
        // on this link, nothing else, so the age is worth reading.
        `<div class="scanline">scanned ${data.scannedAtMs ? ago(data.scannedAtMs) : "earlier"}${data.stats ? ` &middot; ${data.stats.matchesScanned} matches, ${data.stats.candidates} with two VODs` : ""}${data.note ? ` &middot; ${esc(data.note)}` : ""} &middot; <a href="#" data-act="rescan" title="Scan everything again now (~340 MCSR API calls). New matches are picked up on their own every ${data.ttlMin ?? 30} minutes.">rescan</a></div>`;

  // Undo line, above the cards, until it is used or the next dismiss replaces it.
  const undo = lastDismissed
    ? `<div class="scanline undo">Dismissed <b>${esc(lastDismissed.who)}</b> &middot; <a href="#" data-act="undo">undo</a>${lastDismissed.note ? ` <span class="muted">${esc(lastDismissed.note)}</span>` : ""}</div>`
    : "";

  const cards = !data.suggestions.length
    ? `<div class="empty">${data.scanning ? "" : "Nothing suggested yet."}</div>`
    : data.suggestions
        .map((s) => {
          // Rendered since the list was scored — by the nightly, or a click: the card stays, since
          // the list is the operator's reading order, but its verb changes. Pressing render on a
          // finished match was the morning's easiest mistake. The full chain is the only
          // button: it is what the nightly does, and a finished MP4 is what "render" means to
          // the operator; "Render only" -- the Kdenlive round-trip's first half -- is a link in
          // the row of links, where it is found when wanted and not weighed when not.
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
        <div class="facts">${esc(s.facts)} &middot; <span class="expiry${s.expiring ? " warn" : ""}">${esc(s.expiryLabel)}</span></div>
        ${s.rivalPosted ? `<div class="rival" title="${esc(s.rivalPosted.title)}">@${esc(data.rivalHandle ?? "rival")} posted this ${s.rivalPosted.daysAgo === 0 ? "today" : `${s.rivalPosted.daysAgo}d ago`}</div>` : ""}
        ${splitsChart(s.splits, { left: s.players[0], right: s.players[1], compact: true })}
        <div class="links">
          <a href="${esc(s.matchUrl)}" target="_blank" rel="noopener">match page #${s.matchId}</a>
          ${s.vodUrls.map((u, i) => `<a href="${esc(u)}" target="_blank" rel="noopener">VOD ${i + 1}</a>`).join("")}
          ${onShelf ? "" : '<a href="#" data-act="render" title="The plain pipeline, for a match headed to Kdenlive: no Short, no MP4">Render only</a>'}
        </div>
        <div class="acts">
          ${onShelf ? `<button data-act="open">Rendered &middot; open</button>` : `<button data-act="render-short">Render + Short + MP4</button>`}
          ${
            onShelf
              ? ""
              : `<button data-act="queue" class="ghost${queued(s.matchId) ? " queued" : ""}">${queued(s.matchId) ? `Queued #${queued(s.matchId)}` : "Queue"}</button>`
          }
          <button data-act="dismiss" class="ghost">Dismiss</button>
        </div>
      </div>`;
        })
        .join("");

  el.innerHTML = undo + scan + '<div id="playoffs"></div>' + cards;
  // The strip is under the header now, but its "will render" line and the cards' Queue buttons
  // read the same queue, and the shelf it names may have just changed.
  paintNightly();
  paintPlayoffs();
  // A failed action says so where it was clicked — the scan line, the undo line, the card —
  // rather than as an unhandled rejection in a console nobody has open.
  const failed = (target, text) => {
    if (!target) return;
    const old = target.querySelector(".actfail");
    if (old) old.remove();
    target.insertAdjacentHTML("beforeend", ` <span class="bad actfail">${esc(text)}</span>`);
  };
  el.querySelector('[data-act="rescan"]')?.addEventListener("click", async (ev) => {
    ev.preventDefault();
    try {
      renderSuggestions(await api("/api/suggestions/rescan", { method: "POST" }));
    } catch (e) {
      failed(ev.target.closest(".scanline"), `rescan failed: ${e.message}`);
      return;
    }
    clearTimeout(suggestPoll);
    suggestPoll = setTimeout(pollSuggestions, 2000);
    void loadNightly();
  });
  el.querySelector('[data-act="undo"]')?.addEventListener("click", async (ev) => {
    ev.preventDefault();
    const { id, who } = lastDismissed;
    let out;
    try {
      out = await api(`/api/suggestions/${id}/restore`, { method: "POST" });
    } catch (e) {
      failed(ev.target.closest(".scanline"), `undo failed: ${e.message}`);
      return;
    }
    // A restart since the dismiss means the row is gone from memory; it returns at the next scan.
    lastDismissed = out.now ? null : { id, who, note: "back after the next scan" };
    renderSuggestions(out);
    // Focus follows the round trip: the repaint destroyed the link that was focused.
    el.querySelector(`.sugg[data-id="${id}"] [data-act="dismiss"]`)?.focus();
    void loadNightly();
  });
  if (!data.suggestions.length) return;

  // Direct children only: the playoffs section paints its slots as `.sugg` cards too, nested in
  // #playoffs, and they carry no Dismiss — a descendant selector here threw on the first one and
  // left every card after it without handlers.
  el.querySelectorAll(":scope > .sugg").forEach((row) => {
    const id = Number(row.dataset.id);
    row.querySelector('[data-act="render"]')?.addEventListener("click", (ev) => {
      ev.preventDefault();
      startRender(String(id));
    });
    row.querySelector('[data-act="render-short"]')?.addEventListener("click", () => startRenderWithShort(id));
    row.querySelector('[data-act="open"]')?.addEventListener("click", () => select(id, { open: true }));
    row.querySelector('[data-act="queue"]')?.addEventListener("click", async (ev) => {
      const ids = (nightly?.queue ?? []).map((q) => q.matchId);
      try {
        await putQueue(queued(id) ? ids.filter((x) => x !== id) : [...ids, id]);
      } catch (e) {
        failed(ev.target.closest(".acts") ?? row, `queue: ${e.message}`);
        return;
      }
      renderSuggestions(data);
    });
    row.querySelector('[data-act="dismiss"]')?.addEventListener("click", async (ev) => {
      const s = data.suggestions.find((x) => x.matchId === id);
      let out;
      try {
        out = await api(`/api/suggestions/${id}`, { method: "DELETE" });
      } catch (e) {
        failed(ev.target.closest(".acts") ?? row, `dismiss failed: ${e.message}`);
        return;
      }
      lastDismissed = { id, who: s ? `${s.players[0]} vs ${s.players[1]}` : `#${id}` };
      renderSuggestions(out);
      // The repaint destroyed the focused button; land on the sticky undo line so a mis-press is
      // one Enter away and the next Tab does not jump to the top of the panel.
      el.querySelector('[data-act="undo"]')?.focus({ preventScroll: true });
      // Tonight's pick may have been the card just dismissed.
      void loadNightly();
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

/* --- Playoffs --------------------------------------------------------------------------------
   The current bracket's seated slots and the games found for them, above the suggestions while
   a tournament is on. A game's Render is the header form's own start: the plain pipeline by id,
   with the Short and the MP4, as the nightly would run it. Round and game number only — a series
   score is a spoiler here as much as on the video, so playoffs.ts never computes one. */
let playoffData = null;

function paintPlayoffs() {
  const el = $("#playoffs");
  if (!el || !playoffData) return;
  const now = Date.now() / 1000;
  const slots = playoffData.slots.filter(
    (s) => s.games.length || (s.startTime !== null && s.startTime > now - 6 * 3600),
  );
  if (!slots.length) {
    el.innerHTML = "";
    return;
  }
  const when = (t) =>
    t === null
      ? "unscheduled"
      : new Date(t * 1000).toLocaleString(undefined, {
          weekday: "short",
          day: "numeric",
          month: "short",
          hour: "2-digit",
          minute: "2-digit",
        });
  const rounds = [...new Set(slots.map((s) => s.round))].join(", ");
  const firstStart = Math.min(...slots.map((s) => s.startTime ?? Infinity));
  const summary = `${rounds} &middot; ${slots.length} series &middot; first ${esc(when(Number.isFinite(firstStart) ? firstStart : null))}`;
  const rows = slots
    .map(
      (s) => `
      <div class="sugg playoff">
        <div class="top">
          <span class="bucket playoffs">${esc(s.round.toUpperCase())}</span>
          <span class="who">${esc(s.seeds[0].nickname)} <span class="muted">(${esc(s.seeds[0].label)})</span> vs ${esc(s.seeds[1].nickname)} <span class="muted">(${esc(s.seeds[1].label)})</span></span>
        </div>
        <div class="facts">Bo${s.bestOf} &middot; ${esc(when(s.startTime))}${s.games.length ? "" : " &middot; no games found yet"}</div>
        ${s.games
          .map((g) => {
            const onShelf = matches.some((m) => m.matchId === g.matchId);
            return `<div class="game" data-id="${g.matchId}">
            <span>Game ${g.gameNo} of ${s.bestOf}</span>
            <a href="${esc(g.url)}" target="_blank" rel="noopener">#${g.matchId}</a>
            ${onShelf ? `<button data-act="open">Rendered &middot; open</button>` : `<button data-act="render">Render</button>`}
          </div>`;
          })
          .join("")}
      </div>`,
    )
    .join("");
  // The board is eight series of game rows above the suggestions, a whole screen of it at any
  // width: folded whatever the date (the summary names the round and the next slot), and it
  // stays open once opened across repaints.
  const open = el.querySelector("details.playoffsoon")?.open ?? false;
  el.innerHTML = `
    <div class="scanline"><span class="bucket playoffs">PLAYOFFS</span> Season ${esc(String(playoffData.season))} bracket &middot; <a href="${esc(playoffData.bracketUrl ?? "")}" target="_blank" rel="noopener">magmamcsr.com</a></div>
    <details class="playoffsoon"${open ? " open" : ""}><summary>${summary}</summary>${rows}</details>`;
  el.querySelectorAll(".game").forEach((row) => {
    const id = Number(row.dataset.id);
    row.querySelector('[data-act="render"]')?.addEventListener("click", () => startRender(String(id), true));
    row.querySelector('[data-act="open"]')?.addEventListener("click", () => select(id, { open: true }));
  });
}

async function pollSuggestions() {
  const data = await api("/api/suggestions");
  // Not awaited with the list: the bracket's first read fetches sixteen histories.
  api("/api/playoffs")
    .then((board) => {
      playoffData = board;
      paintPlayoffs();
    })
    .catch(() => {});
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

/* --- Settings ---------------------------------------------------------------------------------
   The dashboard's own view of mcsr-vid.config.json, for the handful of keys worth changing without
   an ssh session. The server allowlists what may be written and validates the merged file with the
   loader's own rules, so this side only has to render fields and post what changed. What is NOT
   here is deliberate: youtubeUploadEnabled and nightlyUpload change what goes on the live channel
   (the upload path, and what a nightly does with its MP4). They are shown, greyed, with the reason. */
let settingsData = null;

async function loadSettings() {
  const el = $("#settings");
  if (!el) return;
  try {
    settingsData = await api("/api/settings");
  } catch (e) {
    el.innerHTML = `<div class="scanline bad">${esc(e.message)}</div>`;
    return;
  }
  paintSettings();
}

function settingValue(f) {
  if (f.kind === "boolean") return !!f.value;
  if (f.kind === "words") return Array.isArray(f.value) ? f.value.join(" ") : "";
  return f.value === null || f.value === undefined ? "" : String(f.value);
}

function paintSettings() {
  const el = $("#settings");
  if (!el || !settingsData) return;
  const armed = settingsData.nightlyArmedAt;
  const groups = [];
  for (const f of settingsData.fields) {
    let g = groups.find((x) => x.name === f.group);
    if (!g) groups.push((g = { name: f.group, fields: [] }));
    g.fields.push(f);
  }
  const row = (f) =>
    f.kind === "boolean"
      ? `<div class="setrow">
           <label><input type="checkbox" data-key="${esc(f.key)}"${f.value ? " checked" : ""}> ${esc(f.label)}</label>
           ${f.unattended ? '<span class="badge">unattended</span>' : ""}
           <div class="sethelp">${esc(f.help)}</div>
         </div>`
      : `<div class="setrow">
           <label>${esc(f.label)}
             <input type="${f.kind === "int" || f.kind === "hour" ? "number" : "text"}" data-key="${esc(f.key)}" value="${esc(settingValue(f))}"${f.min !== undefined ? ` min="${f.min}"` : ""}${f.max !== undefined ? ` max="${f.max}"` : ""}${f.nullable ? ' placeholder="off"' : ""}>
           </label>
           ${f.unattended ? '<span class="badge">unattended</span>' : ""}
           <div class="sethelp">${esc(f.help)}</div>
         </div>`;
  el.innerHTML = `
    <div class="scanline">
      Writes <code>mcsr-vid.config.json</code> and applies at once &mdash; no restart.
      ${armed ? `Nightly armed for ${esc(new Date(armed).toLocaleString())}.` : "Nightly is <strong>off</strong>."}
    </div>
    ${groups
      .map((g) => `<div class="setgroup"><h3>${esc(g.name)}</h3>${g.fields.map(row).join("")}</div>`)
      .join("")}
    <div class="setgroup">
      <h3>Not changeable here</h3>
      <div class="sethelp">The first two change what goes on the live channel — the upload path, and what a nightly does with its MP4 — so they stay a deliberate edit on the box.</div>
      ${settingsData.readOnly
        .map(
          (r) =>
            `<div class="setrow off"><label>${esc(r.key)}</label> <code>${esc(JSON.stringify(r.value))}</code></div>`,
        )
        .join("")}
    </div>
    <div class="row">
      <button id="setsave">Save</button>
      <span class="msg" id="setmsg"></span>
    </div>`;
  $("#setsave").addEventListener("click", saveSettingsPanel);
}

async function saveSettingsPanel() {
  const msg = $("#setmsg");
  const patch = {};
  for (const f of settingsData.fields) {
    const input = $(`#settings [data-key="${f.key}"]`);
    if (!input) continue;
    const now = f.kind === "boolean" ? input.checked : input.value;
    // Only what moved: the server counts a no-op as no change, and a patch of everything would
    // rewrite the file every press.
    if (String(now) !== String(settingValue(f))) patch[f.key] = now;
  }
  if (Object.keys(patch).length === 0) {
    msg.textContent = "nothing changed";
    return;
  }
  clearFailAt("#setsave");
  msg.textContent = "saving…";
  try {
    const r = await api("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    settingsData = r;
    paintSettings();
    $("#setmsg").textContent = `saved ${r.changed.join(", ")}`;
  } catch (e) {
    msg.textContent = "";
    failAt("#setsave", "Settings not saved", e.message);
  }
}

const PANELS = { suggestions: "#suggestions", matches: "#list", abtest: "#abtest", settings: "#settings" };

/** A tab is also the way back from the match screen: the rail on a desktop, the bar on a phone. */
function showTab(which) {
  for (const [name, selector] of Object.entries(PANELS)) {
    $(selector).hidden = name !== which;
    $(`#tab-${name === "matches" ? "matches" : name}`).setAttribute("aria-selected", String(name === which));
  }
  showList();
  if (which === "abtest") loadAbTest();
  if (which === "settings") loadSettings();
}

/* --- List screen / match screen -------------------------------------------------------------
   Only the class moves; app.css swaps the two screens at every width. */

/** The tab's own label already carries the count, so the way back names where it goes. */
function updateBackLabel() {
  const tab = $('.tabs [aria-selected="true"]');
  const count = tab?.querySelector("small")?.textContent;
  $("#backtolist").textContent =
    `\u2190 Back to ${tab ? tab.querySelector("span").textContent : "list"}${count ? ` (${count})` : ""}`;
}

/** One of the four groups on a phone; on a desktop all four are on screen and this only marks
    the bar, which is hidden there. */
function showPanel(name) {
  document
    .querySelectorAll("#detail .panel")
    .forEach((p) => p.classList.toggle("on", p.dataset.panel === name));
  document.querySelectorAll("#detail .jump a").forEach((a) => {
    if (a.dataset.panel === name) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
}

function showMatch() {
  document.body.classList.add("view-match");
  updateBackLabel();
  // Hiding the list shortens the page, and the browser would leave you clamped somewhere in
  // the middle of the detail.
  window.scrollTo(0, 0);
}

function showList() {
  document.body.classList.remove("view-match");
  updateBackLabel();
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
  $("#tab-settings").addEventListener("click", () => showTab("settings"));
  $("#backtolist").addEventListener("click", showList);

  // A shelf that cannot be listed must not leave the whole page at "loading…": say so in the
  // list, and let the suggestions poll below run regardless.
  try {
    await refresh();
  } catch (e) {
    $("#list").innerHTML = `<div class="scanline bad">Could not load matches: ${esc(e.message)}</div>`;
  }
  // The strip is on every screen, so it does not wait for the suggestions scan. After the shelf,
  // so its last-run line can link to the match.
  void loadNightly();
  // The top card in display order — the one to publish next — not the server's newest, which
  // is a published or half-encoded match the morning after any upload. Painted behind the list;
  // a row or the strip's last-run link is what shows it.
  const first = $("#list .card");
  if (first) select(Number(first.dataset.id));
  // Not awaited: the first scan can take a minute against a cold cache, and the rendered-match
  // list is usable immediately.
  pollSuggestions().catch(
    (e) => ($("#suggestions").innerHTML = `<div class="scanline bad">${esc(e.message)}</div>`),
  );
})();
