# nakomis-fleet Pi agent

A small systemd service that lets Fleet update a Raspberry Pi the way it updates an ESP32. It connects to AWS IoT
with the Pi's Thing certificate and speaks the same MQTT protocol as esp32-bootstrap's `MqttOTA`:

| Topic | Direction | Messages |
|---|---|---|
| `{project}/{thing}/commands` | in | `ota_update {url, version, sha256?}`, `url_chunk`, `ota_cancel`, `get_version`, `ping`, `get_status`, `reboot` (restarts the managed service, not the Pi) |
| `{project}/{thing}/responses` | out | `ota_progress`, `ota_complete`, `ota_error` (`"rolled back"`, `"sha256 mismatch"`, …), `version`, `pong`, `status` |
| `{project}/{thing}/status` | out | heartbeat with the running version, every `status_interval` seconds |

## Releases

A Pi release is a tarball published to `s3://nakomis-firmware-{env}/{Project}/{version}/artefact.tar.gz` (the
manifest marks the project `artefactType: "tarball"`). The agent:

1. downloads it over HTTPS from the presigned URL Fleet sends, checking `sha256` when Fleet supplies it;
2. unpacks it safely into `install_dir/releases/<version>/` (no absolute paths, `..` or device files);
3. points `install_dir/current` at it (atomic symlink swap) and restarts `service`;
4. checks the unit is active and, optionally, runs a health-check command (config, or the release's `fleet.json`:
   `{"healthcheck": {"command": ["bin/app", "--self-test"], "timeoutSeconds": 30, "settleSeconds": 5}}`);
5. on failure switches back to the previous release, restarts, and reports `ota_error {"message": "rolled back"}`.

It keeps the newest `keep_releases` releases (always including the running one).

The managed unit should run from the symlink, e.g. `ExecStart=/opt/pish/current/bin/pish`.

## Install

```bash
sudo agent/install.sh
sudo $EDITOR /etc/nakomis-fleet-agent/config.toml   # endpoint, thing, project, certs, install_dir, service
sudo systemctl restart nakomis-fleet-agent
```

The Thing needs an IoT policy allowing `iot:Connect` as itself and publish/subscribe on `{project}/{thing}/*`, and
the attributes `project={project}`, `hwType=pi`, `capabilities=ota` so Fleet lists it correctly.

## Development

```bash
python3 -m venv .venv && .venv/bin/pip install -e ".[test]" && .venv/bin/pytest
```
