#!/usr/bin/env python3
"""Validate a MediaMTX rollback snapshot without exposing its secret config.

The rollback command deliberately has a small, explicit snapshot contract.  A
new release snapshot must carry a digest-pinned MediaMTX Compose reference.  A
captured pre-release baseline is allowed to retain its historical
``:latest`` Compose bytes only when the manifest proves which immutable image
was actually running at capture time.

The module is intentionally standard-library only so it can run on KAMRUI
before any rollback writes occur.  Errors name metadata or file paths, never
read or print ``camera.env`` contents.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import hashlib
import ipaddress
import json
from pathlib import Path, PurePosixPath
import re
import sys
from typing import Iterable


class SnapshotValidationError(ValueError):
    """The supplied rollback snapshot cannot safely be used."""


@dataclass(frozen=True)
class GuestRtmpFirewallBaseline:
    """The exact IPv4 UFW state that existed before a cutover."""

    action: str
    direction: str
    guest_ip: str
    kamrui_ip: str
    port: int
    protocol: str
    present_before_cutover: bool


@dataclass(frozen=True)
class UfwObservation:
    """A strict observation of the one rule this feature may change."""

    exact_rule_number: int | None
    unrelated_fingerprint: str


REQUIRED_ARTIFACTS = (
    "opt/media-stack/mediamtx.yml",
    "opt/media-stack/docker-compose.mediamtx.yml",
    "etc/media-stack/camera.env",
    "runtime/mediamtx-inspect.json",
)
MANIFEST_NAME = "rollback-manifest.json"
SUMS_NAME = "SHA256SUMS"
FIREWALL_ARTIFACT = "runtime/guest-rtmp-firewall-before.json"
FIREWALL_STATUS_ARTIFACT = "runtime/ufw-status-numbered.txt"
HEX_SHA256 = re.compile(r"^[0-9a-f]{64}$")
IMAGE_ID = re.compile(r"^sha256:[0-9a-f]{64}$")
REPO_DIGEST = re.compile(r"^bluenviron/mediamtx@sha256:[0-9a-f]{64}$")
PINNED_IMAGE = re.compile(
    r"^bluenviron/mediamtx(?::[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}$"
)
SUM_LINE = re.compile(r"^([0-9a-f]{64}) [ *](.+)$")
UFW_NUMBERED_RULE = re.compile(
    r"^\[\s*(?P<number>[1-9][0-9]*)\]\s+"
    r"(?P<destination>\S+)\s+"
    r"(?P<port>[0-9]{1,5})/(?P<protocol>[A-Za-z0-9]+)\s+"
    r"(?P<action>ALLOW|DENY|REJECT|LIMIT)\s+"
    r"(?P<direction>IN|OUT)\s+"
    r"(?P<source>\S+)\s*$"
)
UFW_NUMBER_PREFIX = re.compile(r"^\[\s*[1-9][0-9]*\]\s+")


@dataclass(frozen=True)
class SnapshotPlan:
    """The immutable image and expected runtime identity for a rollback."""

    snapshot: Path
    snapshot_kind: str
    restore_image: str
    expected_version: str
    expected_image_id: str
    expected_repo_digest: str
    guest_rtmp_firewall: GuestRtmpFirewallBaseline | None = None


def _is_beneath(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
    except ValueError:
        return False
    return True


def _normalise_relative_path(value: object, *, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise SnapshotValidationError(f"{label} must be a non-empty relative path")
    if "\\" in value:
        raise SnapshotValidationError(f"{label} must use POSIX relative paths")
    path = PurePosixPath(value)
    if path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
        raise SnapshotValidationError(f"{label} is not a safe relative path")
    return path.as_posix()


def _safe_regular_file(snapshot: Path, relative_path: str) -> Path:
    """Return a non-symlink regular file contained by ``snapshot``."""

    candidate = snapshot
    for component in PurePosixPath(relative_path).parts:
        candidate = candidate / component
        if candidate.is_symlink():
            raise SnapshotValidationError(f"snapshot artifact is a symlink: {relative_path}")
    if not candidate.is_file():
        raise SnapshotValidationError(f"snapshot artifact is missing or not a regular file: {relative_path}")
    resolved = candidate.resolve(strict=True)
    if not _is_beneath(resolved, snapshot):
        raise SnapshotValidationError(f"snapshot artifact escapes snapshot root: {relative_path}")
    return resolved


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _read_json(path: Path, *, label: str) -> object:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise SnapshotValidationError(f"{label} is not valid JSON") from error


def _parse_sha256sums(path: Path) -> dict[str, str]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeDecodeError) as error:
        raise SnapshotValidationError("SHA256SUMS cannot be read as UTF-8 text") from error

    checksums: dict[str, str] = {}
    for line in lines:
        if not line:
            continue
        match = SUM_LINE.fullmatch(line)
        if match is None:
            raise SnapshotValidationError("SHA256SUMS contains an invalid entry")
        digest, path_value = match.groups()
        relative = _normalise_relative_path(path_value, label="SHA256SUMS path")
        if relative in checksums:
            raise SnapshotValidationError("SHA256SUMS contains a duplicate artifact")
        checksums[relative] = digest
    if not checksums:
        raise SnapshotValidationError("SHA256SUMS is empty")
    return checksums


def _compose_mediamtx_image(compose_path: Path) -> str:
    try:
        lines = compose_path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeDecodeError) as error:
        raise SnapshotValidationError("captured MediaMTX Compose file cannot be read") from error

    images: list[str] = []
    for line in lines:
        match = re.match(r"^\s*image\s*:\s*(.*?)\s*(?:#.*)?$", line)
        if match is None:
            continue
        image = match.group(1).strip()
        if len(image) >= 2 and image[0] == image[-1] and image[0] in {"'", '"'}:
            image = image[1:-1]
        if image.startswith("bluenviron/mediamtx"):
            images.append(image)
    if len(images) != 1:
        raise SnapshotValidationError("captured Compose must contain exactly one MediaMTX image")
    return images[0]


def _validate_runtime(manifest: dict[str, object], inspect_payload: object) -> tuple[str, str, str]:
    runtime = manifest.get("runtime")
    if not isinstance(runtime, dict):
        raise SnapshotValidationError("manifest runtime metadata is missing")
    mediamtx = runtime.get("mediamtx")
    if not isinstance(mediamtx, dict):
        raise SnapshotValidationError("manifest MediaMTX runtime metadata is missing")

    version = mediamtx.get("version")
    image_id = mediamtx.get("image_id")
    repo_digest = mediamtx.get("repo_digest")
    started_at = mediamtx.get("started_at")
    inspect_sha256 = mediamtx.get("inspect_sha256")
    if not isinstance(version, str) or not version.startswith("v") or "\n" in version:
        raise SnapshotValidationError("manifest MediaMTX version is invalid")
    if not isinstance(image_id, str) or IMAGE_ID.fullmatch(image_id) is None:
        raise SnapshotValidationError("manifest MediaMTX image_id is not an immutable sha256 ID")
    if not isinstance(repo_digest, str) or REPO_DIGEST.fullmatch(repo_digest) is None:
        raise SnapshotValidationError("manifest MediaMTX repo_digest is not immutable")
    if not isinstance(started_at, str) or not started_at:
        raise SnapshotValidationError("manifest MediaMTX started_at is missing")
    if not isinstance(inspect_sha256, str) or HEX_SHA256.fullmatch(inspect_sha256) is None:
        raise SnapshotValidationError("manifest MediaMTX inspect_sha256 is invalid")

    if isinstance(inspect_payload, list):
        if len(inspect_payload) != 1:
            raise SnapshotValidationError("captured MediaMTX inspect metadata must contain one container")
        inspect_payload = inspect_payload[0]
    if not isinstance(inspect_payload, dict):
        raise SnapshotValidationError("captured MediaMTX inspect metadata is not an object")
    inspect_image_id = inspect_payload.get("Image")
    state = inspect_payload.get("State")
    inspect_started_at = state.get("StartedAt") if isinstance(state, dict) else None
    if inspect_image_id != image_id:
        raise SnapshotValidationError("captured inspect image ID does not match manifest")
    if inspect_started_at != started_at:
        raise SnapshotValidationError("captured inspect start time does not match manifest")
    return version, image_id, repo_digest


def _private_ipv4(value: object, *, label: str) -> str:
    """Validate a canonical private IPv4 host address for the LAN exception."""

    if not isinstance(value, str):
        raise SnapshotValidationError(f"{label} must be an IPv4 address")
    try:
        address = ipaddress.IPv4Address(value)
    except ipaddress.AddressValueError as error:
        raise SnapshotValidationError(f"{label} is not a valid IPv4 address") from error
    if str(address) != value or not address.is_private or any(
        (address.is_unspecified, address.is_multicast, address.is_loopback, address.is_link_local)
    ):
        raise SnapshotValidationError(f"{label} must be a private unicast IPv4 address")
    return value


def _firewall_baseline_from_payload(
    payload: object, *, label: str
) -> GuestRtmpFirewallBaseline:
    """Validate the one narrow UFW exception this feature can own."""

    required = {
        "action",
        "direction",
        "guest_ip",
        "kamrui_ip",
        "port",
        "protocol",
        "present_before_cutover",
    }
    if not isinstance(payload, dict) or set(payload) != required:
        raise SnapshotValidationError(f"{label} has an invalid Guest RTMP firewall tuple")
    action = payload["action"]
    direction = payload["direction"]
    protocol = payload["protocol"]
    port = payload["port"]
    present = payload["present_before_cutover"]
    if action != "ALLOW" or direction != "IN" or protocol != "tcp" or port != 1935:
        raise SnapshotValidationError(f"{label} is not the exact Guest TCP/1935 allow-in rule")
    if isinstance(port, bool) or not isinstance(port, int):
        raise SnapshotValidationError(f"{label} port is invalid")
    if not isinstance(present, bool):
        raise SnapshotValidationError(f"{label} present_before_cutover must be boolean")
    guest_ip = _private_ipv4(payload["guest_ip"], label=f"{label} guest_ip")
    kamrui_ip = _private_ipv4(payload["kamrui_ip"], label=f"{label} kamrui_ip")
    if guest_ip == kamrui_ip:
        raise SnapshotValidationError(f"{label} Guest and KAMRUI IPv4 addresses must differ")
    return GuestRtmpFirewallBaseline(
        action=action,
        direction=direction,
        guest_ip=guest_ip,
        kamrui_ip=kamrui_ip,
        port=port,
        protocol=protocol,
        present_before_cutover=present,
    )


def _source_covers_guest(source: str, guest_ip: str) -> bool:
    """Return whether a numbered UFW source grants the Guest host access."""

    if source == "Anywhere":
        return True
    try:
        return ipaddress.IPv4Address(guest_ip) in ipaddress.IPv4Network(source, strict=False)
    except ValueError:
        return source == guest_ip


def observe_guest_rtmp_ufw_status(
    status_text: str, baseline: GuestRtmpFirewallBaseline
) -> UfwObservation:
    """Strictly identify the one exact numbered UFW rule, if present.

    ``ufw status numbered`` uses the ``To Action From`` column order, so a
    destination-qualified rule is parsed as ``destination port/proto ACTION
    DIRECTION source``.

    A related non-canonical/broad rule is an ambiguity, not an invitation to
    delete by a loose text match.  Unrelated rules remain represented in a
    number-insensitive fingerprint so callers can prove they were preserved.
    """

    if not any(line.strip() == "Status: active" for line in status_text.splitlines()):
        raise SnapshotValidationError("UFW status is not active; firewall identity cannot be proven")

    exact_numbers: list[int] = []
    unrelated_lines: list[str] = []
    expected_port = str(baseline.port)
    for raw_line in status_text.splitlines():
        line = raw_line.rstrip()
        match = UFW_NUMBERED_RULE.fullmatch(line)
        if match is None:
            if baseline.guest_ip in line and "1935" in line:
                raise SnapshotValidationError("UFW status contains an ambiguous Guest RTMP firewall rule")
            unrelated_lines.append(line)
            continue

        fields = match.groupdict()
        is_exact = (
            fields["port"] == expected_port
            and fields["protocol"] == baseline.protocol
            and fields["action"] == baseline.action
            and fields["direction"] == baseline.direction
            and fields["source"] == baseline.guest_ip
            and fields["destination"] == baseline.kamrui_ip
        )
        if is_exact:
            exact_numbers.append(int(fields["number"]))
            continue

        grants_guest_to_kamrui = (
            fields["port"] == expected_port
            and fields["protocol"] == baseline.protocol
            and fields["action"] == baseline.action
            and fields["direction"] == baseline.direction
            and fields["destination"] == baseline.kamrui_ip
            and _source_covers_guest(fields["source"], baseline.guest_ip)
        )
        directly_related = (
            fields["source"] == baseline.guest_ip
            and fields["destination"] == baseline.kamrui_ip
            and fields["port"] == expected_port
        )
        if grants_guest_to_kamrui or directly_related:
            raise SnapshotValidationError("UFW status contains an ambiguous Guest RTMP firewall rule")
        unrelated_lines.append(UFW_NUMBER_PREFIX.sub("", line))

    if len(exact_numbers) > 1:
        raise SnapshotValidationError("UFW status contains duplicate exact Guest RTMP firewall rules")
    fingerprint = hashlib.sha256(
        "\n".join(unrelated_lines).encode("utf-8")
    ).hexdigest()
    return UfwObservation(
        exact_rule_number=exact_numbers[0] if exact_numbers else None,
        unrelated_fingerprint=fingerprint,
    )


def _validate_guest_rtmp_firewall(
    manifest: dict[str, object],
    artifact_files: dict[str, Path],
    *,
    required: bool,
) -> GuestRtmpFirewallBaseline | None:
    firewall = manifest.get("firewall")
    if firewall is None:
        if required:
            raise SnapshotValidationError("rollback manifest v2 is missing firewall baseline evidence")
        return None
    if not isinstance(firewall, dict) or set(firewall) != {"guest_rtmp"}:
        raise SnapshotValidationError("rollback manifest firewall metadata is invalid")
    guest_rtmp = firewall["guest_rtmp"]
    expected_keys = {
        "action",
        "artifact",
        "direction",
        "guest_ip",
        "kamrui_ip",
        "port",
        "protocol",
        "present_before_cutover",
        "status_artifact",
    }
    if not isinstance(guest_rtmp, dict) or set(guest_rtmp) != expected_keys:
        raise SnapshotValidationError("rollback manifest Guest RTMP firewall metadata is invalid")
    if guest_rtmp["artifact"] != FIREWALL_ARTIFACT or guest_rtmp["status_artifact"] != FIREWALL_STATUS_ARTIFACT:
        raise SnapshotValidationError("rollback manifest Guest RTMP firewall artifact paths are invalid")
    if FIREWALL_ARTIFACT not in artifact_files or FIREWALL_STATUS_ARTIFACT not in artifact_files:
        raise SnapshotValidationError("rollback manifest Guest RTMP firewall evidence is not checksum covered")

    manifest_tuple = {
        key: guest_rtmp[key]
        for key in (
            "action",
            "direction",
            "guest_ip",
            "kamrui_ip",
            "port",
            "protocol",
            "present_before_cutover",
        )
    }
    baseline = _firewall_baseline_from_payload(
        manifest_tuple, label="rollback manifest Guest RTMP firewall"
    )
    artifact_payload = _read_json(
        artifact_files[FIREWALL_ARTIFACT], label="Guest RTMP firewall evidence"
    )
    artifact_baseline = _firewall_baseline_from_payload(
        artifact_payload, label="Guest RTMP firewall evidence"
    )
    if artifact_baseline != baseline:
        raise SnapshotValidationError("Guest RTMP firewall artifact does not match manifest")
    try:
        status_text = artifact_files[FIREWALL_STATUS_ARTIFACT].read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as error:
        raise SnapshotValidationError("captured numbered UFW status cannot be read") from error
    observation = observe_guest_rtmp_ufw_status(status_text, baseline)
    if (observation.exact_rule_number is not None) != baseline.present_before_cutover:
        raise SnapshotValidationError(
            "captured numbered UFW status does not match present_before_cutover"
        )
    return baseline


def _approved_snapshot_root(snapshot: Path, approved_roots: Iterable[Path]) -> Path:
    try:
        resolved_snapshot = snapshot.resolve(strict=True)
    except OSError as error:
        raise SnapshotValidationError("snapshot path does not exist") from error
    if not resolved_snapshot.is_dir():
        raise SnapshotValidationError("snapshot path is not a directory")

    resolved_roots: list[Path] = []
    for root in approved_roots:
        try:
            resolved_roots.append(root.resolve(strict=True))
        except OSError as error:
            raise SnapshotValidationError("approved snapshot root does not exist") from error
    if not resolved_roots or not any(
        resolved_snapshot != root and _is_beneath(resolved_snapshot, root)
        for root in resolved_roots
    ):
        raise SnapshotValidationError("snapshot is outside an approved backup root")
    return resolved_snapshot


def resolve_snapshot(snapshot: Path, approved_roots: Iterable[Path]) -> SnapshotPlan:
    """Validate ``snapshot`` and return its safe, immutable restore plan."""

    snapshot = _approved_snapshot_root(snapshot, approved_roots)
    manifest_path = _safe_regular_file(snapshot, MANIFEST_NAME)
    sums_path = _safe_regular_file(snapshot, SUMS_NAME)
    manifest_payload = _read_json(manifest_path, label="rollback manifest")
    if not isinstance(manifest_payload, dict):
        raise SnapshotValidationError("rollback manifest is not an object")
    schema_version = manifest_payload.get("schema_version")
    if schema_version not in {1, 2}:
        raise SnapshotValidationError("rollback manifest schema_version is unsupported")

    snapshot_kind = manifest_payload.get("snapshot_kind")
    if snapshot_kind not in {"pinned-release", "verified-legacy"}:
        raise SnapshotValidationError("rollback manifest snapshot_kind is invalid")
    artifacts = manifest_payload.get("artifacts")
    hashes = manifest_payload.get("sha256")
    if not isinstance(artifacts, list) or not all(isinstance(item, str) for item in artifacts):
        raise SnapshotValidationError("rollback manifest artifacts must be a path list")
    normalised_artifacts = tuple(
        _normalise_relative_path(item, label="manifest artifact path") for item in artifacts
    )
    if len(set(normalised_artifacts)) != len(normalised_artifacts):
        raise SnapshotValidationError("rollback manifest has duplicate artifact paths")
    missing_artifacts = set(REQUIRED_ARTIFACTS).difference(normalised_artifacts)
    if missing_artifacts:
        raise SnapshotValidationError("rollback manifest is missing required artifacts")
    if not isinstance(hashes, dict) or set(hashes) != set(normalised_artifacts):
        raise SnapshotValidationError("rollback manifest sha256 map must cover exactly its artifacts")

    sums = _parse_sha256sums(sums_path)
    artifact_files: dict[str, Path] = {}
    for relative in normalised_artifacts:
        expected_hash = hashes.get(relative)
        if not isinstance(expected_hash, str) or HEX_SHA256.fullmatch(expected_hash) is None:
            raise SnapshotValidationError("rollback manifest contains an invalid artifact SHA-256")
        actual_path = _safe_regular_file(snapshot, relative)
        actual_hash = _sha256(actual_path)
        if actual_hash != expected_hash:
            raise SnapshotValidationError(f"snapshot checksum mismatch: {relative}")
        if sums.get(relative) != expected_hash:
            raise SnapshotValidationError(f"SHA256SUMS does not verify manifest artifact: {relative}")
        artifact_files[relative] = actual_path

    inspect_path = artifact_files["runtime/mediamtx-inspect.json"]
    version, image_id, repo_digest = _validate_runtime(
        manifest_payload,
        _read_json(inspect_path, label="captured MediaMTX inspect metadata"),
    )
    runtime_metadata = manifest_payload["runtime"]["mediamtx"]
    assert isinstance(runtime_metadata, dict)  # narrowed by _validate_runtime
    if runtime_metadata["inspect_sha256"] != _sha256(inspect_path):
        raise SnapshotValidationError("captured inspect checksum does not match runtime metadata")

    compose_image = _compose_mediamtx_image(
        artifact_files["opt/media-stack/docker-compose.mediamtx.yml"]
    )
    if snapshot_kind == "pinned-release":
        if PINNED_IMAGE.fullmatch(compose_image) is None:
            raise SnapshotValidationError("new rollback snapshot must use a digest-pinned MediaMTX image")
        compose_repo_digest = "bluenviron/mediamtx@" + compose_image.split("@", 1)[1]
        if compose_repo_digest != repo_digest:
            raise SnapshotValidationError(
                "pinned MediaMTX Compose digest does not match captured runtime RepoDigest"
            )
        restore_image = compose_image
    else:
        if compose_image != "bluenviron/mediamtx:latest":
            raise SnapshotValidationError("verified legacy snapshot must retain its original latest MediaMTX Compose image")
        restore_image = repo_digest

    guest_rtmp_firewall = _validate_guest_rtmp_firewall(
        manifest_payload,
        artifact_files,
        required=schema_version == 2,
    )

    return SnapshotPlan(
        snapshot=snapshot,
        snapshot_kind=snapshot_kind,
        restore_image=restore_image,
        expected_version=version,
        expected_image_id=image_id,
        expected_repo_digest=repo_digest,
        guest_rtmp_firewall=guest_rtmp_firewall,
    )


def _main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("snapshot", nargs="?", type=Path)
    parser.add_argument(
        "--approved-root",
        action="append",
        type=Path,
        dest="approved_roots",
        help="approved parent directory for explicit rollback snapshots (repeatable)",
    )
    parser.add_argument(
        "--print-plan",
        action="store_true",
        help="print a tab-separated non-secret plan for rollback.sh",
    )
    parser.add_argument(
        "--print-firewall-plan",
        action="store_true",
        help="print the validated Guest RTMP firewall tuple for the feature rollback wrapper",
    )
    parser.add_argument(
        "--observe-ufw-status",
        type=Path,
        help="strictly observe the exact numbered Guest RTMP UFW rule in a captured status file",
    )
    parser.add_argument("--guest-ip")
    parser.add_argument("--kamrui-ip")
    parser.add_argument("--port", type=int, default=1935)
    parser.add_argument("--protocol", default="tcp")
    parser.add_argument("--action", default="ALLOW")
    parser.add_argument("--direction", default="IN")
    arguments = parser.parse_args(argv)

    if arguments.observe_ufw_status is not None:
        if arguments.snapshot is not None or arguments.print_plan or arguments.print_firewall_plan:
            parser.error("--observe-ufw-status cannot be combined with snapshot plan output")
        try:
            baseline = _firewall_baseline_from_payload(
                {
                    "action": arguments.action,
                    "direction": arguments.direction,
                    "guest_ip": arguments.guest_ip,
                    "kamrui_ip": arguments.kamrui_ip,
                    "port": arguments.port,
                    "protocol": arguments.protocol,
                    "present_before_cutover": False,
                },
                label="UFW observation request",
            )
            status_text = arguments.observe_ufw_status.read_text(encoding="utf-8")
            observation = observe_guest_rtmp_ufw_status(status_text, baseline)
        except (OSError, UnicodeDecodeError, SnapshotValidationError) as error:
            print(f"ERROR: {error}", file=sys.stderr)
            return 1
        print(f"{observation.exact_rule_number or 0}\t{observation.unrelated_fingerprint}")
        return 0

    if arguments.snapshot is None or not arguments.approved_roots:
        parser.error("snapshot and at least one --approved-root are required")
    try:
        plan = resolve_snapshot(arguments.snapshot, arguments.approved_roots)
    except SnapshotValidationError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1

    if arguments.print_plan:
        print(
            "\t".join(
                (
                    plan.snapshot_kind,
                    plan.restore_image,
                    plan.expected_version,
                    plan.expected_image_id,
                    plan.expected_repo_digest,
                )
            )
        )
    if arguments.print_firewall_plan:
        firewall = plan.guest_rtmp_firewall
        if firewall is None:
            print("ERROR: snapshot has no validated live-source firewall baseline", file=sys.stderr)
            return 1
        print(
            "\t".join(
                (
                    firewall.guest_ip,
                    firewall.kamrui_ip,
                    str(firewall.port),
                    firewall.protocol,
                    str(firewall.present_before_cutover).lower(),
                    firewall.action,
                    firewall.direction,
                )
            )
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(_main(sys.argv[1:]))
