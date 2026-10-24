/* The inbox: who hears about what, @mentions, team (subsystem) feeds, and the timed checks for due dates and the
   weekly digest. "Direct" notices are about you. "Team" notices are activity on subsystems you follow. */
import { SUBS, SUB_NAMES } from "./validate.js";

const DAY = 864e5;
const KEEP_MS = 60 * DAY;

/** YYYY-MM-DD in the server's time zone (set TZ to the team's). */
export const localDate = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const daysFrom = (a, b) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / DAY);
const short = (s, n = 120) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);
const noteKey = (n) => `${n.who}\n${n.date}\n${n.text}`;
const fold = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const HANDLE_CH = "a-z0-9._-";

/** @handles found in text. While typing, a handle at the very end doesn't count yet: it may be half written. */
function handlesIn(text, typing) {
  const re = new RegExp(`(?:^|[^\\w@])@([a-z0-9][${HANDLE_CH}]{0,31})(?=[^${HANDLE_CH}]${typing ? "" : "|$"})`, "gi");
  return [...String(text ?? "").matchAll(re)].map((m) => m[1].toLowerCase());
}

export function makeNotifier({ db, store, push }) {
  const q = {
    add: db.prepare("INSERT OR IGNORE INTO notifications (user_id, kind, text, link, dedupe, created_at, sub) VALUES (?, ?, ?, ?, ?, ?, ?)"),
    list: db.prepare(`SELECT id, kind, text, link, sub, created_at AS at, read_at IS NOT NULL AS read FROM notifications
      WHERE user_id = ? AND (kind = 'team') = ? ORDER BY id DESC LIMIT ?`),
    read: db.prepare("UPDATE notifications SET read_at = ? WHERE user_id = ? AND id = ? AND read_at IS NULL"),
    readAll: db.prepare("UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL"),
    prune: db.prepare("DELETE FROM notifications WHERE created_at < ?"),
    users: db.prepare("SELECT id, username FROM users ORDER BY created_at, id"),
    doneSince: db.prepare("SELECT COUNT(*) AS n FROM docs WHERE coll = 'issues' AND updated_at >= ? AND json_extract(data, '$.status') = 'done'"),
  };
  const DEFAULTS = { due: true, blocked: true, mention: true, pr: true, digest: false, follow: [] };

  function prefs(userId) {
    const { id: _i, rev: _r, ...p } = store.get("prefs", userId) ?? {};
    return { ...DEFAULTS, ...p };
  }
  const users = () => q.users.all();
  const isUser = (id) => users().some((u) => u.id === id);
  const name = (id) => (id === "github" ? "GitHub" : store.get("people", id)?.name ?? "Someone");
  const followers = (sub) => users().map((u) => u.id).filter((id) => prefs(id).follow.includes(sub));

  /**
   * Everyone's @handle: their first name, or their whole name run together when two people share a first name.
   * Subsystem keys (@lift) are reserved for team mentions.
   */
  function handles() {
    const ids = new Set(users().map((u) => u.id));
    const people = store.list("people").filter((p) => ids.has(p.id));
    const clip = (s) => s.replace(new RegExp(`[^${HANDLE_CH}]`, "g"), "").replace(/^[._-]+/, "").slice(0, 28);
    const first = (p) => clip(fold(p.name).split(/\s+/)[0] ?? "");
    const whole = (p) => clip(fold(p.name).replace(/\s+/g, ""));
    const firsts = new Map();
    for (const p of people) firsts.set(first(p), (firsts.get(first(p)) ?? 0) + 1);
    const taken = new Set(SUBS), out = new Map();
    for (const p of people) {
      let h = first(p);
      if (!h || firsts.get(h) > 1 || taken.has(h)) h = whole(p);
      const stem = h || "member";
      for (let n = 2; !h || taken.has(h); n++) h = stem + n;
      taken.add(h);
      out.set(p.id, h);
    }
    return out;
  }

  /** Who a piece of text mentions: people by handle or username, and teams by subsystem key. */
  function mentions(text, typing = false) {
    const byHandle = new Map([...handles()].map(([id, h]) => [h, id]));
    const byUsername = new Map(users().map((u) => [u.username.toLowerCase(), u.id]));
    const people = new Set(), teams = new Set();
    for (const raw of handlesIn(text, typing)) {
      for (const h of [raw, raw.replace(/[._-]+$/, "")]) {
        const id = byHandle.get(h) ?? byUsername.get(h);
        if (id) { people.add(id); break; }
        if (SUBS.includes(h)) { teams.add(h); break; }
      }
    }
    return { people, teams };
  }
  const minus = (a, b) => new Set([...a].filter((x) => !b.has(x)));

  /** Add one direct notice, unless the person turned that kind off. dedupe stops repeats of the same event. */
  function send(userId, kind, text, link = null, dedupe = null) {
    if (!isUser(userId) || !prefs(userId)[kind]) return false;
    const r = q.add.run(userId, kind, text, link, dedupe, Date.now(), null);
    if (r.changes) push(userId);
    return r.changes > 0;
  }

  /**
   * One change to one document. Direct notices go first; team notices then go to followers who weren't
   * already told directly, so nobody hears about the same change twice.
   */
  function change(actor, link) {
    const told = new Set([actor]);
    return {
      direct(userId, kind, text) {
        if (told.has(userId)) return;
        told.add(userId);
        send(userId, kind, text, link);
      },
      team(sub, text) {
        for (const u of followers(sub)) {
          if (told.has(u)) continue;
          told.add(u);
          const r = q.add.run(u, "team", text, link, null, Date.now(), sub);
          if (r.changes) push(u);
        }
      },
      /** Newly mentioned people and teams in a text field. Fields save as you type unless typing is false. */
      mentioned(beforeText, afterText, says, typing = true) {
        const was = mentions(beforeText, typing), now = mentions(afterText, typing);
        for (const u of minus(now.people, was.people)) this.direct(u, "mention", says("you"));
        for (const t of minus(now.teams, was.teams)) this.team(t, says(SUB_NAMES[t]));
      },
    };
  }

  function issueChanged(before, after, actor) {
    const label = `FTC-${after.id} ${after.title}`;
    const c = change(actor, `issues/${after.id}`);
    const who = name(actor);

    const was = new Set(before?.who ?? []);
    for (const u of after.who) if (!was.has(u)) c.direct(u, "mention", `${who} assigned you ${label}`);

    const oldNotes = before?.notes ?? [];
    const watchers = [...after.who, ...oldNotes.map((n) => n.who)];
    const seen = new Set(oldNotes.map(noteKey));
    for (const n of after.notes ?? []) {
      if (seen.has(noteKey(n))) continue;
      const nc = change(n.who, `issues/${after.id}`);
      const quote = `"${short(n.text)}"`;
      nc.mentioned("", n.text, (x) => `${name(n.who)} mentioned ${x} on ${label}: ${quote}`, false);
      for (const u of watchers) nc.direct(u, "mention", `${name(n.who)} commented on ${label}: ${quote}`);
      nc.team(after.sub, `${name(n.who)} commented on ${label}: ${quote}`);
    }

    for (const [field, what] of [["desc", "the description of"], ["blockedBy", "the blocker note on"]]) {
      c.mentioned(before?.[field], after[field], (x) => `${who} mentioned ${x} in ${what} ${label}`);
    }

    if (!before) c.team(after.sub, `${who} opened ${label}`);
    else if (before.sub !== after.sub) c.team(after.sub, `${who} moved ${label} to ${SUB_NAMES[after.sub]}`);
    if (before && after.status === "blocked" && before.status !== "blocked") {
      for (const u of new Set(watchers)) c.direct(u, "blocked", `${label} is blocked`);
      c.team(after.sub, `${label} is blocked`);
    }
    if (before && after.status === "done" && before.status !== "done") {
      c.team(after.sub, actor === "github" ? `${label} is done: its pull request was merged` : `${who} finished ${label}`);
    }
  }

  const TEXT = {
    meetings: { fields: ["notes"], where: (d) => `the notes for ${d.title}` },
    notebook: { fields: ["problem", "tried", "result", "next"], where: (d) => `the notebook entry ${d.title}` },
  };

  /** Called after any document is created or saved. */
  function changed(coll, before, after, actor) {
    if (coll === "issues") return issueChanged(before, after, actor);
    const t = TEXT[coll];
    if (!t) return;
    const c = change(actor, `${coll}/${after.id}`);
    for (const f of t.fields) c.mentioned(before?.[f], after[f], (x) => `${name(actor)} mentioned ${x} in ${t.where(after)}`);
  }

  function digest(userId, today, now) {
    const issues = store.list("issues");
    const mine = issues.filter((i) => i.status !== "done" && i.who.includes(userId));
    const late = mine.filter((i) => i.due && daysFrom(today, i.due) < 0).length;
    const done = q.doneSince.get(now - 7 * DAY).n;
    const next = store.list("milestones").find((m) => daysFrom(today, m.date) >= 0);
    const parts = [
      `This week the team finished ${done} ${done === 1 ? "issue" : "issues"}.`,
      `You have ${mine.length} open${late ? `, ${late} overdue` : ""}.`,
      next ? `Next: ${next.name}, ${daysFrom(today, next.date) === 0 ? "today" : `in ${daysFrom(today, next.date)} days`}.` : "",
    ];
    send(userId, "digest", parts.filter(Boolean).join(" "), "home", `digest:${today}`);
  }

  /** The timed checks. Safe to run as often as you like: each notice goes out once. */
  function tick(now = new Date()) {
    const today = localDate(now);
    for (const i of store.list("issues")) {
      if (i.status === "done" || !i.due) continue;
      const d = daysFrom(today, i.due);
      if (d < 0 || d > 2) continue;
      const when = d === 0 ? "today" : d === 1 ? "tomorrow" : "in 2 days";
      for (const u of i.who) send(u, "due", `FTC-${i.id} ${i.title} is due ${when}`, `issues/${i.id}`, `due:${i.id}:${i.due}`);
    }
    if (now.getDay() === 0) for (const u of users()) digest(u.id, today, now.getTime());
    q.prune.run(now.getTime() - KEEP_MS);
  }

  return {
    prefs, send, changed, tick, handles, mentions,
    /** Newest first: up to limit direct notices, then up to limit team ones. */
    list(userId, limit = 100) {
      const rows = [...q.list.all(userId, 0, limit), ...q.list.all(userId, 1, limit)];
      return rows.sort((a, b) => b.id - a.id).map((n) => ({ ...n, read: !!n.read, sub: n.sub ?? undefined }));
    },
    markRead(userId, ids) {
      const at = Date.now();
      if (ids === "all") return q.readAll.run(at, userId).changes;
      let n = 0;
      for (const id of ids) n += q.read.run(at, userId, id).changes;
      return n;
    },
  };
}
