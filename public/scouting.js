/* Scouting uses the workspace's document store and offline queue for observations.
   External data is a dated snapshot, fetched only when someone asks for it. */
(() => {
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const metric = (v) => v === null || v === undefined ? "—" : Number(v).toLocaleString("en-US", { maximumFractionDigits: 1 });
  window.ScoutingUI = ({ F, canWrite, isAdmin, sources, setSources, call, create, persist, render, toast, showModal, closeModal, footer, refresh }) => {
    const state = { selected: "", source: "ftcscout", year: 0, query: "", teamQuery: "", results: [], searched: false, error: "", loading: false, tab: "teams", team: null, shortlist: false, sort: "rank" };
    const year = () => state.year || Number(String(F.team.season).slice(0, 4)) || new Date().getFullYear();
    const active = () => F.scoutEvents.find((e) => e.id === state.selected) || null;
    const notes = (team) => F.scouting.filter((n) => n.season === (active()?.season ?? year()) && (!active() || n.event === active().key) && (!team || n.team === team));
    const selectedSource = () => sources().find((s) => s.id === state.source);
    const selectOptions = (items, selected) => items.map(([v, label]) => `<option value="${esc(v)}" ${String(v) === String(selected) ? "selected" : ""}>${esc(label)}</option>`).join("");
    const select = (name, label, options, value) => `<label>${label}<select class="in" name="${name}">${selectOptions(options, value)}</select></label>`;
    const empty = (title, body) => `<div class="empty"><b>${esc(title)}</b>${esc(body)}</div>`;
    const noteCard = (n) => `<article class="scout-note">
      <div class="scout-note-head"><b>${n.kind === "pit" ? "Pit visit" : esc(n.match || "Match observation")}</b><span class="faint">${esc(n.date)} · ${esc(F.person(n.author).name)}</span>${n.rating ? `<span aria-label="Partner fit ${n.rating} of 5">${n.rating}/5 fit</span>` : ""}${n.shortlist ? '<span class="tag">Shortlisted</span>' : ""}
      ${canWrite() ? `<button class="linkish" data-scout-edit="${esc(n.id)}">Edit</button><button class="rm" data-rm="scouting:${esc(n.id)}">Remove</button>` : ""}</div>
      ${!active() ? `<small class="faint">${esc(n.event)} · #${n.team}</small>` : ""}
      ${[["Auto", n.auto], ["TeleOp", n.teleop], ["Endgame", n.endgame], ["Reliability", n.reliability], ["Notes", n.note]].filter(([, v]) => v).map(([label, value]) => `<p><span class="dim">${label}</span> ${esc(value)}</p>`).join("")}
    </article>`;

    function roster() {
      const teams = new Map((active()?.teams ?? []).map((t) => [t.number, { ...t }]));
      for (const n of notes()) if (!teams.has(n.team)) teams.set(n.team, { number: n.team, name: "" });
      let all = [...teams.values()].filter((t) => !state.shortlist || notes(t.number).some((n) => n.shortlist));
      const value = (t) => state.sort === "team" ? t.number : state.sort === "opr" ? -(t.opr ?? -Infinity) : t.rank ?? Infinity;
      all.sort((a, b) => value(a) - value(b) || a.number - b.number);
      return all;
    }
    function matchTable(matches) {
      return matches.length ? `<div class="tbl"><table class="scout-matches"><thead><tr><th>Match</th><th>Red alliance</th><th>Blue alliance</th><th class="num">Red</th><th class="num">Blue</th><th></th></tr></thead><tbody>${matches.map((m) => `<tr><td>${esc(m.name)}</td><td>${m.red.map((n) => `<button class="linkish" data-scout-team="${n}">${n}</button>`).join(" · ") || "—"}</td><td>${m.blue.map((n) => `<button class="linkish" data-scout-team="${n}">${n}</button>`).join(" · ") || "—"}</td><td class="num">${metric(m.redScore)}</td><td class="num">${metric(m.blueScore)}</td><td>${canWrite() ? `<button class="linkish" data-scout-match="${esc(m.id)}">Scout</button>` : ""}</td></tr>`).join("")}</tbody></table></div>` : empty("No matches published", "You can still add a match observation by hand.");
    }
    function teamDetail() {
      const team = state.team, t = active()?.teams.find((t) => t.number === team), list = notes(team);
      const matches = (active()?.matches ?? []).filter((m) => m.red.includes(team) || m.blue.includes(team));
      return `<div class="scout-detail"><button class="linkish" data-scout-back>← All teams</button>
        <div class="scout-detail-head"><div><small class="dim">TEAM ${team}</small><h2>${esc(t?.name || "Team " + team)}</h2></div>${canWrite() ? `<button class="btn pri" data-scout-new="${team}">Add observation</button>` : ""}</div>
        <div class="stats"><div class="stat"><small>Event rank</small><b>${metric(t?.rank)}</b></div><div class="stat"><small>Event OPR</small><b>${metric(t?.opr)}</b><span>Estimated contribution</span></div><div class="stat"><small>Auto OPR</small><b>${metric(t?.autoOpr)}</b></div><div class="stat"><small>Observations</small><b>${list.length}</b></div></div>
        <div class="blk"><h3>Our observations</h3>${list.slice().reverse().map(noteCard).join("") || empty("No observations yet", "Record what you see in the pit or on the field.")}</div>
        ${active() ? `<div class="blk"><h3>Matches with this team</h3>${matchTable(matches)}</div>` : ""}</div>`;
    }
    function view() {
      const ev = active(), allNotes = notes(), teams = roster();
      return `<div class="ph scout-header"><h1>Scouting</h1><div class="r"><button class="btn" data-scout-sources>Sources</button><button class="btn" data-scout-export ${allNotes.length ? "" : "disabled"}>Export observations</button>${canWrite() ? '<button class="btn pri" data-scout-new="">Add observation</button>' : ""}</div></div>
      <div class="wrap scout-wrap">
        <div class="scout-intro"><div><small class="dim">EVENT INTELLIGENCE</small><h2>Know your next alliance.</h2><p class="dim">Published results alongside what your team sees on the field.</p></div><label class="scout-saved">Saved event<select class="in" data-scout-select><option value="">Our observations · ${year()}</option>${selectOptions(F.scoutEvents.map((e) => [e.id, `${e.season} · ${e.name || e.key} · ${sources().find((s) => s.id === e.source)?.name || e.source}`]), state.selected)}</select></label></div>
        <form class="scout-search" data-scout-search>
          ${select("source", "Source", sources().map((s) => [s.id, s.name + (s.ready ? "" : " · needs setup")]), state.source)}
          <label>Season starts<input class="in" name="season" type="number" min="2015" max="2100" value="${year()}" required></label>
          <label class="scout-query">Event name or code<input class="in" name="query" value="${esc(state.query)}" maxlength="100" placeholder="e.g. Hangzhou or CNHAQ1"></label>
          ${["ftcscout", "first"].includes(state.source) ? `<label>Team's events<input class="in" name="team" type="text" inputmode="numeric" pattern="[0-9]{1,6}" maxlength="6" value="${esc(state.teamQuery)}" placeholder="${esc(F.team.num)}"></label>` : ""}
          <button class="btn" ${state.loading ? "disabled" : ""}>${state.loading ? "Loading…" : "Find events"}</button>
        </form>
        ${!selectedSource()?.ready ? '<p class="hint">Open Sources to connect this provider. FTCScout is available without a key.</p>' : ""}
        ${state.error ? `<p class="err scout-status" role="alert">${esc(state.error)}</p>` : ""}
        <div aria-live="polite">${state.loading ? '<p class="hint scout-status" role="status">Fetching from the source. Your saved data stays available.</p>' : ""}
        ${state.searched ? `<div class="scout-results">${state.results.map((e, i) => `<div class="li"><span class="t"><b>${esc(e.name || e.key)}</b><small>${esc(e.key)} · ${esc(e.start || "Dates unpublished")} · ${esc(e.location)}</small></span>${canWrite() ? `<button type="button" class="btn" data-scout-load="${i}" ${state.loading ? "disabled" : ""}>Load event</button>` : '<span class="faint">Ask a member to load</span>'}</div>`).join("") || '<p class="hint">No events found. Try a shorter name, another season, or another source.</p>'}</div>` : ""}</div>
        ${ev ? `<div class="scout-event"><div><h2>${esc(ev.name || ev.key)}</h2><p class="dim">${ev.season} · ${esc(ev.key)} · ${esc(ev.location)}${ev.start ? " · " + esc(ev.start) : ""}</p>
          <p class="faint">Source: <a class="linkish" href="${esc(sources().find((s) => s.id === ev.source)?.url)}" target="_blank" rel="noopener noreferrer">${esc(sources().find((s) => s.id === ev.source)?.name || ev.source)}</a> · Fetched ${esc(new Date(ev.at).toLocaleString())}</p></div>${canWrite() ? `<button class="btn" data-scout-refresh ${state.loading ? "disabled" : ""}>Refresh event</button>` : ""}</div>
          ${ev.warnings.length ? `<div class="scout-warnings" role="status">${ev.warnings.map((w) => `<p>${esc(w)}</p>`).join("")}</div>` : ""}` : ""}
        ${state.team ? teamDetail() : `<div class="scout-toolbar"><div class="seg">${[["teams", "Teams"], ["matches", "Matches"], ["notes", "Observations"]].map(([k, label]) => `<button class="${state.tab === k ? "on" : ""}" data-scout-tab="${k}" aria-pressed="${state.tab === k}">${label}</button>`).join("")}</div><span class="faint">${teams.length} teams · ${allNotes.length} observations</span>
          ${state.tab === "teams" ? `<div class="avl"><button class="chip ${state.shortlist ? "on" : ""}" data-scout-shortlist aria-pressed="${state.shortlist}">Shortlist</button><label class="sr" for="scout-sort">Sort teams</label><select class="pillsel" id="scout-sort" data-scout-sort>${selectOptions([["rank", "Event rank"], ["opr", "Event OPR"], ["team", "Team number"]], state.sort)}</select></div>` : ""}</div>
          ${state.tab === "teams" ? teams.length ? `<div class="tbl"><table class="scout-teams"><thead><tr><th>Pick</th><th>Team</th><th class="num">Rank</th><th class="num">OPR</th><th class="num">Auto OPR</th><th>W–L–T</th><th class="num">Notes</th></tr></thead><tbody>${teams.map((t) => {
            const list = notes(t.number), picked = list.some((n) => n.shortlist);
            return `<tr><td><button class="scout-star ${picked ? "on" : ""}" data-scout-pick="${t.number}" aria-label="${picked ? "Remove" : "Add"} team ${t.number} ${picked ? "from" : "to"} shortlist" aria-pressed="${picked}" ${canWrite() && ev ? "" : "disabled"}>${picked ? "★" : "☆"}</button></td><td><button class="scout-team-name" data-scout-team="${t.number}"><b>${t.number}</b> ${esc(t.name || "Team " + t.number)}</button></td><td class="num">${metric(t.rank)}</td><td class="num">${metric(t.opr)}</td><td class="num">${metric(t.autoOpr)}</td><td class="nowrap">${t.wins === null || t.wins === undefined ? "—" : `${t.wins}–${t.losses ?? 0}–${t.ties ?? 0}`}</td><td class="num">${list.length}</td></tr>`;
          }).join("")}</tbody></table><p class="hint">OPR estimates one team's contribution from alliance scores. A dash means the source has no value. Scores in Matches are alliance totals.</p></div>` : empty(state.shortlist ? "No teams shortlisted" : "Start with an event or a pit visit", state.shortlist ? "Use the star beside a team, or mark an observation for your shortlist." : "Find an event above, or add observations by hand. Saved events and observations remain available offline.")
          : state.tab === "matches" ? matchTable(ev?.matches ?? []) : allNotes.slice().reverse().map(noteCard).join("") || empty("No observations yet", "Add a pit visit or match observation to share with the team.")}`}
      </div>`;
    }
    function observationModal(existing, team, match) {
      if (!canWrite()) return;
      const ev = active(), n = existing || { season: ev?.season ?? year(), event: ev?.key || "", team: team || "", kind: match ? "match" : "pit", match: match || "", date: F.today };
      const input = (key, label, extra = "") => `<label>${label}<input class="in" name="${key}" value="${esc(n[key])}" ${extra}></label>`;
      showModal(`<form data-scout-observation ${existing ? `data-id="${esc(existing.id)}"` : ""}><div class="hd">${existing ? "Edit" : "Add"} observation</div><div class="bd scout-form">
        <div class="scout-form-grid">${input("season", "Season starts", 'type="number" min="2015" max="2100" required')}${input("event", "Event code", 'maxlength="80" required')}${input("team", "Team number", 'type="number" min="1" max="999999" required')}${input("date", "Date", 'type="date" required')}
        ${select("kind", "Observation", [["pit", "Pit visit"], ["match", "Match"]], n.kind)}${input("match", "Match label (optional)", 'maxlength="100" placeholder="e.g. Quals 12"')}</div>
        ${[["auto", "Autonomous"], ["teleop", "TeleOp"], ["endgame", "Endgame"], ["reliability", "Reliability / defense"], ["note", "Notes"]].map(([key, label]) => `<label>${label}<textarea class="in" name="${key}" rows="2" maxlength="${key === "note" ? 3000 : 1000}">${esc(n[key])}</textarea></label>`).join("")}
        <div class="scout-form-grid">${select("rating", "Alliance partner fit", [["", "Not rated"], [1, "1 · Low"], [2, "2"], [3, "3"], [4, "4"], [5, "5 · High"]], n.rating || "")}<label class="scout-check"><input type="checkbox" name="shortlist" ${n.shortlist ? "checked" : ""}> Add to shortlist</label></div>
      </div>${footer("Save observation")}</form>`);
    }
    function sourceModal() {
      const fields = (names) => names.map(([key, label, type]) => `<label>${label}<input class="in" type="${type || "password"}" name="${key}" maxlength="500" autocomplete="off" placeholder="Leave blank to keep current value"></label>`).join("");
      showModal(`<form data-scout-config><div class="hd">Scouting sources</div><div class="bd scout-form"><p class="dim">FTCScout needs no key. Connect additional providers below. Each saved event keeps its source and season.</p>
        ${sources().map((s) => `<div class="scout-source"><h3><a class="linkish" href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.name)}</a><span class="tag">${s.ready ? "Configured" : "Needs setup"}</span></h3>${isAdmin() ? s.id === "first" ? fields([["firstUsername", "API username", "text"], ["firstToken", "API token"]]) : s.id === "toa" ? fields([["toaKey", "X-TOA-Key"]]) : s.id === "venue" ? `<p class="hint">The workspace server must be able to reach the scoring computer. Uses the v2 full-event API; enter the server address, without /api.</p>${fields([["venueUrl", "Scorekeeper address", "url"], ["venueKey", "Bearer API key (if required)"]])}` : '<p class="hint">Ready to use. Search by event name or your team number.</p>' : ""}
        ${isAdmin() && s.id !== "ftcscout" ? `<label class="scout-check"><input type="checkbox" name="disconnect:${s.id}"> Disconnect this source</label>` : ""}</div>`).join("")}
        <p class="hint">Keys stay on the server and are excluded from JSON exports. Database backups contain them.${isAdmin() ? "" : " An admin can configure sources."}</p>
      </div>${isAdmin() ? footer("Save sources") : '<div class="ft"><button type="button" class="btn" data-act="close-modal">Done</button></div>'}</form>`);
    }
    async function loadEvent(e) {
      state.loading = true; state.error = ""; render();
      try {
        const saved = await call("POST", "/api/scouting/sync", { source: e.source, season: e.season, key: e.key }, AbortSignal.timeout(45_000));
        F.scoutEvents = [...F.scoutEvents.filter((x) => x.id !== saved.id), saved];
        state.selected = saved.id; state.team = null; state.results = []; state.searched = false;
        await refresh(); toast("Event saved for scouting.");
      } catch (err) { state.error = err.message; }
      finally { state.loading = false; render(); }
    }
    function exportNotes() {
      const keys = ["season", "event", "team", "kind", "match", "date", "author", "shortlist", "rating", "auto", "teleop", "endgame", "reliability", "note"];
      const cell = (value) => { let s = String(value ?? ""); if (/^[\s]*[=+\-@\t\r]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
      const csv = [keys, ...notes().map((n) => keys.map((k) => k === "author" ? F.person(n.author).name : n[k]))].map((row) => row.map(cell).join(",")).join("\r\n");
      const url = URL.createObjectURL(new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" })), a = document.createElement("a");
      a.href = url; a.download = `scouting-${active()?.key || year()}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    async function togglePick(team) {
      if (!canWrite() || !active()) return;
      const list = notes(team), picked = list.filter((n) => n.shortlist);
      if (picked.length) for (const n of picked) { n.shortlist = false; await persist("scouting", n); }
      else if (list.length) { list[0].shortlist = true; await persist("scouting", list[0]); }
      else await create("scouting", { season: active().season, event: active().key, team, date: F.today, kind: "pit", author: F.me, shortlist: true });
      render();
    }
    const run = (fn) => { Promise.resolve().then(fn).catch((e) => toast(e.message)); };
    function click(e) {
      const el = e.target.closest("[data-scout-sources], [data-scout-new], [data-scout-edit], [data-scout-load], [data-scout-refresh], [data-scout-team], [data-scout-back], [data-scout-tab], [data-scout-shortlist], [data-scout-pick], [data-scout-match], [data-scout-export]");
      if (!el || el.disabled) return false;
      if (el.hasAttribute("data-scout-sources")) sourceModal();
      else if (el.hasAttribute("data-scout-new")) observationModal(null, Number(el.dataset.scoutNew) || state.team);
      else if (el.hasAttribute("data-scout-edit")) observationModal(F.scouting.find((n) => n.id === el.dataset.scoutEdit));
      else if (el.hasAttribute("data-scout-load")) run(() => loadEvent(state.results[Number(el.dataset.scoutLoad)]));
      else if (el.hasAttribute("data-scout-refresh")) run(() => loadEvent(active()));
      else if (el.hasAttribute("data-scout-team")) { state.team = Number(el.dataset.scoutTeam); render(); }
      else if (el.hasAttribute("data-scout-back")) { state.team = null; render(); }
      else if (el.hasAttribute("data-scout-tab")) { state.tab = el.dataset.scoutTab; render(); }
      else if (el.hasAttribute("data-scout-shortlist")) { state.shortlist = !state.shortlist; render(); }
      else if (el.hasAttribute("data-scout-pick")) { const done = el; done.disabled = true; run(async () => { try { await togglePick(Number(el.dataset.scoutPick)); } finally { done.disabled = false; } }); }
      else if (el.hasAttribute("data-scout-match")) observationModal(null, state.team, active()?.matches.find((m) => m.id === el.dataset.scoutMatch)?.name);
      else if (el.hasAttribute("data-scout-export")) run(exportNotes);
      return true;
    }
    function change(t) {
      if (t.matches("[data-scout-select]")) { state.selected = t.value; state.team = null; render(); }
      else if (t.matches("[data-scout-sort]")) { state.sort = t.value; render(); }
      else if (t.matches("[data-scout-search] [name=source]")) {
        const form = t.form;
        state.source = t.value; state.query = form.elements.query.value; state.year = Number(form.elements.season.value); state.teamQuery = form.elements.team?.value || "";
        state.results = []; state.searched = false; state.error = ""; render();
      } else return false;
      return true;
    }
    async function submit(f, d) {
      if (f.matches("[data-scout-search]")) {
        if (state.loading) return;
        state.source = d.source; state.year = Number(d.season); state.query = d.query; state.teamQuery = d.team || ""; state.loading = true; state.error = ""; state.searched = false; render();
        try { state.results = await call("GET", "/api/scouting/search?" + new URLSearchParams({ source: d.source, season: d.season, q: d.query, team: d.team || "" }), undefined, AbortSignal.timeout(50_000)); state.searched = true; }
        catch (e) { state.error = e.message; }
        finally { state.loading = false; render(); }
      } else if (f.matches("[data-scout-observation]")) {
        const doc = { ...d, season: Number(d.season), team: Number(d.team), event: d.event.trim(), shortlist: d.shortlist === "on", rating: d.rating ? Number(d.rating) : undefined, author: F.me };
        if (!doc.event) throw new Error("Event code is required");
        if (f.dataset.id) { const old = F.scouting.find((n) => n.id === f.dataset.id); Object.assign(old, doc, { author: old.author }); await persist("scouting", old); }
        else await create("scouting", doc);
        closeModal(); toast("Observation saved."); render();
      } else {
        const body = Object.fromEntries(Object.entries(d).filter(([k, v]) => !k.startsWith("disconnect:") && v.trim()));
        const fields = { first: ["firstUsername", "firstToken"], toa: ["toaKey"], venue: ["venueUrl", "venueKey"] };
        for (const id of Object.keys(fields)) if (d["disconnect:" + id]) for (const key of fields[id]) body[key] = "";
        setSources(await call("PUT", "/api/scouting/config", body)); closeModal(); toast("Scouting sources saved."); render();
      }
    }
    return { view, click, change, submit, ownsForm: (f) => f.matches("[data-scout-search], [data-scout-observation], [data-scout-config]") };
  };
})();
