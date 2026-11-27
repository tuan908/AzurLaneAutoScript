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


def test_sidecar_reports_lock_timeout(other_process, tmp_path):
    """alasd answers 503 config_busy for ConfigLockTimeout"""
    import io
    import json

    from module.control.configuration import ConfigService
    from module.control.sidecar import Handlers, serve

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

    class FakeHandlers(Handlers):
        def __init__(self):
            self.config = config

    from hashlib import sha256
    revision = sha256(path.read_bytes()).hexdigest()[:16]
    requests = [
        {"id": 1, "method": "read", "params": {"instance": "alas"}},
        {"id": 2, "method": "update", "params": {"instance": "alas", "revision": revision,
                                                "changes": {"Alas.Emulator.Serial": "x:1"}}},
    ]
    out = io.StringIO()
    serve(io.StringIO("".join(json.dumps(r) + "\n" for r in requests)), out, FakeHandlers())
    responses = [json.loads(line) for line in out.getvalue().splitlines()]
    assert [r["error"]["type"] for r in responses] == ["ConfigLockTimeout", "ConfigLockTimeout"]
    assert json.loads(path.read_text())["Alas"]["Emulator"]["Serial"] == "auto"
