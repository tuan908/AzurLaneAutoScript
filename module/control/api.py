"""
HTTP API of the control plane, mounted at /api/v1 on the existing web server.

Commands are plain REST calls; the worker processes stay owned by the server, so a request
returns the real state of the instance, not what a browser last saw.

Access:
- When a password is set (deploy `Password` or `--key`), every request needs
  `Authorization: Bearer <password>`.
- Without a password, only loopback clients are accepted, and only with a loopback `Host`
  header (blocks DNS rebinding from a web page).
- Requests carrying an `Origin` of another site are refused (blocks cross-site POSTs from a
  browser tab).
"""
import hmac
import ipaddress
import os
import time
from datetime import datetime, timezone
from typing import Callable, Dict, Optional
from urllib.parse import urlsplit

from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Mount, Route

from module.control.instances import InstanceService, UnknownInstance

API_PREFIX = "/api/v1"
API_VERSION = 1
_LOOPBACK_NAMES = ("localhost",)


def _is_loopback(host: Optional[str]) -> bool:
    if not host:
        return False
    if host.lower() in _LOOPBACK_NAMES:
        return True
    try:
        return ipaddress.ip_address(host.strip("[]")).is_loopback
    except ValueError:
        return False


def _host_name(value: str) -> str:
    """Host header or Origin netloc without the port"""
    return urlsplit(f"//{value}").hostname or ""


def _error(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse({"error": {"code": code, "message": message}}, status_code=status)


class ControlApi:
    def __init__(
            self,
            service: InstanceService,
            password: Optional[str] = None,
            health_details: Callable[[], Dict] = dict,
    ):
        self.service = service
        self.password = password or None
        self.health_details = health_details
        self.started_at = time.time()

    # ------------------------------------------------------------ access

    def _refuse(self, request: Request) -> Optional[JSONResponse]:
        host = request.headers.get("host", "")
        origin = request.headers.get("origin")
        if origin is not None and (origin == "null" or _host_name(urlsplit(origin).netloc) != _host_name(host)):
            return _error(403, "cross_origin", "Cross-site requests are not allowed")
        if self.password is not None:
            scheme, _, token = request.headers.get("authorization", "").partition(" ")
            if scheme.lower() != "bearer" or not hmac.compare_digest(token.encode(), self.password.encode()):
                return _error(401, "unauthorized", "Send Authorization: Bearer <password>")
            return None
        client = request.client.host if request.client else None
        if not _is_loopback(client) or not _is_loopback(_host_name(host)):
            return _error(403, "loopback_only", "Without a password the API only accepts local requests")
        return None

    def _guarded(self, handler):
        def endpoint(request: Request):
            refused = self._refuse(request)
            if refused is not None:
                return refused
            try:
                return handler(request)
            except UnknownInstance as e:
                return _error(404, "unknown_instance", f"No instance named {e.args[0]!r}")
        return endpoint

    # ------------------------------------------------------------ endpoints

    def health(self, request: Request) -> JSONResponse:
        now = time.time()
        instances = self.service.list_instances()
        body = {
            "status": "ok",
            "apiVersion": API_VERSION,
            "time": datetime.fromtimestamp(now, tz=timezone.utc).isoformat(),
            "serverPid": os.getpid(),
            "uptimeSeconds": round(now - self.started_at, 3),
            "instances": {
                "total": len(instances),
                "running": sum(1 for s in instances if s["state"] in ("starting", "running", "stopping")),
                "failed": sum(1 for s in instances if s["state"] == "failed"),
            },
        }
        body.update(self.health_details())
        return JSONResponse(body)

    def list_instances(self, request: Request) -> JSONResponse:
        return JSONResponse({"instances": self.service.list_instances()})

    def get_instance(self, request: Request) -> JSONResponse:
        return JSONResponse(self.service.get_status(request.path_params["instance_id"]))

    def start(self, request: Request) -> JSONResponse:
        return JSONResponse(self.service.start(request.path_params["instance_id"]))

    def stop(self, request: Request) -> JSONResponse:
        status = self.service.stop(request.path_params["instance_id"])
        if status["state"] not in ("stopped", "failed"):
            return JSONResponse(status, status_code=409)
        return JSONResponse(status)

    def restart(self, request: Request) -> JSONResponse:
        return JSONResponse(self.service.restart(request.path_params["instance_id"]))

    def routes(self):
        g = self._guarded
        return [
            Route("/health", g(self.health), methods=["GET"]),
            Route("/instances", g(self.list_instances), methods=["GET"]),
            Route("/instances/{instance_id}", g(self.get_instance), methods=["GET"]),
            Route("/instances/{instance_id}/start", g(self.start), methods=["POST"]),
            Route("/instances/{instance_id}/stop", g(self.stop), methods=["POST"]),
            Route("/instances/{instance_id}/restart", g(self.restart), methods=["POST"]),
        ]

    def mount(self) -> Mount:
        return Mount(API_PREFIX, routes=self.routes())


def mount_control_api(app, api: ControlApi) -> None:
    """Put the API in front of the PyWebIO routes of an existing Starlette app"""
    app.router.routes.insert(0, api.mount())
