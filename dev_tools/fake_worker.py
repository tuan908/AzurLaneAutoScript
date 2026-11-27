"""
Fake Alas worker for dashboard smoke tests, speaks the protocol of module/control/worker.py.

    alasd --fake-workers   runs `python dev_tools/fake_worker.py <instance> <func>` for every instance
"""
import json
import sys


def log(text):
    print(json.dumps({"log": text}), flush=True)


if __name__ == "__main__":
    log("Smoke worker ready")
    log("Scheduler: Start task `Commission`")
    log("Scheduler: End task `Commission` [success]")
    for line in sys.stdin:
        if line.strip() == "stop":
            break
