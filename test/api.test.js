import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createApp } from "../server/app.js";

const publicDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

/** Stands in for api.github.com. Set pulls, status or etag; calls records each request. */
function fakeGithub() {
  const gh = { pulls: [], status: 200, calls: [] };
  gh.fetch = async (url, init) => {
    gh.calls.push({ url: String(url), headers: init.headers });
    return new Response(gh.status === 200 ? JSON.stringify(gh.pulls) : "{}", { status: gh.status, headers: { "Content-Type": "application/json" } });
  };
  return gh;
}

async function boot(opts = {}) {
  const gh = fakeGithub();
  const app = createApp({ dbPath: ":memory:", publicDir, githubFetch: gh.fetch, ...opts });
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
  return { app, base, client, gh, close: () => app.close() };
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

test("revisions: a save made from an out-of-date copy is refused with the current one", async () => {
  const t = await boot();
  const a = t.client("alpha");
  await a.post("/api/setup", SETUP);
  let r = await a.post("/api/issues", issue());
  assert.equal(r.data.rev, 1);
  const loaded = r.data;

  r = await a.put("/api/issues/1", { ...loaded, status: "doing" });
  assert.equal(r.status, 200);
  assert.equal(r.data.rev, 2);

  r = await a.put("/api/issues/1", { ...loaded, desc: "stale copy" });
  assert.equal(r.status, 409);
  assert.equal(r.data.current.status, "doing");
  assert.equal(r.data.current.rev, 2);
  assert.equal((await a.get("/api/state")).data.issues[0].desc, "", "the stale save did not apply");

  r = await a.put("/api/issues/1", { ...r.data.current, desc: "rebased" });
  assert.equal(r.status, 200);
  assert.equal(r.data.rev, 3);

  const { rev: _r, ...noRev } = r.data;
  r = await a.put("/api/issues/1", { ...noRev, desc: "forced" });
  assert.equal(r.status, 200, "without rev, last write wins");
  assert.equal(r.data.rev, 4);
  assert.equal((await a.put("/api/issues/1", { ...noRev, rev: "x" })).status, 400);
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

/** An admin (joseph) plus a member (dev) who has chosen a password, both signed in. */
async function team(t) {
  const admin = t.client("admin");
  await admin.post("/api/setup", SETUP);
  const me = (await admin.get("/api/state")).data.me.id;
  const made = await admin.post("/api/users", { name: "Dev", username: "dev", access: "Member" });
  const dev = t.client("dev");
  await dev.post("/api/login", { username: "dev", password: made.data.password });
  await dev.post("/api/password", { current: made.data.password, next: "dev's new password" });
  return { admin, dev, adminId: me, devId: made.data.person.id };
}
const inbox = async (c) => (await c.get("/api/state")).data.inbox;

test("notifications: assignments, comments, mentions and blockers reach the right inbox", async () => {
  const t = await boot();
  const { admin, dev, devId } = await team(t);

  let r = await admin.post("/api/issues", issue({ who: [devId] }));
  let i = r.data;
  let box = await inbox(dev);
  assert.equal(box.length, 1);
  assert.match(box[0].text, /^Joseph assigned you FTC-1 Fix the thing$/);
  assert.equal(box[0].link, "issues/1");
  assert.equal(box[0].read, false);
  assert.deepEqual(await inbox(admin), [], "you are not told about your own changes");

  const say = (who, text) => ({ who, text, date: "2026-10-24" });
  const me = (await admin.get("/api/state")).data.me.id;
  i = (await admin.put("/api/issues/1", { ...i, notes: [say(me, "@dev, can you check the wiring?")] })).data;
  box = await inbox(dev);
  assert.equal(box.length, 2, "a mention is one notice, not a mention plus a comment");
  assert.match(box[0].text, /^Joseph mentioned you on FTC-1 Fix the thing: "@dev, can you check the wiring\?"$/);

  i = (await dev.put("/api/issues/1", { ...i, notes: [...i.notes, say(devId, "Checked. It's the connector.")] })).data;
  box = await inbox(admin);
  assert.equal(box.length, 1, "earlier commenters hear about new comments");
  assert.match(box[0].text, /^Dev commented on FTC-1/);

  i = (await admin.put("/api/issues/1", { ...i, status: "blocked" })).data;
  assert.match((await inbox(dev))[0].text, /^FTC-1 Fix the thing is blocked$/);

  // Turning a kind off stops it, for that person only.
  r = await dev.call("PUT", "/api/prefs", { due: true, blocked: true, mention: false, pr: true, digest: false });
  assert.equal(r.data.mention, false);
  i = (await admin.put("/api/issues/1", { ...i, notes: [...i.notes, say(me, "@dev ping")] })).data;
  assert.equal((await inbox(dev)).length, 3, "no new notice once mentions are off");
  assert.equal((await dev.get("/api/state")).data.prefs.mention, false);

  // Reading
  box = await inbox(dev);
  await dev.post("/api/notifications/read", { ids: [box[0].id] });
  box = await inbox(dev);
  assert.deepEqual(box.map((n) => n.read), [true, false, false]);
  await dev.post("/api/notifications/read", { all: true });
  assert.ok((await inbox(dev)).every((n) => n.read));
  await admin.post("/api/notifications/read", { ids: [box[1].id] });
  assert.equal((await inbox(admin))[0].read, false, "you can't mark someone else's notices");
  await t.close();
});

test("notifications: due dates and the Sunday digest go out once", async () => {
  const t = await boot();
  const { admin, dev, devId, adminId } = await team(t);
  await admin.post("/api/issues", issue({ title: "Wire the lift", who: [devId], due: "2026-10-26" }));
  await admin.post("/api/issues", issue({ title: "Later", who: [devId], due: "2026-11-30" }));
  await admin.post("/api/milestones", { name: "Qualifier", date: "2026-12-06", main: true });
  await admin.call("PUT", "/api/prefs", { digest: true });

  const sunday = new Date(2026, 9, 25, 9); // Sunday 25 October 2026, local time
  t.app.notifier.tick(sunday);
  t.app.notifier.tick(sunday);
  const due = (await inbox(dev)).filter((n) => n.text.includes("due"));
  assert.equal(due.length, 1);
  assert.equal(due[0].text, "FTC-1 Wire the lift is due tomorrow");

  const digests = (await inbox(admin)).filter((n) => n.link === "home");
  assert.equal(digests.length, 1, "digest is on for joseph");
  assert.match(digests[0].text, /You have 0 open\. Next: Qualifier, in 42 days\.$/);
  assert.equal((await inbox(dev)).filter((n) => n.link === "home").length, 0, "digest is off by default");
  assert.ok(adminId);
  await t.close();
});

test("github: pull requests link to issues and move them, once per change", async () => {
  const t = await boot();
  const { admin, dev, adminId } = await team(t);
  await admin.post("/api/issues", issue({ title: "Fix the thing" }));
  await admin.post("/api/issues", issue({ title: "Lift presets", status: "doing" }));
  await admin.patch(`/api/people/${adminId}`, { gh: "@Octo-Joe" });

  assert.equal((await admin.call("PUT", "/api/meta/settings", { repo: "not a repo" })).status, 400);
  t.gh.pulls = [
    { number: 7, state: "open", draft: false, title: "Fix", head: { ref: "ftc-1-fix-the-thing" }, merged_at: null, requested_reviewers: [{ login: "octo-joe" }], html_url: "https://github.com/team/robot/pull/7" },
    { number: 8, state: "closed", title: "FTC-2 Lift presets", head: { ref: "lift" }, merged_at: "2026-10-20T10:00:00Z", requested_reviewers: [] },
    { number: 9, state: "open", title: "Unrelated", head: { ref: "cleanup" }, merged_at: null },
  ];
  await admin.call("PUT", "/api/meta/settings", { budget: 0, branchPrefix: "ftc", repo: "team/robot", autoPr: true });
  let r = await admin.post("/api/github/sync");
  assert.equal(r.data.ok, true);
  assert.equal(t.gh.calls.at(-1).url, "https://api.github.com/repos/team/robot/pulls?state=all&sort=updated&direction=desc&per_page=50");
  assert.equal(t.gh.calls.at(-1).headers.Authorization, undefined);

  let st = (await admin.get("/api/state")).data;
  const [one, two] = st.issues;
  assert.deepEqual([one.status, one.pr, one.prState, one.branch], ["review", 7, "open", "ftc-1-fix-the-thing"]);
  assert.deepEqual([two.status, two.pr, two.merged], ["done", 8, true]);
  assert.equal(st.github.ok, true);
  const review = st.inbox.filter((n) => n.text.startsWith("Review requested"));
  assert.equal(review.length, 1);
  assert.equal(review[0].link, "issues/1");

  // The team moves it back by hand; an unchanged PR leaves it alone.
  await admin.put("/api/issues/1", { ...one, status: "doing" });
  await admin.post("/api/github/sync");
  assert.equal(t.app.store.get("issues", 1).status, "doing");
  assert.equal((await inbox(admin)).filter((n) => n.text.startsWith("Review requested")).length, 1, "review request is not repeated");

  // Merging does move it.
  t.gh.pulls[0] = { ...t.gh.pulls[0], state: "closed", merged_at: "2026-10-24T10:00:00Z" };
  await admin.post("/api/github/sync");
  assert.deepEqual([t.app.store.get("issues", 1).status, t.app.store.get("issues", 1).prState], ["done", "merged"]);

  // Tokens: write-only, admin-only, and sent to GitHub.
  const token = "github_pat_" + "a".repeat(40);
  assert.equal((await dev.call("PUT", "/api/github/token", { token })).status, 403);
  assert.equal((await admin.call("PUT", "/api/github/token", { token: "short" })).status, 400);
  r = await admin.call("PUT", "/api/github/token", { token });
  assert.equal(r.data.hasToken, true);
  assert.equal(t.gh.calls.at(-1).headers.Authorization, "Bearer " + token);
  const everything = JSON.stringify((await admin.get("/api/state")).data) + JSON.stringify((await admin.get("/api/export")).data);
  assert.equal(everything.includes(token), false, "the token never leaves the server");

  t.gh.status = 404;
  r = await admin.post("/api/github/sync");
  assert.equal(r.data.ok, false);
  assert.match(r.data.error, /Repository not found/);
  assert.match((await dev.get("/api/state")).data.github.error, /Repository not found/);
  r = await admin.call("DELETE", "/api/github/token");
  assert.equal(r.data.hasToken, false);
  await t.close();
});

test("mentions: people by first name, teams by subsystem, and only once per new mention", async () => {
  const t = await boot();
  const { admin, dev, devId, adminId } = await team(t);
  const mika = await admin.post("/api/users", { name: "Mika Tan", username: "mtan", access: "Member" });
  const mikaId = mika.data.person.id;
  const m = t.client("mika");
  await m.post("/api/login", { username: "mtan", password: mika.data.password });
  await m.post("/api/password", { current: mika.data.password, next: "mika's new password" });

  let st = (await admin.get("/api/state")).data;
  assert.deepEqual(Object.fromEntries(st.people.map((p) => [p.name, p.handle])), { Joseph: "joseph", Dev: "dev", "Mika Tan": "mika" });
  const other = await admin.post("/api/users", { name: "Mika Rao", username: "mrao", access: "Member" });
  st = (await admin.get("/api/state")).data;
  assert.equal(st.people.find((p) => p.name === "Mika Tan").handle, "mikatan", "a shared first name falls back to the full name");
  assert.equal(st.people.find((p) => p.name === "Mika Rao").handle, "mikarao");
  assert.ok(other.data.person.id);

  // By handle or by username; trailing punctuation is not part of the name.
  let i = (await admin.post("/api/issues", issue())).data;
  const say = (who, text) => ({ who, text, date: "2026-10-24" });
  i = (await admin.put("/api/issues/1", { ...i, notes: [say(adminId, "@mikatan and @mtan, see this.")] })).data;
  assert.equal((await inbox(m)).length, 1, "two ways of naming one person is still one notice");
  assert.match((await inbox(m))[0].text, /^Joseph mentioned you on FTC-1/);

  // A description saves while you type, so a name at the very end isn't final yet.
  i = (await admin.put("/api/issues/1", { ...i, desc: "Ask @de" })).data;
  i = (await admin.put("/api/issues/1", { ...i, desc: "Ask @dev" })).data;
  assert.equal((await inbox(dev)).length, 0);
  i = (await admin.put("/api/issues/1", { ...i, desc: "Ask @dev about it" })).data;
  i = (await admin.put("/api/issues/1", { ...i, desc: "Ask @dev about it, soon" })).data;
  const box = await inbox(dev);
  assert.equal(box.length, 1, "mentioned once, not on every save");
  assert.equal(box[0].text, "Joseph mentioned you in the description of FTC-1 Fix the thing");

  // Meeting notes and notebook entries too, with links that open the right record.
  const mt = (await admin.post("/api/meetings", { date: "2026-10-25", title: "Build day", who: [], agenda: [], notes: "", actions: [] })).data;
  await admin.put(`/api/meetings/${mt.id}`, { ...mt, notes: "@mikatan brings the drill." });
  const n = (await inbox(m))[0];
  assert.equal(n.text, "Joseph mentioned you in the notes for Build day");
  assert.equal(n.link, `meetings/${mt.id}`);
  assert.ok(devId && mikaId);
  await t.close();
});

test("team inboxes: followers see a subsystem's activity, without doubling up direct notices", async () => {
  const t = await boot();
  const { admin, dev, devId, adminId } = await team(t);
  let r = await dev.call("PUT", "/api/prefs", { follow: ["drive", "drive", "nonsense"] });
  assert.deepEqual(r.data.follow, ["drive"], "unknown and repeated subsystems are dropped");
  const teamBox = async () => (await inbox(dev)).filter((n) => n.kind === "team");
  const say = (who, text) => ({ who, text, date: "2026-10-24" });

  let i = (await admin.post("/api/issues", issue({ sub: "drive" }))).data;
  let tb = await teamBox();
  assert.equal(tb.length, 1);
  assert.deepEqual([tb[0].text, tb[0].sub, tb[0].link], ["Joseph opened FTC-1 Fix the thing", "drive", "issues/1"]);

  i = (await admin.put("/api/issues/1", { ...i, notes: [say(adminId, "Chain is loose")] })).data;
  i = (await admin.put("/api/issues/1", { ...i, status: "blocked" })).data;
  i = (await admin.put("/api/issues/1", { ...i, status: "done" })).data;
  assert.deepEqual((await teamBox()).map((n) => n.text).reverse(), [
    "Joseph opened FTC-1 Fix the thing",
    'Joseph commented on FTC-1 Fix the thing: "Chain is loose"',
    "FTC-1 Fix the thing is blocked",
    "Joseph finished FTC-1 Fix the thing",
  ]);

  // Not followed: nothing. Mentioning the team: followers hear.
  let lift = (await admin.post("/api/issues", issue({ title: "Lift slips", sub: "lift" }))).data;
  assert.equal((await teamBox()).length, 4);
  lift = (await admin.put("/api/issues/2", { ...lift, notes: [say(adminId, "@drive can you lend a motor?")] })).data;
  assert.equal((await teamBox())[0].text, 'Joseph mentioned Drivetrain on FTC-2 Lift slips: "@drive can you lend a motor?"');
  assert.equal((await teamBox())[0].sub, "drive");

  // Assigned and following: one direct notice, no team copy.
  await admin.post("/api/issues", issue({ title: "Wheels", sub: "drive", who: [devId] }));
  assert.equal((await teamBox()).length, 5);
  assert.equal((await inbox(dev)).filter((n) => n.kind !== "team")[0].text, "Joseph assigned you FTC-3 Wheels");

  // The actor never hears about their own change.
  await admin.call("PUT", "/api/prefs", { follow: ["drive"] });
  await admin.post("/api/issues", issue({ title: "Bumpers", sub: "drive" }));
  assert.equal((await inbox(admin)).filter((n) => n.kind === "team").length, 0);
  assert.equal((await teamBox()).length, 6);
  await t.close();
});
