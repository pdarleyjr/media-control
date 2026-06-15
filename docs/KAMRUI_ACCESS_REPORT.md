# Kamrui Access Report

## Verified Access

- Kamrui SSH alias discovered: `mbfd-ubuntu`.
- Verified SSH command on Windows: `C:\Program Files\OpenSSH\ssh.exe mbfd-ubuntu`.
- SSH user: `peter`.
- Hostname: `peter-Default-string`.
- Tailscale IP: `100.82.185.48`.
- MagicDNS name observed: `peter-default-string.tail5d82ff.ts.net`.
- Tailscale ping from this workstation succeeded over direct LAN in approximately 2 ms.

## Operating System and Hardware

- OS: Ubuntu 24.04.4 LTS Noble.
- Kernel: `6.17.0-35-generic`.
- Architecture: x86_64.
- CPU: 4 cores.
- Memory: approximately 11 GiB RAM plus 4 GiB swap.
- Root filesystem: approximately 233 GiB with roughly 196 GiB free.
- Additional mount: `/mnt/data` around 1.8 TiB.

## User and Privilege Notes

- Current remote user: `peter`.
- Groups include `sudo`, `docker`, and `mbfd`.
- Docker daemon is reachable by `peter`.
- General passwordless sudo is not available on the Kamrui. `sudo -n true` fails.
- A narrow NOPASSWD rule exists for one MBFD Hub ownership command only.
- Monday installation will need the sudo password typed once at the terminal or a temporary NOPASSWD install window.

## Desktop and Display State

- GDM/GNOME is active with a `gdm-autologin` Wayland session.
- `display-manager` and `gdm3` are active.
- DRM devices exist at `/dev/dri/card0` and `/dev/dri/renderD128`.
- Display connectors reported disconnected during verification: `DP-1`, `HDMI-A-1`, `HDMI-A-2`.
- No touchscreen-like input device was detected in `/proc/bus/input/devices` during verification.
- Interpretation: the UPERFECT HDMI and USB touch cable were not connected, or not detected, at the time of access verification.

## Network

- Ethernet/LAN address observed: `192.168.1.122/24` on `enp1s0`.
- Wi-Fi/secondary address observed: `10.236.80.155/8` on `wlp2s0`.
- Tailscale address: `100.82.185.48/32` on `tailscale0`.
- Default route was primarily through `192.168.1.1`.
- Kamrui can reach the GMKtec server over Tailscale.
- Kamrui can reach GitHub, `mbfdhub.com`, and npm registry endpoints.

## Tooling

- Node.js: `v18.19.1` currently installed.
- npm: `9.2.0`.
- pnpm: not installed at verification time.
- Git: `2.43.0`.
- Docker: installed and daemon reachable.
- Docker Compose: installed.
- curl and Python 3.12 are present.
- systemd is available but degraded because `logrotate.service` was failed.

## GitHub Readiness

- HTTPS and SSH private repo access were not configured on the Kamrui at verification time.
- `git ls-remote` to the private repo over HTTPS reached GitHub but failed for credentials.
- `git ls-remote` over SSH failed with `Permission denied (publickey)`.
- Monday options:
  - clone using a temporary GitHub token,
  - install a deploy key,
  - use `gh auth login`, or
  - copy a release bundle over SSH/Tailscale.

## Installation Readiness

- Ready for SSH inspection and user-level work.
- Ready for Docker work that does not need private GitHub credentials.
- Not fully ready for unattended install until sudo/password, GitHub repo access, Node 22/pnpm, and display/touch hardware are addressed.
- The installer will upgrade/install Node 22 and pnpm automatically once sudo is available.
