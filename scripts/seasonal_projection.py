"""Calendar and capacity-aware calculations used by the methodology PDF."""

from datetime import date, datetime
from zoneinfo import ZoneInfo


def seasonal_target(today: date | None = None) -> tuple[date, float]:
    """Select the next seasonal checkpoint from today's Berlin calendar date."""
    today = today or datetime.now(ZoneInfo("Europe/Berlin")).date()
    if (3, 1) <= (today.month, today.day) < (11, 1):
        return date(today.year, 11, 1), 80.0
    year = today.year + (today.month >= 11)
    return date(year, 3, 1), 20.0


def simulate_fill(start_fill, pp_gwh, injection, withdrawal, demands, factors, level):
    """Apply daily storage limits and the physical 0-100% fill bounds."""
    fill = start_fill
    for demand, factor in zip(demands, factors):
        net = max(-withdrawal, min(injection, level * factor - demand))
        fill = max(0.0, min(100.0, fill + net / pp_gwh))
    return fill


def minimum_supply_level(start_fill, pp_gwh, injection, withdrawal,
                         demands, factors, target_fill):
    """Find the least nonnegative supply level reaching the minimum checkpoint.

    Return None when even the injection capacity cannot meet the checkpoint.
    Returning zero means the minimum survives without any additional supply.
    """
    if len(demands) != len(factors):
        raise ValueError("Demand and inflow-factor windows must have equal lengths")
    if pp_gwh <= 0 or injection < 0 or withdrawal < 0 or any(f <= 0 for f in factors):
        raise ValueError("Storage capacities and inflow factors must be positive")

    def final(level):
        return simulate_fill(start_fill, pp_gwh, injection, withdrawal,
                             demands, factors, level)

    if final(0) >= target_fill:
        return 0.0
    if not demands:
        return None
    # This level saturates injection on every day. More supply cannot improve
    # the result, so it also provides a finite proof of physical feasibility.
    upper = max((d + injection) / f for d, f in zip(demands, factors))
    if final(upper) < target_fill:
        return None
    lower = 0.0
    for _ in range(70):
        middle = (lower + upper) / 2
        if final(middle) >= target_fill:
            upper = middle
        else:
            lower = middle
    return upper
