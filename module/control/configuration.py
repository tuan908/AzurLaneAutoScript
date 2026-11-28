"""
Configuration editor backend: schema from the generated ALAS metadata (args.json, menu.json,
i18n), and revision-checked edits of config/<instance>.json.

Saving follows the PyWebIO GUI's rules (the same type coercion, `validate` patterns, empty value
= default, and ConfigUpdater.save_callback for derived keys), but it is all-or-nothing: if any
change is invalid, nothing is written. Unknown keys in the file are kept because the config is
read, patched and written back as a whole.
"""
import contextlib
import datetime
import hashlib
import json
import re
from collections.abc import Callable, Iterable
from contextlib import AbstractContextManager
from typing import Any

from module.config.deep import deep_get, deep_set

# Field types the editor can change. storage/lock/state are written by ALAS itself.
EDITABLE_TYPES = ("input", "select", "checkbox", "datetime", "textarea")
HIDDEN_TYPES = ("storage",)


class ConfigConflict(Exception):
    def __init__(self, revision: str):
        super().__init__(revision)
        self.revision = revision


class ConfigInvalid(Exception):
    def __init__(self, errors: dict[str, str]):
        super().__init__(errors)
        self.errors = errors


class ConfigUnsupported(Exception):
    pass


class ProfileExists(Exception):
    pass


def _jsonable(value: Any) -> Any:
    """ConfigUpdater.read_file gives datetime objects; send them as the file stores them"""
    if isinstance(value, dict):
        return {k: _jsonable(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_jsonable(v) for v in value]
    if isinstance(value, datetime.datetime):
        return value.strftime("%Y-%m-%d %H:%M:%S")
    if isinstance(value, (datetime.date, datetime.time)):
        return value.isoformat()
    return value


def _revision(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()[:16]


def _label(i18n: dict, group: str, arg: str, default: str) -> tuple[str, str]:
    entry = deep_get(i18n, [group, arg], default={}) or {}
    if not isinstance(entry, dict):
        return default, ""
    return str(entry.get("name") or default), str(entry.get("help") or "")


def _parse_number_or_str(value: Any) -> Any:
    """Same as the GUI's parse_pin_value for inputs without a valuetype"""
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value
    try:
        number = float(value)
    except (TypeError, ValueError):
        return value
    if number.is_integer():
        return int(number)
    return number


def _matches(pattern: str, value: str) -> bool:
    if pattern == "datetime":
        try:
            datetime.datetime.fromisoformat(value)
            return True
        except ValueError:
            return False
    return re.fullmatch(pattern, value) is not None


def validate_profile_name(name: str) -> None:
    """
    Rule of a new profile name. The dashboard checks the same rule before sending; both test
    against tests/control/fixtures/profile_names.json.

    Raises:
        ValueError: with the message shown to the user.
    """
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,47}", name):
        raise ValueError("Use 1–48 letters, digits, hyphens or underscores, starting with a letter or digit")
    # `template*` names are templates to ALAS; the rest are reserved file names on Windows
    if name.lower().startswith("template") or re.fullmatch(r"CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9]", name, flags=re.I):
        raise ValueError("This profile name is reserved")


class ConfigService:
    def __init__(
            self,
            config_mod: Callable[[str], str],
            args: Callable[[str], dict],
            menu: Callable[[str], dict],
            i18n: Callable[[str, str], dict],
            read_raw: Callable[[str], bytes | None],
            read_config: Callable[[str], dict],
            write_config: Callable[[str, dict], None],
            save_callback: Callable[[str, Any], Iterable[tuple[str, Any]]] = lambda key, value: (),
            lock: Callable[[str], AbstractContextManager] = lambda name: contextlib.nullcontext(),
    ):
        """
        Args:
            config_mod: Mod of an instance, "alas" for Alas itself (get_config_mod).
            args: Metadata of an instance (module/config/argument/args.json of its mod).
            menu: Menu of an instance (menu.json of its mod).
            i18n: Translations, i18n(instance, lang).
            read_raw: Bytes of config/<instance>.json, for the revision.
            read_config: Parsed and updated config (ConfigUpdater.read_file).
            write_config: Write the whole config atomically (ConfigUpdater.write_file).
            save_callback: Derived changes for a changed key (ConfigUpdater.save_callback).
            lock: Lock of an instance's config file, shared with the worker and the GUI
                (module.config.lock.config_lock); held from the revision check to the write.
        """
        self._config_mod = config_mod
        self._args = args
        self._menu = menu
        self._i18n = i18n
        self._read_raw = read_raw
        self._read_config = read_config
        self._write_config = write_config
        self._save_callback = save_callback
        self._lock = lock

    def _require_alas(self, instance_id: str) -> None:
        mod = self._config_mod(instance_id)
        if mod != "alas":
            raise ConfigUnsupported(f"Editing {mod} instances is not supported yet")

    # ------------------------------------------------------------ schema

    def schema(self, instance_id: str, lang: str = "en-US") -> dict:
        self._require_alas(instance_id)
        args = self._args(instance_id)
        menu = self._menu(instance_id)
        i18n = self._i18n(instance_id, lang)
        menus = []
        for menu_id, entry in menu.items():
            if entry.get("page") != "setting":
                continue
            tasks = []
            for task in entry.get("tasks", []):
                groups = self._groups(args.get(task, {}), task, i18n)
                if groups:
                    name, help_text = _label(i18n, "Task", task, task)
                    tasks.append({"id": task, "name": name, "help": help_text, "groups": groups})
            if tasks:
                name, _ = _label(i18n, "Menu", menu_id, menu_id)
                menus.append({"id": menu_id, "name": name, "tasks": tasks})
        return {"lang": lang, "menus": menus}

    def _groups(self, task_args: dict, task: str, i18n: dict) -> list[dict]:
        groups = []
        for group, group_args in task_args.items():
            fields = []
            for arg, meta in group_args.items():
                field = self._field(task, group, arg, meta, i18n)
                if field is not None:
                    fields.append(field)
            if fields:
                name, help_text = _label(i18n, group, "_info", group)
                groups.append({"id": group, "name": name, "help": help_text, "fields": fields})
        return groups

    def _field(self, task: str, group: str, arg: str, meta: dict, i18n: dict) -> dict | None:
        kind = meta.get("type")
        display = meta.get("display")
        if kind in HIDDEN_TYPES or display == "hide":
            return None
        label, help_text = _label(i18n, group, arg, arg)
        field = {
            "path": f"{task}.{group}.{arg}",
            "type": kind,
            "label": label,
            "help": help_text,
            "default": meta.get("value"),
            "readOnly": kind not in EDITABLE_TYPES or display == "disabled",
        }
        if "option" in meta:
            names = deep_get(i18n, [group, arg], default={}) or {}
            field["default"] = _jsonable(field["default"])
            field["options"] = [
                {"value": option, "label": str(names.get(str(option), option)) if isinstance(names, dict) else str(option)}
                for option in meta["option"]
            ]
        if "validate" in meta:
            field["validate"] = meta["validate"]
        if "valuetype" in meta:
            field["valuetype"] = meta["valuetype"]
        return field

    # ------------------------------------------------------------ values

    def create(self, instance_id: str, source: str | None) -> None:
        validate_profile_name(instance_id)
        if source is not None:
            self._require_alas(source)
            with self._lock(source):
                raw = self._read_raw(source)
                config = json.loads(raw) if raw else self._read_config(source)
        else:
            config = self._read_config("template")
        with self._lock(instance_id):
            if self._read_raw(instance_id) is not None:
                raise ProfileExists(instance_id)
            self._write_config(instance_id, config)

    def read(self, instance_id: str) -> dict:
        self._require_alas(instance_id)
        with self._lock(instance_id):
            revision = _revision(self._read_raw(instance_id) or b"")
            return {"revision": revision, "config": _jsonable(self._read_config(instance_id))}

    def update(self, instance_id: str, revision: str, changes: dict[str, Any]) -> dict:
        """
        Apply changes {"Task.Group.Arg": value} if the file still has `revision`.

        Raises:
            ConfigConflict: The file changed since `revision` was read.
            ConfigInvalid: Some changes are invalid; nothing was written.
        """
        self._require_alas(instance_id)
        if not isinstance(changes, dict) or not changes:
            raise ConfigInvalid({"": "No changes"})
        with self._lock(instance_id):
            return self._update_locked(instance_id, revision, changes)

    def _update_locked(self, instance_id: str, revision: str, changes: dict[str, Any]) -> dict:
        raw = self._read_raw(instance_id)
        current = _revision(raw or b"")
        if revision != current:
            raise ConfigConflict(current)

        args = self._args(instance_id)
        errors = {}
        coerced = {}
        for path, value in changes.items():
            meta = deep_get(args, path) if isinstance(path, str) and path.count(".") == 2 else None
            if not isinstance(meta, dict) or "type" not in meta:
                errors[path] = "Unknown setting"
                continue
            if meta["type"] not in EDITABLE_TYPES or meta.get("display") in ("disabled", "hide"):
                errors[path] = "Read-only setting"
                continue
            try:
                coerced[path] = self._coerce(meta, value)
            except ValueError as e:
                errors[path] = str(e)
        if errors:
            raise ConfigInvalid(errors)

        config = json.loads(raw) if raw else self._read_config(instance_id)
        applied = {}
        for path, value in coerced.items():
            deep_set(config, path, value)
            applied[path] = value
            for derived_path, derived_value in self._save_callback(path, value):
                deep_set(config, derived_path, derived_value)
                applied[derived_path] = derived_value
        # Writers that hold the same lock cannot have written meanwhile; this catches the rest
        latest = _revision(self._read_raw(instance_id) or b"")
        if latest != current:
            raise ConfigConflict(latest)
        self._write_config(instance_id, config)
        return {"revision": _revision(self._read_raw(instance_id) or b""), "applied": _jsonable(applied)}

    @staticmethod
    def _coerce(meta: dict, value: Any) -> Any:
        kind = meta["type"]
        if value is None or (isinstance(value, str) and not len(value)):
            # Same as the GUI: an emptied field goes back to its default
            return meta.get("value")
        if kind == "checkbox":
            if not isinstance(value, bool):
                raise ValueError("Expected true or false")
            return value
        if kind == "select":
            for option in meta.get("option", []):
                if option == value or str(option) == str(value):
                    return option
            raise ValueError("Not one of the options")
        if kind == "datetime":
            text = str(value).replace("T", " ")
            if len(text) == 16:
                text += ":00"
            if not _matches("datetime", text):
                raise ValueError("Expected a date and time like 2020-01-01 00:00:00")
            return text
        if kind == "textarea":
            return str(value)
        # input
        if meta.get("valuetype") == "str":
            value = str(value)
        else:
            value = _parse_number_or_str(value)
        validate = meta.get("validate")
        if validate and not _matches(validate, str(value)):
            raise ValueError(f"Does not match {validate}")
        return value
