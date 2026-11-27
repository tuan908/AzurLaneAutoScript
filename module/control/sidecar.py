"""
Config helper of the Go control server (alasd), one long-lived process.

    python -m module.control.sidecar

The config of Alas (defaults, migrations, derived keys, the scheduler queue) is Python
code shared with the workers, so alasd asks this process instead of re-implementing it.

Protocol, one JSON object per line:
    request  {"id": 1, "method": "read", "params": {"instance": "alas"}}
    response {"id": 1, "result": ...}
          or {"id": 1, "error": {"type": "ConfigConflict", "message": "...", ...}}
"""
import json
import os
import sys
import traceback


def _protocol_stream():
    fd = os.dup(1)
    os.dup2(2, 1)
    sys.stdout = sys.stderr
    return os.fdopen(fd, "w", encoding="utf-8", buffering=1, newline="\n")


class Handlers:
    def __init__(self):
        from module.config.config_updater import ConfigUpdater
        from module.config.lock import config_lock
        from module.config.utils import filepath_args, filepath_config, filepath_i18n, read_file
        from module.control.configuration import ConfigService
        from module.submodule.utils import get_config_mod

        self.updater = ConfigUpdater()
        self.get_config_mod = get_config_mod
        self.filepath_config = filepath_config

        def i18n(name, lang):
            path = filepath_i18n(lang, get_config_mod(name))
            return read_file(path) if os.path.exists(path) else {}

        self.config = ConfigService(
            config_mod=get_config_mod,
            args=lambda name: read_file(filepath_args("args", get_config_mod(name))),
            menu=lambda name: read_file(filepath_args("menu", get_config_mod(name))),
            i18n=i18n,
            read_raw=self.read_raw,
            read_config=self.updater.read_file,
            write_config=lambda name, data: self.updater.write_file(name, data),
            save_callback=self.updater.save_callback,
            lock=lambda name: config_lock(name, timeout=10, required=True),
        )

    def read_raw(self, name):
        try:
            with open(self.filepath_config(name), "rb") as f:
                return f.read()
        except FileNotFoundError:
            return None

    # ------------------------------------------------------------ methods

    def deploy(self):
        """Settings of config/deploy.yaml the server needs"""
        from module.webui.setting import State
        deploy = State.deploy_config
        runs = []
        if deploy.Run:
            runs = [r.strip(" ['\"]") for r in str(deploy.Run).split(",") if r.strip(" ['\"]")]
        return {"password": deploy.Password or None, "run": runs}

    def instances(self):
        """Configured instances, with the function each one runs"""
        from module.config.utils import alas_instance
        return [{"id": name, "func": self.get_config_mod(name)} for name in alas_instance()]

    def schema(self, instance, lang):
        return self.config.schema(instance, lang)

    def read(self, instance):
        return self.config.read(instance)

    def update(self, instance, revision, changes):
        return self.config.update(instance, revision, changes)

    def create(self, instance, source=None):
        self.config.create(instance, source)
        return None

    def tasks(self, instance):
        """Pending and waiting tasks, computed the same way as the GUI overview"""
        from module.submodule.submodule import load_config
        config = load_config(instance)
        config.get_next_task()

        def as_dict(func):
            return {"command": func.command, "nextRun": str(func.next_run)}

        return {
            "pending": [as_dict(f) for f in config.pending_task],
            "waiting": [as_dict(f) for f in config.waiting_task],
        }


def _error(e: Exception) -> dict:
    error = {"type": type(e).__name__, "message": str(e)}
    for attr in ("revision", "errors"):
        if hasattr(e, attr):
            error[attr] = getattr(e, attr)
    return error


def serve(stdin, stdout, handlers=None):
    handlers = handlers or Handlers()
    for line in stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
            rid = request.get("id")
        except ValueError:
            continue
        try:
            method = request["method"]
            if method.startswith("_") or not hasattr(handlers, method) or method == "read_raw":
                raise ValueError(f"Unknown method {method}")
            result = getattr(handlers, method)(**(request.get("params") or {}))
            response = {"id": rid, "result": result}
        except Exception as e:
            if not isinstance(e, (ValueError, KeyError)) or type(e) in (KeyError,):
                traceback.print_exc(file=sys.stderr)
            response = {"id": rid, "error": _error(e)}
        stdout.write(json.dumps(response, ensure_ascii=False, default=str) + "\n")
        stdout.flush()


def main():
    # The console log of this process goes to stderr, alasd copies it to its own output
    stream = _protocol_stream()
    serve(sys.stdin, stream)


if __name__ == "__main__":
    main()
