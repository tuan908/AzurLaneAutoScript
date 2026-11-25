"""Export the ALAS control API schema for frontend type generation."""
import json
from pathlib import Path

from module.control.openapi import document


if __name__ == "__main__":
    output = Path(__file__).resolve().parents[1] / "dashboard" / "openapi.json"
    output.write_text(json.dumps(document(), indent=2, sort_keys=True) + "\n", encoding="utf-8")
