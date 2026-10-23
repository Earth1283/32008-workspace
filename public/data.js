/* Static configuration and helpers. Everything else comes from the server. */
(function () {
  const toDate = (s) => new Date(s + "T00:00:00");
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

  const F = {
    team: { num: "", short: "", name: "", season: "", logo: null },
    today: iso(new Date()),
    me: null,
    budget: 0,

    people: [], milestones: [], phases: [], issues: [], parts: [], practice: [], meetings: [], notebook: [],

    subs: {
      drive: "Drivetrain", intake: "Intake", lift: "Lift", vision: "Vision",
      electronics: "Electronics", auto: "Autonomous", teleop: "TeleOp",
      notebook: "Notebook", outreach: "Outreach", team: "Team",
    },
    robotSubs: ["drive", "intake", "lift", "vision", "electronics", "auto", "teleop"],
    status: { todo: "To do", doing: "In progress", review: "In review", blocked: "Blocked", done: "Done" },
    statusOrder: ["doing", "review", "blocked", "todo", "done"],
    pri: { high: "High", med: "Medium", low: "Low" },
  };

  F.person = (id) => F.people.find((p) => p.id === id) || { id, name: "?", role: "", hue: 0 };
  F.days = (s) => Math.round((toDate(s) - toDate(F.today)) / 864e5);
  F.fmt = (s) => toDate(s).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  F.parse = toDate;
  F.iso = iso;
  window.FTC = F;
})();
