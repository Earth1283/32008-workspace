import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, existsSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createApp } from "../server/app.js";

const publicDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

/** Stands in for the Gemini API. Set reply to what the model "says"; calls records each request. */
function fakeGemini() {
  const g = { reply: { answer: "FTC-1 is blocked.", issues: [1] }, status: 200, calls: [] };
  g.fetch = async (url, init) => {
    g.calls.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
    const text = typeof g.reply === "string" ? g.reply : JSON.stringify(g.reply);
    return new Response(g.status === 200 ? JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }) : "{}", { status: g.status, headers: { "Content-Type": "application/json" } });
  };
  return g;
}

async function boot(opts = {}) {
  const gemini = fakeGemini();
  const app = createApp({ dbPath: ":memory:", publicDir, githubPollMs: 0, geminiKey: "test-key-123", geminiFetch: gemini.fetch, ...opts });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const client = () => {
    let cookie = "";
    const call = async (method, path, body, headers = {}) => {
      const res = await fetch(base + path, {
        method, headers: { "Content-Type": "application/json", "X-Client": "t", ...(cookie ? { Cookie: cookie } : {}), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const sc = res.headers.get("set-cookie");
      if (sc) cookie = sc.split(";")[0];
      let data = null;
      try { data = await res.json(); } catch { /* not json */ }
      return { status: res.status, data };
    };
    return { call, get: (p) => call("GET", p), post: (p, b) => call("POST", p, b ?? {}), put: (p, b) => call("PUT", p, b) };
  };
  const admin = client();
  await admin.post("/api/setup", { team: { num: "32008", name: "Innovators", short: "008", season: "2026-27" }, admin: { name: "Joseph Cui", username: "joseph", password: "correct horse" } });
  return { app, gemini, client, admin, close: () => app.close() };
}

const issue = (o = {}) => ({ title: "Fix the thing", sub: "drive", pri: "med", status: "todo", who: ["x"], created: "2026-10-23", ...o });

test("ask: without a key the feature is off", async () => {
  const t = await boot({ geminiKey: "" });
  assert.equal((await t.admin.get("/api/state")).data.ask, false);
  const r = await t.admin.post("/api/ask", { q: "what's due" });
  assert.equal(r.status, 503);
  assert.equal(t.gemini.calls.length, 0);
  await t.close();
});

test("ask: sends titles but not descriptions or comments, and keeps the key in a header", async () => {
  const t = await boot();
  const me = (await t.admin.get("/api/state")).data.me.id;
  await t.admin.post("/api/issues", issue({
    title: "Intake jams", status: "blocked", blockedBy: "Waiting on servo", who: [me],
    desc: "SECRET-DESCRIPTION", notes: [{ who: me, text: "SECRET-COMMENT", date: "2026-10-23" }],
  }));
  await t.admin.post("/api/parts", { name: "Goblida servo", sub: "intake", have: 1, need: 3, ordered: 0, price: 24.5, vendor: "goBILDA" });

  assert.equal((await t.admin.get("/api/state")).data.ask, true);
  const r = await t.admin.post("/api/ask", { q: "what's blocking the intake" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { answer: "FTC-1 is blocked.", issues: [1] });

  const [call] = t.gemini.calls;
  assert.match(call.url, /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/[\w.-]+:generateContent$/);
  assert.equal(call.headers["x-goog-api-key"], "test-key-123");
  assert.ok(!call.url.includes("test-key-123"), "the key never goes in the URL");
  const prompt = call.body.contents[0].parts[0].text;
  assert.match(prompt, /FTC-1 \| title:Intake jams \| status:blocked/);
  assert.match(prompt, /assigned:Joseph/);
  assert.match(prompt, /blocked because:Waiting on servo/);
  assert.match(prompt, /name:Goblida servo/);
  assert.match(prompt, /Today is \d{4}-\d{2}-\d{2}\./);
  assert.ok(!prompt.includes("SECRET-DESCRIPTION") && !prompt.includes("SECRET-COMMENT"), "descriptions and comments stay home");
  assert.ok(!prompt.includes("test-key-123"));
  assert.equal(call.body.tools, undefined, "no search grounding, which Google retains for 30 days");
  assert.ok(!JSON.stringify((await t.admin.get("/api/state")).data).includes("test-key-123"), "the key is never sent to the browser");
  await t.close();
});

test("ask: only issues that exist come back, and bad replies are refused", async () => {
  const t = await boot();
  await t.admin.post("/api/issues", issue());
  t.gemini.reply = { answer: "Look at FTC-1 and FTC-77.", issues: [1, 77, 1, "x", -3] };
  assert.deepEqual((await t.admin.post("/api/ask", { q: "what's up" })).data.issues, [1]);

  t.gemini.reply = "this is not json";
  assert.equal((await t.admin.post("/api/ask", { q: "what's up" })).status, 502);
  t.gemini.reply = { answer: "", issues: [] };
  assert.equal((await t.admin.post("/api/ask", { q: "what's up" })).status, 502);
  t.gemini.reply = { answer: "x".repeat(2000), issues: [] };
  assert.ok((await t.admin.post("/api/ask", { q: "what's up" })).data.answer.length <= 500);
  t.gemini.status = 500;
  assert.equal((await t.admin.post("/api/ask", { q: "what's up" })).status, 502);
  await t.close();
});

test("ask: needs a sign-in, a real question, and respects the admin switch and rate limit", async () => {
  const t = await boot({ askLimits: { perMinute: 3 } });
  assert.equal((await t.client().post("/api/ask", { q: "what's up" })).status, 401);
  assert.equal((await t.admin.post("/api/ask", { q: "   " })).status, 400);
  assert.equal((await t.admin.post("/api/ask", { q: "x".repeat(201) })).status, 400);
  assert.equal((await t.admin.call("POST", "/api/ask", { q: "what's up" }, { "X-Client": "" })).status, 403);
  assert.equal(t.gemini.calls.length, 0, "rejected questions cost nothing");

  for (let n = 0; n < 3; n++) assert.equal((await t.admin.post("/api/ask", { q: "what's up" })).status, 200);
  const limited = await t.admin.post("/api/ask", { q: "what's up" });
  assert.equal(limited.status, 429);
  assert.equal(t.gemini.calls.length, 3);

  const st = (await t.admin.get("/api/state")).data.settings;
  assert.equal((await t.admin.put("/api/meta/settings", { ...st, ai: false })).status, 200);
  assert.equal((await t.admin.get("/api/state")).data.settings.ai, false);
  assert.equal((await t.admin.post("/api/ask", { q: "what's up" })).status, 503);
  await t.close();
});

test("ask: prompts live in config/, are created for the team, and edits apply without a restart", async () => {
  const dir = join(mkdtempSync(join(tmpdir(), "008-config-")), "config");
  const t = await boot({ configDir: dir });
  await t.admin.post("/api/issues", issue({ title: "Intake jams" }));

  for (const f of ["ask-system.md", "ask-prompt.md", "README.md"]) assert.ok(existsSync(join(dir, f)), f + " is created on first run");
  await t.admin.post("/api/ask", { q: "what's up" });
  let [call] = t.gemini.calls;
  assert.match(call.body.systemInstruction.parts[0].text, /FIRST Tech Challenge/);
  assert.match(call.body.contents[0].parts[0].text, /Question: what's up/);

  writeFileSync(join(dir, "ask-system.md"), "Answer like a pirate.");
  writeFileSync(join(dir, "ask-prompt.md"), "{{today}} :: {{question}} :: {{workspace}} :: {{question}}");
  await t.admin.post("/api/ask", { q: "what's {{workspace}}" });
  [, call] = t.gemini.calls;
  assert.equal(call.body.systemInstruction.parts[0].text, "Answer like a pirate.");
  const sent = call.body.contents[0].parts[0].text;
  assert.match(sent, /^\d{4}-\d{2}-\d{2} :: what's \{\{workspace\}\} :: Team:/, "placeholders fill once; typed text is not expanded");
  assert.match(sent, /Intake jams/);

  writeFileSync(join(dir, "ask-prompt.md"), "no placeholder here");
  writeFileSync(join(dir, "ask-system.md"), "   ");
  await t.admin.post("/api/ask", { q: "what's up" });
  [, , call] = t.gemini.calls;
  assert.match(call.body.contents[0].parts[0].text, /Question: what's up/, "a prompt that drops {{question}} is ignored");
  assert.match(call.body.systemInstruction.parts[0].text, /FIRST Tech Challenge/, "an empty file falls back");

  await t.close();
  const kept = readFileSync(join(dir, "ask-system.md"), "utf8");
  const again = await boot({ configDir: dir });
  assert.equal(readFileSync(join(dir, "ask-system.md"), "utf8"), kept, "starting again never overwrites an edit");
  await again.close();
  rmSync(join(dir, ".."), { recursive: true, force: true });
});
