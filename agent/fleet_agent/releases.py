"""Release management on the Pi: download, verify, unpack, switch and roll back.

Layout under install_dir (e.g. /opt/pish):

    releases/<version>/   unpacked artefact.tar.gz
    current -> releases/<version>

The managed systemd unit runs from `current`, so switching a release is an atomic symlink swap and a restart.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import tarfile
import tempfile
import time
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

SEMVER = re.compile(r"^\d+\.\d+\.\d+$")
CHUNK = 64 * 1024


def safe_extract(tar: tarfile.TarFile, dest: Path) -> None:
    """Extract without letting the archive escape dest (absolute paths, .., links out, device files)."""
    if hasattr(tarfile, "data_filter"):  # Python 3.11.4+/3.12
        tar.extractall(dest, filter="data")
        return
    # Raspberry Pi OS Bookworm ships 3.11.2, which predates extraction filters.
    root = dest.resolve()
    for member in tar.getmembers():
        target = (dest / member.name).resolve()
        if not str(target).startswith(str(root) + os.sep) and target != root:
            raise tarfile.TarError(f"{member.name} escapes the release directory")
        if member.isdev() or member.islnk():
            raise tarfile.TarError(f"{member.name}: device files and hard links are not allowed")
        if member.issym():
            link = (target.parent / member.linkname).resolve()
            if not str(link).startswith(str(root) + os.sep):
                raise tarfile.TarError(f"{member.name} links outside the release directory")
    tar.extractall(dest)  # noqa: S202 (members validated above)


class OtaError(Exception):
    """An update failed; the message is reported to Fleet as ota_error."""


class Cancelled(OtaError):
    def __init__(self) -> None:
        super().__init__("Update cancelled")


@dataclass
class HealthCheck:
    command: list[str] | None = None
    timeout_seconds: float = 30.0
    settle_seconds: float = 5.0


class Releases:
    def __init__(
        self,
        install_dir: Path,
        service: str,
        keep: int = 3,
        systemctl: str = "systemctl",
        health: HealthCheck | None = None,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self.install_dir = Path(install_dir)
        self.releases_dir = self.install_dir / "releases"
        self.current_link = self.install_dir / "current"
        self.service = service
        self.keep = keep
        self.systemctl = systemctl
        self.health = health or HealthCheck()
        self.sleep = sleep

    # ── State ───────────────────────────────────────────────────────────

    def current_version(self) -> str | None:
        try:
            return Path(os.readlink(self.current_link)).name
        except OSError:
            return None

    # ── Download and unpack ─────────────────────────────────────────────

    def download(
        self,
        url: str,
        dest: Path,
        progress: Callable[[int], None],
        cancelled: Callable[[], bool],
    ) -> str:
        """Download url to dest, returning its sha256. HTTPS only: Fleet hands out presigned HTTPS URLs."""
        if not url.startswith("https://"):
            raise OtaError("Refusing a non-HTTPS artefact URL")
        digest = hashlib.sha256()
        with urllib.request.urlopen(url, timeout=60) as resp, open(dest, "wb") as out:  # noqa: S310 (https checked)
            total = int(resp.headers.get("Content-Length") or 0)
            done = 0
            last_reported = -1
            while chunk := resp.read(CHUNK):
                if cancelled():
                    raise Cancelled()
                out.write(chunk)
                digest.update(chunk)
                done += len(chunk)
                if total:
                    pct = min(99, done * 100 // total)
                    if pct // 10 != last_reported // 10:
                        last_reported = pct
                        progress(pct)
            if total and done != total:
                raise OtaError(f"Download truncated ({done} of {total} bytes)")
        return digest.hexdigest()

    def unpack(self, archive: Path, version: str) -> Path:
        if not SEMVER.match(version):
            raise OtaError(f"Invalid version {version!r}")
        self.releases_dir.mkdir(parents=True, exist_ok=True)
        target = self.releases_dir / version
        staging = Path(tempfile.mkdtemp(prefix=f".{version}-", dir=self.releases_dir))
        try:
            with tarfile.open(archive, "r:gz") as tar:
                safe_extract(tar, staging)
            if target.exists():
                shutil.rmtree(target)
            staging.rename(target)
        except (tarfile.TarError, OSError) as err:
            shutil.rmtree(staging, ignore_errors=True)
            raise OtaError(f"Could not unpack artefact: {err}") from err
        return target

    def release_health(self, release: Path) -> HealthCheck:
        """A release can override the health check in fleet.json: {"healthcheck": {"command": [...], ...}}."""
        meta = release / "fleet.json"
        if not meta.exists():
            return self.health
        try:
            conf = json.loads(meta.read_text()).get("healthcheck", {})
        except (OSError, json.JSONDecodeError):
            return self.health
        return HealthCheck(
            command=conf.get("command", self.health.command),
            timeout_seconds=float(conf.get("timeoutSeconds", self.health.timeout_seconds)),
            settle_seconds=float(conf.get("settleSeconds", self.health.settle_seconds)),
        )

    # ── Switch, check, roll back ────────────────────────────────────────

    def switch_to(self, version: str) -> None:
        tmp = self.install_dir / ".current.tmp"
        if tmp.is_symlink() or tmp.exists():
            tmp.unlink()
        tmp.symlink_to(Path("releases") / version)
        os.replace(tmp, self.current_link)

    def restart(self) -> None:
        subprocess.run([self.systemctl, "restart", self.service], check=False, timeout=60)

    def healthy(self, health: HealthCheck) -> bool:
        self.sleep(health.settle_seconds)
        active = subprocess.run([self.systemctl, "is-active", "--quiet", self.service], check=False, timeout=30)
        if active.returncode != 0:
            return False
        if not health.command:
            return True
        try:
            check = subprocess.run(health.command, check=False, timeout=health.timeout_seconds, cwd=self.current_link)
        except subprocess.TimeoutExpired:
            return False
        return check.returncode == 0

    def install(self, version: str) -> None:
        """Switch to an unpacked release; roll back and raise if it isn't healthy."""
        previous = self.current_version()
        release = self.releases_dir / version
        self.switch_to(version)
        self.restart()
        if self.healthy(self.release_health(release)):
            self.prune(protect={version, previous})
            return
        if previous:
            self.switch_to(previous)
            self.restart()
        raise OtaError("rolled back")

    def prune(self, protect: set[str | None]) -> None:
        if not self.releases_dir.exists():
            return
        versions = sorted(
            (p for p in self.releases_dir.iterdir() if p.is_dir() and SEMVER.match(p.name)),
            key=lambda p: tuple(int(x) for x in p.name.split(".")),
            reverse=True,
        )
        for old in versions[self.keep :]:
            if old.name not in protect:
                shutil.rmtree(old, ignore_errors=True)
