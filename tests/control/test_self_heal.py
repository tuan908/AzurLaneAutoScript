"""Self-healing in the scheduler loop: postpone a failing task, relaunch on an unknown page."""
import sys
import threading
import types

import pytest


class TaskEnd(Exception):
    pass


class FakeConfig:
    def __init__(self, log):
        self.log = log
        self.Error_OnePushConfig = None
        self.Error_HandleError = True

    def task_call(self, task, force_call=True):
        self.log.append(("call", task))
        return True

    def task_delay(self, minute=None, task=None, **kwargs):
        self.log.append(("delay", task, minute))


@pytest.fixture
def alas(monkeypatch):
    log = []
    config_module = types.ModuleType("module.config.config")
    config_module.AzurLaneConfig = lambda config_name: FakeConfig(log)
    config_module.TaskEnd = TaskEnd
    notify_module = types.ModuleType("module.notify")
    notify_module.handle_notify = lambda *args, **kwargs: log.append(("notify", kwargs.get("title")))
    monkeypatch.setitem(sys.modules, "module.config.config", config_module)
    monkeypatch.setitem(sys.modules, "module.notify", notify_module)
    monkeypatch.delitem(sys.modules, "alas", raising=False)
    import alas as alas_module

    def make(script):
        """script: list of (task, behaviour) where behaviour is None or an exception to raise."""
        script = list(script)
        script_alas = alas_module.AzurLaneAutoScript("test")
        script_alas.stop_event = threading.Event()
        script_alas.is_first_task = False
        device = types.SimpleNamespace(screenshot=lambda: None, sleep=lambda s: None, package="pkg",
                                       stuck_record_clear=lambda: None, click_record_clear=lambda: None)
        checker = types.SimpleNamespace(wait_until_available=lambda: None, is_recovered=lambda: False,
                                        check_now=lambda: None, is_available=lambda: True)
        script_alas.__dict__.update(device=device, checker=checker)
        script_alas.save_error_log = lambda: None
        current = {}

        def next_task():
            if not script:
                script_alas.stop_event.set()
                return "Idle"
            task, behaviour = script.pop(0)
            current["behaviour"] = behaviour
            return task

        def runner():
            behaviour = current["behaviour"]
            if behaviour is not None:
                raise behaviour

        script_alas.get_next_task = next_task
        for name in ("commission", "minigame", "dorm", "main", "restart", "idle"):
            setattr(script_alas, name, runner)
        return script_alas

    return alas_module, make, log


def loop_until_done(script_alas):
    # The loop checks stop_event before asking for the next task; stop after the script runs out.
    script_alas.loop()


def test_task_failing_three_times_is_postponed(alas):
    alas_module, make, log = alas
    stuck = alas_module.GameStuckError("Wait too long")
    script_alas = make([("Minigame", stuck)] * 3 + [("Dorm", None)])
    loop_until_done(script_alas)
    assert ("delay", "Minigame", alas_module.TASK_COOLDOWN_MINUTES) in log
    assert script_alas.failure_record["Minigame"] == 0


def test_task_level_takeover_postpones_only_that_task(alas):
    alas_module, make, log = alas
    script_alas = make([("Main", alas_module.RequestHumanTakeover()), ("Dorm", None)])
    loop_until_done(script_alas)
    assert ("delay", "Main", alas_module.TASK_COOLDOWN_MINUTES) in log


def raise_from(alas_module, filename, error):
    code = compile("def fail():\n    raise error\n", filename, "exec")
    scope = {"error": error}
    exec(code, scope)
    try:
        scope["fail"]()
    except alas_module.RequestHumanTakeover as raised:
        return raised


def test_lost_emulator_exits_as_a_crash_for_auto_restart(alas):
    alas_module, make, log = alas
    error = raise_from(alas_module, "module/device/method/adb.py", alas_module.RequestHumanTakeover())
    script_alas = make([("Main", error)])
    with pytest.raises(SystemExit) as stop:
        loop_until_done(script_alas)
    assert stop.value.code == 1
    assert not any(entry[0] == "delay" for entry in log)


def test_emulator_not_found_still_asks_for_a_human(alas):
    alas_module, make, log = alas
    error = raise_from(alas_module, "module/device/device.py", alas_module.EmulatorNotFound())
    script_alas = make([("Main", error)])
    with pytest.raises(SystemExit) as stop:
        loop_until_done(script_alas)
    assert stop.value.code == alas_module.HUMAN_TAKEOVER_EXIT_CODE


def test_many_postpones_in_an_hour_ask_for_a_human(alas):
    alas_module, make, log = alas
    takeover = alas_module.RequestHumanTakeover
    script_alas = make([(task, takeover()) for task in ("Main", "Dorm", "Minigame", "Commission")])
    with pytest.raises(SystemExit) as stop:
        loop_until_done(script_alas)
    assert stop.value.code == alas_module.HUMAN_TAKEOVER_EXIT_CODE
    assert sum(entry[0] == "delay" for entry in log) == alas_module.MAX_POSTPONES_PER_HOUR


def test_unknown_page_relaunches_once_then_stops(alas):
    alas_module, make, log = alas
    unknown = alas_module.GamePageUnknownError
    script_alas = make([("Commission", unknown()), ("Commission", unknown())])
    with pytest.raises(SystemExit) as stop:
        loop_until_done(script_alas)
    assert stop.value.code == 1
    assert log.count(("call", "Restart")) == 1


def test_unknown_page_counter_resets_after_success(alas):
    alas_module, make, log = alas
    unknown = alas_module.GamePageUnknownError
    script_alas = make([("Commission", unknown()), ("Dorm", None), ("Commission", unknown()), ("Dorm", None)])
    loop_until_done(script_alas)
    assert log.count(("call", "Restart")) == 2


def test_restart_failing_three_times_exits_to_retry_later(alas):
    alas_module, make, log = alas
    stuck = alas_module.GameTooManyClickError("Too many click for a button: LOGIN_CHECK")
    script_alas = make([("Restart", stuck)] * 3)
    with pytest.raises(SystemExit) as stop:
        loop_until_done(script_alas)
    assert stop.value.code == alas_module.RETRY_LATER_EXIT_CODE


def test_login_takeover_exits_to_retry_later(alas):
    alas_module, make, log = alas
    code = compile("def login_fails():\n    raise RequestHumanTakeover\n", "module/handler/login.py", "exec")
    scope = {"RequestHumanTakeover": alas_module.RequestHumanTakeover}
    exec(code, scope)
    try:
        scope["login_fails"]()
    except alas_module.RequestHumanTakeover as error:
        login_error = error
    script_alas = make([("Restart", login_error)])
    with pytest.raises(SystemExit) as stop:
        loop_until_done(script_alas)
    assert stop.value.code == alas_module.RETRY_LATER_EXIT_CODE
