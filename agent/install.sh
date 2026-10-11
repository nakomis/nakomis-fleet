#!/bin/bash
# Install or upgrade the Fleet agent on a Raspberry Pi. Run on the Pi from a checkout of nakomis-fleet:
#   sudo agent/install.sh
# First install: put config.toml and the Thing's certificates in /etc/nakomis-fleet-agent/
# (see config.example.toml), then `sudo systemctl start nakomis-fleet-agent`.
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Run as root (sudo)." >&2; exit 1; }
python3 -c 'import venv, ensurepip' 2>/dev/null || { echo "Install python3-venv first: apt install python3-venv" >&2; exit 1; }

HERE="$(cd "$(dirname "$0")" && pwd)"
PREFIX=/opt/nakomis-fleet-agent
CONF=/etc/nakomis-fleet-agent/config.toml

if [ -f "$PREFIX/.updating" ]; then
  echo "Refusing to upgrade while the agent is installing a release." >&2
  exit 1
fi

python3 -m venv "$PREFIX/venv"
# Build from a copy so the checkout isn't littered with root-owned build files.
BUILD=$(mktemp -d)
cp -r "$HERE"/. "$BUILD"
"$PREFIX/venv/bin/pip" install --quiet --force-reinstall --no-deps "$BUILD"
"$PREFIX/venv/bin/pip" install --quiet "$BUILD"
rm -rf "$BUILD"

install -d -m 700 /etc/nakomis-fleet-agent
install -m 644 "$HERE/systemd/nakomis-fleet-agent.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable nakomis-fleet-agent

if [ -f "$CONF" ]; then
  systemctl restart nakomis-fleet-agent
  echo "Upgraded and restarted."
else
  install -m 600 "$HERE/config.example.toml" "$CONF"
  echo "Installed. Edit $CONF and add the certificates, then: systemctl start nakomis-fleet-agent"
fi
