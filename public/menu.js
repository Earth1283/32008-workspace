/* Context menus. attach(resolve) turns right-click, the Menu key, Shift+F10 and a touch long-press into a menu.
   resolve(target) returns the items to show, or null to leave the browser's own menu alone.
   An item is { label, run, icon, hint, check, danger, disabled, items }, "-" for a divider or { heading }.
   check true or false makes it a radio-style choice; items makes it a submenu. */
(function () {
  const HOLD_MS = 450, MOVE_SLOP = 10, ECHO_MS = 700;
  const root = document.getElementById("ctx");
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const svg = (d) => `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const CHECK = svg('<path d="m3.5 8.4 3 3 6-6.6"/>');
  const CARET = svg('<path d="m6 3.5 4.5 4.5L6 12.5"/>');
  const EASE_OUT = "cubic-bezier(.22, 1, .36, 1)";

  let actions = [], returnTo = null, heldAt = 0, swallowClick = false;

  const calm = () => !!(window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches);
  const isOpen = () => !root.hidden;
  const levelOf = (el) => (el === root ? root : el.closest(".ctx-sub, #ctx"));
  const itemsOf = (level) => [...level.children].filter((c) => c.classList.contains("ctx-item") && c.getAttribute("aria-disabled") !== "true");

  /** Dividers only between items: none at the ends, never two in a row. */
  function tidy(items) {
    const out = [];
    for (const it of items.filter(Boolean)) {
      if (it === "-" && (!out.length || out[out.length - 1] === "-")) continue;
      out.push(it);
    }
    if (out[out.length - 1] === "-") out.pop();
    return out;
  }

  function listHtml(items) {
    return tidy(items).map((it) => {
      if (it === "-") return '<div class="ctx-sep" role="separator"></div>';
      if (it.heading) return `<div class="ctx-head" role="presentation">${esc(it.heading)}</div>`;
      const sub = it.items && it.items.length;
      const cls = "ctx-item" + (it.danger ? " danger" : "");
      const body = `${it.icon ? `<span class="ctx-ic">${it.icon}</span>` : ""}<span class="ctx-t">${esc(it.label)}</span>${it.hint ? `<span class="ctx-hint">${esc(it.hint)}</span>` : ""}`;
      const dis = it.disabled ? ' aria-disabled="true"' : "";
      if (sub) return `<div class="${cls}" role="menuitem" tabindex="-1" aria-haspopup="menu" aria-expanded="false"${dis}>${body}<span class="ctx-caret">${CARET}</span><div class="ctx-sub" role="menu">${listHtml(it.items)}</div></div>`;
      const k = actions.push(it.run) - 1;
      if (it.check !== undefined) return `<div class="${cls}" role="menuitemradio" aria-checked="${!!it.check}" tabindex="-1" data-ci="${k}"${dis}>${body}<span class="ctx-check">${it.check ? CHECK : ""}</span></div>`;
      return `<div class="${cls}" role="menuitem" tabindex="-1" data-ci="${k}"${dis}>${body}</div>`;
    }).join("");
  }

  function place(x, y) {
    root.style.left = "0px"; root.style.top = "0px";
    const w = root.offsetWidth, h = root.offsetHeight;
    const flipX = x + w > innerWidth - 8, flipY = y + h > innerHeight - 8;
    root.style.left = Math.max(8, flipX ? x - w : x) + "px";
    root.style.top = Math.max(8, flipY ? y - h : y) + "px";
    root.style.transformOrigin = `${flipX ? "right" : "left"} ${flipY ? "bottom" : "top"}`;
  }

  function openSub(item) {
    for (const sib of levelOf(item).children) if (sib !== item && sib.classList && sib.classList.contains("open")) closeSub(sib);
    const sub = item.querySelector(":scope > .ctx-sub");
    if (!sub || item.classList.contains("open")) return sub;
    item.classList.add("open");
    item.setAttribute("aria-expanded", "true");
    sub.classList.remove("flip");
    sub.style.top = "";
    const r = sub.getBoundingClientRect();
    if (r.right > innerWidth - 8) sub.classList.add("flip");
    if (r.bottom > innerHeight - 8) sub.style.top = -(r.bottom - innerHeight + 8) - 5 + "px";
    return sub;
  }
  function closeSub(item) {
    item.classList.remove("open");
    item.setAttribute("aria-expanded", "false");
    item.querySelectorAll(".open").forEach((x) => { x.classList.remove("open"); x.setAttribute("aria-expanded", "false"); });
  }

  const focusItem = (el) => { if (el) el.focus({ preventScroll: true }); };

  function open({ x, y, items, keyboard = false }) {
    close();
    actions = [];
    root.innerHTML = listHtml(items);
    returnTo = document.activeElement;
    root.hidden = false;
    place(x, y);
    if (!calm() && root.animate) root.animate([{ opacity: 0, transform: "scale(.97)" }, { opacity: 1, transform: "none" }], { duration: 130, easing: EASE_OUT });
    root.focus({ preventScroll: true });
    if (keyboard) focusItem(itemsOf(root)[0]);
  }

  function close() {
    if (!isOpen()) return;
    root.hidden = true;
    root.innerHTML = "";
    actions = [];
    const back = returnTo;
    returnTo = null;
    if (back && back.isConnected && back.focus && document.activeElement === document.body) back.focus({ preventScroll: true });
  }

  function choose(item) {
    if (!item || item.getAttribute("aria-disabled") === "true") return;
    if (item.getAttribute("aria-haspopup")) { focusItem(itemsOf(openSub(item))[0]); return; }
    const run = actions[+item.dataset.ci];
    close();
    if (run) run();
  }

  root.addEventListener("click", (e) => { const item = e.target.closest(".ctx-item"); if (item) choose(item); });
  root.addEventListener("contextmenu", (e) => e.preventDefault());
  root.addEventListener("mouseover", (e) => {
    const item = e.target.closest(".ctx-item");
    if (!item || item.getAttribute("aria-disabled") === "true") return;
    focusItem(item);
    if (item.getAttribute("aria-haspopup")) openSub(item);
    else for (const sib of levelOf(item).children) if (sib.classList && sib.classList.contains("open")) closeSub(sib);
  });

  function onKey(e) {
    if (!isOpen() || ["Shift", "Control", "Alt", "Meta"].includes(e.key)) return;
    const at = document.activeElement;
    const inside = root.contains(at);
    const level = inside ? levelOf(at) : root;
    const list = itemsOf(level);
    const at0 = list.indexOf(at);
    const move = (k) => { if (list.length) focusItem(list[(k + list.length) % list.length]); };
    if (e.key === "ArrowDown") move(at0 < 0 ? 0 : at0 + 1);
    else if (e.key === "ArrowUp") move(at0 < 0 ? -1 : at0 - 1);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(-1);
    else if (e.key === "ArrowRight") { if (at0 >= 0 && at.getAttribute("aria-haspopup")) focusItem(itemsOf(openSub(at))[0]); }
    else if (e.key === "ArrowLeft") { const parent = level !== root && level.parentElement; if (parent) { closeSub(parent); focusItem(parent); } }
    else if (e.key === "Enter" || e.key === " ") { if (at0 >= 0) choose(at); }
    else if (e.key === "Escape") {
      const parent = level !== root && level.parentElement;
      if (parent) { closeSub(parent); focusItem(parent); } else close();
    }
    else if (e.key === "Tab") close();
    else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const k = e.key.toLowerCase();
      const next = [...list.slice(at0 + 1), ...list.slice(0, at0 + 1)].find((x) => x.textContent.trim().toLowerCase().startsWith(k));
      focusItem(next);
    }
    else { close(); return; }
    if (e.key !== "Tab") { e.preventDefault(); e.stopPropagation(); }
  }
  window.addEventListener("keydown", onKey, true);
  document.addEventListener("pointerdown", (e) => { if (isOpen() && !root.contains(e.target)) close(); }, true);
  window.addEventListener("scroll", (e) => { if (isOpen() && !root.contains(e.target)) close(); }, true);
  window.addEventListener("resize", close);
  window.addEventListener("blur", close);

  function attach(resolve) {
    document.addEventListener("contextmenu", (e) => {
      if (e.defaultPrevented) return;
      const items = resolve(e.target);
      if (!items) { close(); return; }
      e.preventDefault();
      if (Date.now() - heldAt < ECHO_MS) return;
      const keyboard = e.button === 0 && !e.ctrlKey;
      if (keyboard) {
        const r = e.target.getBoundingClientRect();
        open({ x: r.left + Math.min(24, r.width / 2), y: r.bottom, items, keyboard });
      } else open({ x: e.clientX, y: e.clientY, items });
    });

    let hold = null;
    const cancelHold = () => { if (hold) { clearTimeout(hold.timer); hold = null; } };
    document.addEventListener("pointerdown", (e) => {
      cancelHold();
      if (e.pointerType !== "touch") return;
      const { clientX: x, clientY: y, target } = e;
      hold = { x, y, timer: setTimeout(() => {
        hold = null;
        const items = resolve(target);
        if (!items) return;
        open({ x, y, items });
        heldAt = Date.now();
        swallowClick = true;
      }, HOLD_MS) };
    });
    document.addEventListener("pointermove", (e) => { if (hold && Math.hypot(e.clientX - hold.x, e.clientY - hold.y) > MOVE_SLOP) cancelHold(); });
    document.addEventListener("pointerup", cancelHold);
    document.addEventListener("pointercancel", cancelHold);
    document.addEventListener("click", (e) => {
      if (!swallowClick) return;
      swallowClick = false;
      if (Date.now() - heldAt < 2000) { e.preventDefault(); e.stopPropagation(); }
    }, true);
  }

  window.ContextMenu = { attach, open, close, isOpen };
})();
