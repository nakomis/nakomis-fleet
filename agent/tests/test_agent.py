import json

from conftest import make_tarball, sha

URL = "https://bucket.s3.eu-west-2.amazonaws.com/Pish/1.0.0/artefact.tar.gz?X-Amz-Signature=x"


def send(agent, **message):
    agent.handle(json.dumps(message).encode())


def wait(agent):
    if agent.worker:
        agent.worker.join(timeout=10)


def test_full_update_reports_progress_completion_and_version(agent, serve):
    a, pub = agent
    data = make_tarball({"bin/pish": "v1"})
    serve[URL] = data

    send(a, command="ota_update", url=URL, version="1.0.0", sha256=sha(data))
    wait(a)

    assert pub.of_type("ota_progress")[0]["status"] == "Downloading"
    assert pub.of_type("ota_complete") == [{"type": "ota_complete", "version": "1.0.0"}]
    assert pub.of_type("version")[-1]["version"] == "1.0.0"
    assert all(t == "pish/pish-1/responses" for t, _ in pub.messages)


def test_url_chunks_are_reassembled(agent, serve):
    a, pub = agent
    serve[URL] = make_tarball({"x": "y"})
    parts = [URL[i : i + 40] for i in range(0, len(URL), 40)]
    for i, part in enumerate(parts):
        send(a, command="url_chunk", chunk_index=i, total_chunks=len(parts), chunk_data=part, version="1.0.0")
    wait(a)
    assert pub.of_type("ota_complete")


def test_sha_mismatch_is_an_error_and_nothing_changes(agent, serve):
    a, pub = agent
    serve[URL] = make_tarball({"x": "y"})
    send(a, command="ota_update", url=URL, version="1.0.0", sha256="00" * 32)
    wait(a)
    assert pub.of_type("ota_error")[0]["message"] == "sha256 mismatch"
    assert a.releases.current_version() is None


def test_unhealthy_update_reports_rolled_back(agent, serve, tmp_path):
    a, pub = agent
    serve[URL] = make_tarball({"x": "1"})
    send(a, command="ota_update", url=URL, version="1.0.0")
    wait(a)
    url2 = URL.replace("1.0.0", "1.1.0")
    serve[url2] = make_tarball({"x": "2"})
    (tmp_path / "unhealthy").touch()
    send(a, command="ota_update", url=url2, version="1.1.0")
    wait(a)
    assert pub.of_type("ota_error")[-1]["message"] == "rolled back"
    assert a.releases.current_version() == "1.0.0"


def test_simple_commands(agent):
    a, pub = agent
    send(a, command="ping")
    send(a, command="get_version")
    send(a, command="get_status")
    send(a, command="reboot")
    send(a, command="bogus")
    a.handle(b"not json")
    assert [m["type"] for _, m in pub.messages] == ["pong", "version", "status", "reboot_ack", "error", "error"]
    assert "reboot_ack" in [m["type"] for _, m in pub.messages]


def test_bad_ota_requests(agent):
    a, pub = agent
    send(a, command="ota_update", version="1.0.0")
    send(a, command="url_chunk", chunk_index=5, total_chunks=2, chunk_data="x")
    send(a, command="ota_cancel")
    assert [m.get("message") or m.get("status") for _, m in pub.messages] == [
        "No firmware URL provided",
        "Invalid chunk parameters",
        "Update cancelled",
    ]


def test_heartbeat_goes_to_status_topic(agent):
    a, pub = agent
    a.heartbeat()
    topic, body = pub.messages[0]
    assert topic == "pish/pish-1/status"
    assert body["version"] is None and body["updating"] is False


def test_out_of_order_chunks_keep_sha256_from_the_last_chunk(agent, serve):
    a, pub = agent
    a.config.require_sha256 = True
    data = make_tarball({"x": "y"})
    serve[URL] = data
    parts = [URL[i : i + 40] for i in range(0, len(URL), 40)]
    order = list(range(len(parts)))
    order = order[-1:] + order[:-1]  # last chunk (with sha256) first
    for i in order:
        extra = {"sha256": sha(data)} if i == len(parts) - 1 else {}
        send(a, command="url_chunk", chunk_index=i, total_chunks=len(parts), chunk_data=parts[i], version="1.0.0", **extra)
    wait(a)
    assert pub.of_type("ota_complete")


def test_sha256_is_required_by_default(agent):
    a, pub = agent
    a.config.require_sha256 = True
    send(a, command="ota_update", url=URL, version="1.0.0")
    assert pub.of_type("ota_error")[0]["message"] == "sha256 required"


def test_pushing_the_running_version_is_a_no_op_success(agent, serve):
    a, pub = agent
    serve[URL] = make_tarball({"x": "1"})
    send(a, command="ota_update", url=URL, version="1.0.0")
    wait(a)
    a.worker = None
    send(a, command="ota_update", url=URL, version="1.0.0")
    assert len(pub.of_type("ota_complete")) == 2


def test_handler_errors_never_escape(agent, monkeypatch):
    a, pub = agent
    monkeypatch.setattr(a.releases, "current_version", lambda: (_ for _ in ()).throw(RuntimeError("boom")))
    send(a, command="get_version")
    send(a, command=["not", "a", "string"])
    assert [m["type"] for _, m in pub.messages] == ["error", "error"]


def test_restart_is_refused_mid_update(agent):
    a, pub = agent
    a._busy.acquire()
    send(a, command="reboot")
    a._busy.release()
    assert pub.messages[-1][1]["message"] == "Update in progress; not restarting"
