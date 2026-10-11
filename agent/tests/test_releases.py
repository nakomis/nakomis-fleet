import tarfile
from pathlib import Path

import pytest

from conftest import make_tarball
from fleet_agent.releases import OtaError, safe_extract


def unpack(releases, tmp_path, version, files):
    archive = tmp_path / f"{version}.tar.gz"
    archive.write_bytes(make_tarball(files))
    return releases.unpack(archive, version)


def test_install_switches_current_and_restarts(releases, tmp_path, systemctl):
    unpack(releases, tmp_path, "1.0.0", {"bin/app": "v1"})
    releases.install("1.0.0")
    assert releases.current_version() == "1.0.0"
    assert (releases.current_link / "bin/app").read_text() == "v1"
    assert "restart pish.service" in systemctl[1].read_text()


def test_unhealthy_release_rolls_back(releases, tmp_path):
    unpack(releases, tmp_path, "1.0.0", {"bin/app": "v1"})
    releases.install("1.0.0")
    unpack(releases, tmp_path, "1.1.0", {"bin/app": "v2"})
    (tmp_path / "unhealthy").touch()

    with pytest.raises(OtaError, match="rolled back"):
        releases.install("1.1.0")
    assert releases.current_version() == "1.0.0"


def test_release_healthcheck_command_from_fleet_json(releases, tmp_path):
    unpack(releases, tmp_path, "1.0.0", {"fleet.json": '{"healthcheck": {"command": ["false"], "settleSeconds": 0}}'})
    with pytest.raises(OtaError):
        releases.install("1.0.0")


def test_prune_keeps_newest_and_current(releases, tmp_path):
    for v in ["1.0.0", "1.0.1", "1.0.2"]:
        unpack(releases, tmp_path, v, {"x": v})
        releases.install(v)
    assert sorted(p.name for p in releases.releases_dir.iterdir()) == ["1.0.1", "1.0.2"]


def test_rejects_bad_versions_and_archives(releases, tmp_path):
    with pytest.raises(OtaError):
        unpack(releases, tmp_path, "../../etc", {"x": "y"})
    archive = tmp_path / "bad.tar.gz"
    archive.write_bytes(b"not a tarball")
    with pytest.raises(OtaError, match="Could not unpack"):
        releases.unpack(archive, "1.0.0")


def test_safe_extract_refuses_escapes(tmp_path, monkeypatch):
    archive = tmp_path / "evil.tar.gz"
    archive.write_bytes(make_tarball({"../evil": "x"}))
    # Exercise the fallback used on Python < 3.11.4 too.
    for has_filter in (True, False):
        if not has_filter:
            monkeypatch.delattr(tarfile, "data_filter", raising=False)
        dest = tmp_path / f"out-{has_filter}"
        dest.mkdir()
        with tarfile.open(archive) as tar, pytest.raises(tarfile.TarError):
            safe_extract(tar, dest)
    assert not (tmp_path / "evil").exists()


def test_download_requires_https(releases, tmp_path):
    with pytest.raises(OtaError, match="non-HTTPS"):
        releases.download("http://x/a.tar.gz", tmp_path / "a", lambda p: None, lambda: False)


def test_current_version_none_before_install(releases):
    assert releases.current_version() is None


def test_first_install_failure_leaves_nothing_current(releases, tmp_path):
    unpack(releases, tmp_path, "1.0.0", {"x": "1"})
    (tmp_path / "unhealthy").touch()
    with pytest.raises(OtaError, match="no previous release"):
        releases.install("1.0.0")
    assert not releases.current_link.is_symlink()


def test_any_error_after_switch_rolls_back(releases, tmp_path):
    unpack(releases, tmp_path, "1.0.0", {"x": "1"})
    releases.install("1.0.0")
    unpack(releases, tmp_path, "1.1.0", {"fleet.json": '{"healthcheck": {"command": ["/no/such/binary"], "settleSeconds": 0}}'})
    with pytest.raises(OtaError, match="rolled back"):
        releases.install("1.1.0")
    assert releases.current_version() == "1.0.0"


def test_bad_fleet_json_is_refused_before_switching(releases, tmp_path):
    unpack(releases, tmp_path, "1.0.0", {"x": "1"})
    releases.install("1.0.0")
    unpack(releases, tmp_path, "1.1.0", {"fleet.json": '{"healthcheck": {"command": "rm -rf /"}}'})
    with pytest.raises(OtaError, match="Invalid fleet.json"):
        releases.install("1.1.0")
    assert releases.current_version() == "1.0.0"


def test_reinstalling_the_running_version_never_deletes_it(releases, tmp_path):
    unpack(releases, tmp_path, "1.0.0", {"x": "1"})
    releases.install("1.0.0")
    with pytest.raises(OtaError, match="already running"):
        unpack(releases, tmp_path, "1.0.0", {"x": "2"})
    assert (releases.current_link / "x").read_text() == "1"


def test_rollback_restores_a_pre_fleet_target(releases, tmp_path):
    legacy = tmp_path / "opt" / "app"
    legacy.mkdir(parents=True)
    releases.current_link.symlink_to(legacy)
    unpack(releases, tmp_path, "1.0.0", {"x": "1"})
    (tmp_path / "unhealthy").touch()
    with pytest.raises(OtaError, match="rolled back"):
        releases.install("1.0.0")
    assert releases.current_target() == str(legacy)


def test_recover_rolls_back_an_interrupted_unhealthy_install(releases, tmp_path):
    unpack(releases, tmp_path, "1.0.0", {"x": "1"})
    releases.install("1.0.0")
    unpack(releases, tmp_path, "1.1.0", {"x": "2"})
    # Simulate dying after the switch: marker written, current moved, no health check.
    releases.pending_file.write_text('{"version": "1.1.0", "previous": "releases/1.0.0"}')
    releases.switch_to("1.1.0")
    (releases.releases_dir / ".1.2.0-stale").mkdir()
    (tmp_path / "unhealthy").touch()

    assert releases.recover() == "rolled back"
    assert releases.current_version() == "1.0.0"
    assert not releases.pending_file.exists()
    assert not (releases.releases_dir / ".1.2.0-stale").exists()


def test_recover_keeps_a_healthy_interrupted_install(releases, tmp_path):
    unpack(releases, tmp_path, "1.0.0", {"x": "1"})
    releases.pending_file.write_text('{"version": "1.0.0", "previous": null}')
    releases.switch_to("1.0.0")
    assert releases.recover() is None
    assert releases.current_version() == "1.0.0"
    assert releases.recover() is None


def test_refuses_to_replace_a_real_current_directory(releases, tmp_path):
    releases.current_link.mkdir(parents=True)
    unpack(releases, tmp_path, "1.0.0", {"x": "1"})
    with pytest.raises(OtaError):
        releases.install("1.0.0")
