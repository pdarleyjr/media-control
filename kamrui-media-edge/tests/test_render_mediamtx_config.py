"""Regression tests for the secret-bearing MediaMTX config renderer."""

from __future__ import annotations

import base64
import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest


EDGE_ROOT = Path(__file__).resolve().parents[1]
SCRIPT_PATH = EDGE_ROOT / "scripts" / "render-mediamtx-config.py"
TEMPLATE_PATH = EDGE_ROOT / "mediamtx.yml.tpl"
COMPOSE_PATH = EDGE_ROOT / "docker-compose.mediamtx.yml"
UPGRADE_PATH = EDGE_ROOT / "scripts" / "upgrade.sh"
ROLLBACK_PATH = EDGE_ROOT / "scripts" / "rollback.sh"
ADMIN_PATH = EDGE_ROOT / "mbfd-media-admin"


def load_renderer():
    spec = importlib.util.spec_from_file_location("render_mediamtx_config", SCRIPT_PATH)
    if spec is None or spec.loader is None:  # pragma: no cover - test setup failure
        raise RuntimeError("unable to load MediaMTX config renderer")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


RENDERER = load_renderer()


def complete_environment_values(**overrides: str) -> dict[str, str]:
    values = {
        "ANPVIZ_RTSP_URL": "rtsp://anpviz-user:anpviz-password@192.168.1.226:554/Streaming/Channels/101",
        "ZOWIEBOX_RTSP_URL": "rtsp://zowie-user:zowie-password@192.168.1.186:554/main/av",
        "KAMRUI_LAN_IP": "192.168.1.122",
        "KAMRUI_TAILSCALE_IP": "100.82.185.48",
        "P3_PUBLISHER_LAN_IP": "192.168.1.101",
        "P3_PUBLISHER_TAILSCALE_IP": "100.123.92.37",
        "GUEST_RTMP_PUBLISHER_LAN_IP": "192.168.1.150",
        "GUEST_RTMP_PUBLISHER_USER": "guest-obs",
        "GUEST_RTMP_PUBLISHER_PASSWORD_HASH": "sha256:ioLmivBaId5ZXlF9kBUrTRD8cfo/18K5jZA7PbueyF0=",
    }
    values.update(overrides)
    return values


def complete_environment(**overrides: str) -> str:
    return "".join(
        f"{key}={value}\n"
        for key, value in complete_environment_values(**overrides).items()
    )


class RenderMediaMtxConfigTests(unittest.TestCase):
    def render(self, environment: str) -> str:
        with tempfile.TemporaryDirectory() as temporary_dir:
            temporary = Path(temporary_dir)
            env_file = temporary / "camera.env"
            destination = temporary / "mediamtx.yml"
            env_file.write_text(environment, encoding="utf-8")
            RENDERER.render(env_file, TEMPLATE_PATH, destination)
            return destination.read_text(encoding="utf-8")

    def test_renders_podium_rtsp_and_guest_rtmp_with_narrow_publish_access(self) -> None:
        config = self.render(complete_environment())

        self.assertIn('rtmpAddress: "192.168.1.122:1935"', config)
        self.assertIn('source: "rtsp://zowie-user:zowie-password@192.168.1.186:554/main/av"', config)
        self.assertIn("podium-computer:\n    source:", config)
        self.assertIn("rtspTransport: tcp", config)
        self.assertIn("guest-computer:\n    source: publisher\n    overridePublisher: false", config)
        self.assertNotIn("sourceProtocol:", config)
        self.assertIn('user: "guest-obs"', config)
        self.assertIn('pass: "sha256:ioLmivBaId5ZXlF9kBUrTRD8cfo/18K5jZA7PbueyF0="', config)
        self.assertIn('ips: ["192.168.1.150"]', config)
        self.assertIn("action: publish\n        path: guest-computer", config)
        self.assertIn("action: publish\n        path: anpviz-main", config)
        self.assertIn("action: read\n        path:", config)
        self.assertNotIn("__", config)

    def test_fails_closed_when_guest_publisher_access_is_not_configured(self) -> None:
        environment = complete_environment(GUEST_RTMP_PUBLISHER_PASSWORD_HASH="")
        with tempfile.TemporaryDirectory() as temporary_dir:
            temporary = Path(temporary_dir)
            env_file = temporary / "camera.env"
            destination = temporary / "mediamtx.yml"
            env_file.write_text(environment, encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "GUEST_RTMP_PUBLISHER_PASSWORD_HASH"):
                RENDERER.render(env_file, TEMPLATE_PATH, destination)
            self.assertFalse(destination.exists())

    def test_rejects_unsafe_yaml_or_network_values_before_rendering(self) -> None:
        for key, value in {
            "GUEST_RTMP_PUBLISHER_USER": "guest\npermissions: []",
            "KAMRUI_LAN_IP": "not-an-ip-address",
        }.items():
            with self.subTest(key=key):
                with self.assertRaises(ValueError):
                    self.render(complete_environment(**{key: value}))

    def test_rejects_sha256_password_hashes_that_are_not_a_32_byte_base64_digest(self) -> None:
        for password_hash in (
            "sha256:not-base64!",
            "sha256:YWJj",
        ):
            with self.subTest(password_hash=password_hash):
                with self.assertRaisesRegex(ValueError, "SHA-256 MediaMTX hash"):
                    self.render(
                        complete_environment(
                            GUEST_RTMP_PUBLISHER_PASSWORD_HASH=password_hash,
                        ),
                    )

    def test_rejects_sha256_password_hashes_with_noncanonical_base64_pad_bits(self) -> None:
        digest = hashlib.sha256(b"test-only-canonical-base64-regression").digest()
        canonical = base64.standard_b64encode(digest).decode("ascii")
        alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
        final_character_index = alphabet.index(canonical[-2])

        # A 32-byte digest ends with one "="; the final non-padding character
        # therefore has two unused pad bits. Flip one without changing the bytes.
        self.assertTrue(canonical.endswith("="))
        self.assertEqual(final_character_index & 0b11, 0)
        noncanonical = f"{canonical[:-2]}{alphabet[final_character_index | 0b01]}{canonical[-1:]}"

        self.assertEqual(
            base64.b64decode(canonical, validate=True),
            digest,
        )
        self.assertEqual(
            base64.b64decode(noncanonical, validate=True),
            digest,
        )
        self.assertNotEqual(
            noncanonical,
            base64.standard_b64encode(base64.b64decode(noncanonical, validate=True)).decode("ascii"),
        )
        self.assertIsNone(
            RENDERER.validate_environment(
                complete_environment_values(
                    GUEST_RTMP_PUBLISHER_PASSWORD_HASH=f"sha256:{canonical}",
                ),
            ),
        )
        with self.assertRaisesRegex(ValueError, "canonical base64"):
            RENDERER.validate_environment(
                complete_environment_values(
                    GUEST_RTMP_PUBLISHER_PASSWORD_HASH=f"sha256:{noncanonical}",
                ),
            )

    def test_retains_argon2_guest_password_hash_support(self) -> None:
        password_hash = "argon2:$argon2id$v=19$m=65536,t=3,p=1$c2FsdA$Z2VzdC1wdWJsaXNoZXItaGFzaA"

        config = self.render(
            complete_environment(
                GUEST_RTMP_PUBLISHER_PASSWORD_HASH=password_hash,
            ),
        )

        self.assertIn(f'pass: "{password_hash}"', config)

    def test_compose_pins_the_observed_v1193_image_digest_without_changing_host_networking(self) -> None:
        compose = COMPOSE_PATH.read_text(encoding="utf-8")

        self.assertIn(
            "image: bluenviron/mediamtx:1.19.3@sha256:7797ed3df88df21e8c04ecd0aff08ce49a5232d1db453e51f5480ef36bc80865",
            compose,
        )
        self.assertNotIn("bluenviron/mediamtx:latest", compose)
        self.assertIn("network_mode: host", compose)

    def test_upgrade_and_rollback_recreate_only_the_pinned_mediamtx_service(self) -> None:
        upgrade = UPGRADE_PATH.read_text(encoding="utf-8")
        rollback = ROLLBACK_PATH.read_text(encoding="utf-8")

        self.assertIn("docker compose -f docker-compose.mediamtx.yml config --quiet", upgrade)
        self.assertIn("require_pinned_mediamtx_image", upgrade)
        self.assertIn("refusing floating MediaMTX image", upgrade)
        self.assertIn(
            "docker compose -f docker-compose.mediamtx.yml up -d --no-deps --force-recreate mediamtx",
            upgrade,
        )
        self.assertLess(
            upgrade.index("up -d --no-deps --force-recreate mediamtx"),
            upgrade.index("ufw-allow-guest-rtmp"),
        )
        self.assertNotIn("restart-mediamtx", upgrade)
        self.assertIn("validate-rollback-snapshot.py", rollback)
        self.assertIn("verified-legacy", rollback)
        self.assertIn('sudo docker pull "$RESTORE_IMAGE"', rollback)
        self.assertIn('COMPOSE_FILES+=(-f "$OVERRIDE")', rollback)
        self.assertIn('sudo docker compose "${COMPOSE_FILES[@]}" config --quiet', rollback)
        self.assertIn(
            'sudo docker compose "${COMPOSE_FILES[@]}" up -d --no-deps --force-recreate mediamtx',
            rollback,
        )
        self.assertIn('sudo docker exec "$CONTAINER" /mediamtx --version', rollback)
        self.assertNotIn("restart-camera-api", rollback)
        self.assertNotIn("camera-api/", rollback)
        self.assertNotIn("mbfd-media-admin", rollback)

    def test_guest_firewall_helper_adds_and_revokes_only_the_exact_rtmp_rule(self) -> None:
        admin = ADMIN_PATH.read_text(encoding="utf-8")
        start = admin.index("ufw-allow-guest-rtmp)")
        end = admin.index("ufw-revoke-guest-rtmp)", start)
        rule = admin[start:end]
        revoke_start = end
        revoke_end = admin.index("ufw-show)", revoke_start)
        revoke_rule = admin[revoke_start:revoke_end]

        self.assertIn("GUEST_RTMP_PUBLISHER_LAN_IP", rule)
        self.assertIn("KAMRUI_LAN_IP", rule)
        self.assertIn("port 1935 proto tcp", rule)
        self.assertNotIn("ufw --force reset", rule)
        self.assertIn("GUEST_RTMP_PUBLISHER_LAN_IP", revoke_rule)
        self.assertIn("ufw --force delete allow in", revoke_rule)
        self.assertIn("port 1935 proto tcp", revoke_rule)
        self.assertNotIn("ufw --force reset", revoke_rule)


if __name__ == "__main__":
    unittest.main()
