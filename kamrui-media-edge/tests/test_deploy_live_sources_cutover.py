"""Policy regression tests for the narrow live-source cutover workflow.

These tests intentionally inspect the deployment script rather than executing
it: its apply mode is designed for an approved KAMRUI maintenance window only.
"""

from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import re
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

    @staticmethod
    def set_bash_mode(bash: str, path: Path, mode: str) -> None:
        subprocess.run(
            [bash, "-lc", 'chmod "$MODE" "$TARGET"'],
            env={
                **os.environ,
                "MODE": mode,
                "TARGET": bash_path(bash, path),
            },
            check=True,
            capture_output=True,
            text=True,
        )

    @staticmethod
    def bash_file_is_readable(bash: str, path: Path) -> bool:
        result = subprocess.run(
            [bash, "-lc", 'test -r "$TARGET"'],
            env={
                **os.environ,
                "TARGET": bash_path(bash, path),
            },
            check=False,
            capture_output=True,
            text=True,
        )
        return result.returncode == 0

    def run_preflight_fixture(
        self,
        bash: str,
        *,
        renderer_exists: bool = True,
        renderer_mode: str = "0644",
        template_exists: bool = True,
        template_mode: str = "0644",
        require_unreadable_renderer: bool = False,
        require_unreadable_template: bool = False,
    ) -> subprocess.CompletedProcess[str]:
        """Run only the real preflight function against a disposable fake host."""

        with tempfile.TemporaryDirectory() as temporary_dir:
            temporary = Path(temporary_dir)
            edge = temporary / "edge"
            scripts = edge / "scripts"
            stack = temporary / "media-stack"
            fake_bin = temporary / "fake-bin"
            snapshot_root = temporary / "approved-backups"
            environment = temporary / "camera.env"
            for directory in (scripts, stack, fake_bin, snapshot_root):
                directory.mkdir(parents=True, exist_ok=True)

            expected_image_match = re.search(
                r"^EXPECTED_MEDIAMTX_IMAGE=(?P<image>[^\r\n]+)$",
                self.script,
                re.MULTILINE,
            )
            self.assertIsNotNone(expected_image_match)
            assert expected_image_match is not None
            expected_image = expected_image_match.group("image")
            expected_repo_digest = "bluenviron/mediamtx@" + expected_image.split("@", 1)[1]

            renderer = scripts / "render-mediamtx-config.py"
            if renderer_exists:
                renderer.write_text("# fixture renderer\n", encoding="utf-8")
                self.set_bash_mode(bash, renderer, renderer_mode)
                if require_unreadable_renderer and self.bash_file_is_readable(bash, renderer):
                    self.skipTest("the local Bash runtime cannot reliably model an unreadable file")

            template = edge / "mediamtx.yml.tpl"
            if template_exists:
                template.write_text("paths: {}\n", encoding="utf-8")
                self.set_bash_mode(bash, template, template_mode)
                if require_unreadable_template and self.bash_file_is_readable(bash, template):
                    self.skipTest("the local Bash runtime cannot reliably model an unreadable file")

            (edge / "docker-compose.mediamtx.yml").write_text(
                f"services:\n  mediamtx:\n    image: {expected_image}\n",
                encoding="utf-8",
            )
            for rollback_file in (
                scripts / "rollback.sh",
                scripts / "rollback-live-sources-cutover.sh",
                scripts / "validate-rollback-snapshot.py",
            ):
                rollback_file.write_text("# fixture prerequisite\n", encoding="utf-8")
                self.set_bash_mode(bash, rollback_file, "0644")

            (stack / "mediamtx.yml").write_text("paths: {}\n", encoding="utf-8")
            (stack / "docker-compose.mediamtx.yml").write_text(
                f"services:\n  mediamtx:\n    image: {expected_image}\n",
                encoding="utf-8",
            )
            environment.write_text("FIXTURE_ONLY=yes\n", encoding="utf-8")

            fake_commands = {
                "docker": """#!/usr/bin/env bash
set -euo pipefail
if [[ \"$1\" == compose && \"${2:-}\" == version ]]; then
  exit 0
fi
if [[ \"$1\" == inspect && \"${2:-}\" == mbfd-mediamtx ]]; then
  printf '%s\\n' '{}'
  exit 0
fi
if [[ \"$1\" == exec && \"${2:-}\" == mbfd-mediamtx ]]; then
  printf '%s\\n' v1.19.3
  exit 0
fi
if [[ \"$1\" == inspect && \"${2:-}\" == --format && \"${3:-}\" == '{{.Image}}' ]]; then
  printf '%s\\n' \"$FAKE_IMAGE_ID\"
  exit 0
fi
if [[ \"$1\" == inspect && \"${2:-}\" == --format && \"${3:-}\" == '{{.State.StartedAt}}' ]]; then
  printf '%s\\n' \"$FAKE_STARTED_AT\"
  exit 0
fi
if [[ \"$1\" == image && \"${2:-}\" == inspect ]]; then
  printf '%s\\n' \"$FAKE_REPO_DIGEST\"
  exit 0
fi
printf 'unexpected fake docker command: %s\\n' \"$*\" >&2
exit 99
""",
                "hostnamectl": "#!/usr/bin/env bash\nprintf '%s\\n' fixture-host\n",
                "curl": """#!/usr/bin/env bash
printf '%s' '{"items":[{"name":"anpviz-video","ready":true},{"name":"anpviz-main","ready":true},{"name":"guest-computer","ready":false}]}'
""",
                "ufw": "#!/usr/bin/env bash\nexit 0\n",
            }
            for name, contents in fake_commands.items():
                command = fake_bin / name
                command.write_text(contents, encoding="utf-8")
                self.set_bash_mode(bash, command, "0755")

            script = self.script.split("while (( $# > 0 )); do", 1)[0]
            script = script.replace(
                'HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"',
                f"HERE='{bash_path(bash, edge)}'",
            )
            script = script.replace("STACK=/opt/mbfd/media-stack", f"STACK='{bash_path(bash, stack)}'")
            script = script.replace(
                "ENV_FILE=/etc/mbfd/media-stack/camera.env",
                f"ENV_FILE='{bash_path(bash, environment)}'",
            )
            script = script.replace(
                "SNAPSHOT_ROOT=/home/peter/mbfd-backups",
                f"SNAPSHOT_ROOT='{bash_path(bash, snapshot_root)}'",
            )
            script = script.replace("EXPECTED_HOSTNAME=peter-Default-string", "EXPECTED_HOSTNAME=fixture-host")
            privilege_guard = '  (( EUID == 0 )) || die "run with sudo only during an approved maintenance window"\n'
            self.assertIn(privilege_guard, script)
            script = script.replace(privilege_guard, "  : # fixture bypasses the production sudo gate\n")
            fixture_script = temporary / "run-preflight.sh"
            fixture_script.write_text(script + "\npreflight\nprintf 'PREFLIGHT_SUCCESS\\n'\n", encoding="utf-8")

            return subprocess.run(
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
                    "FAKE_REPO_DIGEST": expected_repo_digest,
                    "FAKE_STARTED_AT": STARTED_AT,
                },
                check=False,
                capture_output=True,
                text=True,
                timeout=30,
            )

    def test_preflight_accepts_readable_non_executable_renderer(self) -> None:
        bash = git_bash()
        if bash is None:  # pragma: no cover - only for unusually minimal hosts
            self.skipTest("bash is unavailable")

        result = self.run_preflight_fixture(bash, renderer_mode="0644")

        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertIn("PREFLIGHT_SUCCESS", result.stdout)

    def test_preflight_rejects_missing_renderer_and_template(self) -> None:
        bash = git_bash()
        if bash is None:  # pragma: no cover - only for unusually minimal hosts
            self.skipTest("bash is unavailable")

        for fixture in (
            {"renderer_exists": False},
            {"template_exists": False},
        ):
            with self.subTest(fixture=fixture):
                result = self.run_preflight_fixture(bash, **fixture)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("ERROR: rendering inputs are unavailable", result.stderr)

    def test_preflight_rejects_unreadable_renderer_and_template_when_supported(self) -> None:
        bash = git_bash()
        if bash is None:  # pragma: no cover - only for unusually minimal hosts
            self.skipTest("bash is unavailable")

        for fixture in (
            {"renderer_mode": "0000", "require_unreadable_renderer": True},
            {"template_mode": "0000", "require_unreadable_template": True},
        ):
            with self.subTest(fixture=fixture):
                result = self.run_preflight_fixture(bash, **fixture)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("ERROR: rendering inputs are unavailable", result.stderr)

    def test_renderer_preflight_contract_is_python_file_not_direct_execution(self) -> None:
        self.assertIn('[[ -f "$RENDERER" && -r "$RENDERER" && -r "$TEMPLATE" ]]', self.script)
        self.assertIn('python3 "$RENDERER" "$ENV_FILE" "$TEMPLATE" "$rendered"', self.script)
        for existing_guard in (
            "verify_path_contract preflight",
            '[[ -d "$SNAPSHOT_ROOT" ]] || die "approved snapshot root is unavailable"',
            '[[ -r "$ROLLBACK_SCRIPT" ]] || die "verified rollback script is unavailable"',
            '[[ -r "$FEATURE_ROLLBACK_SCRIPT" ]] || die "verified feature rollback script is unavailable"',
            '[[ -r "$SNAPSHOT_VALIDATOR" ]] || die "rollback snapshot validator is unavailable"',
        ):
            with self.subTest(existing_guard=existing_guard):
                self.assertIn(existing_guard, self.script)

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
