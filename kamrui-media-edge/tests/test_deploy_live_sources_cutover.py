"""Policy regression tests for the narrow live-source cutover workflow.

These tests intentionally inspect the deployment script rather than executing
it: its apply mode is designed for an approved KAMRUI maintenance window only.
"""

from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


EDGE_ROOT = Path(__file__).resolve().parents[1]
SCRIPT_PATH = EDGE_ROOT / "scripts" / "deploy-live-sources-cutover.sh"
README_PATH = EDGE_ROOT / "README.md"
DOCUMENTATION_PATH = EDGE_ROOT / "docs" / "live-sources-cutover.md"
ROLLBACK_VALIDATOR_PATH = EDGE_ROOT / "scripts" / "validate-rollback-snapshot.py"

IMAGE_ID = "sha256:" + "a" * 64
REPO_DIGEST = "bluenviron/mediamtx@sha256:" + "b" * 64
STARTED_AT = "2026-08-27T12:00:00.000000000Z"


def load_rollback_validator():
    spec = importlib.util.spec_from_file_location("validate_rollback_snapshot", ROLLBACK_VALIDATOR_PATH)
    if spec is None or spec.loader is None:  # pragma: no cover - test setup failure
        raise RuntimeError("unable to load rollback snapshot validator")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


ROLLBACK_VALIDATOR = load_rollback_validator()


def git_bash() -> str | None:
    candidate = Path(r"C:\Program Files\Git\bin\bash.exe")
    if candidate.is_file():
        return str(candidate)
    return shutil.which("bash")


def bash_path(bash: str, path: Path) -> str:
    if os.name != "nt":
        return str(path)
    result = subprocess.run(
        [bash, "-lc", 'cygpath -u -- "$TARGET"'],
        env={**os.environ, "TARGET": str(path)},
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


class LiveSourcesCutoverPolicyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.script = SCRIPT_PATH.read_text(encoding="utf-8")

    def run_path_contract(self, phase: str, payload: dict, active_config: str | None = None) -> subprocess.CompletedProcess[str]:
        """Run the embedded MediaMTX path classifier without a KAMRUI mutation."""

        marker = '  printf \'%s\' "$payload" | python3 -c \'\n'
        start = self.script.index(marker) + len(marker)
        end = self.script.index("\n' \"$phase\"", start)
        classifier = self.script[start:end]

        with tempfile.TemporaryDirectory() as temporary_dir:
            config_path = Path(temporary_dir) / "mediamtx.yml"
            config_path.write_text(
                active_config
                or "paths:\n  guest-computer:\n    source: rtsp://legacy.example.invalid/main/av\n",
                encoding="utf-8",
            )
            return subprocess.run(
                [sys.executable, "-c", classifier, phase, "verified-legacy", str(config_path)],
                input=json.dumps(payload),
                capture_output=True,
                text=True,
                timeout=10,
            )

    @staticmethod
    def legacy_path_payload(*, guest: dict | None = None, extra_paths: list[dict] | None = None) -> dict:
        items = [
            {"name": "anpviz-video", "ready": True},
            {"name": "anpviz-main", "ready": True},
            guest
            or {
                "name": "guest-computer",
                "ready": True,
                "source": {"type": "rtspSource", "id": ""},
                "tracks": ["H264", "MPEG-4 Audio"],
                "readers": [],
            },
        ]
        return {"items": items + (extra_paths or [])}

    @staticmethod
    def post_cutover_config(*, podium_source: str = "rtsp://zowie.example.invalid/main/av", guest_source: str = "publisher") -> str:
        return (
            "paths:\n"
            "  podium-computer:\n"
            f"    source: {podium_source}\n"
            "  guest-computer:\n"
            f"    source: {guest_source}\n"
        )

    @staticmethod
    def post_cutover_payload(*, podium: dict | None = None, guest: dict | None = None, anpviz_ready: bool = True) -> dict:
        return {
            "items": [
                {"name": "anpviz-video", "ready": anpviz_ready},
                {"name": "anpviz-main", "ready": anpviz_ready},
                podium
                or {
                    "name": "podium-computer",
                    "ready": True,
                    "source": {"type": "rtspSource", "id": "zowie"},
                    "tracks": ["H264", "MPEG-4 Audio"],
                    "readers": [],
                },
                guest
                or {
                    "name": "guest-computer",
                    "ready": False,
                    "readers": [],
                },
            ]
        }

    def test_preflight_accepts_only_the_ready_legacy_rtsp_guest_topology(self) -> None:
        result = self.run_path_contract("preflight", self.legacy_path_payload())
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_preflight_rejects_publisher_and_unknown_guest_source_types(self) -> None:
        for source_type in ("rtmpConn", "rtspSession", "webRTCSession", "unknownSource"):
            with self.subTest(source_type=source_type):
                payload = self.legacy_path_payload(
                    guest={
                        "name": "guest-computer",
                        "ready": False,
                        "source": {"type": source_type, "id": "publisher-id"},
                        "tracks": [],
                        "readers": [],
                    },
                )
                result = self.run_path_contract("preflight", payload)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("source type", result.stderr)

    def test_preflight_rejects_missing_or_duplicate_or_unexpected_paths(self) -> None:
        missing = {"items": [{"name": "anpviz-video", "ready": True}, {"name": "anpviz-main", "ready": True}]}
        duplicate = self.legacy_path_payload(extra_paths=[{
            "name": "guest-computer",
            "ready": False,
            "source": {"type": "rtspSource", "id": ""},
            "tracks": ["H264", "MPEG-4 Audio"],
            "readers": [],
        }])
        unexpected = self.legacy_path_payload(extra_paths=[{"name": "podium-computer", "ready": False}])
        for label, payload in (("missing", missing), ("duplicate", duplicate), ("unexpected", unexpected)):
            with self.subTest(label=label):
                result = self.run_path_contract("preflight", payload)
                self.assertNotEqual(result.returncode, 0)

    def test_preflight_preserves_reader_anpviz_and_podium_conflict_guards(self) -> None:
        readers = self.legacy_path_payload(guest={
            "name": "guest-computer",
            "ready": True,
            "source": {"type": "rtspSource", "id": ""},
            "tracks": ["H264", "MPEG-4 Audio"],
            "readers": [{"type": "hlsSession", "id": "reader-id"}],
        })
        anpviz = self.legacy_path_payload()
        anpviz["items"][0]["ready"] = False
        podium = self.legacy_path_payload(extra_paths=[{"name": "podium-computer", "ready": False}])
        for label, payload, expected_error in (
            ("readers", readers, "active readers"),
            ("anpviz", anpviz, "required Anpviz path is not ready"),
            ("podium", podium, "unexpected preflight MediaMTX paths"),
        ):
            with self.subTest(label=label):
                result = self.run_path_contract("preflight", payload)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(expected_error, result.stderr)

    def test_preflight_rejects_malformed_legacy_config_and_tracks(self) -> None:
        wrong_config = self.run_path_contract(
            "preflight",
            self.legacy_path_payload(),
            "paths:\n  guest-computer:\n    source: publisher\n",
        )
        wrong_tracks = self.legacy_path_payload()
        wrong_tracks["items"][2]["tracks"] = ["H264", "G711"]
        for label, result in (("config", wrong_config), ("tracks", self.run_path_contract("preflight", wrong_tracks))):
            with self.subTest(label=label):
                self.assertNotEqual(result.returncode, 0)

    def test_post_cutover_accepts_only_the_complete_final_topology(self) -> None:
        result = self.run_path_contract(
            "post",
            self.post_cutover_payload(),
            self.post_cutover_config(),
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_post_cutover_rejects_a_not_ready_or_missing_podium(self) -> None:
        not_ready = self.post_cutover_payload()
        not_ready["items"][2]["ready"] = False
        missing = self.post_cutover_payload()
        missing["items"] = [item for item in missing["items"] if item["name"] != "podium-computer"]
        for label, payload in (("not-ready", not_ready), ("missing", missing)):
            with self.subTest(label=label):
                result = self.run_path_contract("post", payload, self.post_cutover_config())
                self.assertNotEqual(result.returncode, 0)

    def test_post_cutover_rejects_a_podium_with_wrong_source_tracks_or_config(self) -> None:
        wrong_source = self.post_cutover_payload()
        wrong_source["items"][2]["source"] = {"type": "rtmpConn", "id": "publisher"}
        wrong_tracks = self.post_cutover_payload()
        wrong_tracks["items"][2]["tracks"] = ["H264"]
        cases = (
            ("source", wrong_source, self.post_cutover_config()),
            ("tracks", wrong_tracks, self.post_cutover_config()),
            ("config", self.post_cutover_payload(), self.post_cutover_config(podium_source="publisher")),
        )
        for label, payload, config in cases:
            with self.subTest(label=label):
                result = self.run_path_contract("post", payload, config)
                self.assertNotEqual(result.returncode, 0)

    def test_post_cutover_rejects_an_active_or_residual_guest_publisher(self) -> None:
        active_rtmp = self.post_cutover_payload()
        active_rtmp["items"][3] = {
            "name": "guest-computer",
            "ready": True,
            "source": {"type": "rtmpConn", "id": "rtmp-publisher"},
            "readers": [],
        }
        active_other = self.post_cutover_payload()
        active_other["items"][3] = {
            "name": "guest-computer",
            "ready": True,
            "source": {"type": "webRTCSession", "id": "webrtc-publisher"},
            "readers": [],
        }
        residual_source = self.post_cutover_payload()
        residual_source["items"][3] = {
            "name": "guest-computer",
            "ready": False,
            "source": {"type": "rtspSession", "id": "residual-session"},
            "readers": [],
        }
        for label, payload in (("rtmp", active_rtmp), ("other", active_other), ("residual", residual_source)):
            with self.subTest(label=label):
                result = self.run_path_contract("post", payload, self.post_cutover_config())
                self.assertNotEqual(result.returncode, 0)

    def test_post_cutover_rejects_a_guest_with_wrong_config_or_readers(self) -> None:
        readers = self.post_cutover_payload()
        readers["items"][3]["readers"] = [{"type": "hlsSession", "id": "reader"}]
        wrong_config = self.run_path_contract(
            "post",
            self.post_cutover_payload(),
            self.post_cutover_config(guest_source="rtsp://legacy.example.invalid/main/av"),
        )
        for label, result in (("readers", self.run_path_contract("post", readers, self.post_cutover_config())), ("config", wrong_config)):
            with self.subTest(label=label):
                self.assertNotEqual(result.returncode, 0)

    def test_post_cutover_preserves_anpviz_readiness_as_a_required_gate(self) -> None:
        result = self.run_path_contract(
            "post",
            self.post_cutover_payload(anpviz_ready=False),
            self.post_cutover_config(),
        )
        self.assertNotEqual(result.returncode, 0)

    def run_post_validation_fixture(self, payloads: list[dict], attempts: int) -> subprocess.CompletedProcess[str]:
        bash = git_bash()
        if bash is None:  # pragma: no cover - only for unusually minimal hosts
            self.skipTest("bash is unavailable")

        with tempfile.TemporaryDirectory() as temporary_dir:
            temporary = Path(temporary_dir)
            stack = temporary / "media-stack"
            response_dir = temporary / "responses"
            response_counter = temporary / "response-count"
            stack.mkdir()
            response_dir.mkdir()
            (stack / "mediamtx.yml").write_text(self.post_cutover_config(), encoding="utf-8")
            for index, payload in enumerate(payloads, start=1):
                (response_dir / f"{index}.json").write_text(json.dumps(payload), encoding="utf-8")

            script = SCRIPT_PATH.read_text(encoding="utf-8").split("while (( $# > 0 )); do")[0]
            script = (
                script.replace("STACK=/opt/mbfd/media-stack", f"STACK='{bash_path(bash, stack)}'")
                .replace("POST_VALIDATION_ATTEMPTS=25", f"POST_VALIDATION_ATTEMPTS={attempts}")
            )
            fixture = temporary / "verify-post.sh"
            fixture.write_text(
                script
                + "\nprintf 0 > \"$RESPONSE_COUNTER\"\n"
                + "docker() {\n"
                + "  if [[ \"$1\" == inspect ]]; then\n"
                + "    case \"$3\" in\n"
                + "      *State.Running*) printf true ;;\n"
                + "      *State.Restarting*) printf false ;;\n"
                + "      *Image*) printf '%s' \"$EXPECTED_IMAGE_ID\" ;;\n"
                + "    esac\n"
                + "  elif [[ \"$1\" == exec ]]; then\n"
                + "    printf '%s' \"$EXPECTED_MEDIAMTX_VERSION\"\n"
                + "  else\n"
                + "    return 99\n"
                + "  fi\n"
                + "}\n"
                + "curl() {\n"
                + "  local response_index file\n"
                + "  response_index=$(( $(cat \"$RESPONSE_COUNTER\") + 1 ))\n"
                + "  printf '%s' \"$response_index\" > \"$RESPONSE_COUNTER\"\n"
                + "  file=\"$RESPONSE_DIR/$response_index.json\"\n"
                + "  [[ -f \"$file\" ]] || file=\"$RESPONSE_DIR/$(ls \"$RESPONSE_DIR\" | sort -n | tail -n 1)\"\n"
                + "  cat \"$file\"\n"
                + "}\n"
                + "sleep() { :; }\n"
                + "EXPECTED_IMAGE_ID='sha256:fixture'\n"
                + "if verify_post_cutover; then printf 'VALIDATION=PASS\\n'; else printf 'VALIDATION=FAIL\\n'; fi\n",
                encoding="utf-8",
            )
            return subprocess.run(
                [bash, "-lc", 'export RESPONSE_DIR="$FIXTURE_RESPONSES"; exec bash "$FIXTURE_SCRIPT"'],
                env={
                    **os.environ,
                    "FIXTURE_RESPONSES": bash_path(bash, response_dir),
                    "RESPONSE_COUNTER": bash_path(bash, response_counter),
                    "FIXTURE_SCRIPT": bash_path(bash, fixture),
                },
                capture_output=True,
                text=True,
                timeout=10,
            )

    def test_post_cutover_retries_until_the_complete_topology_is_ready(self) -> None:
        initially_unready = self.post_cutover_payload()
        initially_unready["items"][2]["ready"] = False
        result = self.run_post_validation_fixture(
            [initially_unready, self.post_cutover_payload()],
            attempts=2,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Post-cutover final topology became valid after 2/2 checks.", result.stdout)
        self.assertIn("VALIDATION=PASS", result.stdout)

    def test_post_cutover_times_out_when_the_complete_topology_never_becomes_valid(self) -> None:
        invalid = self.post_cutover_payload()
        invalid["items"][2]["ready"] = False
        result = self.run_post_validation_fixture([invalid], attempts=2)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("complete post-cutover topology did not become valid within 2 checks", result.stderr)
        self.assertIn("VALIDATION=FAIL", result.stdout)

    def test_apply_invalid_post_topology_fails_and_invokes_feature_rollback(self) -> None:
        """Exercise run_apply's real post validator and ERR-trap rollback path."""

        bash = git_bash()
        if bash is None:  # pragma: no cover - only for unusually minimal hosts
            self.skipTest("bash is unavailable")

        with tempfile.TemporaryDirectory() as temporary_dir:
            temporary = Path(temporary_dir)
            stack = temporary / "media-stack"
            snapshot = temporary / "snapshot"
            response = temporary / "invalid-paths.json"
            final_config = temporary / "final-mediamtx.yml"
            rollback_log = temporary / "rollback.log"
            stack.mkdir()
            (snapshot / "opt" / "media-stack").mkdir(parents=True)
            prior_config = "paths:\n  guest-computer:\n    source: rtsp://legacy.example.invalid/main/av\n"
            (stack / "mediamtx.yml").write_text(prior_config, encoding="utf-8")
            (snapshot / "opt" / "media-stack" / "mediamtx.yml").write_text(prior_config, encoding="utf-8")
            final_config.write_text(self.post_cutover_config(), encoding="utf-8")
            invalid = self.post_cutover_payload()
            invalid["items"][2]["ready"] = False
            response.write_text(json.dumps(invalid), encoding="utf-8")
            rollback = temporary / "rollback-live-sources-cutover.sh"
            rollback.write_text(
                "#!/usr/bin/env bash\n"
                "set -euo pipefail\n"
                "cp \"$1/opt/media-stack/mediamtx.yml\" \"$TARGET_ACTIVE_CONFIG\"\n"
                "printf rollback-invoked > \"$ROLLBACK_LOG\"\n",
                encoding="utf-8",
            )
            rollback.chmod(0o755)

            script = SCRIPT_PATH.read_text(encoding="utf-8").split("while (( $# > 0 )); do")[0]
            script = (
                script.replace("STACK=/opt/mbfd/media-stack", f"STACK='{bash_path(bash, stack)}'")
                .replace("POST_VALIDATION_ATTEMPTS=25", "POST_VALIDATION_ATTEMPTS=1")
            )
            fixture = temporary / "apply-invalid-post.sh"
            fixture.write_text(
                script
                + "\nFEATURE_ROLLBACK_SCRIPT=\"$FIXTURE_ROLLBACK\"\n"
                + "SNAPSHOT_DIR=\"$FIXTURE_SNAPSHOT\"\n"
                + "GUEST_FIREWALL_PRESENT_BEFORE_CUTOVER=false\n"
                + "create_workdir() { :; }\n"
                + "create_rollback_ready_snapshot() { :; }\n"
                + "render_to_temporary_location() { :; }\n"
                + "validate_rendered_contract() { :; }\n"
                + "prepare_isolated_parser_config() { :; }\n"
                + "validate_with_exact_mediamtx() { :; }\n"
                + "install_active_mediamtx_files() { MUTATION_STARTED=1; cp \"$FIXTURE_FINAL_CONFIG\" \"$ACTIVE_CONFIG\"; }\n"
                + "recreate_mediamtx() { :; }\n"
                + "docker() {\n"
                + "  if [[ \"$1\" == inspect ]]; then\n"
                + "    case \"$3\" in\n"
                + "      *State.Running*) printf true ;;\n"
                + "      *State.Restarting*) printf false ;;\n"
                + "      *Image*) printf '%s' \"$EXPECTED_IMAGE_ID\" ;;\n"
                + "    esac\n"
                + "  elif [[ \"$1\" == exec ]]; then printf '%s' \"$EXPECTED_MEDIAMTX_VERSION\"; else return 99; fi\n"
                + "}\n"
                + "curl() { cat \"$FIXTURE_RESPONSE\"; }\n"
                + "sleep() { :; }\n"
                + "EXPECTED_IMAGE_ID='sha256:fixture'\n"
                + "run_apply\n",
                encoding="utf-8",
            )
            result = subprocess.run(
                [bash, "-lc", 'exec bash "$FIXTURE_SCRIPT"'],
                env={
                    **os.environ,
                    "FIXTURE_SCRIPT": bash_path(bash, fixture),
                    "FIXTURE_ROLLBACK": bash_path(bash, rollback),
                    "FIXTURE_SNAPSHOT": bash_path(bash, snapshot),
                    "FIXTURE_FINAL_CONFIG": bash_path(bash, final_config),
                    "FIXTURE_RESPONSE": bash_path(bash, response),
                    "TARGET_ACTIVE_CONFIG": bash_path(bash, stack / "mediamtx.yml"),
                    "ROLLBACK_LOG": bash_path(bash, rollback_log),
                },
                capture_output=True,
                text=True,
                timeout=10,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("complete post-cutover topology did not become valid", result.stderr)
            self.assertIn("invoking verified feature rollback", result.stderr)
            self.assertEqual((stack / "mediamtx.yml").read_text(encoding="utf-8"), prior_config)
            self.assertEqual(rollback_log.read_text(encoding="utf-8"), "rollback-invoked")

    def test_help_is_safe_and_apply_is_explicitly_authorized(self) -> None:
        bash = git_bash()
        if bash is None:  # pragma: no cover - only for unusually minimal hosts
            self.skipTest("bash is unavailable")

        result = subprocess.run(
            [bash, bash_path(bash, SCRIPT_PATH), "--help"],
            check=False,
            capture_output=True,
            text=True,
            timeout=10,
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("--dry-run", result.stdout)
        self.assertIn("--apply", result.stdout)
        self.assertIn('MBFD_LIVE_SOURCES_CUTOVER_AUTHORIZATION=YES', self.script)
        self.assertIn('MODE="dry-run"', self.script)

    def test_python_renderer_requires_a_regular_readable_file_not_execute_permission(self) -> None:
        self.assertIn(
            '[[ -f "$RENDERER" && -r "$RENDERER" && -r "$TEMPLATE" ]] || die "rendering inputs are unavailable"',
            self.script,
        )
        self.assertIn('python3 "$RENDERER" "$ENV_FILE" "$TEMPLATE" "$rendered"', self.script)
        self.assertNotIn('[[ -x "$RENDERER"', self.script)

    def test_snapshot_manifest_captures_the_rollback_contract(self) -> None:
        for token in (
            "rollback-manifest.json",
            '"schema_version": 2',
            '"snapshot_kind"',
            "verified-legacy",
            "pinned-release",
            "opt/media-stack/mediamtx.yml",
            "opt/media-stack/docker-compose.mediamtx.yml",
            "etc/media-stack/camera.env",
            "runtime/mediamtx-inspect.json",
            "runtime/guest-rtmp-firewall-before.json",
            "runtime/ufw-status-numbered.txt",
            '"firewall"',
            '"present_before_cutover"',
            "--print-firewall-plan",
            "--observe-ufw-status",
            "repo_digest",
            "inspect_sha256",
            "SHA256SUMS",
            "SNAPSHOT_VALIDATOR",
            "fresh snapshot validator returned an unexpected kind",
        ):
            with self.subTest(token=token):
                self.assertIn(token, self.script)

    def test_mutating_steps_are_limited_and_ordered(self) -> None:
        script = self.script
        self.assertIn("docker compose -f \"$ACTIVE_COMPOSE\" up -d --no-deps --force-recreate mediamtx", script)
        self.assertIn(
            "ufw allow in from \"$GUEST_FIREWALL_GUEST_IP\" to \"$GUEST_FIREWALL_KAMRUI_IP\" port 1935 proto tcp",
            script,
        )
        self.assertLess(script.index("render_to_temporary_location"), script.index("install_active_mediamtx_files"))
        self.assertLess(script.index("install_active_mediamtx_files"), script.index("recreate_mediamtx"))
        self.assertLess(script.index("recreate_mediamtx"), script.index("allow_guest_rtmp_firewall"))
        self.assertIn('bash "$FEATURE_ROLLBACK_SCRIPT" "$SNAPSHOT_DIR"', script)
        self.assertIn('FEATURE_ROLLBACK_SCRIPT="$HERE/scripts/rollback-live-sources-cutover.sh"', script)
        self.assertIn(
            '[[ -r "$FEATURE_ROLLBACK_SCRIPT" ]] || die "verified feature rollback script is unavailable"',
            script,
        )
        self.assertIn("capture_guest_rtmp_firewall_baseline", script)
        self.assertIn("observe_exact_guest_rtmp_rule", script)
        self.assertNotIn("GUEST_FIREWALL_RULE_ADDED", script)
        self.assertNotIn("revoke_guest_rtmp_firewall_after_failure", script)

    def test_broad_or_unrelated_administration_is_absent(self) -> None:
        # Keep this list to executable commands/paths, rather than prose, so a
        # future safety comment cannot hide an implementation regression.
        for forbidden in (
            "upgrade.sh",
            "mbfd-media-admin",
            "systemctl",
            "useradd",
            "groupadd",
            "usermod",
            "setfacl",
            "visudo",
            "sudoers",
            "recording-broker",
            "restart-camera-api",
            "camera-api/",
            "npm install",
            "npm ci",
            "docker compose down",
            "--remove-orphans",
            "docker restart",
            "ufw --force reset",
            "ufw-apply",
            "jumbo",
        ):
            with self.subTest(forbidden=forbidden):
                self.assertNotIn(forbidden, self.script)

    def test_documentation_makes_this_the_only_cutover_workflow(self) -> None:
        readme = README_PATH.read_text(encoding="utf-8")
        documentation = DOCUMENTATION_PATH.read_text(encoding="utf-8")

        self.assertIn("deploy-live-sources-cutover.sh", readme)
        self.assertIn("never use `scripts/upgrade.sh deploy`", readme)
        self.assertIn("sudo bash ./scripts/deploy-live-sources-cutover.sh --dry-run", documentation)
        self.assertIn("bash ./scripts/deploy-live-sources-cutover.sh --apply", documentation)
        self.assertIn("rollback-live-sources-cutover.sh", documentation)
        self.assertIn("same feature-specific rollback wrapper", documentation)
        self.assertNotIn("invokes `scripts/rollback.sh` with the fresh verified snapshot", documentation)
        self.assertIn("Cannot perform", documentation)
        self.assertIn("Physical acceptance remains a separate gate", documentation)

    def test_fresh_legacy_snapshot_producer_validates_end_to_end(self) -> None:
        """Exercise the real snapshot producer with a fake Docker binary only."""

        bash = git_bash()
        if bash is None:  # pragma: no cover - only for unusually minimal hosts
            self.skipTest("bash is unavailable")

        with tempfile.TemporaryDirectory() as temporary_dir:
            temporary = Path(temporary_dir)
            stack = temporary / "media-stack"
            environment_dir = temporary / "etc-media-stack"
            approved_root = temporary / "approved-backups"
            fake_bin = temporary / "fake-bin"
            runtime = temporary / "runtime"
            workdir = temporary / "workdir"
            for directory in (stack, environment_dir, approved_root, fake_bin, runtime, workdir):
                directory.mkdir(parents=True, exist_ok=True)

            original_config = b"paths:\n  anpviz-main:\n    source: publisher\n"
            original_compose = b"services:\n  mediamtx:\n    image: bluenviron/mediamtx:latest\n"
            original_environment = (
                b"FIXTURE_ONLY=not-a-production-secret\n"
                b"GUEST_RTMP_PUBLISHER_LAN_IP=192.168.1.50\n"
                b"KAMRUI_LAN_IP=192.168.1.122\n"
            )
            (stack / "mediamtx.yml").write_bytes(original_config)
            (stack / "docker-compose.mediamtx.yml").write_bytes(original_compose)
            (environment_dir / "camera.env").write_bytes(original_environment)

            (fake_bin / "docker").write_text(
                "#!/usr/bin/env bash\n"
                "set -euo pipefail\n"
                "if [[ \"$1\" == inspect && \"$2\" == mbfd-mediamtx ]]; then\n"
                "  printf '%s\\n' '[{\"Image\":\"'\"$FAKE_IMAGE_ID\"'\",\"State\":{\"StartedAt\":\"'\"$FAKE_STARTED_AT\"'\"}}]'\n"
                "  exit 0\n"
                "fi\n"
                "printf 'unexpected fake docker command: %s\\n' \"$*\" >&2\n"
                "exit 99\n",
                encoding="utf-8",
            )
            (fake_bin / "docker").chmod(0o755)
            (fake_bin / "ufw").write_text(
                "#!/usr/bin/env bash\n"
                "set -euo pipefail\n"
                "[[ \"$1\" == status && \"$2\" == numbered ]] || exit 98\n"
                "printf '%s\\n' 'Status: active'\n",
                encoding="utf-8",
            )
            (fake_bin / "ufw").chmod(0o755)
            (fake_bin / "install").write_text(
                "#!/usr/bin/env bash\n"
                "set -euo pipefail\n"
                "make_directory=false\n"
                "arguments=()\n"
                "while (( $# > 0 )); do\n"
                "  case \"$1\" in\n"
                "    -d) make_directory=true ;;\n"
                "    -m) shift ;;\n"
                "    *) arguments+=(\"$1\") ;;\n"
                "  esac\n"
                "  shift\n"
                "done\n"
                "if [[ \"$make_directory\" == true ]]; then\n"
                "  mkdir -p \"${arguments[@]}\"\n"
                "else\n"
                "  source=\"${arguments[$((${#arguments[@]} - 2))]}\"\n"
                "  destination=\"${arguments[$((${#arguments[@]} - 1))]}\"\n"
                "  mkdir -p \"$(dirname \"$destination\")\"\n"
                "  cp \"$source\" \"$destination\"\n"
                "fi\n",
                encoding="utf-8",
            )
            (fake_bin / "install").chmod(0o755)

            script = SCRIPT_PATH.read_text(encoding="utf-8").split("while (( $# > 0 )); do")[0]
            stack_shell = bash_path(bash, stack)
            environment_shell = bash_path(bash, environment_dir / "camera.env")
            approved_shell = bash_path(bash, approved_root)
            workdir_shell = bash_path(bash, workdir)
            script = (
                script.replace("STACK=/opt/mbfd/media-stack", f"STACK='{stack_shell}'")
                .replace("ENV_FILE=/etc/mbfd/media-stack/camera.env", f"ENV_FILE='{environment_shell}'")
                .replace("SNAPSHOT_ROOT=/home/peter/mbfd-backups", f"SNAPSHOT_ROOT='{approved_shell}'")
                .replace(
                    'SNAPSHOT_VALIDATOR="$HERE/scripts/validate-rollback-snapshot.py"',
                    f"SNAPSHOT_VALIDATOR='{bash_path(bash, ROLLBACK_VALIDATOR_PATH)}'",
                )
            )
            fixture_script = runtime / "produce-snapshot.sh"
            fixture_script.write_text(
                script
                + "\nWORKDIR='"
                + workdir_shell
                + "'\nSNAPSHOT_DIR=\"$SNAPSHOT_ROOT/fresh-legacy\"\n"
                + "SNAPSHOT_KIND=verified-legacy\n"
                + "CURRENT_VERSION=v1.19.3\n"
                + f"CURRENT_IMAGE_ID='{IMAGE_ID}'\n"
                + f"CURRENT_REPO_DIGEST='{REPO_DIGEST}'\n"
                + f"CURRENT_STARTED_AT='{STARTED_AT}'\n"
                + "create_rollback_ready_snapshot\n",
                encoding="utf-8",
            )

            result = subprocess.run(
                [
                    bash,
                    "-lc",
                    'PATH="$FAKE_BIN:$PATH"; export PATH; exec bash "$FIXTURE_SCRIPT"',
                ],
                env={
                    **os.environ,
                    "FAKE_BIN": bash_path(bash, fake_bin),
                    "FIXTURE_SCRIPT": bash_path(bash, fixture_script),
                    "FAKE_IMAGE_ID": IMAGE_ID,
                    "FAKE_STARTED_AT": STARTED_AT,
                },
                capture_output=True,
                text=True,
                timeout=30,
            )
            self.assertEqual(result.returncode, 0, result.stderr + result.stdout)

            snapshot = approved_root / "fresh-legacy"
            plan = ROLLBACK_VALIDATOR.resolve_snapshot(snapshot, [approved_root])
            self.assertEqual(plan.snapshot_kind, "verified-legacy")
            self.assertEqual(plan.restore_image, REPO_DIGEST)
            self.assertIsNotNone(plan.guest_rtmp_firewall)
            assert plan.guest_rtmp_firewall is not None
            self.assertEqual(plan.guest_rtmp_firewall.guest_ip, "192.168.1.50")
            self.assertFalse(plan.guest_rtmp_firewall.present_before_cutover)
            self.assertEqual(
                (snapshot / "opt/media-stack/docker-compose.mediamtx.yml").read_bytes(),
                original_compose,
            )
            manifest = json.loads((snapshot / "rollback-manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(
                manifest["artifacts"],
                [
                    "opt/media-stack/mediamtx.yml",
                    "opt/media-stack/docker-compose.mediamtx.yml",
                    "etc/media-stack/camera.env",
                    "runtime/mediamtx-inspect.json",
                    "runtime/guest-rtmp-firewall-before.json",
                    "runtime/ufw-status-numbered.txt",
                ],
            )
            self.assertEqual(manifest["schema_version"], 2)
            self.assertEqual(
                manifest["firewall"]["guest_rtmp"]["status_artifact"],
                "runtime/ufw-status-numbered.txt",
            )


if __name__ == "__main__":
    unittest.main()
