"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const projection = require(path.resolve(__dirname, "../projection.js"));

const checkpoint = (date, fill = 20) => ({ date, fill, label: `${fill}%`, season: fill === 20 ? "winter" : "injection", shortDate: date });
const rows = (values) => Object.entries(values).map(([date, value]) => ({ date, value }));
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} should equal ${expected}`);

test("November 2 uses the previous November 2 delta on the current fill basis", () => {
  const result = projection.priorYearProjection(rows({
    "2025-11-01": 80, "2025-11-02": 79.5, "2025-11-03": 78.25,
    "2026-11-01": 61.17,
  }), "2026-11-01", checkpoint("2026-11-03"));
  assert.equal(result.complete, true);
  assert.equal(result.days, 2);
  assert.deepEqual(result.points.map((point) => point.date), ["2026-11-01", "2026-11-02", "2026-11-03"]);
  close(result.points[0].value, 61.17);
  close(result.points[1].value, 60.67);
  close(result.points[2].value, 59.42);
  close(result.projected, 59.42);
  assert.equal(result.met, true);
});

test("historical absolute storage levels do not affect the rebased course", () => {
  const run = (offset) => projection.priorYearProjection(rows({
    "2025-11-01": 60 + offset, "2025-11-02": 59 + offset, "2025-11-03": 56 + offset,
    "2026-11-01": 40,
  }), "2026-11-01", checkpoint("2026-11-03"));
  assert.deepEqual(run(0).points, run(20).points);
  assert.deepEqual(run(0).points.map((point) => point.value), [40, 39, 36]);
});

test("the course crosses New Year using consecutive prior-year calendar dates", () => {
  const result = projection.priorYearProjection(rows({
    "2025-12-31": 70, "2026-01-01": 69, "2026-01-02": 67,
    "2026-12-31": 60,
  }), "2026-12-31", checkpoint("2027-01-02"));
  assert.equal(result.complete, true);
  assert.deepEqual(result.points.map((point) => point.value), [60, 59, 57]);
});

test("a full winter includes every day through March 1 using March 1 of the prior year", () => {
  const historical = [];
  let index = 0;
  for (let day = "2025-11-01"; day <= "2026-03-01"; day = projection.addDays(day, 1)) {
    historical.push({ date: day, value: 80 - index * 0.25 + (index % 2) * 0.1 });
    index += 1;
  }
  const result = projection.priorYearProjection([...historical, { date: "2026-11-01", value: 61.17 }],
    "2026-11-01", projection.seasonalTarget("2026-11-01"));
  assert.equal(result.complete, true);
  assert.equal(result.points.length, 121);
  assert.equal(result.points.at(-1).date, "2027-03-01");
  close(result.points[1].value, 61.02);
  close(result.projected, 31.17);
  assert.notEqual(result.points[1].value - result.points[0].value,
    result.points[2].value - result.points[1].value, "daily variations survive into the predicted curve");
});

test("physical fill bounds apply after each daily change and allow later recovery", () => {
  for (const [basis, history, expected] of [
    [2, [80, 75, 76], [2, 0, 1]],
    [99, [70, 75, 73], [99, 100, 98]],
  ]) {
    const result = projection.priorYearProjection(rows({
      "2025-11-01": history[0], "2025-11-02": history[1], "2025-11-03": history[2],
      "2026-11-01": basis,
    }), "2026-11-01", checkpoint("2026-11-03"));
    assert.deepEqual(result.points.map((point) => point.value), expected);
  }
});

test("missing historical dates make the course unavailable rather than filling gaps with a trend", () => {
  const result = projection.priorYearProjection(rows({
    "2025-11-01": 80, "2025-11-03": 78, "2026-11-01": 61.17,
  }), "2026-11-01", checkpoint("2026-11-04"));
  assert.equal(result.complete, false);
  assert.equal(result.projected, null);
  assert.equal(result.met, null);
  assert.equal(result.shortfall, null);
  assert.deepEqual(result.missingDates, ["2025-11-02", "2025-11-04"]);
  assert.deepEqual(result.points, [{ date: "2026-11-01", value: 61.17 }]);
  close(result.requiredRate, (20 - 61.17) / 3);
});

test("leap-day mapping preserves the calendar-aligned reference interval", () => {
  assert.equal(projection.previousYearDate("2028-02-29"), "2027-02-28");
  const leapCurrent = projection.priorYearProjection(rows({
    "2027-02-28": 40, "2027-03-01": 37, "2028-02-28": 60,
  }), "2028-02-28", checkpoint("2028-03-01"));
  assert.deepEqual(leapCurrent.points.map((point) => point.value), [60, 60, 57]);
  const leapReference = projection.priorYearProjection(rows({
    "2028-02-28": 40, "2028-02-29": 39, "2028-03-01": 37, "2029-02-28": 60,
  }), "2029-02-28", checkpoint("2029-03-01"));
  assert.deepEqual(leapReference.points.map((point) => point.value), [60, 57],
    "March 1 includes the historical leap day that has no current-year calendar date");
});

test("same-day and elapsed checkpoints need no previous-year history or extra day", () => {
  for (const targetDate of ["2026-11-01", "2026-10-31"]) {
    const result = projection.priorYearProjection([{ date: "2026-11-01", value: 61.17 }],
      "2026-11-01", checkpoint(targetDate));
    assert.equal(result.complete, true);
    assert.equal(result.days, 0);
    assert.equal(result.projected, 61.17);
    assert.equal(result.requiredRate, null);
    assert.deepEqual(result.points, [{ date: "2026-11-01", value: 61.17 }]);
  }
});
