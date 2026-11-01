"use strict";

// Run with: node --test scripts/test_seasonal_projection.js
// These checks use a fixed clock and in-memory data; production files are untouched.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const projection = require(path.join(ROOT, "projection.js"));

test("seasonal targets switch on March 1 and November 1, across years", () => {
  for (const [today, date, fill] of [
    ["2026-01-01", "2026-03-01", 20],
    ["2026-02-28", "2026-03-01", 20],
    ["2026-03-01", "2026-11-01", 80],
    ["2026-10-31", "2026-11-01", 80],
    ["2026-11-01", "2027-03-01", 20],
    ["2026-12-31", "2027-03-01", 20],
    ["2027-03-01", "2027-11-01", 80],
    ["2027-11-01", "2028-03-01", 20],
    ["2028-02-29", "2028-03-01", 20],
    ["2028-03-01", "2028-11-01", 80],
  ]) {
    const target = projection.seasonalTarget(today);
    assert.equal(target.date, date, today);
    assert.equal(target.fill, fill, today);
  }
});

test("the current Berlin calendar date controls the target", () => {
  assert.equal(projection.berlinDate(new Date("2026-10-31T22:59:59Z")), "2026-10-31");
  assert.equal(projection.berlinDate(new Date("2026-10-31T23:00:00Z")), "2026-11-01");
  assert.equal(projection.berlinDate(new Date("2026-02-28T23:00:00Z")), "2026-03-01");
  assert.equal(projection.berlinDate(new Date("2026-07-01T22:00:00Z")), "2026-07-02");
  const target = projection.seasonalTarget(
    projection.berlinDate(new Date("2026-10-31T23:00:00Z")),
  );
  const result = projection.project(61.17, -0.312, "2026-10-30", target);
  assert.equal(result.target.date, "2027-03-01");
  assert.equal(result.days, 122);
  assert.ok(Math.abs(result.projected - 23.106) < 1e-9);
  assert.equal(result.met, true, "lagging October observations still use the March reserve goal");
});

test("calendar arithmetic handles daylight-saving changes and leap days", () => {
  for (const [start, end, days] of [
    ["2026-03-28", "2026-03-30", 2],
    ["2026-10-24", "2026-10-26", 2],
    ["2027-11-01", "2028-03-01", 121],
    ["2028-02-28", "2028-03-01", 2],
    ["2026-10-30", "2027-03-01", 122],
  ]) {
    assert.equal(projection.daysBetweenDates(start, end), days);
    assert.equal(projection.addDays(start, days), end);
  }
  assert.equal(projection.addDays("2026-03-28", 1.1), "2026-03-30");
});

test("20 percent is a minimum: exact and greater reserves succeed", () => {
  const target = projection.seasonalTarget("2026-11-01");
  for (const [fill, rate, expected, met] of [
    [50, 0, 50, true],
    [50, -0.25, 20, true],
    [50, -0.3, 14, false],
    [20, 0, 20, true],
    [19.99, 0, 19.99, false],
  ]) {
    const result = projection.project(fill, rate, "2026-11-01", target);
    assert.ok(Math.abs(result.projected - expected) < 1e-9);
    assert.equal(result.met, met);
  }
  assert.equal(projection.project(50, 0, "2026-11-01", target).requiredRate, -0.25);
});

test("the summer filling goal uses the same minimum comparison", () => {
  const target = projection.seasonalTarget("2026-03-01");
  for (const [fill, met] of [[79.99, false], [80, true], [95, true]]) {
    assert.equal(projection.project(fill, 0, "2026-03-01", target).met, met);
  }
  assert.ok(projection.project(50, 0, "2026-03-01", target).requiredRate > 0);
});

test("a reached or elapsed target never invents another projection day", () => {
  const target = projection.seasonalTarget("2026-10-31");
  for (const day of ["2026-11-01", "2026-11-02"]) {
    const result = projection.project(61.17, 0.5, day, target);
    assert.equal(result.days, 0);
    assert.equal(result.projected, 61.17);
    assert.equal(result.requiredRate, null);
    assert.equal(result.met, false);
    assert.ok(Number.isFinite(result.shortfall));
  }
});

test("displayed projections stay within physical storage bounds", () => {
  const target = projection.seasonalTarget("2026-11-01");
  assert.equal(projection.project(50, 5, "2026-11-01", target).projected, 100);
  assert.equal(projection.project(50, -5, "2026-11-01", target).projected, 0);
  assert.equal(projection.clampFill(-1), 0);
  assert.equal(projection.clampFill(101), 100);
});

class FakeElement {
  constructor(id) {
    this.id = id;
    this.textContent = "";
    this.innerHTML = "";
    this.dataset = {};
    this.style = {};
    this.attributes = {};
    this.min = "-1.5";
    this.max = "1.642";
    this.value = "0";
    this.classList = { add() {}, remove() {}, toggle() {} };
  }
  addEventListener() {}
  setAttribute(name, value) { this.attributes[name] = String(value); }
  querySelector(selector) {
    this.children ??= new Map();
    if (!this.children.has(selector)) this.children.set(selector, new FakeElement(selector));
    return this.children.get(selector);
  }
  querySelectorAll() { return []; }
}

async function dashboardAt(timestamp, dataDate = "2026-10-30", options = {}) {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, new FakeElement(id));
    return elements.get(id);
  };
  let clock = new Date(timestamp).valueOf();
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock])); }
    static now() { return clock; }
  }
  const fill = options.fill ?? 50;
  const earlierFill = options.earlierFill ?? fill;
  const norm = options.norm === undefined ? 80 : options.norm ?? "";
  const archive = [
    "run_date_berlin,latest_data_date,current_fill_level_pct,minimum_threshold_pct,rate_avg_pct_per_day,optimistic_20pct_lower_withdrawal_rate_pct_per_day,smallest_withdrawal_rate_pct_per_day,average_withdrawal_rate_pct_per_day,largest_withdrawal_rate_pct_per_day,pessimistic_20pct_higher_withdrawal_rate_pct_per_day",
    `2026-11-01,${dataDate},${fill},20,0,0.2,0.1,0,-0.3,-1`,
  ].join("\n");
  const earlier = projection.addDays(dataDate, -30);
  const gie = ["scope,date,fill_pct,norm_5y_fill_pct,source"];
  for (const scope of ["EU", "DE"]) {
    gie.push(`${scope},${earlier},${earlierFill},${norm},GIE AGSI+ API v013`);
    gie.push(`${scope},${dataDate},${fill},${norm},GIE AGSI+ API v013`);
  }
  const errors = [];
  const events = [];
  const context = vm.createContext({
    Date: FixedDate, Intl, console: { error: (...args) => errors.push(args), warn() {}, log() {} },
    document: {
      getElementById: element,
      querySelector: element,
      querySelectorAll: () => [],
      addEventListener() {},
      visibilityState: "visible",
    },
    window: { setTimeout() {}, clearTimeout() {}, addEventListener() {}, dispatchEvent(event) { events.push(event); } },
    CustomEvent: class { constructor(type, details) { this.type = type; this.detail = details?.detail; } },
    navigator: {},
    setTimeout() {}, clearTimeout() {},
    fetch: async (url) => ({
      ok: true,
      text: async () => String(url).includes("gie_storage") ? gie.join("\n") : archive,
      json: async () => ({ technical_max_injection_gwh_per_day: 3936.52, technical_max_injection_pct_per_day: 1.642 }),
    }),
  });
  vm.runInContext(readFileSync(path.join(ROOT, "projection.js"), "utf8"), context);
  vm.runInContext(readFileSync(path.join(ROOT, "dashboard.js"), "utf8"), context);
  // The real startup awaits only the mocked fetch promises.
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(errors, [], "dashboard startup should finish without errors");
  return {
    context, element, events,
    state: vm.runInContext("state", context),
    setTime(timestamp) { clock = new Date(timestamp).valueOf(); },
  };
}

test("dashboard, scenarios, lab and copied summary share today's winter goal", async () => {
  const { context, element, state } = await dashboardAt("2026-10-31T23:00:00Z");
  assert.equal(state.deProjection.projected, 50);
  assert.equal(state.euProjection.projected, 50);
  assert.equal(element("de-projection-status").dataset.tone, "ok");
  assert.match(element("de-chart").innerHTML, /20%/);
  assert.match(element("de-chart").innerHTML, /01\.03\.2027|1\. März/);
  assert.match(element("scenario-list").innerHTML, /Erreicht:[\s\S]*20%/);
  assert.match(element("scenario-list").innerHTML, /Verfehlt:/);
  element("rate-slider").value = "-0.3";
  context.renderCustomScenario();
  assert.equal(element("custom-outcome").dataset.tone, "danger");
  assert.match(element("custom-detail").textContent, /13\.40%/);
  assert.match(element("custom-label").textContent, /20%/);
  element("rate-slider").value = "0";
  context.renderCustomScenario();
  assert.equal(element("custom-outcome").dataset.tone, "ok");
  const summary = context.buildLageSummary();
  assert.match(summary, /20%[\s\S]*01\.03\.2027/);
  assert.doesNotMatch(summary, /80%-Ziel|bis 1\. November/);
});

test("dashboard automatically returns to the November filling goal in March", async () => {
  const { context, element, state } = await dashboardAt("2027-02-28T23:00:00Z", "2027-02-27");
  assert.equal(state.deProjection.projected, 50);
  assert.equal(element("de-projection-status").dataset.tone, "warn");
  assert.match(element("de-chart").innerHTML, /80%/);
  assert.match(element("de-chart").innerHTML, /01\.11\.2027|1\. November/);
  assert.match(context.buildLageSummary(), /80%[\s\S]*01\.11\.2027/);
});

test("missing numeric data remains missing instead of becoming zero", async () => {
  const { context, element } = await dashboardAt("2026-11-01T12:00:00Z", "2026-10-30", { norm: null });
  for (const value of ["", " ", null, undefined]) assert.equal(context.number(value), null);
  assert.equal(context.number("0"), 0);
  assert.equal(element("de-norm-fill").textContent, "--");
  assert.equal(element("eu-norm-fill").textContent, "--");
  assert.match(element("de-norm-gap").textContent, /nicht verfügbar/);
  assert.doesNotMatch(element("de-chart").innerHTML, /NaN|Norm ≈0\.0%|Norm ≈59\.5%/);
});

test("already reached thresholds do not produce negative durations", async () => {
  const { context } = await dashboardAt("2026-11-01T12:00:00Z");
  for (const fill of [20, 14]) {
    const outcome = context.scenarioOutcome(fill, 20, -0.3, "2026-11-01");
    assert.match(outcome.title, /Schwelle erreicht/);
    assert.doesNotMatch(outcome.title, /-\d+ Tage/);
  }
  for (const fill of [95, 100]) {
    const outcome = context.scenarioOutcome(fill, 20, 0.3, "2026-11-01");
    assert.match(outcome.title, /95% erreicht/);
    assert.doesNotMatch(outcome.title, /-\d+ Tage/);
  }
});

test("trajectory, custom scenario and automatic scenarios clamp to the same physical bounds", async () => {
  for (const [earlierFill, expected, tone] of [[20, 100, "ok"], [80, 0, "danger"]]) {
    const { context, element, state } = await dashboardAt("2026-11-01T12:00:00Z", "2026-10-30", { earlierFill });
    assert.equal(state.deProjection.projected, expected);
    assert.equal(state.euProjection.projected, expected);
    element("rate-slider").value = String(state.deProjection.rate);
    context.renderCustomScenario();
    assert.equal(element("custom-outcome").dataset.tone, tone);
    assert.match(element("custom-detail").textContent, new RegExp(`${expected}\\.00%`));
    assert.equal(context.seasonalScenarioOutcome(50, state.deProjection.rate, "2026-10-30").projected, expected);
    assert.doesNotMatch(element("de-chart").innerHTML, /NaN|Infinity/);
  }
});

test("an open dashboard refreshes all targets when Berlin crosses a seasonal boundary", async () => {
  const { context, element, events, state, setTime } = await dashboardAt("2026-10-31T22:59:59Z");
  assert.equal(state.target.fill, 80);
  assert.equal(state.deProjection.target.date, "2026-11-01");
  setTime("2026-10-31T23:00:00Z");
  context.refreshSeasonalTarget();
  assert.equal(state.target.fill, 20);
  assert.equal(state.deProjection.target.date, "2027-03-01");
  assert.equal(state.euProjection.target.date, "2027-03-01");
  assert.match(element("custom-label").textContent, /20%/);
  assert.match(element("scenario-list").innerHTML, /01\.03\.2027/);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "projection-target-change");
  assert.equal(events[0].detail.date, "2027-03-01");
  context.refreshSeasonalTarget();
  assert.equal(events.length, 1, "same-day refresh should not emit another target change");
  setTime("2027-02-28T23:00:00Z");
  context.refreshSeasonalTarget();
  assert.equal(state.target.fill, 80);
  assert.equal(state.deProjection.target.date, "2027-11-01");
  assert.match(element("custom-label").textContent, /80%/);
  assert.equal(events.length, 2);
});

test("technical injection percentage uses current storage volume and the lower capacity limit", async () => {
  const { context, state } = await dashboardAt("2026-11-01T12:00:00Z");
  for (const [volume, currentCapacity, expected] of [
    [200, 3000, 1.5],
    [400, 5000, 3936.52 / 4000],
    [400, null, 3936.52 / 4000],
  ]) {
    context.updateCapacityRate({ workingGasVolumeTwh: volume, injectionCapacity: currentCapacity });
    assert.ok(Math.abs(state.capacity.technical_max_injection_pct_per_day - expected) < 1e-12);
  }
});

test("zero current injection capacity remains zero in the winter lab slider", async () => {
  const { context, element, state } = await dashboardAt("2026-11-01T12:00:00Z");
  context.updateCapacityRate({ workingGasVolumeTwh: 247.4, injectionCapacity: 0 });
  assert.equal(state.capacity.technical_max_injection_pct_per_day, 0);
  context.renderWinterReserveLab(state.latest);
  assert.equal(Number(element("rate-slider").max), 0);
  assert.match(element("slider-max-label").textContent, /0,000%/);
});

test("the custom lab preserves the exact measured rate rather than quantizing it", async () => {
  const { element, state } = await dashboardAt("2026-11-01T12:00:00Z", "2026-10-30", {
    fill: 61.17, earlierFill: 58.03,
  });
  assert.equal(Number(element("rate-slider").value), state.deProjection.rate);
  assert.notEqual(state.deProjection.rate, Number(state.deProjection.rate.toFixed(2)));
  assert.match(element("custom-detail").textContent, new RegExp(`${state.deProjection.projected.toFixed(2).replace(".", "\\.")}%`));
  const html = readFileSync(path.join(ROOT, "index.html"), "utf8");
  const slider = html.match(/<input\b[^>]*\bid="rate-slider"[^>]*>/s)?.[0];
  assert.ok(slider, "the custom rate slider should exist");
  assert.match(slider, /\bstep="any"/, "the browser must keep the measured rate precision");
});
