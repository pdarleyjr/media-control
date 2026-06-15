# Monday Checklist

## Hardware

- [ ] Kamrui AK1 Plus powered on.
- [ ] UPERFECT HDMI connected.
- [ ] UPERFECT USB touch cable connected.
- [ ] Temporary Ethernet connected if available.
- [ ] Starlink Wi-Fi connected.

## Access

- [ ] SSH works: `C:\Program Files\OpenSSH\ssh.exe mbfd-ubuntu`.
- [ ] Tailscale IP confirmed: `tailscale ip -4`.
- [ ] sudo password available.
- [ ] GitHub private repo access configured.

## Install

- [ ] Clone/pull repo.
- [ ] Checkout `feature/media-control-console-kiosk`.
- [ ] Run `sudo ./scripts/install-kamrui-kiosk.sh`.
- [ ] Edit `/etc/mbfd/media-control-console/config.env`.
- [ ] Confirm `MBFD_CONSOLE_URL` points to `/console/classroom-1`.
- [ ] Confirm `ROOM_ID=classroom-1`.
- [ ] Confirm `DEVICE_ID=classroom-1-podium-console`.
- [ ] Confirm `DEFAULT_PROFILE=guest`.
- [ ] Confirm `ADMIN_PIN` is known.

## Test Before Reboot

- [ ] `systemctl status mbfd-podium-agent.service` is healthy.
- [ ] `curl -s http://127.0.0.1:8755/health | jq` returns JSON.
- [ ] `systemctl status mbfd-console.service` is not crash-looping.
- [ ] Display is detected.
- [ ] Touchscreen is detected.

## Reboot Test

- [ ] `sudo reboot`.
- [ ] Console appears fullscreen.
- [ ] No browser chrome appears.
- [ ] No OS desktop/taskbar appears.
- [ ] No login prompt appears.
- [ ] Guest loads automatically.
- [ ] Profile dropdown appears in top header.
- [ ] Switching profile reloads that member's content/settings.
- [ ] Video Wall 1/2, Smartboard, Sources, Content Library, and placeholder controls are visible through Command Center.
- [ ] Long-press MBFD logo opens admin PIN panel.
- [ ] Reconnect and Device Info work from admin panel.

## Network Test

- [ ] Disconnect temporary Ethernet.
- [ ] Confirm Wi-Fi-only operation.
- [ ] Confirm Tailscale SSH still works.

## Recovery Test

- [ ] Run `sudo ./scripts/emergency-disable-kiosk.sh` from SSH.
- [ ] Confirm desktop/terminal recovery path works.
- [ ] Re-enable kiosk with `sudo systemctl enable --now mbfd-console.service` when done.
