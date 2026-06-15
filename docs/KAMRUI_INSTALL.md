# Kamrui Install Guide

## Preconditions

- Kamrui reachable over Tailscale/SSH as `mbfd-ubuntu`.
- sudo password available for user `peter` or a temporary install-time NOPASSWD rule.
- GitHub private repo access available on the Kamrui through `gh auth login`, a deploy key, or a temporary token.
- UPERFECT HDMI cable connected.
- UPERFECT USB touch cable connected.
- Starlink Wi-Fi configured; temporary Ethernet recommended during install.

## Monday Install Steps

1. Boot the Kamrui.
2. Connect temporary Ethernet if available.
3. Connect the UPERFECT monitor over HDMI.
4. Connect the UPERFECT USB touch cable.
5. Confirm Tailscale and SSH from this workstation:
   ```powershell
   & "C:\Program Files\OpenSSH\ssh.exe" mbfd-ubuntu 'hostname; tailscale ip -4; ip -brief addr'
   ```
6. Clone or update the repo branch:
   ```bash
   git clone https://github.com/pdarleyjr/media-control.git
   cd media-control
   git checkout feature/media-control-console-kiosk
   ```
7. Run the installer:
   ```bash
   sudo ./scripts/install-kamrui-kiosk.sh
   ```
8. Edit the config file:
   ```bash
   sudo nano /etc/mbfd/media-control-console/config.env
   ```
9. Confirm these values:
   ```env
   MBFD_CONSOLE_URL=https://media-control.mbfdhub.com/console/classroom-1
   ROOM_ID=classroom-1
   DEVICE_ID=classroom-1-podium-console
   DEFAULT_PROFILE=guest
   DEVICE_TOKEN=<match server CONSOLE_DEVICE_TOKEN/DEVICE_TOKEN if required>
   ADMIN_PIN=<known service PIN>
   KIOSK_MODE=true
   ```
10. Test touchscreen detection:
   ```bash
   sudo libinput list-devices | grep -i -A8 'touch\|uperfect' || cat /proc/bus/input/devices
   ```
11. Test services before reboot:
   ```bash
   systemctl status mbfd-podium-agent.service
   systemctl status mbfd-console.service
   curl -s http://127.0.0.1:8755/health | jq
   ```
12. Reboot:
   ```bash
   sudo reboot
   ```
13. Confirm it boots into the console.
14. Confirm Guest loads automatically with no login prompt.
15. Open the top profile dropdown and switch to another member.
16. Confirm that member's content/settings load.
17. Disconnect Ethernet and confirm Wi-Fi-only operation.
18. Test emergency recovery from SSH:
   ```bash
   sudo ./scripts/emergency-disable-kiosk.sh
   ```

## Installer Behavior

- Installs Node.js 22 if needed.
- Enables pnpm 9.12.0 through Corepack.
- Installs Cage and Electron runtime dependencies.
- Creates `mbfdkiosk`.
- Builds and packages the Electron app.
- Installs the console to `/opt/mbfd/media-control-console`.
- Installs the podium agent to `/opt/mbfd/podium-agent`.
- Writes config to `/etc/mbfd/media-control-console/config.env` if missing.
- Installs `mbfd-console.service` and `mbfd-podium-agent.service`.
- Sets the system default target to `multi-user.target` and disables the display manager unless `MBFD_KEEP_DISPLAY_MANAGER=1` is set.

## Ubuntu Desktop/GDM Note

The Kamrui currently runs GNOME/GDM. The production kiosk path disables the display manager so Cage owns the console session. If this conflicts with graphics hardware, run:

```bash
sudo ./scripts/emergency-disable-kiosk.sh
```

Then inspect logs and, if needed, set `MBFD_KEEP_DISPLAY_MANAGER=1` before rerunning the installer for a GNOME-assisted recovery/debug install.

## Local Testing URL

For local development on a workstation:

```env
MBFD_CONSOLE_URL=http://localhost:5173/console/classroom-1
ALLOWED_HOSTS=localhost,127.0.0.1
KIOSK_MODE=false
ENABLE_DEVTOOLS=true
```
