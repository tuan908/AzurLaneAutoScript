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
import asyncio
import hmac
import ipaddress
import json
import os
import re
import time
from datetime import datetime, timezone
from typing import Callable, Dict, Optional
from urllib.parse import urlsplit

from starlette.concurrency import run_in_threadpool
from starlette.requests import Request
from starlette.responses import JSONResponse, RedirectResponse, StreamingResponse
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles

from module.control.configuration import ConfigConflict, ConfigInvalid, ConfigService, ConfigUnsupported
from module.control.instances import InstanceService, UnknownInstance

API_PREFIX = "/api/v1"
API_VERSION = 1
DASHBOARD_PREFIX = "/dashboard"
# Server-sent events: how often the stream checks for changes, heartbeat interval,
# and the most log lines sent per instance per check (older ones are skipped; the
# client can page them from /logs)
EVENTS_POLL_SECONDS = 0.5
EVENTS_HEARTBEAT_SECONDS = 15.0
EVENTS_MAX_LINES = 200
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
            config: Optional[ConfigService] = None,
            monitor=None,
    ):
        self.service = service
        self.config = config
        self.monitor = monitor
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
            if request.method == "GET" and not token:
                # EventSource cannot send headers
                scheme, token = "bearer", request.query_params.get("access_token", "")
            if scheme.lower() != "bearer" or not hmac.compare_digest(token.encode(), self.password.encode()):
                return _error(401, "unauthorized", "Send Authorization: Bearer <password>")
            return None
        client = request.client.host if request.client else None
        if not _is_loopback(client) or not _is_loopback(_host_name(host)):
            return _error(403, "loopback_only", "Without a password the API only accepts local requests")
        return None

    @staticmethod
    def _map_error(e: Exception) -> Optional[JSONResponse]:
        if isinstance(e, UnknownInstance):
            return _error(404, "unknown_instance", f"No instance named {e.args[0]!r}")
        if isinstance(e, ConfigConflict):
            body = {"error": {"code": "conflict", "message": "The config changed since it was read; reload it"},
                    "revision": e.revision}
            return JSONResponse(body, status_code=409)
        if isinstance(e, ConfigInvalid):
            body = {"error": {"code": "invalid", "message": "Some values are invalid; nothing was saved"},
                    "fields": e.errors}
            return JSONResponse(body, status_code=400)
        if isinstance(e, ConfigUnsupported):
            return _error(501, "unsupported", str(e))
        if type(e).__name__ == "ConfigLockTimeout":
            return _error(503, "config_busy", "The config is being saved by Alas or the GUI; try again")
        if isinstance(e, ValueError):
            return _error(400, "bad_request", str(e))
        return None

    def _guarded(self, handler):
        if asyncio.iscoroutinefunction(handler):
            async def async_endpoint(request: Request):
                refused = self._refuse(request)
                if refused is not None:
                    return refused
                try:
                    return await handler(request)
                except Exception as e:
                    mapped = self._map_error(e)
                    if mapped is None:
                        raise
                    return mapped
            return async_endpoint

        def endpoint(request: Request):
            refused = self._refuse(request)
            if refused is not None:
                return refused
            try:
                return handler(request)
            except Exception as e:
                mapped = self._map_error(e)
                if mapped is None:
                    raise
                return mapped
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
        if self.monitor is not None:
            body["health"] = self.monitor.checks()
        return JSONResponse(body)

    def recovery(self, request: Request) -> JSONResponse:
        return JSONResponse(self.monitor.snapshot())

    async def recovery_policy(self, request: Request) -> JSONResponse:
        if not request.headers.get("content-type", "").startswith("application/json"):
            return _error(415, "unsupported_media_type", "Send Content-Type: application/json")
        try:
            body = await request.json()
        except Exception:
            raise ValueError("Body is not valid JSON")
        policy = await run_in_threadpool(self.monitor.policy.update, body)
        return JSONResponse({"policy": policy})

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

    def logs(self, request: Request) -> JSONResponse:
        after = int(request.query_params.get("after", "0"))
        limit = min(max(int(request.query_params.get("limit", "500")), 1), 2000)
        return JSONResponse(self.service.logs(request.path_params["instance_id"], after, limit))

    def tasks(self, request: Request) -> JSONResponse:
        return JSONResponse(self.service.tasks(request.path_params["instance_id"]))

    def config_schema(self, request: Request) -> JSONResponse:
        instance_id = request.path_params["instance_id"]
        self.service.require(instance_id)
        lang = request.query_params.get("lang", "en-US")
        if not re.fullmatch(r"[a-z]{2}-[A-Z]{2}", lang):
            raise ValueError("lang must look like en-US")
        return JSONResponse(self.config.schema(instance_id, lang))

    def config_read(self, request: Request) -> JSONResponse:
        instance_id = request.path_params["instance_id"]
        self.service.require(instance_id)
        return JSONResponse(self.config.read(instance_id))

    async def config_update(self, request: Request) -> JSONResponse:
        instance_id = request.path_params["instance_id"]
        self.service.require(instance_id)
        if not request.headers.get("content-type", "").startswith("application/json"):
            return _error(415, "unsupported_media_type", "Send Content-Type: application/json")
        try:
            body = await request.json()
        except Exception:
            raise ValueError("Body is not valid JSON")
        if not isinstance(body, dict) or not isinstance(body.get("revision"), str):
            raise ValueError('Body must be {"revision": "...", "changes": {"Task.Group.Arg": value}}')
        result = await run_in_threadpool(self.config.update, instance_id, body["revision"], body.get("changes"))
        return JSONResponse(result)

    async def events(self, request: Request):
        """
        Server-sent events. Each connection only keeps cursors (last revision and last log
        seq per instance) and reads the bounded buffers, so a slow or stalled browser never
        holds memory or blocks a worker. After a reconnect the client refetches the REST
        snapshot, which stays authoritative.
        """
        refused = self._refuse(request)
        if refused is not None:
            return refused
        service = self.service

        def sse(event_type: str, data: dict, event_id: Optional[int] = None) -> str:
            head = f"id: {event_id}\n" if event_id is not None else ""
            return f"{head}event: {event_type}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"

        async def stream():
            status_seen = {}
            log_seen = {}
            event_id = 0
            last_beat = time.time()
            yield "retry: 3000\n\n"
            while True:
                if await request.is_disconnected():
                    break
                statuses = await run_in_threadpool(service.list_instances)
                for status in statuses:
                    iid = status["id"]
                    health = status.get("health") or {}
                    recovery = health.get("recovery") or {}
                    key = (status["revision"], status["state"], status["currentTask"], health.get("state"),
                           health.get("detail") if health.get("state") == "stalled" else None,
                           recovery.get("nextAttemptAt"), recovery.get("gaveUp"), recovery.get("restartsLastHour"),
                           json.dumps(recovery.get("policy"), sort_keys=True))
                    if status_seen.get(iid) != key:
                        status_seen[iid] = key
                        event_id += 1
                        yield sse("instance.status.changed", {"instanceId": iid, "data": status}, event_id)
                    if iid not in log_seen:
                        # Start at the current end; the backlog comes from /logs
                        log_seen[iid] = service.logs(iid, 0, 1)["lastSeq"]
                        continue
                    chunk = service.logs(iid, log_seen[iid], EVENTS_MAX_LINES)
                    if chunk["lines"]:
                        log_seen[iid] = chunk["lastSeq"]
                        event_id += 1
                        yield sse("log.appended", {"instanceId": iid, "lines": chunk["lines"]}, event_id)
                now = time.time()
                if now - last_beat >= EVENTS_HEARTBEAT_SECONDS:
                    last_beat = now
                    yield ": ping\n\n"
                await asyncio.sleep(EVENTS_POLL_SECONDS)

        return StreamingResponse(stream(), media_type="text/event-stream", headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        })

    def routes(self):
        g = self._guarded
        return [
            Route("/health", g(self.health), methods=["GET"]),
            Route("/instances", g(self.list_instances), methods=["GET"]),
            Route("/instances/{instance_id}", g(self.get_instance), methods=["GET"]),
            Route("/instances/{instance_id}/start", g(self.start), methods=["POST"]),
            Route("/instances/{instance_id}/stop", g(self.stop), methods=["POST"]),
            Route("/instances/{instance_id}/restart", g(self.restart), methods=["POST"]),
            Route("/instances/{instance_id}/logs", g(self.logs), methods=["GET"]),
            Route("/instances/{instance_id}/tasks", g(self.tasks), methods=["GET"]),
            Route("/events", self.events, methods=["GET"]),
        ] + ([
            Route("/instances/{instance_id}/config/schema", g(self.config_schema), methods=["GET"]),
            Route("/instances/{instance_id}/config", g(self.config_read), methods=["GET"]),
            Route("/instances/{instance_id}/config", g(self.config_update), methods=["PATCH"]),
        ] if self.config is not None else []) + ([
            Route("/recovery", g(self.recovery), methods=["GET"]),
            Route("/recovery/policy", g(self.recovery_policy), methods=["PATCH"]),
        ] if self.monitor is not None else [])

    def mount(self) -> Mount:
        return Mount(API_PREFIX, routes=self.routes())


def mount_control_api(app, api: ControlApi, dashboard_dir: Optional[str] = None) -> None:
    """
    Put the API (and the built dashboard, when dashboard_dir exists) in front of the
    PyWebIO routes of an existing Starlette app.
    """
    routes = [api.mount()]
    if dashboard_dir and os.path.isdir(dashboard_dir):
        routes.append(Route(DASHBOARD_PREFIX, lambda request: RedirectResponse(DASHBOARD_PREFIX + "/")))
        routes.append(Mount(DASHBOARD_PREFIX, app=StaticFiles(directory=dashboard_dir, html=True)))
    for route in reversed(routes):
        app.router.routes.insert(0, route)
