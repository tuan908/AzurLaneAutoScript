"""The instance listing rule; alasd implements it again and tests against the same fixture."""
import json
from pathlib import Path

import pytest

from module.config.utils import alas_instance
from module.submodule.utils import get_config_mod

CASES = json.loads((Path(__file__).parent / "fixtures" / "instance_listing.json").read_text("utf-8"))["cases"]


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_listing(case, tmp_path, monkeypatch):
    (tmp_path / "config").mkdir()
    for name in case["files"]:
        (tmp_path / "config" / name).write_text("{}")
    monkeypatch.chdir(tmp_path)
    # Same set as the fixture; the order of os.listdir differs between filesystems
    got = sorted((name, get_config_mod(name)) for name in alas_instance())
    want = sorted((i["id"], i["func"]) for i in case["instances"])
    assert got == want
