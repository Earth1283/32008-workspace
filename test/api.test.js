import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createApp } from "../server/app.js";

const publicDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

async function boot(opts = {}) {
  const app = createApp({ dbPath: ":memory:", publicDir, ...opts });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const client = (name = "c1") => {
    let cookie = "";
    const call = async (method, path, body, headers = {}) => {
      const res = await fetch(base + path, {
        method,
        headers: { "Content-Type": "application/json", "X-Client": name, ...(cookie ? { Cookie: cookie } : {}), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const sc = res.headers.get("set-cookie");
      if (sc) cookie = sc.split(";")[0];
      let data = null;
      try { data = await res.json(); } catch { /* not json */ }
      return { status: res.status, data, res };
    };
    return { call, get: (p) => call("GET", p), post: (p, b) => call("POST", p, b ?? {}), put: (p, b) => call("PUT", p, b), del: (p) => call("DELETE", p), patch: (p, b) => call("PATCH", p, b), cookie: () => cookie };
  };
  return { app, base, client, close: () => app.close() };
}

const SETUP = {
  team: { num: "32008", name: "Innovators", short: "008", season: "2026-27" },
  admin: { name: "Joseph", username: "joseph", password: "correct horse" },
  qualifier: { date: "2026-12-06" },
};
const issue = (o = {}) => ({ title: "Fix the thing", sub: "drive", pri: "med", status: "todo", who: ["x"], created: "2026-10-23", ...o });

test("first run: setup creates the admin, then locks", async () => {
  const t = await boot();
  const a = t.client();
  let r = await a.get("/api/session");
  assert.equal(r.data.needsSetup, true);
  assert.equal(r.data.user, null);

  r = await a.post("/api/setup", SETUP);
  assert.equal(r.status, 201);
  assert.equal(r.data.user.access, "Admin");

  r = await a.get("/api/state");
  assert.equal(r.status, 200);
  assert.equal(r.data.team.name, "Innovators");
  assert.equal(r.data.milestones.length, 1);
  assert.equal(r.data.milestones[0].main, true);
  assert.equal(r.data.people.length, 1);

  const b = t.client("c2");
  r = await b.post("/api/setup", SETUP);
  assert.equal(r.status, 409);
  await t.close();
});

test("setup rejects a short password", async () => {
  const t = await boot();
  const r = await t.client().post("/api/setup", { ...SETUP, admin: { ...SETUP.admin, password: "short" } });
  assert.equal(r.status, 400);
  await t.close();
});

test("api requires a session; writes require X-Client", async () => {
  const t = await boot();
  const a = t.client();
  await a.post("/api/setup", SETUP);
  assert.equal((await t.client("x").get("/api/state")).status, 401);
  const r = await a.call("POST", "/api/issues", issue(), { "X-Client": "" });
  assert.equal(r.status, 403);
  const cross = await a.call("POST", "/api/issues", issue(), { Origin: "http://evil.example" });
  assert.equal(cross.status, 403);
  await t.close();
});

test("issues: sequential ids, validation, update, delete rules", async () => {
  const t = await boot();
  const a = t.client();
  await a.post("/api/setup", SETUP);

  let r = await a.post("/api/issues", issue({ title: "First" }));
  assert.equal(r.status, 201);
  assert.equal(r.data.id, 1);
  r = await a.post("/api/issues", issue({ title: "Second" }));
  assert.equal(r.data.id, 2);

  r = await a.post("/api/issues", issue({ title: "" }));
  assert.equal(r.status, 400);
  r = await a.post("/api/issues", issue({ status: "nope" }));
  assert.equal(r.status, 400);
  r = await a.post("/api/issues", issue({ who: [] }));
  assert.equal(r.status, 400);
  r = await a.post("/api/issues", issue({ due: "2026-13-45" }));
  assert.equal(r.status, 400);

  r = await a.put("/api/issues/1", { ...issue({ title: "First, renamed" }), status: "done", evil: "<script>" });
  assert.equal(r.status, 200);
  assert.equal(r.data.title, "First, renamed");
  assert.equal(r.data.status, "done");
  assert.equal("evil" in r.data, false);

  assert.equal((await a.put("/api/issues/99", issue())).status, 404);

  r = await a.del("/api/issues/2");
  assert.equal(r.status, 200);
  r = await a.post("/api/issues", issue({ title: "Third" }));
  assert.equal(r.data.id, 3, "issue numbers are never reused");

  const st = await a.get("/api/state");
  assert.deepEqual(st.data.issues.map((i) => i.id), [1, 3]);
  await t.close();
});

test("members: admin creates a viewer with a temp password that must be changed", async () => {
  const t = await boot();
  const admin = t.client();
  await admin.post("/api/setup", SETUP);

  let r = await admin.post("/api/users", { name: "Mika", username: "mika", role: "Programming", access: "Viewer" });
  assert.equal(r.status, 201);
  const temp = r.data.password;
  assert.match(temp, /^[a-z2-9]{10}$/);

  assert.equal((await admin.post("/api/users", { name: "Dup", username: "MIKA", access: "Member" })).status, 409);

  const mika = t.client("m");
  assert.equal((await mika.post("/api/login", { username: "mika", password: "wrong" })).status, 401);
  r = await mika.post("/api/login", { username: "mika", password: temp });
  assert.equal(r.status, 200);
  assert.equal(r.data.user.mustChange, true);

  assert.equal((await mika.get("/api/state")).status, 403);
  assert.equal((await mika.post("/api/password", { current: temp, next: "short" })).status, 400);
  assert.equal((await mika.post("/api/password", { current: temp, next: "a much better one" })).status, 200);

  r = await mika.get("/api/state");
  assert.equal(r.status, 200);
  assert.equal(r.data.people.find((p) => p.name === "Mika").username, undefined, "usernames are admin-only");

  assert.equal((await mika.post("/api/issues", issue())).status, 403, "viewers cannot write");
  assert.equal((await mika.put("/api/meta/settings", { budget: 1 })).status, 403);
  assert.equal((await mika.post("/api/users", { name: "X", username: "xx", access: "Admin" })).status, 403);

  assert.equal((await admin.patch(`/api/users/${r.data.me.id}`, { access: "Member" })).status, 200);
  assert.equal((await mika.post("/api/issues", issue())).status, 201);
  await t.close();
});

test("cannot demote the last admin; reset forces a new password and ends sessions", async () => {
  const t = await boot();
  const admin = t.client();
  await admin.post("/api/setup", SETUP);
  const me = (await admin.get("/api/state")).data.me.id;
  assert.equal((await admin.patch(`/api/users/${me}`, { access: "Member" })).status, 400);

  const made = await admin.post("/api/users", { name: "Dev", username: "dev", access: "Member" });
  const dev = t.client("d");
  await dev.post("/api/login", { username: "dev", password: made.data.password });
  await dev.post("/api/password", { current: made.data.password, next: "dev's new password" });
  assert.equal((await dev.get("/api/state")).status, 200);

  const reset = await admin.post(`/api/users/${made.data.person.id}/reset`);
  assert.equal(reset.status, 200);
  assert.equal((await dev.get("/api/state")).status, 401, "old session is gone");
  const again = await dev.post("/api/login", { username: "dev", password: reset.data.password });
  assert.equal(again.data.user.mustChange, true);
  await t.close();
});

test("login is throttled after repeated failures", async () => {
  const t = await boot();
  const a = t.client();
  await a.post("/api/setup", SETUP);
  const b = t.client("b");
  for (let i = 0; i < 5; i++) assert.equal((await b.post("/api/login", { username: "joseph", password: "nope" + i })).status, 401);
  assert.equal((await b.post("/api/login", { username: "joseph", password: "correct horse" })).status, 429);
  await t.close();
});

test("settings, team, backup and logout", async () => {
  const t = await boot();
  const a = t.client();
  await a.post("/api/setup", SETUP);

  let r = await a.put("/api/meta/settings", { budget: 1500, branchPrefix: "008", repo: "team/robot" });
  assert.equal(r.status, 200);
  r = await a.put("/api/meta/team", { ...SETUP.team, logo: "javascript:alert(1)" });
  assert.equal(r.status, 400);
  r = await a.put("/api/meta/team", { ...SETUP.team, name: "Innovators 2", logo: "data:image/png;base64,AAAA" });
  assert.equal(r.status, 200);

  const st = (await a.get("/api/state")).data;
  assert.equal(st.settings.budget, 1500);
  assert.equal(st.team.name, "Innovators 2");

  r = await a.get("/api/export");
  assert.equal(r.status, 200);
  assert.equal(r.data.version, 1);
  assert.ok(!JSON.stringify(r.data).includes("scrypt"), "backup must not contain password hashes");

  assert.equal((await a.post("/api/logout")).status, 200);
  assert.equal((await a.get("/api/state")).status, 401);
  await t.close();
});

test("other collections validate and persist", async () => {
  const t = await boot();
  const a = t.client();
  await a.post("/api/setup", SETUP);

  let r = await a.post("/api/parts", { name: "Motor", sub: "drive", have: 2, need: 4, price: 44.99, vendor: "goBILDA" });
  assert.equal(r.status, 201);
  assert.equal((await a.post("/api/parts", { name: "Bad", have: -1 })).status, 400);

  r = await a.post("/api/practice", { date: "2026-10-21", driver: "x", auto: 7, cycle: 31, note: "good" });
  assert.equal(r.status, 201);
  assert.equal((await a.post("/api/practice", { date: "2026-10-21", auto: 11, cycle: 31 })).status, 400);

  r = await a.post("/api/meetings", { date: "2026-10-25", title: "Build day", who: [], agenda: ["a"], notes: "", actions: [{ id: "a1", text: "Do it", who: "x" }] });
  assert.equal(r.status, 201);
  assert.equal(r.data.actions[0].text, "Do it");

  r = await a.post("/api/notebook", { date: "2026-10-23", title: "Entry", status: "draft" });
  assert.equal(r.status, 201);

  r = await a.post("/api/phases", { name: "Build", start: "2026-09-26", end: "2026-11-14" });
  assert.equal(r.status, 201);
  await t.close();
});

test("events: a write by one client is announced to another", async () => {
  const t = await boot();
  const a = t.client("alpha");
  await a.post("/api/setup", SETUP);
  const ctrl = new AbortController();
  const res = await fetch(t.base + "/api/events", { headers: { Cookie: a.cookie() }, signal: ctrl.signal });
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  const reader = res.body.getReader();
  await reader.read(); // ": connected"

  await a.post("/api/issues", issue());
  const { value } = await reader.read();
  const text = new TextDecoder().decode(value);
  assert.match(text, /event: change/);
  assert.match(text, /"coll":"issues"/);
  assert.match(text, /"by":"alpha"/);
  ctrl.abort();
  await t.close();
});

test("static files: index is served, traversal is not", async () => {
  const t = await boot();
  let res = await fetch(t.base + "/");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/html/);
  assert.match(res.headers.get("content-security-policy"), /script-src 'self'/);
  res = await fetch(t.base + "/app.js");
  assert.equal(res.status, 200);
  for (const p of ["/../package.json", "/%2e%2e/package.json", "/..%2fserver/app.js", "/missing.js"]) {
    res = await fetch(t.base + p);
    assert.equal(res.status, 404, p);
  }
  await t.close();
});

test("demo mode seeds a full dataset with current dates", async () => {
  const t = await boot({ demo: true });
  const a = t.client();
  assert.ok(t.app.demoLogins.includes("joseph"));
  const r = await a.post("/api/login", { username: "joseph", password: "innovators" });
  assert.equal(r.status, 200);
  const st = (await a.get("/api/state")).data;
  assert.equal(st.issues.length, 13);
  assert.equal(st.people.length, 9);
  assert.equal(st.me.access, "Admin");
  const q = st.milestones.find((m) => m.main);
  const days = Math.round((Date.parse(q.date) - Date.parse(new Date().toISOString().slice(0, 10))) / 864e5);
  assert.equal(days, 44, "qualifier is still 44 days out, whatever today is");
  await t.close();
});
