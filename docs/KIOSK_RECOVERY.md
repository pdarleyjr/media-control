# Kiosk Recovery

## Hidden Local Admin Panel

1. Long-press the MBFD logo in the top console header for 5 seconds.
2. Enter the configured `ADMIN_PIN`.
3. Available actions:
   - Reconnect
   - Restart App
   - Device Info
   - Exit Kiosk
   - Reboot Device
   - Disable Kiosk

## SSH Recovery Through Tailscale

From Windows:

```powershell
& "C:\Program Files\OpenSSH\ssh.exe" mbfd-ubuntu
```

Useful checks:

```bash
hostname
tailscale ip -4
systemctl status mbfd-console.service
systemctl status mbfd-podium-agent.service
journalctl -u mbfd-console.service -n 200 --no-pager
journalctl -u mbfd-podium-agent.service -n 200 --no-pager
```

## Stop Kiosk Temporarily

```bash
sudo systemctl stop mbfd-console.service
```

## Disable Kiosk and Restore Desktop

From the repo checkout:

```bash
sudo ./scripts/emergency-disable-kiosk.sh
```

Manual equivalent:

```bash
sudo systemctl disable --now mbfd-console.service
sudo systemctl set-default graphical.target
sudo systemctl enable --now gdm3.service || sudo systemctl start display-manager.service
sudo systemctl start getty@tty1.service
```

## Restart Console

```bash
sudo systemctl restart mbfd-podium-agent.service
sudo systemctl restart mbfd-console.service
```

## View Logs

```bash
journalctl -u mbfd-console.service -f
journalctl -u mbfd-podium-agent.service -f
tail -f /var/log/mbfd-podium-agent.log
```

Electron also writes an app log under the kiosk user's Electron user-data directory.

## Roll Back Code

```bash
cd /path/to/media-control
git fetch origin
git checkout <known-good-branch-or-tag>
sudo ./scripts/update-console.sh
```

## Recover From Blank Screen

1. SSH in through Tailscale.
2. Stop the console service:
   ```bash
   sudo systemctl stop mbfd-console.service
   ```
3. Check display detection:
   ```bash
   ls /dev/dri
   sudo dmesg | grep -iE 'drm|hdmi|display|touch' | tail -80
   ```
4. Check Cage/Electron logs:
   ```bash
   journalctl -u mbfd-console.service -n 200 --no-pager
   ```
5. If needed, restore desktop:
   ```bash
   sudo ./scripts/emergency-disable-kiosk.sh
   ```

## Recover From Network Loss

- The Electron app shows an offline screen and retries automatically.
- If Tailscale is unavailable, attach keyboard/Ethernet locally and check:
  ```bash
  nmcli device status
  tailscale status
  ping -c 3 github.com
  curl -I https://media-control.mbfdhub.com/console/classroom-1
  ```

## Recover From Bad Config

```bash
sudo nano /etc/mbfd/media-control-console/config.env
sudo systemctl restart mbfd-console.service
```

Set `KIOSK_MODE=false` and `ENABLE_DEVTOOLS=true` temporarily for debugging.
