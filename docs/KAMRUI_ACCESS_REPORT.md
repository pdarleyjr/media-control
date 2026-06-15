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
- Sudo credentials were provided during setup and used for installation; do not store them in repo files.

## Desktop and Display State

- GDM/GNOME was active before kiosk installation.
- After installation, the default target is `multi-user.target` and `mbfd-console.service` owns the normal kiosk session.
- DRM devices exist at `/dev/dri/card0` and `/dev/dri/renderD128`.
- Touchscreen confirmed after hardware connection: `Silicon Integrated System Co. SiS HID Touch Controller`.
- `mbfd-console.service` is active and running Cage/Electron on tty1.

## Network

- Ethernet/LAN address observed: `192.168.1.122/24` on `enp1s0`.
- Wi-Fi/secondary address observed: `10.236.80.155/8` on `wlp2s0`.
- Tailscale address: `100.82.185.48/32` on `tailscale0`.
- Default route was primarily through `192.168.1.1`.
- Kamrui can reach the GMKtec server over Tailscale.
- Kamrui can reach GitHub, `mbfdhub.com`, and npm registry endpoints.

## Tooling

- Node.js was upgraded by the installer from `v18.19.1` to Node 22 LTS.
- pnpm 9.12.0 was enabled through Corepack by the installer.
- Git: `2.43.0`.
- Docker: installed and daemon reachable.
- Docker Compose: installed.
- curl and Python 3.12 are present.
- systemd is available but degraded because `logrotate.service` was failed.

## GitHub Readiness

- Private GitHub clone access was not required for the first install because the branch archive was copied over Tailscale SSH from the development workstation.

## Installation Readiness

- Installed under `/home/peter/media-control-console-kiosk` and `/opt/mbfd/media-control-console`.
- `mbfd-podium-agent.service` is active.
- `mbfd-console.service` is active and running Cage/Electron.
- Touchscreen hardware is detected.
- Console config is installed at `/etc/mbfd/media-control-console/config.env` with group-readable access for `mbfdkiosk`.
