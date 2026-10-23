import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tx } from "./db.js";
import { hashPassword } from "./auth.js";

const ANCHOR = "2026-10-23"; // the day the demo dataset was written
export const DEMO_PASSWORD = "innovators";

const day = (s) => Math.round(Date.parse(s + "T00:00:00Z") / 864e5);
const iso = (n) => new Date(n * 864e5).toISOString().slice(0, 10);

/** Shift every YYYY-MM-DD in the dataset so the demo always looks current. */
function shift(v, by) {
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return iso(day(v) + by);
  if (Array.isArray(v)) return v.map((x) => shift(x, by));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shift(x, by)]));
  return v;
}

export function seedDemo(db, store, todayIso = new Date().toISOString().slice(0, 10)) {
  const raw = JSON.parse(readFileSync(new URL("./demo-data.json", import.meta.url), "utf8"));
  const d = shift(raw, day(todayIso) - day(ANCHOR));
  const logins = [];

  tx(db, () => {
    store.setMeta("team", d.team);
    store.setMeta("settings", { budget: d.budget, branchPrefix: "ftc", repo: "" });
    store.setMeta("nextIssue", d.nextId);

    const ins = db.prepare("INSERT INTO users (id, username, pass, access, must_change, created_at) VALUES (?, ?, ?, ?, 0, ?)");
    for (const p of d.people) {
      const { id, ...doc } = p;
      store.put("people", id, doc, "demo");
      const username = p.name.toLowerCase();
      ins.run(id, username, hashPassword(DEMO_PASSWORD), id === "jc" ? "Admin" : "Member", Date.now());
      logins.push(username);
    }
    for (const coll of ["issues", "notebook", "practice", "meetings", "parts", "milestones", "phases"]) {
      for (const doc of d[coll] ?? []) {
        const { id, ...rest } = doc;
        const key = id ?? randomBytes(5).toString("hex");
        store.put(coll, key, rest, "demo");
      }
    }
    // Practice, parts, milestones and phases had no ids in the dataset.
  });
  return logins;
}
