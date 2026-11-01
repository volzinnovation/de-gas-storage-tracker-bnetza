"""Regression checks for the methodology's seasonal reserve calculations."""

from datetime import date, datetime, timezone
import unittest
from unittest.mock import patch

from seasonal_projection import minimum_supply_level, seasonal_target, simulate_fill


class SeasonalTargetTests(unittest.TestCase):
    def test_default_clock_uses_berlin_date_before_utc_midnight(self):
        utc = datetime(2026, 10, 31, 23, 15, tzinfo=timezone.utc)
        with patch("seasonal_projection.datetime") as clock:
            clock.now.side_effect = lambda zone: utc.astimezone(zone)
            self.assertEqual(seasonal_target(), (date(2027, 3, 1), 20))

    def test_season_boundaries_and_year_rollover(self):
        for today, target, fill in [
            ("2026-10-31", "2026-11-01", 80),
            ("2026-11-01", "2027-03-01", 20),
            ("2027-01-01", "2027-03-01", 20),
            ("2027-02-28", "2027-03-01", 20),
            ("2027-03-01", "2027-11-01", 80),
            ("2028-02-29", "2028-03-01", 20),
        ]:
            with self.subTest(today=today):
                self.assertEqual(seasonal_target(date.fromisoformat(today)),
                                 (date.fromisoformat(target), fill))


class MinimumSupplyTests(unittest.TestCase):
    def solve(self, fill, demands, factors, target=20, injection=10, withdrawal=10):
        return minimum_supply_level(fill, 1, injection, withdrawal,
                                    demands, factors, target)

    def test_winter_reserve_can_decline_to_minimum(self):
        level = self.solve(60, [10] * 10, [1] * 10)
        self.assertAlmostEqual(level, 6)
        self.assertAlmostEqual(simulate_fill(60, 1, 10, 10,
                                            [10] * 10, [1] * 10, level), 20)

    def test_capacity_limited_days_require_more_than_average_balance(self):
        # Average balance chooses55; day2 cannot recover day1's 45-unit loss.
        level = self.solve(50, [100, 0], [1, 1], target=60, withdrawal=100)
        self.assertAlmostEqual(level, 100)
        self.assertAlmostEqual(simulate_fill(50, 1, 10, 100,
                                            [100, 0], [1, 1], level), 60)

    def test_solver_uses_daily_capacity_and_storage_bounds(self):
        # Starting full, day1 spills all surplus and day2 must still leave80.
        level = self.solve(100, [0, 100], [1, 1], target=80, withdrawal=100)
        self.assertAlmostEqual(level, 80)
        self.assertAlmostEqual(simulate_fill(100, 1, 10, 100,
                                            [0, 100], [1, 1], level), 80)

    def test_unreachable_goal_is_not_reported_as_solved(self):
        self.assertIsNone(self.solve(0, [0], [1], target=80, injection=10))

    def test_zero_supply_when_reserve_already_survives(self):
        self.assertEqual(self.solve(60, [1] * 10, [1] * 10), 0)

    def test_zero_day_window_uses_current_fill(self):
        self.assertEqual(self.solve(20, [], []), 0)
        self.assertEqual(self.solve(80, [], [], target=80), 0)
        self.assertIsNone(self.solve(19, [], []))

    def test_physical_fill_limits(self):
        self.assertEqual(simulate_fill(95, 1, 1000, 1000, [0], [1], 1000), 100)
        self.assertEqual(simulate_fill(5, 1, 1000, 1000, [1000], [1], 0), 0)


if __name__ == "__main__":
    unittest.main()
