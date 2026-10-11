#!/bin/bash
# Install or upgrade the Fleet agent on a Raspberry Pi. Run on the Pi from a checkout of nakomis-fleet:
#   sudo agent/install.sh
# Then put config.toml and the Thing's certificates in /etc/nakomis-fleet-agent/ (see config.example.toml).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PREFIX=/opt/nakomis-fleet-agent

python3 -m venv "$PREFIX/venv"
"$PREFIX/venv/bin/pip" install --upgrade --quiet "$HERE"
install -d -m 700 /etc/nakomis-fleet-agent
[ -f /etc/nakomis-fleet-agent/config.toml ] || install -m 600 "$HERE/config.example.toml" /etc/nakomis-fleet-agent/config.toml
install -m 644 "$HERE/systemd/nakomis-fleet-agent.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable nakomis-fleet-agent
systemctl restart nakomis-fleet-agent
echo "Installed. Edit /etc/nakomis-fleet-agent/config.toml, then: systemctl restart nakomis-fleet-agent"
