import { test, after } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createApp } from "../server/app.js";

let jsdom = null;
try { jsdom = await import("jsdom"); } catch { /* dev dependency not installed */ }
const publicDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const skip = jsdom ? false : "jsdom is not installed (npm install)";

const opened = [];
after(async () => { for (const a of opened) { try { await a.close(); } catch { /* already closed */ } } });

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
  const { JSDOM, VirtualConsole, requestInterceptor } = jsdom.default ?? jsdom;
  const errors = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => errors.push(String(e.detail?.stack || e.message)));
  // Only the app's own files load; Google Fonts and anything else off-host is stubbed out.
  const resources = { interceptors: [requestInterceptor((req) => (req.url.startsWith(base) ? undefined : new Response("", { headers: { "Content-Type": "text/css" } })))] };
  let cookie = "";
  const dom = await JSDOM.fromURL(base + "/", {
    runScripts: "dangerously", resources, pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      w.fetch = async (url, init = {}) => {
        const res = await fetch(new URL(url, base), { ...init, headers: { ...(init.headers || {}), ...(cookie ? { Cookie: cookie } : {}) } });
        const sc = res.headers.get("set-cookie");
        if (sc) cookie = sc.split(";")[0];
        return res;
      };
      w.confirm = () => true;
    },
  });
  const w = dom.window, d = w.document;
  const q = (s) => d.querySelector(s);
  const fire = (el, type) => el.dispatchEvent(new w.Event(type, { bubbles: true, cancelable: true }));
  const type = (el, v) => { el.value = v; fire(el, "input"); };
  const submit = (form) => fire(form, "submit");
  return { app, base, seeded, w, d, q, fire, type, submit, errors, close: async () => { w.close(); await app.close(); } };
}

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
  const post = (base, path, body, cookie) => fetch(base + path, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Client": "seed", ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body),
  });
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
