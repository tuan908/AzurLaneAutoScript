"""
Application-facing lifecycle of Alas instances.

The web server process owns the workers (ProcessManager). Both the legacy PyWebIO GUI and the
HTTP API go through the same ProcessManager objects, so there is exactly one owner per instance.
Closing or refreshing a browser never touches a worker.
"""
import threading
from typing import Callable, Iterable, List, Optional


class UnknownInstance(KeyError):
    pass


class InstanceService:
    def __init__(
            self,
            list_instances: Callable[[], Iterable[str]],
            get_manager: Callable[[str], object],
            default_func: Callable[[str], str],
            stop_event: Callable[[], Optional[threading.Event]] = lambda: None,
            tasks: Optional[Callable[[str], dict]] = None,
    ):
        """
        Args:
            list_instances: Names of the configured instances, e.g. alas_instance().
            get_manager: ProcessManager.get_manager.
            default_func: Function to run when starting an instance, e.g. get_config_mod().
            stop_event: Event workers watch for a graceful stop (the updater's event).
            tasks: Scheduler queue of an instance, {"running": [...], "pending": [...], "waiting": [...]}.
        """
        self._list_instances = list_instances
        self._get_manager = get_manager
        self._default_func = default_func
        self._stop_event = stop_event
        self._tasks = tasks

    def _manager(self, instance_id: str):
        if instance_id not in set(self._list_instances()):
            raise UnknownInstance(instance_id)
        return self._get_manager(instance_id)

    def require(self, instance_id: str) -> None:
        """Raises UnknownInstance if instance_id is not a configured instance"""
        if instance_id not in set(self._list_instances()):
            raise UnknownInstance(instance_id)

    def list_instances(self) -> List[dict]:
        return [self._get_manager(name).status() for name in self._list_instances()]

    def get_status(self, instance_id: str) -> dict:
        return self._manager(instance_id).status()

    def start(self, instance_id: str) -> dict:
        manager = self._manager(instance_id)
        manager.start(self._default_func(instance_id), self._stop_event())
        return manager.status()

    def stop(self, instance_id: str) -> dict:
        manager = self._manager(instance_id)
        manager.stop()
        return manager.status()

    def restart(self, instance_id: str) -> dict:
        manager = self._manager(instance_id)
        manager.restart(self._default_func(instance_id), self._stop_event())
        return manager.status()

    def logs(self, instance_id: str, after: int = 0, limit: int = 500) -> dict:
        return self._manager(instance_id).log_since(after, limit)

    def tasks(self, instance_id: str) -> dict:
        manager = self._manager(instance_id)
        if self._tasks is None:
            return {"running": [], "pending": [], "waiting": []}
        queue = self._tasks(instance_id)
        # Same rule as the GUI overview: the first pending task is the running one
        pending = list(queue.get("pending", []))
        running = pending[:1] if manager.alive else []
        return {"running": running, "pending": pending[len(running):], "waiting": list(queue.get("waiting", []))}

    def running_count(self) -> int:
        return sum(1 for status in self.list_instances() if status["state"] in ("starting", "running", "stopping"))
