#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run with sudo: sudo ./scripts/uninstall-kamrui-kiosk.sh" >&2
  exit 1
fi

PRESERVE_CONFIG="${PRESERVE_CONFIG:-1}"

systemctl disable --now mbfd-console.service || true
systemctl disable --now mbfd-podium-agent.service || true
rm -f /etc/systemd/system/mbfd-console.service /etc/systemd/system/mbfd-podium-agent.service
rm -f /etc/systemd/logind.conf.d/mbfd-kiosk.conf
systemctl daemon-reload

rm -rf /opt/mbfd/media-control-console /opt/mbfd/podium-agent

if [[ "${PRESERVE_CONFIG}" != "1" ]]; then
  rm -rf /etc/mbfd/media-control-console
fi

systemctl set-default graphical.target || true
systemctl enable --now gdm3.service || systemctl start display-manager.service || true

echo "MBFD kiosk application removed. Config preserved: ${PRESERVE_CONFIG}"
