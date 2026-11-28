"""Profile name rule; the dashboard runs the same fixture against ProfileNameSchema."""
import json
from pathlib import Path

import pytest

from module.control.configuration import validate_profile_name

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "profile_names.json").read_text("utf-8"))
MESSAGES = {
    "format": "Use 1–48 letters, digits, hyphens or underscores, starting with a letter or digit",
    "reserved": "This profile name is reserved",
}


@pytest.mark.parametrize("name", FIXTURE["valid"])
def test_valid(name):
    validate_profile_name(name)


@pytest.mark.parametrize("reason,name", [(r, n) for r, names in FIXTURE["invalid"].items() for n in names])
def test_invalid(reason, name):
    with pytest.raises(ValueError) as e:
        validate_profile_name(name)
    assert str(e.value) == MESSAGES[reason]
