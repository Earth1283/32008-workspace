import { test, after } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createApp } from "../server/app.js";

let jsdom = null;
try { jsdom = await import("jsdom"); } catch { /* dev dependency not installed */ }
const publicDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const skip = jsdom ? false : "jsdom is not installed (npm install)";

const opened = [], windows = [];
after(async () => {
  for (const w of windows) { try { w.close(); } catch { /* already closed */ } }
  for (const a of opened) { try { await a.close(); } catch { /* already closed */ } }
});

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await tick(20); }
  throw new Error("timed out waiting for " + label);
}

async function open({ before, ...opts } = {}) {
  const app = createApp({ dbPath: ":memory:", publicDir, ...opts });
  opened.push(app);
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const seeded = before ? await before(base) : null;
  const t = await browser(base);
  return { ...t, app, seeded, browser: () => browser(base), close: async () => { t.w.close(); await app.close(); } };
}

/** One browser window on the app. Its clock can be moved forward with advance(ms). */
async function browser(base) {
  const { JSDOM, VirtualConsole, requestInterceptor } = jsdom.default ?? jsdom;
  let shift = 0;
  const errors = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => errors.push(String(e.detail?.stack || e.message)));
  // Only the app's own files load; Google Fonts and anything else off-host is stubbed out.
  const resources = { interceptors: [requestInterceptor((req) => (req.url.startsWith(base) ? undefined : new Response("", { headers: { "Content-Type": "text/css" } })))] };
  let cookie = "", online = true;
  const dom = await JSDOM.fromURL(base + "/", {
    runScripts: "dangerously", resources, pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      w.fetch = async (url, { signal: _jsdomSignal, ...init } = {}) => {
        if (!online) throw new TypeError("Failed to fetch");
        const res = await fetch(new URL(url, base), { ...init, headers: { ...(init.headers || {}), ...(cookie ? { Cookie: cookie } : {}) } });
        const sc = res.headers.get("set-cookie");
        if (sc) cookie = sc.split(";")[0];
        return res;
      };
      w.confirm = () => true;
      const RealDate = w.Date;
      w.Date = class extends RealDate {
        constructor(...a) { if (a.length) super(...a); else super(RealDate.now() + shift); }
        static now() { return RealDate.now() + shift; }
      };
    },
  });
  const w = dom.window, d = w.document;
  windows.push(w);
  const q = (s) => d.querySelector(s);
  const fire = (el, type) => el.dispatchEvent(new w.Event(type, { bubbles: true, cancelable: true }));
  const type = (el, v) => { el.value = v; fire(el, "input"); };
  const submit = (form) => fire(form, "submit");
  const signIn = async (username, password) => {
    await until(() => q("[data-login]"), "login form");
    type(q("[name=username]"), username);
    type(q("[name=password]"), password);
    submit(q("[data-login]"));
  };
  const advance = (ms) => { shift += ms; };
  const goOffline = () => { online = false; };
  const goOnline = () => { online = true; w.dispatchEvent(new w.Event("online")); };
  return { base, w, d, q, fire, type, submit, signIn, advance, goOffline, goOnline, errors, close: async () => { w.close(); } };
}

const post = (base, path, body, cookie) => fetch(base + path, {
  method: "POST", headers: { "Content-Type": "application/json", "X-Client": "seed", ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body),
});

test("demo: sign in, browse every page, edit, and the change reaches the database", { skip }, async () => {
  const t = await open({ demo: true });
  await until(() => t.q("[data-login]"), "login form");
  assert.match(t.q("h1").textContent, /32008/);

  t.type(t.q("[name=username]"), "joseph");
  t.type(t.q("[name=password]"), "wrong");
  t.submit(t.q("[data-login]"));
  await until(() => /Wrong username/.test(t.q("#auth-err").textContent), "login error");

  t.type(t.q("[name=password]"), "innovators");
  t.submit(t.q("[data-login]"));
  await until(() => t.q(".ws b"), "app shell");
  assert.match(t.q(".ws b").textContent, /32008 Innovators/);
  assert.match(t.q(".hero h1").textContent, /44 days to the qualifier/);

  for (const r of ["issues", "issues/42", "season", "notebook", "parts", "practice", "meetings", "pit", "settings", "home"]) {
    t.w.location.hash = "#/" + r; await tick();
    assert.ok(t.q("#page").innerHTML.length > 200, r + " rendered");
  }

  // change an issue's status through the panel; the server must see it
  t.w.location.hash = "#/issues/45"; await tick();
  const sel = t.q('[data-field="status"]');
  sel.value = "doing"; t.fire(sel, "change");
  await until(() => t.app.store.get("issues", 45).status === "doing", "status saved");

  // comment
  t.w.location.hash = "#/issues/45"; await tick();
  const f = t.q("[data-cmt]"); f.elements.t.value = "On it.";
  t.submit(f);
  await until(() => t.app.store.get("issues", 45).notes.some((n) => n.text === "On it."), "comment saved");

  // new issue via modal
  t.w.document.dispatchEvent(new t.w.KeyboardEvent("keydown", { key: "c" }));
  const nf = await until(() => t.q("[data-new]"), "new issue modal");
  nf.elements.title.value = "Calibrate the camera"; nf.elements.sub.value = "vision";
  t.submit(nf);
  await until(() => t.app.store.list("issues").some((i) => i.title === "Calibrate the camera" && i.type === "code"), "issue created");

  // done -> offer a notebook draft
  t.w.location.hash = "#/issues/45"; await tick();
  const s2 = t.q('[data-field="status"]'); s2.value = "done"; t.fire(s2, "change");
  const btn = await until(() => t.q("#toast button"), "draft toast");
  btn.click();
  await until(() => t.w.location.hash === "#/notebook" && t.q("[data-nbf=problem]"), "notebook editor");
  const prob = t.q("[data-nbf=problem]"); prob.value = "Connector wiggled loose."; t.fire(prob, "input");
  await until(() => t.app.store.list("notebook").some((n) => n.issue === 45 && n.problem === "Connector wiggled loose."), "notebook saved", 4000);
  t.q("[data-finalize]").click();
  await until(() => t.app.store.get("issues", 45).logged === true, "issue marked logged");

  // parts: add one
  t.w.location.hash = "#/parts"; await tick();
  const pf = t.q("[data-addpart]");
  pf.elements.name.value = "Servo"; pf.elements.need.value = "2"; pf.elements.price.value = "19.99";
  t.submit(pf);
  await until(() => t.app.store.list("parts").some((p) => p.name === "Servo"), "part added");

  // meetings: new meeting, agenda, action -> issue
  t.w.location.hash = "#/meetings"; await tick();
  t.q('[data-act="new-meeting"]').click();
  const mf = await until(() => t.q("[data-newmeeting]"), "meeting modal");
  mf.elements.title.value = "Pit prep";
  t.submit(mf);
  await until(() => t.app.store.list("meetings").some((m) => m.title === "Pit prep"), "meeting created");
  const af = await until(() => t.q("[data-action]"), "action form");
  af.elements.t.value = "Pack spare batteries"; t.submit(af);
  const mk = await until(() => t.q("[data-mkissue]"), "make-issue button");
  mk.click();
  await until(() => t.app.store.list("issues").some((i) => i.title === "Pack spare batteries"), "issue from action");

  // settings: team name persists; qualifier date drives the countdown
  t.w.location.hash = "#/settings"; await tick();
  t.q('[data-set-tab="workspace"]').click(); await tick();
  t.type(t.q('[data-set="tname"]'), "Innovators Robotics");
  await until(() => t.app.store.meta("team").name === "Innovators Robotics", "team saved", 4000);

  // sign out returns to the login form
  t.q('[data-act="logout"]').click();
  await until(() => t.q("[data-login]"), "back at login");

  assert.deepEqual(t.errors, []);
  await t.close();
});

test("fresh install: setup screen creates the admin and lands in an empty workspace", { skip }, async () => {
  const t = await open();
  const form = await until(() => t.q("[data-setup]"), "setup form");
  const set = (n, v) => { form.elements[n].value = v; };
  set("num", "32008"); set("name", "Innovators"); set("short", "008");
  t.type(form.elements.aname, "Joseph");
  assert.equal(form.elements.username.value, "joseph", "username suggested from name");
  set("password", "correct horse"); set("qualifier", "2099-12-06");
  t.submit(form);
  await until(() => t.q(".ws b"), "workspace");
  assert.match(t.q(".ws b").textContent, /32008 Innovators/);
  assert.match(t.q(".hero h1").textContent, /days to the qualifier/);

  for (const r of ["issues", "season", "notebook", "parts", "practice", "meetings", "pit", "settings", "home"]) {
    t.w.location.hash = "#/" + r; await tick();
    assert.ok(t.q("#page").innerHTML.length > 100, r + " renders when empty");
  }
  assert.deepEqual(t.errors, []);
  await t.close();
});

test("a new member is forced to choose a password before entering", { skip }, async () => {
  const t = await open({
    async before(base) {
      const setup = await post(base, "/api/setup", { team: { num: "32008", name: "Innovators" }, admin: { name: "Joseph", username: "joseph", password: "correct horse" } });
      const cookie = setup.headers.get("set-cookie").split(";")[0];
      return (await (await post(base, "/api/users", { name: "Mika", username: "mika", access: "Member" }, cookie)).json()).password;
    },
  });
  await until(() => t.q("[data-login]"), "login form");
  t.type(t.q("[name=username]"), "mika");
  t.type(t.q("[name=password]"), t.seeded);
  t.submit(t.q("[data-login]"));
  const gate = await until(() => t.q("[data-pw-forced]"), "password gate");
  assert.equal(t.q(".ws"), null, "app shell is not shown yet");

  gate.elements.current.value = t.seeded; gate.elements.next.value = "short";
  t.submit(gate);
  await until(() => /at least 8/.test(t.q("#auth-err").textContent), "short password rejected");

  gate.elements.next.value = "a much better one";
  t.submit(gate);
  await until(() => t.q(".ws b"), "app shell after password change");
  assert.deepEqual(t.errors, []);
  await t.close();
});

test("two people editing the same issue at once both keep their changes", { skip }, async () => {
  const a = await open({ demo: true });
  const b = await a.browser();
  await a.signIn("joseph", "innovators");
  await b.signIn("joseph", "innovators");
  await until(() => a.q(".ws b") && b.q(".ws b"), "both signed in");
  a.w.location.hash = b.w.location.hash = "#/issues/45"; await tick();

  // Both comment before either hears about the other, so one save is made from a stale copy.
  const fa = a.q("[data-cmt]"), fb = b.q("[data-cmt]");
  fa.elements.t.value = "From A."; fb.elements.t.value = "From B.";
  a.submit(fa); b.submit(fb);
  const texts = () => a.app.store.get("issues", 45).notes.map((n) => n.text);
  await until(() => texts().includes("From A.") && texts().includes("From B."), "both comments saved");
  assert.equal(texts().filter((x) => x === "From A.").length, 1, "no duplicate comment");

  // One edits the description while the other changes the status.
  a.type(a.q("[data-desc]"), "Check the wiring first.");
  const st = b.q('[data-field="status"]'); st.value = "review"; b.fire(st, "change");
  await until(() => { const i = a.app.store.get("issues", 45); return i.desc === "Check the wiring first." && i.status === "review"; }, "both fields saved", 4000);

  // jsdom has no EventSource, so there are no live updates here. Each window's next save brings it up to date.
  const pa = a.q('[data-field="pri"]'); pa.value = "high"; a.fire(pa, "change");
  await until(() => a.q('[data-field="status"]').value === "review", "A sees the status");
  const pb = b.q('[data-field="pri"]'); pb.value = "low"; b.fire(pb, "change");
  await until(() => b.q("[data-desc]").value === "Check the wiring first.", "B sees the description");
  await until(() => a.app.store.get("issues", 45).pri === "low", "last priority wins");
  assert.deepEqual([...a.errors, ...b.errors], []);
  await b.close();
  await a.close();
});

test("a viewer can read everything but gets no edit controls", { skip }, async () => {
  const t = await open({
    async before(base) {
      const setup = await post(base, "/api/setup", { team: { num: "32008", name: "Innovators" }, admin: { name: "Joseph", username: "joseph", password: "correct horse" } });
      const cookie = setup.headers.get("set-cookie").split(";")[0];
      await post(base, "/api/issues", { title: "Tighten the chain", sub: "drive", who: ["x"], created: "2026-10-23" }, cookie);
      return (await (await post(base, "/api/users", { name: "Vic", username: "vic", access: "Viewer" }, cookie)).json()).password;
    },
  });
  await t.signIn("vic", t.seeded);
  const gate = await until(() => t.q("[data-pw-forced]"), "password gate");
  gate.elements.current.value = t.seeded; gate.elements.next.value = "viewer password";
  t.submit(gate);
  await until(() => t.q(".ws b"), "app shell");
  assert.match(t.q(".ws small").textContent, /View only/);

  t.w.location.hash = "#/issues/1"; await tick();
  assert.ok(t.q(".panel"), "the issue still opens");
  assert.equal(t.q('[data-act="new"]'), null, "no New issue button");
  assert.equal(t.q("[data-cmt]"), null, "no comment box");
  assert.ok([...t.q(".panel").querySelectorAll("select, textarea, input")].every((el) => el.disabled), "issue fields are read-only");
  assert.equal(t.q("[data-subf]").disabled, false, "filters still work");

  t.d.dispatchEvent(new t.w.KeyboardEvent("keydown", { key: "3" }));
  t.d.dispatchEvent(new t.w.KeyboardEvent("keydown", { key: "c" }));
  await tick(100);
  assert.equal(t.app.store.get("issues", 1).status, "todo", "status shortcut does nothing");
  assert.equal(t.q("#ov-modal").classList.contains("show"), false, "new issue shortcut does nothing");

  t.w.location.hash = "#/parts"; await tick();
  assert.equal(t.q("[data-addpart]"), null);
  t.w.location.hash = "#/practice"; await tick();
  assert.equal(t.q('[data-act="new-run"]'), null);
  t.w.location.hash = "#/settings"; await tick();
  assert.equal(t.q('[data-set="dname"]').disabled, false, "a viewer can still edit their own profile");
  assert.deepEqual(t.errors, []);
  await t.close();
});

test("the countdown moves on when the date changes while the app is open", { skip }, async () => {
  const t = await open({ demo: true });
  await t.signIn("joseph", "innovators");
  const h = await until(() => t.q(".hero h1"), "home");
  const days = () => Number(/(\d+) days/.exec(t.q(".hero h1").textContent)[1]);
  const before = days();
  t.advance(864e5);
  t.d.dispatchEvent(new t.w.Event("visibilitychange"));
  await until(() => days() === before - 1, "countdown updated");
  assert.ok(h);
  assert.deepEqual(t.errors, []);
  await t.close();
});

test("inbox: a mention shows up, opens the issue and is marked read; settings save to the account", { skip }, async () => {
  const t = await open({ demo: true });
  // Mika mentions Joseph on issue 45 through the API, as if from another device.
  const login = await post(t.base, "/api/login", { username: "mika", password: "innovators" });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const i = t.app.store.get("issues", 45);
  await fetch(t.base + "/api/issues/45", {
    method: "PUT", headers: { "Content-Type": "application/json", "X-Client": "mika", Cookie: cookie },
    body: JSON.stringify({ ...i, notes: [{ who: "mk", text: "@joseph the spare connectors are in the red bin", date: i.created }] }),
  });

  await t.signIn("joseph", "innovators");
  await until(() => t.q(".ws b"), "app shell");
  const nav = t.q('[data-go="inbox"]');
  assert.equal(nav.querySelector(".n.new").textContent, "1");
  assert.match(t.d.title, /^\(1\) /);

  nav.click(); await tick();
  const note = t.q("[data-note]");
  assert.match(note.textContent, /Mika mentioned you on FTC-45/);
  note.click();
  await until(() => t.w.location.hash === "#/issues/45" && t.q(".panel"), "issue opened");
  await until(() => t.app.notifier.list("jc")[0].read, "marked read on the server");
  assert.equal(t.q('[data-go="inbox"] .n.new'), null);

  t.w.location.hash = "#/settings"; await tick();
  t.q('[data-set-tab="notifications"]').click(); await tick();
  t.q('[data-tgl="due"]').click();
  await until(() => t.app.notifier.prefs("jc").due === false, "preference saved");
  t.q('[data-set-tab="integrations"]').click(); await tick();
  assert.equal(t.q('[data-tgl="autopr"]').disabled, false, "admins can change PR automation");
  t.q('[data-tgl="autopr"]').click();
  await until(() => t.app.store.meta("settings").autoPr === false, "PR automation saved");
  t.q('[data-set-tab="profile"]').click(); await tick();
  t.type(t.q('[data-set="dgh"]'), "octo-joe");
  await until(() => t.app.store.get("people", "jc").gh === "octo-joe", "GitHub username saved", 4000);
  assert.deepEqual(t.errors, []);
  await t.close();
});

test("@mention autocomplete: type, pick with the keyboard, and the comment reaches the person", { skip }, async () => {
  const t = await open({ demo: true });
  await t.signIn("joseph", "innovators");
  await until(() => t.q(".ws b"), "app shell");
  t.w.location.hash = "#/issues/45"; await tick();
  const key = (el, k) => el.dispatchEvent(new t.w.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  let input = t.q("[data-cmt] input");
  assert.equal(input.getAttribute("autocomplete"), "off", "no browser autofill on the comment box");
  assert.equal(input.form.getAttribute("autocomplete"), "off");
  assert.ok(input.hasAttribute("data-1p-ignore") && input.getAttribute("data-lpignore") === "true", "password managers stay out");
  const typeAt = (v) => { input.focus(); input.value = v; input.setSelectionRange(v.length, v.length); t.fire(input, "input"); };

  typeAt("Thanks @mi");
  const menu = t.q("#mention");
  assert.equal(menu.hidden, false, "menu opens");
  assert.match(menu.querySelector("li.on").textContent, /Mika/);
  assert.equal(input.getAttribute("aria-expanded"), "true");

  typeAt("Thanks @li");
  const labels = [...menu.querySelectorAll("li b")].map((b) => b.textContent);
  assert.deepEqual(labels.slice(0, 2), ["Lin", "Lift"], "people first, then teams");
  key(input, "ArrowDown");
  assert.match(menu.querySelector("li.on").textContent, /Lift/);
  key(input, "Escape");
  assert.equal(menu.hidden, true, "Escape closes the menu");
  assert.ok(t.q(".panel"), "Escape did not also close the issue");

  typeAt("Thanks @mi");
  key(input, "Enter");
  assert.equal(input.value, "Thanks @mika ", "Enter picks instead of sending");
  assert.equal(menu.hidden, true);
  input.value += "for the connectors";
  t.submit(t.q("[data-cmt]"));
  await until(() => t.app.notifier.list("mk").some((n) => n.text.startsWith("Joseph mentioned you on FTC-45")), "Mika notified");
  await until(() => t.q(".act .mention"), "mention highlighted");
  assert.equal(t.q(".act .mention").textContent, "@mika");
  assert.equal(t.q(".act .mention").title, "Mika");

  input = t.q("[data-cmt] input"); // the panel re-rendered after sending
  typeAt("@sa");
  key(input, "Tab");
  assert.equal(input.value, "@sam ", "Tab picks too");

  // Following from the inbox
  t.w.location.hash = "#/inbox"; await tick();
  t.q('[data-ibox="team"]').click(); await tick();
  t.q('[data-follow="lift"]').click();
  await until(() => t.app.notifier.prefs("jc").follow.includes("lift"), "follow saved");
  assert.equal(t.q('[data-follow="lift"]').getAttribute("aria-pressed"), "true");
  assert.deepEqual(t.errors, []);
  await t.close();
});

test("command center: type a command, complete it with Tab, run it with Enter, and undo it", { skip }, async () => {
  const t = await open({ demo: true });
  await t.signIn("joseph", "innovators");
  await until(() => t.q(".ws b"), "app shell");
  t.w.location.hash = "#/issues/45"; await tick();

  const press = (key, target = t.q("#pal-in")) => target.dispatchEvent(new t.w.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  const ghost = () => t.q("#pal-ghost .pg-rest")?.textContent ?? "";
  t.w.document.dispatchEvent(new t.w.KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }));
  await until(() => t.q("#ov-pal").classList.contains("show"), "palette open");
  assert.match(ghost(), /^set FTC-45 status to /, "empty input ghosts the next step for the open issue");

  t.type(t.q("#pal-in"), "set theme to li");
  assert.equal(ghost(), "ght");
  press("Tab");
  assert.equal(t.q("#pal-in").value, "set theme to light");
  press("Enter");
  await until(() => t.w.document.documentElement.getAttribute("data-theme") === "light", "theme applied");
  const undo = await until(() => t.q("#toast button"), "undo toast");
  assert.match(t.q("#toast").textContent, /Undo/);
  undo.click();

  t.w.document.dispatchEvent(new t.w.KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }));
  await until(() => t.q("#ov-pal").classList.contains("show"), "palette reopened");
  t.type(t.q("#pal-in"), "move 45 to done");
  press("Enter");
  await until(() => t.app.store.get("issues", 45).status === "done", "status changed through the palette");

  t.w.document.dispatchEvent(new t.w.KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }));
  await until(() => t.q("#ov-pal").classList.contains("show"), "palette reopened again");
  t.type(t.q("#pal-in"), "assign ");
  press("Enter");
  assert.match(t.q("#pal-in").value, /^assign FTC-\d+ to $/, "an unfinished command is filled in rather than run");
  assert.deepEqual(t.errors, []);
});

test("command center settings: presets and switches change what the palette shows", { skip }, async () => {
  const t = await open({ demo: true });
  await t.signIn("joseph", "innovators");
  await until(() => t.q(".ws b"), "app shell");
  t.w.location.hash = "#/settings"; await tick();
  t.q('[data-set-tab="palette"]').click();
  await until(() => t.q("[data-pal-preset]"), "command center settings");

  const openPalette = async () => {
    t.w.document.dispatchEvent(new t.w.KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }));
    await until(() => t.q("#ov-pal").classList.contains("show"), "palette open");
  };
  await openPalette();
  t.type(t.q("#pal-in"), "assign FTC-45 to ");
  assert.ok(t.q("#pal-chips .gc.fill"), "the default style shows grammar chips");
  assert.ok(t.q("#pal-preview b, #pal-preview .fx-label"), "and the preview bar");
  t.q("#ov-pal").click();
  await until(() => !t.q("#ov-pal").classList.contains("show"), "palette closed");

  t.q('[data-pal-preset="minimal"]').click();
  await until(() => t.q('[data-pal-preset="minimal"].on'), "minimal selected");
  t.q('[data-pal-opt="ghost"]').click();
  await until(() => t.q('[data-pal-opt="ghost"]').getAttribute("aria-checked") === "false", "ghost switched off");
  assert.ok(t.q('[data-pal-preset="custom"]'), "a hand-tuned mix is labelled custom");

  await openPalette();
  t.type(t.q("#pal-in"), "set theme to li");
  assert.equal(t.q("#pal-ghost .pg-rest"), null, "no ghost text when it is switched off");
  assert.equal(t.q("#pal-chips").innerHTML, "", "no chips in the minimal style");
  assert.equal(t.w.localStorage.getItem("008-pal") !== null, true, "the choice is saved on this device");
  assert.deepEqual(t.errors, []);
});

test("command center: a question waits for a pause, answers below the local rows, and links to issues", { skip }, async () => {
  const asked = [];
  const geminiFetch = async (url, init) => {
    asked.push(JSON.parse(init.body).contents[0].parts[0].text);
    const reply = { answer: "FTC-45 is the one holding up the lift.", issues: [45, 9999] };
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(reply) }] } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const t = await open({ demo: true, geminiKey: "k", geminiFetch });
  await t.signIn("joseph", "innovators");
  await until(() => t.q(".ws b"), "app shell");

  const press = (key) => t.q("#pal-in").dispatchEvent(new t.w.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  t.w.document.dispatchEvent(new t.w.KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }));
  await until(() => t.q("#ov-pal").classList.contains("show"), "palette open");

  t.type(t.q("#pal-in"), "set theme to dark");
  await tick(100);
  assert.equal(t.q(".ai"), null, "ordinary commands never ask");

  t.type(t.q("#pal-in"), "what's blo");
  t.type(t.q("#pal-in"), "what's blocking the lift");
  assert.match(t.q(".ai-waiting").textContent, /Ask the workspace/, "a placeholder row holds the spot while typing");
  await tick(900);
  assert.equal(asked.length, 0, "nothing is sent before the pause");
  await until(() => t.q(".ai-answer"), "the answer", 4000);
  assert.equal(asked.length, 1, "one question, however many keystrokes");
  assert.match(asked[0], /Question: what's blocking the lift/);
  assert.match(t.q(".ai-answer").textContent, /holding up the lift/);
  press("Enter");
  await tick(100);
  assert.ok(t.q("#ov-pal").classList.contains("show"), "Enter on the answer itself does nothing");
  const link = [...t.d.querySelectorAll("#pal-list li")].find((li) => /FTC-45/.test(li.textContent) && li.querySelector("b"));
  assert.ok(link, "the issue the answer names is listed");
  assert.equal([...t.d.querySelectorAll("#pal-list li")].some((li) => /9999/.test(li.textContent)), false, "an issue that doesn't exist is dropped");

  link.click();
  await until(() => !t.q("#ov-pal").classList.contains("show"), "palette closed");
  await until(() => /#\/issues\/45/.test(t.w.location.hash), "issue opened");

  t.w.document.dispatchEvent(new t.w.KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }));
  await until(() => t.q("#ov-pal").classList.contains("show"), "palette reopened");
  t.type(t.q("#pal-in"), "what's blocking the lift");
  await tick(100);
  assert.equal(asked.length, 1, "the same question is not asked twice");
  press("Escape");
  assert.deepEqual(t.errors, []);
  await t.close();
});

test("context menus: right-click an issue to change it, with the keyboard too, and text fields keep the browser's menu", { skip }, async () => {
  const t = await open({ demo: true });
  await t.signIn("joseph", "innovators");
  await until(() => t.q(".ws b"), "app shell");
  t.w.location.hash = "#/issues"; await tick();

  const menu = () => t.q("#ctx");
  const shown = () => !menu().hidden;
  const rightClick = (el) => {
    const ev = new t.w.MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 40, clientY: 40 });
    el.dispatchEvent(ev);
    return ev;
  };
  const key = (k) => t.w.dispatchEvent(new t.w.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  const item = (label) => [...t.d.querySelectorAll("#ctx .ctx-item")].find((x) => x.querySelector(".ctx-t").textContent === label);

  await until(() => t.q('.row[data-issue="45"]'), "issue row");
  const row = () => t.q('.row[data-issue="45"]');
  assert.equal(rightClick(row()).defaultPrevented, true, "the browser's menu is replaced");
  assert.ok(shown());
  assert.deepEqual([...t.d.querySelectorAll("#ctx > .ctx-item > .ctx-t")].map((x) => x.textContent).slice(0, 4), ["Open", "Status", "Priority", "Assign to"]);

  item("Status").click();
  assert.ok(item("Status").classList.contains("open"), "clicking a submenu opens it");
  const was = t.app.store.get("issues", 45).status;
  const pick = [...t.d.querySelectorAll("#ctx .ctx-sub .ctx-item")].find((x) => x.getAttribute("aria-checked") === "false" && /Blocked|In review/.test(x.textContent));
  pick.click();
  assert.ok(!shown(), "choosing closes the menu");
  await until(() => t.app.store.get("issues", 45).status !== was, "status saved");

  rightClick(row());
  assert.ok(shown());
  key("Escape");
  assert.ok(!shown(), "Escape closes it");

  rightClick(row());
  key("ArrowDown"); key("ArrowDown"); key("ArrowDown"); key("ArrowRight");
  assert.ok(item("Priority").classList.contains("open"), "right arrow opens the submenu");
  key("ArrowDown"); key("Enter");
  assert.ok(!shown());
  await until(() => t.app.store.get("issues", 45).pri === "med", "priority saved");

  rightClick(row());
  key("o");
  assert.equal(t.d.activeElement.querySelector(".ctx-t").textContent, "Open", "typing a letter jumps to the item");
  key("Enter");
  await until(() => /#\/issues\/45/.test(t.w.location.hash), "opened from the menu");

  const field = await until(() => t.q("[data-desc]"), "description field");
  assert.equal(rightClick(field).defaultPrevented, false, "text fields keep the browser's menu");
  assert.ok(!shown());

  t.w.location.hash = "#/parts"; await tick();
  const part = await until(() => t.q("tr[data-part]"), "part row");
  rightClick(part);
  assert.ok(item("Copy part name") && item("Remove part"));
  const id = part.dataset.part;
  item("Remove part").click();
  await until(() => !t.app.store.list("parts").some((p) => String(p.id) === id), "part removed after confirm");
  assert.deepEqual(t.errors, []);
  await t.close();
});

const go = async (t, route) => { t.w.location.hash = "#/" + route; await tick(); };
const openDemo = async () => { const t = await open({ demo: true }); await t.signIn("joseph", "innovators"); await until(() => t.q(".ws b"), "app shell"); return t; };
const fieldValue = (t, sel, v) => { const el = t.q(sel); el.value = v; t.fire(el, "input"); t.fire(el, "change"); };

test("issue titles can be edited, and a blank title puts the old one back", { skip }, async () => {
  const t = await openDemo();
  await go(t, "issues/45");
  fieldValue(t, "[data-title]", "A better title");
  await until(() => t.app.store.get("issues", 45).title === "A better title", "title saved", 4000);
  await go(t, "issues/45");
  fieldValue(t, "[data-title]", "   ");
  await tick(100);
  assert.equal(t.q("[data-title]").value, "A better title");
  assert.equal(t.app.store.get("issues", 45).title, "A better title");
  assert.deepEqual(t.errors, []);
  await t.close();
});

test("notebook: dates and titles edit while drafting, logging locks the entry, and deleting it clears the issue's logged mark", { skip }, async () => {
  const t = await openDemo();
  t.w.location.hash = "#/issues/45"; await tick();
  const status = t.q('[data-field="status"]'); status.value = "done"; t.fire(status, "change");
  (await until(() => t.q("#toast button"), "draft toast")).click();
  await until(() => t.q("[data-nbf=date]"), "draft editor");

  fieldValue(t, "[data-nbf=date]", "2026-10-02");
  fieldValue(t, "[data-nbf=title]", "Connector fix");
  const entry = () => t.app.store.list("notebook").find((n) => n.issue === 45);
  await until(() => entry()?.date === "2026-10-02" && entry().title === "Connector fix", "draft fields saved", 4000);

  t.q("[data-finalize]").click();
  await until(() => t.app.store.get("issues", 45).logged === true && entry().status === "final", "logged");
  await until(() => t.q("[data-reopen]"), "reopen button");
  assert.equal(t.q("[data-nbf=problem]").disabled, true, "a logged entry can't be typed in");
  await until(() => entry().log?.[0]?.what === "logged", "server recorded the logging");

  t.q("[data-reopen]").click();
  await until(() => entry().status === "draft" && t.app.store.get("issues", 45).logged === false, "reopened");
  assert.equal(entry().log.at(-1).what, "reopened");
  assert.equal(t.q("[data-nbf=problem]").disabled, false);

  t.q("[data-finalize]").click();
  await until(() => t.app.store.get("issues", 45).logged === true, "logged again");
  await until(() => t.q(`[data-rm^="notebook:"]`), "delete button");
  t.q(`[data-rm^="notebook:"]`).click();
  await until(() => t.app.store.get("issues", 45).logged === false, "deleting clears the logged mark");
  assert.deepEqual(t.errors, []);
  await t.close();
});

test("copying says so when the browser refused", { skip }, async () => {
  const t = await openDemo();
  await go(t, "issues/45");
  t.q("[data-copy]").click();
  await until(() => t.q("#toast")?.textContent, "toast");
  assert.match(t.q("#toast").textContent, /Couldn't copy/);
  await t.close();
});

test("practice: log a run on the score sheet, see it totalled, edit it, and turn it into an issue", { skip }, async () => {
  const t = await openDemo();
  await go(t, "practice");
  assert.ok(t.q(".stat"), "stat tiles");
  const before = t.app.store.list("practice").length;

  t.q('[data-act="new-run"]').click();
  const form = await until(() => t.q("[data-runform]"), "run form");
  form.elements.routine.value = "Close side, 4 tips";
  const plus = (key) => t.q(`[name="c:${key}"]`).parentElement.querySelector('[data-step="1"]');
  plus("leave").click(); plus("parkAuto").click(); plus("tipAuto").click();
  for (let k = 0; k < 3; k++) plus("tipTele").click();
  assert.match(t.q("#run-total").textContent, /88 points/, "live total: 3 + 5 + 80");
  assert.match(t.q("#run-total").textContent, /POLLINATOR 1 4\/4/);
  assert.match(t.q("#run-total").textContent, /POLLINATOR 2 4\/7/);
  form.elements.fail.value = "jam";
  t.submit(form);
  await until(() => t.app.store.list("practice").length === before + 1, "run saved");
  const run = t.app.store.list("practice").find((r) => r.routine === "Close side, 4 tips");
  assert.deepEqual(run.counts, { leave: 1, parkAuto: 1, tipAuto: 1, tipTele: 3 });
  assert.deepEqual(run.drivers, [t.app.store.list("people").find((p) => p.name === "Joseph").id]);

  await until(() => t.q(`[data-run-issue="${run.id}"]`), "make issue button");
  t.q(`[data-run-issue="${run.id}"]`).click();
  await until(() => t.app.store.get("practice", run.id).issue, "run linked to an issue");
  const issue = t.app.store.get("issues", t.app.store.get("practice", run.id).issue);
  assert.match(issue.title, /Mechanism jammed in Close side, 4 tips/);

  await tick(60);
  t.q(`[data-run-edit="${run.id}"]`).click();
  const edit = await until(() => t.q("[data-runform]"), "edit form");
  assert.equal(edit.elements["c:tipTele"].value, "3");
  edit.elements["c:tipTele"].value = "6"; t.fire(edit.elements["c:tipTele"], "input");
  t.submit(edit);
  await until(() => t.app.store.get("practice", run.id).counts.tipTele === 6, "edit saved");
  assert.ok(t.app.store.get("practice", run.id).issue, "the issue link survives an edit");
  assert.deepEqual(t.errors, []);
  await t.close();
});

test("practice: an auto-only run drops TeleOp counts, and filters narrow the numbers", { skip }, async () => {
  const t = await openDemo();
  await go(t, "practice");
  t.q('[data-act="new-run"]').click();
  const form = await until(() => t.q("[data-runform]"), "run form");
  form.elements["c:tipTele"].value = "4";
  const kind = form.elements.kind; kind.value = "auto"; t.fire(kind, "change");
  form.elements.routine.value = "Solo auto";
  t.submit(form);
  await until(() => t.app.store.list("practice").some((r) => r.routine === "Solo auto"), "run saved");
  assert.deepEqual(t.app.store.list("practice").find((r) => r.routine === "Solo auto").counts, {});

  await until(() => t.q("[data-run-filter=runRoutine]"), "filter");
  const pick = t.q("[data-run-filter=runRoutine]"); pick.value = "Close side, 3 tips"; t.fire(pick, "change");
  await tick();
  assert.ok([...t.d.querySelectorAll("tr.run")].every((row) => /Close side, 3 tips/.test(row.textContent)));
  assert.deepEqual(t.errors, []);
  await t.close();
});

test("import: paste cells from a sheet, check the mapping, and only the new rows are added", { skip }, async () => {
  const t = await openDemo();
  await go(t, "parts");
  const known = t.app.store.list("parts")[0].name;
  const count = t.app.store.list("parts").length;
  t.q('[data-act="import"]').click();
  const form = await until(() => t.q("[data-import]"), "import form");
  assert.equal(t.q("[data-import] .btn.pri").disabled, true);
  const paste = form.elements.paste;
  paste.value = `Team parts list\n\nItem\tQty\tOn hand\tCost\tSupplier\tSystem\nUltraplanetary\t2\t1\t$39.99\tREV\tIntake\n${known}\t1\t0\t\t\t\n\t1\t1\t\t\t\n`;
  t.fire(paste, "input");
  await until(() => /1 row ready/.test(t.q(".imp-count")?.textContent ?? ""), "preview");
  assert.equal(t.q("[data-impcol=name]").value, "0");
  assert.match(t.q("#imp-body").textContent, /2 rows left out/);
  t.submit(form);
  await until(() => t.app.store.list("parts").length === count + 1, "part imported");
  const part = t.app.store.list("parts").find((p) => p.name === "Ultraplanetary");
  assert.deepEqual([part.need, part.have, part.price, part.vendor, part.sub], [2, 1, 39.99, "REV", "intake"]);
  await until(() => [...t.d.querySelectorAll("tr[data-part]")].some((r) => /Ultraplanetary/.test(r.textContent)), "shown in the table");
  assert.deepEqual(t.errors, []);
  await t.close();
});

test("offline: edits, comments, new issues, notebook drafts and logged runs wait on the device, then reach the server in order", { skip }, async () => {
  const t = await openDemo();
  const teammate = await t.browser();
  await teammate.signIn("mika", "innovators");
  await until(() => teammate.q(".ws b"), "teammate signed in");
  await go(t, "issues/45");
  t.goOffline();

  const status = t.q('[data-field="status"]'); status.value = "doing"; t.fire(status, "change");
  await until(() => /Offline, 1 saved here/.test(t.q("#net").textContent), "offline pill");
  assert.equal(t.q("#net").hidden, false);
  assert.equal(t.app.store.get("issues", 45).status === "doing", false, "nothing reached the server");

  await go(t, "issues/45");
  const comment = t.q("[data-cmt]"); comment.elements.t.value = "Comment from the pit."; t.submit(comment);
  await tick();

  t.d.dispatchEvent(new t.w.KeyboardEvent("keydown", { key: "c" }));
  const newIssue = await until(() => t.q("[data-new]"), "new issue modal");
  newIssue.elements.title.value = "Fix the pit cart";
  t.submit(newIssue);
  await until(() => [...t.d.querySelectorAll(".row, .card, #toast")].some((el) => /FTC-new/.test(el.textContent)), "local issue shown");
  const local = t.w.FTC.issues.find((i) => i.title === "Fix the pit cart");
  assert.ok(local.id < 0, "a local number until it syncs");

  await go(t, "issues/" + local.id);
  const s = t.q('[data-field="status"]'); s.value = "done"; t.fire(s, "change");
  (await until(() => t.q("#toast button"), "draft toast")).click();
  await until(() => t.q("[data-nbf=problem]"), "draft on a local issue");

  await go(t, "practice");
  t.q('[data-act="new-run"]').click();
  const run = await until(() => t.q("[data-runform]"), "run form");
  run.elements.routine.value = "Logged at the event"; t.submit(run);
  await until(() => t.w.FTC.practice.some((r) => r.routine === "Logged at the event"), "run kept locally");

  await go(t, "settings");
  t.q('[data-set-tab="workspace"]').click(); await tick();
  fieldValue(t, '[data-set="budget"]', "999");
  await until(() => /offline/i.test(t.q("#toast").textContent), "settings say they need a connection", 2000);

  const teammateIssue = t.app.store.get("issues", 45);
  t.app.store.put("issues", 45, { ...teammateIssue, pri: "low" }, "someone");

  t.goOnline();
  await until(() => t.app.store.list("practice").some((r) => r.routine === "Logged at the event"), "run synced", 4000);
  await until(() => t.q("#net").hidden, "queue drained", 4000);
  const issues = t.app.store.list("issues"), synced = issues.find((i) => i.title === "Fix the pit cart");
  assert.ok(synced.id > 0);
  assert.equal(synced.status, "done");
  const merged = t.app.store.get("issues", 45);
  assert.equal(merged.status, "doing");
  assert.equal(merged.pri, "low", "a teammate's change to another field is kept");
  assert.ok(merged.notes.some((n) => n.text === "Comment from the pit."));
  assert.equal(t.app.store.list("notebook").find((n) => n.title === "Fix the pit cart").issue, synced.id, "the draft points at the real number");
  assert.equal(issues.filter((i) => i.title === "Fix the pit cart").length, 1);
  assert.equal(t.w.FTC.issues.some((i) => i.id < 0), false);
  assert.deepEqual(t.errors, []);
  await t.close();
});

test("offline: a change that can't be applied is kept and shown, not lost", { skip }, async () => {
  const t = await openDemo();
  await go(t, "issues/45");
  t.goOffline();
  const status = t.q('[data-field="status"]'); status.value = "doing"; t.fire(status, "change");
  await until(() => /saved here/.test(t.q("#net").textContent), "queued");
  t.app.store.del("issues", 45);

  t.goOnline();
  await until(() => /didn't sync/.test(t.q("#net").textContent), "failure shown", 4000);
  t.q("#net").click();
  await until(() => /deleted this/.test(t.q("#modal").textContent), "reason shown");
  t.q("[data-sync-drop]").click();
  await until(() => !t.q("[data-sync-drop]"), "discarded");
  await tick(60);
  assert.equal(t.q("#net").hidden, true);
  assert.deepEqual(t.errors, []);
  await t.close();
});

test("offline: signing out waits for a connection, and a saved copy opens the app when the server can't be reached", { skip }, async () => {
  const t = await openDemo();
  await tick(60);
  t.goOffline();
  await go(t, "issues/45");
  const status = t.q('[data-field="status"]'); status.value = "doing"; t.fire(status, "change");
  await until(() => /saved here/.test(t.q("#net").textContent), "queued");
  t.q('[data-act="logout"]').click();
  await until(() => /Sign out once/.test(t.q("#toast").textContent), "sign out refused");
  assert.ok(t.q(".ws b"), "still in the app");

  const saved = JSON.parse(t.w.localStorage.getItem("008-state"));
  assert.ok(saved.state.issues.length > 5, "a copy of the team's data is on the device");
  await t.close();
});

test("scouting: find and save an event, shortlist, edit observations, and sync an offline pit visit", { skip }, async () => {
  const calls = [];
  const t = await open({ demo: true, scoutingFetch: async (url) => {
    const u = new URL(url); calls.push(u);
    let data;
    if (u.pathname.includes("/search/")) data = [{ code: "CNHAQ1", name: "Hangzhou Qualifier", start: "2026-11-28" }];
    else if (u.pathname.endsWith("/teams")) data = [{ teamNumber: 32008, stats: { rank: 1, wins: 4, losses: 0, ties: 0, opr: { totalPointsNp: 42, autoPoints: 12 } } }];
    else if (u.pathname.endsWith("/matches")) data = [{ id: 1, tournamentLevel: "Quals", hasBeenPlayed: true, teams: [{ teamNumber: 32008, alliance: "Red" }], scores: { red: { totalPoints: 40 }, blue: { totalPoints: 35 } } }];
    else if (u.pathname === "/graphql") data = { data: { eventByCode: { teams: [{ teamNumber: 32008, team: { name: "Innovators" } }] } } };
    else data = { code: "CNHAQ1", name: "Hangzhou Qualifier", start: "2026-11-28" };
    return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
  } });
  await t.signIn("joseph", "innovators");
  await until(() => t.q('[data-go="scouting"]'), "scouting navigation");
  t.q('[data-go="scouting"]').click();
  await until(() => t.q("[data-scout-search]"), "scouting page");
  assert.match(t.q("#page").textContent, /Start with an event/);
  const search = t.q("[data-scout-search]");
  search.elements.query.value = "Hangzhou";
  t.submit(search);
  const load = await until(() => t.q("[data-scout-load]"), "event search result");
  load.click();
  await until(() => t.q(".scout-teams"), "saved event roster");
  assert.match(t.q(".scout-teams").textContent, /Innovators/);
  assert.equal(t.app.store.list("scoutEvents").length, 1);
  assert.equal(calls.length, 5);
  t.q('[data-scout-pick="32008"]').click();
  await until(() => t.app.store.list("scouting").some((n) => n.shortlist), "shortlist saved");
  t.q('[data-scout-team="32008"]').click();
  await until(() => t.q(".scout-detail"), "team detail");
  t.q('[data-scout-new="32008"]').click();
  let form = await until(() => t.q("[data-scout-observation]"), "observation form");
  form.elements.auto.value = "Reliable left start"; form.elements.note.value = "Quick cycles"; form.elements.rating.value = "4";
  t.submit(form);
  await until(() => t.app.store.list("scouting").some((n) => n.note === "Quick cycles"), "observation saved");
  await tick(80);
  const note = t.app.store.list("scouting").find((n) => n.note === "Quick cycles");
  t.q(`[data-scout-edit="${note.id}"]`).click();
  form = t.q("[data-scout-observation]"); form.elements.note.value = "Good under defense"; t.submit(form);
  await until(() => t.app.store.get("scouting", note.id).note === "Good under defense", "observation edited");
  await tick(80);
  t.goOffline();
  t.q('[data-scout-new="32008"]').click();
  form = t.q("[data-scout-observation]"); form.elements.note.value = "Offline pit visit"; t.submit(form);
  await until(() => /Offline pit visit/.test(t.q("#page").textContent), "offline observation rendered");
  assert.ok(!t.app.store.list("scouting").some((n) => n.note === "Offline pit visit"));
  assert.ok(t.w.Offline.queue(t.w.localStorage, t.w.FTC.me).pendingCount() > 0);
  t.goOnline();
  await until(() => t.app.store.list("scouting").some((n) => n.note === "Offline pit visit"), "offline scouting synced", 6000);
  await until(() => t.w.Offline.queue(t.w.localStorage, t.w.FTC.me).pendingCount() === 0, "scouting queue drained");
  t.q("[data-scout-sources]").click();
  form = t.q("[data-scout-config]"); form.elements.toaKey.value = "secret-key-test"; t.submit(form);
  await until(() => t.app.store.meta("scoutingConfig", {}).toaKey === "secret-key-test", "source credentials saved");
  assert.ok(!t.q("#page").innerHTML.includes("secret-key-test"));
  assert.deepEqual(t.errors, []);
  await t.close();
});
