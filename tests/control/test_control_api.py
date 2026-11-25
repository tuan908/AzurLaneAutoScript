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
