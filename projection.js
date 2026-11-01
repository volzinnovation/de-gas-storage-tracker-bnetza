/* Calendar and arithmetic shared by the dashboard and the flow-balance lab. */
(function (root) {
  "use strict";

  function berlinDate(now = new Date()) {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(now);
    const part = (type) => parts.find((value) => value.type === type).value;
    return `${part("year")}-${part("month")}-${part("day")}`;
  }

  function timestamp(iso) {
    const value = Date.parse(`${iso}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso) || !Number.isFinite(value) ||
        new Date(value).toISOString().slice(0, 10) !== iso) {
      throw new RangeError(`Invalid calendar date: ${iso}`);
    }
    return value;
  }

  function daysBetweenDates(start, end) {
    return (timestamp(end) - timestamp(start)) / 86400000;
  }

  function addDays(start, days) {
    return new Date(timestamp(start) + Math.ceil(days) * 86400000).toISOString().slice(0, 10);
  }

  function seasonalTarget(today = berlinDate()) {
    timestamp(today);
    const year = Number(today.slice(0, 4));
    if (today >= `${year}-03-01` && today < `${year}-11-01`) {
      return { fill: 80, date: `${year}-11-01`, label: "80%", season: "injection", shortDate: "1. November" };
    }
    return {
      fill: 20, date: `${today >= `${year}-11-01` ? year + 1 : year}-03-01`,
      label: "20%", season: "winter", shortDate: "1. März",
    };
  }

  function clampFill(value) {
    if (!Number.isFinite(value)) throw new RangeError("Fill level must be finite.");
    return Math.max(0, Math.min(100, value));
  }

  function project(fill, rate, dataDate, target = seasonalTarget()) {
    if (!Number.isFinite(rate)) throw new RangeError("Projection rate must be finite.");
    const initial = clampFill(fill);
    const days = Math.max(daysBetweenDates(dataDate, target.date), 0);
    const rawProjected = initial + rate * days;
    const projected = clampFill(rawProjected);
    const met = projected >= target.fill - 1e-9;
    return {
      target, days, projected, rawProjected, met,
      shortfall: met ? 0 : target.fill - projected,
      requiredRate: days > 0 ? (target.fill - initial) / days : null,
    };
  }

  function previousYearDate(iso) {
    const date = new Date(timestamp(iso));
    const year = date.getUTCFullYear() - 1;
    // A leap day without a prior-year counterpart uses February 28. Mapping
    // consecutive dates also includes a skipped historical leap day on March 1.
    const previous = new Date(Date.UTC(year, date.getUTCMonth(), date.getUTCDate()));
    if (previous.getUTCMonth() !== date.getUTCMonth()) return `${year}-02-28`;
    return previous.toISOString().slice(0, 10);
  }

  function priorYearProjection(rows, dataDate, target = seasonalTarget()) {
    const history = new Map(rows.filter((row) => Number.isFinite(row.value))
      .map((row) => [row.date, row.value]));
    const basis = history.get(dataDate);
    if (basis === undefined) throw new RangeError(`Missing projection basis: ${dataDate}`);
    const outcome = project(basis, 0, dataDate, target);
    const initial = { date: dataDate, value: clampFill(basis) };
    const referenceStart = previousYearDate(dataDate);
    const referenceEnd = previousYearDate(target.date);
    const missing = new Set();
    const steps = [];
    for (let day = 1; day <= outcome.days; day += 1) {
      const date = addDays(dataDate, day);
      const referenceDate = previousYearDate(date);
      const previousReferenceDate = previousYearDate(addDays(date, -1));
      for (const required of [previousReferenceDate, referenceDate]) {
        if (!history.has(required)) missing.add(required);
      }
      steps.push({ date, referenceDate, previousReferenceDate });
    }
    if (missing.size) {
      return { ...outcome, projected: null, rawProjected: null, met: null, shortfall: null,
        points: [initial], meanDelta: null, complete: false, missingDates: [...missing].sort(),
        referenceStart, referenceEnd };
    }
    const points = [initial];
    let fill = initial.value;
    let rawProjected = fill;
    for (const step of steps) {
      const delta = history.get(step.referenceDate) - history.get(step.previousReferenceDate);
      rawProjected += delta;
      fill = clampFill(fill + delta);
      points.push({ ...step, delta, value: fill });
    }
    const met = fill >= target.fill - 1e-9;
    return { ...outcome, projected: fill, rawProjected, met,
      shortfall: met ? 0 : target.fill - fill, points, complete: true, missingDates: [],
      meanDelta: outcome.days > 0 ? (rawProjected - initial.value) / outcome.days : 0,
      referenceStart, referenceEnd };
  }

  const api = Object.freeze({ berlinDate, seasonalTarget, daysBetweenDates, addDays, clampFill,
    project, previousYearDate, priorYearProjection });
  root.GasStorageProjection = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(globalThis);
