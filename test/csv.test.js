import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "public", "csv.js"), "utf8");
const sandbox = { window: {}, TextDecoder, Uint8Array };
vm.runInNewContext(source, sandbox);
const { CsvImport } = sandbox.window;
const plain = (x) => JSON.parse(JSON.stringify(x));

const ctx = { subs: { drive: "Drivetrain", lift: "Lift", team: "Team", auto: "Autonomous" }, today: "2026-11-02", me: "jc", typeFor: (sub) => (sub === "auto" ? "code" : "build"), existing: [],
  people: [{ id: "jc", name: "Joseph Cui", handle: "joseph" }, { id: "mk", name: "Mika", handle: "mika" }] };

test("parses quotes, commas in cells, line breaks in cells and CRLF", () => {
  const { headers, rows } = plain(CsvImport.parse('Name,Note\r\n"Bolt, M3","He said ""two""\r\nmore"\r\nNut,plain\r\n'));
  assert.deepEqual(headers, ["Name", "Note"]);
  assert.deepEqual(rows.map((r) => r.cells), [["Bolt, M3", 'He said "two"\r\nmore'], ["Nut", "plain"]]);
  assert.deepEqual(rows.map((r) => r.line), [2, 4]);
});

test("reads semicolons, tabs, a byte order mark and a title row above the header", () => {
  assert.deepEqual(plain(CsvImport.parse("a;b\n1,5;2\n")).rows[0].cells, ["1,5", "2"]);
  assert.deepEqual(plain(CsvImport.parse("a\tb\n1\t2\n")).headers, ["a", "b"]);
  assert.deepEqual(plain(CsvImport.parse("﻿a,b\n1,2\n")).headers, ["a", "b"]);
  assert.deepEqual(plain(CsvImport.parse("2026 parts list,,\n,,\nPart,Need,Have\nBolt,1,2\n")).headers, ["Part", "Need", "Have"]);
});

test("decodes what Excel writes: UTF-8, UTF-16 and Windows-1252", () => {
  const bytes = (...b) => new Uint8Array(b).buffer;
  assert.equal(CsvImport.decode(new TextEncoder().encode("café").buffer), "café");
  assert.equal(CsvImport.decode(bytes(0xff, 0xfe, 0x61, 0x00)), "a");
  assert.equal(CsvImport.decode(bytes(0x63, 0x61, 0x66, 0xe9)), "café");
});

test("finds columns by common names and never uses a column twice", () => {
  const columns = plain(CsvImport.guessColumns("parts", ["Part Name", "Qty", "On Hand", "Unit Cost", "Supplier", "Weird"]));
  assert.deepEqual(columns, { name: 0, need: 1, have: 2, price: 3, vendor: 4 });
  assert.equal(plain(CsvImport.guessColumns("issues", ["Task", "Owner", "Deadline", "Status"])).title, 0);
});

test("numbers and dates survive spreadsheet formatting", () => {
  assert.equal(CsvImport.parseNumber("$1,299.50"), 1299.5);
  assert.equal(CsvImport.parseNumber("12,50"), 12.5);
  assert.equal(CsvImport.parseNumber("abc"), null);
  assert.equal(CsvImport.parseDate("2026-11-02"), "2026-11-02");
  assert.equal(CsvImport.parseDate("11/2/26"), "2026-11-02");
  assert.equal(CsvImport.parseDate("25/12/2026"), "2026-12-25");
  assert.equal(CsvImport.parseDate("2/30/2026"), null);
  assert.equal(CsvImport.parseDate("soon"), null);
});

test("parts: rows that can't be used are reported, and existing names are left out", () => {
  const table = CsvImport.parse("Part,Need,Have,Price,Subsystem\nBolt,4,1,0.25,Lift\nNut,x,1,1,\nbolt,1,1,1,\nOld part,1,1,1,\n,1,1,1,\nWasher,,,,\n");
  const plan = plain(CsvImport.prepare("parts", table, CsvImport.guessColumns("parts", table.headers), { ...ctx, existing: ["Old Part"] }));
  assert.deepEqual(plan.ready.map((p) => p.name), ["Bolt", "Washer"]);
  assert.equal(plan.ready[0].sub, "lift");
  assert.equal(plan.ready[1].need, 1, "a blank need means one");
  assert.deepEqual(plan.skipped.map((x) => x.line), [3, 4, 5, 6]);
});

test("issues: status, priority, people and dates map onto the app's values", () => {
  const table = CsvImport.parse("Task,Status,Priority,Owner,Due,Area\nTune PID,In Progress,High,mika,11/20/2026,Autonomous\nWire hub,complete,,Nobody,someday,\n");
  const { ready, notes } = plain(CsvImport.prepare("issues", table, CsvImport.guessColumns("issues", table.headers), ctx));
  assert.deepEqual([ready[0].status, ready[0].pri, ready[0].who, ready[0].due, ready[0].sub, ready[0].type], ["doing", "high", ["mk"], "2026-11-20", "auto", "code"]);
  assert.deepEqual([ready[1].status, ready[1].pri, ready[1].who, ready[1].due], ["done", "med", ["jc"], undefined]);
  assert.deepEqual(notes, { unknownPeople: 1, badDates: 1 });
});

test("prices with decimal commas and grouped thousands keep their value", () => {
  assert.equal(CsvImport.parseNumber("€1.234,56"), 1234.56);
  assert.equal(CsvImport.parseNumber("1.234.567,89"), 1234567.89);
  assert.equal(CsvImport.parseNumber("$1,234.56"), 1234.56);
  assert.equal(CsvImport.parseNumber("1,234,567.89"), 1234567.89);
  assert.equal(CsvImport.parseNumber("12.34,56"), null, "malformed grouping is not silently reinterpreted");
});

test("Unicode titles and emoji import and deduplicate by their saved names", () => {
  for (const [kind, header, key] of [["parts", "Part", "name"], ["issues", "Title", "title"]]) {
    const table = CsvImport.parse(`${header},Subsystem\n电机,team\n传感器,team\n🦾,team\n🦾,team\nOld Part,team\n`);
    const plan = plain(CsvImport.prepare(kind, table, CsvImport.guessColumns(kind, table.headers), { ...ctx, existing: ["OLD PART"] }));
    assert.deepEqual(plan.ready.map((doc) => doc[key]), ["电机", "传感器", "🦾"]);
    assert.deepEqual(plan.skipped.map((row) => row.line), [5, 6]);
  }
});

test("out-of-range parts are skipped before sending the import", () => {
  const table = CsvImport.parse("Part,Have,Need,Ordered,Price\nToo many,100001,1,0,1\nToo costly,0,1,0,1000001\nAt limits,100000,100000,100000,1000000\nGood,0,1,0,2\n");
  const plan = plain(CsvImport.prepare("parts", table, CsvImport.guessColumns("parts", table.headers), ctx));
  assert.deepEqual(plan.ready.map((part) => part.name), ["At limits", "Good"]);
  assert.deepEqual(plan.skipped.map((row) => row.line), [2, 3]);
  assert.match(plan.skipped[0].reason, /have.*100000/);
  assert.match(plan.skipped[1].reason, /price.*1000000/);
});
