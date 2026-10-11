"""nakomis-fleet Pi agent.

Speaks the same MQTT protocol as the ESP32 devices (esp32-bootstrap MqttOTA), so Fleet treats a Pi like any
other device:

    {project}/{thing}/commands   ← ota_update {url, version, sha256?}, url_chunk, ota_cancel,
                                   get_version, ping, get_status, reboot (restarts the managed service)
    {project}/{thing}/responses  → ota_progress {progress, status, version}, ota_complete {version},
                                   ota_error {message}, version, pong, status
    {project}/{thing}/status     → heartbeat every status_interval seconds
"""

from __future__ import annotations

import json
import logging
import socket
import ssl
import tempfile
import threading
import time
import tomllib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Protocol

from .releases import Cancelled, HealthCheck, OtaError, Releases

log = logging.getLogger("fleet-agent")

MAX_URL_CHUNKS = 10


@dataclass
class Config:
    endpoint: str
    thing_name: str
    project: str
    ca_file: str
    cert_file: str
    key_file: str
    install_dir: str
    service: str
    keep_releases: int = 3
    status_interval: int = 60
    systemctl: str = "systemctl"
    healthcheck: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def load(cls, path: Path) -> "Config":
        with open(path, "rb") as f:
            data = tomllib.load(f)
        return cls(**data)


class Publisher(Protocol):
    def publish(self, topic: str, payload: str, qos: int = 1) -> Any: ...


class Agent:
    def __init__(self, config: Config, releases: Releases, publisher: Publisher, started: float | None = None) -> None:
        self.config = config
        self.releases = releases
        self.publisher = publisher
        self.started = started if started is not None else time.monotonic()
        prefix = f"{config.project}/{config.thing_name}"
        self.command_topic = f"{prefix}/commands"
        self.response_topic = f"{prefix}/responses"
        self.status_topic = f"{prefix}/status"
        self._chunks: dict[int, str] = {}
        self._cancel = threading.Event()
        self._busy = threading.Lock()
        self.worker: threading.Thread | None = None

    # ── Outgoing ────────────────────────────────────────────────────────

    def respond(self, message: dict[str, Any]) -> None:
        self.publisher.publish(self.response_topic, json.dumps(message), qos=1)

    def heartbeat(self) -> None:
        self.publisher.publish(
            self.status_topic,
            json.dumps(
                {
                    "device": socket.gethostname(),
                    "version": self.releases.current_version(),
                    "uptime_seconds": int(time.monotonic() - self.started),
                    "updating": self._busy.locked(),
                }
            ),
            qos=0,
        )

    def announce_version(self) -> None:
        self.respond({"type": "version", "version": self.releases.current_version(), "project": self.config.project})

    # ── Incoming ────────────────────────────────────────────────────────

    def handle(self, payload: bytes) -> None:
        try:
            message = json.loads(payload)
            command = message["command"]
        except (ValueError, KeyError, TypeError):
            self.respond({"type": "error", "message": "Invalid JSON command"})
            return

        handlers: dict[str, Callable[[dict[str, Any]], None]] = {
            "ota_update": self._ota_update,
            "url_chunk": self._url_chunk,
            "ota_cancel": self._ota_cancel,
            "get_version": lambda _: self.announce_version(),
            "ping": lambda _: self.respond({"type": "pong", "timestamp": int(time.time() * 1000)}),
            "get_status": lambda _: self.respond({"type": "status", "version": self.releases.current_version(),
                                                   "service": self.config.service, "updating": self._busy.locked()}),
            "reboot": self._restart_service,
        }
        handler = handlers.get(command)
        if not handler:
            self.respond({"type": "error", "message": f"Unknown command: {command}"})
            return
        handler(message)

    def _restart_service(self, _: dict[str, Any]) -> None:
        self.respond({"type": "reboot_ack", "message": f"Restarting {self.config.service}"})
        self.releases.restart()

    def _url_chunk(self, message: dict[str, Any]) -> None:
        try:
            index, total = int(message["chunk_index"]), int(message["total_chunks"])
            data = str(message["chunk_data"])
        except (KeyError, ValueError, TypeError):
            self.respond({"type": "ota_error", "message": "Invalid chunk parameters"})
            return
        if not (0 <= index < total <= MAX_URL_CHUNKS):
            self.respond({"type": "ota_error", "message": "Invalid chunk parameters"})
            return
        if index == 0:
            self._chunks = {}
        self._chunks[index] = data
        if len(self._chunks) < total:
            self.respond({"type": "ota_progress", "progress": 0, "status": f"Chunk {index + 1}/{total} received"})
            return
        url = "".join(self._chunks[i] for i in range(total))
        self._chunks = {}
        self._ota_update({"url": url, "version": message.get("version"), "sha256": message.get("sha256")})

    def _ota_cancel(self, _: dict[str, Any]) -> None:
        self._chunks = {}
        if self._busy.locked():
            self._cancel.set()
        else:
            self.respond({"type": "ota_progress", "progress": 0, "status": "Update cancelled"})

    def _ota_update(self, message: dict[str, Any]) -> None:
        url, version = message.get("url"), message.get("version")
        if not url or not version:
            self.respond({"type": "ota_error", "message": "No firmware URL provided"})
            return
        if not self._busy.acquire(blocking=False):
            self.respond({"type": "ota_error", "message": "Update already in progress"})
            return
        self._cancel.clear()
        self.worker = threading.Thread(
            target=self._run_update, args=(url, str(version), message.get("sha256")), daemon=True
        )
        self.worker.start()

    def _run_update(self, url: str, version: str, sha256: str | None) -> None:
        def progress(pct: int, status: str) -> None:
            self.respond({"type": "ota_progress", "progress": pct, "status": status, "version": version})

        try:
            progress(0, "Downloading")
            with tempfile.TemporaryDirectory() as tmp:
                archive = Path(tmp) / "artefact.tar.gz"
                digest = self.releases.download(
                    url, archive, lambda pct: progress(pct, "Downloading"), self._cancel.is_set
                )
                if sha256 and digest != sha256.lower():
                    raise OtaError("sha256 mismatch")
                if self._cancel.is_set():
                    raise Cancelled()
                progress(100, "Installing")
                self.releases.unpack(archive, version)
            self.releases.install(version)
            self.respond({"type": "ota_complete", "version": version})
            self.announce_version()
        except Cancelled:
            self.respond({"type": "ota_progress", "progress": 0, "status": "Update cancelled", "version": version})
        except OtaError as err:
            log.warning("Update to %s failed: %s", version, err)
            self.respond({"type": "ota_error", "message": str(err), "version": version})
        except Exception as err:  # noqa: BLE001 (report anything rather than die silently)
            log.exception("Update to %s crashed", version)
            self.respond({"type": "ota_error", "message": f"Update failed: {err}", "version": version})
        finally:
            self._busy.release()


def releases_from(config: Config) -> Releases:
    hc = config.healthcheck
    return Releases(
        install_dir=Path(config.install_dir),
        service=config.service,
        keep=config.keep_releases,
        systemctl=config.systemctl,
        health=HealthCheck(
            command=hc.get("command"),
            timeout_seconds=float(hc.get("timeout_seconds", 30)),
            settle_seconds=float(hc.get("settle_seconds", 5)),
        ),
    )


def run(config: Config) -> None:  # pragma: no cover (needs a broker; exercised on devices)
    import paho.mqtt.client as mqtt

    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=config.thing_name)
    client.tls_set(ca_certs=config.ca_file, certfile=config.cert_file, keyfile=config.key_file,
                   tls_version=ssl.PROTOCOL_TLS_CLIENT)
    agent = Agent(config, releases_from(config), client)

    def on_connect(c, _userdata, _flags, reason, _props):
        log.info("Connected to %s (%s); subscribing to %s", config.endpoint, reason, agent.command_topic)
        c.subscribe(agent.command_topic, qos=1)
        agent.announce_version()

    client.on_connect = on_connect
    client.on_message = lambda _c, _u, msg: agent.handle(msg.payload)
    client.reconnect_delay_set(min_delay=1, max_delay=60)
    client.connect_async(config.endpoint, 8883, keepalive=60)
    client.loop_start()
    try:
        while True:
            time.sleep(config.status_interval)
            if client.is_connected():
                agent.heartbeat()
    finally:
        client.loop_stop()


def main() -> None:  # pragma: no cover
    import argparse

    parser = argparse.ArgumentParser(description="nakomis-fleet Raspberry Pi agent")
    parser.add_argument("--config", default="/etc/nakomis-fleet-agent/config.toml")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    run(Config.load(Path(args.config)))


if __name__ == "__main__":  # pragma: no cover
    main()
