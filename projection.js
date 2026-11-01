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

  const api = Object.freeze({ berlinDate, seasonalTarget, daysBetweenDates, addDays, clampFill, project });
  root.GasStorageProjection = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(globalThis);
