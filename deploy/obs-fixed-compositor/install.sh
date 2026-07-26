#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this installer as root." >&2
  exit 1
fi

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPOSITORY_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
EXPECTED_ROOT=/opt/mbfd/media-control

if [ "$REPOSITORY_ROOT" != "$EXPECTED_ROOT" ]; then
  echo "Install the candidate checkout at $EXPECTED_ROOT before installing the service." >&2
  exit 1
fi

install -d -m 0755 /etc/mbfd
install -d -o mbfd -g mbfd -m 0700 /var/lib/mbfd-obs
install -m 0644 "$SCRIPT_DIR/mbfd-fixed-compositor.service" \
  /etc/systemd/system/mbfd-fixed-compositor.service

if [ ! -e /etc/mbfd/obs-fixed-compositor.env ]; then
  install -m 0600 "$SCRIPT_DIR/obs-fixed-compositor.env.example" \
    /etc/mbfd/obs-fixed-compositor.env
  echo "Created /etc/mbfd/obs-fixed-compositor.env; populate its protected runtime values."
fi

systemctl daemon-reload
echo "Installed mbfd-fixed-compositor.service without enabling or starting it."
echo "Validate the protected environment, then use the controlled mode-switch procedure in README.md."
