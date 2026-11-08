/* The score sheet for each season. A logged run names its sheet, so older runs keep scoring correctly after a new
   season is added here. The browser loads this as a script; the server imports it for its side effect.
   Point values and thresholds come from the Competition Manual, tables 10-2, 10-3 and 10-4. Ranking point targets
   are the ones for regular events: Regional and FIRST Championship targets are announced in Team Updates. */
(function () {
  const SCORING_ELEMENTS = 56;
  const MAX_DRIVERS = 3;

  const SHEETS = {
    biobuzz: {
      name: "BIOBUZZ",
      season: "2026–27",
      items: [
        { key: "leave", label: "LEAVE", hint: "Robots off the wall", phase: "auto", points: 3, max: 2 },
        { key: "parkAuto", label: "PARK", hint: "Robots in the loading zone", phase: "auto", points: 5, max: 2 },
        { key: "tipAuto", label: "HIVE TIP", hint: "Done before TeleOp", phase: "auto", points: 20, max: 99 },
        { key: "tipTele", label: "HIVE TIP", hint: "During TeleOp", phase: "teleop", points: 20, max: 99 },
        { key: "cell", label: "Left in CELL", hint: "Upward-facing, at the end", phase: "teleop", points: 2, max: SCORING_ELEMENTS },
        { key: "flower", label: "In owned FLOWER", hint: "POLLEN and NECTAR", phase: "teleop", points: 2, max: SCORING_ELEMENTS },
        { key: "bottom", label: "Bottom NECTAR", hint: "FLOWERS with the bonus", phase: "teleop", points: 5, max: 4 },
        { key: "garden", label: "In GARDEN", hint: "POLLEN and NECTAR", phase: "teleop", points: 1, max: SCORING_ELEMENTS },
        { key: "parkEnd", label: "PARK", hint: "Robots in the loading zone", phase: "teleop", points: 5, max: 2 },
      ],
      fouls: [
        { key: "minor", label: "Minor fouls", hint: "5 points to the opponent", credit: 5, max: 50 },
        { key: "major", label: "Major fouls", hint: "20 points to the opponent", credit: 20, max: 50 },
      ],
      rankingPoints: [
        { key: "swarm", label: "SWARM", counts: ["leave", "parkAuto", "parkEnd"], measure: "points", target: 16, unit: "points", note: "An alliance total: one robot can reach 13." },
        { key: "pollinator1", label: "POLLINATOR 1", counts: ["tipAuto", "tipTele"], measure: "count", target: 4, unit: "tips" },
        { key: "pollinator2", label: "POLLINATOR 2", counts: ["tipAuto", "tipTele"], measure: "count", target: 7, unit: "tips" },
      ],
      tips: ["tipAuto", "tipTele"],
      resultPoints: { win: 3, tie: 1 },
    },
  };

  const KINDS = { full: "Full run", auto: "Auto only", scrimmage: "Scrimmage", match: "Competition match" };
  const FAILS = {
    auto: { label: "Auto missed", sub: "auto" },
    jam: { label: "Mechanism jammed", sub: "team" },
    broke: { label: "Something broke", sub: "team" },
    power: { label: "Brownout", sub: "electronics" },
    comms: { label: "Lost connection", sub: "electronics" },
    crash: { label: "Code crash", sub: "teleop" },
    driver: { label: "Driver error", sub: "team" },
    foul: { label: "Foul", sub: "team" },
    other: { label: "Something else", sub: "team" },
  };
  const hasResult = (kind) => kind === "scrimmage" || kind === "match";

  function tally(run) {
    if (!Object.hasOwn(SHEETS, run.sheet)) return null;
    const sheet = SHEETS[run.sheet];
    if (!sheet || !run.counts) return null;
    const count = (key) => run.counts[key] ?? 0;
    const pointsFor = (keys) => sheet.items.filter((item) => keys.includes(item.key)).reduce((sum, item) => sum + count(item.key) * item.points, 0);
    const phasePoints = (phase) => pointsFor(sheet.items.filter((item) => item.phase === phase).map((item) => item.key));
    const auto = phasePoints("auto"), teleop = phasePoints("teleop");
    const rankingPoints = sheet.rankingPoints.map((rp) => {
      const value = rp.measure === "points" ? pointsFor(rp.counts) : rp.counts.reduce((sum, key) => sum + count(key), 0);
      return { ...rp, value, hit: value >= rp.target };
    });
    return {
      sheet, auto, teleop, total: auto + teleop, rankingPoints,
      tips: sheet.tips.reduce((sum, key) => sum + count(key), 0),
      given: sheet.fouls.reduce((sum, foul) => sum + count(foul.key) * foul.credit, 0),
      rp: rankingPoints.filter((rp) => rp.hit).length + (sheet.resultPoints[run.result] ?? 0),
    };
  }

  globalThis.Scoring = { CURRENT: "biobuzz", MAX_DRIVERS, SHEETS, KINDS, FAILS, hasResult, tally };
})();
