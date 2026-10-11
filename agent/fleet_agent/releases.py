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

SEMVER = re.compile(r"\d+\.\d+\.\d+")
CHUNK = 64 * 1024
PENDING_FILE = ".pending.json"


class _HttpsOnlyRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not newurl.startswith("https://"):
            raise OtaError("Refusing a redirect away from HTTPS")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _open(url: str):
    return urllib.request.build_opener(_HttpsOnlyRedirects()).open(url, timeout=60)


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
        if member.isdev() or member.islnk() or member.isfifo():
            raise tarfile.TarError(f"{member.name}: device files, FIFOs and hard links are not allowed")
        # Like the "data" filter: no setuid/setgid/sticky bits, and files owned by whoever extracts them.
        member.mode &= 0o755
        member.uid = member.gid = 0
        member.uname = member.gname = ""
        if member.issym():
            link = (target.parent / member.linkname).resolve()
            if not str(link).startswith(str(root) + os.sep):
                raise tarfile.TarError(f"{member.name} links outside the release directory")
    tar.extractall(dest, numeric_owner=True)  # noqa: S202 (members validated above)


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

    def current_target(self) -> str | None:
        """The raw target of current, which may predate the agent (e.g. /opt/pish/app)."""
        try:
            return os.readlink(self.current_link)
        except OSError:
            return None

    def current_version(self) -> str | None:
        target = self.current_target()
        if target is None:
            return None
        name = Path(target).name
        return name if SEMVER.fullmatch(name) else None

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
        with _open(url) as resp, open(dest, "wb") as out:
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
        if not SEMVER.fullmatch(version):
            raise OtaError(f"Invalid version {version!r}")
        self.releases_dir.mkdir(parents=True, exist_ok=True)
        target = self.releases_dir / version
        staging = Path(tempfile.mkdtemp(prefix=f".{version}-", dir=self.releases_dir))
        try:
            with tarfile.open(archive, "r:gz") as tar:
                safe_extract(tar, staging)
            if target.exists():
                if version == self.current_version():
                    raise OtaError(f"{version} is already running")
                shutil.rmtree(target)
            staging.rename(target)
        except OtaError:
            shutil.rmtree(staging, ignore_errors=True)
            raise
        except (tarfile.TarError, OSError) as err:
            shutil.rmtree(staging, ignore_errors=True)
            raise OtaError(f"Could not unpack artefact: {err}") from err
        return target

    def release_health(self, release: Path) -> HealthCheck:
        """A release can override the health check in fleet.json: {"healthcheck": {"command": [...], ...}}."""
        meta = release / "fleet.json"
        if not meta.exists():
            return self.health
        # Note: fleet.json comes with the release, so a release can relax its own health check.
        try:
            conf = json.loads(meta.read_text()).get("healthcheck", {})
            command = conf.get("command", self.health.command)
            if command is not None and not (isinstance(command, list) and all(isinstance(c, str) for c in command)):
                raise ValueError("healthcheck.command must be a list of strings")
            return HealthCheck(
                command=command,
                timeout_seconds=float(conf.get("timeoutSeconds", self.health.timeout_seconds)),
                settle_seconds=float(conf.get("settleSeconds", self.health.settle_seconds)),
            )
        except (OSError, ValueError, TypeError, AttributeError) as err:
            raise OtaError(f"Invalid fleet.json: {err}") from err

    # ── Switch, check, roll back ────────────────────────────────────────

    def switch_to(self, version: str) -> None:
        self._point_current_at(str(Path("releases") / version))

    def _point_current_at(self, target: str) -> None:
        if self.current_link.exists() and not self.current_link.is_symlink():
            raise OtaError(f"{self.current_link} is a real directory; make it a symlink before using Fleet updates")
        tmp = self.install_dir / ".current.tmp"
        if tmp.is_symlink() or tmp.exists():
            tmp.unlink()
        tmp.symlink_to(target)
        os.replace(tmp, self.current_link)

    def restart(self) -> None:
        subprocess.run([self.systemctl, "restart", self.service], check=False, timeout=60)

    def healthy(self, health: HealthCheck) -> bool:
        """Active three times in a row across the settle period (so a crash loop doesn't pass), then the command."""
        try:
            for _ in range(3):
                self.sleep(health.settle_seconds / 3)
                active = subprocess.run([self.systemctl, "is-active", "--quiet", self.service], check=False, timeout=30)
                if active.returncode != 0:
                    return False
            if not health.command:
                return True
            check = subprocess.run(health.command, check=False, timeout=health.timeout_seconds, cwd=self.current_link)
            return check.returncode == 0
        except (OSError, subprocess.SubprocessError):
            return False

    @property
    def pending_file(self) -> Path:
        return self.install_dir / PENDING_FILE

    def install(self, version: str) -> None:
        """Switch to an unpacked release; roll back and raise if it isn't healthy.

        A pending marker records the previous target first, so an agent that dies mid-install can finish the
        job on restart (see recover()).
        """
        if version == self.current_version():
            raise OtaError(f"{version} is already running")
        if self.current_link.exists() and not self.current_link.is_symlink():
            raise OtaError(f"{self.current_link} is a real directory; make it a symlink before using Fleet updates")
        health = self.release_health(self.releases_dir / version)
        previous = self.current_target()
        self.pending_file.write_text(json.dumps({"version": version, "previous": previous}))
        try:
            self.switch_to(version)
            self.restart()
            ok = self.healthy(health)
        except Exception:  # noqa: BLE001 (anything going wrong after the switch means roll back)
            ok = False
        if ok:
            self.pending_file.unlink(missing_ok=True)
            self.prune(protect={version, self.version_of(previous)})
            return
        self._roll_back(previous)
        raise OtaError("rolled back" if previous else "health check failed (no previous release to roll back to)")

    @staticmethod
    def version_of(target: str | None) -> str | None:
        return Path(target).name if target else None

    def _roll_back(self, previous: str | None) -> None:
        try:
            if previous:
                self._point_current_at(previous)
            else:
                # First install: leave nothing pointing at the broken release.
                if self.current_link.is_symlink():
                    self.current_link.unlink()
            self.restart()
        finally:
            self.pending_file.unlink(missing_ok=True)

    def recover(self) -> str | None:
        """On start-up: finish an install the agent died in the middle of. Returns a message to report, if any."""
        self._sweep()
        if not self.pending_file.exists():
            return None
        try:
            pending = json.loads(self.pending_file.read_text())
            version, previous = pending["version"], pending.get("previous")
        except (OSError, ValueError, KeyError, TypeError):
            self.pending_file.unlink(missing_ok=True)
            return None
        if self.current_version() == version:
            try:
                ok = self.healthy(self.release_health(self.releases_dir / version))
            except OtaError:
                ok = False
            if ok:
                self.pending_file.unlink(missing_ok=True)
                return None
        self._roll_back(previous)
        return "rolled back"

    def _sweep(self) -> None:
        """Remove leftovers of an interrupted unpack or switch."""
        if self.releases_dir.exists():
            for p in self.releases_dir.iterdir():
                if p.name.startswith("."):
                    shutil.rmtree(p, ignore_errors=True)
        tmp = self.install_dir / ".current.tmp"
        if tmp.is_symlink():
            tmp.unlink()

    def prune(self, protect: set[str | None]) -> None:
        if not self.releases_dir.exists():
            return
        versions = sorted(
            (p for p in self.releases_dir.iterdir() if p.is_dir() and SEMVER.fullmatch(p.name)),
            key=lambda p: tuple(int(x) for x in p.name.split(".")),
            reverse=True,
        )
        for old in versions[self.keep :]:
            if old.name not in protect:
                shutil.rmtree(old, ignore_errors=True)
