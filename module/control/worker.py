"""
One Alas instance as a child process of the Go control server (alasd).

    python -m module.control.worker <config_name> <func>

Protocol:
- stdout: one JSON object per line, {"log": "<plain text log entry>"}.
  Everything else the worker prints is moved to stderr, which alasd also reads.
- stdin: "stop" asks for a graceful stop (the stop event Alas checks between tasks
  and in waits). End of stdin means the server is gone: stop as well, so a worker
  never outlives its server.
- exit code: 0 finished or stopped, 1 crashed, HUMAN_TAKEOVER_EXIT_CODE,
  RETRY_LATER_EXIT_CODE, ALREADY_RUNNING_EXIT_CODE when another process owns the
  instance.
"""
import json
import os
import sys
import threading

# Protocol with alasd. alasd/internal/worker/protocol_test.go checks its copies against these.
ALREADY_RUNNING_EXIT_CODE = 75
WORKER_LOCK_DIR = "./config/tmp/workers"
LOG_KEY = "log"
STOP_COMMAND = "stop"


def _protocol_stream():
    """Keep the real stdout for the protocol, send prints and the console log to stderr"""
    fd = os.dup(1)
    os.dup2(2, 1)
    sys.stdout = sys.stderr
    return os.fdopen(fd, "w", encoding="utf-8", buffering=1, newline="\n")


class Publisher:
    def __init__(self, stream):
        self.stream = stream
        self.lock = threading.Lock()
        self.console = None

    def text(self, log) -> str:
        if isinstance(log, str):
            return log
        if self.console is None:
            from rich.console import Console
            self.console = Console(no_color=True, width=200)
        with self.console.capture() as capture:
            self.console.print(log)
        return capture.get()

    def __call__(self, log):
        try:
            line = json.dumps({LOG_KEY: self.text(log)}, ensure_ascii=False)
        except Exception:
            return
        with self.lock:
            try:
                self.stream.write(line + "\n")
            except (OSError, ValueError):
                # The server is gone, the stdin watcher stops the worker
                pass


def _command_stream():
    """
    Take stdin for the commands of the server. sys.stdin becomes devnull: the builtin exit()
    closes sys.stdin, which blocks forever while another thread reads it.
    """
    fd = os.dup(0)
    devnull = os.open(os.devnull, os.O_RDONLY)
    os.dup2(devnull, 0)
    os.close(devnull)
    sys.stdin = open(os.devnull, encoding="utf-8")
    return os.fdopen(fd, "r", encoding="utf-8")


def _watch_commands(commands, stop: threading.Event):
    try:
        for line in commands:
            if line.strip() == STOP_COMMAND:
                break
    except (OSError, ValueError):
        pass
    stop.set()


def run(config_name: str, func: str, publish, commands) -> None:
    import inflection

    from module.exception import HUMAN_TAKEOVER_EXIT_CODE, RequestHumanTakeover
    from module.logger import console_hdlr, logger, set_file_logger, set_func_logger
    from module.submodule.submodule import load_mod
    from module.submodule.utils import get_available_func, get_available_mod, get_available_mod_func, get_func_mod

    set_file_logger(name=config_name)
    # The server reads the log from the protocol stream, not from the console
    logger.removeHandler(console_hdlr)
    set_func_logger(func=publish)

    stop = threading.Event()
    threading.Thread(target=_watch_commands, args=(commands, stop), name="CommandWatcher", daemon=True).start()

    from module.config.config import AzurLaneConfig
    AzurLaneConfig.stop_event = stop
    try:
        if func == "alas":
            from alas import AzurLaneAutoScript
            AzurLaneAutoScript.stop_event = stop
            AzurLaneAutoScript(config_name=config_name).loop()
        elif func in get_available_func():
            from alas import AzurLaneAutoScript
            AzurLaneAutoScript(config_name=config_name).run(inflection.underscore(func), skip_first_screenshot=True)
        elif func in get_available_mod():
            mod = load_mod(func)
            mod.set_stop_event(stop)
            mod.loop(config_name)
        elif func in get_available_mod_func():
            getattr(load_mod(get_func_mod(func)), inflection.underscore(func))(config_name)
        else:
            logger.critical(f"No function matched: {func}")
        logger.info(f"[{config_name}] exited. Reason: Finish\n")
    except RequestHumanTakeover:
        logger.critical("Request human takeover")
        raise SystemExit(HUMAN_TAKEOVER_EXIT_CODE) from None
    except Exception as e:
        logger.exception(e)
        raise SystemExit(1) from None


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if len(argv) != 2:
        print("Usage: python -m module.control.worker <config_name> <func>", file=sys.stderr)
        return 2
    config_name, func = argv
    stream = _protocol_stream()
    commands = _command_stream()

    from filelock import FileLock, Timeout
    os.makedirs(WORKER_LOCK_DIR, exist_ok=True)
    lock = FileLock(os.path.abspath(os.path.join(WORKER_LOCK_DIR, f"{config_name}.lock")))
    try:
        lock.acquire(timeout=0)
    except Timeout:
        print(f"[{config_name}] is already running in another process", file=sys.stderr)
        return ALREADY_RUNNING_EXIT_CODE
    try:
        run(config_name, func, Publisher(stream), commands)
    except SystemExit as e:
        return e.code if isinstance(e.code, int) else 1
    finally:
        lock.release()
        try:
            stream.flush()
        except OSError:
            pass
    return 0


if __name__ == "__main__":
    # os._exit: daemon threads of Alas (screenshot streams, adb) must not keep a stopped worker alive
    code = main()
    sys.stderr.flush()
    os._exit(code)
