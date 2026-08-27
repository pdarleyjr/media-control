#!/usr/bin/env python3
"""Start the real v1.19.3 parser in a disposable loopback-only test harness.

MediaMTX v1.19.3 has no configuration-only command: parsing immediately starts
listeners and source pulls. This harness keeps the topology and authentication
syntax intact while moving listeners to unused loopback ports and sources to an
unreachable loopback RTSP endpoint. It never contacts KAMRUI, ZowieBox, Anpviz,
or a guest computer. When an FFmpeg binary is supplied, it additionally proves
that a wrong guest credential is rejected and the scoped guest credential can
publish H.264/AAC to only the intended RTMP path.
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from urllib.error import HTTPError, URLError
from urllib.request import urlopen


EDGE_ROOT = Path(__file__).resolve().parents[1]
RENDERER_PATH = EDGE_ROOT / "scripts" / "render-mediamtx-config.py"
TEMPLATE_PATH = EDGE_ROOT / "mediamtx.yml.tpl"


def load_renderer():
    spec = importlib.util.spec_from_file_location("render_mediamtx_config", RENDERER_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError("unable to load MediaMTX config renderer")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def path_status(path_name: str) -> tuple[bool, str]:
    try:
        with urlopen(f"http://127.0.0.1:19997/v3/paths/get/{path_name}", timeout=3) as response:
            payload = json.load(response)
    except (HTTPError, URLError, TimeoutError) as error:
        return False, str(error)
    # v1.19.3 returns the path object directly. Accept the nested form as well
    # so a harmless API response-shape change does not turn authentication
    # proof into a false negative.
    return payload.get("ready") is True or payload.get("item", {}).get("ready") is True, json.dumps(payload)


def main(argv: list[str]) -> int:
    if len(argv) not in {2, 3}:
        print("usage: validate_mediamtx_v1193.py /absolute/path/to/mediamtx [ffmpeg]", file=sys.stderr)
        return 2

    binary = Path(argv[1]).resolve()
    if not binary.is_file():
        print("MediaMTX binary does not exist", file=sys.stderr)
        return 2
    ffmpeg = Path(argv[2]).resolve() if len(argv) == 3 else None
    if ffmpeg is not None and not ffmpeg.is_file():
        print("FFmpeg binary does not exist", file=sys.stderr)
        return 2

    version = subprocess.run(
        [str(binary), "--version"],
        check=False,
        capture_output=True,
        text=True,
        timeout=10,
    )
    if version.returncode != 0 or "v1.19.3" not in f"{version.stdout}\n{version.stderr}":
        print("provided binary is not MediaMTX v1.19.3", file=sys.stderr)
        return 1

    renderer = load_renderer()
    with tempfile.TemporaryDirectory(prefix="mbfd-mediamtx-v1193-") as directory:
        temporary = Path(directory)
        environment = temporary / "camera.env"
        rendered = temporary / "mediamtx.yml"
        environment.write_text(
            "\n".join(
                (
                    "ANPVIZ_RTSP_URL=rtsp://test:password@127.0.0.1:1/anpviz",
                    "ZOWIEBOX_RTSP_URL=rtsp://test:password@127.0.0.1:1/zowiebox",
                    "KAMRUI_LAN_IP=127.0.0.1",
                    "KAMRUI_TAILSCALE_IP=127.0.0.2",
                    "P3_PUBLISHER_LAN_IP=127.0.0.3",
                    "P3_PUBLISHER_TAILSCALE_IP=127.0.0.4",
                    "GUEST_RTMP_PUBLISHER_LAN_IP=127.0.0.1",
                    "GUEST_RTMP_PUBLISHER_USER=guest-obs",
                    "GUEST_RTMP_PUBLISHER_PASSWORD_HASH=sha256:ioLmivBaId5ZXlF9kBUrTRD8cfo/18K5jZA7PbueyF0=",
                    "",
                )
            ),
            encoding="utf-8",
        )
        renderer.render(environment, TEMPLATE_PATH, rendered)

        config = rendered.read_text(encoding="utf-8")
        loopback_overrides = {
            "apiAddress: 127.0.0.1:9997": "apiAddress: 127.0.0.1:19997",
            'rtmpAddress: "127.0.0.1:1935"': 'rtmpAddress: "127.0.0.1:11935"',
            "rtspAddress: :8554": "rtspAddress: 127.0.0.1:18554",
            "hlsAddress: :8888": "hlsAddress: 127.0.0.1:18888",
            "webrtcAddress: :8889": "webrtcAddress: 127.0.0.1:18889",
            "webrtcLocalUDPAddress: :8189": "webrtcLocalUDPAddress: 127.0.0.1:18189",
        }
        for original, replacement in loopback_overrides.items():
            if original not in config:
                print("staging configuration rewrite target is missing", file=sys.stderr)
                return 1
            config = config.replace(original, replacement)
        rendered.write_text(config, encoding="utf-8")

        process = subprocess.Popen(
            [str(binary), str(rendered)],
            cwd=temporary,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        try:
            time.sleep(2)
            returncode = process.poll()
            if returncode is not None:
                output = process.communicate(timeout=5)[0]
                print("MediaMTX v1.19.3 rejected the staged configuration", file=sys.stderr)
                print(output[-4000:], file=sys.stderr)
                return 1
            if ffmpeg is not None:
                base_arguments = [
                    str(ffmpeg),
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-re",
                    "-f",
                    "lavfi",
                    "-i",
                    "testsrc2=size=320x180:rate=30",
                    "-f",
                    "lavfi",
                    "-i",
                    "sine=frequency=1000:sample_rate=48000",
                    "-t",
                    "5",
                    "-c:v",
                    "libx264",
                    "-pix_fmt",
                    "yuv420p",
                    "-g",
                    "60",
                    "-c:a",
                    "aac",
                    "-ar",
                    "48000",
                    "-ac",
                    "2",
                    "-b:a",
                    "128k",
                    "-f",
                    "flv",
                ]
                def publish_and_observe(url: str, path_name: str) -> tuple[bool, int, str, list[str]]:
                    publisher = subprocess.Popen(
                        [*base_arguments, url],
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.PIPE,
                        text=True,
                    )
                    observations = []
                    try:
                        ready = False
                        for _ in range(24):
                            time.sleep(0.25)
                            sample_ready, status = path_status(path_name)
                            observations.append(status)
                            ready = ready or sample_ready
                        _stdout, stderr = publisher.communicate(timeout=10)
                        return ready, publisher.returncode, stderr, observations
                    except subprocess.TimeoutExpired:
                        publisher.terminate()
                        _stdout, stderr = publisher.communicate(timeout=5)
                        sample_ready, status = path_status(path_name)
                        observations.append(status)
                        return ready or sample_ready, publisher.returncode, stderr, observations

                rejected_ready, _rejected_code, _rejected_stderr, rejected_observations = publish_and_observe(
                    "rtmp://127.0.0.1:11935/guest-computer?user=wrong&pass=wrong",
                    "guest-computer",
                )
                if rejected_ready:
                    print("MediaMTX accepted an unauthorized guest RTMP publisher", file=sys.stderr)
                    print("\n".join(rejected_observations[-4:]), file=sys.stderr)
                    return 1
                wrong_path_ready, _wrong_path_code, _wrong_path_stderr, wrong_path_observations = publish_and_observe(
                    "rtmp://127.0.0.1:11935/anpviz-main?user=guest-obs&pass=test-only-long-password",
                    "anpviz-main",
                )
                if wrong_path_ready:
                    print("MediaMTX allowed the guest credential to publish a different path", file=sys.stderr)
                    print("\n".join(wrong_path_observations[-4:]), file=sys.stderr)
                    return 1
                accepted_ready, _accepted_code, accepted_stderr, accepted_observations = publish_and_observe(
                    "rtmp://127.0.0.1:11935/guest-computer?user=guest-obs&pass=test-only-long-password",
                    "guest-computer",
                )
                if not accepted_ready:
                    print("MediaMTX rejected the scoped guest RTMP publisher", file=sys.stderr)
                    print(accepted_stderr[-4000:], file=sys.stderr)
                    print("\n".join(accepted_observations[-4:]), file=sys.stderr)
                    if process.poll() is None:
                        process.terminate()
                        print(process.communicate(timeout=5)[0][-4000:], file=sys.stderr)
                    return 1
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.communicate(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.communicate(timeout=5)

    if ffmpeg is None:
        print("MediaMTX v1.19.3 staged configuration accepted")
    else:
        print("MediaMTX v1.19.3 staged configuration and guest RTMP access accepted")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
