import importlib.util
from pathlib import Path
from types import SimpleNamespace

# Loaded by path: importing the module.device package pulls in adb and uiautomator2.
_spec = importlib.util.spec_from_file_location(
    "serial_fallback", Path(__file__).resolve().parents[2] / "module/device/platform/serial_fallback.py")
_module = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_module)
fallback_instance = _module.fallback_instance


def emu(name, path, type_="MuMuPlayer12", serial="127.0.0.1:16384"):
    return SimpleNamespace(name=name, path=path, type=type_, serial=serial)


MUMU = "D:/MuMuPlayer/nx_main/MuMuNxMain.exe"


def test_saved_name_and_path_pick_the_instance():
    first, second = emu("MuMuPlayer-12.0-0", MUMU), emu("MuMuPlayer-12.0-1", MUMU, serial="127.0.0.1:16416")
    assert fallback_instance([first, second], name="MuMuPlayer-12.0-1", path=MUMU) is second


def test_only_installed_instance_is_used():
    only = emu("MuMuPlayer-12.0-0", MUMU)
    assert fallback_instance([only]) is only


def test_ambiguous_without_saved_info_gives_none():
    assert fallback_instance([emu("a", MUMU), emu("b", MUMU)]) is None
    assert fallback_instance([]) is None
