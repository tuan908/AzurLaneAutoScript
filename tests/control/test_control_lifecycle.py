import gc
import multiprocessing
import threading
import time

import pytest

from module.webui.process_manager import ProcessManager
from module.webui.setting import State

import control_fakes as fakes


class _QueueOnlyManager:
    """Stands in for the SyncManager: workers only need Queue()"""

    @staticmethod
    def Queue():
        return multiprocessing.Queue()


@pytest.fixture
def pm(monkeypatch, tmp_path):
    monkeypatch.setattr(State, "manager", _QueueOnlyManager())
    monkeypatch.setattr(ProcessManager, "_processes", {})
    monkeypatch.setattr(ProcessManager, "stop_join_timeout", 5.0)
    managers = []

    def make(target=fakes.worker_runs, name="alas"):
        monkeypatch.setattr(ProcessManager, "run_process", staticmethod(target))
        manager = ProcessManager.get_manager(name)
        managers.append(manager)
        return manager

    make.spawns = str(tmp_path / "spawns.txt")
    yield make
    for manager in managers:
        manager.stop()


def wait_until(predicate, timeout=5.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(0.02)
    return predicate()


def run_threads(n, fn):
    barrier = threading.Barrier(n)
    results = [None] * n

    def worker(i):
        barrier.wait()
        results[i] = fn()

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(n)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=30)
    return results


def test_concurrent_start_creates_one_worker(pm):
    manager = pm()
    results = run_threads(20, lambda: manager.start(pm.spawns))
    assert results.count(True) == 1
    assert wait_until(lambda: fakes.spawn_count(pm.spawns) == 1)
    time.sleep(0.3)
    assert fakes.spawn_count(pm.spawns) == 1
    assert manager.status()["state"] == "running"


def test_concurrent_get_manager_returns_one_object(pm):
    pm()
    managers = run_threads(20, lambda: ProcessManager.get_manager("fresh"))
    assert all(m is managers[0] for m in managers)
    assert list(ProcessManager._processes).count("fresh") == 1


def test_stop_waits_for_confirmed_exit(pm):
    manager = pm()
    assert manager.start(pm.spawns)
    process = manager._process
    revision = manager.status()["revision"]

    assert manager.stop() is True
    assert not process.is_alive()
    assert process.exitcode is not None
    status = manager.status()
    assert status["state"] == "stopped"
    assert status["processId"] is None
    assert status["revision"] > revision
    assert status["stoppedAt"] is not None
    assert str(manager.renderables[-1]).endswith("Reason: Manual stop\n")
    assert manager.state == 2


def test_stop_when_stopped_is_safe(pm):
    manager = pm()
    assert manager.stop() is True
    assert manager.stop() is True
    assert manager.renderables == []
    assert manager.status()["state"] == "stopped"


def test_restart_never_runs_two_workers(pm):
    manager = pm()
    assert manager.start(pm.spawns)
    started = [manager._process]

    def restart():
        with manager.lock:
            ok = manager.restart(pm.spawns)
            started.append(manager._process)
        return ok

    for _ in range(3):
        assert run_threads(2, restart) == [True, True]
    assert len({p.pid for p in started}) == 7
    alive = [p for p in started if p.is_alive()]
    assert alive == [manager._process]


def test_start_during_stop_waits_for_the_stop(pm):
    manager = pm()
    assert manager.start(pm.spawns)
    old = manager._process
    seen_old_alive = []

    def stop():
        manager.stop()

    def start():
        started = manager.start(pm.spawns)
        seen_old_alive.append(old.is_alive())
        return started

    t_stop = threading.Thread(target=stop)
    t_stop.start()
    assert wait_until(lambda: manager._transition == "stopping" or not old.is_alive())
    start()
    t_stop.join(timeout=10)
    assert seen_old_alive == [False]
    assert manager.alive
    assert manager._process is not old


def test_unexpected_exit_is_failed(pm):
    manager = pm(fakes.worker_crashes)
    assert manager.start(pm.spawns)
    assert wait_until(lambda: not manager.alive)
    status = manager.status()
    assert status["state"] == "failed"
    assert status["exitCode"] == 3
    assert "code 3" in status["lastError"]


def test_natural_finish_is_stopped(pm):
    manager = pm(fakes.worker_finishes)
    assert manager.start(pm.spawns)
    assert wait_until(lambda: not manager.alive)
    status = manager.status()
    assert status["state"] == "stopped"
    assert status["exitCode"] == 0
    assert status["lastError"] is None


def test_status_survives_gui_session_closing(pm):
    manager = pm()
    assert manager.start(pm.spawns)
    pid = manager._process.pid

    class Session:
        def __init__(self):
            self.alas = ProcessManager.get_manager("alas")

    session = Session()
    del session
    gc.collect()
    again = ProcessManager.get_manager("alas")
    assert again is manager
    assert again.status()["processId"] == pid
    assert again.stop()


def test_current_task_and_activity_come_from_logs(pm):
    manager = pm()
    assert manager.start(pm.spawns)
    assert wait_until(lambda: manager.status()["currentTask"] == "Commission")
    assert manager.status()["lastActivityAt"] is not None
