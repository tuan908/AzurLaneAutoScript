"""Run the ALAS dashboard and control API in one local server process."""
import argparse
import asyncio
import sys

import uvicorn

from module.webui.setting import State


class ControlServer(uvicorn.Server):
    async def shutdown(self, sockets=None):
        State.shutting_down = True
        await super().shutdown(sockets)


def app():
    from module.webui.app import app as create_app

    return create_app(headless=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("-p", "--port", type=int, default=22267)
    parser.add_argument("--run", nargs="+", metavar="INSTANCE", help="Start these profiles at launch")
    args = parser.parse_args()
    if sys.platform == "win32":
        asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())
    ControlServer(uvicorn.Config(
        "control_server:app", factory=True, host="127.0.0.1", port=args.port, workers=1, access_log=False,
    )).run()
