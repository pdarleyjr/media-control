"""Fake-UFW regressions for manual live-source cutover rollback.

The feature-specific rollback owns only the exact Guest-to-KAMRUI RTMP rule.
Every executable scenario uses a disposable fake UFW binary and a fake
source-only rollback primitive; it cannot contact KAMRUI or mutate a real
firewall.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest


EDGE_ROOT = Path(__file__).resolve().parents[1]
WRAPPER_PATH = EDGE_ROOT / "scripts" / "rollback-live-sources-cutover.sh"
VALIDATOR_PATH = EDGE_ROOT / "scripts" / "validate-rollback-snapshot.py"
GENERIC_ROLLBACK_PATH = EDGE_ROOT / "scripts" / "rollback.sh"

IMAGE_ID = "sha256:" + "a" * 64
REPO_DIGEST = "bluenviron/mediamtx@sha256:" + "b" * 64
STARTED_AT = "2026-08-27T12:00:00.000000000Z"
GUEST_IP = "192.168.1.50"
KAMRUI_IP = "192.168.1.122"


def load_validator():
    spec = importlib.util.spec_from_file_location("live_sources_firewall_validator", VALIDATOR_PATH)
    if spec is None or spec.loader is None:  # pragma: no cover - test setup failure
        raise RuntimeError("unable to load rollback snapshot validator")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


VALIDATOR = load_validator()


def git_bash() -> str | None:
    if os.name == "nt":
        candidate = Path(r"C:\Program Files\Git\bin\bash.exe")
        return str(candidate) if candidate.is_file() else None
    return shutil.which("bash")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def write_cutover_snapshot(
    snapshot: Path,
    *,
    present_before_cutover: bool,
    guest_ip: str = GUEST_IP,
    kamrui_ip: str = KAMRUI_IP,
    baseline_status_rules: list[str] | None = None,
) -> None:
    """Write a checksum-complete cutover fixture with no live credentials."""

    firewall_payload = {
        "action": "ALLOW",
        "direction": "IN",
        "guest_ip": guest_ip,
        "kamrui_ip": kamrui_ip,
        "port": 1935,
        "protocol": "tcp",
        "present_before_cutover": present_before_cutover,
    }
    if baseline_status_rules is None:
        baseline_status_rules = (
            [f"[ 1] {kamrui_ip} 1935/tcp ALLOW IN {guest_ip}"]
            if present_before_cutover
            else []
        )
    artifacts = {
        "opt/media-stack/mediamtx.yml": b"paths:\n  anpviz-main:\n    source: publisher\n",
        "opt/media-stack/docker-compose.mediamtx.yml": (
            "services:\n  mediamtx:\n    image: bluenviron/mediamtx:latest\n".encode("utf-8")
        ),
        "etc/media-stack/camera.env": b"FIXTURE_ONLY=not-a-production-secret\n",
        "runtime/mediamtx-inspect.json": json.dumps(
            {"Image": IMAGE_ID, "State": {"StartedAt": STARTED_AT}}, sort_keys=True
        ).encode("utf-8"),
        "runtime/guest-rtmp-firewall-before.json": (
            json.dumps(firewall_payload, sort_keys=True) + "\n"
        ).encode("utf-8"),
        "runtime/ufw-status-numbered.txt": (
            "Status: active\n" + "\n".join(baseline_status_rules) + "\n"
        ).encode("utf-8"),
    }
    for relative, content in artifacts.items():
        path = snapshot / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)

    hashes = {relative: sha256_bytes(content) for relative, content in artifacts.items()}
    manifest = {
        "schema_version": 2,
        "snapshot_kind": "verified-legacy",
        "artifacts": list(artifacts),
        "sha256": hashes,
        "runtime": {
            "mediamtx": {
                "version": "v1.19.3",
                "image_id": IMAGE_ID,
                "repo_digest": REPO_DIGEST,
                "started_at": STARTED_AT,
                "inspect_sha256": hashes["runtime/mediamtx-inspect.json"],
            }
        },
        "firewall": {
            "guest_rtmp": {
                **firewall_payload,
                "artifact": "runtime/guest-rtmp-firewall-before.json",
                "status_artifact": "runtime/ufw-status-numbered.txt",
            }
        },
    }
    (snapshot / "rollback-manifest.json").write_text(
        json.dumps(manifest, sort_keys=True, indent=2) + "\n", encoding="utf-8"
    )
    (snapshot / "SHA256SUMS").write_text(
        "".join(f"{digest}  {relative}\n" for relative, digest in hashes.items()),
        encoding="utf-8",
    )


class LiveSourcesCutoverFirewallRollbackTests(unittest.TestCase):
    bash = git_bash()

    @classmethod
    def setUpClass(cls) -> None:
        cls.wrapper = WRAPPER_PATH.read_text(encoding="utf-8")

    def _bash_path(self, path: Path) -> str:
        assert self.bash is not None
        result = subprocess.run(
            [self.bash, "-lc", 'cygpath -u -- "$TARGET"'],
            env={**os.environ, "TARGET": str(path)},
            check=True,
            capture_output=True,
            text=True,
        )
        return result.stdout.strip()

    def _run_wrapper(
        self,
        *,
        present_before_cutover: bool,
        initial_status_rules: list[str],
        source_rollback_exit: int = 0,
        delete_fails: bool = False,
        guest_ip: str = GUEST_IP,
        kamrui_ip: str = KAMRUI_IP,
    ) -> tuple[subprocess.CompletedProcess[str], str, str, str, str]:
        """Run the source wrapper against fake UFW and a fake lower primitive."""

        assert self.bash is not None
        with tempfile.TemporaryDirectory() as temporary_dir:
            temporary = Path(temporary_dir)
            approved_one = temporary / "approved-one"
            approved_two = temporary / "approved-two"
            snapshot = approved_one / "cutover-snapshot"
            snapshot.mkdir(parents=True)
            approved_two.mkdir()
            write_cutover_snapshot(
                snapshot,
                present_before_cutover=present_before_cutover,
                guest_ip=guest_ip,
                kamrui_ip=kamrui_ip,
            )

            runtime_scripts = temporary / "runtime-scripts"
            fake_bin = temporary / "fake-bin"
            runtime_scripts.mkdir()
            fake_bin.mkdir()
            lower_log = temporary / "lower.log"
            ufw_log = temporary / "ufw.log"
            event_log = temporary / "event.log"
            status_file = temporary / "ufw-status.txt"
            status_file.write_text(
                "Status: active\n" + "\n".join(initial_status_rules) + "\n",
                encoding="utf-8",
            )

            lower_rollback = runtime_scripts / "rollback.sh"
            lower_rollback.write_text(
                "#!/usr/bin/env bash\n"
                "set -euo pipefail\n"
                "printf 'source-rollback %s\\n' \"$1\" >> \"$FAKE_LOWER_LOG\"\n"
                "printf 'source-rollback\\n' >> \"$FAKE_EVENT_LOG\"\n"
                "exit \"${FAKE_SOURCE_ROLLBACK_EXIT:-0}\"\n",
                encoding="utf-8",
            )
            lower_rollback.chmod(0o755)
            shutil.copy2(VALIDATOR_PATH, runtime_scripts / VALIDATOR_PATH.name)

            wrapper_text = self.wrapper.replace(
                "APPROVED_ROOT_ONE=/home/peter/mbfd-backups",
                f"APPROVED_ROOT_ONE='{self._bash_path(approved_one)}'",
            ).replace(
                "APPROVED_ROOT_TWO=/opt/mbfd/media-stack/backups",
                f"APPROVED_ROOT_TWO='{self._bash_path(approved_two)}'",
            ).replace(
                '(( EUID == 0 )) || fail "run this feature-specific rollback with sudo"',
                ": # root requirement bypassed only by the disposable fake-UFW test",
            )
            wrapper = runtime_scripts / WRAPPER_PATH.name
            wrapper.write_text(wrapper_text, encoding="utf-8")
            wrapper.chmod(0o755)

            (fake_bin / "ufw").write_text(
                textwrap.dedent(
                    """\
                    #!/usr/bin/env bash
                    set -euo pipefail
                    printf '%s\\t' "$@" >> "$FAKE_UFW_LOG"
                    printf '\\n' >> "$FAKE_UFW_LOG"
                    printf 'ufw:%s\\n' "$*" >> "$FAKE_EVENT_LOG"
                    state="$FAKE_UFW_STATE"
                    if [[ "$1" == "status" && "$2" == "numbered" ]]; then
                      cat "$state"
                      exit 0
                    fi
                    if [[ "$1" == "--force" && "$2" == "delete" ]]; then
                      [[ "${FAKE_UFW_DELETE_FAIL:-0}" != "1" ]] || exit 75
                      [[ "$3" =~ ^[1-9][0-9]*$ ]] || exit 76
                      python3 - "$state" "$3" <<'PY'
                    from pathlib import Path
                    import sys
                    status = Path(sys.argv[1])
                    number = sys.argv[2]
                    lines = status.read_text(encoding="utf-8").splitlines()
                    matching = [index for index, line in enumerate(lines) if line.startswith(f"[ {number}] ") or line.startswith(f"[{number}] ")]
                    if len(matching) != 1:
                        raise SystemExit(77)
                    del lines[matching[0]]
                    status.write_text("\\n".join(lines) + "\\n", encoding="utf-8")
                    PY
                      exit 0
                    fi
                    if [[ "$1" == "allow" ]]; then
                      [[ "$2" == "in" && "$3" == "from" && "$5" == "to" && "$7" == "port" && "$9" == "proto" && "${10}" == "tcp" ]] || exit 78
                      python3 - "$state" "$4" "$6" <<'PY'
                    from pathlib import Path
                    import sys
                    status = Path(sys.argv[1])
                    guest, kamrui = sys.argv[2:]
                    needle = f"{kamrui} 1935/tcp ALLOW IN {guest}"
                    lines = status.read_text(encoding="utf-8").splitlines()
                    if any(needle in line for line in lines):
                        raise SystemExit(79)
                    lines.append(f"[ 99] {needle}")
                    status.write_text("\\n".join(lines) + "\\n", encoding="utf-8")
                    PY
                      exit 0
                    fi
                    exit 80
                    """
                ),
                encoding="utf-8",
            )
            (fake_bin / "ufw").chmod(0o755)

            default_path = subprocess.run(
                [self.bash, "-lc", 'printf "%s" "$PATH"'],
                check=True,
                capture_output=True,
                text=True,
            ).stdout
            environment = {
                **os.environ,
                "PATH": f"{self._bash_path(fake_bin)}:{default_path}",
                "FAKE_LOWER_LOG": self._bash_path(lower_log),
                "FAKE_SOURCE_ROLLBACK_EXIT": str(source_rollback_exit),
                "FAKE_UFW_LOG": self._bash_path(ufw_log),
                "FAKE_UFW_STATE": self._bash_path(status_file),
                "FAKE_UFW_DELETE_FAIL": "1" if delete_fails else "0",
                "FAKE_EVENT_LOG": self._bash_path(event_log),
            }
            result = subprocess.run(
                [self.bash, self._bash_path(wrapper), self._bash_path(snapshot)],
                env=environment,
                capture_output=True,
                text=True,
                timeout=30,
            )
            return (
                result,
                status_file.read_text(encoding="utf-8"),
                lower_log.read_text(encoding="utf-8") if lower_log.exists() else "",
                ufw_log.read_text(encoding="utf-8") if ufw_log.exists() else "",
                event_log.read_text(encoding="utf-8") if event_log.exists() else "",
            )

    def test_wrapper_is_feature_specific_and_generic_rollback_remains_source_only(self) -> None:
        self.assertIn("validate-rollback-snapshot.py", self.wrapper)
        self.assertIn("--print-firewall-plan", self.wrapper)
        self.assertIn('bash "$ROLLBACK_SCRIPT" "$SNAPSHOT"', self.wrapper)
        self.assertNotIn("ufw --force reset", self.wrapper)
        self.assertNotIn("ufw", GENERIC_ROLLBACK_PATH.read_text(encoding="utf-8"))

    def test_real_ufw_numbered_status_column_order_identifies_only_exact_rule(self) -> None:
        """UFW emits ``To Action From``, with destination before action."""

        baseline = VALIDATOR.GuestRtmpFirewallBaseline(
            action="ALLOW",
            direction="IN",
            guest_ip=GUEST_IP,
            kamrui_ip=KAMRUI_IP,
            port=1935,
            protocol="tcp",
            present_before_cutover=False,
        )
        status = "\n".join(
            (
                "Status: active",
                "",
                "     To                         Action      From",
                "     --                         ------      ----",
                f"[ 7] {KAMRUI_IP} 1935/tcp ALLOW IN {GUEST_IP}",
                f"[ 8] {KAMRUI_IP} 1935/tcp ALLOW IN 192.168.1.77",
                "",
            )
        )

        observation = VALIDATOR.observe_guest_rtmp_ufw_status(status, baseline)

        self.assertEqual(observation.exact_rule_number, 7)
        self.assertNotEqual(observation.unrelated_fingerprint, "")

    def test_v2_firewall_artifact_and_numbered_status_are_cross_checked(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_dir:
            approved = Path(temporary_dir) / "approved"
            snapshot = approved / "cutover-snapshot"
            snapshot.mkdir(parents=True)
            write_cutover_snapshot(snapshot, present_before_cutover=False)

            firewall_artifact = snapshot / "runtime/guest-rtmp-firewall-before.json"
            payload = json.loads(firewall_artifact.read_text(encoding="utf-8"))
            payload["guest_ip"] = "192.168.1.51"
            firewall_artifact.write_text(
                json.dumps(payload, sort_keys=True) + "\n", encoding="utf-8"
            )
            manifest_path = snapshot / "rollback-manifest.json"
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            relative = "runtime/guest-rtmp-firewall-before.json"
            manifest["sha256"][relative] = sha256_bytes(firewall_artifact.read_bytes())
            manifest_path.write_text(
                json.dumps(manifest, sort_keys=True, indent=2) + "\n", encoding="utf-8"
            )
            (snapshot / "SHA256SUMS").write_text(
                "".join(
                    f"{digest}  {path}\n" for path, digest in manifest["sha256"].items()
                ),
                encoding="utf-8",
            )

            with self.assertRaisesRegex(VALIDATOR.SnapshotValidationError, "does not match manifest"):
                VALIDATOR.resolve_snapshot(snapshot, [approved])

    def test_v2_numbered_status_must_prove_the_recorded_baseline_state(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_dir:
            approved = Path(temporary_dir) / "approved"
            snapshot = approved / "cutover-snapshot"
            snapshot.mkdir(parents=True)
            write_cutover_snapshot(snapshot, present_before_cutover=False)

            status_artifact = snapshot / "runtime/ufw-status-numbered.txt"
            status_artifact.write_text(
                f"Status: active\n[ 1] {KAMRUI_IP} 1935/tcp ALLOW IN {GUEST_IP}\n",
                encoding="utf-8",
            )
            manifest_path = snapshot / "rollback-manifest.json"
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            relative = "runtime/ufw-status-numbered.txt"
            manifest["sha256"][relative] = sha256_bytes(status_artifact.read_bytes())
            manifest_path.write_text(
                json.dumps(manifest, sort_keys=True, indent=2) + "\n", encoding="utf-8"
            )
            (snapshot / "SHA256SUMS").write_text(
                "".join(
                    f"{digest}  {path}\n" for path, digest in manifest["sha256"].items()
                ),
                encoding="utf-8",
            )

            with self.assertRaisesRegex(VALIDATOR.SnapshotValidationError, "does not match present"):
                VALIDATOR.resolve_snapshot(snapshot, [approved])

    @unittest.skipUnless(bash, "Git Bash or Bash is required for fake-UFW rollback regression")
    def test_baseline_absent_removes_only_exact_rule_then_runs_source_rollback(self) -> None:
        exact = f"[ 1] {KAMRUI_IP} 1935/tcp ALLOW IN {GUEST_IP}"
        unrelated = f"[ 2] {KAMRUI_IP} 443/tcp ALLOW IN 192.168.1.60"
        different_source = f"[ 3] {KAMRUI_IP} 1935/tcp ALLOW IN 192.168.1.77"
        result, status, lower_log, ufw_log, event_log = self._run_wrapper(
            present_before_cutover=False,
            initial_status_rules=[exact, unrelated, different_source],
        )

        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertNotIn(exact, status)
        self.assertIn(unrelated, status)
        self.assertIn(different_source, status)
        self.assertIn("source-rollback", lower_log)
        self.assertLess(event_log.index("ufw:--force delete"), event_log.index("source-rollback"))
        self.assertIn("Guest RTMP firewall baseline restored", result.stdout)

    @unittest.skipUnless(bash, "Git Bash or Bash is required for fake-UFW rollback regression")
    def test_absent_exact_rule_is_idempotent(self) -> None:
        unrelated = f"[ 2] {KAMRUI_IP} 1935/tcp ALLOW IN 192.168.1.77"
        result, status, lower_log, ufw_log, _ = self._run_wrapper(
            present_before_cutover=False,
            initial_status_rules=[unrelated],
        )

        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertIn(unrelated, status)
        self.assertIn("source-rollback", lower_log)
        self.assertNotIn("delete", ufw_log)

    @unittest.skipUnless(bash, "Git Bash or Bash is required for fake-UFW rollback regression")
    def test_baseline_present_is_preserved_or_restored_after_source_success(self) -> None:
        exact = f"[ 1] {KAMRUI_IP} 1935/tcp ALLOW IN {GUEST_IP}"
        preserved, status, lower_log, ufw_log, _ = self._run_wrapper(
            present_before_cutover=True,
            initial_status_rules=[exact],
        )
        self.assertEqual(preserved.returncode, 0, preserved.stderr + preserved.stdout)
        self.assertIn(exact, status)
        self.assertIn("source-rollback", lower_log)
        self.assertNotIn("delete", ufw_log)
        self.assertNotIn("allow", ufw_log)

        restored, restored_status, restored_lower_log, restored_ufw_log, restored_event_log = self._run_wrapper(
            present_before_cutover=True,
            initial_status_rules=[],
        )
        self.assertEqual(
            restored.returncode,
            0,
            restored.stderr + restored.stdout + restored_ufw_log,
        )
        self.assertIn(f"{KAMRUI_IP} 1935/tcp ALLOW IN {GUEST_IP}", restored_status)
        self.assertIn("source-rollback", restored_lower_log)
        self.assertIn("allow\tin\tfrom", restored_ufw_log)
        self.assertLess(restored_event_log.index("source-rollback"), restored_event_log.index("ufw:allow"))

    @unittest.skipUnless(bash, "Git Bash or Bash is required for fake-UFW rollback regression")
    def test_ambiguous_or_malformed_firewall_identity_fails_closed(self) -> None:
        exact = f"[ 1] {KAMRUI_IP} 1935/tcp ALLOW IN {GUEST_IP}"
        result, status, lower_log, _, _ = self._run_wrapper(
            present_before_cutover=False,
            initial_status_rules=[exact, exact.replace("[ 1]", "[ 2]")],
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(exact, status)
        self.assertEqual(lower_log, "")
        self.assertIn("ambiguous", result.stderr.lower())

        malformed, _, malformed_lower_log, _, _ = self._run_wrapper(
            present_before_cutover=False,
            initial_status_rules=[],
            guest_ip="not-an-ip",
        )
        self.assertNotEqual(malformed.returncode, 0)
        self.assertEqual(malformed_lower_log, "")
        self.assertIn("firewall", malformed.stderr.lower())

    @unittest.skipUnless(bash, "Git Bash or Bash is required for fake-UFW rollback regression")
    def test_firewall_removal_and_source_rollback_failures_never_report_green(self) -> None:
        exact = f"[ 1] {KAMRUI_IP} 1935/tcp ALLOW IN {GUEST_IP}"
        removal, removal_status, removal_lower_log, _, _ = self._run_wrapper(
            present_before_cutover=False,
            initial_status_rules=[exact],
            delete_fails=True,
        )
        self.assertNotEqual(removal.returncode, 0)
        self.assertIn(exact, removal_status)
        self.assertEqual(removal_lower_log, "")
        self.assertNotIn("rollback complete", removal.stdout.lower())

        source, source_status, source_lower_log, _, _ = self._run_wrapper(
            present_before_cutover=False,
            initial_status_rules=[exact],
            source_rollback_exit=55,
        )
        self.assertNotEqual(source.returncode, 0)
        self.assertNotIn(exact, source_status)
        self.assertIn("source-rollback", source_lower_log)
        self.assertIn("Guest ingress remains closed", source.stderr)


if __name__ == "__main__":
    unittest.main()
