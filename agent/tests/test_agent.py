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
