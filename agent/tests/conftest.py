import hashlib
import io
import json
import os
import stat
import tarfile
import threading
from pathlib import Path

import pytest

from fleet_agent.agent import Agent, Config
from fleet_agent.releases import HealthCheck, Releases


def make_tarball(files: dict[str, str]) -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for name, content in files.items():
            data = content.encode()
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    return buf.getvalue()


class FakeResponse(io.BytesIO):
    def __init__(self, data: bytes):
        super().__init__(data)
        self.headers = {"Content-Length": str(len(data))}

    def __enter__(self):
        return self

    def __exit__(self, *a):
        self.close()


@pytest.fixture
def serve(monkeypatch):
    """Serve bytes for https:// URLs via a patched urlopen."""
    served: dict[str, bytes] = {}

    def urlopen(url, timeout=None):
        return FakeResponse(served[url])

    monkeypatch.setattr("fleet_agent.releases._open", urlopen)
    return served


@pytest.fixture
def systemctl(tmp_path):
    """A fake systemctl that logs calls; is-active fails while tmp_path/unhealthy exists."""
    log = tmp_path / "systemctl.log"
    script = tmp_path / "systemctl"
    script.write_text(
        "#!/bin/sh\n"
        f'echo "$@" >> "{log}"\n'
        f'if [ "$1" = "is-active" ] && [ -e "{tmp_path}/unhealthy" ]; then exit 3; fi\n'
        "exit 0\n"
    )
    script.chmod(script.stat().st_mode | stat.S_IEXEC)
    return script, log


@pytest.fixture
def releases(tmp_path, systemctl):
    return Releases(tmp_path / "opt", "pish.service", keep=2, systemctl=str(systemctl[0]),
                    health=HealthCheck(settle_seconds=0), sleep=lambda s: None)


class FakePublisher:
    def __init__(self):
        self.messages: list[tuple[str, dict]] = []

    def publish(self, topic, payload, qos=1):
        self.messages.append((topic, json.loads(payload)))

    def of_type(self, kind):
        return [m for t, m in self.messages if m.get("type") == kind]


@pytest.fixture
def agent(tmp_path, releases):
    config = Config(endpoint="x", thing_name="pish-1", project="pish", ca_file="", cert_file="", key_file="",
                    install_dir=str(tmp_path / "opt"), service="pish.service", require_sha256=False)
    publisher = FakePublisher()
    return Agent(config, releases, publisher, started=0), publisher


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()
