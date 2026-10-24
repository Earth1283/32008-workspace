export class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}
const bad = (m) => new HttpError(400, m);

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (s) => DATE.test(s) && !Number.isNaN(Date.parse(s + "T00:00:00Z"));

export const SUBS = ["drive", "intake", "lift", "vision", "electronics", "auto", "teleop", "notebook", "outreach", "team"];
export const SUB_NAMES = {
  drive: "Drivetrain", intake: "Intake", lift: "Lift", vision: "Vision", electronics: "Electronics",
  auto: "Autonomous", teleop: "TeleOp", notebook: "Notebook", outreach: "Outreach", team: "Team",
};
export const ACCESS = ["Admin", "Member", "Mentor", "Viewer"];

/* Field rules: t = type, plus req / max / min / values / def / of. */
const str = (max, req = false) => ({ t: "str", max, req });
const date = (req = false) => ({ t: "date", req });
const int = (min, max, req = false, def) => ({ t: "int", min, max, req, def });
const num = (min, max, req = false, def) => ({ t: "num", min, max, req, def });
const bool = (def = false) => ({ t: "bool", def });
const oneOf = (values, def) => ({ t: "enum", values, def });
const strs = (n, max = 64, min = 0) => ({ t: "strs", n, max, min });
const list = (n, of) => ({ t: "list", n, of });

export const SPECS = {
  issues: {
    title: str(200, true),
    type: oneOf(["build", "code", "cad", "notebook", "outreach", "parts", "other"], "build"),
    sub: oneOf(SUBS, "team"),
    pri: oneOf(["high", "med", "low"], "med"),
    status: oneOf(["todo", "doing", "review", "blocked", "done"], "todo"),
    who: strs(10, 64, 1),
    created: date(true),
    due: date(),
    desc: str(5000),
    blockedBy: str(1000),
    branch: str(200),
    pr: int(0, 1_000_000),
    merged: bool(),
    prState: oneOf(["none", "draft", "open", "merged", "closed"], "none"),
    logged: bool(),
    notes: list(300, { who: str(64, true), text: str(2000, true), date: date(true) }),
  },
  notebook: {
    date: date(true),
    title: str(200, true),
    issue: int(0, 1_000_000),
    author: str(64),
    status: oneOf(["draft", "final"], "draft"),
    problem: str(5000), tried: str(5000), result: str(5000), next: str(5000),
  },
  practice: {
    date: date(true),
    driver: str(64),
    auto: int(0, 10, true),
    cycle: num(1, 600, true),
    note: str(1000),
  },
  meetings: {
    date: date(true),
    title: str(200, true),
    who: strs(40),
    agenda: { ...strs(50, 300) },
    notes: str(20000),
    actions: list(50, { id: str(40, true), text: str(500, true), who: str(64), issue: int(0, 1_000_000) }),
  },
  parts: {
    name: str(200, true),
    sub: oneOf(SUBS, "team"),
    have: int(0, 100_000, false, 0),
    need: int(0, 100_000, false, 1),
    ordered: int(0, 100_000, false, 0),
    price: num(0, 1_000_000, false, 0),
    vendor: str(100),
  },
  milestones: { name: str(100, true), date: date(true), main: bool() },
  phases: { name: str(100, true), start: date(true), end: date(true) },
  people: { name: str(60, true), role: str(80), hue: int(0, 359, false, 0), gh: str(39) },
  team: { num: str(12, true), name: str(60, true), short: str(8), season: str(20), logo: str(400_000) },
  settings: { budget: num(0, 10_000_000, false, 0), branchPrefix: str(20), repo: str(100), autoPr: bool(true), ai: bool(true) },
  /* Each person's own notification choices. */
  prefs: { due: bool(true), blocked: bool(true), mention: bool(true), pr: bool(true), digest: bool(false), follow: strs(SUBS.length, 20) },
};

function one(k, r, v) {
  const empty = v === undefined || v === null || v === "";
  switch (r.t) {
    case "str": {
      if (empty) { if (r.req) throw bad(`${k} is required`); return ""; }
      if (typeof v !== "string") throw bad(`${k} must be text`);
      if (r.req && !v.trim()) throw bad(`${k} is required`);
      if (v.length > r.max) throw bad(`${k} is too long`);
      return r.req ? v.trim() : v;
    }
    case "date": {
      if (empty) { if (r.req) throw bad(`${k} is required`); return undefined; }
      if (typeof v !== "string" || !validDate(v)) throw bad(`${k} must be a date (YYYY-MM-DD)`);
      return v;
    }
    case "int":
    case "num": {
      if (empty) { if (r.req) throw bad(`${k} is required`); return r.def; }
      if (typeof v !== "number" || !Number.isFinite(v) || (r.t === "int" && !Number.isInteger(v))) throw bad(`${k} must be a number`);
      if (v < r.min || v > r.max) throw bad(`${k} is out of range`);
      return v;
    }
    case "bool": return v === undefined || v === null ? r.def : v === true;
    case "enum": {
      if (empty) { if (r.def !== undefined) return r.def; throw bad(`${k} is required`); }
      if (!r.values.includes(v)) throw bad(`${k} is not a valid choice`);
      return v;
    }
    case "strs": {
      if (empty) { if (r.min) throw bad(`${k} needs at least ${r.min}`); return []; }
      if (!Array.isArray(v) || v.length > r.n) throw bad(`${k} must be a short list`);
      if (v.length < r.min) throw bad(`${k} needs at least ${r.min}`);
      return v.map((s) => {
        if (typeof s !== "string" || s.length > r.max) throw bad(`${k} has an invalid entry`);
        return s;
      });
    }
    case "list": {
      if (empty) return [];
      if (!Array.isArray(v) || v.length > r.n) throw bad(`${k} has too many entries`);
      return v.map((item) => clean(r.of, item));
    }
    default: throw new Error("unknown rule " + r.t);
  }
}

/** Build a new object holding only the fields in spec, each checked. */
export function clean(spec, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw bad("Expected an object");
  const out = {};
  for (const [k, r] of Object.entries(spec)) {
    const v = one(k, r, input[k]);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

export const USERNAME = /^[a-z0-9][a-z0-9._-]{1,31}$/i;
export const GH_LOGIN = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;
export const GH_REPO = /^[\w.-]+\/[\w.-]+$/;
export const isDate = validDate;
