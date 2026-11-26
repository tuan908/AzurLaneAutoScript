"""Response contracts for the Starlette control API and its generated dashboard types."""
from typing import Any, Dict, List, Optional, Union

from pydantic import BaseModel, Field, StrictBool, StrictFloat, StrictInt, StrictStr
from pydantic.schema import schema
from typing_extensions import Literal

from module.control.api import API_PREFIX, API_VERSION, ControlApi


InstanceState = Literal["stopped", "starting", "running", "stopping", "failed"]
HealthState = Literal["ok", "idle", "stopped", "stalled", "crashed", "human_takeover", "waiting_retry", "unmanaged"]
FieldKind = Literal["input", "select", "checkbox", "datetime", "textarea", "storage", "lock", "state"]


class InstancePolicy(BaseModel):
    autoRestart: bool
    restartOnStall: bool
    stallMinutes: int


class InstanceRecovery(BaseModel):
    policy: InstancePolicy
    restartsLastHour: int
    nextAttemptAt: Optional[str] = Field(..., nullable=True)
    pendingReason: Optional[str] = Field(..., nullable=True)
    gaveUp: bool


class InstanceHealth(BaseModel):
    state: HealthState
    detail: str
    recovery: InstanceRecovery


class InstanceStatus(BaseModel):
    id: str
    state: InstanceState
    processId: Optional[int] = Field(..., nullable=True)
    startedAt: Optional[str] = Field(..., nullable=True)
    stoppedAt: Optional[str] = Field(..., nullable=True)
    exitCode: Optional[int] = Field(..., nullable=True)
    currentTask: Optional[str] = Field(..., nullable=True)
    lastActivityAt: Optional[str] = Field(..., nullable=True)
    lastError: Optional[str] = Field(..., nullable=True)
    legacyState: int
    revision: int
    runLogStartSeq: int
    logDraining: bool
    unmanaged: bool
    taskSuccesses: int
    taskFailures: int
    health: Optional[InstanceHealth] = Field(None, nullable=True)


class Instances(BaseModel):
    instances: List[InstanceStatus]


CheckResult = Literal["ok", "warn", "fail"]


class HealthCheck(BaseModel):
    name: str
    status: CheckResult
    detail: str


class HealthChecks(BaseModel):
    status: CheckResult
    checks: List[HealthCheck]


class InstanceCounts(BaseModel):
    total: int
    running: int
    failed: int


class Metrics(BaseModel):
    taskSuccesses: int
    taskFailures: int
    workerRestarts: int
    sseConnections: int


class Health(BaseModel):
    status: str
    apiVersion: int
    time: str
    serverPid: int
    uptimeSeconds: float
    instances: InstanceCounts
    logQueueManagerAlive: Optional[bool] = Field(None, nullable=True)
    health: Optional[HealthChecks]


class HealthDetails(Health):
    metrics: Metrics
    instanceDetails: List[InstanceStatus]


class Task(BaseModel):
    command: str
    nextRun: Optional[str] = Field(..., nullable=True)


class Tasks(BaseModel):
    running: List[Task]
    pending: List[Task]
    waiting: List[Task]


class LogLine(BaseModel):
    seq: int
    text: str


class LogChunk(BaseModel):
    lines: List[LogLine]
    lastSeq: int


ConfigValue = Union[StrictStr, StrictBool, StrictInt, StrictFloat]


class ConfigOption(BaseModel):
    value: Optional[ConfigValue] = Field(..., nullable=True)
    label: str


class ConfigField(BaseModel):
    path: str
    type: FieldKind
    label: str
    help: str
    default: Optional[ConfigValue] = Field(..., nullable=True)
    readOnly: bool
    options: Optional[List[ConfigOption]]
    validation: Optional[str] = Field(None, alias="validate")
    valuetype: Optional[str]


class ConfigGroup(BaseModel):
    id: str
    name: str
    help: str
    fields: List[ConfigField]


class ConfigTask(BaseModel):
    id: str
    name: str
    help: str
    groups: List[ConfigGroup]


class ConfigMenu(BaseModel):
    id: str
    name: str
    tasks: List[ConfigTask]


class ConfigSchema(BaseModel):
    lang: str
    menus: List[ConfigMenu]


class ConfigDoc(BaseModel):
    revision: str
    config: Dict[str, Any]


class ConfigUpdate(BaseModel):
    revision: Optional[str]
    changes: Dict[str, Optional[ConfigValue]]


class ConfigApplied(BaseModel):
    revision: str
    applied: Dict[str, Any]


class PolicyOverride(BaseModel):
    autoRestart: Optional[bool]
    restartOnStall: Optional[bool]
    stallMinutes: Optional[int]


class PolicyUpdate(BaseModel):
    maxRestartsPerHour: Optional[int]
    backoffSeconds: Optional[List[int]]
    instances: Optional[Dict[str, PolicyOverride]]


class RecoveryPolicy(BaseModel):
    maxRestartsPerHour: int
    backoffSeconds: List[int]
    instances: Dict[str, PolicyOverride]


class RecoveryEvent(BaseModel):
    time: str
    instanceId: str
    action: str
    reason: str
    detail: str


class RecoverySnapshot(BaseModel):
    policy: RecoveryPolicy
    history: List[RecoveryEvent]


class PolicyApplied(BaseModel):
    policy: RecoveryPolicy


class ProfileCreate(BaseModel):
    id: str
    source: Optional[str] = Field(None, nullable=True)


RESPONSES = {
    "health": Health, "health_snapshot": HealthDetails,
    "list_instances": Instances, "get_instance": InstanceStatus, "start": InstanceStatus,
    "stop": InstanceStatus, "restart": InstanceStatus, "create_profile": InstanceStatus,
    "logs": LogChunk, "tasks": Tasks, "config_schema": ConfigSchema, "config_read": ConfigDoc,
    "config_update": ConfigApplied, "recovery": RecoverySnapshot, "recovery_policy": PolicyApplied,
}
REQUESTS = {"config_update": ConfigUpdate, "recovery_policy": PolicyUpdate, "create_profile": ProfileCreate}
PARAMETERS = {
    "logs": [("after", "query", "integer"), ("limit", "query", "integer")],
    "config_schema": [("lang", "query", "string")],
    "config_update": [("If-Match", "header", "string")],
}


def _ref(model):
    return {"$ref": "#/components/schemas/" + model.__name__}


def document(routes=None):
    if routes is None:
        routes = ControlApi(None, config=object(), monitor=object()).routes()
    models = list(dict.fromkeys(list(RESPONSES.values()) + list(REQUESTS.values())))
    schemas = schema(models, ref_prefix="#/components/schemas/")["definitions"]
    paths = {}
    for route in routes:
        name = route.endpoint.__name__
        if name == "openapi":
            continue
        path = API_PREFIX + route.path
        status = "201" if name == "create_profile" else "200"
        content = {"application/json": {"schema": _ref(RESPONSES[name])}} if name in RESPONSES else {
            "text/event-stream": {"schema": {"type": "string"}}}
        operation = {
            "operationId": name + ("_global" if path.endswith("/config/schema") and "{" not in path else ""),
            "responses": {status: {"description": "Success", "content": content}},
        }
        params = [{"name": param, "in": "path", "required": True, "schema": {"type": "string"}}
                  for param in route.param_convertors]
        params.extend({"name": param, "in": location, "schema": {"type": kind}}
                      for param, location, kind in PARAMETERS.get(name, []))
        if params:
            operation["parameters"] = params
        if name in REQUESTS:
            operation["requestBody"] = {
                "required": True, "content": {"application/json": {"schema": _ref(REQUESTS[name])}},
            }
        method = next(method.lower() for method in sorted(route.methods) if method != "HEAD")
        paths.setdefault(path, {})[method] = operation
    return {
        "openapi": "3.0.3", "info": {"title": "ALAS Control API", "version": str(API_VERSION)},
        "paths": paths,
        "components": {"schemas": schemas, "securitySchemes": {"bearer": {"type": "http", "scheme": "bearer"}}},
        "security": [{"bearer": []}, {}],
    }
