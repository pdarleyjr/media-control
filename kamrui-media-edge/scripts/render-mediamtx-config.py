#!/usr/bin/env python3
"""Render the KAMRUI MediaMTX configuration without logging secret values."""

from __future__ import annotations

import base64
import binascii
import ipaddress
import json
import os
from pathlib import Path
import re
import sys
import tempfile
from urllib.parse import urlparse


REQUIRED = (
    "ANPVIZ_RTSP_URL",
    "ZOWIEBOX_RTSP_URL",
    "KAMRUI_LAN_IP",
    "KAMRUI_TAILSCALE_IP",
    "P3_PUBLISHER_LAN_IP",
    "P3_PUBLISHER_TAILSCALE_IP",
    "GUEST_RTMP_PUBLISHER_LAN_IP",
    "GUEST_RTMP_PUBLISHER_USER",
    "GUEST_RTMP_PUBLISHER_PASSWORD_HASH",
)
RTSP_URL_KEYS = ("ANPVIZ_RTSP_URL", "ZOWIEBOX_RTSP_URL")
IP_KEYS = (
    "KAMRUI_LAN_IP",
    "KAMRUI_TAILSCALE_IP",
    "P3_PUBLISHER_LAN_IP",
    "P3_PUBLISHER_TAILSCALE_IP",
    "GUEST_RTMP_PUBLISHER_LAN_IP",
)
ENVIRONMENT_KEY = re.compile(r"^[A-Z][A-Z0-9_]*$")
MEDIAMTX_PLAIN_CREDENTIAL = re.compile(r"^[a-zA-Z0-9!$()*+.;<=>\[\]^_\-{}@#&]+$")


def load_environment(source: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for line_number, raw_line in enumerate(source.read_text(encoding="utf-8").splitlines(), start=1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            raise ValueError(f"camera environment contains malformed entry at line {line_number}")
        key, value = line.split("=", 1)
        key = key.strip()
        if not ENVIRONMENT_KEY.fullmatch(key):
            raise ValueError(f"camera environment contains unsupported key at line {line_number}")
        values[key] = value

    missing = [key for key in REQUIRED if not values.get(key)]
    if missing:
        raise ValueError(f"camera environment is missing required keys: {', '.join(missing)}")
    validate_environment(values)
    return values


def validate_environment(values: dict[str, str]) -> None:
    for key in RTSP_URL_KEYS:
        value = values[key]
        if any(character in value for character in "\r\n\x00"):
            raise ValueError(f"{key} contains unsafe characters")
        parsed = urlparse(value)
        if parsed.scheme.lower() != "rtsp" or not parsed.hostname:
            raise ValueError(f"{key} must be an RTSP URL")

    for key in IP_KEYS:
        try:
            parsed_ip = ipaddress.ip_address(values[key])
        except ValueError as error:
            raise ValueError(f"{key} must be an IPv4 address") from error
        if parsed_ip.version != 4:
            raise ValueError(f"{key} must be an IPv4 address")

    user = values["GUEST_RTMP_PUBLISHER_USER"]
    if not MEDIAMTX_PLAIN_CREDENTIAL.fullmatch(user):
        raise ValueError("GUEST_RTMP_PUBLISHER_USER contains unsupported MediaMTX credential characters")

    password_hash = values["GUEST_RTMP_PUBLISHER_PASSWORD_HASH"]
    if any(character in password_hash for character in "\r\n\x00") or not password_hash.startswith(("argon2:", "sha256:")):
        raise ValueError("GUEST_RTMP_PUBLISHER_PASSWORD_HASH must be an Argon2 or SHA-256 MediaMTX hash")
    if password_hash.startswith("sha256:"):
        encoded = password_hash.removeprefix("sha256:")
        try:
            digest = base64.b64decode(encoded, validate=True)
        except (ValueError, binascii.Error) as error:
            raise ValueError(
                "GUEST_RTMP_PUBLISHER_PASSWORD_HASH SHA-256 MediaMTX hash must be valid base64",
            ) from error
        if len(digest) != 32:
            raise ValueError(
                "GUEST_RTMP_PUBLISHER_PASSWORD_HASH SHA-256 MediaMTX hash must decode to 32 bytes",
            )
        if base64.standard_b64encode(digest).decode("ascii") != encoded:
            raise ValueError(
                "GUEST_RTMP_PUBLISHER_PASSWORD_HASH SHA-256 MediaMTX hash must be canonical base64",
            )


def yaml_scalar(value: str) -> str:
    """Return a YAML-compatible quoted scalar without exposing it in logs."""
    return json.dumps(value, ensure_ascii=False)


def render(source: Path, template: Path, destination: Path) -> None:
    values = load_environment(source)
    output = template.read_text(encoding="utf-8")
    replacements = {
        "__ANPVIZ_RTSP_URL__": yaml_scalar(values["ANPVIZ_RTSP_URL"]),
        "__ZOWIEBOX_RTSP_URL__": yaml_scalar(values["ZOWIEBOX_RTSP_URL"]),
        "__KAMRUI_RTMP_ADDRESS__": yaml_scalar(f'{values["KAMRUI_LAN_IP"]}:1935'),
        "__KAMRUI_LAN_IP__": yaml_scalar(values["KAMRUI_LAN_IP"]),
        "__KAMRUI_TAILSCALE_IP__": yaml_scalar(values["KAMRUI_TAILSCALE_IP"]),
        "__P3_PUBLISHER_LAN_IP__": yaml_scalar(values["P3_PUBLISHER_LAN_IP"]),
        "__P3_PUBLISHER_TAILSCALE_IP__": yaml_scalar(values["P3_PUBLISHER_TAILSCALE_IP"]),
        "__GUEST_RTMP_PUBLISHER_LAN_IP__": yaml_scalar(values["GUEST_RTMP_PUBLISHER_LAN_IP"]),
        "__GUEST_RTMP_PUBLISHER_USER__": yaml_scalar(values["GUEST_RTMP_PUBLISHER_USER"]),
        "__GUEST_RTMP_PUBLISHER_PASSWORD_HASH__": yaml_scalar(values["GUEST_RTMP_PUBLISHER_PASSWORD_HASH"]),
    }
    for token, replacement in replacements.items():
        output = output.replace(token, replacement)
    if re.search(r"__[A-Z0-9_]+__", output):
        raise ValueError("MediaMTX template has unresolved placeholders")

    destination.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary_name = tempfile.mkstemp(
        prefix=f".{destination.name}.",
        dir=destination.parent,
        text=True,
    )
    temporary = Path(temporary_name)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(output)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, destination)
        os.chmod(destination, 0o600)
    finally:
        if temporary.exists():
            temporary.unlink()


def main(argv: list[str]) -> int:
    if len(argv) != 4:
        print("usage: render-mediamtx-config.py ENV TEMPLATE DESTINATION", file=sys.stderr)
        return 2
    try:
        render(Path(argv[1]), Path(argv[2]), Path(argv[3]))
    except Exception as error:
        print(f"MediaMTX configuration render failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
