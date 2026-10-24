import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "public", "commands.js"), "utf8");
const sandbox = { window: {} };
vm.runInNewContext(source, sandbox);
const { CMD } = sandbox.window;

const TODAY = "2026-10-24";
const dayNumber = (iso) => Math.round(Date.parse(iso + "T00:00:00Z") / 864e5);

function makeWorld(extra = []) {
  const F = {
    today: TODAY, me: "jc",
    subs: { drive: "Drivetrain", intake: "Intake", lift: "Lift" },
    status: { todo: "To do", doing: "In progress", review: "In review", blocked: "Blocked", done: "Done" },
    statusOrder: ["doing", "review", "blocked", "todo", "done"],
    pri: { high: "High", med: "Medium", low: "Low" },
    people: [{ id: "jc", name: "Joseph" }, { id: "mk", name: "Mika" }, { id: "ln", name: "Lin" }],
    issues: [
      { id: 12, title: "Tune drivetrain feedforward", status: "doing", sub: "drive", pri: "high", who: ["mk"], due: "2026-10-22" },
      { id: 13, title: "Intake jams on yellow samples", status: "blocked", sub: "intake", pri: "med", who: ["jc"] },
      { id: 14, title: "Lift string re-route", status: "done", sub: "lift", pri: "low", who: ["ln"], logged: false },
      ...extra,
    ],
    days: (iso) => dayNumber(iso) - dayNumber(TODAY),
    fmt: (iso) => iso,
  };
  F.person = (id) => F.people.find((p) => p.id === id);
  return F;
}

function makePalette({ route = "home", arg = null, extra = [], overrides = {} } = {}) {
  const calls = [];
  const act = new Proxy({}, { get: (_, name) => (...args) => { calls.push([name, ...args]); } });
  const ctx = { route, arg, me: "jc", theme: "dark", themePref: "system", accent: "", density: "comfortable", role: "captain", canWrite: true, admin: true, ...overrides };
  const accents = [["", "Steel blue", "#1A6FA8"], ["#14B8A6", "Teal", "#14B8A6"], ["#8B9099", "Graphite", "#8B9099"]];
  return { calls, palette: CMD.create({ F: makeWorld(extra), ctx, act, accents }) };
}

const typed = (palette, text) => palette.analyze(text);
const plain = (value) => JSON.parse(JSON.stringify(value));
const texts = (result) => result.rows.map((row) => row.text);

test("typing a verb prefix ghosts the rest of the command", () => {
  const { palette } = makePalette();
  const result = typed(palette, "set th");
  assert.match(result.ghost, /^eme to /);
});

test("set theme to <value> completes and runs", () => {
  const { palette, calls } = makePalette();
  const result = typed(palette, "set theme to li");
  assert.equal(result.ghost, "ght");
  const row = result.rows[0];
  assert.equal(row.complete, true);
  row.run();
  assert.deepEqual(calls[0], ["setTheme", "light"]);
});

test("the undo handed back restores the previous theme preference", () => {
  const { palette, calls } = makePalette();
  const undo = typed(palette, "set theme to light").rows[0].run();
  undo();
  assert.deepEqual(calls.map((c) => c.slice(0, 2)), [["setTheme", "light"], ["setTheme", "system"]]);
});

test("loose words find an enumerable command", () => {
  const { palette } = makePalette();
  const result = typed(palette, "dark");
  assert.equal(result.rows[0].text, "set theme to dark");
});

test("aliases: mark ... as and move ... to reach the same command", () => {
  const { palette } = makePalette();
  for (const phrase of ["mark FTC-12 as done", "move 12 to done", "set FTC-12 status to done"]) {
    const row = typed(palette, phrase).rows[0];
    assert.equal(row.command, "status", phrase);
    assert.equal(row.complete, true, phrase);
  }
});

test("multi-word values: in progress", () => {
  const { palette, calls } = makePalette();
  const row = typed(palette, "set FTC-13 status to in prog").rows[0];
  assert.equal(row.args.status.id, "doing");
  assert.equal(typed(palette, "set FTC-13 status to in prog").ghost, "ress");
  row.run();
  assert.deepEqual(calls[0], ["setStatus", 13, "doing"]);
});

test("the issue on screen is the first suggestion for an issue slot", () => {
  const { palette } = makePalette({ route: "issues", arg: "13" });
  assert.equal(typed(palette, "assign ").ghost, "FTC-13 to ");
});

test("assignee suggestions favor people who know the subsystem, then the lightest load", () => {
  const { palette } = makePalette();
  const result = typed(palette, "assign FTC-12 to ");
  assert.equal(result.rows[0].args.person.id, "mk");
});

test("an issue title ghosts when typed from its start", () => {
  const { palette } = makePalette();
  const result = typed(palette, "Tune dr");
  assert.equal(result.ghost, "ivetrain feedforward");
  assert.equal(result.ghostRow.command, "open");
});

test("empty input suggests the next step for the issue on screen", () => {
  const { palette } = makePalette({ route: "issues", arg: "12" });
  const result = typed(palette, "");
  assert.equal(result.ghost, "set FTC-12 status to in review");
  assert.equal(result.empty, true);
});

test("empty input on a done, unlogged issue suggests drafting the notebook entry", () => {
  const { palette } = makePalette({ route: "issues", arg: "14" });
  assert.equal(typed(palette, "").ghost, "draft notebook entry for FTC-14");
});

test("an incomplete row fills text instead of running", () => {
  const { palette } = makePalette();
  const row = typed(palette, "assign").rows.find((r) => r.command === "assign");
  assert.equal(row.complete, false);
  assert.equal(row.run, null);
});

test("viewers do not see commands that write", () => {
  const { palette } = makePalette({ overrides: { canWrite: false } });
  const result = typed(palette, "set FTC-12 status to done");
  assert.ok(!result.rows.some((r) => r.command === "status"));
});

test("only admins get connect github", () => {
  assert.ok(typed(makePalette().palette, "connect gi").rows.some((r) => r.command === "github"));
  assert.ok(!typed(makePalette({ overrides: { admin: false } }).palette, "connect gi").rows.some((r) => r.command === "github"));
});

test("dates: weekdays, tomorrow and ISO resolve; nonsense does not", () => {
  assert.equal(CMD.resolveDate("tomorrow", TODAY), "2026-10-25");
  assert.equal(CMD.resolveDate("monday", TODAY), "2026-10-26");
  assert.equal(CMD.resolveDate("saturday", TODAY), "2026-10-31");
  assert.equal(CMD.resolveDate("2026-11-03", TODAY), "2026-11-03");
  assert.equal(CMD.resolveDate("2026-02-31", TODAY), null);
  assert.equal(CMD.resolveDate("soonish", TODAY), null);
  assert.equal(CMD.resolveDate("none", TODAY), "");
});

test("new issue carries the title through", () => {
  const { palette, calls } = makePalette();
  typed(palette, "new issue Replace the intake belt").rows[0].run();
  assert.deepEqual(calls[0], ["newIssue", "Replace the intake belt"]);
});

test("a thousand keystrokes against 3000 issues stay fast", () => {
  const many = Array.from({ length: 3000 }, (_, n) => ({
    id: 100 + n, title: `Issue number ${n} about ${["lift", "intake", "vision", "drivetrain"][n % 4]} tuning`, status: ["todo", "doing", "review", "done"][n % 4],
    sub: ["drive", "intake", "lift"][n % 3], pri: "med", who: [["jc", "mk", "ln"][n % 3]], due: n % 7 === 0 ? "2026-10-20" : undefined, logged: n % 8 !== 3,
  }));
  const phrases = ["", "o", "open FTC-1", "set theme to d", "assign FTC-1", "assign FTC-150 to m", "set FTC-2000 status to in r", "drive", "tuning", "Issue number 29", "mark 77 as d", "set accent to t"];
  const started = performance.now();
  let keystrokes = 0;
  for (let round = 0; round < 84; round++) {
    const { palette } = makePalette({ route: "issues", arg: "150", extra: many });
    for (const phrase of phrases) for (let end = 1; end <= phrase.length || end === 1; end++) { palette.analyze(phrase.slice(0, end)); keystrokes++; }
  }
  const perKeystroke = (performance.now() - started) / keystrokes;
  assert.ok(perKeystroke < 4, `${perKeystroke.toFixed(2)} ms per keystroke including palette construction`);
});

test("one warm palette answers a keystroke in well under a frame", () => {
  const many = Array.from({ length: 3000 }, (_, n) => ({ id: 100 + n, title: `Issue ${n} lift tuning`, status: "todo", sub: "lift", pri: "med", who: ["jc"] }));
  const { palette } = makePalette({ extra: many });
  palette.analyze("open ");
  const started = performance.now();
  for (let i = 0; i < 500; i++) palette.analyze(i % 2 ? "open FTC-1" : "assign FTC-15");
  assert.ok((performance.now() - started) / 500 < 1, "under 1 ms per keystroke once warm");
});

test("a finished command reports the change it will make, from and to", () => {
  const { palette } = makePalette();
  assert.deepEqual(plain(typed(palette, "set theme to light").rows[0].effect), { label: "Theme", from: "system", to: "light" });
  assert.deepEqual(plain(typed(palette, "move 13 to doing").rows[0].effect), { label: "FTC-13", from: "Blocked", to: "In progress" });
  assert.deepEqual(plain(typed(palette, "open 12").rows[0].effect), { text: "Opens the issue" });
});

test("an empty box offers both suggestions and the menu of command shapes", () => {
  const { palette } = makePalette();
  const result = typed(palette, "");
  assert.ok(result.rows.length > 0);
  assert.ok(result.menu.some((row) => row.command === "status" && row.menu));
});
