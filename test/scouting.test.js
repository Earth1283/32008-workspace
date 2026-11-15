import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { makeScouting } from "../server/scouting.js";
import { openDb, makeStore } from "../server/db.js";
import { createApp } from "../server/app.js";

const response = (data, status = 200) => new Response(JSON.stringify(data), { status });
const fixtures = {
  ftcscout: {
    "/rest/v1/events/search/2026": [{ code: "TEST", name: "Test Qualifier", start: "2026-11-28" }],
    "/rest/v1/events/2026/TEST": { code: "TEST", name: "Test Qualifier" },
    "/rest/v1/events/2026/TEST/teams": [{ teamNumber: 32008, stats: { rank: 2, wins: 3, losses: 1, ties: 0, qualMatchesPlayed: 4, opr: { totalPointsNp: 42.5, autoPoints: 13.2 } } }],
    "/rest/v1/events/2026/TEST/matches": [
      { id: 1, tournamentLevel: "Quals", hasBeenPlayed: true, teams: [{ teamNumber: 32008, alliance: "Red" }, { teamNumber: 1, alliance: "Blue" }], scores: { red: { totalPoints: 0 }, blue: { totalPoints: 5 } } },
      { id: 2, tournamentLevel: "Quals", hasBeenPlayed: false, teams: [] },
    ],
    "/graphql": { data: { eventByCode: { teams: [{ teamNumber: 32008, team: { name: "Innovators" } }] } } },
  },
  first: {
    "/v2.0/2026/events": { events: [{ code: "TEST", name: "Test Qualifier" }] },
    "/v2.0/2026/teams": { pageTotal: 1, teams: [{ teamNumber: 32008, nameShort: "Innovators" }] },
    "/v2.0/2026/rankings/TEST": { Rankings: [{ teamNumber: 32008, rank: 2, wins: 3, losses: 1, ties: 0, matchesPlayed: 4 }] },
    "/v2.0/2026/matches/TEST": { matches: [{ description: "Quals 1", tournamentLevel: "QUALIFICATION", series: 0, matchNumber: 1, teams: [{ teamNumber: 32008, station: "Red1" }, { teamNumber: 1, station: "Blue1" }], scoreRedFinal: 0, scoreBlueFinal: 5 }, { description: "Quals 2", matchNumber: 2, scoreRedFinal: null, scoreBlueFinal: null }] },
  },
  toa: {
    "/api/event/": [{ event_key: "TEST", event_name: "Test Qualifier" }],
    "/api/event/TEST": [{ event_key: "TEST", event_name: "Test Qualifier" }],
    "/api/event/TEST/teams": [{ team_key: "32008", team: { team_name_short: "Innovators" } }],
    "/api/event/TEST/rankings": [{ team_key: "32008", rank: 2, wins: 3, losses: 1, ties: 0, played: 4, np_opr: 42.5 }],
    "/api/event/TEST/matches": [{ match_key: "q1", match_name: "Quals 1", participants: [{ team_key: "32008", station: "R1" }, { team_key: "1", station: "B1" }], red_score: 0, blue_score: 5 }, { match_key: "q2", red_score: -1, blue_score: -1 }],
  },
  venue: {
    "/api/v1/events/": { eventCodes: ["TEST"] },
    "/api/v1/events/TEST/": { eventCode: "TEST", name: "Test Qualifier" },
    "/api/v2/events/TEST/full/": {
      event: { code: "TEST", name: "Test Qualifier" }, teamList: { teams: [{ number: 32008, name: "Innovators" }] },
      rankingsList: { rankingList: [{ team: 32008, ranking: 2, wins: 3, losses: 1, ties: 0, matchesPlayed: 4 }] },
      matchList: { matches: [{ matchBrief: { matchNumber: 1, matchName: "Quals 1", finished: true, red: { team1: 32008 }, blue: { team1: 1 } }, redScore: 0, blueScore: 5 }, { matchBrief: { matchNumber: 2, finished: false } }] },
    },
  },
};
const config = { firstUsername: "user", firstToken: "first-secret", toaKey: "toa-secret", venueUrl: "http://scorekeeper.test", venueKey: "venue-secret" };
function harness(source) {
  const db = openDb(":memory:"), store = makeStore(db), calls = [];
  let clock = Date.now(), fail = "";
  const fetch = async (url, init) => {
    const u = new URL(url); calls.push({ url: u, ...init });
    return fail && u.pathname.includes(fail) ? response({}, 503) : response(fixtures[source][u.pathname] ?? {});
  };
  const api = makeScouting({ store, fetch, config, now: () => clock });
  return { api, store, calls, db, advance: () => { clock += 31_000; }, fail: (path) => { fail = path; } };
}

for (const source of Object.keys(fixtures)) test(`scouting ${source}: normalizes a roster, rankings, scores and unplayed matches`, async () => {
  const t = harness(source);
  try {
    const found = await t.api.search(source, 2026, "Test");
    assert.equal(found[0].key, "TEST");
    const e = await t.api.sync(source, 2026, "TEST", "me");
    assert.equal(e.source, source); assert.equal(e.season, 2026);
    assert.equal(e.teams[0].name, "Innovators");
    assert.equal(e.teams[0].rank, 2); assert.equal(e.teams[0].wins, 3);
    assert.equal(e.teams[0].opr, ["ftcscout", "toa"].includes(source) ? 42.5 : null);
    assert.deepEqual(e.matches[0].red, [32008]); assert.deepEqual(e.matches[0].blue, [1]);
    assert.equal(e.matches[0].redScore, 0); assert.equal(e.matches[1].redScore, null);
    const count = t.calls.length;
    await t.api.sync(source, 2026, "TEST", "me");
    assert.equal(t.calls.length, count, "a repeated refresh uses the recent snapshot");
    const req = t.calls[0];
    assert.equal(req.redirect, "error");
    if (source === "first") assert.equal(req.headers.Authorization, "Basic " + Buffer.from("user:first-secret").toString("base64"));
    if (source === "toa") assert.equal(req.headers["X-TOA-Key"], "toa-secret");
    if (source === "venue") assert.equal(req.headers.Authorization, "Bearer venue-secret");
  } finally { t.db.close(); }
});

test("scouting refresh preserves old sections and timestamps when a source fails", async () => {
  const t = harness("ftcscout");
  try {
    const old = await t.api.sync("ftcscout", 2026, "TEST", "me");
    t.advance(); t.fail("/matches");
    const saved = await t.api.sync("ftcscout", 2026, "TEST", "me");
    assert.deepEqual(saved.matches, old.matches);
    assert.equal(saved.sectionAt.matches, old.sectionAt.matches);
    assert.notEqual(saved.sectionAt.teams, old.sectionAt.teams);
    assert.match(saved.warnings.join(" "), /matches.*Previous data kept/);
    t.advance(); t.fail("/rest/v1/events/2026/TEST");
    await assert.rejects(t.api.sync("ftcscout", 2026, "TEST", "me"), /HTTP 503/);
    assert.deepEqual(t.store.get("scoutEvents", saved.id), saved);
  } finally { t.db.close(); }
});

test("scouting validates source, season, codes, URLs and redacts credentials", async () => {
  const t = harness("ftcscout");
  try {
    await assert.rejects(t.api.search("bad", 2026), /Unknown scouting/);
    await assert.rejects(t.api.search("__proto__", 2026), /Unknown scouting/);
    await assert.rejects(t.api.search("ftcscout", "bad"), /Season must/);
    await assert.rejects(t.api.sync("ftcscout", 2026, "../secrets", "me"), /valid event code/);
    assert.throws(() => t.api.configure({ venueUrl: "file:///etc/passwd" }), /Invalid scorekeeper/);
    assert.throws(() => t.api.configure({ venueUrl: "http://user:secret@server/" }), /Invalid scorekeeper/);
    assert.throws(() => t.api.configure({ venueUrl: "http://169.254.169.254" }), /Invalid scorekeeper/);
    const status = t.api.configure({ toaKey: "new-secret" });
    assert.ok(!JSON.stringify(status).includes("secret"));
    t.api.configure({ toaKey: "" });
    assert.equal(t.api.status().find((s) => s.id === "toa").ready, false);
    await assert.rejects(t.api.sync("toa", 2026, "TEST", "me"), /Configure/);
  } finally { t.db.close(); }
});

test("scouting FIRST follows roster pagination", async () => {
  const db = openDb(":memory:"), store = makeStore(db), pages = [];
  try {
    const api = makeScouting({ store, config, fetch: async (url) => {
      const u = new URL(url);
      if (u.pathname.endsWith("/teams")) { const page = Number(u.searchParams.get("page")); pages.push(page); return response({ pageTotal: 2, teams: [{ teamNumber: page, nameShort: "Team " + page }] }); }
      return response(fixtures.first[u.pathname]);
    } });
    const saved = await api.sync("first", 2026, "TEST", "me");
    assert.deepEqual(pages, [1, 2]); assert.equal(saved.teams.length, 2);
  } finally { db.close(); }
});

test("scouting deduplicates simultaneous syncs", async () => {
  const t = harness("ftcscout");
  try {
    const [a, b] = await Promise.all([t.api.sync("ftcscout", 2026, "TEST", "me"), t.api.sync("ftcscout", 2026, "TEST", "other")]);
    assert.equal(a.id, b.id); assert.equal(t.calls.length, 4);
    assert.equal(t.store.list("scoutEvents").length, 1);
  } finally { t.db.close(); }
});

test("scouting API: member observations, viewer permissions, author ownership and secret-free exports", async () => {
  const app = createApp({ dbPath: ":memory:", publicDir: fileURLToPath(new URL("../public", import.meta.url)), demo: true, githubPollMs: 0,
    scoutingConfig: config, scoutingFetch: async (url) => response(fixtures.ftcscout[new URL(url).pathname] ?? {}) });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  function client() {
    let cookie = "";
    return async (method, path, body) => {
      const r = await fetch(base + "/api/" + path, { method, headers: { "X-Client": "scouting-test", "Content-Type": "application/json", Cookie: cookie }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (r.headers.get("set-cookie")) cookie = r.headers.get("set-cookie").split(";")[0];
      return { status: r.status, data: await r.json() };
    };
  }
  try {
    const admin = client(), member = client(), viewer = client(), anonymous = client();
    assert.equal((await anonymous("GET", "scouting/search?source=ftcscout&season=2026")).status, 401);
    await admin("POST", "login", { username: "joseph", password: "innovators" });
    const user = await admin("POST", "users", { name: "Reader", username: "reader", access: "Viewer", role: "Scout" });
    await viewer("POST", "login", { username: "reader", password: user.data.password });
    await viewer("POST", "password", { current: user.data.password, next: "reader password" });
    const writer = await admin("POST", "users", { name: "Scout", username: "scout", access: "Member", role: "Scout" });
    await member("POST", "login", { username: "scout", password: writer.data.password });
    await member("POST", "password", { current: writer.data.password, next: "scout password" });
    assert.equal((await viewer("GET", "scouting/search?source=ftcscout&season=2026&q=Test")).status, 200);
    assert.equal((await viewer("POST", "scouting/sync", { source: "ftcscout", season: 2026, key: "TEST" })).status, 403);
    assert.equal((await member("PUT", "scouting/config", { toaKey: "x" })).status, 403);
    assert.equal((await member("POST", "scouting/sync", { source: "ftcscout", season: 2026, key: "TEST" })).status, 200);
    const doc = { season: 2026, event: "TEST", team: 32008, kind: "pit", date: "2026-11-15", author: "spoof", note: "Fast intake", shortlist: true };
    assert.equal((await viewer("POST", "scouting", doc)).status, 403);
    const saved = await member("POST", "scouting", { ...doc, cid: "scouting-idempotent" });
    assert.equal(saved.status, 201); assert.equal(saved.data.author, writer.data.person.id);
    assert.equal((await member("POST", "scouting", { ...doc, cid: "scouting-idempotent" })).data.id, saved.data.id);
    assert.equal((await member("POST", "scouting", { ...doc, team: -1 })).status, 400);
    const updated = await member("PUT", "scouting/" + saved.data.id, { ...saved.data, author: "spoof", note: "Updated" });
    assert.equal(updated.data.author, writer.data.person.id);
    assert.equal((await member("PUT", "scouting/" + saved.data.id, saved.data)).status, 409);
    const state = await viewer("GET", "state");
    assert.equal(state.data.scouting.length, 1); assert.equal(state.data.scoutEvents.length, 1);
    assert.ok(!JSON.stringify(state.data).includes("secret"));
    await admin("PUT", "scouting/config", { toaKey: "saved-secret" });
    const backup = await admin("GET", "export");
    assert.equal(backup.data.docs.scouting.length, 1); assert.equal(backup.data.docs.scoutEvents.length, 1);
    assert.ok(!JSON.stringify(backup.data).includes("secret"));
    assert.equal((await viewer("DELETE", "scouting/" + saved.data.id)).status, 403);
    assert.equal((await member("DELETE", "scouting/" + saved.data.id)).status, 200);
  } finally { await app.close(); }
});

test("scouting keeps a snapshot's matches when an upstream list has the wrong shape", async () => {
  const db = openDb(":memory:"), store = makeStore(db);
  let clock = Date.now(), malformed = false;
  const api = makeScouting({ store, now: () => clock, fetch: async (url) => {
    const path = new URL(url).pathname;
    return response(malformed && path.endsWith('/matches') ? { changedFormat: [] } : fixtures.ftcscout[path]);
  } });
  try {
    const before = await api.sync('ftcscout', 2026, 'TEST', 'me');
    malformed = true; clock += 31_000;
    const after = await api.sync('ftcscout', 2026, 'TEST', 'me');
    assert.deepEqual(after.matches, before.matches);
    assert.match(after.warnings.join(' '), /unexpected list format/);
  } finally { db.close(); }
});
