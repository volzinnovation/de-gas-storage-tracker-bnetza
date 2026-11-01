"use strict";

// Exercise the real flow-lab model with an in-memory clock and fixtures.
// The closure is exposed only in this VM; production code gains no test API.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");

function flowLabAt(timestamp, startDate = "2026-10-30") {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, { textContent: "", innerHTML: "", style: {}, dataset: {}, setAttribute() {} });
    return elements.get(id);
  };
  const clock = new Date(timestamp).valueOf();
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock])); }
    static now() { return clock; }
  }
  const context = vm.createContext({
    Date: FixedDate, Intl,
    document: { getElementById: element, querySelectorAll: () => [] },
  });
  vm.runInContext(readFileSync(path.join(ROOT, "projection.js"), "utf8"), context);
  const source = readFileSync(path.join(ROOT, "flowlab.js"), "utf8");
  const startup = '\n  if (document.readyState === "loading") {';
  assert.ok(source.includes(startup), "flow-lab startup marker should still be present");
  vm.runInContext(source.replace(startup, `
  globalThis.flowModel = {
    state, setHorizon, simulate, reserveAtSupply, supplyRequirement,
    requiredSupply, zielSchnitt, zielZufluss, buildCsv, buildCsvGesamt,
    number, applyDataset,
  };
  return;
${startup}`), context);
  const model = context.flowModel;
  const fallbackPpGwh = model.state.ppGwh;
  Object.assign(model.state, {
    startDate,
    startFill: 50,
    ppGwh: 100,
    injectionCapacity: 50,
    withdrawalCapacity: 100,
    demand: { households: 100, industry: 0, power: 0 },
    supply: { pipeline: 100, lng: 0, domestic: 0 },
    refYear: 2025,
    refYears: [2025],
  });
  model.setHorizon();
  return { model, element, fallbackPpGwh };
}

test("the flow lab selects March from today's date despite October observations", () => {
  const { model } = flowLabAt("2026-10-31T23:00:00Z");
  assert.equal(model.state.target.fill, 20);
  assert.equal(model.state.targetDate, "2027-03-01");
  assert.equal(model.state.targetIndex, 122);
  const requirement = model.supplyRequirement(0, 50);
  assert.equal(requirement.feasible, true);
  assert.ok(requirement.pp < 0, "the reserve minimum permits withdrawals");
  const expectedSupply = 100 - ((50 - 20) * 100) / 122;
  assert.ok(Math.abs(requirement.niveau - expectedSupply) < 1e-6);
  assert.ok(Math.abs(model.reserveAtSupply(requirement.niveau, 0, 50) - 20) < 1e-6);
});

test("an already sufficient winter reserve can require zero additional inflow", () => {
  const { model } = flowLabAt("2026-11-01T12:00:00Z");
  model.state.demand.households = 10;
  const requirement = model.supplyRequirement(0, 50);
  assert.equal(requirement.niveau, 0);
  assert.equal(requirement.gwh, 0);
  assert.equal(requirement.feasible, true);
  assert.ok(model.reserveAtSupply(0, 0, 50) > 20);
  assert.equal(model.zielZufluss(), 0);
});

test("a reserve above the minimum still needs supply when later demand consumes it", () => {
  const { model } = flowLabAt("2026-11-01T12:00:00Z");
  const requirement = model.supplyRequirement(0, 50);
  assert.ok(requirement.niveau > 0);
  assert.equal(requirement.feasible, true);
  assert.ok(model.reserveAtSupply(0, 0, 50) < 20);
});

test("the flow lab reports goals that storage injection capacity cannot reach", () => {
  const { model } = flowLabAt("2026-10-31T12:00:00Z", "2026-10-31");
  model.state.injectionCapacity = 10;
  assert.equal(model.state.target.fill, 80);
  assert.equal(model.state.targetIndex, 1);
  const requirement = model.supplyRequirement(0, 50);
  assert.equal(requirement.feasible, false);
  assert.ok(model.reserveAtSupply(requirement.niveau, 0, 50) < 80);
  assert.ok(Number.isFinite(requirement.niveau));
});

test("required supply respects storage overflow instead of relying on aggregate volumes", () => {
  const { model } = flowLabAt("2026-10-30T12:00:00Z", "2026-10-30");
  Object.assign(model.state, {
    startFill: 95,
    injectionCapacity: 10000,
    withdrawalCapacity: 10000,
    demand: { households: 1, industry: 0, power: 0 },
    base: { households: 1, industry: 0, power: 0 },
    consumption: new Map([[2025, new Map([
      ["10-30", { slp: 0, rlm: 0 }],
      ["10-31", { slp: 3000, rlm: 0 }],
    ])]]),
  });
  assert.equal(model.state.targetIndex, 2);
  const requirement = model.supplyRequirement(0, 95);
  // An aggregate balance suggests750 GWh/day, but early gas overflows at100%.
  assert.ok(Math.abs(model.reserveAtSupply(750, 0, 95) - 77.5) < 1e-9);
  assert.equal(requirement.feasible, true);
  assert.ok(Math.abs(requirement.niveau - 1000) < 1e-6);
  assert.ok(Math.abs(model.reserveAtSupply(requirement.niveau, 0, 95) - 80) < 1e-6);
});

test("at or after the target date the flow lab does not invent another day", () => {
  for (const start of ["2026-11-01", "2026-11-02"]) {
    const { model } = flowLabAt("2026-10-31T12:00:00Z", start);
    assert.equal(model.state.targetIndex, 0);
    assert.equal(model.supplyRequirement(0, 50), null);
    assert.equal(model.zielSchnitt(), 0);
    assert.equal(model.zielZufluss(), 0);
    assert.equal(model.reserveAtSupply(1000, 0, 50), 50);
    assert.doesNotMatch(model.buildCsv(), /NaN|Infinity/);
  }
});

test("CSV exports carry the active winter target and the same finite reserve path", () => {
  const { model } = flowLabAt("2026-11-01T12:00:00Z");
  const csv = model.buildCsv();
  assert.match(csv, /20\s*%/);
  assert.match(csv, /2027-03-01/);
  assert.doesNotMatch(csv, /NaN|Infinity/);
  const lines = csv.split("\n").filter((line) => line && !line.startsWith("#"));
  const header = lines.shift().split(",");
  const records = lines.map((line) => Object.fromEntries(line.split(",").map((value, index) => [header[index], value])));
  const target = records.find((row) => row.datum === model.state.targetDate);
  assert.equal(target.zielpfad_fuellstand_pct, "20.000");
  for (const row of records) {
    assert.ok(Number(row.fuellstand_pct) >= 0 && Number(row.fuellstand_pct) <= 100);
    if (row.datum > model.state.targetDate) assert.equal(row.zielpfad_fuellstand_pct, "");
  }
  const all = model.buildCsvGesamt();
  assert.match(all, /mindestens 20 % am 2027-03-01/);
  assert.doesNotMatch(all, /NaN|Infinity/);
});

test("blank flow-lab numerics use fallbacks while explicit zero capacity remains zero", () => {
  const { model, fallbackPpGwh } = flowLabAt("2026-11-01T12:00:00Z");
  for (const value of ["", " ", null, undefined]) assert.equal(model.number(value), null);
  assert.equal(model.number("0"), 0);
  const row = {
    date: "2026-10-30", fill_pct: "61.17", norm_5y_fill_pct: "",
    working_gas_volume_twh: "", injection_capacity_gwh_per_day: "0",
    withdrawal_capacity_gwh_per_day: "", consumption_gwh_per_day: "",
    injection_gwh_per_day: "", withdrawal_gwh_per_day: "",
  };
  model.applyDataset([{ ...row, date: "2026-10-01", fill_pct: "58.03" }, row]);
  assert.equal(model.state.ppGwh, fallbackPpGwh);
  assert.ok(model.state.ppGwh > 0, "blank working volume must not become a zero divisor");
  assert.equal(model.state.injectionCapacity, 0);
  assert.ok(model.state.withdrawalCapacity > 0);
  assert.ok(model.state.consumptionTwh > 0);
  assert.equal(model.state.storageFlows.size, 0, "blank storage flows must not become measured zeros");
});
