import io
import json
import os

import pytest

from module.control.configuration import EDITABLE_TYPES, ConfigConflict, ConfigInvalid, ConfigService, ConfigUnsupported
from module.control.sidecar import Handlers, serve

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


def load(path):
    with open(os.path.join(ROOT, path), encoding="utf-8") as f:
        return json.load(f)


ARGS = load("module/config/argument/args.json")
MENU = load("module/config/argument/menu.json")
I18N = load("module/config/i18n/en-US.json")


@pytest.fixture
def files(tmp_path):
    config = load("config/template.json")
    config["Custom"] = {"Unknown": {"Key": 42}}
    path = tmp_path / "alas.json"
    path.write_text(json.dumps(config, indent=2), encoding="utf-8")
    return {"alas": str(path)}


def make_service(files, mod="alas", save_callback=lambda key, value: ()):
    def read_raw(name):
        with open(files[name], "rb") as f:
            return f.read()

    def read_config(name):
        with open(files[name], encoding="utf-8") as f:
            return json.load(f)

    def write_config(name, data):
        # Same serialisation as module.config.utils.write_file
        with open(files[name], "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False, default=str)

    return ConfigService(
        config_mod=lambda name: mod,
        args=lambda name: ARGS,
        menu=lambda name: MENU,
        i18n=lambda name, lang: I18N,
        read_raw=read_raw,
        read_config=read_config,
        write_config=write_config,
        save_callback=save_callback,
    )


def fields_of(schema):
    for menu in schema["menus"]:
        for task in menu["tasks"]:
            for group in task["groups"]:
                yield from group["fields"]


def test_schema_covers_metadata(files):
    schema = make_service(files).schema("alas")
    assert schema["menus"]
    fields = list(fields_of(schema))
    assert len(fields) > 500
    for field in fields:
        task, group, arg = field["path"].split(".")
        meta = ARGS[task][group][arg]
        assert field["type"] == meta["type"]
        assert field["type"] != "storage"
        assert meta.get("display") != "hide"
        assert field["readOnly"] == (meta["type"] not in EDITABLE_TYPES or meta.get("display") == "disabled")


def test_schema_labels_and_options_from_i18n(files):
    fields = {f["path"]: f for f in fields_of(make_service(files).schema("alas"))}
    serial = fields["Alas.Emulator.Serial"]
    assert serial["label"] == I18N["Emulator"]["Serial"]["name"]
    assert serial["type"] == "input"
    package = fields["Alas.Emulator.PackageName"]
    assert {"value": "auto", "label": str(I18N["Emulator"]["PackageName"].get("auto", "auto"))} in package["options"]


def test_read_has_revision_and_config(files):
    body = make_service(files).read("alas")
    assert len(body["revision"]) == 16
    assert body["config"]["Alas"]["Emulator"]["Serial"] == "auto"


def test_update_applies_and_keeps_unknown_keys(files):
    service = make_service(files)
    # The real ConfigUpdater rebuilds the parsed document from metadata.
    parsed = service._read_config

    def known_settings(name):
        config = parsed(name)
        config.pop("Custom", None)
        return config

    service._read_config = known_settings
    revision = service.read("alas")["revision"]
    result = service.update("alas", revision, {
        "Alas.Emulator.Serial": "127.0.0.1:16384",
        "Alas.Emulator.ScreenshotDedithering": True,
        "Alas.Emulator.PackageName": "com.YoStarEN.AzurLane",
        "Commission.Scheduler.NextRun": "2026-11-25T08:30",
    })
    assert result["revision"] != revision
    saved = service.read("alas")["config"]
    assert saved["Alas"]["Emulator"]["Serial"] == "127.0.0.1:16384"
    assert saved["Alas"]["Emulator"]["ScreenshotDedithering"] is True
    assert saved["Alas"]["Emulator"]["PackageName"] == "com.YoStarEN.AzurLane"
    assert saved["Commission"]["Scheduler"]["NextRun"] == "2026-11-25 08:30:00"
    with open(files["alas"], encoding="utf-8") as stored:
        assert json.load(stored)["Custom"] == {"Unknown": {"Key": 42}}


def test_update_numbers_like_the_gui(files):
    service = make_service(files)
    path = next(f["path"] for f in fields_of(service.schema("alas"))
                if f["type"] == "input" and isinstance(f["default"], int) and not f["readOnly"]
                and "validate" not in f)
    service.update("alas", service.read("alas")["revision"], {path: "7"})
    task, group, arg = path.split(".")
    assert service.read("alas")["config"][task][group][arg] == 7


def test_invalid_change_writes_nothing(files):
    service = make_service(files)
    before = service.read("alas")
    with pytest.raises(ConfigInvalid) as e:
        service.update("alas", before["revision"], {
            "Alas.Emulator.Serial": "valid:1",
            "Alas.Emulator.PackageName": "not.an.option",
            "Alas.Emulator.ScreenshotDedithering": "yes",
            "Commission.Scheduler.NextRun": "tomorrow",
            "Nope.Nope.Nope": 1,
        })
    assert set(e.value.errors) == {"Alas.Emulator.PackageName", "Alas.Emulator.ScreenshotDedithering",
                                   "Commission.Scheduler.NextRun", "Nope.Nope.Nope"}
    assert service.read("alas") == before


def test_read_only_fields_refused(files):
    service = make_service(files)
    with pytest.raises(ConfigInvalid) as e:
        service.update("alas", service.read("alas")["revision"], {"Commission.Scheduler.Enable": False})
    assert e.value.errors == {"Commission.Scheduler.Enable": "Read-only setting"}


def test_stale_revision_is_conflict(files):
    service = make_service(files)
    revision = service.read("alas")["revision"]
    service.update("alas", revision, {"Alas.Emulator.Serial": "a:1"})
    with pytest.raises(ConfigConflict) as e:
        service.update("alas", revision, {"Alas.Emulator.Serial": "b:2"})
    assert e.value.revision == service.read("alas")["revision"]
    assert service.read("alas")["config"]["Alas"]["Emulator"]["Serial"] == "a:1"


def test_empty_value_resets_to_default(files):
    service = make_service(files)
    service.update("alas", service.read("alas")["revision"], {"Alas.Emulator.Serial": "x:1"})
    service.update("alas", service.read("alas")["revision"], {"Alas.Emulator.Serial": ""})
    assert service.read("alas")["config"]["Alas"]["Emulator"]["Serial"] == ARGS["Alas"]["Emulator"]["Serial"]["value"]


def test_save_callback_derived_keys(files):
    def callback(key, value):
        if key == "Alas.Emulator.Serial":
            yield "Alas.Emulator.AdbRestart", True

    service = make_service(files, save_callback=callback)
    result = service.update("alas", service.read("alas")["revision"], {"Alas.Emulator.Serial": "x:1"})
    assert result["applied"]["Alas.Emulator.AdbRestart"] is True
    assert service.read("alas")["config"]["Alas"]["Emulator"]["AdbRestart"] is True


def test_read_sends_datetimes_as_strings(files):
    import datetime

    service = make_service(files)
    plain = service._read_config

    def with_datetimes(name):
        config = plain(name)
        config["Commission"]["Scheduler"]["NextRun"] = datetime.datetime(2026, 11, 25, 8, 30, 5)
        return config

    service._read_config = with_datetimes
    body = service.read("alas")
    json.dumps(body)
    assert body["config"]["Commission"]["Scheduler"]["NextRun"] == "2026-11-25 08:30:05"
    # Saving still works when the parsed config holds datetimes
    service.update("alas", body["revision"], {"Alas.Emulator.Serial": "x:1"})


def test_mod_instances_unsupported(files):
    with pytest.raises(ConfigUnsupported):
        make_service(files, mod="fpy").schema("alas")


# ---------------------------------------------------------------- sidecar protocol


class FakeHandlers(Handlers):
    def __init__(self, config):
        self.config = config


@pytest.fixture
def call(files):
    """One JSON-lines request to the sidecar, as alasd sends it"""
    handlers = FakeHandlers(make_service(files))

    def call(method, **params):
        out = io.StringIO()
        serve(io.StringIO(json.dumps({"id": 7, "method": method, "params": params}) + "\n"), out, handlers)
        response = json.loads(out.getvalue())
        assert response["id"] == 7
        return response

    return call


def test_sidecar_schema_and_read(call):
    assert call("schema", instance="alas", lang="en-US")["result"]["menus"]
    assert "revision" in call("read", instance="alas")["result"]


def test_sidecar_update_flow(call):
    revision = call("read", instance="alas")["result"]["revision"]
    changes = {"Alas.Emulator.Serial": "127.0.0.1:16384"}
    ok = call("update", instance="alas", revision=revision, changes=changes)["result"]
    assert ok["applied"] == changes

    stale = call("update", instance="alas", revision=revision, changes=changes)["error"]
    assert stale["type"] == "ConfigConflict" and stale["revision"] == ok["revision"]

    bad = call("update", instance="alas", revision=ok["revision"], changes={"Alas.Emulator.PackageName": "nope"})
    assert bad["error"]["type"] == "ConfigInvalid"
    assert "Alas.Emulator.PackageName" in bad["error"]["errors"]


def test_sidecar_refuses_private_and_unknown_methods(call):
    assert call("_read_raw", name="alas")["error"]["type"] == "ValueError"
    assert call("_nope")["error"]["type"] == "ValueError"
    assert call("nope")["error"]["type"] == "ValueError"
