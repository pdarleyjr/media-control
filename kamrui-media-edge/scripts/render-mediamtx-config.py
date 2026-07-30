#!/usr/bin/env python3
"""Render MediaMTX camera URLs without writing secret values to stdout."""

from __future__ import annotations

import os
from pathlib import Path
import sys
import tempfile


REQUIRED = (
    "ANPVIZ_RTSP_URL",
    "ZOWIEBOX_RTSP_URL",
)


def load_environment(source: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw_line in source.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value
    missing = [key for key in REQUIRED if not values.get(key)]
    if missing:
        raise ValueError(f"camera environment is missing required keys: {', '.join(missing)}")
    return values


def render(source: Path, template: Path, destination: Path) -> None:
    values = load_environment(source)
    output = template.read_text(encoding="utf-8")
    output = output.replace("__ANPVIZ_RTSP_URL__", values["ANPVIZ_RTSP_URL"])
    output = output.replace("__ZOWIEBOX_RTSP_URL__", values["ZOWIEBOX_RTSP_URL"])

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

