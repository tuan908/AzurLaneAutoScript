"""Windows side of sync-from-wsl.sh. Runs under the installed toolkit Python."""

from contextlib import contextmanager
import ctypes
import errno
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import ProxyHandler, Request, build_opener

if sys.platform == "win32":
    import psutil
else:
    raise SystemExit("Run this helper with the Windows toolkit Python.")

opener = build_opener(ProxyHandler({}))
kernel = ctypes.WinDLL("kernel32", use_last_error=True)
user = ctypes.WinDLL("user32")
kernel.GetConsoleWindow.restype = ctypes.c_void_p
user.IsWindowVisible.argtypes = [ctypes.c_void_p]


def request(path, method="GET", timeout=5):
    with opener.open(Request(f"http://127.0.0.1:{port}{path}", method=method), timeout=timeout) as response:
        return response.read()


def api(path, method="GET", timeout=5):
    return json.loads(request("/api/v1/" + path, method, timeout))


def find_control_server():
    try:
        pid = api("health")["serverPid"]
    except HTTPError as error:
        if error.code == 401:
            raise RuntimeError("Automatic restart requires a local control API without a password.") from None
        raise
    except URLError as error:
        if getattr(error.reason, "errno", None) in (errno.ECONNREFUSED, 10061):
            return None
        raise
    process = psutil.Process(pid)
    # alasd.exe since the Go control server, control_server.py before
    is_control_server = process.name().lower() == "alasd.exe" or any(
        Path(arg).name in ("control_server.py", "alasd.exe") for arg in process.cmdline())
    if Path(process.cwd()) != root or not is_control_server:
        raise RuntimeError(f"Port {port} is serving a different installation or command")
    return process


@contextmanager
def attached_console(pid):
    kernel.FreeConsole()
    if not kernel.AttachConsole(pid):
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        yield
    finally:
        kernel.FreeConsole()


def request_server_shutdown(process):
    with attached_console(process.pid):
        members = (ctypes.c_ulong * 128)()
        count = kernel.GetConsoleProcessList(members, len(members))
        related = {os.getpid(), process.pid, process.ppid()}
        related.update(child.pid for child in process.children(recursive=True))
        if not 0 < count <= len(members) or not set(members[:count]).issubset(related):
            raise RuntimeError("Control server shares its console with unrelated processes")

        # Ctrl+C reaches the whole console. Keep this helper alive to finish the restart.
        ctrl_c_event = 0
        if not kernel.SetConsoleCtrlHandler(None, True) or not kernel.GenerateConsoleCtrlEvent(ctrl_c_event, 0):
            raise ctypes.WinError(ctypes.get_last_error())
        time.sleep(0.5)


def close_old_batch(parent):
    # Ctrl+C can leave the hidden batch at a prompt, holding the launcher log open.
    if parent is None:
        return
    try:
        if parent.name().lower() != "cmd.exe" or Path(parent.cwd()) != root:
            return
        batch_args = [arg.lower() for arg in parent.cmdline()[1:4]]
        if batch_args != ["/d", "/c", "start-control.bat"]:
            return
        if any(child.name().lower() != "conhost.exe" for child in parent.children(recursive=True)):
            return
        parent.terminate()
        parent.wait(timeout=5)
    except psutil.NoSuchProcess:
        pass


def instance_path(profile):
    return "instances/" + quote(profile, safe="")


def stop_control_server():
    process = find_control_server()
    profiles = []
    crashed = []
    if process:
        for status in api("instances")["instances"]:
            if status.get("unmanaged"):
                continue
            if status["state"] in ("starting", "running"):
                profiles.append(status["id"])
            # A restart forgets the crash, so resume what automatic recovery would have restarted.
            elif (status["state"] == "failed"
                  and (status.get("health") or {}).get("state") in ("crashed", "waiting_retry")
                  and (status.get("health") or {}).get("recovery", {}).get("policy", {}).get("autoRestart")):
                crashed.append(status["id"])
    saved = {"pid": process.pid if process else None, "profiles": profiles + crashed}
    state_file.write_text(json.dumps(saved), encoding="utf-8")
    if process is None:
        return

    for profile in profiles:
        status = api(instance_path(profile) + "/stop", "POST", timeout=45)
        if status["state"] != "stopped" or status["processId"] is not None:
            raise RuntimeError("A managed worker did not stop")
    parent = process.parent()
    request_server_shutdown(process)
    process.wait(timeout=30)
    close_old_batch(parent)
    print(f"Stopped control server and {len(profiles)} managed worker(s).", flush=True)


def launch_hidden_server():
    wscript = Path(os.environ["WINDIR"]) / "System32" / "wscript.exe"
    launcher = subprocess.Popen(
        [str(wscript), str(root / "start-control.vbs"), port],
        cwd=str(root), creationflags=subprocess.DETACHED_PROCESS,
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    # The first launch installs uv, Python and the dependencies into toolkit\uv and .venv
    deadline = time.monotonic() + 600
    while time.monotonic() < deadline:
        process = find_control_server()
        if process:
            return process
        if launcher.poll() is not None:
            raise RuntimeError(f"Hidden launcher exited with code {launcher.returncode}. Check log/control-launch.log.")
        time.sleep(1)
    raise RuntimeError("Timed out starting the hidden control server. Check log/control-launch.log.")


def resume_control_server():
    saved = json.loads(state_file.read_text(encoding="utf-8"))
    process = find_control_server() or launch_hidden_server()
    for profile in saved["profiles"]:
        path = instance_path(profile)
        if api(path)["state"] not in ("starting", "running"):
            api(path + "/start", "POST", timeout=30)
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            status = api(path)
            if status["state"] == "running" and status["processId"]:
                break
            if status["state"] == "failed":
                raise RuntimeError("A worker failed to resume")
            time.sleep(1)
        else:
            raise RuntimeError("Timed out waiting for a worker to resume")
    if process.pid != saved["pid"]:
        with attached_console(process.pid):
            window = kernel.GetConsoleWindow()
            if window and user.IsWindowVisible(window):
                raise RuntimeError("Control server console is visible")
        if request("/dashboard/") != (root / "dashboard" / "dist" / "index.html").read_bytes():
            raise RuntimeError("Served dashboard differs from the deployed build")
        print(f"Hidden control server is ready on port {port}; resumed {len(saved['profiles'])} worker(s).")


if __name__ == "__main__":
    mode, target, port, state_path = sys.argv[1:]
    root = Path(target)
    state_file = Path(state_path)
    if mode == "stop":
        stop_control_server()
    elif mode == "resume":
        resume_control_server()
    else:
        raise SystemExit(f"Unknown control action: {mode}")
