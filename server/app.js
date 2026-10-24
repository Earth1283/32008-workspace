import http from "node:http";
import { randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { openDb, makeStore, tx } from "./db.js";
import { HttpError, SPECS, ACCESS, USERNAME, GH_LOGIN, GH_REPO, SUBS, clean } from "./validate.js";
import { hashPassword, checkPassword, DUMMY_HASH, newToken, sha256, tempPassword, parseCookies, makeThrottle } from "./auth.js";
import { seedDemo, DEMO_PASSWORD } from "./demo.js";
import { makeNotifier, localDate } from "./notify.js";
import { makeGithub } from "./github.js";

const SESSION_SECONDS = 30 * 24 * 3600;
const DOC_COLLS = {
  issues:     { write: "member", del: "admin" },
  notebook:   { write: "member", del: "member" },
  practice:   { write: "member", del: "member" },
  meetings:   { write: "member", del: "member" },
  parts:      { write: "member", del: "member" },
  milestones: { write: "admin", del: "admin" },
  phases:     { write: "admin", del: "admin" },
};
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8",
};
const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com", "img-src 'self' data:", "connect-src 'self'",
  "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'",
].join("; ");

const json = (res, status, body) => {
  const s = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Content-Length": Buffer.byteLength(s) });
  res.end(s);
};

function readJson(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0, over = false, ended = false;
    req.on("close", () => { if (!ended) reject(new HttpError(400, "Request was cancelled")); });
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { over = true; chunks.length = 0; } else if (!over) chunks.push(c);
    });
    req.on("end", () => {
      ended = true;
      if (over) return reject(new HttpError(413, "Request is too large"));
      if (!size) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(new HttpError(400, "Invalid JSON")); }
    });
    req.on("error", reject);
  });
}

const hueOf = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
const today = () => localDate();

export function createApp({ dbPath = "data/008.db", publicDir, demo = false, trustProxy = false, githubFetch, githubApi, githubPollMs = 180_000 } = {}) {
  const db = openDb(dbPath);
  const store = makeStore(db);
  const throttle = makeThrottle();
  const clients = new Map(); // event stream -> user id
  let demoLogins = null;
  let closing = false, inflight = 0;

  const userCount = () => db.prepare("SELECT COUNT(*) AS n FROM users").get().n;
  if (demo && userCount() === 0) demoLogins = seedDemo(db, store, today());

  const broadcast = (coll, by) => {
    const msg = `event: change\ndata: ${JSON.stringify({ coll, by })}\n\n`;
    for (const c of clients.keys()) c.write(msg);
  };
  /** Tell one person's open tabs that their inbox changed. */
  const push = (userId, by) => {
    const msg = `event: change\ndata: ${JSON.stringify({ coll: "notifications", by })}\n\n`;
    for (const [c, u] of clients) if (u === userId) c.write(msg);
  };
  const notifier = makeNotifier({ db, store, push });
  const github = makeGithub({ db, store, notifier, broadcast, fetch: githubFetch, api: githubApi });
  const safely = (fn) => () => { try { const r = fn(); if (r && r.catch) r.catch((e) => console.error(e)); } catch (e) { console.error(e); } };

  const purge = () => db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(Date.now());
  purge();
  const timers = [
    setInterval(purge, 3600_000),
    setInterval(() => { for (const c of clients.keys()) c.write(": ping\n\n"); }, 25_000),
    setInterval(safely(() => notifier.tick()), 15 * 60_000),
    setTimeout(safely(() => notifier.tick()), 5_000),
    ...(githubPollMs ? [setInterval(safely(() => github.sync()), githubPollMs), setTimeout(safely(() => github.sync()), 5_000)] : []),
  ];
  timers.forEach((t) => t.unref());

  /** Address used for login throttling. Only believe X-Forwarded-For when a trusted proxy sets it. */
  function clientIp(req) {
    if (trustProxy) {
      const xff = String(req.headers["x-forwarded-for"] ?? "").split(",").map((x) => x.trim()).filter(Boolean);
      if (xff.length) return xff[xff.length - 1];
    }
    return req.socket.remoteAddress;
  }

  /* ---------- auth helpers ---------- */
  function authenticate(req) {
    const token = parseCookies(req.headers.cookie).sid;
    if (!token) return null;
    const hash = sha256(token);
    const r = db.prepare(`SELECT u.id, u.username, u.access, u.must_change AS mustChange, s.expires_at AS exp
      FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`).get(hash);
    if (!r || r.exp < Date.now()) return null;
    return { id: r.id, username: r.username, access: r.access, mustChange: !!r.mustChange, hash };
  }
  const publicUser = (u) => ({ id: u.id, username: u.username, access: u.access, mustChange: u.mustChange });

  function startSession(req, res, userId) {
    const token = newToken();
    db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(sha256(token), userId, Date.now() + SESSION_SECONDS * 1000);
    const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
    res.setHeader("Set-Cookie", `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_SECONDS}${secure}`);
  }

  function requireWrite(req) {
    if (!req.headers["x-client"]) throw new HttpError(403, "Missing X-Client header");
    const origin = req.headers.origin;
    if (origin) {
      let host = "";
      try { host = new URL(origin).host; } catch { /* fall through */ }
      if (host !== req.headers.host) throw new HttpError(403, "Cross-site request blocked");
    }
  }
  const need = (user, level) => {
    if (level === "admin" && user.access !== "Admin") throw new HttpError(403, "Only admins can do that");
    if (level === "member" && user.access === "Viewer") throw new HttpError(403, "You have view-only access");
  };

  function createUser({ name, username, role, access, password, mustChange }) {
    if (!USERNAME.test(username)) throw new HttpError(400, "Username must be 2-32 letters, numbers, dots, dashes or underscores");
    if (!ACCESS.includes(access)) throw new HttpError(400, "Unknown access level");
    const id = randomBytes(4).toString("hex");
    const person = clean(SPECS.people, { name, role, hue: hueOf(name) });
    try {
      tx(db, () => {
        db.prepare("INSERT INTO users (id, username, pass, access, must_change, created_at) VALUES (?, ?, ?, ?, ?, ?)")
          .run(id, username, hashPassword(password), access, mustChange ? 1 : 0, Date.now());
        store.put("people", id, person, id);
      });
    } catch (e) {
      if (/UNIQUE/i.test(String(e.message))) throw new HttpError(409, "That username is taken");
      throw e;
    }
    return { ...person, id, access };
  }

  const adminCount = () => db.prepare("SELECT COUNT(*) AS n FROM users WHERE access = 'Admin'").get().n;

  /* ---------- state ---------- */
  function buildState(user) {
    const accessRows = new Map(db.prepare("SELECT id, access, username FROM users").all().map((u) => [u.id, u]));
    const handles = notifier.handles();
    const out = {
      me: publicUser(user),
      team: store.meta("team", {}),
      settings: store.meta("settings", { budget: 0, branchPrefix: "ftc", repo: "" }),
      people: store.list("people").map((p) => ({
        ...p, access: accessRows.get(p.id)?.access ?? "Member", handle: handles.get(p.id),
        ...(user.access === "Admin" ? { username: accessRows.get(p.id)?.username } : {}),
      })),
    };
    for (const c of Object.keys(DOC_COLLS)) out[c] = store.list(c);
    out.prefs = notifier.prefs(user.id);
    out.inbox = notifier.list(user.id);
    out.github = { ...store.meta("githubStatus", {}), hasToken: !!store.meta("github", {}).token };
    return out;
  }

  function sessionInfo(user) {
    const needsSetup = userCount() === 0;
    const t = store.meta("team", null);
    return { needsSetup, team: t ? { num: t.num, name: t.name, short: t.short, logo: t.logo } : null, user: user ? publicUser(user) : null, demo: !!demo };
  }

  /* ---------- routes ---------- */
  async function api(req, res, url) {
    const [a, b, c] = url.pathname.split("/").slice(2).filter(Boolean).map(decodeURIComponent);
    const m = req.method;
    const isWrite = m !== "GET" && m !== "HEAD";
    if (isWrite) requireWrite(req);
    const user = authenticate(req);

    if (a === "session" && m === "GET") return json(res, 200, sessionInfo(user));

    if (a === "login" && m === "POST") {
      const body = await readJson(req);
      const username = String(body.username ?? "").trim().toLowerCase();
      const key = `${clientIp(req)}|${username}`;
      if (!throttle.check(key)) throw new HttpError(429, "Too many attempts. Wait a minute and try again.");
      const row = db.prepare("SELECT id, username, pass, access, must_change AS mustChange FROM users WHERE username = ?").get(username);
      const ok = checkPassword(String(body.password ?? ""), row ? row.pass : DUMMY_HASH) && !!row;
      if (!ok) { throttle.fail(key); throw new HttpError(401, "Wrong username or password"); }
      throttle.ok(key);
      startSession(req, res, row.id);
      return json(res, 200, { user: publicUser({ ...row, mustChange: !!row.mustChange }) });
    }

    if (a === "setup" && m === "POST") {
      const body = await readJson(req);
      if (userCount() > 0) throw new HttpError(409, "This workspace is already set up");
      const team = clean(SPECS.team, { ...body.team, short: body.team?.short || String(body.team?.num ?? "").slice(-3) });
      const ad = body.admin ?? {};
      if (typeof ad.password !== "string" || ad.password.length < 8) throw new HttpError(400, "Password must be at least 8 characters");
      const qual = body.qualifier && body.qualifier.date ? clean(SPECS.milestones, { name: "Qualifier", date: body.qualifier.date, main: true }) : null;
      let person;
      tx(db, () => {
        if (userCount() > 0) throw new HttpError(409, "This workspace is already set up");
        store.setMeta("team", team);
        store.setMeta("settings", { budget: 0, branchPrefix: "ftc", repo: "" });
        if (qual) store.put("milestones", randomBytes(5).toString("hex"), qual, "setup");
        person = createUser({ name: String(ad.name ?? ""), username: String(ad.username ?? ""), role: String(ad.role ?? "Captain"), access: "Admin", password: ad.password, mustChange: false });
      });
      startSession(req, res, person.id);
      return json(res, 201, { user: { id: person.id, username: ad.username, access: "Admin", mustChange: false } });
    }

    if (!user) throw new HttpError(401, "Sign in required");

    if (a === "logout" && m === "POST") {
      db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(user.hash);
      res.setHeader("Set-Cookie", "sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
      return json(res, 200, { ok: true });
    }

    if (a === "password" && m === "POST") {
      const body = await readJson(req);
      const row = db.prepare("SELECT pass FROM users WHERE id = ?").get(user.id);
      if (!checkPassword(String(body.current ?? ""), row.pass)) throw new HttpError(400, "Current password is wrong");
      if (typeof body.next !== "string" || body.next.length < 8) throw new HttpError(400, "New password must be at least 8 characters");
      if (body.next === body.current) throw new HttpError(400, "Choose a different password");
      tx(db, () => {
        db.prepare("UPDATE users SET pass = ?, must_change = 0 WHERE id = ?").run(hashPassword(body.next), user.id);
        db.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?").run(user.id, user.hash);
      });
      return json(res, 200, { ok: true });
    }

    if (user.mustChange) throw new HttpError(403, "Change your password first");

    if (a === "state" && m === "GET") return json(res, 200, buildState(user));

    if (a === "events" && m === "GET") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
      res.write(": connected\n\n");
      clients.set(res, user.id);
      req.on("close", () => clients.delete(res));
      return;
    }

    if (a === "export" && m === "GET") {
      need(user, "admin");
      const docs = {};
      for (const c of [...Object.keys(DOC_COLLS), "people"]) docs[c] = store.list(c);
      const body = { version: 1, exportedAt: new Date().toISOString(), meta: { team: store.meta("team"), settings: store.meta("settings"), nextIssue: store.meta("nextIssue", 1) },
        users: db.prepare("SELECT id, username, access FROM users").all(), docs };
      const s = JSON.stringify(body, null, 1);
      res.writeHead(200, { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="008-backup-${today()}.json"`, "Cache-Control": "no-store" });
      return res.end(s);
    }

    if (a === "meta" && m === "PUT" && (b === "team" || b === "settings")) {
      need(user, "admin");
      const doc = clean(SPECS[b], await readJson(req, 1_500_000));
      if (b === "team" && doc.logo && !doc.logo.startsWith("data:image/")) throw new HttpError(400, "Logo must be an image");
      if (b === "settings" && doc.repo && !GH_REPO.test(doc.repo)) throw new HttpError(400, "Repository must look like owner/repo");
      const prev = store.meta(b, {});
      store.setMeta(b, doc);
      broadcast("meta", req.headers["x-client"]);
      if (b === "settings" && (prev.repo !== doc.repo || prev.branchPrefix !== doc.branchPrefix)) {
        if (!doc.repo) store.setMeta("githubStatus", {});
        safely(() => github.sync())();
      }
      return json(res, 200, doc);
    }

    if (a === "prefs" && !b && m === "PUT") {
      const doc = clean(SPECS.prefs, await readJson(req));
      doc.follow = [...new Set(doc.follow)].filter((s) => SUBS.includes(s));
      store.put("prefs", user.id, doc, user.id);
      return json(res, 200, notifier.prefs(user.id));
    }

    if (a === "notifications" && b === "read" && m === "POST") {
      const body = await readJson(req);
      const ids = body.all === true ? "all" : Array.isArray(body.ids) ? body.ids.filter(Number.isInteger).slice(0, 500) : [];
      const n = notifier.markRead(user.id, ids);
      if (n) push(user.id, req.headers["x-client"]);
      return json(res, 200, { ok: true, marked: n });
    }

    if (a === "github") {
      need(user, "admin");
      if (b === "token" && m === "PUT") {
        const { token } = await readJson(req);
        if (typeof token !== "string" || !/^[\w-]{20,255}$/.test(token.trim())) throw new HttpError(400, "That doesn't look like a GitHub token");
        store.setMeta("github", { token: token.trim() });
      } else if (b === "token" && m === "DELETE") {
        store.setMeta("github", {});
      } else if (!(b === "sync" && m === "POST")) throw new HttpError(404, "Not found");
      github.forget();
      const status = await github.sync();
      broadcast("meta", req.headers["x-client"]);
      return json(res, 200, { ...(status ?? store.meta("githubStatus", {})), hasToken: !!store.meta("github", {}).token });
    }

    if (a === "people" && b && m === "PATCH") {
      if (user.id !== b) need(user, "admin");
      const cur = store.get("people", b);
      if (!cur) throw new HttpError(404, "No such person");
      const body = await readJson(req);
      const gh = String(body.gh ?? cur.gh ?? "").trim().replace(/^@/, "");
      if (gh && !GH_LOGIN.test(gh)) throw new HttpError(400, "That isn't a valid GitHub username");
      const doc = clean(SPECS.people, { ...cur, name: body.name ?? cur.name, role: body.role ?? cur.role, gh });
      store.put("people", b, doc, user.id);
      broadcast("people", req.headers["x-client"]);
      return json(res, 200, { ...doc, id: b });
    }

    if (a === "users") {
      need(user, "admin");
      if (!b && m === "POST") {
        const body = await readJson(req);
        const password = tempPassword();
        const person = createUser({ name: String(body.name ?? ""), username: String(body.username ?? ""), role: String(body.role ?? ""), access: String(body.access ?? "Member"), password, mustChange: true });
        broadcast("people", req.headers["x-client"]);
        return json(res, 201, { person, password });
      }
      if (b && !c && m === "PATCH") {
        const body = await readJson(req);
        if (!ACCESS.includes(body.access)) throw new HttpError(400, "Unknown access level");
        const row = db.prepare("SELECT access FROM users WHERE id = ?").get(b);
        if (!row) throw new HttpError(404, "No such user");
        if (row.access === "Admin" && body.access !== "Admin" && adminCount() <= 1) throw new HttpError(400, "The workspace needs at least one admin");
        db.prepare("UPDATE users SET access = ? WHERE id = ?").run(body.access, b);
        broadcast("people", req.headers["x-client"]);
        return json(res, 200, { id: b, access: body.access });
      }
      if (b && c === "reset" && m === "POST") {
        const password = tempPassword();
        const r = db.prepare("UPDATE users SET pass = ?, must_change = 1 WHERE id = ?").run(hashPassword(password), b);
        if (!r.changes) throw new HttpError(404, "No such user");
        db.prepare("DELETE FROM sessions WHERE user_id = ?").run(b);
        return json(res, 200, { password });
      }
    }

    const cfg = DOC_COLLS[a];
    if (cfg) {
      if (!b && m === "POST") {
        need(user, cfg.write);
        const doc = clean(SPECS[a], await readJson(req));
        const id = tx(db, () => {
          const id = a === "issues" ? store.nextIssueId() : randomBytes(5).toString("hex");
          store.put(a, id, doc, user.id);
          return id;
        });
        broadcast(a, req.headers["x-client"]);
        const saved = store.get(a, id);
        safely(() => notifier.changed(a, null, saved, user.id))();
        return json(res, 201, saved);
      }
      if (b && m === "PUT") {
        need(user, cfg.write);
        if (!store.get(a, b)) throw new HttpError(404, "Not found");
        const body = await readJson(req);
        const doc = clean(SPECS[a], body);
        // With rev, the save only applies to the version the client last saw. Without it, last write wins.
        if (body.rev !== undefined && !Number.isInteger(body.rev)) throw new HttpError(400, "rev must be a whole number");
        let before;
        const saved = tx(db, () => {
          before = store.get(a, b);
          if (!before) throw new HttpError(404, "Not found");
          if (body.rev !== undefined && body.rev !== before.rev) throw new HttpError(409, "Someone else changed this first", { current: before });
          store.put(a, b, doc, user.id);
          return store.get(a, b);
        });
        broadcast(a, req.headers["x-client"]);
        safely(() => notifier.changed(a, before, saved, user.id))();
        return json(res, 200, saved);
      }
      if (b && m === "DELETE") {
        need(user, cfg.del);
        if (!store.del(a, b)) throw new HttpError(404, "Not found");
        broadcast(a, req.headers["x-client"]);
        return json(res, 200, { ok: true });
      }
    }

    throw new HttpError(404, "Not found");
  }

  /* ---------- static files ---------- */
  async function serveStatic(req, res, url) {
    if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "Method not allowed");
    let rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, "");
    if (rel === "" || rel.endsWith(sep)) rel += "index.html";
    const file = join(publicDir, rel);
    if (!file.startsWith(publicDir + sep) && file !== publicDir) throw new HttpError(404, "Not found");
    let data;
    try {
      if (!(await stat(file)).isFile()) throw new Error("not a file");
      data = await readFile(file);
    } catch { throw new HttpError(404, "Not found"); }
    res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream", "Content-Length": data.length, "Cache-Control": "no-cache" });
    res.end(req.method === "HEAD" ? undefined : data);
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("Content-Security-Policy", CSP);
    res.setHeader("X-Frame-Options", "DENY");
    if (closing) return json(res, 503, { error: "Server is shutting down" });
    inflight++;
    try {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname.startsWith("/api/")) await api(req, res, url);
      else await serveStatic(req, res, url);
    } catch (e) {
      if (e instanceof HttpError) {
        if (!res.headersSent) json(res, e.status, { ...e.extra, error: e.message });
      } else {
        console.error(e);
        if (!res.headersSent) json(res, 500, { error: "Something went wrong on the server" });
      }
    } finally { inflight--; }
  });

  return {
    server, db, store, demoLogins, notifier, github,
    async close() {
      closing = true;
      timers.forEach(clearInterval);
      for (const c of clients.keys()) c.end();
      await github.idle();
      const stopped = new Promise((r) => server.close(r));
      server.closeAllConnections?.();
      await stopped;
      for (let i = 0; i < 200 && inflight > 0; i++) await new Promise((r) => setTimeout(r, 10));
      db.close();
    },
  };
}

export { DEMO_PASSWORD };
