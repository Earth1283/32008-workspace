import { test } from "node:test";
import assert from "node:assert/strict";
import "../public/scoring.js";

const { Scoring } = globalThis;
const run = (counts, extra = {}) => ({ sheet: "biobuzz", kind: "full", counts, ...extra });

test("points follow the manual's table", () => {
  const score = Scoring.tally(run({ leave: 2, parkAuto: 1, tipAuto: 2, tipTele: 1, cell: 3, bottom: 1, flower: 4, garden: 5, parkEnd: 2 }));
  assert.equal(score.auto, 2 * 3 + 5 + 2 * 20);
  assert.equal(score.teleop, 20 + 3 * 2 + 5 + 4 * 2 + 5 + 2 * 5);
  assert.equal(score.total, score.auto + score.teleop);
  assert.equal(score.tips, 3);
});

test("ranking points use the thresholds for regular events", () => {
  const rp = (counts) => Object.fromEntries(Scoring.tally(run(counts)).rankingPoints.map((x) => [x.key, x.hit]));
  assert.deepEqual(rp({ leave: 1, parkAuto: 1, parkEnd: 1, tipAuto: 3 }), { swarm: false, pollinator1: false, pollinator2: false });
  assert.deepEqual(rp({ leave: 2, parkAuto: 2, tipAuto: 1, tipTele: 3 }), { swarm: true, pollinator1: true, pollinator2: false });
  assert.deepEqual(rp({ tipTele: 7 }).pollinator2, true);
});

test("a win adds 3 ranking points, a tie 1, and fouls credit the opponent", () => {
  assert.equal(Scoring.tally(run({ tipTele: 4 }, { result: "win" })).rp, 4);
  assert.equal(Scoring.tally(run({}, { result: "tie" })).rp, 1);
  assert.equal(Scoring.tally(run({}, { result: "loss" })).rp, 0);
  assert.equal(Scoring.tally(run({ minor: 2, major: 1 })).given, 30);
});

test("runs from before the score sheet have no score", () => {
  assert.equal(Scoring.tally({ auto: 7, cycle: 30 }), null);
});
