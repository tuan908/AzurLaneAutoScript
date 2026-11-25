import multiprocessing
import os
import threading
import time

import pytest

import module.config.lock as lock_module
from module.config.lock import ConfigLockTimeout, config_lock


@pytest.fixture(autouse=True)
def lock_dir(tmp_path, monkeypatch):
    path = str(tmp_path / "locks")
    monkeypatch.setattr(lock_module, "LOCK_DIR", path)
    monkeypatch.setattr(lock_module, "_locks", {})
    return path


def hold_lock(lock_dir, name, held, release):
    lock_module.LOCK_DIR = lock_dir
    lock_module._locks = {}
    with config_lock(name, required=True):
        held.set()
        release.wait(30)


@pytest.fixture
def other_process(lock_dir):
    """Another process (like an Alas worker) holding the lock of 'alas'"""
    held = multiprocessing.Event()
    release = multiprocessing.Event()
    process = multiprocessing.Process(target=hold_lock, args=(lock_dir, "alas", held, release))
    process.start()
    assert held.wait(15)
    yield release
    release.set()
    process.join(15)


def test_lock_file_location(lock_dir):
    assert lock_module.lock_path("alas") == os.path.join(os.path.abspath(lock_dir), "alas.lock")
    assert lock_module.lock_path("alas", "fpy").endswith("alas.fpy.lock")


def test_threads_exclude_each_other():
    inside = []
    overlaps = []

    def work():
        for _ in range(20):
            with config_lock("alas", required=True):
                inside.append(1)
                if len(inside) > 1:
                    overlaps.append(1)
                time.sleep(0.001)
                inside.pop()

    threads = [threading.Thread(target=work) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(30)
    assert overlaps == []


def test_reentrant_in_one_thread():
    with config_lock("alas", required=True) as outer:
        with config_lock("alas", required=True, timeout=0.5) as inner:
            assert outer and inner


def test_different_configs_do_not_block():
    with config_lock("alas", required=True):
        with config_lock("alas2", required=True, timeout=0.5) as locked:
            assert locked


def test_other_process_blocks_required_lock(other_process):
    started = time.time()
    with pytest.raises(ConfigLockTimeout):
        with config_lock("alas", timeout=0.3, required=True):
            pass
    assert time.time() - started >= 0.25

    other_process.set()
    with config_lock("alas", timeout=15, required=True) as locked:
        assert locked


def test_other_process_soft_lock_continues_without(other_process):
    with config_lock("alas", timeout=0.3) as locked:
        assert locked is False


def test_api_returns_503_while_locked(other_process, tmp_path):
    import json

    from starlette.applications import Starlette
    from starlette.testclient import TestClient

    from module.control.api import ControlApi, mount_control_api
    from module.control.configuration import ConfigService
    from module.control.instances import InstanceService

    path = tmp_path / "alas.json"
    path.write_text(json.dumps({"Alas": {"Emulator": {"Serial": "auto"}}}))
    args = {"Alas": {"Emulator": {"Serial": {"type": "input", "value": "auto", "valuetype": "str"}}}}
    config = ConfigService(
        config_mod=lambda name: "alas",
        args=lambda name: args,
        menu=lambda name: {},
        i18n=lambda name, lang: {},
        read_raw=lambda name: path.read_bytes(),
        read_config=lambda name: json.loads(path.read_text()),
        write_config=lambda name, data: path.write_text(json.dumps(data)),
        lock=lambda name: config_lock(name, timeout=0.3, required=True),
    )
    service = InstanceService(list_instances=lambda: ["alas"], get_manager=lambda name: None,
                              default_func=lambda name: "alas")
    app = Starlette()
    mount_control_api(app, ControlApi(service, config=config))

    class AsLoopback:
        async def __call__(self, scope, receive, send):
            if scope["type"] == "http":
                scope = dict(scope, client=("127.0.0.1", 50000))
            await app(scope, receive, send)

    client = TestClient(AsLoopback(), base_url="http://127.0.0.1:22267")
    from hashlib import sha256

    assert client.get("/api/v1/instances/alas/config").status_code == 503
    revision = sha256(path.read_bytes()).hexdigest()[:16]
    body = {"revision": revision, "changes": {"Alas.Emulator.Serial": "x:1"}}
    busy = client.patch("/api/v1/instances/alas/config", json=body)
    assert busy.status_code == 503
    assert busy.json()["error"]["code"] == "config_busy"
    assert json.loads(path.read_text())["Alas"]["Emulator"]["Serial"] == "auto"

    other_process.set()
    time.sleep(0.5)
    ok = client.patch("/api/v1/instances/alas/config", json=body)
    assert ok.status_code == 200
    assert json.loads(path.read_text())["Alas"]["Emulator"]["Serial"] == "x:1"
