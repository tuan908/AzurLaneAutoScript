"""Start a dashboard smoke server from an isolated checkout, with a fake worker."""
import argparse
import asyncio
import sys
import time


def worker(config_name, func, logs, event):
    logs.put("Smoke worker ready")
    logs.put("Scheduler: Start task `Commission`")
    logs.put("Scheduler: End task `Commission` [success]")
    while not event.is_set():
        time.sleep(0.1)


def app():
    from control_server import app as create_app
    from module.webui.process_manager import ProcessManager

    ProcessManager.run_process = staticmethod(worker)
    return create_app()


if __name__ == "__main__":
    import uvicorn

    from control_server import ControlServer

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=22368)
    args = parser.parse_args()
    if sys.platform == "win32":
        asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())
    ControlServer(uvicorn.Config("dev_tools.smoke_control_runtime:app", factory=True, host="127.0.0.1",
                                 port=args.port, workers=1, access_log=False)).run()
