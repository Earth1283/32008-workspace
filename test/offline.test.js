import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "public", "offline.js"), "utf8");
const sandbox = { window: {} };
vm.runInNewContext(source, sandbox);
const { Offline } = sandbox.window;
const plain = (x) => JSON.parse(JSON.stringify(x));

const memory = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) }; };
const fresh = () => Offline.queue(memory(), "me");

test("every script and stylesheet the page loads is kept for offline use", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
  const html = readFileSync(join(root, "index.html"), "utf8"), worker = readFileSync(join(root, "sw.js"), "utf8");
  const loaded = [...html.matchAll(/(?:src|href)="([\w-]+\.(?:js|css))"/g)].map((m) => m[1]);
  assert.ok(loaded.length >= 8);
  for (const file of loaded) assert.ok(worker.includes(`"/${file}"`), `${file} is missing from sw.js`);
});

test("edits of one document fold together and keep the copy the first edit started from", () => {
  const q = fresh();
  q.save("issues", { id: 1, title: "b", rev: 3 }, { id: 1, title: "a", rev: 3 });
  q.save("issues", { id: 1, title: "c", rev: 3 }, { id: 1, title: "b", rev: 3 });
  const [op, ...rest] = plain(q.all());
  assert.equal(rest.length, 0);
  assert.equal(op.doc.title, "c");
  assert.equal(op.was.title, "a");
});

test("editing or deleting something that was never sent changes the waiting create", () => {
  const q = fresh();
  q.create("issues", -5, "cid", { title: "new" });
  q.save("issues", { id: -5, title: "newer", rev: 0 });
  assert.equal(plain(q.all()).length, 1);
  assert.equal(plain(q.all())[0].doc.title, "newer");
  assert.equal(plain(q.all())[0].doc.id, undefined);
  q.remove("issues", -5);
  assert.equal(q.all().length, 0, "the server never hears about it");
});

test("deleting a document replaces its waiting edits", () => {
  const q = fresh();
  q.save("parts", { id: "p", name: "x" }, { id: "p", name: "w" });
  q.remove("parts", "p");
  assert.deepEqual(plain(q.all()).map((op) => op.type), ["remove"]);
});

test("a change that points at a new issue waits until the issue has its real number", () => {
  const q = fresh();
  q.save("meetings", { id: "m", actions: [] }, { id: "m", actions: [] });
  q.create("issues", -5, "cid", { title: "x" });
  q.save("meetings", { id: "m", actions: [{ id: "a", issue: -5 }] });
  const issue = plain(q.next());
  assert.equal(issue.type, "create");
  q.resolve("issues", -5, 42);
  q.finish(issue.id, issue.v, { id: 42, rev: 1 });
  const next = plain(q.next());
  assert.equal(next.coll, "meetings");
  assert.equal(next.doc.actions[0].issue, 42);
});

test("a new notebook entry on a new issue is sent after it, with the real number", () => {
  const q = fresh();
  q.create("notebook", "newA", "c1", { title: "entry", issue: -5 });
  q.create("issues", -5, "c2", { title: "issue" });
  const issue = plain(q.next());
  assert.equal(issue.coll, "issues");
  q.resolve("issues", -5, 7);
  q.finish(issue.id, issue.v, { id: 7, rev: 1 });
  assert.equal(plain(q.next()).doc.issue, 7);
});

test("a document edited while it was being sent goes out again with the newer text", () => {
  const q = fresh();
  q.create("issues", -5, "c", { title: "first" });
  const sending = plain(q.next());
  q.save("issues", { id: -5, title: "second" });
  q.resolve("issues", -5, 9);
  q.finish(sending.id, sending.v, { id: 9, rev: 1, title: "first" });
  const op = plain(q.next());
  assert.deepEqual([op.type, op.target, op.doc.title, op.doc.rev, op.was.title], ["save", 9, "second", 1, "first"]);
});

test("failed changes stop going out, stay listed, and clear when retried, edited or discarded", () => {
  const q = fresh();
  q.save("parts", { id: "p", name: "x" }, { id: "p", name: "w" });
  const { id } = q.next();
  q.fail(id, "Nope");
  assert.equal(q.next(), null);
  assert.equal(q.pendingCount(), 0);
  assert.equal(q.failedCount(), 1);
  q.retry(id);
  assert.equal(q.pendingCount(), 1);
  q.fail(id, "Nope");
  q.save("parts", { id: "p", name: "y" });
  assert.equal(q.pendingCount(), 1, "a new edit tries again");
  q.discard(id);
  assert.equal(q.all().length, 0);
});

test("the screen shows server data with waiting changes on top", () => {
  const q = fresh();
  const state = { issues: [{ id: 1, title: "a", rev: 1 }, { id: 2, title: "b", rev: 1 }], inbox: [{ id: 5, read: false }, { id: 6, read: false }] };
  q.save("issues", { id: 1, title: "changed", rev: 1 }, state.issues[0]);
  q.remove("issues", 2);
  q.create("issues", -9, "c", { title: "new" });
  q.markRead([5]);
  const out = plain(q.overlay(state));
  assert.deepEqual(out.issues.map((i) => [i.id, i.title]), [[1, "changed"], [-9, "new"]]);
  assert.deepEqual(out.inbox.map((n) => n.read), [true, false]);
  assert.equal(state.issues.length, 2, "the saved copy itself isn't touched");
});

test("read marks fold together, and 'all' wins", () => {
  const q = fresh();
  q.markRead([1]); q.markRead([2]);
  assert.deepEqual(plain(q.all())[0].ids, [1, 2]);
  q.markRead("all");
  assert.equal(plain(q.all())[0].ids, "all");
});

test("each person has their own queue on a shared device", () => {
  const device = memory();
  Offline.queue(device, "ana").save("parts", { id: "p" }, { id: "p" });
  assert.equal(Offline.queue(device, "dev").pendingCount(), 0);
  assert.equal(Offline.queue(device, "ana").pendingCount(), 1);
});

test("one tab syncs at a time, and a lease left by a closed tab runs out", () => {
  const device = memory();
  assert.equal(Offline.takeLease(device, "a", 1000), true);
  assert.equal(Offline.takeLease(device, "b", 2000), false);
  assert.equal(Offline.takeLease(device, "a", 2000), true);
  assert.equal(Offline.takeLease(device, "b", 60_000), true);
});

test("a tab that finishes syncing hands the lease straight to another", () => {
  const device = memory();
  Offline.takeLease(device, "a", 1000);
  Offline.releaseLease(device, "b");
  assert.equal(Offline.takeLease(device, "c", 1000), false, "only the holder can release it");
  Offline.releaseLease(device, "a");
  assert.equal(Offline.takeLease(device, "c", 1000), true);
});

test("a device without storage reports no saved copy instead of failing", () => {
  assert.equal(Offline.saveState(null, {}), false);
  assert.equal(Offline.loadState(null), null);
  assert.equal(Offline.takeLease(null, "a"), true);
  assert.equal(Offline.queue(null, "me").pendingCount(), 0);
});
