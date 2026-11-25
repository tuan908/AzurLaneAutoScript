import argparse
import collections
import os
import queue
import re
import threading
import time
from datetime import datetime, timezone
from multiprocessing import Process
from typing import Dict, List, Optional, Union

import inflection
from rich.console import Console, ConsoleRenderable

# Since this file does not run under the same process or subprocess of app.py
# the following code needs to be repeated
# Import fake module before import pywebio to avoid importing unnecessary module PIL
from module.webui.fake_pil_module import *

import_fake_pil_module()

from module.logger import logger, set_file_logger, set_func_logger
from module.submodule.submodule import load_mod
from module.submodule.utils import get_available_func, get_available_mod, get_available_mod_func, get_config_mod, \
    get_func_mod, list_mod_instance
from module.webui.setting import State


_TASK_START = re.compile(r"Scheduler: Start task `([^`]+)`")
_TASK_END = "Scheduler: End task"
# Plain-text log tail kept per instance for the API (the renderables list stays for PyWebIO)
LOG_TAIL_LINES = 2000
LOG_LINE_MAX_CHARS = 16 * 1024


def _iso(timestamp: Optional[float]) -> Optional[str]:
    if timestamp is None:
        return None
    return datetime.fromtimestamp(timestamp, tz=timezone.utc).isoformat()


class ProcessManager:
    _processes: Dict[str, "ProcessManager"] = {}
    # Guards _processes, so concurrent get_manager() calls never create two managers
    _registry_lock = threading.Lock()
    # Seconds to wait for a killed worker to be reaped
    stop_join_timeout = 10.0

    def __init__(self, config_name: str = "alas") -> None:
        self.config_name = config_name
        self._renderable_queue: queue.Queue[ConsoleRenderable] = State.manager.Queue()
        self.renderables: List[ConsoleRenderable] = []
        self.renderables_max_length = 400
        self.renderables_reduce_length = 80
        self._process: Process = None
        self.thd_log_queue_handler: threading.Thread = None
        # Serialises start / stop / restart of this instance. Re-entrant, so restart
        # can hold it across its stop and start.
        self.lock = threading.RLock()
        # "starting" or "stopping" while a lifecycle call is in progress
        self._transition: Optional[str] = None
        self._stop_requested = False
        self._exit_observed = True
        self.revision = 0
        self.started_at: Optional[float] = None
        self.stopped_at: Optional[float] = None
        self.last_activity_at: Optional[float] = None
        self.current_task: Optional[str] = None
        self._text_console = Console(no_color=True, width=200)
        self.log_tail = collections.deque(maxlen=LOG_TAIL_LINES)
        self.log_seq = 0
        # log_seq when the current run started: lines after it belong to this run
        self.run_log_start_seq = 0

    def start(self, func, ev: threading.Event = None) -> bool:
        """
        Start the worker unless it is already running.

        Returns:
            bool: If a new worker was started.
        """
        with self.lock:
            if self.alive:
                return False
            if func is None:
                func = get_config_mod(self.config_name)
            self._transition = "starting"
            try:
                self._process = Process(
                    target=ProcessManager.run_process,
                    args=(
                        self.config_name,
                        func,
                        self._renderable_queue,
                        ev,
                    ),
                )
                self.run_log_start_seq = self.log_seq
                self._process.start()
                self._stop_requested = False
                self._exit_observed = False
                self.started_at = time.time()
                self.stopped_at = None
                self.current_task = None
                self.revision += 1
                self.start_log_queue_handler()
            finally:
                self._transition = None
            return True

    def start_log_queue_handler(self):
        if (
            self.thd_log_queue_handler is not None
            and self.thd_log_queue_handler.is_alive()
        ):
            return
        self.thd_log_queue_handler = threading.Thread(
            target=self._thread_log_queue_handler
        )
        self.thd_log_queue_handler.start()

    def stop(self) -> bool:
        """
        Kill the worker and wait until it has exited.

        Returns:
            bool: If no worker is running afterwards.
        """
        with self.lock:
            if self.alive:
                self._transition = "stopping"
                self._stop_requested = True
                self.revision += 1
                try:
                    self._process.kill()
                    self._process.join(timeout=self.stop_join_timeout)
                finally:
                    self._transition = None
                if self._process.is_alive():
                    logger.warning(
                        f"[{self.config_name}] still alive {self.stop_join_timeout}s after kill"
                    )
                else:
                    line = f"[{self.config_name}] exited. Reason: Manual stop\n"
                    self.renderables.append(line)
                    self._append_text(line)
                    self._observe_exit()
            if self.thd_log_queue_handler is not None:
                self.thd_log_queue_handler.join(timeout=1)
                if self.thd_log_queue_handler.is_alive():
                    logger.warning(
                        "Log queue handler thread does not stop within 1 seconds"
                    )
            stopped = not self.alive
        logger.info(f"[{self.config_name}] exited")
        return stopped

    def restart(self, func, ev: threading.Event = None) -> bool:
        """
        Stop the worker if running, then start a new one. Nothing else can start or
        stop this instance in between.

        Returns:
            bool: If a new worker was started.
        """
        with self.lock:
            if not self.stop():
                return False
            return self.start(func, ev)

    def _observe_exit(self) -> None:
        if not self._exit_observed:
            self._exit_observed = True
            self.stopped_at = time.time()
            self.revision += 1

    def _thread_log_queue_handler(self) -> None:
        while self.alive:
            try:
                log = self._renderable_queue.get(timeout=1)
            except queue.Empty:
                continue
            self.renderables.append(log)
            self._track_activity(log)
            if len(self.renderables) > self.renderables_max_length:
                self.renderables = self.renderables[self.renderables_reduce_length :]
        logger.info("End of log queue handler loop")

    def _track_activity(self, log) -> None:
        self.last_activity_at = time.time()
        try:
            if isinstance(log, str):
                text = log
            else:
                with self._text_console.capture() as capture:
                    self._text_console.print(log)
                text = capture.get()
        except Exception:
            return
        self._append_text(text)
        match = _TASK_START.search(text)
        if match:
            self.current_task = match.group(1)
        elif _TASK_END in text:
            self.current_task = None

    def _append_text(self, text: str) -> None:
        text = text.rstrip("\n")
        if len(text) > LOG_LINE_MAX_CHARS:
            text = text[:LOG_LINE_MAX_CHARS] + " …(truncated)"
        self.log_seq += 1
        self.log_tail.append((self.log_seq, text))

    def log_since(self, after: int = 0, limit: int = 500) -> dict:
        """
        Plain-text log lines with seq > after, oldest first, at most limit of them
        (the newest ones when more are available).
        """
        lines = [{"seq": seq, "text": text} for seq, text in list(self.log_tail) if seq > after]
        if limit and len(lines) > limit:
            lines = lines[-limit:]
        return {"lines": lines, "lastSeq": self.log_seq}

    def status(self) -> dict:
        """
        Snapshot of this instance, derived from the worker process this server owns.
        Never blocks on a running start or stop.
        """
        process = self._process
        alive = process is not None and process.is_alive()
        if process is not None and not alive and not self._exit_observed:
            if self.lock.acquire(blocking=False):
                try:
                    self._observe_exit()
                finally:
                    self.lock.release()

        legacy_state = self.state
        exit_code = None if process is None or alive else process.exitcode
        last_error = None
        if self._transition is not None:
            state = self._transition
        elif alive:
            state = "running"
        elif process is None or self._stop_requested:
            state = "stopped"
        elif exit_code not in (0, None):
            state = "failed"
            last_error = f"Worker exited with code {exit_code}"
        elif legacy_state == 3:
            state = "failed"
            last_error = "Worker stopped on an error, see the log"
        else:
            state = "stopped"

        return {
            "id": self.config_name,
            "state": state,
            "processId": process.pid if alive else None,
            "startedAt": _iso(self.started_at),
            "stoppedAt": None if alive else _iso(self.stopped_at),
            "exitCode": exit_code,
            "currentTask": self.current_task if alive else None,
            "lastActivityAt": _iso(self.last_activity_at),
            "lastError": last_error,
            "legacyState": legacy_state,
            "revision": self.revision,
            "runLogStartSeq": self.run_log_start_seq,
        }

    @property
    def alive(self) -> bool:
        if self._process is not None:
            return self._process.is_alive()
        else:
            return False

    @property
    def state(self) -> int:
        if self.alive:
            return 1
        elif len(self.renderables) == 0:
            return 2
        else:
            console = Console(no_color=True)
            with console.capture() as capture:
                console.print(self.renderables[-1])
            s = capture.get().strip()
            if s.endswith("Reason: Manual stop"):
                return 2
            elif s.endswith("Reason: Finish"):
                return 2
            elif s.endswith("Reason: Update"):
                return 4
            else:
                return 3

    @classmethod
    def get_manager(cls, config_name: str) -> "ProcessManager":
        """
        Create a new alas if not exists.
        """
        with cls._registry_lock:
            if config_name not in cls._processes:
                cls._processes[config_name] = ProcessManager(config_name)
            return cls._processes[config_name]

    @staticmethod
    def run_process(
        config_name, func: str, q: queue.Queue, e: threading.Event = None
    ) -> None:
        parser = argparse.ArgumentParser()
        parser.add_argument(
            "--electron", action="store_true", help="Runs by electron client."
        )
        args, _ = parser.parse_known_args()
        State.electron = args.electron

        # Setup logger
        set_file_logger(name=config_name)
        if State.electron:
            # https://github.com/LmeSzinc/AzurLaneAutoScript/issues/2051
            logger.info("Electron detected, remove log output to stdout")
            from module.logger import console_hdlr
            logger.removeHandler(console_hdlr)
        set_func_logger(func=q.put)

        from module.config.config import AzurLaneConfig

        # Remove fake PIL module, because subprocess will use it
        remove_fake_pil_module()

        AzurLaneConfig.stop_event = e
        try:
            # Run alas
            if func == "alas":
                from alas import AzurLaneAutoScript

                if e is not None:
                    AzurLaneAutoScript.stop_event = e
                AzurLaneAutoScript(config_name=config_name).loop()
            elif func in get_available_func():
                from alas import AzurLaneAutoScript

                AzurLaneAutoScript(config_name=config_name).run(inflection.underscore(func), skip_first_screenshot=True)
            elif func in get_available_mod():
                mod = load_mod(func)

                if e is not None:
                    mod.set_stop_event(e)
                mod.loop(config_name)
            elif func in get_available_mod_func():
                getattr(load_mod(get_func_mod(func)), inflection.underscore(func))(config_name)
            else:
                logger.critical(f"No function matched: {func}")
            logger.info(f"[{config_name}] exited. Reason: Finish\n")
        except Exception as e:
            logger.exception(e)

    @classmethod
    def running_instances(cls) -> List["ProcessManager"]:
        l = []
        for process in cls._processes.values():
            if process.alive:
                l.append(process)
        return l

    @staticmethod
    def restart_processes(
        instances: List[Union["ProcessManager", str]] = None, ev: threading.Event = None
    ):
        """
        After update and reload, or failed to perform an update,
        restart all alas that running before update
        """
        logger.hr("Restart alas")

        # Load MOD_CONFIG_DICT
        list_mod_instance()

        if instances is None:
            instances = []

        _instances = set()

        for instance in instances:
            if isinstance(instance, str):
                _instances.add(ProcessManager.get_manager(instance))
            elif isinstance(instance, ProcessManager):
                _instances.add(instance)

        try:
            with open("./config/reloadalas", mode="r") as f:
                for line in f.readlines():
                    line = line.strip()
                    _instances.add(ProcessManager.get_manager(line))
        except FileNotFoundError:
            pass

        for process in _instances:
            logger.info(f"Starting [{process.config_name}]")
            process.start(func=get_config_mod(process.config_name), ev=ev)

        try:
            os.remove("./config/reloadalas")
        except:
            pass
        logger.info("Start alas complete")
