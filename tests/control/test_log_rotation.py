import datetime
import logging

from rich.console import Console

from module.logger import RichFileHandler


def test_file_logs_rotate_on_size_and_date(tmp_path, monkeypatch):
    class Date(datetime.date):
        day = datetime.date(2026, 11, 25)

        @classmethod
        def today(cls):
            return cls.day

    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr("module.logger.datetime.date", Date)
    handler = RichFileHandler("rotation-test", console=Console())
    handler.max_bytes = 8
    folder = tmp_path / "log"
    legacy = folder / "2024-01-01_rotation-test.txt"
    legacy.write_text("legacy")
    entry = logging.LogRecord("test", logging.INFO, __file__, 1, "logged message", None, None)
    try:
        for _ in range(8):
            handler.handle(entry)
        assert len(list(folder.glob("*.rotated-*.txt"))) == 4
        Date.day = Date.day + datetime.timedelta(days=1)
        handler.handle(entry)
        assert not (folder / "2026-11-25_rotation-test.txt").exists()
        assert "logged message" in (folder / "2026-11-26_rotation-test.txt").read_text()
        assert legacy.read_text() == "legacy"
        handler.max_bytes = 1_000_000
        handler.close()
        handler.handle(entry)
        assert (folder / "2026-11-26_rotation-test.txt").read_text().count("logged message") == 2
    finally:
        handler.close()
