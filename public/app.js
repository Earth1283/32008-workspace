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
    prefs: { due: true, blocked: true, mention: true, pr: true, digest: false, follow: [] },
    inbox: [], github: {}, autoPr: true, ask: false, aiOn: true, iboxTab: "you",
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
      if (u.mode === "board" || u.mode === "list") S.mode = u.mode;
    } catch (e) { /* ignore */ }
  }
  const saveUi = () => { try { localStorage.setItem(UI_KEY, JSON.stringify({ role: S.role, density: S.density, mode: S.mode })); } catch (e) { /* ignore */ } };

  /* ---------- server access ---------- */
  const CLIENT = Math.random().toString(36).slice(2, 10);
  const pending = new Set();

  async function call(method, url, body, signal) {
    const r = await fetch(url, {
      method, credentials: "same-origin", signal,
      headers: { "Content-Type": "application/json", "X-Client": CLIENT },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = null;
    try { data = await r.json(); } catch (e) { /* no body */ }
    if (!r.ok) {
      const err = new Error((data && data.error) || r.statusText || "Request failed");
      err.status = r.status;
      err.data = data;
      if (r.status === 401 && S.ready) sessionEnded();
      throw err;
    }
    return data;
  }
  function track(p) {
    const tracked = p.catch(() => {});
    pending.add(tracked);
    tracked.then(() => pending.delete(tracked));
    return p;
  }
  const write = (method, url, body) => track(call(method, url, body));
  function writeFailed(e) {
    if (e.status === 401) return;
    toast(e.message || "Could not save that change");
    refresh();
  }

  /* ---------- saving documents ----------
     Each document carries the rev it was loaded at. The server refuses a save made from an
     older rev (409) and returns its current copy; we then redo our edits on top of that copy. */
  const base = new WeakMap(); // document object -> the server copy it was last in step with
  const remember = (doc) => base.set(doc, JSON.parse(JSON.stringify(doc)));
  /** Array fields where teammates add and remove items independently, merged item by item. */
  const SETS = { issues: ["notes"], meetings: ["who", "agenda", "actions"] };
  const stable = (x) => (x && typeof x === "object" && !Array.isArray(x) ? JSON.stringify(Object.keys(x).sort().map((k) => [k, x[k]])) : JSON.stringify(x));
  const ident = (x) => (x && typeof x === "object" && "id" in x ? "id:" + x.id : "v:" + stable(x));

  /** Three-way merge: start from theirs, then reapply every field we changed since was. */
  function merge(was, mine, theirs, sets) {
    const out = { ...theirs };
    let clobbered = false;
    for (const k of new Set([...Object.keys(was), ...Object.keys(mine)])) {
      if (k === "id" || k === "rev" || stable(was[k]) === stable(mine[k])) continue;
      if (sets.includes(k) && Array.isArray(mine[k])) {
        const old = new Map((was[k] || []).map((x) => [ident(x), x]));
        const now = new Map(mine[k].map((x) => [ident(x), x]));
        const list = (theirs[k] || [])
          .filter((x) => !(old.has(ident(x)) && !now.has(ident(x))))
          .map((x) => { const m = now.get(ident(x)); return m && stable(m) !== stable(old.get(ident(x))) ? m : x; });
        const seen = new Set(list.map(ident));
        for (const x of mine[k]) if (!old.has(ident(x)) && !seen.has(ident(x))) list.push(x);
        out[k] = list;
      } else {
        if (stable(theirs[k]) !== stable(was[k]) && stable(theirs[k]) !== stable(mine[k])) clobbered = true;
        out[k] = mine[k];
      }
    }
    return { doc: out, clobbered };
  }

  async function save(coll, doc) {
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await call("PUT", `/api/${coll}/${doc.id}`, doc);
        doc.rev = r.rev;
        base.set(doc, r);
        return r;
      } catch (e) {
        const cur = e.status === 409 && e.data && e.data.current;
        if (!cur || attempt >= 3) throw e;
        const { doc: merged, clobbered } = merge(base.get(doc) || {}, doc, cur, SETS[coll] || []);
        for (const k of Object.keys(doc)) if (!(k in merged)) delete doc[k];
        Object.assign(doc, merged);
        base.set(doc, cur);
        if (clobbered) toast("A teammate edited this at the same time. Where you both changed the same thing, your version was kept.");
        refreshSoon();
      }
    }
  }
  const queues = new Map();
  /** Save a document. Saves of the same document go one at a time, so we never race ourselves. */
  function persist(coll, doc) {
    const key = coll + doc.id;
    clearTimeout(timers.get(key));
    const p = (queues.get(key) || Promise.resolve()).then(() => save(coll, doc));
    const settled = p.catch(() => {});
    queues.set(key, settled);
    settled.then(() => { if (queues.get(key) === settled) queues.delete(key); });
    return track(p).catch(writeFailed);
  }
  const timers = new Map();
  const soon = (key, fn, ms = 450) => { clearTimeout(timers.get(key)); timers.set(key, setTimeout(() => { timers.delete(key); fn(); }, ms)); };
  const persistSoon = (coll, doc) => soon(coll + doc.id, () => persist(coll, doc));
  const saveTeam = () => write("PUT", "/api/meta/team", F.team).catch(writeFailed);
  const saveSettings = () => write("PUT", "/api/meta/settings", { budget: F.budget, branchPrefix: S.branchPrefix, repo: S.repo || "", autoPr: S.autoPr, ai: S.aiOn }).catch(writeFailed);
  const saveMe = () => { const p = F.person(F.me); return write("PATCH", `/api/people/${F.me}`, { name: p.name, role: p.role, gh: p.gh || "" }).catch(writeFailed); };
  const savePrefs = () => write("PUT", "/api/prefs", S.prefs).catch(writeFailed);
  function markRead(ids) {
    const all = ids === "all";
    for (const n of S.inbox) if (all || ids.includes(n.id)) n.read = true;
    return write("POST", "/api/notifications/read", all ? { all: true } : { ids }).catch(writeFailed);
  }

  const SORT = {
    practice: (a, b) => a.date.localeCompare(b.date),
    meetings: (a, b) => b.date.localeCompare(a.date),
    milestones: (a, b) => a.date.localeCompare(b.date),
    phases: (a, b) => a.start.localeCompare(b.start),
  };
  async function create(coll, doc) {
    const r = await write("POST", `/api/${coll}`, doc);
    remember(r);
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
    S.autoPr = st.settings.autoPr !== false;
    S.ask = !!st.ask;
    S.aiOn = st.settings.ai !== false;
    S.prefs = st.prefs;
    S.inbox = st.inbox;
    S.github = st.github || {};
    F.people = st.people;
    for (const k of ["milestones", "phases", "issues", "parts", "practice", "meetings", "notebook"]) { F[k] = st[k]; F[k].forEach(remember); }
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
  const canWrite = () => !!S.user && S.user.access !== "Viewer";
  /** Controls that only make sense for someone who can change things. Removed for viewers. */
  const WRITE_ONLY = '[data-write], [data-act="new"], [data-act^="new-"], [data-rm], [data-draft], [data-finalize], [data-mkissue], [data-agenda-rm], [data-action-rm], form[data-cmt], form[data-agenda], form[data-action], form[data-addpart]';
  function lockPage() {
    const page = $("#page");
    page.querySelectorAll(WRITE_ONLY).forEach((el) => el.remove());
    page.querySelectorAll("input, textarea, select, [data-attend]").forEach((el) => { if (!el.matches("[data-subf]")) el.disabled = true; });
    page.querySelectorAll("[data-drag]").forEach((el) => { el.draggable = false; });
  }
  const renderSide = () => { $("#side").innerHTML = sideHtml(); };

  /* ---------- motion ----------
     One vocabulary: things arrive on EASE.out, leave faster on EASE.in, and small toggles settle with a slight overshoot.
     render() rebuilds the DOM, so CSS transitions never see a state change. Instead render() takes a snapshot first and
     settle() animates from it afterwards. Page entrances only play when you move to another page, not on every redraw. */
  const EASE = { out: "cubic-bezier(.22, 1, .36, 1)", in: "cubic-bezier(.55, 0, 1, .45)", inOut: "cubic-bezier(.65, 0, .35, 1)", spring: "cubic-bezier(.34, 1.45, .64, 1)" };
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const calm = () => !!(window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches);
  const anim = (el, kf, o = {}) => (el && el.animate && !calm() ? el.animate(kf, { duration: 280, easing: EASE.out, fill: "backwards", ...o }) : null);
  const stop = (el) => { if (el && el.getAnimations) el.getAnimations().forEach((a) => a.cancel()); };
  const vt = (fn) => (document.startViewTransition && !calm() ? document.startViewTransition(fn) : fn());
  const motion = { page: undefined, pane: null, arg: null, bump: null };

  /** Fades and lifts elements in, in reading order. Anything below the fold just appears. */
  function reveal(els, { step = 30, max = 10, y = 6, delay = 0 } = {}) {
    const vis = els.map((el) => [el, el.getBoundingClientRect()]).filter(([, r]) => r.top < innerHeight)
      .sort(([, a], [, b]) => Math.round(a.top / 8) - Math.round(b.top / 8) || a.left - b.left);
    vis.forEach(([el], k) => anim(el, [{ opacity: 0, transform: `translateY(${y}px)` }, { opacity: 1, transform: "none" }], { duration: 320, delay: delay + Math.min(k, max) * step }));
  }
  const shake = (el) => anim(el, [{ transform: "none" }, { transform: "translateX(-6px)" }, { transform: "translateX(5px)" }, { transform: "translateX(-3px)" }, { transform: "none" }], { duration: 320, easing: EASE.inOut });

  /** Shows something hidden with display:none. Returns true when it was already showing. */
  function arrive(el, runs) {
    const was = el.classList.contains("show");
    if (el.classList.contains("leaving")) { el.classList.remove("leaving"); runs.forEach(([x]) => stop(x)); }
    el.classList.add("show");
    if (!was) runs.forEach(([x, kf, o]) => anim(x, kf, o));
    return was;
  }
  /** Plays the entrance backwards, faster. The element stays visible as .leaving, but no longer counts as shown. */
  function leave(el, runs) {
    if (!el.classList.contains("show")) return;
    el.classList.replace("show", "leaving");
    const all = runs.map(([x, kf, o]) => anim(x, kf.slice().reverse(), { ...o, duration: 150, easing: EASE.in, fill: "forwards" })).filter(Boolean);
    const end = () => { if (el.classList.contains("leaving")) { el.classList.remove("leaving"); runs.forEach(([x]) => stop(x)); } };
    if (all.length) Promise.all(all.map((a) => a.finished)).then(end, end); else end();
  }
  const ovRuns = (ov) => [[ov, [{ opacity: 0 }, { opacity: 1 }], { duration: 180, easing: "ease-out" }],
    [ov.firstElementChild, [{ opacity: 0, transform: "translateY(-6px) scale(.98)" }, { opacity: 1, transform: "none" }], { duration: 260 }]];
  const toastRuns = (t) => [[t, [{ opacity: 0, transform: "translate(-50%, 14px) scale(.96)" }, { opacity: 1, transform: "translate(-50%, 0)" }], { duration: 340, easing: EASE.spring }]];

  /* The highlight behind a selected item slides from where it was. [container, selected item, same on every page] */
  const GLIDES = [["#side", ".nav.on", true], [".tabs", ".tab.on"], [".seg", ".on"], [".pl", ".pi.on"], [".list", ".row.on"]];
  const KEYED = "[data-issue], [data-issue-go], [data-note], [data-nb], [data-mt], [data-g]";
  const keyOf = (el) => ["issue", "issueGo", "note", "nb", "mt", "g"].map((k) => el.dataset[k] ?? "").join(":");
  const hostOf = (el) => [...el.attributes].filter((a) => a.name.startsWith("data-")).map((a) => a.name + "=" + a.value).join(" ");
  /* Controls whose new state gets a small settle animation (.moved, styled in CSS). [selector, state, element to mark] */
  const WATCH = [
    ["[data-tgl], [data-pal-opt]", (el) => el.getAttribute("aria-checked")],
    ["[data-accent], [data-attend], [data-follow], [data-note]", (el) => el.className + el.getAttribute("aria-pressed")],
    ["#side .nav", (el) => (el.querySelector(".n") || {}).textContent || "", (el) => el.querySelector(".n")],
  ];
  const box = (on, c) => { const r = on.getBoundingClientRect(), b = c.getBoundingClientRect(); return { x: r.left - b.left - c.clientLeft + c.scrollLeft, y: r.top - b.top - c.clientTop + c.scrollTop, w: r.width, h: r.height }; };

  function snapshot() {
    const s = { rects: new Map(), glides: new Map(), states: new Map() };
    const n = {};
    $$("#page " + KEYED.split(", ").join(", #page ")).forEach((el) => { const k = keyOf(el); n[k] = (n[k] || 0) + 1; s.rects.set(k + "#" + n[k], el.getBoundingClientRect()); });
    GLIDES.forEach(([c, sel, global], g) => $$(c).forEach((el, k) => { const on = el.querySelector(sel); if (on) s.glides.set(`${global ? "" : motion.route}|${g}|${k}`, box(on, el)); }));
    WATCH.forEach(([sel, val], w) => $$(sel).forEach((el) => s.states.set(w + ":" + hostOf(el), val(el))));
    return s;
  }

  function glide(on, c, from) {
    const to = box(on, c);
    if (Math.abs(from.x - to.x) < 1 && Math.abs(from.y - to.y) < 1) return;
    if (!c.animate || calm()) return;
    const cs = getComputedStyle(on), g = document.createElement("span");
    g.className = "glide";
    Object.assign(g.style, { left: to.x + "px", top: to.y + "px", width: to.w + "px", height: to.h + "px", background: cs.backgroundColor, boxShadow: cs.boxShadow, borderRadius: cs.borderRadius });
    c.prepend(g); on.classList.add("gliding");
    const a = anim(g, [{ transform: `translate(${from.x - to.x}px, ${from.y - to.y}px)`, width: from.w + "px", height: from.h + "px" }, { transform: "none", width: to.w + "px", height: to.h + "px" }], { duration: 300 });
    // The item's own highlight fades back in over the ghost, so keep the ghost a moment longer.
    a.finished.then(() => { on.classList.remove("gliding"); setTimeout(() => g.remove(), 200); }, () => g.remove());
  }

  function countUp(el) {
    const n = +el.textContent, t0 = performance.now(), d = 900;
    if (!n || calm() || !el.animate) return;
    const f = (t) => { if (!el.isConnected) return; const p = Math.min(1, (t - t0) / d); el.textContent = Math.round(n * (1 - Math.pow(1 - p, 4))); if (p < 1) requestAnimationFrame(f); };
    el.textContent = 0; requestAnimationFrame(f);
  }

  const REVEAL = {
    home: ".hero, .blk", issues: ".gh, .row, .col, .empty", season: ".hero, .gantt, .blk, .empty", inbox: ".follow, .li, .empty",
    parts: ".hero, .form, tbody tr, .empty", practice: ".chart, .blk, tbody tr, .empty",
    notebook: ".pl > *, .pr > *", meetings: ".pl > *, .pr > *, .page > .empty", settings: ".pl > *, .pr > *",
    pit: ".pitwrap header, .pit-grid > div, .pit-two h3, .pit-two p",
  };
  function enterPage(route) {
    const page = $("#page");
    reveal($$(REVEAL[route] || ".wrap > *", page), route === "pit" ? { step: 50, y: 12 } : {});
    $$(".chart svg", page).forEach((svg) => {
      anim(svg.querySelector(".ln"), [{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], { duration: 800, delay: 160, easing: EASE.inOut });
      const pts = $$(".pt", svg);
      pts.forEach((p, k) => anim(p, [{ transform: "scale(0)" }, { transform: "none" }], { duration: 320, delay: 160 + (800 * k) / Math.max(1, pts.length - 1) * 0.85, easing: EASE.spring }));
    });
    $$(".gbar", page).forEach((b, k) => {
      anim(b, [{ transform: "scaleX(0)" }, { transform: "none" }], { duration: 600, delay: 140 + k * 70 });
      anim(b.firstElementChild, [{ transform: "scaleX(0)" }, { transform: "none" }], { duration: 500, delay: 460 + k * 70 });
    });
    anim($(".gline.today", page), [{ opacity: 0, transform: "scaleY(0)" }, { opacity: 1, transform: "none" }], { duration: 400, delay: 380 });
    $$(".bar i", page).forEach((b) => anim(b, [{ transform: "scaleX(0)" }, { transform: "none" }], { duration: 800, delay: 160, easing: EASE.inOut }));
    $$("[data-count]", page).forEach(countUp);
  }

  function settle(s, route) {
    const page = route + (route === "issues" ? ":" + S.mode : "");
    const pane = { notebook: S.nbSel, meetings: S.mtSel, settings: S.setTab }[route] ?? null;
    const arg = route === "issues" ? S.arg : null;
    const fresh = page !== motion.page;
    if (fresh) enterPage(route);
    else {
      const n = {};
      $$("#page " + KEYED.split(", ").join(", #page ")).forEach((el) => {
        const k = keyOf(el); n[k] = (n[k] || 0) + 1;
        const was = s.rects.get(k + "#" + n[k]), r = el.getBoundingClientRect();
        if (!was) { anim(el, [{ opacity: 0 }, { opacity: 1 }], { duration: 240 }); return; }
        const dx = was.left - r.left, dy = was.top - r.top;
        if (Math.abs(dx) >= 1 || Math.abs(dy) >= 1) anim(el, [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: 340 });
      });
      if (pane !== motion.pane) reveal($$(".pr > *"), { step: 24, max: 6 });
    }
    const p = $(".panel");
    if (p && arg !== motion.arg) {
      if (!motion.arg || fresh) anim(p, [{ opacity: 0, transform: "translateX(24px)" }, { opacity: 1, transform: "none" }], { duration: 320 });
      else anim(p, [{ opacity: 0.45, transform: "translateY(3px)" }, { opacity: 1, transform: "none" }], { duration: 200 });
    }
    GLIDES.forEach(([c, sel, global], g) => $$(c).forEach((el, k) => {
      const on = el.querySelector(sel), from = s.glides.get(`${global ? "" : route}|${g}|${k}`);
      if (on && from) glide(on, el, from);
    }));
    WATCH.forEach(([sel, val, target], w) => $$(sel).forEach((el) => {
      const was = s.states.get(w + ":" + hostOf(el));
      if (was !== undefined && was !== val(el)) { const t = target ? target(el) : el; if (t) t.classList.add("moved"); }
    }));
    if (motion.bump != null) {
      $$(`#page [data-issue="${motion.bump}"] .si`).forEach((si) => {
        anim(si, [{ transform: "scale(.5)" }, { transform: "none" }], { duration: 420, easing: EASE.spring });
        anim(si.querySelector("path[pathLength]"), [{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], { duration: 320, delay: 120 });
      });
      anim($(".panel .callout"), [{ opacity: 0, transform: "translateY(-4px)" }, { opacity: 1, transform: "none" }], { duration: 280 });
      motion.bump = null;
    }
    Object.assign(motion, { page, pane, arg, route });
  }
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
  const isTeam = (n) => n.kind === "team";
  const unread = () => S.inbox.filter((n) => !n.read && !isTeam(n)).length;
  const unreadTeam = () => S.inbox.filter((n) => !n.read && isTeam(n)).length;
  const prState = (i) => (i.prState && i.prState !== "none" ? i.prState : i.merged ? "merged" : i.pr ? "open" : null);
  const prUrl = (i) => (S.repo && i.pr ? `https://github.com/${S.repo}/pull/${i.pr}` : null);
  const ago = (ms) => {
    const m = Math.round((Date.now() - ms) / 60000);
    if (m < 1) return "just now";
    if (m < 60) return m + " min ago";
    if (m < 24 * 60) return Math.round(m / 60) + " h ago";
    return F.fmt(F.iso(new Date(ms)));
  };
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
    if (s === "done") return `<svg class="si" width="14" height="14" viewBox="0 0 14 14"><circle cx="7" cy="7" r="6" fill="${c}"/><path d="M4.4 7.2l1.9 1.9 3.3-3.8" pathLength="1" fill="none" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    return `<svg class="si" width="14" height="14" viewBox="0 0 14 14" role="img" aria-label="${F.status[s]}">${ring}${inner}</svg>`;
  };
  const priIcon = (p) => {
    const n = { high: 3, med: 2, low: 1 }[p];
    const bars = [0, 1, 2].map((k) => `<rect x="${1 + k * 4.5}" y="${9 - k * 3}" width="3" height="${3 + k * 3}" rx=".8" fill="${k < n ? "var(--dim)" : "var(--line)"}"/>`).join("");
    return `<svg class="pri-i" width="14" height="14" viewBox="0 0 14 14" role="img" aria-label="${F.pri[p]} priority">${bars}</svg>`;
  };
  const I = {
    return: '<path d="M12.5 3.5v4A1.5 1.5 0 0 1 11 9H3.5M5.8 6.7 3.3 9l2.5 2.3"/>',
    tab: '<path d="M2.5 8h9M8.5 4.8 11.7 8l-3.2 3.2M13.5 3.5v9"/>',
    updown: '<path d="M5.5 12.5v-9M3.3 5.7l2.2-2.2 2.2 2.2M10.5 3.5v9M8.3 10.3l2.2 2.2 2.2-2.2"/>',
    arrow: '<path d="M3 8h10M9.3 4.3 13 8l-3.7 3.7"/>',
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
    inbox: '<path d="M2 9.5 3.8 3.4a1 1 0 0 1 1-.7h6.4a1 1 0 0 1 1 .7L14 9.5V13a.5.5 0 0 1-.5.5h-11A.5.5 0 0 1 2 13Z"/><path d="M2 9.5h3.5l1 1.5h3l1-1.5H14"/>',
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
  /** Escaped text with @mentions of real people and teams highlighted. */
  function mentionHtml(text) {
    const who = new Map(F.people.filter((p) => p.handle).map((p) => [p.handle, p.name]));
    for (const [k, v] of Object.entries(F.subs)) if (!who.has(k)) who.set(k, v + " team");
    return esc(text).replace(/(^|[^\w@])@([a-z0-9][a-z0-9._-]{0,31})/gi, (m, pre, h) => {
      const k = h.toLowerCase(), base = k.replace(/[._-]+$/, ""), hit = who.has(k) ? k : who.has(base) ? base : null;
      if (!hit) return m;
      return `${pre}<span class="mention" title="${esc(who.get(hit))}">@${h.slice(0, hit.length)}</span>${h.slice(hit.length)}`;
    });
  }
  /** For fields with the @ menu. Browser autofill and password managers stay out, so their dropdowns never cover it. */
  const MENTION_ATTRS = 'data-mention aria-autocomplete="list" aria-controls="mention" autocomplete="off" data-1p-ignore data-lpignore="true" data-bwignore data-form-type="other"';

  /* ---------- routing ---------- */
  const go = (path) => {
    const h = "#/" + path;
    if (location.hash === h) { parseHash(); render(); } else location.hash = h;
  };
  const parseHash = () => {
    const [r, a] = (location.hash.replace(/^#\/?/, "") || "home").split("/");
    S.route = r || "home"; S.arg = a || null;
    if (S.arg && S.route === "meetings") S.mtSel = S.arg;
    if (S.arg && S.route === "notebook") S.nbSel = S.arg;
  };

  /* ---------- sidebar ---------- */
  const NAV = [["home", "Home", "home"], ["inbox", "Inbox", "inbox"], ["mine", "My issues", "me"], ["issues", "Issues", "issues"]];
  const NAV2 = [["season", "Season", "season"], ["notebook", "Notebook", "notebook"], ["parts", "Parts", "parts"], ["practice", "Practice", "practice"], ["meetings", "Meetings", "meetings"]];
  const sideHtml = () => {
    const onIssues = S.route === "issues";
    const navBtn = ([k, label, ic], extra = "") => {
      const on = k === "mine" ? onIssues && S.view === "mine" : k === "issues" ? onIssues && S.view !== "mine" && !S.sub : S.route === k;
      return `<button class="nav ${on ? "on" : ""}" data-go="${k}" ${on ? 'aria-current="page"' : ""}>${ico(ic)}${label}${extra}</button>`;
    };
    const nbDebt = debt().length;
    return `
      <div class="ws">${logoHtml()}<div><b>${esc(F.team.num)} ${esc(F.team.name)}</b><small>${esc(F.team.season)}${F.team.season ? " season" : ""}${canWrite() ? "" : `${F.team.season ? " · " : ""}View only`}</small></div></div>
      <button class="search" data-act="palette">${ico("search")}Search<kbd>Ctrl K</kbd></button>
      ${NAV.map((n) => navBtn(n, n[0] === "mine" ? `<span class="n">${mine().length}</span>` : n[0] === "inbox" ? (unread() ? `<span class="n new">${unread()}</span>` : unreadTeam() ? `<span class="n" title="Unread in Teams">${unreadTeam()}</span>` : "") : "")).join("")}
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
        ${i.status === "blocked" ? `<div class="callout"><b>Blocked</b><textarea class="in" rows="2" data-blockedby="${i.id}" placeholder="What is it waiting on?" aria-label="Blocked by" ${MENTION_ATTRS}>${esc(i.blockedBy || "")}</textarea></div>` : ""}
        <div class="sec"><h3>Description</h3><textarea class="in" rows="${i.desc ? 4 : 2}" data-desc="${i.id}" placeholder="Add details" aria-label="Description" ${MENTION_ATTRS}>${esc(i.desc || "")}</textarea></div>
        <div class="sec"><h3>GitHub</h3>${gitBlock(i)}</div>
        ${i.status === "done" ? `<div class="sec"><h3>Notebook</h3>${i.logged
          ? `<p class="dim">Logged in the engineering notebook.</p>`
          : `<div class="git"><span class="dim" style="flex:1">No notebook entry yet.</span><button class="btn pri" data-draft="${i.id}">Draft entry</button></div>`}</div>` : ""}
        <div class="sec"><h3>Activity</h3>
          ${act.map((a) => `<div class="act">${av(a.who)}<div><p>${a.text.startsWith("created") ? `<b>${esc(F.person(a.who).name)}</b> ${esc(a.text)}` : mentionHtml(a.text)}</p><small>${F.fmt(a.date)}${a.text.startsWith("created") ? "" : " · " + esc(F.person(a.who).name)}</small></div></div>`).join("")}
          <form class="cmt" data-cmt="${i.id}" autocomplete="off"><input class="in" name="t" placeholder="Leave a comment. Type @ to mention someone" aria-label="Comment" ${MENTION_ATTRS}><button class="btn">Send</button></form>
        </div>
        ${isAdmin() ? `<div class="sec"><button class="btn ghost" data-rm="issues:${i.id}">Delete issue</button></div>` : ""}
      </aside>`;
  };
  const PR_LABEL = { draft: "Draft", open: "Open", merged: "Merged", closed: "Closed" };
  const gitBlock = (i) => {
    if (i.branch || i.pr) {
      const st = prState(i), url = prUrl(i);
      const pr = i.pr ? (url ? `<a class="chip" href="${esc(url)}" target="_blank" rel="noopener">PR #${i.pr}</a>` : `<span class="chip">PR #${i.pr}</span>`) : "";
      return `<div class="git">${ico("git")}<span class="mono">${esc(i.branch || "")}</span><span style="margin-left:auto;display:flex;gap:6px">${pr}<span class="chip pr-${st || "none"}">${st ? PR_LABEL[st] : "Branch only"}</span></span></div>`;
    }
    return `<div class="git">${ico("git")}<span class="mono">${esc(branchName(i))}</span><button class="btn" style="margin-left:auto" data-copy="${esc(branchName(i))}">Copy</button></div>
      <p class="faint" style="margin-top:6px">${S.repo ? "Suggested branch name. A pull request from it links here by itself within a few minutes." : "Suggested branch name. Pull requests from it will link here once a repository is connected."}</p>`;
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
      body = grouped().map(([s, a]) => `<div class="gh" data-g="${s}">${statusIcon(s)}<b>${F.status[s]}</b><span>${a.length}</span></div>${a.map(rowHtml).join("")}`).join("");
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
    const openPrs = F.issues.filter((i) => prState(i) === "open" || prState(i) === "draft");
    const gitBlk = `<div class="blk"><h3>GitHub</h3>${S.repo
      ? (S.github.error
        ? `<p class="hint err">${esc(S.github.error)}</p>`
        : `${openPrs.map((i) => liIssue(i, `PR #${i.pr}${prState(i) === "draft" ? " · draft" : ""}`)).join("") || `<p class="hint">No open pull requests on <span class="mono">${esc(S.repo)}</span>.</p>`}`)
      : `<p class="hint">No repo yet. Add one when you create it so pull requests link to issues.</p><button class="btn" data-act="github">Connect GitHub</button>`}</div>`;

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
    return `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Trend, latest ${vals[n - 1]}">${grid}${xl}<polyline class="ln" pathLength="1" points="${pts}"/>${vals.map((v, k) => `<circle class="pt ${k === n - 1 ? "last" : ""}" cx="${x(k)}" cy="${y(v)}" r="3.5"/>`).join("")}</svg>`;
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
    const f = (k, label, rows = 3) => `<div class="fld"><label for="nb-${k}">${label}</label><textarea class="in" id="nb-${k}" rows="${rows}" data-nbf="${k}" data-nbid="${esc(e.id)}" ${MENTION_ATTRS}>${esc(e[k])}</textarea></div>`;
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
            return `<tr data-part="${esc(p.id)}"><td>${esc(p.name)}</td><td class="dim">${F.subs[p.sub]}</td><td class="num">${num(p, "have")}</td><td class="num">${num(p, "ordered")}</td><td class="num">${num(p, "need")}</td><td>${dot(st[0])} ${st[1]}</td><td class="num">$${p.price.toFixed(2)}</td><td class="dim">${esc(p.vendor)}</td><td><button class="rm" data-rm="parts:${esc(p.id)}" aria-label="Remove ${esc(p.name)}">Remove</button></td></tr>`;
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
        <div class="blk" data-write><h3>Log a session</h3>
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
          <tbody>${p.slice().reverse().map((x) => `<tr data-session="${esc(x.id)}"><td>${F.fmt(x.date)}</td><td>${esc(F.person(x.driver).name)}</td><td class="num">${x.auto}/10</td><td class="num">${x.cycle} s</td><td class="dim">${esc(x.note)}</td><td><button class="rm" data-rm="practice:${esc(x.id)}" aria-label="Remove session">Remove</button></td></tr>`).join("")}</tbody>
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
        <div class="sec"><h3>Notes</h3><textarea class="in" rows="6" data-mtnotes="${esc(m.id)}" placeholder="What was decided? Type @ to mention someone" aria-label="Notes" ${MENTION_ATTRS}>${esc(m.notes)}</textarea></div>
        <div class="sec"><h3>Action items</h3>
          ${m.actions.map((a) => `<div class="li">${av(a.who)}<span class="t">${esc(a.text)}</span>${a.issue
            ? `<button class="chip mono" data-issue-go="${a.issue}">FTC-${a.issue}</button>`
            : `<button class="btn" data-mkissue="${esc(m.id)}:${esc(a.id)}">Make issue</button>`}<button class="rm" data-action-rm="${esc(m.id)}:${esc(a.id)}" aria-label="Remove action item">Remove</button></div>`).join("") || '<p class="hint">No action items.</p>'}
          <form class="formrow" data-action="${esc(m.id)}"><input class="in" name="t" placeholder="Add an action item" autocomplete="off" aria-label="Action item" required>
            <select class="in" name="who" style="max-width:130px" aria-label="Owner">${F.people.map((p) => `<option value="${esc(p.id)}" ${p.id === F.me ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select><button class="btn">Add</button></form>
        </div>
        <div class="sec"><button class="btn ghost" data-rm="meetings:${esc(m.id)}">Delete meeting</button></div></div></div>`;
  };

  const followChips = () => `<div class="chips" role="group" aria-label="Subsystems you follow">${Object.entries(F.subs).map(([k, v]) => {
    const on = S.prefs.follow.includes(k);
    return `<button class="chip ${on ? "on" : ""}" data-follow="${k}" aria-pressed="${on}">${v}</button>`;
  }).join("")}</div>`;

  views.inbox = () => {
    const team = S.iboxTab === "team";
    const list = S.inbox.filter((x) => isTeam(x) === team);
    const tab = (k, label, n) => `<button class="tab ${S.iboxTab === k ? "on" : ""}" data-ibox="${k}">${label}${n ? `<span class="cnt">${n}</span>` : ""}</button>`;
    const items = list.map((x) => `<button class="li note ${x.read ? "" : "unread"}" data-note="${x.id}"><span class="dot${x.read ? "" : " new"}"></span><span class="t">${esc(x.text)}</span>${team && x.sub ? `<span class="chip">${F.subs[x.sub]}</span>` : ""}<span class="r">${ago(x.at)}</span></button>`).join("");
    const empty = !team
      ? `<div class="empty"><b>Nothing here yet</b>Assignments, comments, @mentions, blockers and due dates show up here.</div>`
      : S.prefs.follow.length
        ? `<div class="empty"><b>Quiet so far</b>New issues, comments and blockers on the subsystems you follow show up here.</div>`
        : `<div class="empty"><b>Follow your subsystems</b>Pick the ones you work on above. New issues, comments and blockers on them show up here.</div>`;
    return `<div class="ph"><h1>Inbox</h1><div class="tabs">${tab("you", "For you", unread())}${tab("team", "Teams", unreadTeam())}</div>
        <div class="r">${list.some((x) => !x.read) ? `<button class="btn" data-inbox-all>Mark all as read</button>` : ""}<button class="btn ghost" data-act="notif-settings">Settings</button></div></div>
      <div class="wrap">${team ? `<div class="follow"><span class="dim">Following</span>${followChips()}</div>` : ""}${items ? `<div class="blk">${items}</div>` : empty}</div>`;
  };

  views.pit = () => {
    const q = qualifier();
    return `<div class="pitwrap">
      <header><div><div class="dim" style="font-size:18px">${esc(F.team.num)} ${esc(F.team.name)}</div>
        ${q ? `<div class="pit-num"><span data-count>${Math.max(0, F.days(q.date))}</span> days</div><div class="dim" style="font-size:22px">to the ${esc(q.name.toLowerCase())}, ${F.fmt(q.date)}</div>` : `<div class="pit-num">Pit board</div>`}</div>
        <button class="btn x" data-go="home">Exit pit board</button></header>
      <div class="pit-grid">${F.robotSubs.map((k) => { const h = health(k); return `<div>${dot(h.s)}${F.subs[k]}<small>${h.label}${h.n ? ", " + h.n + " open" : ""}</small></div>`; }).join("")}</div>
      <div class="pit-two">
        <div><h3>Blocked</h3>${blocked().map((i) => `<p>${esc(i.title)}</p>`).join("") || "<p>Nothing blocked.</p>"}</div>
        <div><h3>Next up</h3>${F.issues.filter((i) => isOpen(i) && i.pri === "high" && i.status !== "blocked").map((i) => `<p>${esc(i.title)}</p>`).join("") || "<p>No high priority work open.</p>"}</div>
      </div></div>`;
  };

  views.settings = () => {
    const tabs = [["profile", "Profile"], ["workspace", "Workspace"], ["appearance", "Appearance"], ["palette", "Command center"], ["notifications", "Notifications"], ["members", "Members"], ["integrations", "Integrations"]];
    const admin = isAdmin();
    const row = (title, desc, ctl) => `<div class="setrow"><div><b>${title}</b>${desc ? `<small>${desc}</small>` : ""}</div>${ctl}</div>`;
    const field = (key, val, label, type = "text", locked = false, extra = "") => `<input class="in" type="${type}" data-set="${key}" value="${esc(val)}" aria-label="${label}" ${locked ? "disabled" : ""} ${extra}>`;
    const tgl = (k, label, off = false, on = S.prefs[k]) => `<button class="tgl" role="switch" aria-checked="${!!on}" aria-label="${label}" data-tgl="${k}" ${off ? "disabled" : ""}></button>`;
    const segBtns = (attr, cur, opts) => `<div class="seg">${opts.map(([v, l]) => `<button class="${cur === v ? "on" : ""}" ${attr}="${v}" aria-pressed="${cur === v}">${l}</button>`).join("")}</div>`;
    const me = F.person(F.me);
    const q = qualifier();
    const lockNote = admin ? "" : `<p class="faint" style="margin-top:6px">Only admins can change these.</p>`;
    let body = "";
    if (S.setTab === "profile") {
      body = `<h2>Profile</h2><p class="dim">How you show up to the team. Signed in as <span class="mono">${esc(S.user.username)}</span> (${S.user.access}).</p><div class="box" style="margin-top:16px">
        ${row("Display name", "Shown on issues and comments.", field("dname", me.name, "Display name"))}
        ${row("Role", "Your title on the team.", field("drole", me.role, "Role"))}
        ${row("GitHub username", "So review requests on GitHub reach your inbox.", field("dgh", me.gh || "", "GitHub username", "text", false, 'maxlength="39" autocapitalize="off" spellcheck="false" placeholder="octocat"'))}
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
    } else if (S.setTab === "palette") {
      const toggle = ([key, title, desc]) => row(title, desc, `<button class="tgl" role="switch" aria-checked="${palette.config[key]}" aria-label="${title}" data-pal-opt="${key}"></button>`);
      const preset = currentPalettePreset();
      body = `<h2>Command center</h2><p class="dim">The Ctrl K box. Saved on this device.</p><div class="box" style="margin-top:16px">
        ${row("Style", preset === "custom" ? "Custom. Pick a preset to start over." : "Start from a preset, then adjust below.", segBtns("data-pal-preset", preset, [...PALETTE_PRESET_LABELS, ...(preset === "custom" ? [["custom", "Custom"]] : [])]))}
        ${row("When the box is empty", "What to list before you type anything.", segBtns("data-pal-empty", palette.config.empty, PALETTE_EMPTY_LABELS))}
        ${PALETTE_TOGGLES.filter(([key]) => key !== "ai" || (S.ask && S.aiOn)).map(toggle).join("")}
      </div><div style="margin-top:14px"><button class="btn" data-act="palette">Try it</button></div>`;
    } else if (S.setTab === "notifications") {
      body = `<h2>Notifications</h2><p class="dim">These arrive in your <button class="linkish" data-go="inbox">inbox</button>. Saved to your account, so they apply on every device.</p><div class="box" style="margin-top:16px">
        ${row("Due soon", "An issue assigned to you is due within 2 days.", tgl("due", "Due soon"))}
        ${row("Blocked", "An issue you're assigned to or commented on is marked Blocked.", tgl("blocked", "Blocked"))}
        ${row("Assignments, comments and mentions", `Someone assigns you an issue, comments on one you're on, or writes @${esc(me.handle || S.user.username)}.`, tgl("mention", "Assignments, comments and mentions"))}
        ${row("Review requests", me.gh ? "A pull request on GitHub asks for your review." : "A pull request on GitHub asks for your review. Add your GitHub username in Profile first.", tgl("pr", "Review requests"))}
        ${row("Weekly digest", "A Sunday summary of the week and what is next.", tgl("digest", "Weekly digest"))}
      </div>
      <h3 class="sh">Team inboxes</h3><div class="box" style="padding:14px 16px">
        <p class="dim" style="margin-bottom:8px">Follow the subsystems you work on. Their new issues, comments, blockers and finished work go to Inbox, Teams, and so does anything that mentions the team, like @lift.</p>
        ${followChips()}
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
        ${row("Repository", S.repo ? "Pull requests link to issues by branch name, or FTC-123 in the title." : "No repo connected yet.", S.repo ? `<div class="avl"><span class="mono">${esc(S.repo)}</span>${admin ? `<button class="btn" data-gh-disc>Disconnect</button>` : ""}</div>` : (admin ? `<button class="btn pri" data-act="github">Connect GitHub</button>` : ""))}
        ${S.repo ? row("Sync", S.github.error ? `<span class="err">${esc(S.github.error)}</span>` : S.github.at ? `Checked ${ago(S.github.at)}. Checks again every few minutes.` : "Not checked yet.", admin ? `<button class="btn" data-gh-sync>Check now</button>` : "") : ""}
        ${admin ? row("Access token", "Only needed for a private repository. A fine-grained token with read-only access to pull requests is enough.", S.github.hasToken
          ? `<div class="avl"><span class="dim">Saved</span><button class="btn ghost" data-gh-token-rm>Remove</button></div>`
          : `<form class="avl" data-ghtoken><input class="in" type="password" name="token" placeholder="github_pat_…" autocomplete="off" aria-label="Access token" required style="width:160px"><button class="btn">Save</button></form>`) : ""}
        ${row("Branch prefix", "Suggested branch names start with this.", field("prefix", S.branchPrefix, "Branch prefix", "text", !admin, 'maxlength="20"'))}
        ${row("Move issues with pull requests", "Opening a PR sets In review. Merging sets Done. You can still change the status by hand.", tgl("autopr", "Move issues with pull requests", !admin, S.autoPr))}
      </div>
        <h3 class="sh">Ask the workspace</h3><div class="box">
        ${row("Answer questions in the command center", S.ask
          ? "Type a question starting with what's in Ctrl K. After a pause, Google's Gemini model answers from issue titles, people, parts, practice runs, meetings and dates. Comments, descriptions and notebook text are never sent."
          : "Add GEMINI_API_KEY to the server's .env file and restart. See .env.example. Use a key from a billing-enabled Google project.", S.ask ? tgl("ai", "Answer questions in the command center", !admin, S.aiOn) : "")}
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
    $("#ov-modal").classList.remove("show", "leaving");
    motion.page = undefined;
    reveal($$(".authbox > *"), { step: 40, y: 8 });
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
  const authError = (m) => { const e = $("#auth-err"); if (e) e.textContent = m; shake($(".authbox")); };

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
    mentionClose();
    const snap = snapshot();
    const keep = ["list", "panel"].map((c) => { const el = $("." + c); return el ? el.scrollTop : 0; });
    const route = S.route === "mine" ? "issues" : S.route;
    const view = views[route] || views.home;
    const app = $("#app");
    app.className = ("app " + (route === "pit" ? "pit " : "") + "role-" + S.role + (S.density === "compact" ? " dense" : "")).trim();
    $("#side").innerHTML = sideHtml();
    $("#page").innerHTML = view();
    if (!canWrite() && route !== "settings") lockPage();
    const l = $(".list"), p = $(".panel");
    if (l) l.scrollTop = keep[0];
    if (p) p.scrollTop = keep[1];
    settle(snap, route);
    document.title = `${unread() ? `(${unread()}) ` : ""}${F.team.short || "008"} Workspace`;
  }

  /* ---------- actions ---------- */
  function toast(text, label, fn) {
    const t = $("#toast");
    t.innerHTML = `<span>${esc(text)}</span>${label ? `<button>${esc(label)}</button>` : ""}`;
    if (arrive(t, toastRuns(t))) anim(t, [{ transform: "translate(-50%, 0) scale(.96)" }, { transform: "translate(-50%, 0)" }], { duration: 260, easing: EASE.spring });
    if (label) t.querySelector("button").onclick = () => { hideToast(); fn(); };
    clearTimeout(S.toastTimer);
    S.toastTimer = setTimeout(hideToast, 6500);
  }
  const hideToast = () => { const t = $("#toast"); leave(t, toastRuns(t)); };
  function setStatus(i, s) {
    if (!canWrite()) return;
    if (i.status !== s) motion.bump = i.id;
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
  function closeIssue() {
    const p = $(".panel");
    if (!p || p.classList.contains("leaving")) return go("issues");
    p.classList.add("leaving");
    const a = anim(p, [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateX(24px)" }], { duration: 160, easing: EASE.in, fill: "forwards" });
    if (a) a.finished.then(() => go("issues"), () => {}); else go("issues");
  }

  /* A button waiting on the server says what it is doing: "Sign in" reads "Signing in…" until the request settles.
     The label only changes once the wait passes BUSY_AFTER ms, so quick requests don't flash it. */
  const ING = { Add: "Adding", Check: "Checking", Create: "Creating", Delete: "Deleting", Draft: "Drafting", Log: "Logging", Make: "Making", Remove: "Removing", Reset: "Resetting", Save: "Saving", Send: "Sending", Sign: "Signing" };
  const BUSY_AFTER = 150;
  /** Disables btn at once and relabels it (or its text part, label) if the wait drags on. Returns a function that puts it back. */
  function busy(btn, label = btn) {
    if (!btn || !label) return () => {};
    const was = label.textContent;
    const [verb, ...rest] = was.trim().split(/\s+/);
    btn.disabled = true; btn.setAttribute("aria-busy", "true");
    const show = setTimeout(() => {
      const w = btn.offsetWidth;
      if (w) btn.style.minWidth = w + "px";
      btn.classList.add("busy");
      label.textContent = btn.dataset.busy || (ING[verb] ? [ING[verb], ...rest].join(" ") : was.trim()) + "…";
    }, BUSY_AFTER);
    return () => {
      clearTimeout(show);
      btn.disabled = false; btn.removeAttribute("aria-busy");
      if (btn.classList.contains("busy")) { btn.classList.remove("busy"); btn.style.minWidth = ""; label.textContent = was; }
    };
  }

  function showModal(html) {
    const ov = $("#ov-modal");
    $("#modal").innerHTML = html;
    if (arrive(ov, ovRuns(ov))) reveal([$("#modal").firstElementChild], { y: 4 });
    const f = $("#modal input:not([type=checkbox]), #modal select"); if (f) f.focus(); }
  function closeModal() { const ov = $("#ov-modal"); leave(ov, ovRuns(ov)); if (S.dirty) setTimeout(rerenderIfIdle, 50); }
  const modalErr = (m) => { const e = $("#modal .err"); if (e) e.textContent = m; shake($("#modal")); };
  const footer = (ok, cancel = true) => `<p class="err" role="alert" style="padding:0 18px"></p><div class="ft">${cancel ? '<button type="button" class="btn" data-act="close-modal">Cancel</button>' : ""}<button class="btn pri">${ok}</button></div>`;

  function newIssueModal(seed = {}) {
    if (!canWrite()) return toast("You have view-only access.");
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
        <p class="dim" style="margin-bottom:12px">The server checks this repository every few minutes and links pull requests to issues. For a private repository, add an access token afterwards in Settings, Integrations.</p>
        <input class="in mono" name="repo" placeholder="owner/repo" pattern="[A-Za-z0-9_.\\-]+/[A-Za-z0-9_.\\-]+" required maxlength="100" autocomplete="off" aria-label="Repository">
      </div>${footer("Save")}
    </form>`);
  }
  const simpleModal = (attr, title, fields, ok) => showModal(`<form ${attr}><div class="hd">${title}</div><div class="bd">${fields}</div>${footer(ok)}</form>`);

  /* command palette */
  const PALETTE_CONFIG_KEY = "008-pal";
  const PALETTE_RECENT_KEY = "008-pal-recent";
  const PALETTE_RECENT_STORED = 5;
  const PALETTE_RECENT_SHOWN = 3;
  const PALETTE_PROMPT = "Type a command, or search";
  const PALETTE_SUGGESTIONS_SHOWN = { suggest: 6, both: 4, menu: 1 };
  const PALETTE_PRESETS = {
    minimal: { ghost: true, empty: "suggest", chips: false, tokens: false, preview: false, recents: false, undo: true, ai: true },
    grammar: { ghost: true, empty: "menu", chips: true, tokens: true, preview: false, recents: false, undo: true, ai: true },
    context: { ghost: true, empty: "suggest", chips: false, tokens: false, preview: true, recents: true, undo: true, ai: true },
    mix: { ghost: true, empty: "both", chips: true, tokens: true, preview: true, recents: true, undo: true, ai: true },
  };
  const PALETTE_DEFAULT_PRESET = "mix";
  const PALETTE_PRESET_LABELS = [["minimal", "Minimal"], ["grammar", "Grammar"], ["context", "Context"], ["mix", "Mix"]];
  const PALETTE_EMPTY_LABELS = [["suggest", "Suggestions"], ["both", "Both"], ["menu", "Commands"]];
  const PALETTE_TOGGLES = [
    ["ghost", "Ghost text", "A faded completion after your cursor. Tab or the right arrow accepts it."],
    ["chips", "Grammar chips", "Shows the command as chips, with the next gap highlighted."],
    ["tokens", "Highlight as you type", "Dims the verbs and turns finished values into chips inside the input."],
    ["preview", "Preview bar", "Shows the exact change before you press Enter."],
    ["recents", "Recent commands", "Lists the last few commands you ran when the box is empty."],
    ["undo", "Undo after running", "Offers to take a command back for a few seconds."],
    ["ai", "Ask the workspace", "Type a question that starts with what's, like what's blocking the lift. After a pause, an AI model answers from the team's data."],
  ];
  const PALETTE_SLOT_NAMES = { pri: "priority", sub: "subsystem", accent: "color", role: "view" };

  const readStorage = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch (e) { return fallback; } };
  const writeStorage = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* storage unavailable */ } };

  const palette = { engine: null, config: loadPaletteConfig(), result: null, localRows: [], rows: [], index: 0, chipsShown: new Set(), ask: null };

  function loadPaletteConfig() {
    const base = PALETTE_PRESETS[PALETTE_DEFAULT_PRESET], stored = readStorage(PALETTE_CONFIG_KEY, {});
    const config = { ...base };
    for (const key of Object.keys(base)) if (typeof stored[key] === typeof base[key]) config[key] = stored[key];
    if (!PALETTE_EMPTY_LABELS.some(([value]) => value === config.empty)) config.empty = base.empty;
    return config;
  }
  function updatePaletteConfig(changes) {
    palette.config = { ...palette.config, ...changes };
    writeStorage(PALETTE_CONFIG_KEY, palette.config);
  }
  const paletteSettingKeys = Object.keys(PALETTE_PRESETS[PALETTE_DEFAULT_PRESET]);
  const currentPalettePreset = () => Object.keys(PALETTE_PRESETS).find((name) => paletteSettingKeys.every((key) => PALETTE_PRESETS[name][key] === palette.config[key])) ?? "custom";

  function paletteEnvironment() {
    const clearIssueSelection = () => { S.view = S.role === "captain" ? "open" : "mine"; S.sub = ""; };
    return {
      F,
      accents: ACCENTS,
      ctx: {
        route: S.route === "mine" ? "issues" : S.route, arg: S.arg, me: F.me,
        theme: document.documentElement.getAttribute("data-theme"), themePref: themePref(),
        accent: S.accent, density: S.density, role: S.role, canWrite: canWrite(), admin: isAdmin(),
      },
      act: {
        go: (page) => {
          if (page === "mine") { S.view = "mine"; S.sub = ""; return go("issues"); }
          if (page === "issues") { if (S.view === "mine") S.view = "open"; S.sub = ""; }
          go(page);
        },
        openIssue,
        filterSub: (sub) => { S.sub = sub; S.view = "open"; go("issues"); render(); },
        setTheme: (value) => vt(() => { setThemePref(value); render(); }),
        toggleTheme: () => vt(toggleTheme),
        setAccent: (value) => vt(() => { applyAccent(value); render(); }),
        setDensity: (value) => { S.density = value; saveUi(); render(); },
        setRole: (value) => { S.role = value; clearIssueSelection(); saveUi(); render(); },
        setStatus: (id, status) => { setStatus(byId(id), status); render(); },
        setWho: (id, who) => { const issue = byId(id); issue.who = who; persist("issues", issue); render(); },
        setField: (id, field, value) => { const issue = byId(id); issue[field] = value || undefined; persist("issues", issue); render(); },
        newIssue: (title) => newIssueModal({ title }),
        draft,
        connectGithub: githubModal,
        signOut: logout,
      },
    };
  }

  function openPalette() {
    const overlay = $("#ov-pal"), input = $("#pal-in");
    palette.engine = CMD.create(paletteEnvironment());
    palette.chipsShown.clear();
    askCache.clear();
    arrive(overlay, ovRuns(overlay));
    input.value = "";
    paletteUpdate();
    input.focus();
  }
  function closePalette() { askCancel(); const ov = $("#ov-pal"); leave(ov, ovRuns(ov)); }

  function recentRows() {
    return readStorage(PALETTE_RECENT_KEY, []).map((text) => palette.engine.analyze(text).rows.find((row) => row.complete && row.text === text)).filter(Boolean);
  }
  function paletteRowsFor(result) {
    if (!result.empty) return result.rows;
    const { config } = palette, taken = new Set();
    const section = (rows, name) => rows.filter((row) => !taken.has(row.text) && taken.add(row.text)).map((row) => ({ ...row, section: name }));
    return [
      ...section(result.rows.slice(0, PALETTE_SUGGESTIONS_SHOWN[config.empty]), "Suggested"),
      ...(config.recents ? section(recentRows().slice(0, PALETTE_RECENT_SHOWN), "Recent") : []),
      ...(config.empty === "suggest" ? [] : section(result.menu, "Commands")),
    ];
  }

  /* Ask the workspace: a question like "what's blocking the lift" goes to the server once typing pauses.
     The answer arrives below the local matches, so it never moves the row Enter would run. */
  const ASK_QUESTION = /^what(?:['\u2019]s|s| is| are)\s+\S/i;
  const ASK_DEBOUNCE_MS = 1500;
  const ASK_MIN_CHARS = 12;
  const askCache = new Map();

  function askCancel() {
    const { ask } = palette;
    palette.ask = null;
    if (ask) { clearTimeout(ask.timer); if (ask.abort) ask.abort.abort(); }
  }
  function askSync() {
    const text = $("#pal-in").value.trim().replace(/\s+/g, " ");
    if (!(S.ask && S.aiOn && palette.config.ai) || text.length < ASK_MIN_CHARS || !ASK_QUESTION.test(text)) return askCancel();
    if (palette.ask && palette.ask.text === text) return;
    askCancel();
    const hit = askCache.get(text.toLowerCase());
    if (hit) { palette.ask = { text, state: "done", ...hit }; return; }
    palette.ask = { text, state: "waiting", timer: setTimeout(() => askFetch(text), ASK_DEBOUNCE_MS) };
  }
  async function askFetch(text) {
    const ask = palette.ask;
    if (!ask || ask.text !== text) return;
    ask.state = "thinking";
    ask.abort = new AbortController();
    paletteRefresh();
    try {
      const data = await call("POST", "/api/ask", { q: text }, ask.abort.signal);
      if (palette.ask !== ask) return;
      const result = { answer: data.answer, issues: data.issues.filter((id) => byId(id)) };
      askCache.set(text.toLowerCase(), result);
      Object.assign(ask, result, { state: "done" });
    } catch (e) {
      if (palette.ask !== ask) return;
      if (e.status === 429) Object.assign(ask, { state: "done", answer: e.message, issues: [] });
      else palette.ask = null;
    }
    paletteRefresh();
  }
  function askRows() {
    const { ask } = palette;
    if (!ask) return [];
    if (ask.state === "waiting") return [{ ai: true, kind: "waiting", section: "Answer", label: "Ask the workspace", detail: "Answers when you stop typing" }];
    if (ask.state === "thinking") return [{ ai: true, kind: "thinking", section: "Answer", label: "Looking through the workspace" }];
    return [
      { ai: true, kind: "answer", section: "Answer", label: ask.answer },
      ...ask.issues.map((issue) => ({ ai: true, kind: "issue", issue, section: "From the answer", label: "FTC-" + issue })),
    ];
  }

  function paletteUpdate() {
    palette.result = palette.engine.analyze($("#pal-in").value);
    palette.localRows = paletteRowsFor(palette.result);
    askSync();
    palette.rows = [...palette.localRows, ...askRows()];
    palette.index = 0;
    paletteDraw();
  }
  /** Redraw after an answer arrives, keeping the highlighted row where it was. */
  function paletteRefresh() {
    palette.rows = [...palette.localRows, ...askRows()];
    palette.index = Math.min(palette.index, Math.max(0, palette.rows.length - 1));
    paletteDraw();
  }

  function typedHtml(typed, segments, finished) {
    if (!segments.length) return esc(typed);
    let html = "", cursor = 0;
    for (const [start, end, kind] of segments) {
      const isChip = kind === "value" && (finished || end < typed.length);
      html += esc(typed.slice(cursor, start)) + `<span class="pg-${kind}${isChip ? " is-chip" : ""}">${esc(typed.slice(start, end))}</span>`;
      cursor = end;
    }
    return html + esc(typed.slice(cursor));
  }

  function chipValueHtml(slot, arg) {
    if (slot === "issue") return `${statusIcon(byId(arg.id).status)}FTC-${arg.id}`;
    if (slot === "person") return `${av(arg.id)}${esc(arg.label)}`;
    if (slot === "status") return `${statusIcon(arg.id)}${esc(arg.label)}`;
    if (slot === "accent") return `<span class="pal-sw" style="--c:${esc(arg.swatch)}"></span>${esc(arg.label)}`;
    if (slot === "title") return `“${esc(arg.id)}”`;
    return esc(arg.label ?? arg.id);
  }
  function chipsHtml(row) {
    if (!row) return '<span class="gc-hint">Start typing, or pick a command below</span>';
    const nextGap = row.parts.findIndex((part) => part.slot && !row.args[part.slot]);
    const shownNow = new Set();
    const html = row.parts.map((part, k) => {
      if (part.words) return `<span class="gw">${esc(part.words[0])}</span>`;
      const arg = row.args[part.slot];
      if (arg) {
        const key = part.slot + ":" + arg.id;
        shownNow.add(key);
        return `<span class="gc fill${palette.chipsShown.has(key) ? "" : " fresh"}">${chipValueHtml(part.slot, arg)}</span>`;
      }
      return `<span class="gc ${k === nextGap ? "now" : "next"}">${esc(PALETTE_SLOT_NAMES[part.slot] ?? part.slot)}</span>`;
    }).join("");
    palette.chipsShown = shownNow;
    return html;
  }

  function rowRightText(row) {
    if (row.why) return `<span class="r why ${row.tone || ""}">${esc(row.why)}</span>`;
    return `<span class="r">${esc(row.hint || row.group)}</span>`;
  }
  const GAP_CHIP = '<span class="gc next mini" aria-hidden="true"></span>';
  const templateHtml = (row) => row.parts.map((part) => (part.words ? esc(part.words[0]) : `<span class="gc next" aria-hidden="true">${esc(PALETTE_SLOT_NAMES[part.slot] ?? part.slot)}</span>`)).join(" ");
  function rowLabelHtml(row) {
    if (row.menu) return templateHtml(row);
    return row.complete || !row.label.endsWith(" \u2026") ? esc(row.label) : esc(row.label.slice(0, -2)) + " " + GAP_CHIP;
  }
  function askRowHtml(row, k) {
    const on = `role="option" id="pal-o-${k}" aria-label="${esc(row.label)}" aria-selected="${k === palette.index}" data-pi="${k}"`;
    if (row.kind === "issue") {
      const issue = byId(row.issue);
      return `<li ${on} class="${k === palette.index ? "on" : ""}">${statusIcon(issue.status)}<b>FTC-${issue.id}</b><span class="d">${esc(issue.title)}</span><span class="r">${esc(F.status[issue.status])}</span></li>`;
    }
    const cls = `ai ai-${row.kind}${k === palette.index ? " on" : ""}`;
    if (row.kind === "answer") return `<li ${on} class="${cls}"><span class="ai-text">${esc(row.label)}</span><span class="r">AI answer</span></li>`;
    return `<li ${on} class="${cls}"><span class="ai-text">${esc(row.label)}</span>${row.detail ? `<span class="d">${esc(row.detail)}</span>` : ""}</li>`;
  }
  function paletteRowHtml(row, k) {
    if (row.ai) return askRowHtml(row, k);
    const lead = row.swatch ? `<span class="pal-sw" style="--c:${esc(row.swatch)}"></span>` : "";
    const detail = row.detail ? `<span class="d">${esc(row.detail)}</span>` : "";
    return `<li role="option" id="pal-o-${k}" class="${k === palette.index ? "on" : ""}" aria-label="${esc(row.label)}" aria-selected="${k === palette.index}" data-pi="${k}">${lead}<b>${rowLabelHtml(row)}</b>${detail}${rowRightText(row)}</li>`;
  }
  function listHtml() {
    if (!palette.rows.length) return '<li class="dim" role="presentation">Nothing matches. Try a verb: set, go to, assign, new issue</li>';
    const showHeadings = new Set(palette.rows.map((row) => row.section)).size > 1;
    let section;
    return palette.rows.map((row, k) => {
      const heading = showHeadings && row.section && row.section !== section ? `<li class="pal-head" role="presentation">${esc(row.section)}</li>` : "";
      section = row.section;
      return heading + paletteRowHtml(row, k);
    }).join("");
  }
  const paletteFooterHtml = () => `<span><kbd>↵</kbd> run</span><span><kbd>Tab</kbd> complete</span><span><kbd>↑↓</kbd> move</span><button class="pal-gear" data-act="palette-settings">Customize</button>`;

  function effectHtml(effect) {
    if (effect.text) return `<b>${esc(effect.text)}</b>`;
    return `<span class="fx-label">${esc(effect.label)}</span><span class="fx-from">${esc(effect.from)}</span><span class="fx-arrow">${ico("arrow")}</span><span class="gc fill">${esc(effect.to)}</span>`;
  }
  function previewHtml(row) {
    if (!row) return '<span class="pv-idle">Nothing to run yet</span>';
    if (!row.complete) return `<b>${esc(row.label)}</b><span class="d">Press <kbd>${ico("tab")}</kbd> to fill in the rest</span>`;
    return `${row.effect ? effectHtml(row.effect) : `<b>${esc(row.label)}</b>`}${row.detail ? `<span class="d">${esc(row.detail)}</span>` : ""}`;
  }

  function paletteDraw() {
    const { config, result } = palette;
    const input = $("#pal-in"), typed = input.value, picked = palette.rows[palette.index], row = picked && !picked.ai ? picked : undefined;
    const ghost = config.ghost ? result.ghost : "";
    const segments = config.tokens && row && !result.empty ? row.segments : [];
    $("#pal").className = `dlg pal${config.tokens ? " has-tokens" : ""}${config.chips ? " has-chips" : ""}${config.preview ? " has-preview" : ""}`;
    $("#pal-ghost").innerHTML = `<span class="pg-typed">${typedHtml(typed, segments, row && row.complete)}</span>`
      + (ghost ? `<span class="pg-rest">${esc(ghost)}</span>` : "")
      + (!typed && !ghost ? `<span class="pg-rest">${PALETTE_PROMPT}</span>` : "");
    $("#pal-ghost").scrollLeft = input.scrollLeft;
    $("#pal-accept").hidden = !ghost;
    $("#pal-chips").innerHTML = config.chips ? chipsHtml(row) : "";
    $("#pal-list").innerHTML = listHtml();
    $("#pal-preview").innerHTML = config.preview ? previewHtml(row) : "";
    $("#pal-foot").innerHTML = paletteFooterHtml();
    input.setAttribute("aria-activedescendant", picked ? "pal-o-" + palette.index : "");
    const selected = $("#pal-o-" + palette.index);
    if (selected && selected.scrollIntoView) selected.scrollIntoView({ block: "nearest" });
  }

  function paletteMove(step) {
    if (!palette.rows.length) return;
    palette.index = (palette.index + step + palette.rows.length) % palette.rows.length;
    paletteDraw();
  }
  function paletteFill(text) {
    const input = $("#pal-in");
    input.value = text;
    input.setSelectionRange(text.length, text.length);
    paletteUpdate();
    input.focus();
  }
  function paletteAccept() {
    const { result, config } = palette, row = palette.rows[palette.index];
    if (palette.index === 0 && config.ghost && result.ghost) return paletteFill(result.typed + result.ghost);
    if (row && !row.ai) paletteFill(row.text);
  }
  function rememberCommand(row) {
    if (row.command === "open" || row.command === "page") return;
    const recent = [row.text, ...readStorage(PALETTE_RECENT_KEY, []).filter((text) => text !== row.text)];
    writeStorage(PALETTE_RECENT_KEY, recent.slice(0, PALETTE_RECENT_STORED));
  }
  function paletteRun(row) {
    closePalette();
    rememberCommand(row);
    const toastBefore = S.toastTimer;
    const undo = row.run();
    if (palette.config.undo && typeof undo === "function" && S.toastTimer === toastBefore) toast(row.label + ".", "Undo", undo);
  }
  function paletteChoose(k) {
    const row = palette.rows[k];
    if (!row) return;
    if (row.ai) { if (row.issue) { closePalette(); openIssue(row.issue); } return; }
    if (row.complete) paletteRun(row);
    else paletteFill(row.text);
  }
  function paletteKey(e) {
    const input = $("#pal-in"), atEnd = input.selectionStart === input.value.length && input.selectionEnd === input.value.length;
    const ghostShown = palette.config.ghost && palette.result.ghost;
    if (e.key === "Escape") closePalette();
    else if (e.key === "ArrowDown") paletteMove(1);
    else if (e.key === "ArrowUp") paletteMove(-1);
    else if (e.key === "Enter") paletteChoose(palette.index);
    else if (e.key === "Tab" && !e.shiftKey) paletteAccept();
    else if (e.key === "ArrowRight" && atEnd && ghostShown) paletteAccept();
    else return;
    e.preventDefault();
  }

  /* ---------- @mention autocomplete ---------- */
  const MENTION_AT = /(?:^|[^\w@])@([\w.-]{0,32})$/;
  let mn = null; // the open menu: { el, at, items, idx }

  function mentionables(query) {
    const q = query.toLowerCase();
    const score = (handle, label) => (handle.startsWith(q) ? 0 : label.toLowerCase().split(/\s+/).some((w) => w.startsWith(q)) ? 1 : label.toLowerCase().includes(q) ? 2 : -1);
    return [
      ...F.people.filter((p) => p.handle && p.id !== F.me).map((p) => ({ handle: p.handle, label: p.name, hint: p.role, person: p.id })),
      ...Object.entries(F.subs).map(([k, v]) => ({ handle: k, label: v, hint: "Everyone following " + v })),
    ].map((x) => ({ ...x, s: score(x.handle, x.label) })).filter((x) => x.s >= 0)
      .sort((a, b) => a.s - b.s || (b.person ? 1 : 0) - (a.person ? 1 : 0)).slice(0, 7);
  }

  /** Where the caret is inside a field, in pixels, by laying the text out in a hidden copy of the field. */
  function caretXY(el, pos) {
    const cs = getComputedStyle(el), div = document.createElement("div");
    for (const p of ["boxSizing", "width", "borderTopWidth", "borderLeftWidth", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
      "fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "wordSpacing", "textTransform", "textIndent", "tabSize"]) div.style[p] = cs[p];
    Object.assign(div.style, { position: "absolute", visibility: "hidden", top: "0", left: "-9999px", overflow: "hidden",
      whiteSpace: el.tagName === "TEXTAREA" ? "pre-wrap" : "pre", overflowWrap: "break-word" });
    div.textContent = el.value.slice(0, pos);
    const mark = document.createElement("span"); mark.textContent = "@";
    div.appendChild(mark);
    document.body.appendChild(div);
    const line = parseFloat(cs.lineHeight) || (parseFloat(cs.fontSize) || 14) * 1.4;
    const r = { top: mark.offsetTop + (parseFloat(cs.borderTopWidth) || 0) - el.scrollTop, left: mark.offsetLeft + (parseFloat(cs.borderLeftWidth) || 0) - el.scrollLeft, h: line };
    div.remove();
    return r;
  }

  function mentionUpdate(el) {
    const pos = el.selectionStart;
    const m = pos != null && el.selectionEnd === pos ? MENTION_AT.exec(el.value.slice(0, pos)) : null;
    const items = m ? mentionables(m[1]) : [];
    if (!items.length) return mentionClose();
    mn = { el, at: pos - m[1].length - 1, items, idx: 0 };
    mentionDraw();
  }
  function mentionDraw() {
    const box = $("#mention");
    box.innerHTML = mn.items.map((x, k) => `<li role="option" id="mn-${k}" aria-selected="${k === mn.idx}" class="${k === mn.idx ? "on" : ""}" data-mn="${k}">
      ${x.person ? av(x.person) : `<span class="av team" aria-hidden="true">${ico("issues")}</span>`}<b>${esc(x.label)}</b><span class="mono dim">@${esc(x.handle)}</span>${x.hint ? `<span class="r">${esc(x.hint)}</span>` : ""}</li>`).join("");
    if (box.hidden) anim(box, [{ opacity: 0, transform: "translateY(-4px)" }, { opacity: 1, transform: "none" }], { duration: 160 });
    box.hidden = false;
    const r = mn.el.getBoundingClientRect(), c = caretXY(mn.el, mn.at);
    const bw = box.offsetWidth || 300, bh = box.offsetHeight || 220;
    let top = r.top + c.top + c.h + 4;
    if (top + bh > innerHeight - 8) top = Math.max(8, r.top + c.top - bh - 4);
    const left = Math.max(8, Math.min(r.left + c.left, innerWidth - bw - 8));
    box.style.top = top + "px"; box.style.left = left + "px";
    mn.el.setAttribute("aria-expanded", "true");
    mn.el.setAttribute("aria-activedescendant", "mn-" + mn.idx);
  }
  function mentionClose() {
    if (!mn) return;
    mn.el.setAttribute("aria-expanded", "false");
    mn.el.removeAttribute("aria-activedescendant");
    mn = null;
    const box = $("#mention"); box.hidden = true; box.innerHTML = "";
  }
  function mentionPick(k) {
    const x = mn.items[k], el = mn.el, ins = "@" + x.handle + " ";
    el.value = el.value.slice(0, mn.at) + ins + el.value.slice(el.selectionStart);
    const at = mn.at + ins.length;
    el.setSelectionRange(at, at);
    mentionClose();
    el.focus();
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
  document.addEventListener("input", (e) => { if (e.target.matches && e.target.matches("[data-mention]")) mentionUpdate(e.target); });
  document.addEventListener("click", (e) => { if (e.target.matches && e.target.matches("[data-mention]")) mentionUpdate(e.target); });
  document.addEventListener("keyup", (e) => { if (/^(ArrowLeft|ArrowRight|Home|End)$/.test(e.key) && e.target.matches && e.target.matches("[data-mention]")) mentionUpdate(e.target); });
  document.addEventListener("focusout", (e) => { if (mn && e.target === mn.el) mentionClose(); });
  window.addEventListener("scroll", () => { if (mn) mentionDraw(); }, true);
  window.addEventListener("resize", () => mentionClose());
  // Capture phase, so the menu gets Enter, Tab, arrows and Escape before forms and shortcuts do.
  window.addEventListener("keydown", (e) => {
    if (!mn || e.target !== mn.el) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { mn.idx = (mn.idx + (e.key === "ArrowDown" ? 1 : -1) + mn.items.length) % mn.items.length; mentionDraw(); }
    else if (e.key === "Enter" || e.key === "Tab") mentionPick(mn.idx);
    else if (e.key === "Escape") mentionClose();
    else return;
    e.preventDefault(); e.stopPropagation();
  }, true);
  $("#mention").addEventListener("mousedown", (e) => {
    const li = e.target.closest("[data-mn]");
    if (li && mn) { e.preventDefault(); mentionPick(+li.dataset.mn); }
  });

  $("#pal").addEventListener("mousedown", (e) => { if (e.target.closest("button, li")) e.preventDefault(); });

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


  /* ---------- shared actions ---------- */
  const assign = (i, who) => { i.who = [who, ...i.who.slice(1).filter((x) => x !== who)]; persist("issues", i); };
  async function copyText(value, message) {
    try { await navigator.clipboard.writeText(value); } catch (err) { /* ignore */ }
    toast(message);
  }
  const REMOVE_LABEL = { issues: "this issue", notebook: "this notebook entry", meetings: "this meeting", parts: "this part", practice: "this session", milestones: "this milestone", phases: "this phase" };
  /** Asks first. btn, if given, shows it is working. */
  async function removeWithConfirm(coll, id, btn) {
    if (!window.confirm(`Delete ${REMOVE_LABEL[coll]}? This can't be undone.`)) return;
    const done = btn ? busy(btn) : () => {};
    try {
      await remove(coll, id);
      if (coll === "issues") go("issues"); else render();
    } catch (err) { done(); writeFailed(err); }
  }
  function finalizeEntry(n) {
    if (!n) return;
    n.status = "final"; persist("notebook", n);
    const i = byId(n.issue); if (i) { i.logged = true; persist("issues", i); }
    toast("Saved to the notebook."); render();
  }
  function openNote(n) {
    if (!n) return;
    if (!n.read) markRead([n.id]);
    if (n.link && /^https:\/\//.test(n.link)) { window.open(n.link, "_blank", "noopener"); render(); } else if (n.link) go(n.link); else render();
  }

  /* ---------- context menus ---------- */
  const withIssue = (id, fn) => () => { const i = byId(id); if (i) fn(i); };
  const choices = (entries, current, pick, icon) => entries.map(([k, label]) => ({ label, check: k === current, icon: icon && icon(k), run: pick(k) }));

  function issueMenu(id) {
    const i = byId(id);
    if (!i) return null;
    const w = canWrite();
    return [
      { label: "Open", icon: ico("arrow"), run: () => openIssue(id) },
      w && "-",
      w && { label: "Status", items: choices(Object.entries(F.status), i.status, (k) => withIssue(id, (x) => { setStatus(x, k); render(); }), statusIcon) },
      w && { label: "Priority", items: choices(Object.entries(F.pri), i.pri, (k) => withIssue(id, (x) => { x.pri = k; persist("issues", x); render(); }), priIcon) },
      w && { label: "Assign to", items: choices(F.people.map((p) => [p.id, p.name]), i.who[0], (k) => withIssue(id, (x) => { assign(x, k); render(); }), av) },
      "-",
      { label: "Copy ID", hint: "FTC-" + id, run: () => copyText("FTC-" + id, `Copied FTC-${id}.`) },
      { label: "Copy branch name", run: () => copyText(branchName(i), "Branch name copied.") },
      w && i.status === "done" && !i.logged && { label: "Draft notebook entry", run: () => draft(id) },
      isAdmin() && "-",
      isAdmin() && { label: "Delete issue", danger: true, run: () => removeWithConfirm("issues", id) },
    ];
  }
  function notebookMenu(id) {
    const n = F.notebook.find((x) => x.id === id);
    if (!n) return null;
    const w = canWrite();
    return [
      { label: "Open", icon: ico("arrow"), run: () => { S.nbSel = id; render(); } },
      w && n.status === "draft" && { label: "Mark as logged", run: () => finalizeEntry(F.notebook.find((x) => x.id === id)) },
      n.issue && { label: "Open FTC-" + n.issue, run: () => openIssue(n.issue) },
      w && "-",
      w && { label: "Delete entry", danger: true, run: () => removeWithConfirm("notebook", id) },
    ];
  }
  function meetingMenu(id) {
    if (!F.meetings.some((x) => x.id === id)) return null;
    return [
      { label: "Open", icon: ico("arrow"), run: () => { S.mtSel = id; render(); } },
      canWrite() && "-",
      canWrite() && { label: "Delete meeting", danger: true, run: () => removeWithConfirm("meetings", id) },
    ];
  }
  function partMenu(id) {
    const p = F.parts.find((x) => x.id === id);
    if (!p) return null;
    const w = canWrite();
    const edit = (fn) => () => { const x = F.parts.find((y) => y.id === id); if (x) { fn(x); persist("parts", x); render(); } };
    return [
      w && p.have < p.need && p.have + p.ordered < p.need && { label: "Mark as ordered", run: edit((x) => { x.ordered = x.need - x.have; }) },
      w && p.have < p.need && { label: "Mark as in stock", run: edit((x) => { x.have = x.need; x.ordered = 0; }) },
      { label: "Copy part name", run: () => copyText(p.name, "Part name copied.") },
      w && "-",
      w && { label: "Remove part", danger: true, run: () => removeWithConfirm("parts", id) },
    ];
  }
  function sessionMenu(id) {
    if (!canWrite() || !F.practice.some((x) => String(x.id) === id)) return null;
    return [{ label: "Remove session", danger: true, run: () => removeWithConfirm("practice", id) }];
  }
  function noteMenu(id) {
    const n = S.inbox.find((x) => x.id === id);
    if (!n) return null;
    return [
      { label: "Open", icon: ico("arrow"), run: () => openNote(S.inbox.find((x) => x.id === id)) },
      !n.read && { label: "Mark as read", run: () => { markRead([id]); render(); } },
    ];
  }
  function subsystemMenu(k) {
    const following = S.prefs.follow.includes(k);
    return [
      { label: "Show issues", icon: ico("arrow"), run: () => { S.sub = k; S.view = "open"; go("issues"); render(); } },
      { label: following ? "Unfollow in Inbox" : "Follow in Inbox", run: () => { S.prefs.follow = following ? S.prefs.follow.filter((x) => x !== k) : [...S.prefs.follow, k]; savePrefs(); render(); } },
    ];
  }

  /** The menu for whatever was right-clicked, or null to leave the browser's own menu (text fields, links, selected text). */
  function contextItems(t) {
    if (!S.ready || S.route === "pit" || document.querySelector(".ov.show")) return null;
    if (t.closest("input, textarea, select, a[href], [contenteditable]")) return null;
    const sel = getSelection();
    let el;
    if ((el = t.closest("[data-issue], [data-issue-go]"))) {
      if (sel && !sel.isCollapsed && el.contains(sel.anchorNode)) return null;
      return issueMenu(+(el.dataset.issue ?? el.dataset.issueGo));
    }
    if ((el = t.closest("[data-nb]"))) return notebookMenu(el.dataset.nb);
    if ((el = t.closest("[data-mt]"))) return meetingMenu(el.dataset.mt);
    if ((el = t.closest("[data-part]"))) return partMenu(el.dataset.part);
    if ((el = t.closest("[data-session]"))) return sessionMenu(el.dataset.session);
    if ((el = t.closest("[data-note]"))) return noteMenu(+el.dataset.note);
    if ((el = t.closest("#side [data-sub]"))) return subsystemMenu(el.dataset.sub);
    return null;
  }
  window.ContextMenu.attach(contextItems);

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
    if ((el = q("[data-draft]"))) { const done = busy(el); draft(el.dataset.draft).finally(done); return; }
    if ((el = q("[data-note]"))) { openNote(S.inbox.find((x) => x.id === +el.dataset.note)); return; }
    if (q("[data-inbox-all]")) { markRead(S.inbox.filter((x) => !x.read && isTeam(x) === (S.iboxTab === "team")).map((x) => x.id)); render(); return; }
    if ((el = q("[data-ibox]"))) { S.iboxTab = el.dataset.ibox; render(); return; }
    if ((el = q("[data-follow]"))) {
      const k = el.dataset.follow, f = S.prefs.follow;
      S.prefs.follow = f.includes(k) ? f.filter((x) => x !== k) : [...f, k];
      savePrefs(); render(); return;
    }
    if ((el = q("[data-finalize]"))) { finalizeEntry(F.notebook.find((x) => x.id === el.dataset.finalize)); return; }
    if ((el = q("[data-nb]"))) { S.nbSel = el.dataset.nb; render(); return; }
    if ((el = q("[data-mt]"))) { S.mtSel = el.dataset.mt; render(); return; }
    if ((el = q("[data-copy]"))) { copyText(el.dataset.copy, el.dataset.copyLabel || "Branch name copied."); return; }
    if ((el = q("[data-rm]"))) { const [coll, id] = el.dataset.rm.split(":"); removeWithConfirm(coll, id, el); return; }
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
      const done = busy(el);
      try {
        const i = await create("issues", { title: a.text, type: "build", sub: "team", pri: "med", status: "todo", who: [a.who], created: F.today, desc: `From the ${m.title.toLowerCase()} on ${F.fmt(m.date)}.` });
        a.issue = i.id; await persist("meetings", m);
        toast(`Created FTC-${i.id}.`, "Open", () => openIssue(i.id)); render();
      } catch (err) { done(); writeFailed(err); }
      return;
    }
    if ((el = q("[data-pal-preset]"))) { if (PALETTE_PRESETS[el.dataset.palPreset]) updatePaletteConfig(PALETTE_PRESETS[el.dataset.palPreset]); render(); return; }
    if ((el = q("[data-pal-empty]"))) { updatePaletteConfig({ empty: el.dataset.palEmpty }); render(); return; }
    if ((el = q("[data-pal-opt]"))) { updatePaletteConfig({ [el.dataset.palOpt]: !palette.config[el.dataset.palOpt] }); render(); return; }
    if (q("#pal-accept")) { paletteAccept(); return; }
    if ((el = q("[data-pi]"))) { paletteChoose(+el.dataset.pi); return; }
    if ((el = q("[data-set-tab]"))) { S.setTab = el.dataset.setTab; render(); return; }
    if ((el = q("[data-tgl]"))) {
      const k = el.dataset.tgl;
      if (k === "autopr") { S.autoPr = !S.autoPr; saveSettings(); } else if (k === "ai") { S.aiOn = !S.aiOn; saveSettings(); } else { S.prefs[k] = !S.prefs[k]; savePrefs(); }
      render(); return;
    }
    if ((el = q("[data-accent]"))) { const v = el.dataset.accent; vt(() => { applyAccent(v); render(); }); return; }
    if ((el = q("[data-theme-set]"))) { const v = el.dataset.themeSet; vt(() => { setThemePref(v); render(); }); return; }
    if ((el = q("[data-density]"))) { S.density = el.dataset.density; saveUi(); render(); return; }
    if (q("[data-logo-clear]")) { F.team.logo = null; saveTeam(); render(); return; }
    if (q("[data-gh-disc]")) { S.repo = null; S.github = { hasToken: S.github.hasToken }; saveSettings(); toast("Disconnected from GitHub."); render(); return; }
    if ((el = q("[data-gh-sync]"))) {
      busy(el);
      try { S.github = await write("POST", "/api/github/sync"); toast(S.github.error || "Checked GitHub."); refresh(); } catch (err) { writeFailed(err); }
      render(); return;
    }
    if ((el = q("[data-gh-token-rm]"))) {
      if (!window.confirm("Remove the GitHub access token? A private repository will stop syncing.")) return;
      busy(el);
      try { S.github = await write("DELETE", "/api/github/token"); toast("Token removed."); } catch (err) { writeFailed(err); }
      render(); return;
    }
    if ((el = q("[data-reset]"))) {
      const p = F.person(el.dataset.reset);
      if (!window.confirm(`Reset ${p.name}'s password? They will be signed out everywhere.`)) return;
      const done = busy(el);
      try { const r = await write("POST", `/api/users/${p.id}/reset`); showTemp("Password reset", p.name, r.password); } catch (err) { writeFailed(err); } finally { done(); }
      return;
    }
    if ((el = q("[data-act]"))) {
      const a = el.dataset.act;
      if (a === "palette") openPalette();
      else if (a === "new") newIssueModal();
      else if (a === "github") githubModal();
      else if (a === "theme") vt(toggleTheme);
      else if (a === "logout") { busy(el, el.querySelector(".n")); logout(); }
      else if (a === "menu") $("#app").classList.toggle("open");
      else if (a === "close-modal") closeModal();
      else if (a === "notif-settings") { S.setTab = "notifications"; go("settings"); }
      else if (a === "palette-settings") { closePalette(); S.setTab = "palette"; go("settings"); }
      else if (a === "close-issue") closeIssue();
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
    if ($("#ov-pal").classList.contains("show")) return paletteKey(e);
    if (e.key === "Escape") {
      if ($("#ov-modal").classList.contains("show")) closeModal();
      else if (S.route === "pit") go("home");
      else if (S.route === "issues" && S.arg) closeIssue();
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
      else if (f === "who") assign(i, t.value);
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
      t.disabled = true;
      try { await write("PATCH", `/api/users/${p.id}`, { access: t.value }); p.access = t.value; toast(`${p.name} is now ${t.value}.`); }
      catch (err) { t.value = prev; toast(err.message); }
      finally { t.disabled = false; }
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
    if (t.id === "pal-in") paletteUpdate();
    else if (t.matches("[data-set]") && t.dataset.set !== "role" && t.dataset.set !== "qual") {
      const v = t.value, k = t.dataset.set;
      if (k === "dname") { F.person(F.me).name = v || "?"; soon("me", saveMe); }
      else if (k === "drole") { F.person(F.me).role = v; soon("me", saveMe); }
      else if (k === "dgh") {
        const gh = v.trim().replace(/^@/, "");
        if (!gh || /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i.test(gh)) { F.person(F.me).gh = gh; soon("me", saveMe); }
      }
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
    const done = busy(f.querySelector("button:not([type=button])"));
    const stale = f.closest("#modal") ? $("#modal .err") : f.querySelector("#auth-err"); if (stale) stale.textContent = "";
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
      } else if (f.matches("[data-ghtoken]")) {
        S.github = await write("PUT", "/api/github/token", { token: d.token });
        toast(S.github.error ? `Token saved, but: ${S.github.error}` : "Token saved. GitHub is linked.");
        refresh(); render();
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

  /* The date rolls over while the app stays open, for example a pit board left on overnight. */
  function checkDay() {
    const d = F.iso(new Date());
    if (d !== F.today) { F.today = d; rerenderIfIdle(); }
  }
  setInterval(checkDay, 60_000);
  document.addEventListener("visibilitychange", checkDay);
  window.addEventListener("focus", checkDay);

  boot();
})();
