"""The worker process as alasd runs it: python -m module.control.worker <instance> <func>"""
import json
import os
import subprocess
import sys

from filelock import FileLock

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


def run_worker(instance, func, timeout=120):
    proc = subprocess.Popen(
        [sys.executable, "-m", "module.control.worker", instance, func],
        cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        env=dict(os.environ, PYTHONIOENCODING="utf-8"),
    )
    # stdin stays open, like alasd keeps it: the worker must still exit by itself
    try:
        proc.wait(timeout=timeout)
    finally:
        out = proc.stdout.read().decode("utf-8")
        err = proc.stderr.read().decode("utf-8")
        proc.stdin.close()
    return proc.returncode, out, err


def test_logs_are_json_lines_and_worker_exits_with_stdin_open():
    code, out, err = run_worker("pytest-worker-protocol", "NoSuchFunction")
    lines = [json.loads(line)["log"] for line in out.splitlines()]
    assert code == 0, err
    assert any("No function matched: NoSuchFunction" in line for line in lines)
    assert "Reason: Finish" in lines[-1]


def test_instance_owned_elsewhere_exits_75():
    lock_dir = os.path.join(ROOT, "config", "tmp", "workers")
    os.makedirs(lock_dir, exist_ok=True)
    with FileLock(os.path.join(lock_dir, "pytest-worker-owned.lock")):
        code, out, err = run_worker("pytest-worker-owned", "alas", timeout=60)
    assert code == 75
    assert out == ""
