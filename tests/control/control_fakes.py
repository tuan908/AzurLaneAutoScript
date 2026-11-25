"""
Fake worker targets with the ProcessManager.run_process signature (config_name, func, q, ev).

``func`` carries the path of a spawn log: every fake appends one line to it when it starts,
so tests can count how many workers were really created.
"""
import os
import time


def _record_spawn(path):
    with open(path, "a") as f:
        f.write("{}\n".format(os.getpid()))


def worker_runs(config_name, func, q, ev):
    _record_spawn(func)
    q.put("Scheduler: Start task `Commission`")
    time.sleep(120)


def worker_finishes(config_name, func, q, ev):
    _record_spawn(func)
    q.put("[{}] exited. Reason: Finish\n".format(config_name))


def worker_crashes(config_name, func, q, ev):
    _record_spawn(func)
    os._exit(3)


def spawn_count(path):
    if not os.path.exists(path):
        return 0
    with open(path) as f:
        return len([line for line in f if line.strip()])
