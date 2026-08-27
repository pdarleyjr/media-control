from __future__ import annotations

import shutil
import subprocess
import unittest
from pathlib import Path


EDGE_ROOT = Path(__file__).resolve().parents[1]
COLLECTOR = EDGE_ROOT / "scripts" / "collect-guest-laptop-network.ps1"
POLICY = EDGE_ROOT / "scripts" / "guest-network-adapter-policy.ps1"
POWERSHELL_TEST = Path(__file__).with_name("test_guest_network_adapter_policy.ps1")
README = EDGE_ROOT / "README.md"


class GuestLaptopCollectorRegressionTests(unittest.TestCase):
    def test_collector_uses_the_shared_selection_function(self) -> None:
        contents = COLLECTOR.read_text(encoding="utf-8")

        self.assertIn("guest-network-adapter-policy.ps1", contents)
        self.assertIn("Select-GuestWiredEthernetAdapter", contents)
        self.assertIn("testNetConnectionUsesSelectedEthernet", contents)
        self.assertIn("testNetConnectionSourceMatchesSelectedEthernet", contents)
        self.assertIn("Test-GuestNetworkFullDuplexWhereObservable", contents)
        self.assertIn("$hasExplicitNonFullDuplex", contents)
        self.assertIn("100 Mbps can carry the stream", contents)
        link_warning_position = contents.index("100 Mbps can carry the stream")
        self.assertIn(
            "$verdict = 'AMBER'",
            contents[max(0, link_warning_position - 160) : link_warning_position],
        )
        self.assertNotIn("$ethernetCandidates = @(\n    $allAdapters | Where-Object", contents)

        selection_position = contents.index("Select-GuestWiredEthernetAdapter")
        ping_position = contents.index("& ping.exe")
        self.assertLess(
            selection_position,
            ping_position,
            "adapter selection must complete before the collector can send ICMP",
        )

    def test_policy_rejects_required_non_wired_identities(self) -> None:
        contents = POLICY.read_text(encoding="utf-8")

        for forbidden_identity in (
            "Wi-Fi",
            "Wireless",
            "802\\.11",
            "WLAN",
            "Bluetooth",
            "Tailscale",
            "TAP",
            "VPN",
            "Virtual",
            "Hyper-V",
            "WAN Miniport",
            "Loopback",
            "Kernel Debug",
        ):
            self.assertIn(forbidden_identity, contents)

        self.assertIn("HardwareInterface", contents)
        self.assertIn("Status", contents)

    def test_readme_requires_the_collector_policy_companion(self) -> None:
        contents = README.read_text(encoding="utf-8")

        self.assertIn("guest-network-adapter-policy.ps1", contents)
        self.assertIn("Do not copy only", contents)

    def test_behavioral_adapter_policy_regressions(self) -> None:
        powershell = shutil.which("powershell.exe") or shutil.which("powershell")
        if powershell is None:
            self.skipTest("Windows PowerShell is required for collector policy regression tests")

        completed = subprocess.run(
            [
                powershell,
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                str(POWERSHELL_TEST),
            ],
            cwd=EDGE_ROOT,
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(
            completed.returncode,
            0,
            msg=f"stdout:\n{completed.stdout}\nstderr:\n{completed.stderr}",
        )
        self.assertIn("guest-network adapter policy regression tests passed", completed.stdout)


if __name__ == "__main__":
    unittest.main()
