import { createHash } from "node:crypto";
import { HttpError } from "./validate.js";

export const SOURCES = {
  ftcscout: { name: "FTCScout", url: "https://ftcscout.org" },
  first: { name: "FIRST Events", url: "https://ftc-events.firstinspires.org/services/API" },
  toa: { name: "The Orange Alliance", url: "https://theorangealliance.org" },
  venue: { name: "Venue scorekeeper", url: "https://github.com/FIRST-Tech-Challenge/scorekeeper/wiki/API-Documentation" },
};
const text = (v, max = 200) => String(v ?? "").slice(0, max);
const number = (v) => v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v);
const score = (v) => number(v) !== null && number(v) >= 0 ? number(v) : null;
const array = (v, ...keys) => {
  for (const k of keys) if (Array.isArray(v?.[k])) return v[k];
  return Array.isArray(v) ? v : [];
};
const requiredArray = (v, ...keys) => {
  if (Array.isArray(v) || keys.some((k) => Array.isArray(v?.[k]))) return array(v, ...keys);
  throw new HttpError(400, "Source returned an unexpected list format");
};
const codePart = (v) => {
  if (typeof v !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(v)) throw new HttpError(400, "Enter a valid event code");
  return v;
};
const seasonNumber = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 2015 || n > 2100) throw new HttpError(400, "Season must be its starting year, for example 2026");
  return n;
};

/** Providers stay separate: their rankings and OPR definitions are not interchangeable. */
export function makeScouting({ store, fetch: fetcher = globalThis.fetch, config = {}, now = Date.now }) {
  const pending = new Map(), searches = new Map(), recent = new Map();
  let generation = 0;
  const settings = () => ({ ...config, ...store.meta("scoutingConfig", {}) });
  const status = () => {
    const c = settings();
    return Object.entries(SOURCES).map(([id, s]) => ({ id, ...s,
      ready: id === "ftcscout" || (id === "first" ? !!(c.firstUsername && c.firstToken) : id === "toa" ? !!c.toaKey : !!c.venueUrl),
    }));
  };
  function configure(body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "Invalid source settings");
    const saved = { ...store.meta("scoutingConfig", {}) };
    for (const key of ["firstUsername", "firstToken", "toaKey", "venueUrl", "venueKey"]) {
      if (!(key in body)) continue;
      if (typeof body[key] !== "string" || body[key].length > 500) throw new HttpError(400, "Invalid source setting");
      saved[key] = body[key].trim();
      if (key === "venueUrl" && saved[key]) {
        let u;
        try { u = new URL(saved[key]); } catch { throw new HttpError(400, "Enter the scorekeeper's http or https address"); }
        if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || u.search || u.hash || u.hostname === "169.254.169.254") throw new HttpError(400, "Invalid scorekeeper address");
        saved[key] = u.href.replace(/\/$/, "");
      }
    }
    generation++;
    store.setMeta("scoutingConfig", saved);
    searches.clear(); recent.clear();
    return status();
  }
  function source(id) {
    if (!Object.hasOwn(SOURCES, id)) throw new HttpError(400, "Unknown scouting source");
    if (!status().find((s) => s.id === id).ready) throw new HttpError(400, `Configure ${SOURCES[id].name} in Scouting, Sources first`);
  }
  async function request(id, path, body) {
    const c = settings();
    const base = { ftcscout: "https://api.ftcscout.org", first: "https://ftc-api.firstinspires.org/v2.0", toa: "https://theorangealliance.org/api", venue: c.venueUrl }[id];
    const headers = { Accept: "application/json", "User-Agent": "008-workspace scouting" };
    if (id === "first") headers.Authorization = "Basic " + Buffer.from(`${c.firstUsername}:${c.firstToken}`).toString("base64");
    if (id === "toa") { headers["X-TOA-Key"] = c.toaKey; headers["X-Application-Origin"] = "008-workspace"; headers["Content-Type"] = "application/json"; }
    if (id === "venue" && c.venueKey) headers.Authorization = "Bearer " + c.venueKey;
    if (body) headers["Content-Type"] = "application/json";
    try {
      const r = await fetcher(base + path, { headers, method: body ? "POST" : "GET", ...(body ? { body: JSON.stringify(body) } : {}), redirect: "error", signal: AbortSignal.timeout(8_000) });
      if (!r.ok) throw new Error(r.status === 401 || r.status === 403 ? "Access refused; check the source credentials" : `Source returned HTTP ${r.status}`);
      // Bound memory even if a provider sends an unexpectedly large response.
      const reader = r.body.getReader(), chunks = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 8_000_000) throw new Error("Source response is too large");
          chunks.push(Buffer.from(value));
        }
      } finally { await reader.cancel().catch(() => {}); }
      const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (data?.errors?.length || data?._code >= 400) throw new Error("Source could not provide this data");
      return data;
    } catch (e) {
      // Never expose upstream URLs, headers or bodies: these may contain credentials.
      const message = /^(Access refused|Source returned HTTP|Source response|Source could not)/.test(e.message) ? e.message : "Source unavailable or timed out";
      throw new HttpError(400, `${SOURCES[id].name}: ${message}`);
    }
  }
  const requestList = async (id, path, ...keys) => requiredArray(await request(id, path), ...keys);
  const event = (id, season, e) => ({
    source: id, season, key: text(e.code ?? e.event_key ?? e.eventCode, 80),
    name: text(e.name ?? e.event_name ?? e.eventName),
    start: text(e.start ?? e.dateStart ?? e.start_date, 10), end: text(e.end ?? e.dateEnd ?? e.end_date, 10),
    location: [e.city, e.state ?? e.stateprov ?? e.state_prov, e.country].filter(Boolean).join(", ").slice(0, 250),
  });
  async function search(id, year, query = "", team = "") {
    source(id);
    const season = seasonNumber(year), q = text(query, 100).trim();
    if (team && !/^\d{1,6}$/.test(team)) throw new HttpError(400, "Enter a team number");
    const key = JSON.stringify([generation, id, season, q, team]);
    if (searches.get(key)?.until > now()) return searches.get(key).value;
    return single("search:" + key, async () => {
      let data;
      if (id === "ftcscout") {
        if (team) {
          const g = await request(id, "/graphql", { query: `{ teamByNumber(number:${Number(team)}) { events(season:${season}) { event { code name start end location { city state country } } } } }` });
          data = array(g?.data?.teamByNumber?.events).map((x) => ({ ...x.event, ...x.event?.location }));
        } else data = await requestList(id, `/rest/v1/events/search/${season}?searchText=${encodeURIComponent(q)}&limit=50`);
      } else if (id === "first") data = await requestList(id, `/${season}/events${team ? "?teamNumber=" + team : ""}`, "events", "Events");
      else if (id === "toa") data = await requestList(id, `/event/?season_key=${String(season).slice(2)}${String(season + 1).slice(2)}`);
      else {
        const listing = await request(id, "/api/v1/events/");
        if (Array.isArray(listing?.eventCodes)) {
          // FTC Live lists codes here; names come from each event's metadata endpoint.
          const codes = listing.eventCodes.filter((v) => typeof v === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(v));
          const matchingCodes = q ? codes.filter((v) => v.toLowerCase().includes(q.toLowerCase())) : [];
          const chosen = (matchingCodes.length ? matchingCodes : codes).slice(0, 20);
          data = [];
          for (let i = 0; i < chosen.length; i += 4) {
            const batch = await Promise.all(chosen.slice(i, i + 4).map(async (code) => ({ ...(await request(id, `/api/v1/events/${code}/`)), code })));
            data.push(...batch);
          }
        } else data = requiredArray(listing, "events", "eventList");
      }
      const value = array(data).map((e) => event(id, season, e)).filter((e) => e.key && (!q || `${e.key} ${e.name} ${e.location}`.toLowerCase().includes(q.toLowerCase()))).slice(0, 100);
      if (searches.size >= 100) searches.delete(searches.keys().next().value);
      searches.set(key, { value, until: now() + 60_000 });
      return value;
    });
  }
  function single(key, fn) {
    if (pending.has(key)) return pending.get(key);
    if (pending.size >= 6) throw new HttpError(429, "Scouting sources are busy; try again shortly");
    const p = Promise.resolve().then(fn).finally(() => pending.delete(key));
    pending.set(key, p);
    return p;
  }
  async function sync(id, year, key, who) {
    source(id);
    const season = seasonNumber(year), code = codePart(key);
    const docId = createHash("sha256").update(JSON.stringify([id, season, code])).digest("hex").slice(0, 24);
    const cacheKey = `${generation}:${docId}`;
    if (recent.get(cacheKey) > now() - 30_000) return store.get("scoutEvents", docId);
    return single("sync:" + cacheKey, async () => {
      const warnings = [], old = store.get("scoutEvents", docId), sectionAt = {}, failed = [];
      async function section(name, fn) {
        try { const data = await fn(); sectionAt[name] = new Date(now()).toISOString(); return data; }
        catch (e) { warnings.push(`${name}: ${e.message}. ${old ? "Previous data kept where available." : "No data saved for this section."}`); failed.push(name); return null; }
      }
      let info, teams, rankings, matches;
      if (id === "ftcscout") {
        const root = `/rest/v1/events/${season}/${code}`;
        info = await request(id, root);
        [teams, matches] = await Promise.all([
          section("teams", () => requestList(id, root + "/teams")), section("matches", () => requestList(id, root + "/matches")),
        ]);
        rankings = teams;
        // Fetch all team names in one query, instead of a request for every team.
        const names = await section("names", () => request(id, "/graphql", { query: `{ eventByCode(season:${season}, code:${JSON.stringify(code)}) { teams { teamNumber team { name } } } }` }));
        const byNum = new Map(array(names?.data?.eventByCode?.teams).map((t) => [t.teamNumber, t.team?.name]));
        teams = teams === null ? null : array(teams).map((t) => ({ number: t.teamNumber, name: byNum.get(t.teamNumber), ...stats(t.stats) }));
        matches = matches === null ? null : array(matches).map((m) => match(m.id, `${m.tournamentLevel} ${m.series ? m.series + "-" : ""}${m.tournamentLevel === "Quals" ? m.id : m.id % 1000}`, m.scheduledStartTime,
          array(m.teams).filter((t) => t.alliance === "Red").map((t) => t.teamNumber), array(m.teams).filter((t) => t.alliance === "Blue").map((t) => t.teamNumber),
          m.hasBeenPlayed ? m.scores?.red?.totalPoints : null, m.hasBeenPlayed ? m.scores?.blue?.totalPoints : null));
      } else if (id === "first") {
        const ev = await request(id, `/${season}/events?eventCode=${code}`);
        info = array(ev, "events", "Events")[0];
        if (!info) throw new HttpError(400, "FIRST Events: Event not found");
        [teams, rankings, matches] = await Promise.all([
          section("teams", async () => {
            const all = [];
            for (let page = 1; page <= 20; page++) {
              const r = await request(id, `/${season}/teams?eventCode=${code}&page=${page}`);
              all.push(...requiredArray(r, "teams", "Teams"));
              if (page >= (r.pageTotal ?? 1)) break;
              if (page === 20) warnings.push("Teams: source has more than 20 pages; roster is incomplete.");
            }
            return all;
          }),
          section("rankings", () => requestList(id, `/${season}/rankings/${code}`, "Rankings", "rankings")),
          section("matches", () => requestList(id, `/${season}/matches/${code}`, "matches", "Matches")),
        ]);
        const ranks = new Map(array(rankings, "Rankings", "rankings").map((r) => [r.teamNumber, r]));
        teams = teams === null ? null : array(teams).map((t) => ({ number: t.teamNumber, name: t.nameShort ?? t.nameFull, ...stats(ranks.get(t.teamNumber)) }));
        matches = matches === null ? null : array(matches, "matches", "Matches").map((m) => match(`${m.tournamentLevel}-${m.series}-${m.matchNumber}`, m.description || `${m.tournamentLevel} ${m.matchNumber}`, m.startTime,
          array(m.teams).filter((t) => /^Red/.test(t.station)).map((t) => t.teamNumber), array(m.teams).filter((t) => /^Blue/.test(t.station)).map((t) => t.teamNumber), m.scoreRedFinal, m.scoreBlueFinal));
      } else if (id === "toa") {
        const root = `/event/${code}`;
        info = array(await request(id, root))[0];
        if (!info) throw new HttpError(400, "The Orange Alliance: Event not found");
        [teams, rankings, matches] = await Promise.all([section("teams", () => requestList(id, root + "/teams")), section("rankings", () => requestList(id, root + "/rankings")), section("matches", () => requestList(id, root + "/matches"))]);
        const ranks = new Map(array(rankings).map((r) => [Number(r.team_key ?? r.team_number), r]));
        teams = teams === null ? null : array(teams).map((t) => ({ number: Number(t.team_key ?? t.team_number), name: t.team?.team_name_short, ...stats(ranks.get(Number(t.team_key ?? t.team_number))) }));
        matches = matches === null ? null : array(matches).map((m) => match(m.match_key, m.match_name, m.scheduled_time,
          array(m.participants).filter((t) => /^R/.test(t.station)).map((t) => Number(t.team_key ?? t.team_number)), array(m.participants).filter((t) => /^B/.test(t.station)).map((t) => Number(t.team_key ?? t.team_number)), m.red_score, m.blue_score));
      } else {
        const r = await request(id, `/api/v2/events/${code}/full/`);
        info = r.event;
        if (!info) throw new HttpError(400, "Venue scorekeeper: Event not found or this version does not support the v2 full-event API");
        rankings = requiredArray(r.rankingsList, "rankingList");
        const ranks = new Map(rankings.map((r) => [r.team, r]));
        teams = requiredArray(r.teamList, "teams").map((t) => ({ number: t.number, name: t.name, ...stats(ranks.get(t.number)) }));
        matches = requiredArray(r.matchList, "matches").map((m) => {
          const b = m.matchBrief ?? m;
          return match(b.matchNumber, b.matchName, m.scheduledTime ? new Date(m.scheduledTime).toISOString() : "", [b.red?.team1, b.red?.team2], [b.blue?.team1, b.blue?.team2], b.finished ? m.redScore : null, b.finished ? m.blueScore : null);
        });
        sectionAt.teams = sectionAt.matches = sectionAt.rankings = new Date(now()).toISOString();
        warnings.push("Venue import includes qualification matches. Playoff formats vary by scorekeeper version.");
      }
      if (!info || typeof info !== "object") throw new HttpError(400, "Source returned no event details");
      const normalizedTeams = teams === null ? old?.teams ?? [] : teams.filter((t) => Number.isInteger(Number(t.number)) && Number(t.number) > 0).map((t) => {
        const before = old?.teams.find((o) => o.number === Number(t.number));
        const preserveStats = rankings === null || failed.includes("rankings");
        return { ...(preserveStats ? before : {}), ...t, ...(preserveStats && before ? Object.fromEntries(["rank", "wins", "losses", "ties", "played", "opr", "autoOpr", "dcOpr"].map((k) => [k, before[k] ?? null])) : {}), number: Number(t.number), name: text(t.name || before?.name, 200) };
      });
      const saved = { ...event(id, season, info), key: code, at: new Date(now()).toISOString(), sectionAt: { ...old?.sectionAt, ...sectionAt }, warnings, teams: normalizedTeams, matches: matches ?? old?.matches ?? [] };
      store.put("scoutEvents", docId, saved, who);
      if (recent.size >= 100) recent.delete(recent.keys().next().value);
      recent.set(cacheKey, now());
      return store.get("scoutEvents", docId);
    });
  }
  return { status, configure, search, sync, idle: () => Promise.allSettled([...pending.values()]) };
}

function stats(s) {
  return { rank: number(s?.rank ?? s?.ranking), wins: number(s?.wins), losses: number(s?.losses), ties: number(s?.ties), played: number(s?.qualMatchesPlayed ?? s?.matchesPlayed ?? s?.played),
    opr: number(s?.opr?.totalPointsNp ?? s?.np_opr ?? (typeof s?.opr === "number" ? s.opr : null)), autoOpr: number(s?.opr?.autoPoints), dcOpr: number(s?.opr?.dcPoints) };
}
function match(id, name, time, red, blue, redScore, blueScore) {
  return { id: text(id, 100), name: text(name, 100), time: text(time, 50), red: red.map(Number).filter((n) => Number.isInteger(n) && n > 0), blue: blue.map(Number).filter((n) => Number.isInteger(n) && n > 0), redScore: score(redScore), blueScore: score(blueScore) };
}
