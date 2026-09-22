"""Regression checks for transient GIE API failures; no network or secrets."""

import unittest
from contextlib import ExitStack
from unittest.mock import Mock, patch

import requests

import update_gie_storage as gie


def response(status=200, **payload):
    return Mock(status_code=status, json=Mock(return_value=payload))


class FetchDatasetTests(unittest.TestCase):
    def setUp(self):
        stack = ExitStack()
        self.addCleanup(stack.close)
        self.get = stack.enter_context(patch.object(gie.requests, "get"))
        self.sleep = stack.enter_context(patch.object(gie.time, "sleep"))

    def fetch(self):
        return gie.fetch_dataset({"type": "eu"}, "test-key", to_date="2026-09-22")

    def test_timeout_retries_same_page_without_duplicates(self):
        self.get.side_effect = [
            response(data=[{"gasDayStart": "2026-09-21"}], last_page=2),
            requests.ReadTimeout(),
            response(data=[{"gasDayStart": "2026-09-20"}], last_page=2),
        ]
        rows = self.fetch()
        self.assertEqual([row["gasDayStart"] for row in rows], ["2026-09-21", "2026-09-20"])
        self.assertEqual([call.kwargs["params"]["page"] for call in self.get.call_args_list], ["1", "2", "2"])
        self.assertEqual(self.get.call_args.kwargs["timeout"], (10, 60))
        self.sleep.assert_called_once_with(2)

    def test_transient_http_errors_are_retried(self):
        for status in (429, 500, 502, 503, 504):
            with self.subTest(status=status):
                self.get.reset_mock()
                self.get.side_effect = [response(status), response(data=[{"ok": True}])]
                self.assertEqual(self.fetch(), [{"ok": True}])
                self.assertEqual(self.get.call_count, 2)

    def test_connection_failures_have_bounded_backoff(self):
        self.get.side_effect = requests.ConnectionError("connection failed")
        with self.assertRaisesRegex(RuntimeError, "Exhausted 3 attempts"):
            self.fetch()
        self.assertEqual(self.get.call_count, 3)
        self.assertEqual([call.args[0] for call in self.sleep.call_args_list], [2, 4])

    def test_permanent_http_errors_are_not_retried(self):
        for status in (400, 401, 403, 404):
            with self.subTest(status=status):
                self.get.reset_mock()
                self.get.return_value = response(status)
                with self.assertRaisesRegex(RuntimeError, f"HTTP {status}"):
                    self.fetch()
                self.assertEqual(self.get.call_count, 1)
        self.sleep.assert_not_called()

    def test_invalid_payloads_are_rejected(self):
        for payload in ([], {"error": "denied"}, {"data": "invalid"}, {"data": []}):
            with self.subTest(payload=payload):
                self.get.return_value = Mock(status_code=200, json=Mock(return_value=payload))
                with self.assertRaises(RuntimeError):
                    self.fetch()
        self.sleep.assert_not_called()

    def test_failed_second_dataset_does_not_overwrite_existing_files(self):
        with (
            patch.object(gie, "load_api_key", return_value="test-key"),
            patch.object(gie, "fetch_dataset", side_effect=[[{"gasDayStart": "2026-09-21"}], RuntimeError("offline")]),
            patch.object(gie, "write_csv") as write,
        ):
            with self.assertRaisesRegex(RuntimeError, "offline"):
                gie.main()
            write.assert_not_called()


if __name__ == "__main__":
    unittest.main()
