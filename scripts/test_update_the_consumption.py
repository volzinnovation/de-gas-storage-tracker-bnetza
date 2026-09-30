"""THE XML API regression checks; no network and no production-file writes."""

import csv
import datetime as dt
import io
import tempfile
import unittest
import urllib.error
from contextlib import ExitStack, redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import Mock, patch

import update_the_consumption as the

TODAY = dt.date(2026, 9, 30)


def record(day="2026-09-29", **changes):
    values = dict.fromkeys(the.SLP_FIELDS + the.RLM_FIELDS, "1000000")
    values.update(Gasday=day, Unit="kWh", Status="preliminary")
    values.update(changes)
    return "<AggregatedConsumptionData>" + "".join(
        f"<{key}>{value}</{key}>" for key, value in values.items() if value is not None
    ) + "</AggregatedConsumptionData>"


def payload(*records, namespace=False):
    content = "".join(records)
    if namespace:
        content = content.replace("<AggregatedConsumptionData>",
                                  f'<AggregatedConsumptionData xmlns="{the.NS[1:-1]}">')
    return ("\ufeff<?xml version='1.0' encoding='utf-8'?>\n"
            '<AggregatedConsumptionData xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
            + content + "</AggregatedConsumptionData>").encode()


def zero_rlm():
    return dict.fromkeys(the.RLM_FIELDS, "0")


class ParseTests(unittest.TestCase):
    def test_new_and_legacy_xml_convert_all_eight_fields(self):
        for namespace in (False, True):
            with self.subTest(namespace=namespace):
                row, = the.parse(payload(record(), namespace=namespace))
                self.assertEqual(row["consumption_gwh"], "8.000")
                self.assertEqual(row["slp_gwh"], "4.000")
                self.assertEqual(row["rlm_gwh"], "4.000")
                self.assertEqual(row["source"], the.SOURCE_LABEL)

    def test_each_required_field_missing_or_empty_fails(self):
        for field in the.SLP_FIELDS + the.RLM_FIELDS + ("Gasday", "Unit", "Status"):
            for value in (None, "", " "):
                with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                    the.parse(payload(record(**{field: value})))

    def test_invalid_values_fail(self):
        for field, value in [("Unit", "MWh"), ("Gasday", "2026-02-30"),
                             ("Gasday", "2026-09-29garbage"), ("Status", "unknown")]:
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                the.parse(payload(record(**{field: value})))
        for value in ("-1", "1.5", "NaN", "inf", "1e6", "1,000"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                the.parse(payload(record(HGasRLMmT=value)))

    def test_zero_is_valid_and_timestamp_is_supported(self):
        row, = the.parse(payload(record("2026-09-29T00:00:00", **zero_rlm())))
        self.assertEqual(row["date"], "2026-09-29")
        self.assertEqual(row["rlm_gwh"], "0.000")
        self.assertTrue(row["_rlm_zero"])

    def test_small_positive_amount_is_not_classified_as_zero(self):
        values = zero_rlm()
        values[the.RLM_FIELDS[0]] = "1"
        row, = the.parse(payload(record(**values)))
        self.assertFalse(row["_rlm_zero"])

    def test_duplicates_fail(self):
        with self.assertRaisesRegex(ValueError, "Doppelter Gastag"):
            the.parse(payload(record(), record()))
        with self.assertRaises(ValueError):
            the.parse(payload(record().replace("</Unit>", "</Unit><Unit>kWh</Unit>")))

    def test_error_html_bad_encoding_and_malformed_xml_fail(self):
        for body in (b"<html>offline</html>", b"\xff", b"<AggregatedConsumptionData><",
                     b"<AggregatedConsumptionData><Error>offline</Error></AggregatedConsumptionData>"):
            with self.subTest(body=body), self.assertRaises((ValueError, the.ET.ParseError)):
                the.parse(body)

    def test_statuses_pass_through(self):
        for status in ("preliminary", "corrected", "final"):
            self.assertEqual(the.parse(payload(record(Status=status)))[0]["status"], status)


class FetchTests(unittest.TestCase):
    def test_endpoint_dates_user_agent_timeout(self):
        response = Mock()
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        response.read.return_value = b"xml"
        with patch.object(the.urllib.request, "urlopen", return_value=response) as urlopen:
            self.assertEqual(the.fetch(TODAY - dt.timedelta(days=1), TODAY), b"xml")
        request = urlopen.call_args.args[0]
        self.assertEqual(request.full_url, the.ENDPOINT + "?startDate=2026-09-29&endDate=2026-09-30")
        self.assertEqual(request.get_header("User-agent"), the.USER_AGENT)
        self.assertEqual(urlopen.call_args.kwargs, {"timeout": 60})

    def test_spans_are_inclusive_and_nonoverlapping(self):
        with patch.object(the, "CHUNK_DAYS", 2):
            self.assertEqual(list(the.spans(dt.date(2026, 9, 26), TODAY)), [
                (dt.date(2026, 9, 26), dt.date(2026, 9, 27)),
                (dt.date(2026, 9, 28), dt.date(2026, 9, 29)), (TODAY, TODAY)])

    def test_berlin_date_changes_before_utc_midnight(self):
        for utc, expected in [(dt.datetime(2026, 9, 29, 21, 59, tzinfo=dt.timezone.utc), dt.date(2026, 9, 29)),
                              (dt.datetime(2026, 9, 29, 22, 0, tzinfo=dt.timezone.utc), TODAY),
                              (dt.datetime(2026, 1, 1, 23, 0, tzinfo=dt.timezone.utc), dt.date(2026, 1, 2))]:
            with self.subTest(utc=utc), patch.object(the.dt, "datetime") as clock:
                clock.now.side_effect = lambda zone: utc.astimezone(zone)
                self.assertEqual(the.today_in_berlin(), expected)


class MainTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.directory = Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        self.target = self.directory / "data.csv"
        self.stack.enter_context(patch.object(the, "TARGET", self.target))
        self.stack.enter_context(patch.object(the, "today_in_berlin", return_value=TODAY))
        self.stack.enter_context(patch.object(the, "FIRST_GASDAY", dt.date(2026, 9, 27)))
        self.fetch = self.stack.enter_context(patch.object(the, "fetch"))
        self.stack.enter_context(redirect_stdout(io.StringIO()))
        self.stack.enter_context(redirect_stderr(io.StringIO()))
        self.seed()
        self.original = self.target.read_bytes()

    def seed(self, *extra):
        rows = the.parse(payload(*(record(f"2026-09-{day}") for day in (27, 28, 29)), *extra))
        the.write({row["date"]: row for row in rows})

    def run_main(self, *args):
        with patch.object(the.sys, "argv", ["update_the_consumption.py", *args]):
            return the.main()

    def assert_unchanged_failure(self):
        self.assertEqual(self.run_main(), 1)
        self.assertEqual(self.target.read_bytes(), self.original)

    def full_payload(self, *extra):
        return payload(*(record(f"2026-09-{day}") for day in (27, 28, 29)), *extra)

    def test_success_replaces_corrections_preserves_old_history(self):
        self.fetch.return_value = payload(record("2026-09-28", Status="corrected", HGasRLMmT="2000000"), record())
        self.assertEqual(self.run_main("--refresh-days", "1"), 0)
        rows = the.load_existing()
        self.assertEqual(set(rows), {"2026-09-27", "2026-09-28", "2026-09-29"})
        self.assertEqual(rows["2026-09-28"]["consumption_gwh"], "9.000")
        self.assertEqual(rows["2026-09-28"]["status"], "corrected")

    def test_current_provisional_zero_is_omitted_and_old_placeholder_removed(self):
        provisional = record(TODAY.isoformat(), **zero_rlm())
        self.seed(provisional)
        self.fetch.return_value = self.full_payload(provisional)
        self.assertEqual(self.run_main(), 0)
        self.assertEqual(max(the.load_existing()), "2026-09-29")

    def test_historical_preliminary_zero_and_current_final_zero_are_kept(self):
        self.fetch.return_value = payload(record("2026-09-27"), record("2026-09-28"),
                                         record(**zero_rlm()), record(TODAY.isoformat(), Status="final", **zero_rlm()))
        self.assertEqual(self.run_main(), 0)
        rows = the.load_existing()
        self.assertEqual(rows["2026-09-29"]["rlm_gwh"], "0.000")
        self.assertEqual(rows[TODAY.isoformat()]["status"], "final")

    def test_provisional_cannot_remove_existing_nonzero_or_final_row(self):
        for status, rlm in (("preliminary", "1000000"), ("final", "0")):
            with self.subTest(status=status):
                self.seed(record(TODAY.isoformat(), Status=status, **dict.fromkeys(the.RLM_FIELDS, rlm)))
                self.original = self.target.read_bytes()
                self.fetch.return_value = self.full_payload(record(TODAY.isoformat(), **zero_rlm()))
                self.assert_unchanged_failure()

    def test_empty_stale_gap_and_out_of_range_fail_despite_cache(self):
        for body in (payload(), payload(record("2026-09-27")),
                     payload(record("2026-09-27"), record()),
                     self.full_payload(record("2026-10-01", **zero_rlm())),
                     self.full_payload(record("2026-09-26"))):
            with self.subTest(body=body):
                self.fetch.return_value = body
                self.assert_unchanged_failure()

    def test_missing_known_tail_fails_even_if_fresh_enough(self):
        self.fetch.return_value = payload(record("2026-09-27"), record("2026-09-28"))
        self.assert_unchanged_failure()

    def test_network_and_parse_failures_preserve_file(self):
        for error in (urllib.error.URLError("offline"), TimeoutError("timeout"),
                      the.ET.ParseError("bad xml"), ValueError("bad payload")):
            with self.subTest(error=error):
                self.fetch.side_effect = error
                self.assert_unchanged_failure()

    def test_later_chunk_failure_never_partially_writes(self):
        with patch.object(the, "CHUNK_DAYS", 2):
            self.fetch.side_effect = [payload(record("2026-09-27"), record("2026-09-28")),
                                      urllib.error.URLError("offline")]
            self.assert_unchanged_failure()
            self.assertEqual(self.fetch.call_count, 2)

    def test_empty_pre_history_chunks_allowed_on_full_initial_load(self):
        self.target.unlink()
        with patch.object(the, "FIRST_GASDAY", dt.date(2026, 9, 25)), patch.object(the, "CHUNK_DAYS", 2):
            self.fetch.side_effect = [payload(), payload(record("2026-09-27"), record("2026-09-28")), payload(record())]
            self.assertEqual(self.run_main("--full"), 0)
        self.assertEqual(min(the.load_existing()), "2026-09-27")

    def test_missing_leading_known_day_is_not_hidden_by_cache(self):
        self.fetch.return_value = payload(record("2026-09-28"), record())
        self.assert_unchanged_failure()

    def test_atomic_replace_failure_leaves_original_and_cleans_tempfile(self):
        self.fetch.return_value = self.full_payload()
        with patch.object(Path, "replace", side_effect=OSError("disk error")):
            self.assert_unchanged_failure()
        self.assertEqual(list(self.directory.iterdir()), [self.target])

    def test_serialization_failure_leaves_original_and_cleans_tempfile(self):
        with patch.object(the.csv.DictWriter, "writerow", side_effect=OSError("write failed")):
            with self.assertRaises(OSError):
                the.write({"2026-09-29": {}})
        self.assertEqual(self.target.read_bytes(), self.original)
        self.assertEqual(list(self.directory.iterdir()), [self.target])

    def test_cli_rejects_nonpositive_limits_before_fetch(self):
        for option in ("--refresh-days", "--max-data-age-days"):
            for value in ("0", "-1"):
                with self.subTest(option=option, value=value), self.assertRaises(SystemExit) as error:
                    self.run_main(option, value)
                self.assertEqual(error.exception.code, 2)
        self.fetch.assert_not_called()


if __name__ == "__main__":
    unittest.main()
