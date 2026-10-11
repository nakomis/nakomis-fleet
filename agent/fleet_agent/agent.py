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
    # Refuse updates Fleet sends without a sha256 (Fleet always sends one for builds in its manifest).
    require_sha256: bool = True
    healthcheck: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def load(cls, path: Path) -> "Config":
        with open(path, "rb") as f:
            data = tomllib.load(f)
        unknown = set(data) - set(cls.__dataclass_fields__)
        if unknown:
            raise ValueError(f"Unknown settings in {path}: {', '.join(sorted(unknown))}")
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
        self._chunk_total = 0
        self._chunk_meta: dict[str, Any] = {}
        self._installing = False
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
        # Runs on paho's network thread: never let an exception escape and kill it.
        try:
            self._handle(payload)
        except Exception as err:  # noqa: BLE001
            log.exception("Command failed")
            try:
                self.respond({"type": "error", "message": f"Command failed: {err}"})
            except Exception:  # noqa: BLE001
                pass

    def _handle(self, payload: bytes) -> None:
        try:
            message = json.loads(payload)
            command = message["command"]
            if not isinstance(command, str):
                raise TypeError
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
        if self._busy.locked():
            self.respond({"type": "error", "message": "Update in progress; not restarting"})
            return
        self.respond({"type": "reboot_ack", "message": f"Restarting {self.config.service}"})
        # Off the network thread: systemctl can take a while.
        threading.Thread(target=self.releases.restart, daemon=True).start()

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
        # Chunks can arrive in any order; a different total means a new URL.
        if total != self._chunk_total:
            self._chunks, self._chunk_meta, self._chunk_total = {}, {}, total
        self._chunks[index] = data
        if index == total - 1:
            # Fleet puts sha256 on the last chunk; MQTT may deliver chunks out of order.
            self._chunk_meta = {"version": message.get("version"), "sha256": message.get("sha256")}
        if len(self._chunks) < total or not self._chunk_meta:
            self.respond({"type": "ota_progress", "progress": 0, "status": f"Chunk {index + 1}/{total} received"})
            return
        url = "".join(self._chunks[i] for i in range(total))
        meta, self._chunks, self._chunk_meta, self._chunk_total = self._chunk_meta, {}, {}, 0
        self._ota_update({"url": url, **meta})

    def _ota_cancel(self, _: dict[str, Any]) -> None:
        self._chunks, self._chunk_meta, self._chunk_total = {}, {}, 0
        if self._installing:
            self.respond({"type": "ota_progress", "progress": 100, "status": "Installing; too late to cancel"})
        elif self._busy.locked():
            self._cancel.set()
        else:
            self.respond({"type": "ota_progress", "progress": 0, "status": "Update cancelled"})

    def _ota_update(self, message: dict[str, Any]) -> None:
        url, version = message.get("url"), message.get("version")
        if not url or not version:
            self.respond({"type": "ota_error", "message": "No firmware URL provided"})
            return
        if self.config.require_sha256 and not message.get("sha256"):
            self.respond({"type": "ota_error", "message": "sha256 required", "version": version})
            return
        if str(version) == self.releases.current_version():
            self.respond({"type": "ota_complete", "version": version})
            self.announce_version()
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
        marker = self._updating_marker()
        try:
            marker.touch()
        except OSError:
            pass
        try:
            self._update(url, version, sha256)
        finally:
            marker.unlink(missing_ok=True)

    def _updating_marker(self) -> Path:
        # install.sh refuses to restart the agent while this exists.
        return Path(self.config.install_dir).parent / "nakomis-fleet-agent" / ".updating"

    def _update(self, url: str, version: str, sha256: str | None) -> None:
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
                self._installing = True
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
            self._installing = False
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
    releases = releases_from(config)
    recovered = releases.recover()
    agent = Agent(config, releases, client)

    def on_connect(c, _userdata, _flags, reason, _props):
        log.info("Connected to %s (%s); subscribing to %s", config.endpoint, reason, agent.command_topic)
        c.subscribe(agent.command_topic, qos=1)
        nonlocal recovered
        if recovered:
            # The agent died mid-install last time and has rolled back.
            agent.respond({"type": "ota_error", "message": recovered})
            recovered = None
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
