#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run with sudo: sudo ./scripts/update-console.sh" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${REPO_ROOT}"
git pull --ff-only
corepack enable
corepack prepare pnpm@9.12.0 --activate
pnpm install
pnpm build
pnpm package:linux

systemctl stop mbfd-console.service || true
rsync -a --delete "${REPO_ROOT}/apps/console-linux/release/linux-unpacked/" /opt/mbfd/media-control-console/
rsync -a --delete "${REPO_ROOT}/services/podium-agent/dist/" /opt/mbfd/podium-agent/dist/
chown -R mbfdkiosk:mbfdkiosk /opt/mbfd/media-control-console
systemctl restart mbfd-podium-agent.service
systemctl restart mbfd-console.service

echo "MBFD console updated and restarted."
