(() => {
  const F = window.FTC;
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const S = {
    ready: false, user: null, session: null, dirty: false, sseSeen: false, es: null,
    route: "home", arg: null,
    view: "open", sub: "", mode: "list",
    role: "captain", repo: null, branchPrefix: "ftc",
    nbSel: null, mtSel: null,
    toastTimer: null, g: 0,
    setTab: "profile", density: "comfortable", accent: "",
    prefs: { due: true, blocked: true, mention: true, pr: true, digest: false },
  };
  const ACCENTS = [["", "Steel blue", "#1A6FA8"], ["#38BDF8", "Sky", "#38BDF8"], ["#14B8A6", "Teal", "#14B8A6"], ["#22A06B", "Green", "#22A06B"],
    ["#E5A93B", "Amber", "#E5A93B"], ["#F07A3C", "Orange", "#F07A3C"], ["#E5484D", "Red", "#E5484D"], ["#8B9099", "Graphite", "#8B9099"]];

  /* ---------- per-device preferences ---------- */
  const UI_KEY = "008-ui";
  function loadUi() {
    try {
      const u = JSON.parse(localStorage.getItem(UI_KEY) || "{}");
      if (["captain", "programmer", "builder"].includes(u.role)) S.role = u.role;
      if (["comfortable", "compact"].includes(u.density)) S.density = u.density;
      if (u.prefs && typeof u.prefs === "object") S.prefs = { ...S.prefs, ...u.prefs };
      if (u.mode === "board" || u.mode === "list") S.mode = u.mode;
    } catch (e) { /* ignore */ }
  }
  const saveUi = () => { try { localStorage.setItem(UI_KEY, JSON.stringify({ role: S.role, density: S.density, prefs: S.prefs, mode: S.mode })); } catch (e) { /* ignore */ } };

  /* ---------- server access ---------- */
  const CLIENT = Math.random().toString(36).slice(2, 10);
  const pending = new Set();

  async function call(method, url, body) {
    const r = await fetch(url, {
      method, credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-Client": CLIENT },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = null;
    try { data = await r.json(); } catch (e) { /* no body */ }
    if (!r.ok) {
      const err = new Error((data && data.error) || r.statusText || "Request failed");
      err.status = r.status;
      if (r.status === 401 && S.ready) sessionEnded();
      throw err;
    }
    return data;
  }
  function write(method, url, body) {
    const p = call(method, url, body);
    const tracked = p.catch(() => {});
    pending.add(tracked);
    tracked.then(() => pending.delete(tracked));
    return p;
  }
  function writeFailed(e) {
    if (e.status === 401) return;
    toast(e.message || "Could not save that change");
    refresh();
  }
  const persist = (coll, doc) => { clearTimeout(timers.get(coll + doc.id)); return write("PUT", `/api/${coll}/${doc.id}`, doc).catch(writeFailed); };
  const timers = new Map();
  const soon = (key, fn, ms = 450) => { clearTimeout(timers.get(key)); timers.set(key, setTimeout(() => { timers.delete(key); fn(); }, ms)); };
  const persistSoon = (coll, doc) => soon(coll + doc.id, () => persist(coll, doc));
  const saveTeam = () => write("PUT", "/api/meta/team", F.team).catch(writeFailed);
  const saveSettings = () => write("PUT", "/api/meta/settings", { budget: F.budget, branchPrefix: S.branchPrefix, repo: S.repo || "" }).catch(writeFailed);
  const saveMe = () => { const p = F.person(F.me); return write("PATCH", `/api/people/${F.me}`, { name: p.name, role: p.role }).catch(writeFailed); };

  const SORT = {
    practice: (a, b) => a.date.localeCompare(b.date),
    meetings: (a, b) => b.date.localeCompare(a.date),
    milestones: (a, b) => a.date.localeCompare(b.date),
    phases: (a, b) => a.start.localeCompare(b.start),
  };
  async function create(coll, doc) {
    const r = await write("POST", `/api/${coll}`, doc);
    F[coll].push(r);
    if (SORT[coll]) F[coll].sort(SORT[coll]);
    return r;
  }
  async function remove(coll, id) {
    await write("DELETE", `/api/${coll}/${id}`);
    F[coll] = F[coll].filter((x) => String(x.id) !== String(id));
  }

  function applyState(st) {
    F.me = st.me.id;
    S.user = st.me;
    F.team = { logo: null, ...st.team };
    F.budget = st.settings.budget || 0;
    S.branchPrefix = st.settings.branchPrefix || "ftc";
    S.repo = st.settings.repo || null;
    for (const k of ["people", "milestones", "phases", "issues", "parts", "practice", "meetings", "notebook"]) F[k] = st[k];
  }
  async function refresh() {
    if (!S.ready) return;
    await Promise.allSettled([...pending]);
    try { applyState(await call("GET", "/api/state")); } catch (e) { return; }
    rerenderIfIdle();
  }
  let refreshTimer;
  const refreshSoon = () => { clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 250); };
  function rerenderIfIdle() {
    const a = document.activeElement;
    const typing = a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && a.closest("#page, #modal");
    if (typing || $("#ov-modal").classList.contains("show")) { S.dirty = true; return; }
    S.dirty = false;
    render();
  }
  function connectEvents() {
    if (S.es) S.es.close();
    if (typeof EventSource === "undefined") return;
    const es = new EventSource("/api/events");
    es.addEventListener("change", (e) => { try { if (JSON.parse(e.data).by !== CLIENT) refreshSoon(); } catch (err) { /* ignore */ } });
    es.addEventListener("open", () => { if (S.sseSeen) refreshSoon(); S.sseSeen = true; });
    S.es = es;
  }

  /* ---------- appearance ---------- */
  const logoHtml = () => F.team.logo
    ? `<span class="logo img" style="background-image:url('${esc(F.team.logo)}')">${esc(F.team.short)}</span>`
    : `<span class="logo">${esc(F.team.short || "008")}</span>`;
  const isAdmin = () => !!S.user && S.user.access === "Admin";
  const renderSide = () => { $("#side").innerHTML = sideHtml(); };
  function applyAccent(hex) {
    const r = document.documentElement.style;
    S.accent = hex || "";
    if (!hex) { r.removeProperty("--brand"); r.removeProperty("--brand-ink"); }
    else {
      const n = parseInt(hex.slice(1), 16), lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
      r.setProperty("--brand", hex); r.setProperty("--brand-ink", lum > 0.5 ? "#03202E" : "#FFFFFF");
    }
    try { localStorage.setItem("008-accent", S.accent); } catch (e) { /* ignore */ }
  }
  const themePref = () => { try { return localStorage.getItem("008-theme") || "system"; } catch (e) { return "system"; } };
  function setThemePref(v) {
    try { v === "system" ? localStorage.removeItem("008-theme") : localStorage.setItem("008-theme", v); } catch (e) { /* ignore */ }
    const t = v === "system" ? (window.matchMedia && matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark") : v;
    document.documentElement.setAttribute("data-theme", t);
  }

  /* ---------- queries ---------- */
  const byId = (id) => F.issues.find((i) => i.id === +id);
  const isOpen = (i) => i.status !== "done";
  const debt = () => F.issues.filter((i) => i.status === "done" && !i.logged);
  const mine = () => F.issues.filter((i) => i.who.includes(F.me) && isOpen(i));
  const blocked = () => F.issues.filter((i) => i.status === "blocked");
  const qualifier = () => F.milestones.find((m) => m.main);
  const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const branchName = (i) => `${S.branchPrefix || "ftc"}-${i.id}-${slug(i.title).slice(0, 30).replace(/-$/, "")}`;
  const typeFor = (sub) => (["auto", "teleop", "vision"].includes(sub) ? "code" : sub === "notebook" ? "notebook" : sub === "outreach" ? "outreach" : "build");
  const uid = () => "a" + Math.random().toString(36).slice(2, 8);

  const health = (sub) => {
    const o = F.issues.filter((i) => i.sub === sub && isOpen(i));
    if (o.some((i) => i.status === "blocked")) return { s: "bad", label: "Blocked", n: o.length };
    if (o.some((i) => i.pri === "high")) return { s: "warn", label: "Needs work", n: o.length };
    return { s: "ok", label: o.length ? "On track" : "Healthy", n: o.length };
  };

  /* ---------- glyphs ---------- */
  const COL = { todo: "var(--todo)", doing: "var(--doing)", review: "var(--review)", blocked: "var(--blocked)", done: "var(--done)" };
  const statusIcon = (s) => {
    const c = COL[s];
    const ring = `<circle cx="7" cy="7" r="5.25" fill="none" stroke="${c}" stroke-width="1.5"${s === "todo" ? ' stroke-dasharray="2.2 2"' : ""}/>`;
    let inner = "";
    if (s === "doing") inner = `<path d="M7 7V3.25A3.75 3.75 0 0 1 7 10.75Z" fill="${c}"/>`;
    if (s === "review") inner = `<path d="M7 7V3.25A3.75 3.75 0 1 1 3.25 7Z" fill="${c}"/>`;
    if (s === "blocked") inner = `<rect x="4.2" y="6.2" width="5.6" height="1.6" rx=".8" fill="${c}"/>`;
    if (s === "done") return `<svg class="si" width="14" height="14" viewBox="0 0 14 14"><circle cx="7" cy="7" r="6" fill="${c}"/><path d="M4.4 7.2l1.9 1.9 3.3-3.8" fill="none" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    return `<svg class="si" width="14" height="14" viewBox="0 0 14 14" role="img" aria-label="${F.status[s]}">${ring}${inner}</svg>`;
  };
  const priIcon = (p) => {
    const n = { high: 3, med: 2, low: 1 }[p];
    const bars = [0, 1, 2].map((k) => `<rect x="${1 + k * 4.5}" y="${9 - k * 3}" width="3" height="${3 + k * 3}" rx=".8" fill="${k < n ? "var(--dim)" : "var(--line)"}"/>`).join("");
    return `<svg class="pri-i" width="14" height="14" viewBox="0 0 14 14" role="img" aria-label="${F.pri[p]} priority">${bars}</svg>`;
  };
  const I = {
    home: '<path d="M2 7.2 8 2.5l6 4.7V13a.5.5 0 0 1-.5.5H10V9H6v4.5H2.5A.5.5 0 0 1 2 13Z"/>',
    me: '<circle cx="8" cy="5.5" r="2.5"/><path d="M3 13.5c.4-2.6 2.5-4 5-4s4.6 1.4 5 4"/>',
    issues: '<circle cx="8" cy="8" r="5.5"/><path d="M5.5 8.2l1.8 1.8 3.2-3.6"/>',
    season: '<rect x="2" y="3.5" width="12" height="10" rx="1.5"/><path d="M2 6.8h12M5.5 2v3M10.5 2v3"/>',
    notebook: '<rect x="3.5" y="2" width="9" height="12" rx="1.5"/><path d="M6 5.5h4M6 8h4"/>',
    parts: '<path d="M8 2 13.5 5v6L8 14 2.5 11V5Z"/><path d="M2.8 5.2 8 8l5.2-2.8M8 8v6"/>',
    practice: '<path d="M2 12 5.5 8l2.5 2L13 4"/><path d="M10 4h3v3"/>',
    meetings: '<circle cx="6" cy="6" r="2"/><circle cx="11" cy="7" r="1.6"/><path d="M2 13c.3-2 1.8-3.2 4-3.2s3.7 1.2 4 3.2M10.5 10c1.6 0 2.8.9 3.1 2.6"/>',
    pit: '<rect x="2" y="3" width="12" height="8.5" rx="1.5"/><path d="M6 14h4"/>',
    search: '<circle cx="7" cy="7" r="4"/><path d="m10 10 3.5 3.5"/>',
    gear: '<path d="M6.77 3.05L6.97 1.48L9.03 1.48L9.23 3.05L10.63 3.63L11.88 2.66L13.34 4.12L12.37 5.37L12.95 6.77L14.52 6.97L14.52 9.03L12.95 9.23L12.37 10.63L13.34 11.88L11.88 13.34L10.63 12.37L9.23 12.95L9.03 14.52L6.97 14.52L6.77 12.95L5.37 12.37L4.12 13.34L2.66 11.88L3.63 10.63L3.05 9.23L1.48 9.03L1.48 6.97L3.05 6.77L3.63 5.37L2.66 4.12L4.12 2.66L5.37 3.63Z"/><circle cx="8" cy="8" r="2.1"/>',
    git: '<circle cx="4.5" cy="4" r="1.6"/><circle cx="4.5" cy="12" r="1.6"/><circle cx="11.5" cy="6.5" r="1.6"/><path d="M4.5 5.6v4.8M11.5 8.1c0 2-3 1.6-6.4 2.6"/>',
  };
  const ico = (k) => `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${I[k]}</svg>`;
  const av = (id) => { const p = F.person(id); return `<span class="av" style="--h:${p.hue}" title="${esc(p.name)}">${esc(p.name[0])}</span>`; };
  const avs = (ids) => `<span class="avs">${ids.map(av).join("")}</span>`;
  const dueChip = (i) => {
    if (!i.due || i.status === "done") return "";
    const d = F.days(i.due);
    const cls = d < 0 ? "overdue" : d <= 2 ? "due-soon" : "";
    return `<span class="chip ${cls}">${F.fmt(i.due)}</span>`;
  };
  const dot = (s) => `<span class="dot ${s}"></span>`;

  /* ---------- routing ---------- */
  const go = (path) => {
    const h = "#/" + path;
    if (location.hash === h) { parseHash(); render(); } else location.hash = h;
  };
  const parseHash = () => {
    const [r, a] = (location.hash.replace(/^#\/?/, "") || "home").split("/");
    S.route = r || "home"; S.arg = a || null;
  };

  /* ---------- sidebar ---------- */
  const NAV = [["home", "Home", "home"], ["mine", "My issues", "me"], ["issues", "Issues", "issues"]];
  const NAV2 = [["season", "Season", "season"], ["notebook", "Notebook", "notebook"], ["parts", "Parts", "parts"], ["practice", "Practice", "practice"], ["meetings", "Meetings", "meetings"]];
  const sideHtml = () => {
    const onIssues = S.route === "issues";
    const navBtn = ([k, label, ic], extra = "") => {
      const on = k === "mine" ? onIssues && S.view === "mine" : k === "issues" ? onIssues && S.view !== "mine" && !S.sub : S.route === k;
      return `<button class="nav ${on ? "on" : ""}" data-go="${k}" ${on ? 'aria-current="page"' : ""}>${ico(ic)}${label}${extra}</button>`;
    };
    const nbDebt = debt().length;
    return `
      <div class="ws">${logoHtml()}<div><b>${esc(F.team.num)} ${esc(F.team.name)}</b><small>${esc(F.team.season)}${F.team.season ? " season" : ""}</small></div></div>
      <button class="search" data-act="palette">${ico("search")}Search<kbd>Ctrl K</kbd></button>
      ${NAV.map((n) => navBtn(n, n[0] === "mine" ? `<span class="n">${mine().length}</span>` : "")).join("")}
      <div class="grp">Team</div>
      ${NAV2.map((n) => navBtn(n, n[0] === "notebook" && nbDebt ? `<span class="n alert">${nbDebt}</span>` : "")).join("")}
      <div class="grp">Subsystems</div>
      ${F.robotSubs.map((k) => {
        const h = health(k);
        return `<button class="nav ${onIssues && S.sub === k ? "on" : ""}" data-sub="${k}">${dot(h.s)}${F.subs[k]}<span class="n">${h.n || ""}</span></button>`;
      }).join("")}
      <div class="spacer"></div>
      <div class="foot">
        <button class="nav" data-go="pit">${ico("pit")}Pit board</button>
        <button class="nav" data-act="github">${ico("git")}${S.repo ? esc(S.repo) : "Connect GitHub"}</button>
        <label class="sr" for="role">View as</label>
        <select class="sel" id="role" data-role>
          ${[["captain", "Captain view"], ["programmer", "Programmer view"], ["builder", "Builder view"]].map(([k, l]) => `<option value="${k}" ${S.role === k ? "selected" : ""}>${l}</option>`).join("")}
        </select>
        <button class="nav ${S.route === "settings" ? "on" : ""}" data-go="settings">${ico("gear")}Settings</button>
        <button class="nav" data-act="logout" title="Sign out">${av(F.me)}<span style="overflow:hidden;text-overflow:ellipsis">${esc(F.person(F.me).name)}</span><span class="n">Sign out</span></button>
      </div>`;
  };

  /* ---------- issue list helpers ---------- */
  const filterIssues = () => {
    let l = F.issues.slice();
    const v = S.view;
    if (v === "open") l = l.filter(isOpen);
    else if (v === "mine") l = l.filter((i) => i.who.includes(F.me) && isOpen(i));
    else if (v === "blocked") l = l.filter((i) => i.status === "blocked");
    else if (v === "notebook") l = l.filter((i) => i.status === "done" && !i.logged);
    if (S.sub) l = l.filter((i) => i.sub === S.sub);
    return l;
  };
  const grouped = () => {
    const l = filterIssues();
    return F.statusOrder.map((s) => [s, l.filter((i) => i.status === s)]).filter(([, a]) => a.length);
  };
  const flat = () => grouped().flatMap(([, a]) => a);

  const rowHtml = (i) => `
    <div class="row ${i.status === "done" ? "done" : ""} ${+S.arg === i.id ? "on" : ""}" role="button" tabindex="0" data-issue="${i.id}">
      ${priIcon(i.pri)}<span class="mono dim id">FTC-${i.id}</span>${statusIcon(i.status)}
      <span class="t">${esc(i.title)}</span>
      <span class="chip sub">${F.subs[i.sub]}</span>
      <span class="pr-col">${i.branch ? `<span class="chip mono" title="Branch ${esc(i.branch)}">${i.pr ? "PR #" + i.pr : esc(i.branch.split("/")[0])}</span>` : ""}${dueChip(i)}</span>
      ${avs(i.who)}
    </div>`;

  const cardHtml = (i) => `
    <button class="card ${+S.arg === i.id ? "on" : ""}" draggable="true" data-issue="${i.id}" data-drag="${i.id}">
      <div class="t">${esc(i.title)}</div>
      <div class="m"><span class="mono">FTC-${i.id}</span><span class="chip">${F.subs[i.sub]}</span>${avs(i.who)}</div>
    </button>`;

  const panelHtml = () => {
    const i = byId(S.arg);
    if (!i) return "";
    const sel = (field, opts, cur) => `<select data-field="${field}" data-id="${i.id}" aria-label="${field}">${opts.map(([k, l]) => `<option value="${k}" ${k === cur ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
    const act = [{ who: i.who[0], text: "created this issue", date: i.created }, ...(i.notes || [])];
    return `
      <aside class="panel" aria-label="Issue FTC-${i.id}">
        <button class="close" data-act="close-issue" aria-label="Close panel">Close</button>
        <div class="mono dim">FTC-${i.id}</div>
        <h2>${esc(i.title)}</h2>
        <div class="props">
          <span>Status</span>${sel("status", Object.entries(F.status), i.status)}
          <span>Priority</span>${sel("pri", Object.entries(F.pri), i.pri)}
          <span>Assignee</span>${sel("who", F.people.map((p) => [p.id, p.name]), i.who[0])}
          <span>Subsystem</span>${sel("sub", Object.entries(F.subs), i.sub)}
          <span>Due</span><input type="date" data-field="due" data-id="${i.id}" value="${i.due || ""}" aria-label="Due date">
        </div>
        ${i.status === "blocked" ? `<div class="callout"><b>Blocked</b><textarea class="in" rows="2" data-blockedby="${i.id}" placeholder="What is it waiting on?" aria-label="Blocked by">${esc(i.blockedBy || "")}</textarea></div>` : ""}
        <div class="sec"><h3>Description</h3><textarea class="in" rows="${i.desc ? 4 : 2}" data-desc="${i.id}" placeholder="Add details" aria-label="Description">${esc(i.desc || "")}</textarea></div>
        <div class="sec"><h3>GitHub</h3>${gitBlock(i)}</div>
        ${i.status === "done" ? `<div class="sec"><h3>Notebook</h3>${i.logged
          ? `<p class="dim">Logged in the engineering notebook.</p>`
          : `<div class="git"><span class="dim" style="flex:1">No notebook entry yet.</span><button class="btn pri" data-draft="${i.id}">Draft entry</button></div>`}</div>` : ""}
        <div class="sec"><h3>Activity</h3>
          ${act.map((a) => `<div class="act">${av(a.who)}<div><p>${a.text.startsWith("created") ? `<b>${esc(F.person(a.who).name)}</b> ${esc(a.text)}` : esc(a.text)}</p><small>${F.fmt(a.date)}${a.text.startsWith("created") ? "" : " · " + esc(F.person(a.who).name)}</small></div></div>`).join("")}
          <form class="cmt" data-cmt="${i.id}"><input class="in" name="t" placeholder="Leave a comment" autocomplete="off"><button class="btn">Send</button></form>
        </div>
        ${isAdmin() ? `<div class="sec"><button class="btn ghost" data-rm="issues:${i.id}">Delete issue</button></div>` : ""}
      </aside>`;
  };
  const gitBlock = (i) => {
    if (i.branch) {
      return `<div class="git">${ico("git")}<span class="mono">${esc(i.branch)}</span><span class="chip" style="margin-left:auto">${i.merged ? "Merged" : i.pr ? "PR #" + i.pr + " open" : "Branch only"}</span></div>`;
    }
    return `<div class="git">${ico("git")}<span class="mono">${esc(branchName(i))}</span><button class="btn" style="margin-left:auto" data-copy="${esc(branchName(i))}">Copy</button></div>
      <p class="faint" style="margin-top:6px">Suggested branch name. Using it links the PR to this issue once GitHub sync is on.</p>`;
  };

  /* ---------- views ---------- */
  const views = {};

  views.issues = () => {
    const tabs = [["open", "Open"], ["mine", "Mine"], ["blocked", "Blocked"], ["notebook", "Needs notebook"], ["all", "All"]];
    const l = filterIssues();
    let body;
    if (!l.length) {
      body = `<div class="empty"><b>${F.issues.length ? "Nothing here" : "No issues yet"}</b>${S.view === "blocked" ? "No blocked issues. Nice." : "Press C to create one."}</div>`;
    } else if (S.mode === "board") {
      const order = ["todo", "doing", "review", "blocked", "done"];
      body = `<div class="board">${order.map((s) => {
        const c = l.filter((i) => i.status === s);
        return `<div class="col" data-drop="${s}"><h4>${statusIcon(s)}${F.status[s]}<span>${c.length}</span></h4>${c.map(cardHtml).join("")}</div>`;
      }).join("")}</div>`;
    } else {
      body = grouped().map(([s, a]) => `<div class="gh">${statusIcon(s)}<b>${F.status[s]}</b><span>${a.length}</span></div>${a.map(rowHtml).join("")}`).join("");
    }
    const subTitle = S.sub ? F.subs[S.sub] : S.view === "mine" ? "My issues" : "Issues";
    return `
      <div class="ph"><h1>${subTitle}</h1>
        <div class="tabs">${tabs.map(([k, l2]) => `<button class="tab ${S.view === k ? "on" : ""}" data-view="${k}">${l2}</button>`).join("")}</div>
        <div class="r">
          <label class="sr" for="subf">Subsystem</label>
          <select class="pillsel" id="subf" data-subf><option value="">All subsystems</option>${Object.entries(F.subs).map(([k, v]) => `<option value="${k}" ${S.sub === k ? "selected" : ""}>${v}</option>`).join("")}</select>
          <div class="seg"><button class="${S.mode === "list" ? "on" : ""}" data-mode="list">List</button><button class="${S.mode === "board" ? "on" : ""}" data-mode="board">Board</button></div>
          <button class="btn pri" data-act="new">New issue</button>
        </div>
      </div>
      <div class="split"><div class="list">${body}</div>${panelHtml()}</div>`;
  };

  const liIssue = (i, right = "") => `<button class="li" data-issue-go="${i.id}">${statusIcon(i.status)}<span class="t">${esc(i.title)}</span><span class="r">${right}</span></button>`;

  views.home = () => {
    const q = qualifier();
    const nextMs = F.milestones.filter((m) => F.days(m.date) > 0 && !m.main)[0];
    const role = S.role;
    const healthBlk = `
      <div class="blk"><h3>Robot health<button data-go="issues" data-clear>All issues</button></h3>
        ${F.robotSubs.map((k) => { const h = health(k); return `<button class="li" data-sub="${k}">${dot(h.s)}<span class="t">${F.subs[k]}</span><span class="r">${h.label}${h.n ? " · " + h.n + " open" : ""}</span></button>`; }).join("")}
      </div>`;
    const attnItems = [
      ...blocked().map((i) => liIssue(i, "Blocked")),
      ...F.issues.filter((i) => isOpen(i) && i.status !== "blocked" && i.due && F.days(i.due) <= 3).map((i) => liIssue(i, F.days(i.due) < 0 ? "Overdue" : "Due " + F.fmt(i.due))),
      ...(debt().length ? [`<button class="li" data-go="notebook"><span class="dot warn"></span><span class="t">${debt().length} finished ${debt().length === 1 ? "issue has" : "issues have"} no notebook entry</span><span class="r">Notebook</span></button>`] : []),
    ];
    const attention = `<div class="blk"><h3>Needs attention</h3>${attnItems.join("") || '<p class="hint">Nothing is blocked or overdue.</p>'}</div>`;
    const myList = role === "programmer" ? mine().filter((i) => i.type === "code") : mine();
    const myBlk = `<div class="blk"><h3>${role === "programmer" ? "My code issues" : "Assigned to me"}<button data-view-go="mine">View all</button></h3>${myList.map((i) => liIssue(i, dueChip(i))).join("") || '<p class="hint">Nothing assigned.</p>'}</div>`;
    const last = F.practice[F.practice.length - 1];
    const practiceBlk = `<div class="blk"><h3>Practice<button data-go="practice">Open</button></h3>${last
      ? `<div style="display:flex;align-items:baseline;gap:10px;padding:10px 0 4px"><span class="big">${last.auto}/10</span><span class="dim">auto success, ${F.fmt(last.date)}</span></div>
        <div class="chart">${chart(F.practice.map((p) => p.auto), { min: 0, max: 10, h: 64, labels: false })}</div>`
      : '<p class="hint">No sessions logged yet.</p>'}</div>`;
    const partsNeeded = F.parts.filter((p) => p.have < p.need);
    const partsBlk = `<div class="blk"><h3>Parts we still need<button data-go="parts">Open</button></h3>${partsNeeded.map((p) => `<button class="li" data-go="parts"><span class="t">${esc(p.name)}</span><span class="r">${p.have} of ${p.need}${p.ordered ? " · " + p.ordered + " ordered" : ""}</span></button>`).join("") || '<p class="hint">Nothing missing.</p>'}</div>`;
    const gitBlk = `<div class="blk"><h3>GitHub</h3>${S.repo
      ? `<p class="hint">Repo saved as <span class="mono">${esc(S.repo)}</span>. Live PR status is not wired up yet.</p>`
      : `<p class="hint">No repo yet. Add one when you create it so branch names and links show up on issues.</p><button class="btn" data-act="github">Connect GitHub</button>`}</div>`;

    let left, right;
    if (role === "programmer") { left = [attention, myBlk]; right = [gitBlk, practiceBlk, healthBlk]; }
    else if (role === "builder") { left = [myBlk, partsBlk]; right = [healthBlk, attention]; }
    else { left = [healthBlk, partsBlk]; right = [attention, myBlk, practiceBlk, gitBlk]; }
    const greeting = { captain: "Captain view", programmer: "Programmer view", builder: "Builder view" }[role];
    const hero = q
      ? `<h1>${F.days(q.date) < 0 ? "The " + q.name.toLowerCase() + " was " + Math.abs(F.days(q.date)) + " days ago" : F.days(q.date) === 0 ? "The " + q.name.toLowerCase() + " is today" : F.days(q.date) + " days to the " + q.name.toLowerCase()}</h1>
         <p>${F.fmt(q.date)}.${nextMs ? ` Next up: ${esc(nextMs.name.toLowerCase())} on ${F.fmt(nextMs.date)}, ${F.days(nextMs.date)} days away.` : ""}</p>`
      : `<h1>${esc(F.team.num)} ${esc(F.team.name)}</h1><p>${isAdmin() ? "Add your qualifier date in Settings to start the countdown." : "No qualifier date has been set yet."}</p>`;
    return `<div class="wrap"><div class="hero"><small>${greeting}</small>${hero}</div><div class="cols"><div>${left.join("")}</div><div>${right.join("")}</div></div></div>`;
  };

  /* line chart (single series) */
  function chart(vals, { min = 0, max = 10, h = 120, labels = true, dates = [] } = {}) {
    const w = 420, pl = labels ? 28 : 4, pr = 8, pt = 8, pb = labels ? 22 : 6;
    const n = vals.length, iw = w - pl - pr, ih = h - pt - pb;
    const x = (k) => pl + (n === 1 ? iw / 2 : (k * iw) / (n - 1));
    const y = (v) => pt + ih - ((Math.min(max, Math.max(min, v)) - min) / (max - min)) * ih;
    const pts = vals.map((v, k) => `${x(k).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
    const grid = labels ? [min, (min + max) / 2, max].map((g) => `<line class="grid" x1="${pl}" x2="${w - pr}" y1="${y(g)}" y2="${y(g)}"/><text class="lab" x="${pl - 6}" y="${y(g) + 4}" text-anchor="end">${Math.round(g)}</text>`).join("") : "";
    const xl = labels ? dates.map((d, k) => k % 2 === 0 || n < 5 ? `<text class="lab" x="${x(k)}" y="${h - 4}" text-anchor="middle">${F.fmt(d)}</text>` : "").join("") : "";
    return `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Trend, latest ${vals[n - 1]}">${grid}${xl}<polyline class="ln" points="${pts}"/>${vals.map((v, k) => `<circle class="pt ${k === n - 1 ? "last" : ""}" cx="${x(k)}" cy="${y(v)}" r="3.5"/>`).join("")}</svg>`;
  }

  const addDays = (s, n) => { const d = F.parse(s); d.setDate(d.getDate() + n); return F.iso(d); };

  views.season = () => {
    const dates = [...F.phases.flatMap((p) => [p.start, p.end]), ...F.milestones.map((m) => m.date), F.today].sort();
    const start = F.parse(addDays(dates[0], -7)), end = F.parse(addDays(dates[dates.length - 1], 7));
    const span = end - start;
    const pct = (s) => ((F.parse(s) - start) / span) * 100;
    const months = [];
    for (let d = new Date(start.getFullYear(), start.getMonth() + 1, 1); d <= end; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) months.push([d.toLocaleDateString("en-US", { month: "short" }), F.iso(d)]);
    const todayP = pct(F.today);
    const admin = isAdmin();
    const has = F.phases.length || F.milestones.length;
    return `
      <div class="ph"><h1>Season</h1><div class="r">${admin ? `<button class="btn" data-act="new-phase">Add phase</button><button class="btn" data-act="new-milestone">Add milestone</button>` : ""}</div></div>
      <div class="wrap">
        <div class="hero"><h1>${qualifier() ? "Everything between now and the " + esc(qualifier().name.toLowerCase()) : "Plan the season"}</h1><p>Phases can overlap. Milestones are the dates that do not move.</p></div>
        ${has ? `<div class="gantt">
          <div class="gmonths" style="margin-left:130px">${months.map(([m, d]) => `<span style="left:${pct(d)}%">${m}</span>`).join("")}</div>
          ${F.phases.map((p) => {
            const a = pct(p.start), b = pct(p.end), done = Math.max(0, Math.min(100, ((todayP - a) / ((b - a) || 1)) * 100));
            return `<div class="grow"><span class="lab">${esc(p.name)}</span><div class="gtrack"><div class="gbar" style="left:${a}%;width:${Math.max(b - a, 0.5)}%" title="${F.fmt(p.start)} to ${F.fmt(p.end)}"><i style="width:${done}%"></i></div></div></div>`;
          }).join("")}
          <div style="position:absolute;left:130px;right:0;top:0;bottom:0;pointer-events:none">
            ${F.milestones.map((m) => `<div class="gline ${m.main ? "main" : ""}" style="left:${pct(m.date)}%"></div>`).join("")}
            <div class="gline today" style="left:${todayP}%"></div>
          </div>
        </div>` : `<div class="empty"><b>Nothing planned yet</b>${admin ? "Add a phase or a milestone to start the timeline." : "An admin can add phases and milestones."}</div>`}
        ${F.phases.length && admin ? `<div class="blk" style="margin-top:40px"><h3>Phases</h3>${F.phases.map((p) => `<div class="li"><span class="t">${esc(p.name)}</span><span class="r">${F.fmt(p.start)} to ${F.fmt(p.end)}</span><button class="rm" data-rm="phases:${p.id}" aria-label="Remove ${esc(p.name)}">Remove</button></div>`).join("")}</div>` : ""}
        ${F.milestones.length ? `<div class="blk" style="margin-top:40px"><h3>Milestones</h3>
          ${F.milestones.map((m) => { const d = F.days(m.date); return `<div class="li"><span class="dot ${d < 0 ? "ok" : m.main ? "bad" : "warn"}" style="${d < 0 ? "" : "background:var(--faint)"}"></span><span class="t">${esc(m.name)}${m.main ? ' <span class="tag you">Main event</span>' : ""}</span><span class="r">${F.fmt(m.date)} · ${d < 0 ? Math.abs(d) + " days ago" : d === 0 ? "today" : d + " days"}</span>${admin ? `<button class="rm" data-rm="milestones:${m.id}" aria-label="Remove ${esc(m.name)}">Remove</button>` : ""}</div>`; }).join("")}
        </div>` : ""}
      </div>`;
  };

  views.notebook = () => {
    const entries = F.notebook.slice().sort((a, b) => (a.status === "draft" ? -1 : 1) - (b.status === "draft" ? -1 : 1) || b.date.localeCompare(a.date));
    const e = F.notebook.find((x) => x.id === S.nbSel) || entries[0];
    const needs = debt().filter((i) => !F.notebook.some((n) => n.issue === i.id));
    const list = `
      ${needs.length ? `<div class="gh"><b>Needs an entry</b><span>${needs.length}</span></div>${needs.map((i) => `<div class="pi"><b>${esc(i.title)}</b><small>FTC-${i.id} · done</small><div style="margin-top:6px"><button class="btn" data-draft="${i.id}">Draft entry</button></div></div>`).join("")}` : ""}
      <div class="gh"><b>Entries</b><span>${entries.length}</span></div>
      ${entries.map((n) => `<button class="pi ${e && e.id === n.id ? "on" : ""}" data-nb="${n.id}"><b>${esc(n.title)}</b><small>${F.fmt(n.date)} · ${esc(F.person(n.author).name)} ${n.status === "draft" ? '<span class="tag draft">Draft</span>' : ""}</small></button>`).join("")}`;
    const f = (k, label, rows = 3) => `<div class="fld"><label for="nb-${k}">${label}</label><textarea class="in" id="nb-${k}" rows="${rows}" data-nbf="${k}" data-nbid="${esc(e.id)}">${esc(e[k])}</textarea></div>`;
    const editor = e ? `
      <div class="mono dim">${e.issue ? "FTC-" + e.issue : "No linked issue"} · ${F.fmt(e.date)} · ${esc(F.person(e.author).name)}</div>
      <h2>${esc(e.title)} ${e.status === "draft" ? '<span class="tag draft">Draft</span>' : ""}</h2>
      ${f("problem", "Problem")}${f("tried", "What we tried", 4)}${f("result", "Result")}${f("next", "Next step", 2)}
      <div style="margin-top:20px;display:flex;gap:8px;align-items:center">${e.status === "draft" ? `<button class="btn pri" data-finalize="${esc(e.id)}">Mark as logged</button>` : `<span class="dim">Logged. Judges will see this in the notebook.</span>`}<button class="btn ghost" data-rm="notebook:${esc(e.id)}">Delete</button></div>`
      : `<div class="empty"><b>No entries yet</b>Finish an issue and draft one here, or start a blank entry.</div>`;
    return `<div class="ph"><h1>Engineering notebook</h1><div class="r"><button class="btn" data-act="new-entry">New entry</button></div></div><div class="pane2"><div class="pl">${list}</div><div class="pr">${editor}</div></div>`;
  };

  views.parts = () => {
    const spent = F.parts.reduce((s, p) => s + Math.min(p.have + p.ordered, p.need) * p.price, 0);
    const pct = F.budget ? Math.min(100, (spent / F.budget) * 100) : 0;
    const num = (p, k) => `<input class="in num-in" type="number" min="0" data-pf="${k}" data-pid="${esc(p.id)}" value="${p[k]}" aria-label="${esc(p.name)} ${k}">`;
    return `
      <div class="ph"><h1>Parts</h1></div>
      <div class="wrap">
        <div class="hero"><h1>$${spent.toFixed(0)}${F.budget ? ` of $${F.budget.toLocaleString()}` : ""}</h1><p>Counts everything we own or have ordered.${F.budget ? "" : (isAdmin() ? " Set a budget in Settings to track it." : "")}</p>
          ${F.budget ? `<div class="bar ${spent > F.budget ? "over" : ""}" style="margin-top:14px"><i style="width:${pct}%"></i></div>` : ""}</div>
        <form class="form parts" data-addpart>
          <input class="in" name="name" placeholder="Part name" required aria-label="Part name">
          <select class="in" name="sub" aria-label="Subsystem">${Object.entries(F.subs).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select>
          <input class="in" type="number" min="0" name="have" placeholder="Have" aria-label="Have">
          <input class="in" type="number" min="0" name="need" placeholder="Need" required aria-label="Need">
          <input class="in" type="number" min="0" step="0.01" name="price" placeholder="Price" aria-label="Unit price">
          <input class="in" name="vendor" placeholder="Vendor" aria-label="Vendor">
          <button class="btn pri">Add part</button>
        </form>
        ${F.parts.length ? `<table>
          <thead><tr><th>Part</th><th>Subsystem</th><th class="num">Have</th><th class="num">Ordered</th><th class="num">Need</th><th>Status</th><th class="num">Unit</th><th>Vendor</th><th></th></tr></thead>
          <tbody>${F.parts.map((p) => {
            const st = p.have >= p.need ? ["ok", "In stock"] : p.have + p.ordered >= p.need ? ["warn", "Ordered"] : ["bad", "Needed"];
            return `<tr><td>${esc(p.name)}</td><td class="dim">${F.subs[p.sub]}</td><td class="num">${num(p, "have")}</td><td class="num">${num(p, "ordered")}</td><td class="num">${num(p, "need")}</td><td>${dot(st[0])} ${st[1]}</td><td class="num">$${p.price.toFixed(2)}</td><td class="dim">${esc(p.vendor)}</td><td><button class="rm" data-rm="parts:${esc(p.id)}" aria-label="Remove ${esc(p.name)}">Remove</button></td></tr>`;
          }).join("")}</tbody>
        </table>` : `<div class="empty"><b>No parts yet</b>Add what you own and what you still need.</div>`}
      </div>`;
  };

  views.practice = () => {
    const p = F.practice;
    const last = p[p.length - 1];
    return `
      <div class="ph"><h1>Practice</h1></div>
      <div class="wrap">
        ${last ? `<div class="charts">
          <div class="chart"><div class="dim">Auto success, out of 10</div><div class="big" style="margin:2px 0 8px">${last.auto}/10</div>${chart(p.map((x) => x.auto), { min: 0, max: 10, dates: p.map((x) => x.date) })}</div>
          <div class="chart"><div class="dim">Average cycle time, seconds</div><div class="big" style="margin:2px 0 8px">${last.cycle} s</div>${chart(p.map((x) => x.cycle), { min: Math.max(0, Math.floor(Math.min(...p.map((x) => x.cycle)) / 5) * 5 - 5), max: Math.ceil(Math.max(...p.map((x) => x.cycle)) / 5) * 5 + 5, dates: p.map((x) => x.date) })}</div>
        </div>` : ""}
        <div class="blk"><h3>Log a session</h3>
          <form class="form" data-prac>
            <input class="in" type="date" name="date" value="${F.today}" aria-label="Date">
            <select class="in" name="driver" aria-label="Driver">${F.people.map((x) => `<option value="${esc(x.id)}" ${x.id === F.me ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select>
            <input class="in" type="number" name="auto" min="0" max="10" placeholder="Auto /10" required aria-label="Auto successes out of 10">
            <input class="in" type="number" name="cycle" min="1" max="600" step="0.1" placeholder="Cycle s" required aria-label="Cycle time in seconds">
            <input class="in" name="note" placeholder="What happened?" aria-label="Notes">
            <button class="btn pri">Log</button>
          </form></div>
        ${p.length ? `<table>
          <thead><tr><th>Date</th><th>Driver</th><th class="num">Auto</th><th class="num">Cycle</th><th>Notes</th><th></th></tr></thead>
          <tbody>${p.slice().reverse().map((x) => `<tr><td>${F.fmt(x.date)}</td><td>${esc(F.person(x.driver).name)}</td><td class="num">${x.auto}/10</td><td class="num">${x.cycle} s</td><td class="dim">${esc(x.note)}</td><td><button class="rm" data-rm="practice:${esc(x.id)}" aria-label="Remove session">Remove</button></td></tr>`).join("")}</tbody>
        </table>` : `<div class="empty"><b>No sessions yet</b>Log your first practice run above.</div>`}
      </div>`;
  };

  views.meetings = () => {
    const m = F.meetings.find((x) => x.id === S.mtSel) || F.meetings[0];
    const head = `<div class="ph"><h1>Meetings</h1><div class="r"><button class="btn" data-act="new-meeting">New meeting</button></div></div>`;
    if (!m) return head + `<div class="empty"><b>No meetings yet</b>Create one to keep an agenda, notes and action items.</div>`;
    const list = F.meetings.map((x) => `<button class="pi ${x.id === m.id ? "on" : ""}" data-mt="${esc(x.id)}"><b>${esc(x.title)}</b><small>${F.fmt(x.date)}${F.days(x.date) >= 0 ? " · upcoming" : ""} · ${x.who.length} people</small></button>`).join("");
    return `${head}
      <div class="pane2"><div class="pl">${list}</div>
      <div class="pr"><div class="dim">${F.fmt(m.date)}</div><h2>${esc(m.title)}</h2>
        <div class="chips" role="group" aria-label="Attendees">${F.people.map((p) => `<button class="chip ${m.who.includes(p.id) ? "on" : ""}" data-attend="${esc(m.id)}:${esc(p.id)}" aria-pressed="${m.who.includes(p.id)}">${esc(p.name)}</button>`).join("")}</div>
        <div class="sec"><h3>Agenda</h3>${m.agenda.map((a, k) => `<div class="li"><span class="t">${esc(a)}</span><button class="rm" data-agenda-rm="${esc(m.id)}:${k}" aria-label="Remove agenda item">Remove</button></div>`).join("")}
          <form class="formrow" data-agenda="${esc(m.id)}"><input class="in" name="t" placeholder="Add an agenda item" autocomplete="off" aria-label="Agenda item"><button class="btn">Add</button></form></div>
        <div class="sec"><h3>Notes</h3><textarea class="in" rows="6" data-mtnotes="${esc(m.id)}" placeholder="What was decided?" aria-label="Notes">${esc(m.notes)}</textarea></div>
        <div class="sec"><h3>Action items</h3>
          ${m.actions.map((a) => `<div class="li">${av(a.who)}<span class="t">${esc(a.text)}</span>${a.issue
            ? `<button class="chip mono" data-issue-go="${a.issue}">FTC-${a.issue}</button>`
            : `<button class="btn" data-mkissue="${esc(m.id)}:${esc(a.id)}">Make issue</button>`}<button class="rm" data-action-rm="${esc(m.id)}:${esc(a.id)}" aria-label="Remove action item">Remove</button></div>`).join("") || '<p class="hint">No action items.</p>'}
          <form class="formrow" data-action="${esc(m.id)}"><input class="in" name="t" placeholder="Add an action item" autocomplete="off" aria-label="Action item" required>
            <select class="in" name="who" style="max-width:130px" aria-label="Owner">${F.people.map((p) => `<option value="${esc(p.id)}" ${p.id === F.me ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select><button class="btn">Add</button></form>
        </div>
        <div class="sec"><button class="btn ghost" data-rm="meetings:${esc(m.id)}">Delete meeting</button></div></div></div>`;
  };

  views.pit = () => {
    const q = qualifier();
    return `<div class="pitwrap">
      <header><div><div class="dim" style="font-size:18px">${esc(F.team.num)} ${esc(F.team.name)}</div>
        ${q ? `<div class="pit-num">${Math.max(0, F.days(q.date))} days</div><div class="dim" style="font-size:22px">to the ${esc(q.name.toLowerCase())}, ${F.fmt(q.date)}</div>` : `<div class="pit-num">Pit board</div>`}</div>
        <button class="btn x" data-go="home">Exit pit board</button></header>
      <div class="pit-grid">${F.robotSubs.map((k) => { const h = health(k); return `<div>${dot(h.s)}${F.subs[k]}<small>${h.label}${h.n ? ", " + h.n + " open" : ""}</small></div>`; }).join("")}</div>
      <div class="pit-two">
        <div><h3>Blocked</h3>${blocked().map((i) => `<p>${esc(i.title)}</p>`).join("") || "<p>Nothing blocked.</p>"}</div>
        <div><h3>Next up</h3>${F.issues.filter((i) => isOpen(i) && i.pri === "high" && i.status !== "blocked").map((i) => `<p>${esc(i.title)}</p>`).join("") || "<p>No high priority work open.</p>"}</div>
      </div></div>`;
  };

  views.settings = () => {
    const tabs = [["profile", "Profile"], ["workspace", "Workspace"], ["appearance", "Appearance"], ["notifications", "Notifications"], ["members", "Members"], ["integrations", "Integrations"]];
    const admin = isAdmin();
    const row = (title, desc, ctl) => `<div class="setrow"><div><b>${title}</b>${desc ? `<small>${desc}</small>` : ""}</div>${ctl}</div>`;
    const field = (key, val, label, type = "text", locked = false, extra = "") => `<input class="in" type="${type}" data-set="${key}" value="${esc(val)}" aria-label="${label}" ${locked ? "disabled" : ""} ${extra}>`;
    const tgl = (k, label, off = false) => `<button class="tgl" role="switch" aria-checked="${!!S.prefs[k]}" aria-label="${label}" data-tgl="${k}" ${off ? "disabled" : ""}></button>`;
    const segBtns = (attr, cur, opts) => `<div class="seg">${opts.map(([v, l]) => `<button class="${cur === v ? "on" : ""}" ${attr}="${v}" aria-pressed="${cur === v}">${l}</button>`).join("")}</div>`;
    const me = F.person(F.me);
    const q = qualifier();
    const lockNote = admin ? "" : `<p class="faint" style="margin-top:6px">Only admins can change these.</p>`;
    let body = "";
    if (S.setTab === "profile") {
      body = `<h2>Profile</h2><p class="dim">How you show up to the team. Signed in as <span class="mono">${esc(S.user.username)}</span> (${S.user.access}).</p><div class="box" style="margin-top:16px">
        ${row("Display name", "Shown on issues and comments.", field("dname", me.name, "Display name"))}
        ${row("Role", "Your title on the team.", field("drole", me.role, "Role"))}
        ${row("Default view", "What Home shows. Saved on this device.", `<select class="in" data-set="role" aria-label="Default view" style="width:220px">${[["captain", "Captain"], ["programmer", "Programmer"], ["builder", "Builder"]].map(([k, l]) => `<option value="${k}" ${S.role === k ? "selected" : ""}>${l}</option>`).join("")}</select>`)}
        ${row("Password", "", `<button class="btn" data-act="change-password">Change password</button>`)}
      </div>`;
    } else if (S.setTab === "workspace") {
      body = `<h2>Workspace</h2><p class="dim">Team identity, dates and budget.</p>${lockNote}
        <h3 class="sh">Identity</h3><div class="box">
        ${row("Team name", "", field("tname", F.team.name, "Team name", "text", !admin))}
        ${row("Team number", "", field("tnum", F.team.num, "Team number", "text", !admin))}
        ${row("Short name", "What you call yourselves. Used on the logo mark.", field("tshort", F.team.short, "Short name", "text", !admin, 'maxlength="8"'))}
        ${row("Season", "", field("tseason", F.team.season, "Season", "text", !admin))}
        ${row("Logo", "PNG or SVG under 300 KB. Shown in the sidebar.", `<div class="avl">${logoHtml()}${admin ? `<label class="btn filebtn">Upload<input type="file" accept="image/*" data-logo></label>${F.team.logo ? `<button class="btn ghost" data-logo-clear>Remove</button>` : ""}` : ""}</div>`)}
      </div><h3 class="sh">Season</h3><div class="box">
        ${row("Qualifier date", q ? `The countdown on Home and the pit board uses this. Currently ${F.days(q.date)} days away.` : "Starts the countdown on Home and the pit board.", field("qual", q ? q.date : "", "Qualifier date", "date", !admin))}
        ${row("Parts budget", "Dollars. Leave at 0 to hide the budget bar.", field("budget", F.budget, "Parts budget", "number", !admin, 'min="0" step="10"'))}
      </div><h3 class="sh">Backup</h3><div class="box">
        ${row("Download everything", "A JSON copy of all issues, notes and settings. Passwords are not included.", admin ? `<a class="btn" href="/api/export" download>Download backup</a>` : `<span class="faint">Admins only</span>`)}
      </div>`;
    } else if (S.setTab === "appearance") {
      body = `<h2>Appearance</h2><p class="dim">Saved on this device.</p><div class="box" style="margin-top:16px">
        ${row("Theme", "", segBtns("data-theme-set", themePref(), [["dark", "Dark"], ["light", "Light"], ["system", "System"]]))}
        ${row("Accent color", "Used for selection, buttons and links.", `<div class="swatches">${ACCENTS.map(([v, n, c]) => `<button class="sw" style="--c:${c}" title="${n}" aria-label="${n}" aria-pressed="${S.accent === v}" data-accent="${v}"></button>`).join("")}</div>`)}
        ${row("Density", "Compact fits more issues on a laptop screen.", segBtns("data-density", S.density, [["comfortable", "Comfortable"], ["compact", "Compact"]]))}
      </div>`;
    } else if (S.setTab === "notifications") {
      body = `<h2>Notifications</h2><p class="dim">Your choices are saved on this device. Delivery (email or push) is not built yet.</p><div class="box" style="margin-top:16px">
        ${row("Due soon", "An issue assigned to you is due within 2 days.", tgl("due", "Due soon"))}
        ${row("Blocked", "Something you depend on becomes blocked.", tgl("blocked", "Blocked"))}
        ${row("Mentions", "Someone comments on your issue or mentions you.", tgl("mention", "Mentions"))}
        ${row("Review requests", "A pull request needs your review.", tgl("pr", "Review requests"))}
        ${row("Weekly digest", "A Sunday summary of the week and what is next.", tgl("digest", "Weekly digest"))}
      </div>`;
    } else if (S.setTab === "members") {
      body = `<h2>Members</h2><p class="dim">${F.people.length} ${F.people.length === 1 ? "person" : "people"}. Admins can add members, change access and reset passwords.</p>
        ${admin ? `<div style="margin:16px 0"><button class="btn pri" data-act="add-member">Add member</button></div>` : ""}
        <div class="box" style="padding-top:4px;padding-bottom:4px">${F.people.map((p) => `<div class="setrow"><div class="avl">${av(p.id)}<div><b>${esc(p.name)}${p.id === F.me ? ' <span class="tag you">You</span>' : ""}</b><small>${esc(p.role)}${p.username ? " · " + esc(p.username) : ""}</small></div></div>
          <div class="avl">${admin && p.id !== F.me ? `<button class="btn ghost" data-reset="${esc(p.id)}">Reset password</button>` : ""}
          <select class="in" style="width:130px" data-member="${esc(p.id)}" aria-label="Access for ${esc(p.name)}" ${admin ? "" : "disabled"}>${["Admin", "Member", "Mentor", "Viewer"].map((a) => `<option ${p.access === a ? "selected" : ""}>${a}</option>`).join("")}</select></div></div>`).join("")}</div>
        <p class="faint" style="margin-top:8px">Viewers can read everything but cannot change anything.</p>`;
    } else {
      body = `<h2>Integrations</h2><p class="dim">Connect the tools the team already uses.</p>${lockNote}
        <h3 class="sh">GitHub</h3><div class="box">
        ${row("Repository", S.repo ? "Saved. Live PR sync is not built yet." : "No repo connected yet.", S.repo ? `<div class="avl"><span class="mono">${esc(S.repo)}</span>${admin ? `<button class="btn" data-gh-disc>Disconnect</button>` : ""}</div>` : (admin ? `<button class="btn pri" data-act="github">Connect GitHub</button>` : ""))}
        ${row("Branch prefix", "Suggested branch names start with this.", field("prefix", S.branchPrefix, "Branch prefix", "text", !admin, 'maxlength="20"'))}
        ${row("Move issues with pull requests", "Opening a PR sets In review. Merging sets Done. Needs GitHub sync.", tgl("autopr", "Move issues with pull requests", true))}
      </div>`;
    }
    return `<div class="ph"><h1>Settings</h1></div>
      <div class="pane2"><div class="pl" role="tablist" aria-label="Settings sections">${tabs.map(([k, l]) => `<button class="pi ${S.setTab === k ? "on" : ""}" role="tab" aria-selected="${S.setTab === k}" data-set-tab="${k}"><b>${l}</b></button>`).join("")}</div>
      <div class="pr">${body}</div></div>`;
  };

  /* ---------- sign in, setup ---------- */
  function authScreen(html) {
    S.ready = false;
    if (S.es) { S.es.close(); S.es = null; }
    $("#app").className = "app auth";
    $("#page").innerHTML = `<div class="authwrap">${html}</div>`;
    $("#ov-modal").classList.remove("show");
    const f = $("#page input"); if (f) f.focus();
  }
  const teamMark = () => { const t = S.session && S.session.team; return t ? `<span class="logo ${t.logo ? "img" : ""}" ${t.logo ? `style="background-image:url('${esc(t.logo)}')"` : ""}>${esc(t.short || "008")}</span>` : '<span class="logo">008</span>'; };

  function showLogin(message = "") {
    const t = S.session && S.session.team;
    authScreen(`<form class="authbox" data-login>
      ${teamMark()}
      <h1>${t ? `Sign in to ${esc(t.num)} ${esc(t.name)}` : "Sign in"}</h1>
      <div><label for="lg-u">Username</label><input class="in" id="lg-u" name="username" autocomplete="username" autocapitalize="off" spellcheck="false" required></div>
      <div><label for="lg-p">Password</label><input class="in" id="lg-p" name="password" type="password" autocomplete="current-password" required></div>
      <p class="err" role="alert" id="auth-err">${esc(message)}</p>
      <button class="btn pri">Sign in</button>
      ${S.session && S.session.demo ? '<p class="faint">Demo data is loaded. Try joseph with the password innovators.</p>' : ""}
    </form>`);
  }
  function showSetup() {
    const now = new Date(), y = now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1;
    authScreen(`<form class="authbox wide" data-setup>
      <span class="logo">008</span>
      <h1>Set up your workspace</h1>
      <p class="dim">This is a fresh install. Tell us about the team, then create the first admin account. You can add everyone else afterwards.</p>
      <div class="two"><div><label for="st-n">Team number</label><input class="in" id="st-n" name="num" required maxlength="12" inputmode="numeric"></div>
        <div><label for="st-s">Short name</label><input class="in" id="st-s" name="short" maxlength="8" placeholder="What you call yourselves"></div></div>
      <div class="two"><div><label for="st-t">Team name</label><input class="in" id="st-t" name="name" required maxlength="60"></div>
        <div><label for="st-y">Season</label><input class="in" id="st-y" name="season" value="${y}–${String(y + 1).slice(2)}" maxlength="20"></div></div>
      <div><label for="st-q">Qualifier date (optional)</label><input class="in" id="st-q" name="qualifier" type="date"></div>
      <div class="two"><div><label for="st-a">Your name</label><input class="in" id="st-a" name="aname" required maxlength="60" autocomplete="name"></div>
        <div><label for="st-u">Username</label><input class="in" id="st-u" name="username" required autocomplete="username" autocapitalize="off" spellcheck="false"></div></div>
      <div><label for="st-p">Password (8 or more characters)</label><input class="in" id="st-p" name="password" type="password" minlength="8" required autocomplete="new-password"></div>
      <p class="err" role="alert" id="auth-err"></p>
      <button class="btn pri">Create workspace</button>
    </form>`);
  }
  function showPasswordGate(message = "") {
    authScreen(`<form class="authbox" data-pw-forced>
      ${teamMark()}
      <h1>Choose a new password</h1>
      <p class="dim">You signed in with a temporary password. Pick your own before continuing.</p>
      <div><label for="pw-c">Temporary password</label><input class="in" id="pw-c" name="current" type="password" autocomplete="current-password" required></div>
      <div><label for="pw-n">New password (8 or more characters)</label><input class="in" id="pw-n" name="next" type="password" minlength="8" autocomplete="new-password" required></div>
      <p class="err" role="alert" id="auth-err">${esc(message)}</p>
      <button class="btn pri">Save password</button>
    </form>`);
  }
  const authError = (m) => { const e = $("#auth-err"); if (e) e.textContent = m; };

  function sessionEnded() {
    S.ready = false;
    call("GET", "/api/session").then((s) => { S.session = s; showLogin("Your session ended. Sign in again."); }).catch(() => showLogin("Your session ended. Sign in again."));
  }

  async function enter(user) {
    S.user = user;
    if (user.mustChange) return showPasswordGate();
    applyState(await call("GET", "/api/state"));
    S.ready = true;
    S.view = S.role === "captain" ? "open" : "mine";
    $("#app").className = "app";
    connectEvents();
    render();
  }

  async function boot() {
    loadUi();
    try { const a = localStorage.getItem("008-accent"); if (a) applyAccent(a); } catch (e) { /* ignore */ }
    parseHash();
    try {
      S.session = await call("GET", "/api/session");
      if (S.session.needsSetup) return showSetup();
      if (!S.session.user) return showLogin();
      await enter(S.session.user);
    } catch (e) {
      authScreen(`<div class="authbox"><h1>Can't reach the server</h1><p class="dim">${esc(e.message)}. Check that it's running, then reload.</p><button class="btn pri" data-act="reload">Reload</button></div>`);
    }
  }

  /* ---------- render ---------- */
  function render() {
    if (!S.ready) return;
    const keep = ["list", "panel"].map((c) => { const el = $("." + c); return el ? el.scrollTop : 0; });
    const route = S.route === "mine" ? "issues" : S.route;
    const view = views[route] || views.home;
    const app = $("#app");
    app.className = ("app " + (route === "pit" ? "pit " : "") + "role-" + S.role + (S.density === "compact" ? " dense" : "")).trim();
    $("#side").innerHTML = sideHtml();
    $("#page").innerHTML = view();
    const l = $(".list"), p = $(".panel");
    if (l) l.scrollTop = keep[0];
    if (p) p.scrollTop = keep[1];
    document.title = `${F.team.short || "008"} Workspace`;
  }

  /* ---------- actions ---------- */
  function toast(text, label, fn) {
    const t = $("#toast");
    t.innerHTML = `<span>${esc(text)}</span>${label ? `<button>${esc(label)}</button>` : ""}`;
    t.classList.add("show");
    if (label) t.querySelector("button").onclick = () => { t.classList.remove("show"); fn(); };
    clearTimeout(S.toastTimer);
    S.toastTimer = setTimeout(() => t.classList.remove("show"), 6500);
  }
  function setStatus(i, s) {
    i.status = s;
    persist("issues", i);
    if (s === "done" && !i.logged) toast(`FTC-${i.id} is done. Add it to the notebook?`, "Draft entry", () => draft(i.id));
  }
  async function draft(id) {
    const i = byId(id);
    let n = F.notebook.find((x) => x.issue === i.id);
    if (!n) {
      try {
        n = await create("notebook", { date: F.today, title: i.title, issue: i.id, author: i.who[0], status: "draft",
          problem: i.desc || i.title, tried: (i.notes || []).map((x) => x.text).join(" "), result: "", next: "" });
      } catch (e) { return writeFailed(e); }
    }
    S.nbSel = n.id;
    go("notebook");
  }
  function openIssue(id) { go("issues/" + id); }

  function showModal(html) { $("#modal").innerHTML = html; $("#ov-modal").classList.add("show"); const f = $("#modal input:not([type=checkbox]), #modal select"); if (f) f.focus(); }
  function closeModal() { $("#ov-modal").classList.remove("show"); if (S.dirty) setTimeout(rerenderIfIdle, 50); }
  const modalErr = (m) => { const e = $("#modal .err"); if (e) e.textContent = m; };
  const footer = (ok, cancel = true) => `<p class="err" role="alert" style="padding:0 18px"></p><div class="ft">${cancel ? '<button type="button" class="btn" data-act="close-modal">Cancel</button>' : ""}<button class="btn pri">${ok}</button></div>`;

  function newIssueModal(seed = {}) {
    showModal(`<form data-new>
      <div class="hd">New issue</div>
      <div class="bd">
        <input class="in" name="title" placeholder="Issue title" value="${esc(seed.title || "")}" required maxlength="200" autocomplete="off" aria-label="Title">
        <div class="fl">
          <div><label for="ni-sub">Subsystem</label><select class="in" id="ni-sub" name="sub">${Object.entries(F.subs).map(([k, v]) => `<option value="${k}" ${k === (seed.sub || S.sub || "team") ? "selected" : ""}>${v}</option>`).join("")}</select></div>
          <div><label for="ni-pri">Priority</label><select class="in" id="ni-pri" name="pri">${Object.entries(F.pri).map(([k, v]) => `<option value="${k}" ${k === "med" ? "selected" : ""}>${v}</option>`).join("")}</select></div>
          <div><label for="ni-who">Assignee</label><select class="in" id="ni-who" name="who">${F.people.map((p) => `<option value="${esc(p.id)}" ${p.id === (seed.who || F.me) ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select></div>
          <div><label for="ni-due">Due</label><input class="in" id="ni-due" type="date" name="due"></div>
        </div>
      </div>${footer("Create issue")}
    </form>`);
  }
  function githubModal() {
    if (!isAdmin()) return toast("Only admins can change integrations.");
    showModal(`<form data-gh>
      <div class="hd">Connect GitHub</div>
      <div class="bd">
        <p class="dim" style="margin-bottom:12px">Saves the repository name for the whole team. Live branch and pull request tracking is not built yet.</p>
        <input class="in mono" name="repo" placeholder="owner/repo" pattern="[A-Za-z0-9_.\\-]+/[A-Za-z0-9_.\\-]+" required maxlength="100" autocomplete="off" aria-label="Repository">
      </div>${footer("Save")}
    </form>`);
  }
  const simpleModal = (attr, title, fields, ok) => showModal(`<form ${attr}><div class="hd">${title}</div><div class="bd">${fields}</div>${footer(ok)}</form>`);

  /* command palette */
  let palItems = [], palIdx = 0;
  function openPalette() {
    $("#ov-pal").classList.add("show");
    const inp = $("#pal-in"); inp.value = ""; palFilter(""); inp.focus();
  }
  function closePalette() { $("#ov-pal").classList.remove("show"); }
  function palFilter(q) {
    q = q.trim().toLowerCase();
    const all = [
      ...[["home", "Home"], ["issues", "Issues"], ["season", "Season"], ["notebook", "Notebook"], ["parts", "Parts"], ["practice", "Practice"], ["meetings", "Meetings"], ["pit", "Pit board"], ["settings", "Settings"]].map(([k, l]) => ({ label: "Go to " + l, hint: "Page", run: () => go(k) })),
      { label: "New issue", hint: "C", run: () => newIssueModal() },
      { label: "Toggle theme", hint: "Action", run: toggleTheme },
      { label: "Connect GitHub", hint: "Action", run: githubModal },
      { label: "Sign out", hint: "Action", run: logout },
      ...F.issues.map((i) => ({ label: `FTC-${i.id}  ${i.title}`, hint: F.status[i.status], run: () => openIssue(i.id) })),
    ];
    palItems = all.filter((x) => !q || x.label.toLowerCase().includes(q)).slice(0, 12);
    palIdx = 0; palDraw();
  }
  function palDraw() {
    $("#pal-list").innerHTML = palItems.length
      ? palItems.map((x, k) => `<li class="${k === palIdx ? "on" : ""}" data-pi="${k}"><b>${esc(x.label)}</b><span class="r">${esc(x.hint)}</span></li>`).join("")
      : '<li class="dim">No matches</li>';
  }
  function palRun(k) { const x = palItems[k]; if (!x) return; closePalette(); x.run(); }

  function toggleTheme() {
    const t = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", t);
    try { localStorage.setItem("008-theme", t); } catch (e) { /* ignore */ }
  }
  async function logout() {
    try { await call("POST", "/api/logout"); } catch (e) { /* already out */ }
    S.ready = false;
    try { S.session = await call("GET", "/api/session"); } catch (e) { /* ignore */ }
    showLogin();
  }
  const showTemp = (title, who, password) => showModal(`<div><div class="hd">${title}</div><div class="bd">
      <p class="dim">Share this with <b>${esc(who)}</b> now. It is only shown once, and they will be asked to choose their own password at first sign-in.</p>
      <div class="pw">${esc(password)}</div><button class="btn" data-copy="${esc(password)}" data-copy-label="Password copied.">Copy password</button></div>
      <div class="ft"><button class="btn pri" data-act="close-modal">Done</button></div></div>`);

  /* ---------- events ---------- */
  document.addEventListener("click", async (e) => {
    const t = e.target;
    const q = (s) => t.closest(s);
    let el;
    if ((el = q("[data-act]")) && el.dataset.act === "reload") { location.reload(); return; }
    if (!S.ready) return;
    if ((el = q("[data-go]"))) { if (el.hasAttribute("data-clear")) { S.view = "open"; S.sub = ""; } const g = el.dataset.go; if (g === "mine") { S.view = "mine"; S.sub = ""; go("issues"); } else if (g === "issues") { if (S.view === "mine") S.view = "open"; S.sub = ""; go("issues"); } else go(g); return; }
    if ((el = q("[data-sub]"))) { S.sub = el.dataset.sub; S.view = "open"; go("issues"); render(); return; }
    if ((el = q("[data-view-go]"))) { S.view = el.dataset.viewGo; S.sub = ""; go("issues"); return; }
    if ((el = q("[data-view]"))) { S.view = el.dataset.view; render(); return; }
    if ((el = q("[data-mode]"))) { S.mode = el.dataset.mode; saveUi(); render(); return; }
    if ((el = q("[data-issue-go]"))) { openIssue(el.dataset.issueGo); return; }
    if ((el = q("[data-issue]"))) { openIssue(el.dataset.issue); return; }
    if ((el = q("[data-draft]"))) { draft(el.dataset.draft); return; }
    if ((el = q("[data-finalize]"))) {
      const n = F.notebook.find((x) => x.id === el.dataset.finalize); if (!n) return;
      n.status = "final"; persist("notebook", n);
      const i = byId(n.issue); if (i) { i.logged = true; persist("issues", i); }
      toast("Saved to the notebook."); render(); return;
    }
    if ((el = q("[data-nb]"))) { S.nbSel = el.dataset.nb; render(); return; }
    if ((el = q("[data-mt]"))) { S.mtSel = el.dataset.mt; render(); return; }
    if ((el = q("[data-copy]"))) { const v = el.dataset.copy; try { await navigator.clipboard.writeText(v); } catch (err) { /* ignore */ } toast(el.dataset.copyLabel || "Branch name copied."); return; }
    if ((el = q("[data-rm]"))) {
      const [coll, id] = el.dataset.rm.split(":");
      const label = { issues: "this issue", notebook: "this notebook entry", meetings: "this meeting", parts: "this part", practice: "this session", milestones: "this milestone", phases: "this phase" }[coll];
      if (!window.confirm(`Delete ${label}? This can't be undone.`)) return;
      try {
        await remove(coll, id);
        if (coll === "issues") go("issues"); else render();
      } catch (err) { writeFailed(err); }
      return;
    }
    if ((el = q("[data-attend]"))) {
      const [mid, pid] = el.dataset.attend.split(":");
      const m = F.meetings.find((x) => x.id === mid); if (!m) return;
      m.who = m.who.includes(pid) ? m.who.filter((x) => x !== pid) : [...m.who, pid];
      persist("meetings", m); render(); return;
    }
    if ((el = q("[data-agenda-rm]"))) {
      const [mid, k] = el.dataset.agendaRm.split(":");
      const m = F.meetings.find((x) => x.id === mid); m.agenda.splice(+k, 1); persist("meetings", m); render(); return;
    }
    if ((el = q("[data-action-rm]"))) {
      const [mid, aid] = el.dataset.actionRm.split(":");
      const m = F.meetings.find((x) => x.id === mid); m.actions = m.actions.filter((a) => a.id !== aid); persist("meetings", m); render(); return;
    }
    if ((el = q("[data-mkissue]"))) {
      const [mid, aid] = el.dataset.mkissue.split(":");
      const m = F.meetings.find((x) => x.id === mid), a = m.actions.find((x) => x.id === aid);
      try {
        const i = await create("issues", { title: a.text, type: "build", sub: "team", pri: "med", status: "todo", who: [a.who], created: F.today, desc: `From the ${m.title.toLowerCase()} on ${F.fmt(m.date)}.` });
        a.issue = i.id; await persist("meetings", m);
        toast(`Created FTC-${i.id}.`, "Open", () => openIssue(i.id)); render();
      } catch (err) { writeFailed(err); }
      return;
    }
    if ((el = q("[data-pi]"))) { palRun(+el.dataset.pi); return; }
    if ((el = q("[data-set-tab]"))) { S.setTab = el.dataset.setTab; render(); return; }
    if ((el = q("[data-tgl]"))) { S.prefs[el.dataset.tgl] = !S.prefs[el.dataset.tgl]; saveUi(); render(); return; }
    if ((el = q("[data-accent]"))) { applyAccent(el.dataset.accent); render(); return; }
    if ((el = q("[data-theme-set]"))) { setThemePref(el.dataset.themeSet); render(); return; }
    if ((el = q("[data-density]"))) { S.density = el.dataset.density; saveUi(); render(); return; }
    if (q("[data-logo-clear]")) { F.team.logo = null; saveTeam(); render(); return; }
    if (q("[data-gh-disc]")) { S.repo = null; saveSettings(); toast("Disconnected from GitHub."); render(); return; }
    if ((el = q("[data-reset]"))) {
      const p = F.person(el.dataset.reset);
      if (!window.confirm(`Reset ${p.name}'s password? They will be signed out everywhere.`)) return;
      try { const r = await write("POST", `/api/users/${p.id}/reset`); showTemp("Password reset", p.name, r.password); } catch (err) { writeFailed(err); }
      return;
    }
    if ((el = q("[data-act]"))) {
      const a = el.dataset.act;
      if (a === "palette") openPalette();
      else if (a === "new") newIssueModal();
      else if (a === "github") githubModal();
      else if (a === "theme") toggleTheme();
      else if (a === "logout") logout();
      else if (a === "menu") $("#app").classList.toggle("open");
      else if (a === "close-modal") closeModal();
      else if (a === "close-issue") go("issues");
      else if (a === "new-entry") simpleModal("data-newentry", "New notebook entry", '<input class="in" name="title" placeholder="Title" required maxlength="200" autocomplete="off" aria-label="Title">', "Create entry");
      else if (a === "new-meeting") simpleModal("data-newmeeting", "New meeting", `<input class="in" name="title" placeholder="Title" required maxlength="200" autocomplete="off" aria-label="Title"><div class="fl"><div><label for="nm-d">Date</label><input class="in" id="nm-d" type="date" name="date" value="${F.today}" required></div></div>`, "Create meeting");
      else if (a === "new-phase") simpleModal("data-newphase", "Add phase", `<input class="in" name="name" placeholder="Name, for example Build" required maxlength="100" autocomplete="off" aria-label="Name"><div class="fl"><div><label for="np-s">Starts</label><input class="in" id="np-s" type="date" name="start" value="${F.today}" required></div><div><label for="np-e">Ends</label><input class="in" id="np-e" type="date" name="end" required></div></div>`, "Add phase");
      else if (a === "new-milestone") simpleModal("data-newmilestone", "Add milestone", `<input class="in" name="name" placeholder="Name, for example Scrimmage" required maxlength="100" autocomplete="off" aria-label="Name"><div class="fl"><div><label for="nl-d">Date</label><input class="in" id="nl-d" type="date" name="date" required></div></div><label style="display:flex;gap:8px;align-items:center;margin-top:12px;color:var(--dim)"><input type="checkbox" name="main"> This is the main event (drives the countdown)</label>`, "Add milestone");
      else if (a === "add-member") simpleModal("data-addmember", "Add a member", `<input class="in" name="name" placeholder="Full name" required maxlength="60" autocomplete="off" aria-label="Name"><div class="fl"><div><label for="am-u">Username</label><input class="in" id="am-u" name="username" required autocapitalize="off" spellcheck="false" autocomplete="off"></div><div><label for="am-a">Access</label><select class="in" id="am-a" name="access">${["Member", "Mentor", "Viewer", "Admin"].map((x) => `<option>${x}</option>`).join("")}</select></div></div><input class="in" name="role" placeholder="Role, for example Build lead" maxlength="80" style="margin-top:10px" autocomplete="off" aria-label="Role">`, "Create account");
      else if (a === "change-password") simpleModal("data-pw", "Change password", '<div><label for="cp-c" style="color:var(--dim);font-size:12px">Current password</label><input class="in" id="cp-c" name="current" type="password" autocomplete="current-password" required></div><div style="margin-top:10px"><label for="cp-n" style="color:var(--dim);font-size:12px">New password (8 or more characters)</label><input class="in" id="cp-n" name="next" type="password" minlength="8" autocomplete="new-password" required></div>', "Save password");
      return;
    }
    if (t.classList.contains("ov")) { closeModal(); closePalette(); }
    if (t.closest(".main") && $("#app").classList.contains("open")) $("#app").classList.remove("open");
  });

  document.addEventListener("keydown", (e) => {
    if (!S.ready) return;
    if (e.key === "Enter" && e.target.matches && e.target.matches(".row")) { openIssue(e.target.dataset.issue); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openPalette(); return; }
    if ($("#ov-pal").classList.contains("show")) {
      if (e.key === "Escape") closePalette();
      else if (e.key === "ArrowDown") { e.preventDefault(); palIdx = Math.min(palIdx + 1, palItems.length - 1); palDraw(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); palIdx = Math.max(palIdx - 1, 0); palDraw(); }
      else if (e.key === "Enter") { e.preventDefault(); palRun(palIdx); }
      return;
    }
    if (e.key === "Escape") {
      if ($("#ov-modal").classList.contains("show")) closeModal();
      else if (S.route === "pit") go("home");
      else if (S.route === "issues" && S.arg) go("issues");
      return;
    }
    const tag = (e.target.tagName || "").toLowerCase();
    if (["input", "textarea", "select"].includes(tag) || e.ctrlKey || e.metaKey || e.altKey) return;
    if ($("#ov-modal").classList.contains("show")) return;
    const k = e.key.toLowerCase();
    if (Date.now() - S.g < 900) {
      S.g = 0;
      const m = { h: "home", i: "issues", s: "season", n: "notebook", p: "parts", r: "practice", m: "meetings", b: "pit", ",": "settings" }[k];
      if (m) { e.preventDefault(); go(m); }
      return;
    }
    if (k === "g") { S.g = Date.now(); return; }
    if (k === "c") { e.preventDefault(); newIssueModal(); return; }
    if (S.route === "issues" && (k === "j" || k === "k")) {
      const l = flat(); if (!l.length) return;
      const at = l.findIndex((i) => i.id === +S.arg);
      const nx = k === "j" ? Math.min(at + 1, l.length - 1) : Math.max(at - 1, 0);
      openIssue(l[at < 0 ? 0 : nx].id);
      return;
    }
    if (S.route === "issues" && S.arg && /^[1-5]$/.test(k)) {
      const i = byId(S.arg), s = ["todo", "doing", "review", "blocked", "done"][+k - 1];
      if (i) { setStatus(i, s); render(); }
    }
  });

  document.addEventListener("change", async (e) => {
    if (!S.ready) return;
    const t = e.target;
    if (t.matches("[data-field]")) {
      const i = byId(t.dataset.id), f = t.dataset.field;
      if (f === "status") setStatus(i, t.value);
      else if (f === "who") { i.who = [t.value, ...i.who.slice(1).filter((x) => x !== t.value)]; persist("issues", i); }
      else if (f === "due") { i.due = t.value || undefined; persist("issues", i); }
      else { i[f] = t.value; persist("issues", i); }
      render();
    } else if (t.matches("[data-subf]")) { S.sub = t.value; S.arg = null; go("issues"); render(); }
    else if (t.matches("[data-role]")) { S.role = t.value; S.view = S.role === "captain" ? "open" : "mine"; S.sub = ""; saveUi(); render(); }
    else if (t.matches("[data-set='role']")) { S.role = t.value; S.view = S.role === "captain" ? "open" : "mine"; saveUi(); render(); }
    else if (t.matches("[data-set='qual']")) {
      if (!t.value) return;
      const m = qualifier();
      try {
        if (m) { m.date = t.value; await persist("milestones", m); }
        else await create("milestones", { name: "Qualifier", date: t.value, main: true });
        render();
      } catch (err) { writeFailed(err); }
    }
    else if (t.matches("[data-member]")) {
      const p = F.person(t.dataset.member), prev = p.access;
      try { await write("PATCH", `/api/users/${p.id}`, { access: t.value }); p.access = t.value; toast(`${p.name} is now ${t.value}.`); }
      catch (err) { t.value = prev; toast(err.message); }
    }
    else if (t.matches("[data-pf]")) {
      const p = F.parts.find((x) => x.id === t.dataset.pid); if (!p) return;
      p[t.dataset.pf] = Math.max(0, Math.round(Number(t.value) || 0)); persist("parts", p); render();
    }
    else if (t.matches("[data-logo]")) {
      const f = t.files && t.files[0]; if (!f) return;
      if (f.size > 300 * 1024) return toast("That logo is over 300 KB. Use a smaller file.");
      const rd = new FileReader(); rd.onload = () => { F.team.logo = rd.result; saveTeam(); render(); }; rd.readAsDataURL(f);
    }
  });

  document.addEventListener("input", (e) => {
    const t = e.target;
    if (t.matches && t.matches("[data-setup] [name=aname]")) { const u = t.form.elements.username; if (!u.dataset.touched) u.value = t.value.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 32); return; }
    if (t.matches && t.matches("[data-setup] [name=username]")) { t.dataset.touched = "1"; return; }
    if (t.matches && t.matches("[data-addmember] [name=name]")) { const u = t.form.elements.username; if (!u.dataset.touched) u.value = t.value.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 32); return; }
    if (t.matches && t.matches("[data-addmember] [name=username]")) { t.dataset.touched = "1"; return; }
    if (!S.ready) return;
    if (t.id === "pal-in") palFilter(t.value);
    else if (t.matches("[data-set]") && t.dataset.set !== "role" && t.dataset.set !== "qual") {
      const v = t.value, k = t.dataset.set;
      if (k === "dname") { F.person(F.me).name = v || "?"; soon("me", saveMe); }
      else if (k === "drole") { F.person(F.me).role = v; soon("me", saveMe); }
      else if (k === "tname") { F.team.name = v; soon("team", saveTeam); }
      else if (k === "tnum") { F.team.num = v; soon("team", saveTeam); }
      else if (k === "tshort") { F.team.short = v; soon("team", saveTeam); }
      else if (k === "tseason") { F.team.season = v; soon("team", saveTeam); }
      else if (k === "prefix") { S.branchPrefix = v; soon("settings", saveSettings); }
      else if (k === "budget") { F.budget = Math.max(0, Number(v) || 0); soon("settings", saveSettings); }
      renderSide();
    }
    else if (t.matches("[data-nbf]")) { const n = F.notebook.find((x) => x.id === t.dataset.nbid); if (n) { n[t.dataset.nbf] = t.value; persistSoon("notebook", n); } }
    else if (t.matches("[data-mtnotes]")) { const m = F.meetings.find((x) => x.id === t.dataset.mtnotes); if (m) { m.notes = t.value; persistSoon("meetings", m); } }
    else if (t.matches("[data-desc]")) { const i = byId(t.dataset.desc); if (i) { i.desc = t.value; persistSoon("issues", i); } }
    else if (t.matches("[data-blockedby]")) { const i = byId(t.dataset.blockedby); if (i) { i.blockedBy = t.value; persistSoon("issues", i); } }
  });

  document.addEventListener("focusout", () => { if (S.dirty) setTimeout(rerenderIfIdle, 400); });

  document.addEventListener("submit", async (e) => {
    const f = e.target;
    e.preventDefault();
    const d = Object.fromEntries(new FormData(f));
    const busy = f.querySelector("button:not([type=button])"); if (busy) busy.disabled = true;
    const done = () => { if (busy) busy.disabled = false; };
    try {
      if (f.matches("[data-login]")) {
        const r = await call("POST", "/api/login", { username: d.username, password: d.password });
        await enter(r.user);
      } else if (f.matches("[data-setup]")) {
        await call("POST", "/api/setup", {
          team: { num: d.num.trim(), name: d.name.trim(), short: d.short.trim(), season: d.season.trim() },
          admin: { name: d.aname.trim(), username: d.username.trim(), password: d.password },
          qualifier: d.qualifier ? { date: d.qualifier } : null,
        });
        S.session = await call("GET", "/api/session");
        await enter(S.session.user);
      } else if (f.matches("[data-pw-forced]")) {
        await call("POST", "/api/password", { current: d.current, next: d.next });
        await enter({ ...S.user, mustChange: false });
      } else if (!S.ready) {
        /* ignore */
      } else if (f.matches("[data-new]")) {
        const i = await create("issues", { title: d.title.trim(), type: typeFor(d.sub), sub: d.sub, pri: d.pri, status: "todo", who: [d.who], created: F.today, due: d.due || undefined, desc: "" });
        closeModal(); toast(`Created FTC-${i.id}.`, "Open", () => openIssue(i.id)); render();
      } else if (f.matches("[data-gh]")) {
        S.repo = d.repo.trim(); await saveSettings(); closeModal(); toast(`Saved ${S.repo}.`); render();
      } else if (f.matches("[data-cmt]")) {
        const i = byId(f.dataset.cmt);
        if (d.t.trim()) { i.notes = [...(i.notes || []), { who: F.me, text: d.t.trim(), date: F.today }]; persist("issues", i); render(); }
      } else if (f.matches("[data-prac]")) {
        await create("practice", { date: d.date, driver: d.driver, auto: +d.auto, cycle: +d.cycle, note: d.note });
        toast("Session logged."); render();
      } else if (f.matches("[data-addpart]")) {
        await create("parts", { name: d.name.trim(), sub: d.sub, have: +d.have || 0, need: +d.need || 0, ordered: 0, price: +d.price || 0, vendor: d.vendor });
        render();
      } else if (f.matches("[data-newentry]")) {
        const n = await create("notebook", { date: F.today, title: d.title.trim(), author: F.me, status: "draft", problem: "", tried: "", result: "", next: "" });
        S.nbSel = n.id; closeModal(); go("notebook"); render();
      } else if (f.matches("[data-newmeeting]")) {
        const m = await create("meetings", { date: d.date, title: d.title.trim(), who: [F.me], agenda: [], notes: "", actions: [] });
        S.mtSel = m.id; closeModal(); render();
      } else if (f.matches("[data-newphase]")) {
        await create("phases", { name: d.name.trim(), start: d.start, end: d.end });
        closeModal(); render();
      } else if (f.matches("[data-newmilestone]")) {
        if (d.main) for (const o of F.milestones.filter((x) => x.main)) { o.main = false; await persist("milestones", o); }
        await create("milestones", { name: d.name.trim(), date: d.date, main: !!d.main });
        closeModal(); render();
      } else if (f.matches("[data-agenda]")) {
        const m = F.meetings.find((x) => x.id === f.dataset.agenda);
        if (d.t.trim()) { m.agenda = [...m.agenda, d.t.trim()]; persist("meetings", m); render(); }
      } else if (f.matches("[data-action]")) {
        const m = F.meetings.find((x) => x.id === f.dataset.action);
        if (d.t.trim()) { m.actions = [...m.actions, { id: uid(), text: d.t.trim(), who: d.who }]; persist("meetings", m); render(); }
      } else if (f.matches("[data-addmember]")) {
        const r = await write("POST", "/api/users", { name: d.name.trim(), username: d.username.trim(), role: d.role, access: d.access });
        F.people.push({ ...r.person, username: d.username.trim() });
        showTemp("Account created", r.person.name, r.password); render();
      } else if (f.matches("[data-pw]")) {
        await write("POST", "/api/password", { current: d.current, next: d.next });
        closeModal(); toast("Password changed. Other devices were signed out.");
      }
    } catch (err) {
      if (f.matches("[data-login],[data-setup],[data-pw-forced]")) authError(err.message);
      else if (f.closest("#modal")) modalErr(err.message);
      else writeFailed(err);
    } finally { done(); }
  });

  /* board drag and drop (desktop) */
  document.addEventListener("dragstart", (e) => { const c = e.target.closest("[data-drag]"); if (c) e.dataTransfer.setData("text/plain", c.dataset.drag); });
  document.addEventListener("dragover", (e) => { const c = e.target.closest("[data-drop]"); if (c) { e.preventDefault(); c.classList.add("over"); } });
  document.addEventListener("dragleave", (e) => { const c = e.target.closest("[data-drop]"); if (c) c.classList.remove("over"); });
  document.addEventListener("drop", (e) => {
    const c = e.target.closest("[data-drop]"); if (!c || !S.ready) return;
    e.preventDefault();
    const i = byId(e.dataTransfer.getData("text/plain"));
    if (i) { setStatus(i, c.dataset.drop); render(); }
  });

  window.addEventListener("hashchange", () => { parseHash(); render(); });
  boot();
})();
