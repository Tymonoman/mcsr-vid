const $ = (s, r = document) => r.querySelector(s);
let STAGES = { order: [], labels: {}, short: {} };
/** Hidden matches are filtered out of the list until this is toggled on. */
let showHidden = false;
let matches = [];
let selected = null;
/** The /api/meta answer the match screen was painted from; the NOW group (paintNow) reads it too. */
let selectedMeta = null;
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

/**
 * One request to the server. A request that never got an answer throws "dashboard unreachable"
 * (`offline`), and the strip says so and keeps trying (noteOffline) -- one line for the page,
 * while each panel says under its own control what it could not do.
 */
async function api(path, opts) {
  let res;
  try {
    res = await fetch(path, opts);
  } catch {
    noteOffline();
    throw Object.assign(new Error("dashboard unreachable"), { offline: true });
  }
  if (!res.ok)
    throw new Error((await res.json().catch(() => ({}))).error || `${res.status} ${res.statusText}`);
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

/** Where a row's Short state puts it (MatchRowShort, src/shorts/shortPlan.ts): what needs the
    operator first, what is on its way, what is done last. */
const SHORT_ORDER = { failed: 0, "waiting-for-hook": 1, scheduled: 3, published: 4 };
/** [label, class, the server's detail says it better]: a running step's detail ("cutting the
    Short", "uploading the long-form") is the line on its own. */
const SHORT_LINE = {
  failed: ["failed", "bad"],
  "waiting-for-hook": ["waiting for hook", "ready"],
  picking: ["exported &middot; picking the Short", "", true],
  rendering: ["rendering the Short", "", true],
  uploading: ["uploading", "", true],
  scheduled: ["scheduled", "ok"],
  published: ["published", ""],
};

/**
 * Waiting for the operator's hooks with a pick to glance at: what the strip counts
 * (NightlyShortSummary.waitingForHook). A row the server calls "not picked yet" (shortFlow.ts
 * stateOf) is backlog nobody has opened -- opening it asks the model -- and is neither counted
 * nor offered as "next".
 */
const awaitsHooks = (m) => m.shortState === "waiting-for-hook" && m.shortDetail !== "not picked yet";
const unpicked = (m) => m.shortState === "waiting-for-hook" && !awaitsHooks(m);

/**
 * The list in the order the morning asks its question -- what needs me? A failure first, then
 * the matches waiting for a hook, then what is on its way, then scheduled, then published; the
 * ones the competitor already posted after the fresh ones, newest first within each. A server
 * one restart behind sends no `shortState`, and its rows sort the old way: ready, in progress,
 * published.
 */
function orderedMatches() {
  const stage = (m) =>
    unpicked(m)
      ? m.uploaded
        ? 4
        : 2.5
      : m.shortState
        ? (SHORT_ORDER[m.shortState] ?? 2)
        : m.uploaded
          ? 4
          : m.exported
            ? 1
            : 2;
  return (showHidden ? matches : matches.filter((m) => !m.hidden))
    .slice()
    .sort((a, b) => stage(a) - stage(b) || !!a.rivalPosted - !!b.rivalPosted || b.matchId - a.matchId);
}

function renderList() {
  const el = $("#list");
  if (!matches.length) {
    el.innerHTML =
      '<div class="empty">Nothing rendered yet. <b>Render + MP4 + pick</b> on a Tonight card makes one now; the nightly renders the top card on its own.</div>';
    $("#tab-matches small").textContent = "";
    return;
  }
  // Directories with the VODs and nothing rendered (the playoff games secured ahead of their
  // render, a run stopped early) fold away at the bottom: forty "in progress" rows that were not
  // in progress buried the ones that were. The match on screen and tonight's run stay out.
  const parked = (m) =>
    !m.stages.render &&
    !m.exported &&
    !m.uploaded &&
    m.matchId !== selected &&
    !(nightly?.lastRun?.outcome === "started" && nightly.lastRun.matchId === m.matchId);
  const all = orderedMatches();
  const visible = all.filter((m) => !parked(m));
  const unrendered = all.filter(parked);
  const hiddenCount = matches.filter((m) => m.hidden).length;
  // The morning's number: matches waiting for the operator's hooks, the only thing between them
  // and the channel now. Hidden matches are out of it, so parking an old one keeps it honest.
  const shown = matches.filter((m) => !m.hidden);
  const hooks = shown.filter(awaitsHooks).length;
  const ready = shown.filter((m) => !m.shortState && m.exported && !m.uploaded).length;
  $("#tab-matches small").textContent = hooks ? `${hooks} hooks` : ready ? `${ready} ready` : "";
  updateBackLabel();
  // One line naming where the match stands, from the server's plan (shortState + shortDetail).
  const rival = (m) =>
    m.rivalPosted && m.shortState !== "published"
      ? ` &middot; <span class="rival" title="${esc(m.rivalPosted.title)}">@${esc(rivalHandleOrDefault())} posted ${m.rivalPosted.daysAgo === 0 ? "today" : `${m.rivalPosted.daysAgo}d ago`}</span>`
      : "";
  const state = (m) => {
    if (parked(m)) {
      const next = STAGES.order.find((s) => !m.stages[s]);
      return `<div class="state">not rendered${next ? ` &middot; next: ${esc(STAGES.short?.[next] ?? next).toLowerCase()}` : ""}</div>`;
    }
    if (m.shortState === "no-export" && /^a playoff game/.test(m.shortDetail ?? ""))
      return '<div class="state">playoff game &middot; part of its series&rsquo; video</div>';
    // A video put up in Studio before the Short flow existed has no pick either; it is published.
    if (unpicked(m))
      return m.uploaded
        ? '<div class="state">published &middot; no Short</div>'
        : `<div class="state">exported &middot; no Short picked yet &mdash; opening it asks the model${rival(m)}</div>`;
    const line = SHORT_LINE[m.shortState];
    if (line && line[2] && m.shortDetail)
      return `<div class="state">${line[0].startsWith("exported") ? "exported &middot; " : ""}${esc(m.shortDetail)}&hellip;${rival(m)}</div>`;
    if (line)
      return `<div class="state ${line[1]}">${line[0]}${m.shortDetail ? ` &middot; ${esc(m.shortDetail)}` : ""}${rival(m)}</div>`;
    if (!m.shortState && m.uploaded) return '<div class="state">published</div>';
    if (!m.shortState && m.exported) return `<div class="state ready">ready${rival(m)}</div>`;
    const next = STAGES.order.find((s) => !m.stages[s]);
    return `<div class="state">${next ? `in progress &middot; ${esc(STAGES.short?.[next] ?? STAGES.labels[next] ?? next).toLowerCase()}` : "rendered &middot; not exported yet"}</div>`;
  };
  const toggle = hiddenCount
    ? `<button type="button" id="showhidden" class="ghost">${showHidden ? "Hide" : "Show"} ${hiddenCount} hidden</button>`
    : "";

  const card = (m) => `
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
    </div>`;
  const open = el.querySelector("details.parked")?.open ? " open" : "";
  el.innerHTML =
    toggle +
    (visible.length ? visible.map(card).join("") : '<div class="empty">Nothing rendered to show.</div>') +
    (unrendered.length
      ? `<details class="fold parked"${open}><summary>${unrendered.length} not rendered &mdash; VODs on disk</summary>${unrendered.map(card).join("")}</details>`
      : "");

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
    clearFailAt(btn.closest(".card") ?? btn);
    try {
      await api(`/api/hidden/${id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hidden: nowHidden }),
      });
    } catch (err) {
      failAt(btn.closest(".card") ?? btn, `${nowHidden ? "Hide" : "Unhide"} failed`, err.message);
      return;
    }
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
      btn.disabled = false;
      btn.textContent = "Delete";
      // Under the button pressed: nothing was deleted, so nothing is repainted away.
      failAt(btn.closest(".card") ?? btn, "Not deleted", err.message);
      return;
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
 * (src/pipeline/title.ts): a line still holding the placeholder, and a line that already has a hook in
 * front of the generated half. Either way the hook is everything before the name pair, so
 * replacing it is one rule, and the tail after it stays as it is on disk. A line without the pair
 * is left exactly as it is.
 */
function titleWithHook(firstLine, hook, generated) {
  if (!hook) return firstLine;
  if (firstLine.includes("<HOOK>")) return firstLine.replace("<HOOK>", hook);
  const old = hookOfTitle(firstLine, generated);
  return old === null ? firstLine : hook + firstLine.slice(old.length);
}

/** The hook in a title's first line: what stands before " | <left> vs <right> | ". Not the first
    " | " -- a hook may carry one ("PLAYOFFS | SWEPT vs TAS") -- and not the whole generated tail,
    which a title written before a tail change no longer ends with. Null for "<HOOK>". */
function hookOfTitle(line, generated) {
  const at = generated && !line.includes("<HOOK>") ? line.indexOf(` | ${generated.split(" | ")[0]} | `) : -1;
  return at > 0 ? line.slice(0, at) : null;
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
 * The match screen is a head and four groups: Now (the steps from the export to the channel,
 * with the two hooks -- paintNow), Check (the video, the sync frames, the sync editor), Package
 * (thumbnails; splits and the title editors folded), Publish (YouTube, the kit, Manage). Two
 * columns on a desktop, one group at a time below 860px, switched by the .jump bar. Every match
 * opens on Now: the hooks are the only thing between a finished video and the channel.
 */
async function select(id, { open = false } = {}) {
  // Re-selecting the match on screen (the strip's last-run link, a card's "Rendered · open")
  // rebuilds the markup; the group the operator was in must survive it, or a phone drops back to
  // Now mid-Package.
  const keepPanel = selected === id ? $("#detail .panel.on")?.dataset.panel : undefined;
  selected = id;
  clearTimeout(nowPoll);
  if (exportStream) {
    exportStream.close();
    exportStream = null;
  }
  if (open) showMatch();
  renderList();
  let meta;
  try {
    meta = await api(`/api/meta/${id}`);
  } catch (e) {
    if (selected !== id) return;
    // A match screen that cannot load says so, with the way to try again, instead of leaving
    // the last match's panels under this one's list row.
    nowPlan = null;
    $("#detail").innerHTML =
      `<div class="scanline bad">Could not open #${id}: ${esc(e.message)} &middot; <a href="#" id="reselect">try again</a></div>`;
    $("#reselect").addEventListener("click", (ev) => {
      ev.preventDefault();
      void select(id, { open });
    });
    return;
  }
  if (selected !== id) return; // the operator moved on while this was in flight
  selectedMeta = meta;
  const m = matches.find((x) => x.matchId === id);
  const rendered = m && m.stages.render;
  // Only the first line of the title file is a title; the rest is guidance formatTitle writes
  // for the terminal (src/pipeline/title.ts). The box shows the line, Save puts the guidance back, so
  // the file keeps saying how long a hook may be.
  const [titleLine, ...titleRest] = (meta.title ?? "").split("\n");

  // Unrendered, the head's one button is what a Tonight card's is: render, the MP4, the pick.
  // Rendered, Manage keeps the plain re-run (a new overlay; the MP4 is Check's Re-encode).
  const runButtons = `<button id="run" class="${rendered ? "ghost" : ""}">${rendered ? "Re-run pipeline" : "Render + MP4 + pick"}</button>
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
      ${
        meta.series
          ? `<div id="serieshead">series &middot; ${esc(meta.series.round.toLowerCase())} &middot; best of ${meta.series.bestOf} &middot; games: ${meta.series.games
              .map((g) => `<a href="#" data-game="${g.matchId}">${g.gameNo}</a>`)
              .join(" ")}</div>`
          : ""
      }
      <nav class="jump">
        <a href="#now" data-panel="now" aria-current="page">Now</a>
        <a href="#h-preview" data-panel="check">Check</a>
        <a href="#h-thumbs" data-panel="package">Package</a>
        <a href="#h-youtube" data-panel="publish">Publish</a>
      </nav>
    </div>

    <div class="cols">
      <div class="col">
        <section class="panel on" data-panel="now">
          <div id="now"><div class="empty">loading&hellip;</div></div>
        </section>
        <section class="panel" data-panel="check">
          <h2 id="h-preview">Final video</h2>
          <div id="preview"><div class="empty">loading&hellip;</div></div>
          <div id="synccheck"></div>
          <details id="syncedit" class="syncedit"><summary>Fix the sync by hand</summary><div class="empty">loading&hellip;</div></details>
        </section>
      </div>
      <div class="col">
        <section class="panel" data-panel="package">
          <h2 id="h-thumbs">Thumbnail</h2>
          <div id="variants"><div class="empty">loading&hellip;</div></div>

          <details class="fold"><summary>Splits</summary>
            <div id="splits"><div class="empty">loading&hellip;</div></div>
          </details>
          <details class="fold"><summary>Title &amp; description ${meta.titleEdited || meta.descriptionEdited ? '<span class="saved">(edited)</span>' : ""}</summary>
            <h2>Title ${meta.titleEdited ? '<span class="saved">(edited)</span>' : ""}</h2>
            <textarea id="title" rows="2">${esc(titleLine)}</textarea>
            <h2>Description ${meta.descriptionEdited ? '<span class="saved">(edited)</span>' : ""}</h2>
            <textarea id="description" rows="14">${esc(meta.description ?? "")}</textarea>
            <div class="row">
              <button type="button" id="savetext" class="ghost">Save text</button>
              <span class="msg" id="savetextmsg">the hook is saved in Now; this saves the text as typed</span>
            </div>
          </details>
        </section>
        <section class="panel" data-panel="publish">
          <h2 id="h-youtube">YouTube</h2>
          <div id="youtube"><div class="empty">loading&hellip;</div></div>

          <h2 id="h-publishkit">Publish kit</h2>
          <div id="publishkit"><div class="empty">loading&hellip;</div></div>

          <h2>Done by hand</h2>
          <div class="checklist" id="checklist"></div>
          ${manageHtml(id, rendered ? runButtons : "", meta.outputs)}
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
  showPanel(keepPanel ?? "now");
  wireNow(id);

  $("#mhide") && wireHide($("#mhide"), id);
  $("#mdel") && wireDelete($("#mdel"), id);
  // A series' games are hidden rows; the head's numbers open each one (its own sync check).
  document.querySelectorAll("#serieshead [data-game]").forEach((a) =>
    a.addEventListener("click", (ev) => {
      ev.preventDefault();
      select(Number(a.dataset.game), { open: true });
    }),
  );

  // Both live in the head for an unrendered match and in the Manage fold once it is rendered;
  // neither exists when the match has no directory on the shelf yet.
  $("#run")?.addEventListener("click", async () => {
    clearFailAt("#run");
    try {
      await api(`/api/render/${id}${rendered ? "" : "?short=1&export=1"}`, { method: "POST" });
    } catch (e) {
      failAt("#run", "Not started", e.message);
      return;
    }
    watch(id);
  });
  $("#stop")?.addEventListener("click", async () => {
    clearFailAt("#stop");
    try {
      await api(`/api/render/${id}`, { method: "DELETE" });
    } catch (e) {
      failAt("#stop", "Not stopped", e.message);
    }
  });
  $("#failcopy").addEventListener("click", async () => {
    const ok = await copyText($("#failtext").textContent);
    $("#failcopy").textContent = ok ? "Copied" : "Blocked — select it by hand";
  });
  // The title and description as typed, for the day one needs more than a hook. The hook itself
  // is saved in Now (PUT /api/shorts/hooks), which is what lets the uploads go; this writes the
  // two files and nothing else.
  $("#savetext").addEventListener("click", async () => {
    const msg = $("#savetextmsg");
    clearFailAt("#savetext");
    msg.textContent = "saving…";
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
      msg.textContent = "";
      failAt("#savetext", "Text not saved", e.message);
      return;
    }
    msg.textContent = "saved";
    // The PUT answers with the merged meta, so the panels that quote the text repaint from it.
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
  loadPlan(id);
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
  ["shortUploaded", "Short uploaded"],
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
    // The hook and the Short are the plan's facts now: a hook counts once it is saved, which is
    // what lets the uploads go, not once the title file has one (the pipeline writes its own).
    const plan = nowPlan?.matchId === id ? nowPlan : null;
    if (plan) {
      state = {
        ...state,
        hookPicked: plan.titleHook !== null,
        shortUploaded: !!plan.uploads.short || state.shortUploaded,
      };
    }
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
 * The rendered pose variants, a column per configured pair. Picking one copies it over
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
    el.innerHTML = '<div class="empty">no thumbnails yet &mdash; the render makes them, four poses</div>';
    return;
  }

  const tile = (v) => {
    const fellBack = v.leftProvider === "nmsr" || v.rightProvider === "nmsr";
    const chosen = v.key === data.chosen;
    // The variant the render picked needs a button too, or the operator who looks at all
    // six and likes the default has no way to say so: the checklist pill means "chosen",
    // not "rendered" (chosenBy in src/dashboard/matchShelf.ts), and PUT on the key already in use is
    // what stamps it. `chosenBy !== "auto"` mirrors the checklist exactly, so a manifest
    // from before the field still reads as chosen and asks for no second click.
    const confirmed = chosen && data.chosenBy !== "auto";
    return `
      <figure class="variant ${chosen ? "chosen" : ""}" data-key="${esc(v.key)}">
        <img src="/api/thumbnail/${id}?v=${encodeURIComponent(v.key)}" alt="${esc(v.key)}" loading="lazy">
        <figcaption>
          <span class="key">${esc(v.leftPose)} / ${esc(v.rightPose)}</span>
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
      btn.disabled = true;
      try {
        await api(`/api/thumbnails/${id}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chosen: btn.closest(".variant").dataset.key }),
        });
      } catch (e) {
        btn.disabled = false;
        failAt(btn.closest(".variant"), "Thumbnail not chosen", e.message);
        return;
      }
      await loadVariants(id);
      loadChecklist(id);
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
    clearFailAt(btn);
    try {
      await api(`/api/export/fast/${id}`, { method: "POST" });
      $("#encodestate").textContent = "encoding…";
      $(".exportbar").classList.remove("hidden");
      watchExport(id);
    } catch (e) {
      btn.disabled = false;
      failAt(btn, "Encode not started", e.message);
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
        // An export is what the picker waits for (a GET on an exported match queues a pick).
        void loadPlan(id);
        // The list's state line and count read the same file.
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
  // the whole file: the lines under it are guidance for the terminal (src/pipeline/title.ts).
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
  // Now's "Video up" names this slot until the video has one of its own.
  if (nowPlan?.matchId === id && !nowPlan.uploads.video) paintNow(nowPlan, true);

  // Getting the files onto the PC that publishes, which is step zero of the Studio phase and the
  // only part of this panel that is a command rather than a paste. Pull, not push
  // (src/dashboard/publishSet.ts). Absent unless `pullSource` is configured.
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
      // Why the slot is later than the first free one (the pair gap, src/youtube/publishSlot.ts).
      slot
        ? block(
            "Publish at",
            slotText,
            1,
            kit.publishWhy ? ` <span class="muted small">${esc(kit.publishWhy)}</span>` : "",
          )
        : "",
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
         <summary>after the upload &mdash; ${kit.shortTitle ? "Short, " : ""}pinned comment, community post, DMs</summary>`,
      // The Short uploads itself once the hooks are saved; these are for a Studio upload by hand
      // (uploads off on the box), and exist only once the Short is cut.
      kit.shortTitle ? block("Short title", kit.shortTitle, 2) : "",
      kit.shortDescription ? block("Short description", kit.shortDescription, 4) : "",
      // A first comment to pin: what the video is and where to report a sync slip, in the
      // operator's voice. The server's line wins; the fallback is the same text for a server one
      // restart behind (src/youtube/youtubeStore.ts).
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
  // Delegated from #now: the NOW group repaints its fields, and #now itself outlives that.
  $("#now")?.addEventListener("input", (ev) => ev.target.id === "hook" && setTimeout(paint, 0));
}

/** The maintenance fold at the bottom of Publish: Re-run (for a rendered match -- it is the head's
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
 * The NOW group: one column of steps in pipeline order -- Video, Pick, Hooks, Short, Video up,
 * Short up -- painted from GET /api/shorts/plan/:id (src/shorts/shortPlan.ts, ShortPlanResponse).
 *
 * Nothing uploads and no Short renders until the operator has saved the hooks; after that the
 * chain runs by itself, so this group is a glance at the pick, two fields and a status list. A
 * finished step is one line; the step that needs the operator, is running or failed is open. A
 * running step carries the server's activity line with a clock counting up (tickClocks) and a bar
 * when it knows a percentage; a failed one carries the server's error, whole, with what to do
 * about it and the button that does it; each has a Details fold with its log lines.
 *
 * Here rather than in a file of its own: server.ts serves public/ from an allowlist, and a new
 * script there is a server change.
 */

/** The plan on screen, and its JSON: a poll that brings nothing new repaints nothing. */
let nowPlan = null;
let nowPlanJson = "";
let nowPoll = null;
/** Steps the operator opened or closed by hand, for the match on screen. */
let nowOpen = {};
/** The Details folds and log lines the operator unfolded: a poll's repaint keeps them open. */
let nowLogOpen = {};
const nowLineOpen = new Set();
/** Each Details fold's lines as plain text, for its Copy button. */
let nowLogText = {};
/** Why the last read of the plan failed, until one succeeds: its own line at the top of Now. */
let nowProblem = null;

const PLAN_RUNNING = ["picking", "rendering", "uploading"];
/** The contract's step names (ShortActivity, ShortLogLine, errors) to Now's rows. */
const ROW_OF = { pick: "pick", render: "short", "upload-video": "videoup", "upload-short": "shortup" };
const STEP_OF = { pick: "pick", short: "render", videoup: "upload-video", shortup: "upload-short" };
/** A pick that has run this long is worth a line: a whole match takes 1.5-5 min. */
const PICK_LONG_SEC = 8 * 60;

const nowWhen = (iso) =>
  new Date(iso).toLocaleString([], {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

/** A clock counting up from `since`; tickClocks keeps every one on the page current. */
const clock = (since) =>
  `<span class="clock" data-since="${esc(since)}">${formatDuration(Date.now() - Date.parse(since))}</span>`;

function tickClocks() {
  const now = Date.now();
  document.querySelectorAll("[data-since]").forEach((el) => {
    const ms = now - Date.parse(el.dataset.since);
    if (el.dataset.after) el.hidden = !(ms > Number(el.dataset.after) * 1000);
    else el.textContent = formatDuration(ms);
  });
}

/** What the running step is doing: the server's own words, how long, and how far if it knows. */
const activitySum = (a) =>
  `${esc(a.line)} &middot; ${clock(a.since)}${Number.isFinite(a.percent) ? ` &middot; ${Math.round(a.percent)}%` : ""}`;

/** The chain stopped after the render on purpose: uploads are switched off on the box. */
const uploadsOff = (plan) => plan.state === "failed" && /^uploads are off/.test(plan.detail ?? "");

/** The server's detail for a playoff game whose series video is not this match (shortFlow.ts SERIES_GAME). */
const seriesGameOf = (plan) => plan.state === "no-export" && /^a playoff game/.test(plan.detail ?? "");

/** The plan has no "rendered" flag; every state past the render says it, and so does a chain
    that stopped at an upload. A Short rendered for an older hook reads "rendering" again. */
const shortRendered = (plan) =>
  !!plan.uploads.short ||
  ["uploading", "scheduled", "published"].includes(plan.state) ||
  /^upload/.test(plan.activity?.step ?? "") ||
  uploadsOff(plan) ||
  (plan.state === "failed" && /^upload/.test(plan.errors.find((e) => e.step !== "pick")?.step ?? ""));

/**
 * What to do about a failure, read off its text: the ones that have happened have a known fix.
 * Static HTML only -- never the message itself, which is shown escaped beside it.
 */
function fixFor(step, message) {
  const m = message ?? "";
  if (/not signed in/i.test(m))
    return "On the lab run <code>docker exec -it mcsr-dashboard agy</code>, open the URL it prints on your PC and sign in with the Google account that has the Gemini plan. Then press Pick again, or leave it: the server re-asks the model once a day for a pick the heuristic made.";
  if (/reasonerCommand/i.test(m))
    return "Set <code>reasonerCommand</code> in mcsr-vid.config.json on the lab (CLAUDE.md, Shorts). Until then every pick is the heuristic's.";
  if (/ENOENT|spawn/i.test(m) && step === "pick")
    return "The model's command is not installed in the dashboard's container: check <code>reasonerCommand</code> and that <code>agy</code> runs there.";
  if (/timed out/i.test(m))
    return step === "pick"
      ? "The model took too long. Pick again; if it keeps timing out, the lab is busy (an encode running) &mdash; try once that is done."
      : "It took too long: Retry.";
  if (/quota/i.test(m))
    return "YouTube's daily quota resets at midnight Pacific time (09:00 in Poland): Retry after that.";
  if (/RATE_LIMIT|429/i.test(m))
    return "YouTube caps new playlists at about a dozen a day; the server's tick adds this video to them by itself. Nothing to press.";
  if (/stale|newer than|re-?export|re-?encode/i.test(m))
    return "Re-encode the MP4 in Check (~10 min), then Retry here.";
  if (/not connected|invalid_grant|unauthori[sz]ed|\b401\b|token/i.test(m))
    return "The YouTube sign-in is gone: run <code>npm run youtube-auth</code> on a machine with a browser and copy <code>youtube-token.json</code> to the lab, then Retry.";
  if (/ENOSPC|no space/i.test(m))
    return "The disk is full: delete an old published match (Publish &rsaquo; Manage), then Retry.";
  if (/in flight/i.test(m)) return "Wait for the upload to finish; this page follows it.";
  if (/<HOOK>/.test(m)) return "The title has no hook yet: save the hooks.";
  return "";
}

/** A server-side problem in its step's row: the whole text, how long ago, and what to do. */
const errorBox = (e) => `
  <div class="inlinefail${e.warn ? " warn" : ""}">
    <div class="head"><span>${esc(e.title)}${e.at ? ` &middot; ${ago(e.at)}` : ""}</span></div>
    <pre>${esc(e.text)}</pre>${e.fix ? `<div class="fix">${e.fix}</div>` : ""}
  </div>`;

/**
 * A step's problems: the one that stopped it (`current`), and the rest (`earlier`) -- an attempt
 * the chain has since got past, or a problem the step lived with, like a playlist cap after an
 * upload that worked. `errors` is only cleared by a save, so an old failure must not read as
 * today's. A pick error stands while the heuristic's pick does.
 */
function problemsOf(plan, step) {
  const all = plan.errors.filter((e) => e.step === step);
  let current = null;
  if (step === "pick") {
    const picking = plan.pickActivity || plan.activity?.step === "pick";
    if (!picking && plan.pick?.source !== "agy") current = all[0] ?? null;
  } else if (plan.state === "failed") {
    const stopping = plan.errors.find((e) => e.step !== "pick");
    if (stopping?.step === step) current = stopping;
  }
  return { current, earlier: all.filter((e) => e !== current) };
}

/** A step's log lines, newest last. The chain's own lines sit with its first step. */
function linesFor(plan, row) {
  const chainRow = plan.noShort ? "videoup" : "short";
  return (plan.log ?? []).filter((l) => l.step === STEP_OF[row] || (l.step === "chain" && row === chainRow));
}

const logKey = (l) => `${l.at}|${l.step}|${l.text}`;

/** The Details fold: every line the server logged for this step, a line's detail unfoldable. */
function logFold(row, lines) {
  if (!lines.length) return "";
  nowLogText[row] = lines
    .map(
      (l) =>
        `${l.at} ${l.level.toUpperCase()} [${l.step}] ${l.text}${l.detail ? `\n    ${l.detail.replace(/\n/g, "\n    ")}` : ""}`,
    )
    .join("\n");
  const time = (l) =>
    `<span class="t">${new Date(l.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>`;
  const line = (l) =>
    l.detail
      ? `<details class="logline lv-${esc(l.level)}" data-key="${esc(logKey(l))}"${nowLineOpen.has(logKey(l)) ? " open" : ""}>
           <summary>${time(l)} ${esc(l.text)}</summary><pre>${esc(l.detail)}</pre></details>`
      : `<div class="logline lv-${esc(l.level)}">${time(l)} ${esc(l.text)}</div>`;
  const bad = lines.filter((l) => l.level === "error").length;
  return `<details class="steplog" data-log="${row}"${nowLogOpen[row] ? " open" : ""}>
    <summary>Details &middot; ${lines.length} line${lines.length === 1 ? "" : "s"}${bad ? ` &middot; <span class="bad">${bad} error${bad === 1 ? "" : "s"}</span>` : ""}</summary>
    <div class="loglines">${lines.map(line).join("")}</div>
    <div class="row"><button type="button" class="ghost" data-act="copy-log">Copy</button></div>
  </details>`;
}

async function loadPlan(id) {
  clearTimeout(nowPoll);
  const el = $("#now");
  if (!el) return;
  let plan;
  try {
    plan = await api(`/api/shorts/plan/${id}`);
  } catch (e) {
    if (selected !== id) return;
    // Its own line, and the last plan stays on screen under it: a poll that fails must not
    // freeze the panel on "loading", nor stop trying.
    nowProblem = e.offline ? "dashboard unreachable" : `could not read where this match stands: ${e.message}`;
    paintNowProblem();
    nowPoll = setTimeout(() => loadPlan(id), 5000);
    return;
  }
  if (selected !== id) return;
  nowProblem = null;
  const before = nowPlan?.matchId === id ? nowPlan.state : null;
  paintNow(plan);
  // The checklist's hook and Short pills read the plan (loadChecklist).
  if (before === null) loadChecklist(id);
  // The list's state line follows a step that finishes while this screen is open.
  else if (before !== plan.state) void refresh();
  if (plan.pickActivity || plan.activity || PLAN_RUNNING.includes(plan.state))
    nowPoll = setTimeout(() => loadPlan(id), 4000);
}

function paintNowProblem() {
  const el = $("#now");
  if (!el) return;
  el.querySelector(".nowconn")?.remove();
  if (!nowProblem) return;
  const line = `<div class="scanline bad nowconn">${esc(nowProblem)} &mdash; retrying in 5 s</div>`;
  if (el.querySelector(".step, .seriesnote")) el.insertAdjacentHTML("afterbegin", line);
  else el.innerHTML = line;
}

function nowSteps(plan, meta) {
  const id = plan.matchId;
  const nick = (side) => (side === "left" ? meta.leftNickname : meta.rightNickname);
  const saved = plan.titleHook !== null;
  const titleLocked = !!plan.uploads.video;
  const shortLocked = !!plan.uploads.short;
  const noExport = plan.state === "no-export";
  const act = plan.activity ?? null;
  const sync = syncEditState?.data?.matchId === id ? syncEditState.data : null;
  const row = matches.find((m) => m.matchId === id);
  const steps = [];
  const button = (what, label, note = "") =>
    `<div class="row"><button type="button" class="ghost" data-act="${what}">${label}</button>${note ? `<span class="muted small">${note}</span>` : ""}</div>`;
  const retry = button("retry", "Retry", "saves the same hooks again, which restarts the chain");
  const toCheck = button("to-check", "Re-encode in Check &rsaquo;");
  // The step's problems and log lines, attached the same way to every row that has them.
  const attach = (s, current, earlier) => {
    const { current: now, earlier: before } = problemsOf(plan, STEP_OF[s.key]);
    if (now) {
      // A heuristic pick standing in is a warning with its reason, not a stopped step.
      if (s.status !== "warn") s.status = "fail";
      s.boxes = [{ title: current, text: now.message, at: now.at, fix: fixFor(STEP_OF[s.key], now.message) }];
    }
    s.earlier = before.map((e) => ({
      title: earlier,
      text: e.message,
      at: e.at,
      warn: true,
      fix: fixFor(STEP_OF[s.key], e.message),
    }));
    s.log = linesFor(plan, s.key);
    return s;
  };

  // --- Video: exported, and whether the sync is worth a look ---------------------------------
  const conf = meta.sync ? `sync ${Math.round(meta.sync.confidence * 100)}%` : "no sync.json";
  const checkLink = `<a href="#" data-act="to-check">check &rsaquo;</a>`;
  if (noExport && !row?.stages?.render) {
    steps.push({
      key: "video",
      status: "todo",
      name: "Video",
      sum: "not rendered yet &mdash; <b>Render + MP4 + pick</b> above renders it, encodes it and picks the Short",
    });
  } else if (noExport) {
    steps.push({
      key: "video",
      status: "todo",
      name: "Video",
      sum: "rendered, not exported yet &mdash; the MP4 is Check's Encode (~10 min)",
      aside: `<a href="#" data-act="to-check">encode &rsaquo;</a>`,
    });
  } else if (sync?.syncStale) {
    steps.push({
      key: "video",
      status: "fail",
      name: "Video",
      sum: `exported &middot; ${conf}`,
      aside: checkLink,
      boxes: [
        {
          title: "Sync changed after this export",
          text: sync.staleMessage,
          fix: fixFor("upload-video", "stale"),
        },
      ],
      body: `${toCheck}<div id="nowsync"></div>`,
    });
  } else {
    steps.push({
      key: "video",
      status: plan.syncWeak ? "warn" : "done",
      name: "Video",
      sum: `exported &middot; ${conf}${plan.syncWeak ? " &mdash; look at the frames" : ""}`,
      aside: checkLink,
      open: !!plan.syncWeak,
      body: `<div id="nowsync"></div>
        <div class="muted small">Both should show the same countdown digit. If they do not, fix the sync in Check and re-encode before saving.</div>`,
    });
  }

  // --- Pick: the model's window, or the heuristic standing in ---------------------------------
  const pick = plan.pick;
  const againBtn = shortLocked
    ? '<div class="muted small">The Short is on the channel: a new pick would need a re-upload.</div>'
    : button("pick-again", "Pick again", "the model watches the match again, 1.5&ndash;5 min");
  const picking = plan.pickActivity === "running" || act?.step === "pick";
  if (picking) {
    const s = { key: "pick", status: "run", name: "Pick", open: true };
    if (act?.step === "pick") {
      s.sum = activitySum(act);
      s.percent = act.percent;
      s.body = `<div class="scanline longnote" data-since="${esc(act.since)}" data-after="${PICK_LONG_SEC}"${Date.now() - Date.parse(act.since) > PICK_LONG_SEC * 1000 ? "" : " hidden"}>
          Longer than usual: a whole match takes 1.5&ndash;5 min. The Details below say what it is on; the model is
          stopped after 25 min and the heuristic stands in.</div>`;
    } else s.sum = "the model is watching the match&hellip;";
    steps.push(attach(s, "The picker failed", "The last attempt failed"));
  } else if (plan.pickActivity === "queued") {
    steps.push(
      attach(
        {
          key: "pick",
          status: "run",
          name: "Pick",
          sum: "queued &mdash; the model watches one match at a time and starts this one next",
        },
        "The picker failed",
        "The last attempt failed",
      ),
    );
  } else if (noExport) {
    steps.push({ key: "pick", status: "todo", name: "Pick", sum: "once the video is exported" });
  } else if (!pick) {
    steps.push(
      attach(
        {
          key: "pick",
          // attach() turns it red when a pick actually failed; a video already on the channel is
          // simply not picked yet (the server does not spend a model watch on opening it).
          status: "todo",
          name: "Pick",
          sum: "no pick yet",
          open: true,
          body: `${shortLocked ? againBtn : button("pick-again", "Ask the model", "it watches the match, 1.5&ndash;5 min")}<div class="muted small">Or tick &ldquo;No Short for this one&rdquo; under Hooks: the video then goes out alone.</div>`,
        },
        "The picker failed",
        "An earlier pick failed",
      ),
    );
  } else {
    const game = meta.series?.games.find((g) => g.matchId === pick.gameMatchId && g.matchId !== id)?.gameNo;
    const secs = Math.round((pick.endMs - pick.startMs) / 1000);
    const source =
      pick.source === "agy" ? `model${pick.model ? ` (${esc(pick.model)})` : ""}` : "heuristic stands in";
    const pov =
      pick.pov === "both"
        ? `both POVs${pick.focus ? `, ${esc(nick(pick.focus))}'s audio up` : ""}`
        : `${esc(nick(pick.pov))}'s POV alone`;
    const p = plan.preview;
    steps.push(
      attach(
        {
          key: "pick",
          status: pick.source === "agy" ? "done" : "warn",
          name: "Pick",
          sum: `${source} &middot; ${game ? `game ${game} &middot; ` : ""}${runClock(pick.startMs)}&ndash;${runClock(pick.endMs)} &middot; ${secs} s`,
          open: plan.state === "waiting-for-hook" || pick.source !== "agy",
          // The window plays inside the long-form's own video: the fragment starts and stops it,
          // no timeupdate listener to outlive the panel.
          body: `${
            p
              ? `<video class="pickvideo" controls preload="metadata" playsinline src="${esc(p.videoUrl)}#t=${p.startSec},${p.endSec}"></video>
                 <div class="previewmeta"><span>${runClock(p.startSec * 1000)}&ndash;${runClock(p.endSec * 1000)} of the ${meta.series ? "series" : "final"} video</span></div>`
              : ""
          }
            <div class="pickwhat">${pov} &middot; ${pick.kind === "race" ? "a race" : "one play"}</div>
            ${
              // Operator-only: the model's own words, which may exaggerate or name who finished. Never published.
              pick.why ? `<div class="why">&ldquo;${esc(pick.why)}&rdquo;</div>` : ""
            }
            ${againBtn}`,
        },
        "The model failed, the heuristic stands in",
        "An earlier pick failed",
      ),
    );
  }

  // --- Hooks: the two lines the operator confirms ---------------------------------------------
  if (noExport) {
    steps.push({ key: "hooks", status: "todo", name: "Hooks", sum: "once the video is exported and picked" });
  } else {
    const titleChips = plan.suggestions.title.length
      ? plan.suggestions.title
      : (meta.hook?.suggestions ?? []);
    const chips = (list, target) =>
      list.length
        ? `<div class="chips" data-for="${target}">${list.map((s) => `<button type="button" class="chip">${esc(s)}</button>`).join("")}</div>`
        : "";
    // The title's own hook first: a saved or typed one must not be swapped for a chip by a press
    // that only meant "confirm".
    const titleVal =
      plan.titleHook ??
      hookOfTitle((meta.title ?? "").split("\n")[0], meta.hook?.generated) ??
      titleChips[0] ??
      "";
    const shortVal = plan.shortHook ?? pick?.hookSuggestion ?? "";
    const lockNote = titleLocked
      ? `<div class="scanline">The video is on the channel, so its title hook is locked: a new one would mean a re-upload, which is your call.${shortLocked ? " The Short is up too." : ""}</div>`
      : "";
    steps.push({
      key: "hooks",
      status: saved ? "done" : "need",
      name: "Hooks",
      sum: saved
        ? `saved &middot; &ldquo;${esc(plan.titleHook)}&rdquo;${plan.noShort ? " &middot; no Short" : plan.shortHook ? ` &middot; &ldquo;${esc(plan.shortHook)}&rdquo;` : ""}${titleLocked ? " &middot; locked" : ""}`
        : "save both and the rest runs itself",
      open: !saved,
      body: `${lockNote}
        <label class="hooklabel" for="hook"><span>Title hook</span><span class="counter" id="hookcount"></span></label>
        <input type="text" id="hook" value="${esc(titleVal)}"${titleLocked ? " disabled" : ""} spellcheck="false">
        ${titleLocked ? "" : chips(titleChips, "hook")}
        <label class="hooklabel" for="shorthook"><span>Short hook &middot; on screen for 4 s</span><span class="counter" id="shorthookcount"></span></label>
        <input type="text" id="shorthook" value="${esc(shortVal)}"${shortLocked || plan.noShort ? " disabled" : ""} placeholder="${pick ? "" : "the model's line lands here once it has picked"}" spellcheck="false">
        ${shortLocked ? "" : chips(plan.suggestions.short, "shorthook")}
        <label class="noshort"><input type="checkbox" id="noshort"${plan.noShort ? " checked" : ""}${shortLocked ? " disabled" : ""}> No Short for this one &mdash; the video goes out alone</label>`,
    });
  }

  // --- Short: renders once the hooks are saved -------------------------------------------------
  const secs = pick ? `${Math.round((pick.endMs - pick.startMs) / 1000)} s` : "";
  if (plan.noShort) {
    steps.push({ key: "short", status: "skip", name: "Short", sum: "none for this one &mdash; your call" });
  } else {
    let s;
    if (act?.step === "render") s = { status: "run", sum: activitySum(act), percent: act.percent };
    else if (plan.state === "rendering")
      s = { status: "run", sum: `${esc(plan.detail ?? "cutting the Short")}&hellip;` };
    else if (saved && shortRendered(plan))
      s = {
        status: "done",
        sum: `rendered${secs ? ` &middot; ${secs}` : ""} &middot; &#9654; watch`,
        body: `<div class="shortplayer"><video controls preload="none" playsinline src="/api/shorts/preview/${id}"></video>
          <div class="previewmeta"><a href="/api/shorts/preview/${id}" download>Download</a></div></div>`,
      };
    else
      s = {
        status: "todo",
        sum: noExport
          ? "once the video is exported"
          : saved
            ? "waits for the pick"
            : "renders once the hooks are saved, about 2 min",
      };
    s = attach({ key: "short", name: "Short", ...s }, "Short render failed", "An earlier render failed");
    if (s.status === "fail") Object.assign(s, { sum: "failed", body: `${retry}${s.body ?? ""}` });
    steps.push(s);
  }

  // --- Video up, Short up ----------------------------------------------------------------------
  // The slot the upload will take is the kit's (publishSlotAt, app.js loadPublishKit): the same
  // publishSlot.ts answer, a series' hour included.
  const up = (key, name, rec, pending, link) => {
    const step = STEP_OF[key];
    let s;
    if (rec) {
      const said =
        plan.state === "published"
          ? "published"
          : rec.publishAt
            ? `scheduled ${nowWhen(rec.publishAt)}`
            : "up, private with no publish time &mdash; set one in Studio";
      s = {
        status: "done",
        sum: said,
        aside: `<a href="${link(rec.videoId)}" target="_blank" rel="noopener">open &rsaquo;</a>`,
      };
    } else if (act?.step === step) s = { status: "run", sum: activitySum(act), percent: act.percent };
    else if (uploadsOff(plan))
      // Stopped after the render on purpose -- not a failure to retry: Publish is the way.
      s = {
        status: "warn",
        sum: "uploads are off on the box",
        aside: `<a href="#" data-act="to-publish">Publish &rsaquo;</a>`,
        body: `<div class="muted small">The chain stops after the render while <code>youtubeUploadEnabled</code> is false or <code>nightlyUpload</code> is "off" (mcsr-vid.config.json on the lab). Upload by hand in Publish, or switch uploads on and save the hooks again.</div>`,
      };
    else s = { status: "todo", sum: pending };
    s = attach(
      { key, name, ...s },
      `${name === "Video up" ? "Video" : "Short"} upload failed`,
      rec ? "Up, with a problem" : "An earlier attempt failed",
    );
    if (s.status === "fail")
      Object.assign(s, {
        sum: "failed",
        body: `${retry}${key === "videoup" && sync?.syncStale ? toCheck : ""}${s.body ?? ""}`,
      });
    return s;
  };
  const videoAt = plan.uploads.video?.publishAt ?? publishSlotAt?.toISOString();
  const waitSuffix = noExport
    ? " &middot; once the video is exported"
    : saved
      ? ""
      : " &middot; once the hooks are saved";
  const videoUp = up(
    "videoup",
    "Video up",
    plan.uploads.video,
    `${videoAt ? nowWhen(videoAt) : "the next free slot"}${waitSuffix}`,
    (v) => `https://youtu.be/${encodeURIComponent(v)}`,
  );
  // Uploading with no activity line: a server between steps, or one a restart cut short.
  if (plan.state === "uploading" && !act && !plan.uploads.video && videoUp.status === "todo")
    Object.assign(videoUp, { status: "run", sum: `${esc(plan.detail ?? "uploading")}&hellip;` });
  steps.push(videoUp);
  if (!plan.noShort) {
    // The long-form's time + 18 h, or an hour from now if that has passed (shortFlow.ts shortPublishAt).
    const shortAt = videoAt
      ? new Date(Math.max(new Date(videoAt).getTime() + 18 * 3600e3, Date.now() + 3600e3)).toISOString()
      : null;
    const shortUp = up(
      "shortup",
      "Short up",
      plan.uploads.short,
      `${shortAt ? nowWhen(shortAt) : "18 h after the video"}${waitSuffix}`,
      (v) => `https://youtube.com/shorts/${encodeURIComponent(v)}`,
    );
    if (
      plan.state === "uploading" &&
      !act &&
      plan.uploads.video &&
      !plan.uploads.short &&
      shortUp.status === "todo"
    )
      Object.assign(shortUp, { status: "run", sum: `${esc(plan.detail ?? "uploading")}&hellip;` });
    steps.push(shortUp);
  }
  return steps;
}

const STEP_MARK = {
  done: "&#10004;",
  todo: "&#9675;",
  run: "&#9679;",
  need: "&#9679;",
  warn: "!",
  fail: "&#10008;",
  skip: "&ndash;",
};

/**
 * A playoff game that is not its series' video (game 2..n, or game 1 before the join): the
 * series is picked, cut and uploaded as one video from game 1, so this game has nothing to save.
 * Where to go instead, from the bracket the Tonight tab loaded.
 */
function seriesGameHtml(plan) {
  const id = plan.matchId;
  const slot = playoffData?.slots.find((s) => s.games.some((g) => g.matchId === id));
  const game = slot?.games.find((g) => g.matchId === id);
  const first = slot?.series?.firstGameId;
  const what = game
    ? `Game ${game.gameNo} of ${esc(slot.round)}, ${esc(slot.seeds[0].nickname)} vs ${esc(slot.seeds[1].nickname)}.`
    : "A playoff game.";
  const joined = !!slot?.series?.joined;
  const go =
    first && first !== id && matches.some((m) => m.matchId === first)
      ? `<a href="#" data-act="open-game" data-id="${first}">open game 1 &rsaquo;</a>`
      : `<a href="#" data-act="to-playoffs">Tonight &rsaquo; Playoffs &rsaquo;</a>`;
  return `<div class="seriesnote">
      <div><b>${what}</b> A series is one video: its pick, its hooks and both uploads live on game 1${joined ? "" : ", once every game is exported and joined (Render the series, on the bracket, does both)"}. ${go}</div>
      <div class="muted small">This game's own sync check is in Check.</div>
    </div>`;
}

function paintNow(plan = nowPlan, force = false) {
  const el = $("#now");
  const meta = selectedMeta;
  if (!el || !plan || !meta || plan.matchId !== selected) return;
  const json = JSON.stringify(plan);
  if (!force && json === nowPlanJson && nowPlan?.matchId === plan.matchId && !el.querySelector(".nowconn"))
    return;
  if (nowPlan?.matchId !== plan.matchId) {
    nowOpen = {};
    nowLogOpen = {};
    nowLineOpen.clear();
  }
  nowPlan = plan;
  nowPlanJson = json;
  nowLogText = {};

  if (seriesGameOf(plan)) {
    el.innerHTML = seriesGameHtml(plan);
    paintNowProblem();
    paintSave();
    return;
  }

  // What is typed and not saved survives a repaint: a poll must not take the operator's words.
  const draft = [...el.querySelectorAll("input[data-dirty]")].map((f) => [
    f.id,
    f.type === "checkbox" ? f.checked : f.value,
  ]);
  const msg = $("#savedmsg");
  const said = msg ? [msg.innerHTML, msg.className] : null;
  const scrolls = new Map(
    [...el.querySelectorAll(".loglines")].map((l) => [l.closest(".steplog").dataset.log, l.scrollTop]),
  );
  const steps = nowSteps(plan, meta);
  const saveAt = steps.findIndex((s) => s.key === "hooks") + 1;
  const stepHtml = (s) => {
    const body = [s.body ?? "", ...(s.earlier ?? []).map(errorBox), logFold(s.key, s.log ?? [])]
      .join("")
      .trim();
    const open = nowOpen[s.key] ?? !!(s.open || s.boxes?.length);
    return `<div class="step s-${s.status}${open ? " open" : ""}" data-step="${s.key}">
      <div class="stephead">
        <button type="button" class="steptoggle" aria-expanded="${open}"${body ? "" : " disabled"}>
          <span class="mark" aria-hidden="true">${STEP_MARK[s.status]}</span><span class="name">${s.name}</span><span class="sum">${s.sum}</span>
        </button>${s.aside ?? ""}
      </div>
      ${Number.isFinite(s.percent) ? `<div class="bar stepbar"><i style="width:${Math.max(0, Math.min(100, s.percent))}%"></i></div>` : ""}
      ${(s.boxes ?? []).map(errorBox).join("")}
      ${body ? `<div class="stepbody">${body}</div>` : ""}
    </div>`;
  };
  // A failure no row owns (a step the server marked failed without an error line): said at the top.
  const orphan =
    plan.state === "failed" && !uploadsOff(plan) && !steps.some((s) => s.boxes?.length)
      ? errorBox({
          title: "Stopped",
          text: plan.detail ?? "a step failed",
          fix: "Save the hooks again to retry.",
        })
      : "";
  el.innerHTML = `${orphan}
    ${steps.slice(0, saveAt).map(stepHtml).join("")}
    <div class="row saverow"><button type="button" id="save" hidden></button></div>
    <div id="savedmsg"></div>
    ${steps.slice(saveAt).map(stepHtml).join("")}`;
  paintNowProblem();

  for (const [fid, v] of draft) {
    const f = document.getElementById(fid);
    if (!f || f.disabled) continue;
    if (f.type === "checkbox") f.checked = v;
    else f.value = v;
    f.dataset.dirty = "1";
  }
  if ($("#noshort")?.checked && $("#shorthook")) $("#shorthook").disabled = true;
  if (draft.length) setSavedMsg("not saved &mdash; nothing uploads until you save", "muted");
  else if (said) setSavedMsg(...said);
  // Newest last: a fold opens on its end, and a repaint keeps where the operator scrolled to.
  el.querySelectorAll(".loglines").forEach((l) => {
    const kept = scrolls.get(l.closest(".steplog").dataset.log);
    l.scrollTop = kept ?? l.scrollHeight;
  });
  hookCounter(meta);
  shortHookCounter();
  paintNowSync();
  paintSave();
}

/** The Short hook's length. 40 is the picker's own ceiling for a line burned in for 4 s
    (HOOK_MAX_CHARS, src/shorts/videoPick.ts); past it the line wraps on the Short. */
function shortHookCounter() {
  const f = $("#shorthook"),
    out = $("#shorthookcount");
  if (!f || !out) return;
  out.textContent = f.disabled ? "" : `${f.value.length} / 40`;
  out.className = "counter" + (f.value.length > 40 ? " over" : f.value.length ? " good" : "");
}

function setSavedMsg(html, cls) {
  const m = $("#savedmsg");
  if (!m) return;
  m.innerHTML = html;
  m.className = cls;
}

/** The two 9.6 s frames in the Video step: the same look as Check's sync check, here because a
    weak sync is the one thing worth seeing before the hooks are saved. */
function paintNowSync() {
  const el = $("#nowsync");
  const d = syncEditState?.data;
  if (!el || !d || d.matchId !== selected) return;
  if (!d.left.clip || !d.right.clip) {
    el.innerHTML =
      '<div class="muted small">The POV clips are not on disk any more, so there is nothing to compare.</div>';
    return;
  }
  const offset = (side) => (d.sync ? d.sync[side] : d.fallback);
  el.innerHTML = `<div class="syncsides">${["left", "right"]
    .map(
      (side) => `<div class="syncside"><div class="who">${esc(d[side].nickname ?? side)}</div>
        <img src="${esc(syncFrameUrl(side, SYNC_CHECK_SEC, offset(side)))}" alt="${esc(d[side].nickname ?? side)} at ${SYNC_CHECK_SEC}s" loading="lazy"></div>`,
    )
    .join("")}</div>`;
}

/** Matches waiting for a hook, in the list's order, other than the one on screen. */
const waitingOthers = () =>
  orderedMatches().filter((m) => awaitsHooks(m) && m.matchId !== selected && !m.hidden);

/** One primary button: save while the hooks are open to edit, then the next match waiting. */
function paintSave() {
  const btn = $("#save");
  const plan = nowPlan;
  if (!btn || !plan) return;
  const hooksOpen = $('#now .step[data-step="hooks"]')?.classList.contains("open");
  const editable = !plan.uploads.video || !plan.uploads.short;
  const next = waitingOthers()[0];
  // The YouTube panel's answer (loadYoutube): with uploads off the chain stops after the render.
  const noUploads = ytStatus && (!ytStatus.connected || !ytStatus.uploadsEnabled);
  btn.hidden = false;
  if (editable && hooksOpen) {
    btn.dataset.mode = "save";
    btn.textContent =
      plan.titleHook !== null
        ? "Save hooks"
        : noUploads
          ? "Save hooks — renders the Short; uploads are off"
          : plan.syncWeak
            ? "Sync looks right — save hooks and schedule"
            : "Save hooks and schedule";
  } else if (next) {
    btn.dataset.mode = "next";
    btn.dataset.id = String(next.matchId);
    btn.textContent = "Next waiting ›";
  } else {
    btn.hidden = true;
  }
  const row = btn.closest(".saverow");
  row.hidden = btn.hidden;
  // Save at the end of the Hooks step; "Next waiting" after the last step, where a desktop reader
  // finishes (a phone pins the row to the bottom slot either way).
  const hooks = $('#now .step[data-step="hooks"]');
  if (btn.dataset.mode === "save" && hooks) hooks.after(row, $("#savedmsg"));
  else $("#now").append(row, $("#savedmsg"));
}

/** A refused save under the save row -- which a phone pins to the bottom of the screen, so the
    box lands in the page's flow at the end of the Hooks step, and is scrolled to. */
function failSave(title, text) {
  failAt("#save", title, text);
  $(".saverow + .inlinefail")?.scrollIntoView({ block: "center" });
}

async function saveHooks(id, btn) {
  const noShort = !!$("#noshort")?.checked;
  const body = {
    titleHook: $("#hook").value.trim(),
    shortHook: noShort ? null : $("#shorthook").value.trim(),
    ...(noShort ? { noShort: true } : {}),
  };
  clearFailAt("#save");
  if (!body.titleHook) return failSave("Hooks not saved", "The title hook is empty.");
  if (!noShort && !body.shortHook)
    return failSave(
      "Hooks not saved",
      nowPlan?.pick
        ? "The Short hook is empty: write one, or tick “No Short for this one”."
        : "The Short hook is empty and the model has not picked yet: wait for its line, write one, or tick “No Short for this one”.",
    );
  btn.disabled = true;
  setSavedMsg("saving&hellip;", "muted");
  await putHooks(id, body, "#save", "Hooks not saved");
}

/** PUT /api/shorts/hooks answers 202 with the plan; everything after it runs server-side. The
    same call is Retry: saving the saved hooks again is what restarts a chain that failed. */
async function putHooks(id, body, anchor, failTitle) {
  let plan;
  try {
    plan = await api(`/api/shorts/hooks/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    const b = typeof anchor === "string" ? $(anchor) : anchor;
    if (b) b.disabled = false;
    setSavedMsg("", "");
    if (anchor === "#save") failSave(failTitle, e.message);
    else failAt(anchor, failTitle, e.message);
    return;
  }
  if (selected !== id) return;
  nowOpen = {};
  // Saved is not a draft any more: the repaint must not keep it, nor say "not saved".
  $("#now")
    .querySelectorAll("[data-dirty]")
    .forEach((f) => delete f.dataset.dirty);
  paintNow(plan, true);
  setSavedMsg("saved &mdash; the rest runs by itself; this page follows it", "saved");
  // The hook pill reads the plan, which says "saved" now.
  loadChecklist(id);
  clearTimeout(nowPoll);
  nowPoll = setTimeout(() => loadPlan(id), 4000);
  // The title file carries the hook now: the kit, the title box and the checklist quote it.
  api(`/api/meta/${id}`)
    .then((meta) => {
      if (selected !== id) return;
      Object.assign(selectedMeta, meta);
      if ($("#title")) $("#title").value = (meta.title ?? "").split("\n")[0];
      loadPublishKit(id, selectedMeta);
    })
    .catch(() => {});
  await refresh();
  void loadNightly();
  paintSave();
}

/** The group's controls, bound once per select(): #now outlives its own repaints. */
function wireNow(id) {
  const el = $("#now");
  el.addEventListener("click", async (ev) => {
    const t = ev.target;
    const toggle = t.closest(".steptoggle");
    if (toggle) {
      const step = toggle.closest(".step");
      const open = !step.classList.contains("open");
      step.classList.toggle("open", open);
      toggle.setAttribute("aria-expanded", String(open));
      nowOpen[step.dataset.step] = open;
      if (step.dataset.step === "hooks") paintSave();
      return;
    }
    const chip = t.closest(".chip");
    if (chip) {
      const f = document.getElementById(chip.closest(".chips").dataset.for);
      if (!f || f.disabled) return;
      f.value = chip.textContent;
      // Through the event a keystroke raises: the counter, "not saved" and the kit follow it.
      f.dispatchEvent(new Event("input", { bubbles: true }));
      f.focus();
      return;
    }
    const save = t.closest("#save");
    if (save) {
      if (save.dataset.mode === "next") void select(Number(save.dataset.id), { open: true });
      else await saveHooks(id, save);
      return;
    }
    const act = t.closest("[data-act]");
    if (!act) return;
    const what = act.dataset.act;
    if (what === "to-check" || what === "to-publish") {
      ev.preventDefault();
      const check = what === "to-check";
      showPanel(check ? "check" : "publish");
      $(check ? "#h-preview" : "#h-youtube")?.scrollIntoView();
    } else if (what === "open-game") {
      ev.preventDefault();
      void select(Number(act.dataset.id), { open: true });
    } else if (what === "to-playoffs") {
      ev.preventDefault();
      showTab("suggestions");
      const fold = $("#playoffs details.playoffsoon");
      if (fold) fold.open = true;
    } else if (what === "copy-log") {
      const ok = await copyText(nowLogText[act.closest(".steplog").dataset.log] ?? "");
      act.textContent = ok ? "Copied" : "Copy blocked — select the lines by hand";
      setTimeout(() => act.isConnected && (act.textContent = "Copy"), 2000);
    } else if (what === "pick-again") {
      clearFailAt(act);
      act.disabled = true;
      try {
        await api(`/api/shorts/pick/${id}`, { method: "POST" });
      } catch (e) {
        act.disabled = false;
        failAt(act, "Pick again failed", e.message);
        return;
      }
      await loadPlan(id);
    } else if (what === "retry") {
      clearFailAt(act);
      act.disabled = true;
      const p = nowPlan;
      await putHooks(
        id,
        { titleHook: p.titleHook, shortHook: p.shortHook, ...(p.noShort ? { noShort: true } : {}) },
        act,
        "Retry failed",
      );
    }
  });
  // <details> toggles do not bubble: caught on the way down, so a repaint reopens what was open.
  el.addEventListener(
    "toggle",
    (ev) => {
      const d = ev.target;
      if (d.matches?.(".steplog")) nowLogOpen[d.dataset.log] = d.open;
      else if (d.matches?.(".logline[data-key]")) {
        if (d.open) nowLineOpen.add(d.dataset.key);
        else nowLineOpen.delete(d.dataset.key);
      }
    },
    true,
  );
  el.addEventListener("input", (ev) => {
    const f = ev.target;
    if (!["hook", "shorthook", "noshort"].includes(f.id)) return;
    f.dataset.dirty = "1";
    if (f.id === "noshort") $("#shorthook").disabled = f.checked || !!nowPlan?.uploads.short;
    if (f.id === "hook") hookCounter(selectedMeta);
    shortHookCounter();
    // Typed is not saved: nothing uploads, and no Short renders, until Save.
    setSavedMsg("not saved &mdash; nothing uploads until you save", "muted");
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
  // The same line in the head, above the groups: Now, Package and Publish hide the Check group
  // on a phone, and this is the one warning that must survive the switch.
  const head = $("#headwarn");
  if (head) {
    head.querySelector(".stale")?.remove();
    if (d.syncStale)
      head.insertAdjacentHTML("beforeend", `<div class="scanline bad stale">${esc(d.staleMessage)}</div>`);
  }
  guardUpload();
  // Now's Video step shows the same two frames, and fails on the same stale export.
  paintNow(nowPlan, true);
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
  return el
    ? (el.closest(".row, .setrow, .syncside, .kit, .comment, .manage, .acts, .game, .links") ?? el)
    : null;
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

let listRetry = null;

/** The list again. A failure says so above the rows it could not refresh, which stay, and tries
    again: in 30 s, or -- unreachable -- as soon as the strip's poll gets an answer. */
async function refresh() {
  clearTimeout(listRetry);
  try {
    matches = (await api("/api/matches")).matches;
  } catch (e) {
    const el = $("#list");
    el.querySelector(".listfail")?.remove();
    el.insertAdjacentHTML(
      "afterbegin",
      `<div class="scanline bad listfail">Could not ${matches.length ? "refresh" : "load"} the list: ${esc(e.message)} &mdash; ${e.offline ? "it refreshes once the dashboard answers" : "trying again in 30 s"}</div>`,
    );
    if (!e.offline) listRetry = setTimeout(refresh, 30000);
    return false;
  }
  renderList();
  // A card whose match just landed on the shelf switches from render buttons to "open".
  if (suggestData) renderSuggestions(suggestData);
  return true;
}

/* --- Nightly render strip ---------------------------------------------------------------------
   The whole of the scheduler's UI: what it will pick tonight, what the last run did, and a
   button that stops you waiting for 03:00 UTC to find out.

   A static element under the header (index.html), on every screen: its warnings -- a failed run,
   a server one restart behind -- are the first thing the morning reads. Those are direct children
   with the `bad` class, which is what lets the phone match screen keep exactly them (panels.css).
   The payload is cached so a repaint costs no request. */

let nightly = null;
let nightlyPoll = null;
/** A press in the strip that failed (Run now, a queue move): its own red line until the next press. */
let stripError = null;
/** When a request last went unanswered, until one is answered: the strip's red line. */
let offlineSince = null;

/**
 * A request got no answer at all: one `.bad` line in the strip (so a phone's match screen keeps
 * it), and the strip asks again every 5 s. The first answer clears the line and refreshes what
 * the outage may have left stale -- the list, and the match on screen.
 */
function noteOffline() {
  if (offlineSince) return;
  offlineSince = Date.now();
  paintNightly();
  clearTimeout(nightlyPoll);
  nightlyPoll = setTimeout(loadNightly, 5000);
}

/** What changes the list when it changes: a run's end, a pick landing, a chain step. */
const nightlySig = () =>
  JSON.stringify([
    nightly?.lastRun,
    nightly?.waitingForHook,
    nightly?.failed,
    (nightly?.activity?.running ?? []).map((r) => [r.matchId, r.step]),
  ]);

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
  const offline = offlineSince
    ? `<div class="bad">Dashboard unreachable since ${new Date(offlineSince).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} &mdash; retrying every 5 s. What is on screen may be out of date.</div>`
    : "";
  return offline + nightlyBody();
}

function nightlyBody() {
  if (!nightly)
    return offlineSince ? "" : '<div class="lines"><span class="muted">nightly&hellip;</span></div>';
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
    // A nightly picks the Short's moment; the render waits for the operator's hooks. `short` is
    // a record from before 23 Sept, when the nightly cut the Short itself.
    const short =
      lastRun.pick === "agy"
        ? ' <span class="ok">+ Short picked (model)</span>'
        : lastRun.pick === "heuristic"
          ? ' <span class="warn">+ Short picked (heuristic: the model failed)</span>'
          : lastRun.short === "done"
            ? ' <span class="ok">+ Short</span>'
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

  const failed = stripError ? `<div class="bad">${esc(stripError)}</div>` : "";
  // The morning's two numbers (NightlyShortSummary): what waits for a hook, and what failed on
  // its way to the channel. The failure is a direct `.bad` child, so a phone's match screen
  // keeps it; each opens the first such match in the list's order.
  const ns = nightly;
  const hooks = ns.waitingForHook?.length
    ? `<div class="hooks"><a href="#" data-act="open-first" data-ids="${ns.waitingForHook.join(",")}">${ns.waitingForHook.length} waiting for a hook &rsaquo;</a></div>`
    : "";
  const shortsFailed = ns.failed?.length
    ? `<div class="bad"><a href="#" data-act="open-first" data-ids="${ns.failed.join(",")}">${ns.failed.length} failed on the way to the channel &rsaquo;</a></div>`
    : "";
  // The model down for the whole box: every pick is the heuristic's until someone fixes it.
  const fix = ns.picker?.ok === false ? fixFor("pick", ns.picker.message) : "";
  const picker =
    ns.picker && ns.picker.ok === false
      ? `<div class="pickerline">Short picker: ${esc(ns.picker.message ?? "the model cannot be reached")} &middot; picks come from the heuristic${fix ? ` &middot; <a href="#" data-act="signin">how to fix &rsaquo;</a><div class="signinhow" hidden>${fix}</div>` : ""}</div>`
      : "";
  // What the box is doing now (NightlyShortSummary.activity): each running step names its match,
  // which is the link, with the server's line and a clock; then how many picks wait their turn.
  const VERB = {
    pick: "picking",
    render: "cutting the Short of",
    "upload-video": "uploading",
    "upload-short": "uploading the Short of",
  };
  const running = (ns.activity?.running ?? []).map(
    (r) =>
      `<a href="#" data-act="open-match" data-id="${r.matchId}">${VERB[r.step] ?? esc(r.step)} #${r.matchId}</a> &middot; ${esc(r.line)} (${clock(r.since)}${Number.isFinite(r.percent) ? `, ${Math.round(r.percent)}%` : ""})`,
  );
  const n = ns.activity?.queued?.length ?? 0;
  const queuedPicks = n
    ? [`${n} more pick${n === 1 ? "" : "s"} waiting ${n === 1 ? "its" : "their"} turn`]
    : [];
  const activity = [...running, ...queuedPicks]
    .map((l) => `<div class="activity"><span class="muted">Now</span> ${l}</div>`)
    .join("");
  return `${behind}${failed}${shortsFailed}${picker}<div class="lines">
      ${activity}
      <div class="plan" title="${esc(nextRunAt ?? "no schedule")}">${plan}</div>
      <div class="last" title="${esc(lastRun ? lastRun.startedAt : "")}">${last}</div>
      ${hooks}
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
  el.querySelectorAll('[data-act="nightly-open"], [data-act="open-match"]').forEach((a) =>
    a.addEventListener("click", (ev) => {
      ev.preventDefault();
      void select(Number(a.dataset.id), { open: true });
    }),
  );
  el.querySelectorAll('[data-act="open-first"]').forEach((a) =>
    a.addEventListener("click", (ev) => {
      ev.preventDefault();
      const ids = a.dataset.ids.split(",").map(Number);
      const first = orderedMatches().find((m) => ids.includes(m.matchId))?.matchId ?? ids[0];
      void select(first, { open: true });
    }),
  );
  el.querySelector('[data-act="signin"]')?.addEventListener("click", (ev) => {
    ev.preventDefault();
    const how = el.querySelector(".signinhow");
    how.hidden = !how.hidden;
  });
  el.querySelectorAll('[data-act="queue-up"], [data-act="queue-drop"]').forEach((a) =>
    a.addEventListener("click", async (ev) => {
      ev.preventDefault();
      const id = Number(a.closest("li").dataset.id);
      const ids = (nightly?.queue ?? []).map((q) => q.matchId);
      const i = ids.indexOf(id);
      if (a.dataset.act === "queue-drop") ids.splice(i, 1);
      else if (i > 0) [ids[i - 1], ids[i]] = [ids[i], ids[i - 1]];
      stripError = null;
      try {
        await putQueue(ids);
      } catch (e) {
        // In the strip it was pressed in, as its own red line.
        stripError = `Queue not changed: ${e.message}`;
        paintNightly();
        return;
      }
      // The cards' Queue buttons carry the position.
      if (suggestData) renderSuggestions(suggestData);
    }),
  );
}

/**
 * The strip, and its own poll: every 10 s while something runs (the clocks tick in between),
 * every minute otherwise, every 5 s while the dashboard does not answer. A change in what it
 * reports -- a run done, a pick in, a chain step -- refreshes the list too.
 */
async function loadNightly() {
  clearTimeout(nightlyPoll);
  const before = JSON.stringify((nightly?.queue ?? []).map((q) => q.matchId));
  const sigBefore = nightly && !nightly.error ? nightlySig() : null;
  let back = false;
  try {
    nightly = await api("/api/nightly");
    back = offlineSince !== null;
    offlineSince = null;
  } catch (e) {
    // public/ is served from disk and src/ is read at boot, so after a pull this page is newer
    // than the server until the container restarts. The old server answers this route with
    // "match id must be digits" (no nightly route: the id parser gets "nightly"); say what that
    // means instead of showing it. Unreachable keeps the last answer under its red line.
    if (!e.offline) nightly = { error: e.message, stale: /must be digits|not found/i.test(e.message) };
  }
  paintNightly();
  const busy = !!(nightly?.activity?.running?.length || nightly?.activity?.queued?.length);
  nightlyPoll = setTimeout(loadNightly, offlineSince ? 5000 : busy ? 10000 : 60000);
  if (back) {
    // Back from an outage: what it may have left stale.
    void refresh();
    if (selected) void loadPlan(selected);
  } else if (sigBefore !== null && !nightly?.error && nightlySig() !== sigBefore) void refresh();
  // The cards' Queue buttons carry the position, so they repaint when the queue is news to them.
  if (suggestData && JSON.stringify((nightly?.queue ?? []).map((q) => q.matchId)) !== before)
    renderSuggestions(suggestData);
}

/** The same body the clock runs. A skip repaints the strip with its reason; a start is watched
    like any other render, so it lands in the list exactly as a card's render would. */
async function runNightlyNow(btn) {
  btn.disabled = true;
  btn.textContent = "starting…";
  stripError = null;
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
    stripError = `Run now failed: ${e.message}`;
    await loadNightly();
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
    ? `<div class="empty">${data.scanning ? "" : `Nothing to suggest: every recent match with both VODs is rendered or dismissed. New matches are picked up every ${data.ttlMin ?? 30} minutes.`}</div>`
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
          ${onShelf ? `<button data-act="open">Rendered &middot; open</button>` : `<button data-act="render-short" title="Render, encode the MP4 and let the model pick the Short's moment; the Short renders once you save its hook">Render + MP4 + pick</button>`}
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
      startRender(String(id), false, ev.currentTarget);
    });
    row
      .querySelector('[data-act="render-short"]')
      ?.addEventListener("click", (ev) => startRenderWithShort(id, ev.currentTarget));
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
async function startRenderWithShort(id, btn) {
  clearFailAt(btn);
  btn.disabled = true;
  try {
    await api(`/api/render/${id}?short=1&export=1`, { method: "POST" });
  } catch (e) {
    btn.disabled = false;
    // Under the card's buttons: the header's error line is a screen up from a card low in the list.
    failAt(btn, "Not started", e.message);
    return;
  }
  await refresh();
  await select(id, { open: true });
  watch(id);
}

/* --- Playoffs --------------------------------------------------------------------------------
   The current bracket's seated slots and the games found for them, above the suggestions while
   a tournament is on. A game's Render is the header form's own start: the plain pipeline by id,
   with the Short and the MP4, as the nightly would run it; a series row's button renders the lot
   and joins them (src/playoffs/series.ts). Round and game number only — the series score is for the
   video's own dots, never for a line here. */
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
  // A series is one video (src/playoffs/series.ts): the row's button renders every game left and joins
  // them; game 1's directory is the video, so "open" on the series goes there. A game's own
  // line says what it is on disk — a directory holding only the downloads is not rendered.
  const seriesLine = (s) => {
    const st = s.series;
    if (!st) return "";
    const n = s.games.length;
    const done = st.exported.filter(Boolean).length;
    if (st.progress && !/^(done|failed)/.test(st.progress))
      return `<div class="state">series &middot; ${esc(st.progress)}</div>`;
    if (st.progress && st.progress.startsWith("failed"))
      return `<div class="state bad">series &middot; ${esc(st.progress)}</div>`;
    if (st.joined)
      return `<div class="state ready">series video ready${st.shortFromMatchId ? " &middot; short" : ""} &middot; open #${st.firstGameId}</div>`;
    return `<div class="state">${done} of ${n} games exported</div>`;
  };
  const gameState = (g) => {
    const m = matches.find((x) => x.matchId === g.matchId);
    if (!m) return null;
    if (m.exported) return "exported";
    if (m.stages && m.stages.render) return "rendered";
    return "downloaded";
  };
  const rows = slots
    .map(
      (s) => `
      <div class="sugg playoff" data-first="${s.series ? s.series.firstGameId : ""}">
        <div class="top">
          <span class="bucket playoffs">${esc(s.round.toUpperCase())}</span>
          <span class="who">${esc(s.seeds[0].nickname)} <span class="muted">(${esc(s.seeds[0].label)})</span> vs ${esc(s.seeds[1].nickname)} <span class="muted">(${esc(s.seeds[1].label)})</span></span>
        </div>
        <div class="facts">Bo${s.bestOf} &middot; ${esc(when(s.startTime))}${s.games.length ? "" : " &middot; no games found yet"}</div>
        ${seriesLine(s)}
        ${s.games
          .map((g) => {
            const state = gameState(g);
            return `<div class="game" data-id="${g.matchId}">
            <span>Game ${g.gameNo} of ${s.bestOf}</span>
            <a href="${esc(g.url)}" target="_blank" rel="noopener">#${g.matchId}</a>
            ${state ? `<button data-act="open">${state} &middot; open</button>` : `<button data-act="render">Render</button>`}
          </div>`;
          })
          .join("")}
        ${
          s.series && s.games.length
            ? `<div class="btns">${
                s.series.joined
                  ? `<button data-act="open-series">Open the series</button>`
                  : s.series.progress && !/^(done|failed)/.test(s.series.progress)
                    ? ""
                    : `<button data-act="render-series">Render the series</button>`
              }</div>`
            : ""
        }
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
    row
      .querySelector('[data-act="render"]')
      ?.addEventListener("click", (ev) => startRender(String(id), true, ev.currentTarget));
    row.querySelector('[data-act="open"]')?.addEventListener("click", () => select(id, { open: true }));
  });
  el.querySelectorAll(".sugg.playoff").forEach((row) => {
    const first = Number(row.dataset.first);
    if (!first) return;
    row
      .querySelector('[data-act="open-series"]')
      ?.addEventListener("click", () => select(first, { open: true }));
    row.querySelector('[data-act="render-series"]')?.addEventListener("click", async (ev) => {
      const btn = ev.currentTarget;
      btn.disabled = true;
      try {
        await api(`/api/series/${first}/render`, { method: "POST" });
        await pollSuggestions();
      } catch (e) {
        failAt(btn, "Render the series failed", e.message);
        btn.disabled = false;
      }
    });
  });
  // A series in flight repaints itself: the board is the only place its progress shows.
  clearTimeout(seriesPoll);
  if (slots.some((s) => s.series && s.series.progress && !/^(done|failed)/.test(s.series.progress)))
    seriesPoll = setTimeout(pollSuggestions, 15000);
}
let seriesPoll = null;

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
async function startRender(input, full = false, btn = null) {
  const err = $("#entryerr");
  err.textContent = "";
  if (btn) clearFailAt(btn);
  let matchId;
  try {
    ({ matchId } = await api(`/api/render${full ? "?short=1&export=1" : ""}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input }),
    }));
  } catch (e) {
    // Under the control pressed when there is one (a card's link, a bracket game's button);
    // the header's line for the header's form.
    if (btn) failAt(btn, "Not started", e.message);
    else err.textContent = e.message;
    return;
  }
  // The match may have no working directory yet, so it is not in `matches` — refresh first so
  // select() can find it, then fall back to watching the id directly.
  await refresh();
  await select(matchId, { open: true });
  watch(matchId);
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

/** The tab's own label already carries the count, so the way back names where it goes; beside
    it, the other matches waiting for a hook, the next one a tap away. */
function updateBackLabel() {
  const tab = $('.tabs [aria-selected="true"]');
  const count = tab?.querySelector("small")?.textContent;
  const waiting = waitingOthers();
  $("#backtolist").textContent =
    `\u2190 ${tab ? tab.querySelector("span").textContent : "List"}${count && !waiting.length ? ` \u00b7 ${count}` : ""}`;
  const next = $("#nextwaiting");
  next.hidden = !waiting.length;
  next.textContent = `${waiting.length} more waiting \u203a`;
  next.dataset.id = String(waiting[0]?.matchId ?? "");
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
  // Every clock on the page (a running step, the strip's Now line) counts up from its own start.
  setInterval(tickClocks, 1000);
  try {
    STAGES = await api("/api/stages");
  } catch {
    // Unreachable at load: the strip says so and keeps asking; the list says what it could not do.
  }

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
  $("#nextwaiting").addEventListener("click", (ev) =>
    select(Number(ev.currentTarget.dataset.id), { open: true }),
  );

  // A shelf that cannot be listed must not leave the whole page at "loading…": refresh says so in
  // the list, and the suggestions poll below runs regardless.
  if (!(await refresh())) $("#list .empty")?.remove();
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
