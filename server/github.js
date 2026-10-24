/* GitHub sync: reads the repo's pull requests on a timer and links each one to its issue. No webhook, so it
   works on a server the internet can't reach. Uses the REST API with an optional token (needed for private repos). */
import { tx } from "./db.js";
import { SPECS, clean } from "./validate.js";

const API = "https://api.github.com";
const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const stateOf = (p) => (p.merged_at ? "merged" : p.state === "closed" ? "closed" : p.draft ? "draft" : "open");
const RANK = { open: 3, draft: 2, merged: 1, closed: 0 };

function problem(res, hasToken) {
  if (res.status === 401) return "GitHub rejected the token. Check it hasn't expired.";
  if (res.status === 404) return hasToken ? "Repository not found, or the token can't see it." : "Repository not found. If it's private, add a token.";
  if ((res.status === 403 || res.status === 429) && res.headers.get("x-ratelimit-remaining") === "0") return "GitHub's rate limit was reached. Adding a token raises it.";
  return `GitHub answered with an error (${res.status}).`;
}

export function makeGithub({ db, store, notifier, broadcast, fetch = globalThis.fetch, api = API }) {
  let etag = null, etagFor = null, running = null;

  function setStatus(s) {
    const prev = store.meta("githubStatus", {});
    const next = { at: Date.now(), ok: s.ok, error: s.error ?? "" };
    store.setMeta("githubStatus", next);
    if (prev.ok !== next.ok || prev.error !== next.error) broadcast("meta");
    return next;
  }

  /** Which issue a pull request belongs to: the suggested branch name first, then FTC-<n> in its title. */
  function issueFor(p, prefix) {
    const m = new RegExp(`(?:^|/)${reEscape(prefix)}-(\\d+)(?:-|$)`, "i").exec(p.head?.ref ?? "") || /\bFTC-(\d+)\b/i.exec(p.title ?? "");
    return m ? Number(m[1]) : null;
  }

  /** Copy PR state onto issues. Status only moves when the PR's state changes, so the team can still override it. */
  function apply(pulls, { branchPrefix, autoPr }) {
    const best = new Map();
    for (const p of pulls) {
      const id = issueFor(p, branchPrefix || "ftc");
      if (id === null) continue;
      const cur = best.get(id);
      if (!cur || RANK[stateOf(p)] > RANK[stateOf(cur)]) best.set(id, p); // newest first, so ties keep the newer
    }
    const changes = [];
    tx(db, () => {
      for (const [id, p] of best) {
        const i = store.get("issues", id);
        if (!i) continue;
        const { id: _i, rev: _r, ...was } = i;
        const st = stateOf(p);
        const next = { ...was, branch: p.head?.ref ?? was.branch, pr: p.number, merged: st === "merged", prState: st };
        const moved = i.pr !== p.number || (i.prState ?? "none") !== st;
        if (autoPr !== false && moved) {
          if (st === "merged" && i.status !== "done") next.status = "done";
          else if (st === "open" && (i.status === "todo" || i.status === "doing")) next.status = "review";
        }
        const doc = clean(SPECS.issues, next);
        if (JSON.stringify(doc) === JSON.stringify(clean(SPECS.issues, was))) continue;
        store.put("issues", id, doc, "github");
        changes.push([i, store.get("issues", id)]);
      }
    });
    if (changes.length) broadcast("issues");
    for (const [before, after] of changes) {
      try { notifier.changed("issues", before, after, "github"); } catch (e) { console.error(e); }
    }
    return best;
  }

  function reviews(pulls, linked) {
    const byLogin = new Map(store.list("people").filter((p) => p.gh).map((p) => [p.gh.toLowerCase(), p.id]));
    for (const p of pulls) {
      if (p.state !== "open") continue;
      const issue = [...linked].find(([, x]) => x.number === p.number)?.[0];
      const link = issue ? `issues/${issue}` : /^https:\/\/github\.com\//.test(p.html_url ?? "") ? p.html_url : null;
      for (const r of p.requested_reviewers ?? []) {
        const u = byLogin.get(String(r.login).toLowerCase());
        if (u) notifier.send(u, "pr", `Review requested on PR #${p.number}: ${p.title}`, link, `pr:${p.number}:${u}`);
      }
    }
  }

  async function run() {
    const settings = store.meta("settings", {});
    if (!settings.repo) return null;
    const { token = "" } = store.meta("github", {});
    const key = settings.repo + "\n" + token + "\n" + settings.branchPrefix;
    if (etagFor !== key) { etag = null; etagFor = key; }
    const headers = { Accept: "application/vnd.github+json", "User-Agent": "008-workspace", "X-GitHub-Api-Version": "2022-11-28" };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (etag) headers["If-None-Match"] = etag;
    let res;
    try {
      res = await fetch(`${api}/repos/${settings.repo}/pulls?state=all&sort=updated&direction=desc&per_page=50`, { headers, signal: AbortSignal.timeout(15_000) });
    } catch {
      return setStatus({ ok: false, error: "Couldn't reach GitHub." });
    }
    if (res.status === 304) return setStatus({ ok: true });
    if (!res.ok) return setStatus({ ok: false, error: problem(res, !!token) });
    let pulls;
    try { pulls = await res.json(); } catch { return setStatus({ ok: false, error: "GitHub sent something unexpected." }); }
    if (!Array.isArray(pulls)) return setStatus({ ok: false, error: "GitHub sent something unexpected." });
    const linked = apply(pulls, settings);
    reviews(pulls, linked);
    etag = res.headers.get("etag");
    return setStatus({ ok: true });
  }

  return {
    /** Check GitHub now. Overlapping calls share one run. */
    sync() {
      if (!running) running = run().finally(() => { running = null; });
      return running;
    },
    idle: () => (running ? running.catch(() => {}) : Promise.resolve()),
    forget() { etag = null; etagFor = null; },
  };
}
