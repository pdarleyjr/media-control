#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run with sudo: sudo ./scripts/install-kamrui-kiosk.sh" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
CONFIG_DIR="/etc/mbfd/media-control-console"
CONFIG_FILE="${CONFIG_DIR}/config.env"
CONSOLE_DIR="/opt/mbfd/media-control-console"
AGENT_DIR="/opt/mbfd/podium-agent"
KIOSK_USER="mbfdkiosk"

log() { printf '\n[mbfd-install] %s\n' "$*"; }

require_ubuntu() {
  if [[ ! -r /etc/os-release ]]; then
    echo "Cannot identify OS; /etc/os-release missing" >&2
    exit 1
  fi
  # shellcheck disable=SC1091
  . /etc/os-release
  if [[ "${ID:-}" != "ubuntu" ]]; then
    echo "This installer targets Ubuntu LTS. Detected: ${PRETTY_NAME:-unknown}" >&2
    exit 1
  fi
  log "Detected ${PRETTY_NAME}"
}

install_packages() {
  log "Installing Ubuntu kiosk dependencies"
  apt-get update
  local asound_pkg="libasound2"
  if apt-cache show libasound2t64 >/dev/null 2>&1; then
    asound_pkg="libasound2t64"
  fi
  apt-get install -y --no-install-recommends \
    ca-certificates curl jq git rsync coreutils procps openssl xdg-utils exfatprogs ntfs-3g \
    cage dbus-x11 xwayland seatd libinput-tools unclutter \
    libgtk-3-0 libnss3 libxss1 "${asound_pkg}" libatk-bridge2.0-0 libdrm2 libgbm1 \
    v4l-utils x11-xserver-utils
}

install_node() {
  local major="0"
  if command -v node >/dev/null 2>&1; then
    major="$(node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || echo 0)"
  fi
  if [[ "${major}" -lt 20 ]]; then
    log "Installing Node.js 22 LTS"
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
  else
    log "Node.js $(node --version) already present"
  fi
  corepack enable
  corepack prepare pnpm@9.12.0 --activate
}

create_user() {
  log "Creating kiosk user ${KIOSK_USER}"
  if ! id -u "${KIOSK_USER}" >/dev/null 2>&1; then
    useradd --create-home --shell /bin/bash "${KIOSK_USER}"
  fi
  usermod -aG video,input,render "${KIOSK_USER}" || true
}

install_config() {
  log "Installing config template"
  install -d -m 0755 "${CONFIG_DIR}"
  if [[ ! -f "${CONFIG_FILE}" ]]; then
    install -m 0600 "${REPO_ROOT}/deploy/config.env.example" "${CONFIG_FILE}"
    sed -i "s/ADMIN_PIN=change-me/ADMIN_PIN=$(openssl rand -hex 3)/" "${CONFIG_FILE}" || true
  fi
  chgrp "${KIOSK_USER}" "${CONFIG_FILE}" 2>/dev/null || true
  chmod 0640 "${CONFIG_FILE}"
}

build_apps() {
  log "Installing workspace dependencies"
  cd "${REPO_ROOT}"
  pnpm install
  log "Building console and podium agent"
  pnpm build
  log "Packaging Linux Electron directory"
  pnpm package:linux
}

install_apps() {
  log "Installing application files"
  install -d -m 0755 "${CONSOLE_DIR}" "${AGENT_DIR}"
  if [[ ! -d "${REPO_ROOT}/apps/console-linux/release/linux-unpacked" ]]; then
    echo "Electron linux-unpacked output not found" >&2
    exit 1
  fi
  rsync -a --delete "${REPO_ROOT}/apps/console-linux/release/linux-unpacked/" "${CONSOLE_DIR}/"
  rsync -a --delete "${REPO_ROOT}/services/podium-agent/dist/" "${AGENT_DIR}/dist/"
  install -m 0644 "${REPO_ROOT}/services/podium-agent/package.json" "${AGENT_DIR}/package.json"
  chown -R "${KIOSK_USER}:${KIOSK_USER}" "${CONSOLE_DIR}"
  if [[ -f "${CONSOLE_DIR}/chrome-sandbox" ]]; then
    chown root:root "${CONSOLE_DIR}/chrome-sandbox"
    chmod 4755 "${CONSOLE_DIR}/chrome-sandbox"
  fi
}

install_services() {
  log "Installing systemd services"
  install -m 0644 "${REPO_ROOT}/deploy/systemd/mbfd-podium-agent.service" /etc/systemd/system/mbfd-podium-agent.service
  install -m 0644 "${REPO_ROOT}/deploy/systemd/mbfd-console.service" /etc/systemd/system/mbfd-console.service
  install -m 0755 "${REPO_ROOT}/deploy/cage/mbfd-console-session.sh" "${CONSOLE_DIR}/mbfd-console-session.sh"
  install -d -m 0755 /etc/systemd/logind.conf.d
  cat >/etc/systemd/logind.conf.d/mbfd-kiosk.conf <<'EOF'
[Login]
HandleLidSwitch=ignore
HandleLidSwitchExternalPower=ignore
IdleAction=ignore
NAutoVTs=1
ReserveVT=0
EOF
  systemctl daemon-reload
  systemctl restart systemd-logind.service || true
  systemctl enable --now mbfd-podium-agent.service
}

enable_kiosk_boot() {
  log "Configuring boot-to-console kiosk mode"
  systemctl set-default multi-user.target
  if [[ "${MBFD_KEEP_DISPLAY_MANAGER:-0}" != "1" ]]; then
    systemctl disable --now display-manager.service || true
    systemctl disable --now gdm3.service || true
  fi
  systemctl enable mbfd-console.service
  systemctl restart mbfd-console.service || true
}

print_next_steps() {
  cat <<EOF

MBFD Media Control Console install complete.

Review/edit:
  sudo nano ${CONFIG_FILE}

Important values:
  MBFD_CONSOLE_URL=https://media-control.mbfdhub.com/console/classroom-1
  ROOM_ID=classroom-1
  DEVICE_ID=classroom-1-podium-console
  DEFAULT_PROFILE=guest
  DEVICE_TOKEN=<match server CONSOLE_DEVICE_TOKEN/DEVICE_TOKEN if required>
  ADMIN_PIN=<service PIN>

Then reboot:
  sudo reboot

Logs:
  journalctl -u mbfd-console.service -f
  journalctl -u mbfd-podium-agent.service -f

Emergency recovery:
  sudo ${REPO_ROOT}/scripts/emergency-disable-kiosk.sh
EOF
}

require_ubuntu
install_packages
install_node
create_user
install_config
build_apps
install_apps
install_services
enable_kiosk_boot
print_next_steps
