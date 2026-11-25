import multiprocessing
import time

import pytest
from starlette.applications import Starlette
from starlette.responses import PlainTextResponse
from starlette.routing import Route
from starlette.testclient import TestClient

from module.control.api import ControlApi, mount_control_api
from module.control.instances import InstanceService
from module.webui.process_manager import ProcessManager
from module.webui.setting import State

import control_fakes as fakes


class _QueueOnlyManager:
    @staticmethod
    def Queue():
        return multiprocessing.Queue()


class _AsClient:
    """ASGI wrapper that sets the client address, which TestClient fixes to 'testclient'"""

    def __init__(self, app, host):
        self.app = app
        self.host = host

    async def __call__(self, scope, receive, send):
        if scope["type"] in ("http", "websocket"):
            scope = dict(scope, client=(self.host, 50000))
        await self.app(scope, receive, send)


@pytest.fixture
def server(monkeypatch, tmp_path):
    monkeypatch.setattr(State, "manager", _QueueOnlyManager())
    monkeypatch.setattr(ProcessManager, "_processes", {})
    monkeypatch.setattr(ProcessManager, "run_process", staticmethod(fakes.worker_runs))
    spawns = str(tmp_path / "spawns.txt")
    clients = []

    def make(password=None, client_host="127.0.0.1", base_url="http://127.0.0.1:22267"):
        app = Starlette(routes=[Route("/", lambda request: PlainTextResponse("pywebio"))])
        service = InstanceService(
            list_instances=lambda: ["alas", "alas2"],
            get_manager=ProcessManager.get_manager,
            default_func=lambda name: spawns,
        )
        mount_control_api(app, ControlApi(service, password=password,
                                          health_details=lambda: {"logQueueManagerAlive": True}))
        client = TestClient(_AsClient(app, client_host), base_url=base_url)
        clients.append(client)
        return client

    make.spawns = spawns
    yield make
    for manager in list(ProcessManager._processes.values()):
        manager.stop()


def test_health(server):
    r = server().get("/api/v1/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["apiVersion"] == 1
    assert body["instances"] == {"total": 2, "running": 0, "failed": 0}
    assert body["logQueueManagerAlive"] is True
    assert body["serverPid"] > 0


def test_existing_routes_still_served(server):
    r = server().get("/")
    assert r.status_code == 200
    assert r.text == "pywebio"


def test_list_and_get(server):
    client = server()
    r = client.get("/api/v1/instances")
    assert [s["id"] for s in r.json()["instances"]] == ["alas", "alas2"]
    r = client.get("/api/v1/instances/alas")
    assert r.status_code == 200
    assert r.json()["state"] == "stopped"


def test_unknown_instance_is_404(server):
    client = server()
    assert client.get("/api/v1/instances/nope").status_code == 404
    r = client.post("/api/v1/instances/nope/start")
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "unknown_instance"
    assert fakes.spawn_count(server.spawns) == 0


def test_start_stop_through_api(server):
    client = server()
    r = client.post("/api/v1/instances/alas/start")
    assert r.status_code == 200
    started = r.json()
    assert started["state"] == "running"
    pid = started["processId"]
    assert pid

    # A second start is a no-op on the same worker
    again = client.post("/api/v1/instances/alas/start").json()
    assert again["processId"] == pid

    # A new client (new browser session) sees the real state
    assert server().get("/api/v1/instances/alas").json()["processId"] == pid

    r = client.post("/api/v1/instances/alas/stop")
    assert r.status_code == 200
    stopped = r.json()
    assert stopped["state"] == "stopped"
    assert stopped["processId"] is None
    assert not ProcessManager.get_manager("alas")._process.is_alive()
    assert fakes.spawn_count(server.spawns) == 1


def test_restart_through_api(server):
    client = server()
    first = client.post("/api/v1/instances/alas/start").json()["processId"]
    second = client.post("/api/v1/instances/alas/restart").json()
    assert second["state"] == "running"
    assert second["processId"] != first


def test_get_is_not_allowed_on_commands(server):
    assert server().get("/api/v1/instances/alas/start").status_code == 405


def test_password_required_when_set(server):
    client = server(password="s3cret", client_host="192.168.1.20", base_url="http://192.168.1.10:22267")
    assert client.get("/api/v1/health").status_code == 401
    assert client.get("/api/v1/health", headers={"Authorization": "Bearer wrong"}).status_code == 401
    ok = client.get("/api/v1/health", headers={"Authorization": "Bearer s3cret"})
    assert ok.status_code == 200


def test_no_password_refuses_remote_clients(server):
    client = server(client_host="192.168.1.20", base_url="http://192.168.1.10:22267")
    r = client.post("/api/v1/instances/alas/start")
    assert r.status_code == 403
    assert r.json()["error"]["code"] == "loopback_only"
    assert fakes.spawn_count(server.spawns) == 0


def test_no_password_refuses_dns_rebinding(server):
    # A web page on evil.example resolving to 127.0.0.1: loopback client, foreign Host
    client = server(base_url="http://evil.example:22267")
    assert client.get("/api/v1/instances").status_code == 403


@pytest.mark.parametrize("origin", ["http://evil.example", "null"])
def test_cross_site_requests_refused(server, origin):
    client = server()
    r = client.post("/api/v1/instances/alas/start", headers={"Origin": origin})
    assert r.status_code == 403
    assert r.json()["error"]["code"] == "cross_origin"
    assert fakes.spawn_count(server.spawns) == 0


def test_same_origin_requests_allowed(server):
    client = server()
    r = client.get("/api/v1/health", headers={"Origin": "http://127.0.0.1:22267"})
    assert r.status_code == 200


def test_localhost_name_allowed(server):
    client = server(base_url="http://localhost:22267")
    assert client.get("/api/v1/health").status_code == 200


def wait_for(predicate, timeout=5.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(0.05)
    return predicate()


def test_logs_tail(server):
    client = server()
    client.post("/api/v1/instances/alas/start")
    assert wait_for(lambda: client.get("/api/v1/instances/alas/logs").json()["lines"])
    body = client.get("/api/v1/instances/alas/logs").json()
    assert "Scheduler: Start task `Commission`" in body["lines"][-1]["text"]
    last = body["lastSeq"]
    assert client.get("/api/v1/instances/alas/logs?after={}".format(last)).json()["lines"] == []
    client.post("/api/v1/instances/alas/stop")
    after_stop = client.get("/api/v1/instances/alas/logs?after={}".format(last)).json()["lines"]
    assert after_stop[-1]["text"].endswith("Reason: Manual stop")
    assert client.get("/api/v1/instances/alas/logs?after=x").status_code == 400


def test_tasks_without_provider_is_empty(server):
    assert server().get("/api/v1/instances/alas/tasks").json() == {"running": [], "pending": [], "waiting": []}


def test_tasks_first_pending_is_running_only_while_alive():
    class Manager:
        alive = True

    service = InstanceService(
        list_instances=lambda: ["alas"],
        get_manager=lambda name: Manager,
        default_func=lambda name: "alas",
        tasks=lambda name: {"pending": [{"command": "Commission"}, {"command": "Research"}],
                            "waiting": [{"command": "Daily"}]},
    )
    assert service.tasks("alas") == {"running": [{"command": "Commission"}], "pending": [{"command": "Research"}],
                                     "waiting": [{"command": "Daily"}]}
    Manager.alive = False
    assert service.tasks("alas")["running"] == []
    assert len(service.tasks("alas")["pending"]) == 2


def _read_events(api, host="127.0.0.1:22267", client=("127.0.0.1", 50000), chunks=3, timeout=5.0):
    import asyncio
    from starlette.requests import Request

    async def never_disconnect():
        await asyncio.sleep(3600)

    scope = {"type": "http", "method": "GET", "path": "/api/v1/events", "query_string": b"",
             "headers": [(b"host", host.encode())], "client": client}

    async def run():
        response = await api.events(Request(scope, never_disconnect))
        if not hasattr(response, "body_iterator"):
            return response, []
        out = []
        iterator = response.body_iterator.__aiter__()
        while len(out) < chunks:
            out.append(await asyncio.wait_for(iterator.__anext__(), timeout))
        await iterator.aclose()
        return response, out

    return asyncio.get_event_loop().run_until_complete(run())


def _api(spawns):
    service = InstanceService(
        list_instances=lambda: ["alas"],
        get_manager=ProcessManager.get_manager,
        default_func=lambda name: spawns,
    )
    return ControlApi(service)


def test_events_stream_status_then_logs(server):
    server()
    api = _api(server.spawns)
    response, chunks = _read_events(api, chunks=2)
    assert response.media_type == "text/event-stream"
    assert chunks[0].startswith("retry:")
    assert "event: instance.status.changed" in chunks[1]
    assert '"state": "stopped"' in chunks[1]

    # A connection open while a worker logs gets the state change, then the new lines
    import asyncio
    from starlette.requests import Request

    async def never_disconnect():
        await asyncio.sleep(3600)

    scope = {"type": "http", "method": "GET", "path": "/api/v1/events", "query_string": b"",
             "headers": [(b"host", b"127.0.0.1:22267")], "client": ("127.0.0.1", 50000)}

    async def run():
        response = await api.events(Request(scope, never_disconnect))
        iterator = response.body_iterator.__aiter__()
        out = [await iterator.__anext__(), await iterator.__anext__()]  # retry, stopped
        ProcessManager.get_manager("alas").start(server.spawns)
        while not any("log.appended" in c for c in out):
            out.append(await asyncio.wait_for(iterator.__anext__(), 10))
        await iterator.aclose()
        return "".join(out)

    joined = asyncio.get_event_loop().run_until_complete(run())
    assert '"state": "running"' in joined
    assert "Scheduler: Start task `Commission`" in joined


def test_events_refuse_cross_site(server):
    server()
    response, chunks = _read_events(_api(server.spawns), host="evil.example:22267")
    assert response.status_code == 403
    assert chunks == []


def test_dashboard_served_when_built(tmp_path, server):
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text("<html>dashboard</html>")
    app = Starlette(routes=[Route("/", lambda request: PlainTextResponse("pywebio"))])
    mount_control_api(app, _api(server.spawns), dashboard_dir=str(dist))
    client = TestClient(_AsClient(app, "127.0.0.1"), base_url="http://127.0.0.1:22267")
    r = client.get("/dashboard", allow_redirects=False)
    assert r.status_code in (302, 307)
    assert client.get("/dashboard/").text == "<html>dashboard</html>"
    assert client.get("/").text == "pywebio"
