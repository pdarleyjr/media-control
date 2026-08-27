"""Regression coverage for immutable and verified-legacy rollback snapshots."""

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
VALIDATOR_PATH = EDGE_ROOT / "scripts" / "validate-rollback-snapshot.py"
ROLLBACK_PATH = EDGE_ROOT / "scripts" / "rollback.sh"

IMAGE_ID = "sha256:" + "a" * 64
REPO_DIGEST = "bluenviron/mediamtx@sha256:" + "b" * 64
PINNED_IMAGE = "bluenviron/mediamtx:1.19.3@sha256:" + "b" * 64
STARTED_AT = "2026-08-27T12:00:00.000000000Z"


def load_validator():
    spec = importlib.util.spec_from_file_location("validate_rollback_snapshot", VALIDATOR_PATH)
    if spec is None or spec.loader is None:  # pragma: no cover - test setup failure
        raise RuntimeError("unable to load rollback snapshot validator")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


VALIDATOR = load_validator()


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def write_snapshot(
    snapshot: Path,
    *,
    snapshot_kind: str,
    compose_image: str,
    repo_digest: object = REPO_DIGEST,
) -> dict[str, bytes]:
    """Create a minimal, checksum-complete snapshot fixture without secrets."""

    artifacts = {
        "opt/media-stack/mediamtx.yml": b"paths:\n  anpviz-main:\n    source: publisher\n",
        "opt/media-stack/docker-compose.mediamtx.yml": (
            f"services:\n  mediamtx:\n    image: {compose_image}\n".encode("utf-8")
        ),
        "etc/media-stack/camera.env": b"FIXTURE_ONLY=not-a-production-secret\n",
        "runtime/mediamtx-inspect.json": json.dumps(
            {"Image": IMAGE_ID, "State": {"StartedAt": STARTED_AT}}, sort_keys=True
        ).encode("utf-8"),
    }
    for relative, content in artifacts.items():
        path = snapshot / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)

    hashes = {relative: sha256_bytes(content) for relative, content in artifacts.items()}
    manifest = {
        "schema_version": 1,
        "snapshot_kind": snapshot_kind,
        "artifacts": list(artifacts),
        "sha256": hashes,
        "runtime": {
            "mediamtx": {
                "version": "v1.19.3",
                "image_id": IMAGE_ID,
                "repo_digest": repo_digest,
                "started_at": STARTED_AT,
                "inspect_sha256": hashes["runtime/mediamtx-inspect.json"],
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
    return artifacts


class RollbackSnapshotTests(unittest.TestCase):
    def make_rooted_snapshot(self, root: Path, name: str = "snapshot") -> Path:
        root.mkdir(parents=True, exist_ok=True)
        snapshot = root / name
        snapshot.mkdir()
        return snapshot

    def test_new_pinned_snapshot_is_accepted(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_dir:
            approved = Path(temporary_dir) / "approved"
            snapshot = self.make_rooted_snapshot(approved)
            original = write_snapshot(
                snapshot,
                snapshot_kind="pinned-release",
                compose_image=PINNED_IMAGE,
            )

            plan = VALIDATOR.resolve_snapshot(snapshot, [approved])

            self.assertEqual(plan.snapshot_kind, "pinned-release")
            self.assertEqual(plan.restore_image, PINNED_IMAGE)
            self.assertEqual(
                (snapshot / "opt/media-stack/docker-compose.mediamtx.yml").read_bytes(),
                original["opt/media-stack/docker-compose.mediamtx.yml"],
            )

    def test_pinned_snapshot_requires_runtime_digest_to_match_compose(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_dir:
            approved = Path(temporary_dir) / "approved"
            snapshot = self.make_rooted_snapshot(approved)
            write_snapshot(
                snapshot,
                snapshot_kind="pinned-release",
                compose_image=PINNED_IMAGE,
                repo_digest="bluenviron/mediamtx@sha256:" + "c" * 64,
            )

            with self.assertRaisesRegex(VALIDATOR.SnapshotValidationError, "does not match"):
                VALIDATOR.resolve_snapshot(snapshot, [approved])

    def test_verified_legacy_latest_snapshot_resolves_to_captured_digest(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_dir:
            approved = Path(temporary_dir) / "approved"
            snapshot = self.make_rooted_snapshot(approved)
            original = write_snapshot(
                snapshot,
                snapshot_kind="verified-legacy",
                compose_image="bluenviron/mediamtx:latest",
            )

            plan = VALIDATOR.resolve_snapshot(snapshot, [approved])

            self.assertEqual(plan.snapshot_kind, "verified-legacy")
            self.assertEqual(plan.restore_image, REPO_DIGEST)
            self.assertEqual(
                (snapshot / "opt/media-stack/docker-compose.mediamtx.yml").read_bytes(),
                original["opt/media-stack/docker-compose.mediamtx.yml"],
            )

    def test_latest_snapshot_without_immutable_runtime_identity_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_dir:
            approved = Path(temporary_dir) / "approved"
            snapshot = self.make_rooted_snapshot(approved)
            write_snapshot(
                snapshot,
                snapshot_kind="verified-legacy",
                compose_image="bluenviron/mediamtx:latest",
                repo_digest=None,
            )

            with self.assertRaisesRegex(VALIDATOR.SnapshotValidationError, "repo_digest"):
                VALIDATOR.resolve_snapshot(snapshot, [approved])

    def test_bad_artifact_checksum_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_dir:
            approved = Path(temporary_dir) / "approved"
            snapshot = self.make_rooted_snapshot(approved)
            write_snapshot(
                snapshot,
                snapshot_kind="pinned-release",
                compose_image=PINNED_IMAGE,
            )
            (snapshot / "opt/media-stack/mediamtx.yml").write_text("tampered\n", encoding="utf-8")

            with self.assertRaisesRegex(VALIDATOR.SnapshotValidationError, "checksum mismatch"):
                VALIDATOR.resolve_snapshot(snapshot, [approved])

    def test_incorrect_sha256sums_entry_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_dir:
            approved = Path(temporary_dir) / "approved"
            snapshot = self.make_rooted_snapshot(approved)
            write_snapshot(
                snapshot,
                snapshot_kind="pinned-release",
                compose_image=PINNED_IMAGE,
            )
            sums_path = snapshot / "SHA256SUMS"
            sums_path.write_text(
                "0" * 64 + "  opt/media-stack/mediamtx.yml\n",
                encoding="utf-8",
            )

            with self.assertRaisesRegex(VALIDATOR.SnapshotValidationError, "SHA256SUMS"):
                VALIDATOR.resolve_snapshot(snapshot, [approved])

    def test_snapshot_outside_approved_root_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_dir:
            temporary = Path(temporary_dir)
            approved = temporary / "approved"
            outside = temporary / "outside"
            snapshot = self.make_rooted_snapshot(outside)
            approved.mkdir()
            write_snapshot(
                snapshot,
                snapshot_kind="pinned-release",
                compose_image=PINNED_IMAGE,
            )

            with self.assertRaisesRegex(VALIDATOR.SnapshotValidationError, "outside an approved"):
                VALIDATOR.resolve_snapshot(snapshot, [approved])

    def test_latest_compose_requires_explicit_verified_legacy_kind(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_dir:
            approved = Path(temporary_dir) / "approved"
            snapshot = self.make_rooted_snapshot(approved)
            write_snapshot(
                snapshot,
                snapshot_kind="pinned-release",
                compose_image="bluenviron/mediamtx:latest",
            )

            with self.assertRaisesRegex(VALIDATOR.SnapshotValidationError, "digest-pinned"):
                VALIDATOR.resolve_snapshot(snapshot, [approved])


def git_bash() -> str | None:
    """Return Git Bash on Windows, or a native Bash elsewhere."""

    if os.name == "nt":
        candidate = Path(r"C:\Program Files\Git\bin\bash.exe")
        return str(candidate) if candidate.is_file() else None
    return shutil.which("bash")


class RollbackScriptExecutionTests(unittest.TestCase):
    """Exercise the legacy path with fake Docker, never a real host/service."""

    bash = git_bash()

    @unittest.skipUnless(bash, "Git Bash or Bash is required for rollback shell regression")
    def test_legacy_rollback_uses_only_captured_digest_and_temporary_override(self) -> None:
        assert self.bash is not None  # narrowed by skipUnless
        with tempfile.TemporaryDirectory() as temporary_dir:
            temporary = Path(temporary_dir)
            approved_one = temporary / "approved-one"
            approved_two = temporary / "approved-two"
            snapshot = approved_one / "legacy-snapshot"
            snapshot.mkdir(parents=True)
            approved_two.mkdir()
            original = write_snapshot(
                snapshot,
                snapshot_kind="verified-legacy",
                compose_image="bluenviron/mediamtx:latest",
            )
            stack = temporary / "media-stack"
            stack.mkdir()
            runtime_scripts = temporary / "runtime-scripts"
            runtime_scripts.mkdir()
            fake_bin = temporary / "fake-bin"
            fake_bin.mkdir()
            capture_dir = temporary / "compose-captures"
            capture_dir.mkdir()
            docker_log = temporary / "docker.log"
            curl_log = temporary / "curl.log"
            docker_state = temporary / "docker-state"
            override_path = temporary / "override-path"

            def bash_path(path: Path) -> str:
                result = subprocess.run(
                    [self.bash, "-lc", 'cygpath -u -- "$TARGET"'],
                    env={**os.environ, "TARGET": str(path)},
                    check=True,
                    capture_output=True,
                    text=True,
                )
                return result.stdout.strip()

            stack_shell = bash_path(stack)
            approved_one_shell = bash_path(approved_one)
            approved_two_shell = bash_path(approved_two)
            snapshot_shell = bash_path(snapshot)
            fake_bin_shell = bash_path(fake_bin)

            # Keep the tested source exact except for its hard-coded production
            # roots, which are redirected to this disposable local sandbox.
            script_text = ROLLBACK_PATH.read_text(encoding="utf-8")
            script_text = script_text.replace(
                "STACK=/opt/mbfd/media-stack", f"STACK='{stack_shell}'"
            ).replace(
                "--approved-root /home/peter/mbfd-backups",
                f"--approved-root '{approved_one_shell}'",
            ).replace(
                "--approved-root /opt/mbfd/media-stack/backups",
                f"--approved-root '{approved_two_shell}'",
            ).replace("curl --fail", '"$FAKE_CURL" --fail')
            test_rollback = runtime_scripts / "rollback.sh"
            test_rollback.write_text(script_text, encoding="utf-8")
            shutil.copy2(VALIDATOR_PATH, runtime_scripts / VALIDATOR_PATH.name)

            (fake_bin / "sudo").write_text(
                textwrap.dedent(
                    """\
                    #!/usr/bin/env bash
                    set -euo pipefail
                    if [ "${1:-}" = "install" ]; then
                      source="${@: -2:1}"
                      destination="${@: -1}"
                      mkdir -p "$(dirname "$destination")"
                      cp "$source" "$destination"
                    else
                      exec "$@"
                    fi
                    """
                ),
                encoding="utf-8",
            )
            (fake_bin / "docker").write_text(
                textwrap.dedent(
                    """\
                    #!/usr/bin/env bash
                    set -euo pipefail
                    printf '%s\\t' "$@" >> "$FAKE_DOCKER_LOG"
                    printf '\\n' >> "$FAKE_DOCKER_LOG"
                    image_id="$FAKE_IMAGE_ID"
                    repo_digest="$FAKE_REPO_DIGEST"
                    case "$1" in
                      image)
                        if [ "$2" != "inspect" ]; then exit 97; fi
                        if [ "${3:-}" = "--format" ]; then
                          case "$4" in
                            '{{.Id}}') printf '%s\\n' "$image_id" ;;
                            *RepoDigests*) printf '%s\\n' "$repo_digest" ;;
                            *) exit 96 ;;
                          esac
                        else
                          [ -f "$FAKE_DOCKER_STATE" ] || exit 1
                        fi
                        ;;
                      pull)
                        [ "${2:-}" = "$repo_digest" ] || exit 95
                        : > "$FAKE_DOCKER_STATE"
                        ;;
                      compose)
                        arguments=("$@")
                        for ((index=0; index < ${#arguments[@]}; index++)); do
                          if [ "${arguments[$index]}" = "-f" ]; then
                            compose_file="${arguments[$((index + 1))]}"
                            count="$(cat "$FAKE_CAPTURE_COUNTER" 2>/dev/null || printf '0')"
                            count=$((count + 1))
                            printf '%s' "$count" > "$FAKE_CAPTURE_COUNTER"
                            cp "$compose_file" "$FAKE_CAPTURE_DIR/compose-$count.yml"
                            case "$compose_file" in
                              /tmp/mbfd-mediamtx-legacy-rollback.*.yml)
                                printf '%s' "$compose_file" > "$FAKE_OVERRIDE_PATH"
                                ;;
                            esac
                          fi
                        done
                        ;;
                      inspect)
                        [ "${2:-}" = "--format" ] || exit 94
                        case "$3" in
                          '{{.State.Running}}') printf 'true\\n' ;;
                          '{{.Image}}') printf '%s\\n' "$image_id" ;;
                          *) exit 93 ;;
                        esac
                        ;;
                      exec)
                        [ "${3:-}" = "/mediamtx" ] || exit 92
                        [ "${4:-}" = "--version" ] || exit 91
                        printf 'v1.19.3\\n'
                        ;;
                      *) exit 90 ;;
                    esac
                    """
                ),
                encoding="utf-8",
            )
            (fake_bin / "curl").write_text(
                textwrap.dedent(
                    """\
                    #!/usr/bin/env bash
                    set -euo pipefail
                    printf '%s\\t' "$@" >> "$FAKE_CURL_LOG"
                    printf '\\n' >> "$FAKE_CURL_LOG"
                    printf '%s' '{"items":[{"name":"anpviz-video"},{"name":"anpviz-main"}]}'
                    """
                ),
                encoding="utf-8",
            )
            for executable in fake_bin.iterdir():
                executable.chmod(0o755)

            default_path = subprocess.run(
                [self.bash, "-lc", 'printf "%s" "$PATH"'],
                check=True,
                capture_output=True,
                text=True,
            ).stdout
            environment = {
                **os.environ,
                "PATH": f"{fake_bin_shell}:{default_path}",
                "FAKE_DOCKER_LOG": str(docker_log),
                "FAKE_CURL_LOG": str(curl_log),
                "FAKE_DOCKER_STATE": str(docker_state),
                "FAKE_CAPTURE_DIR": str(capture_dir),
                "FAKE_CAPTURE_COUNTER": str(temporary / "capture-count"),
                "FAKE_OVERRIDE_PATH": str(override_path),
                "FAKE_IMAGE_ID": IMAGE_ID,
                "FAKE_REPO_DIGEST": REPO_DIGEST,
                "FAKE_CURL": bash_path(fake_bin / "curl"),
            }
            result = subprocess.run(
                [self.bash, bash_path(test_rollback), snapshot_shell],
                env=environment,
                capture_output=True,
                text=True,
                timeout=30,
            )
            self.assertEqual(result.returncode, 0, result.stderr + result.stdout)

            docker_calls = [line.split("\t")[:-1] for line in docker_log.read_text(encoding="utf-8").splitlines()]
            pulls = [call for call in docker_calls if call and call[0] == "pull"]
            self.assertEqual(pulls, [["pull", REPO_DIGEST]])
            self.assertFalse(any("latest" in "\t".join(call) for call in docker_calls))
            self.assertTrue(any(call[:2] == ["compose", "-f"] for call in docker_calls))
            self.assertTrue(any(call and call[0] == "exec" for call in docker_calls))
            self.assertTrue(any(call and call[0] == "inspect" for call in docker_calls))
            self.assertIn("/v3/paths/list", curl_log.read_text(encoding="utf-8"))

            self.assertEqual(
                (stack / "docker-compose.mediamtx.yml").read_bytes(),
                original["opt/media-stack/docker-compose.mediamtx.yml"],
            )
            captured_compose = [path.read_text(encoding="utf-8") for path in capture_dir.glob("*.yml")]
            self.assertTrue(any("bluenviron/mediamtx:latest" in value for value in captured_compose))
            self.assertTrue(any(f"image: {REPO_DIGEST}" in value for value in captured_compose))
            recorded_override = override_path.read_text(encoding="utf-8")
            no_override_result = subprocess.run(
                [self.bash, "-lc", 'test ! -e "$TARGET"'],
                env={**environment, "TARGET": recorded_override},
                capture_output=True,
                text=True,
            )
            self.assertEqual(no_override_result.returncode, 0, "legacy Compose override was not removed")


if __name__ == "__main__":
    unittest.main()
