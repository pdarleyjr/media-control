#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run with sudo: sudo ./scripts/emergency-disable-kiosk.sh" >&2
  exit 1
fi

echo "[mbfd-recovery] Disabling kiosk services"
systemctl disable --now mbfd-console.service || true
systemctl stop mbfd-podium-agent.service || true
systemctl set-default graphical.target || true

if systemctl list-unit-files gdm3.service >/dev/null 2>&1; then
  systemctl enable gdm3.service || true
  systemctl start gdm3.service || true
else
  systemctl start display-manager.service || true
fi

systemctl start getty@tty1.service || true

cat <<'EOF'
[mbfd-recovery] Kiosk disabled. Useful diagnostics:
  journalctl -u mbfd-console.service -n 200 --no-pager
  journalctl -u mbfd-podium-agent.service -n 200 --no-pager
  systemctl status display-manager.service
EOF
