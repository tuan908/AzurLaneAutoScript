"""alas.py writes the scheduler markers that alasd and the dashboard parse."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "scheduler_log.json").read_text("utf-8"))


def test_alas_logs_the_marker_templates():
    source = (ROOT / "alas.py").read_text("utf-8")
    for name, template in FIXTURE["templates"].items():
        assert f"logger.info(f'{template}')" in source, f"alas.py no longer logs the {name} marker {template!r}"


def test_fixture_lines_follow_the_templates():
    for line in FIXTURE["lines"]:
        if "start" in line:
            assert FIXTURE["templates"]["start"].format(task=line["start"]) in line["text"]
        if line.get("result"):
            assert FIXTURE["templates"]["end"].format(task=line["end"], outcome=line["result"]) in line["text"]
