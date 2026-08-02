#!/usr/bin/env python3
"""Unit tests for the MBFD recording broker validation logic.

Tests the broker's session-ID, environment, action, and request validation
without requiring a running systemd or socket.  Run with:
    python3 -m pytest kamrui-media-edge/recording-broker/test_broker.py
or:
    python3 kamrui-media-edge/recording-broker/test_broker.py
"""

import importlib.util
import json
import os
import sys
import unittest
from unittest import mock

# Load the broker module from its file path.
_broker_path = os.path.join(os.path.dirname(__file__), "mbfd-recording-broker.py")
_spec = importlib.util.spec_from_file_location("mbfd_recording_broker", _broker_path)
broker = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(broker)


class TestSessionIdValidation(unittest.TestCase):
    def test_valid_session_id(self):
        self.assertEqual(broker.validate_session_id("ses_abc123"), "ses_abc123")
        self.assertEqual(broker.validate_session_id("ses_test-2026"), "ses_test-2026")

    def test_invalid_session_id_no_prefix(self):
        with self.assertRaises(ValueError):
            broker.validate_session_id("abc123")

    def test_invalid_session_id_path_traversal(self):
        with self.assertRaises(ValueError):
            broker.validate_session_id("ses_../escape")

    def test_invalid_session_id_empty(self):
        with self.assertRaises(ValueError):
            broker.validate_session_id("")

    def test_invalid_session_id_not_string(self):
        with self.assertRaises(ValueError):
            broker.validate_session_id(123)

    def test_invalid_session_id_shell_injection(self):
        with self.assertRaises(ValueError):
            broker.validate_session_id("ses_abc; rm -rf /")


class TestEnvironmentValidation(unittest.TestCase):
    def _valid_env(self, session_id="ses_test"):
        return {
            "MBFD_RECORDING_SESSION_ID": session_id,
            "MBFD_RECORDING_SOURCE": "rtsp://127.0.0.1:8554/anpviz-main",
            "MBFD_RECORDING_OUTPUT_PATTERN": f"/mnt/data/recordings/active/{session_id}/recording_%03d.mp4",
            "MBFD_RECORDING_NONCE": "a" * 64,
            "MBFD_RECORDING_SEGMENT_SECONDS": "1800",
        }

    def test_valid_environment(self):
        env = broker.validate_environment("ses_test", self._valid_env())
        self.assertEqual(env["MBFD_RECORDING_SESSION_ID"], "ses_test")

    def test_missing_key(self):
        env = self._valid_env()
        del env["MBFD_RECORDING_NONCE"]
        with self.assertRaises(ValueError):
            broker.validate_environment("ses_test", env)

    def test_extra_key(self):
        env = self._valid_env()
        env["EXTRA_KEY"] = "evil"
        with self.assertRaises(ValueError):
            broker.validate_environment("ses_test", env)

    def test_session_id_mismatch(self):
        env = self._valid_env("ses_other")
        with self.assertRaises(ValueError):
            broker.validate_environment("ses_test", env)

    def test_non_loopback_source(self):
        env = self._valid_env()
        env["MBFD_RECORDING_SOURCE"] = "rtsp://10.0.0.1:8554/stream"
        with self.assertRaises(ValueError):
            broker.validate_environment("ses_test", env)

    def test_source_with_credentials(self):
        env = self._valid_env()
        env["MBFD_RECORDING_SOURCE"] = "rtsp://user:pass@127.0.0.1:8554/stream"
        with self.assertRaises(ValueError):
            broker.validate_environment("ses_test", env)

    def test_output_path_traversal(self):
        env = self._valid_env()
        env["MBFD_RECORDING_OUTPUT_PATTERN"] = "/mnt/data/recordings/active/other/out_%03d.mp4"
        with self.assertRaises(ValueError):
            broker.validate_environment("ses_test", env)

    def test_output_path_command_injection(self):
        env = self._valid_env()
        env["MBFD_RECORDING_OUTPUT_PATTERN"] = "/mnt/data/recordings/active/ses_test/out_%03d.mp4; rm -rf /"
        with self.assertRaises(ValueError):
            broker.validate_environment("ses_test", env)

    def test_invalid_nonce(self):
        env = self._valid_env()
        env["MBFD_RECORDING_NONCE"] = "xyz" * 21
        with self.assertRaises(ValueError):
            broker.validate_environment("ses_test", env)

    def test_invalid_segment_duration(self):
        env = self._valid_env()
        env["MBFD_RECORDING_SEGMENT_SECONDS"] = "0"
        with self.assertRaises(ValueError):
            broker.validate_environment("ses_test", env)
        env["MBFD_RECORDING_SEGMENT_SECONDS"] = "99999"
        with self.assertRaises(ValueError):
            broker.validate_environment("ses_test", env)

    def test_environment_not_dict(self):
        with self.assertRaises(ValueError):
            broker.validate_environment("ses_test", "not a dict")

    def test_environment_value_injection(self):
        env = self._valid_env()
        env["MBFD_RECORDING_SOURCE"] = "rtsp://127.0.0.1:8554/stream; rm -rf /"
        with self.assertRaises(ValueError):
            broker.validate_environment("ses_test", env)


class TestRequestProcessing(unittest.TestCase):
    def _process(self, request_dict, peer_uid=999, expected_uid=999):
        return broker.process_request(
            json.dumps(request_dict).encode("utf-8"),
            peer_uid,
            expected_uid,
        )

    def test_unauthorized_peer_denied(self):
        resp = self._process({"action": "status", "session_id": "ses_test"},
                             peer_uid=1000, expected_uid=999)
        self.assertIn(b"unauthorized", resp)

    def test_unknown_action_denied(self):
        resp = self._process({"action": "reboot", "session_id": "ses_test"})
        self.assertIn(b"unknown action", resp)

    def test_missing_action_denied(self):
        resp = self._process({"session_id": "ses_test"})
        self.assertIn(b"unknown action", resp)

    def test_invalid_session_id_denied(self):
        resp = self._process({"action": "status", "session_id": "../escape"})
        self.assertIn(b"invalid session id", resp)

    def test_start_without_environment_denied(self):
        resp = self._process({"action": "start", "session_id": "ses_test"})
        self.assertIn(b"Error=", resp)

    def test_start_with_invalid_environment_denied(self):
        resp = self._process({"action": "start", "session_id": "ses_test", "environment": {}})
        self.assertIn(b"Error=", resp)

    def test_malformed_json_denied(self):
        resp = broker.process_request(b"{not valid json", 999, 999)
        self.assertIn(b"malformed json", resp)

    def test_non_object_request_denied(self):
        resp = broker.process_request(b'"just a string"', 999, 999)
        self.assertIn(b"must be an object", resp)

    def test_oversized_request_denied(self):
        large = b"x" * (broker.MAX_REQUEST + 1)
        result = broker.read_bounded.__wrapped__ if hasattr(broker.read_bounded, '__wrapped__') else None
        # Test read_bounded directly with a mock conn
        class MockConn:
            def __init__(self, data):
                self._data = data
                self._pos = 0
            def recv(self, n):
                chunk = self._data[self._pos:self._pos + n]
                self._pos += len(chunk)
                return chunk
        conn = MockConn(large + b"\n")
        result = broker.read_bounded(conn, broker.MAX_REQUEST)
        self.assertIsNone(result)  # oversized -> None

    def test_allowed_actions_exact_set(self):
        self.assertEqual(broker.ALLOWED_ACTIONS,
                         frozenset({"start", "stop", "status", "reconcile", "finalize"}))

    def test_no_shell_in_broker(self):
        """The broker script must never use shell=True or os.system."""
        broker_path = os.path.join(os.path.dirname(__file__), "mbfd-recording-broker.py")
        with open(broker_path, "r") as f:
            source = f.read()
        self.assertNotIn("shell=True", source)
        self.assertNotIn("os.system", source)
        self.assertNotIn("os.popen", source)
        self.assertIn("SO_PEERCRED", source)


class TestReconcileClassifications(unittest.TestCase):
    def test_all_classifications_defined(self):
        for c in broker.RECONCILE_CLASSIFICATIONS:
            self.assertIn(c, [
                "ACTIVE", "FINALIZING", "RECOVERABLE", "ORPHANED_METADATA",
                "FAILED_WITH_MEDIA", "FAILED_WITHOUT_MEDIA", "UNKNOWN",
            ])


class TestActiveProcessIdentity(unittest.TestCase):
    def test_runner_cmdline_is_bound_to_the_exact_session(self):
        broker.validate_runner_cmdline(
            [b"bash", broker.RUNNER.encode(), b"ses_test"],
            "ses_test",
        )
        with self.assertRaises(ValueError):
            broker.validate_runner_cmdline(
                [b"bash", broker.RUNNER.encode(), b"ses_other"],
                "ses_test",
            )
        with self.assertRaises(ValueError):
            broker.validate_runner_cmdline(
                [b"bash", broker.RUNNER.encode(), b"ses_test", b"extra"],
                "ses_test",
            )

    def test_ffmpeg_child_must_belong_to_the_validated_runner(self):
        broker.validate_ffmpeg_parent("4321", 4321)
        with self.assertRaises(ValueError):
            broker.validate_ffmpeg_parent("9999", 4321)
        with self.assertRaises(ValueError):
            broker.validate_ffmpeg_parent("not-a-pid", 4321)

    def test_child_pid_file_is_session_scoped(self):
        self.assertEqual(
            broker.child_pid_path_for("ses_test"),
            "/run/mbfd-camera-recording/ses_test.pid",
        )

    def test_expected_ffmpeg_arguments_bind_all_runtime_values(self):
        source = "rtsp://127.0.0.1:8554/anpviz-main"
        segment = "1800"
        output = "/mnt/data/recordings/active/ses_test/recording_%03d.mp4"

        arguments = broker.expected_ffmpeg_arguments(source, segment, output)

        self.assertEqual(arguments[arguments.index("-i") + 1], source)
        self.assertEqual(arguments[arguments.index("-segment_time") + 1], segment)
        self.assertEqual(arguments[-1], output)
        self.assertNotIn(None, arguments)

    def test_broker_service_can_inspect_recording_process_identity(self):
        service_path = os.path.join(
            os.path.dirname(__file__),
            "..",
            "systemd",
            "mbfd-recording-broker.service",
        )
        with open(service_path, "r", encoding="utf-8") as service_file:
            service = service_file.read()

        capability_line = next(
            line for line in service.splitlines()
            if line.startswith("CapabilityBoundingSet=")
        )
        self.assertIn("CAP_SYS_PTRACE", capability_line.split("=", 1)[1].split())

    @mock.patch.object(broker, "write_env_file")
    @mock.patch.object(broker, "validate_environment")
    @mock.patch.object(broker.subprocess, "run")
    @mock.patch.object(
        broker,
        "validate_active_unit",
        side_effect=[
            (None, {"ActiveState": "active", "SubState": "running"}),
            (4321, {"ActiveState": "active", "SubState": "running"}),
        ],
    )
    def test_start_waits_for_runner_to_launch_validated_ffmpeg(
        self,
        validate_active_unit,
        run,
        validate_environment,
        write_env_file,
    ):
        broker.handle_start("ses_test", {})

        self.assertEqual(validate_active_unit.call_count, 2)
        run.assert_called_once()
        validate_environment.assert_called_once_with("ses_test", {})
        write_env_file.assert_called_once_with("ses_test", {})


if __name__ == "__main__":
    unittest.main()
