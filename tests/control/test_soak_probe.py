"""
Tests of dev_tools/soak_probe.py (P0.1).

Row building and process classification use fake psutil-like objects, only
the smoke tests touch the real psutil and real processes.
"""
import csv
import os
import socket
import subprocess
import sys
import threading
import time
from collections import namedtuple
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from dev_tools import soak_probe
from dev_tools.soak_probe import COLUMNS, CpuCache, CsvSink, build_http_row, build_log_rows, build_proc_row, \
    classify, make_snapshot, parse_last_log_timestamp

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

Memory = namedtuple('Memory', ['rss', 'vms'])


class NoSuchProcess(Exception):
    pass


class AccessDenied(Exception):
    pass


class FakeProc:
    def __init__(self, rss=100 * 1048576, vms=200 * 1048576, threads=12, cpu=5.0, status='running', raises=None):
        self._memory = Memory(rss, vms)
        self._threads = threads
        self._cpu = cpu
        self._status = status
        self.raises = raises or {}
        self.cpu_calls = 0

    def _maybe_raise(self, name):
        if name in self.raises:
            raise self.raises[name]()

    def memory_info(self):
        self._maybe_raise('memory_info')
        return self._memory

    def num_threads(self):
        self._maybe_raise('num_threads')
        return self._threads

    def cpu_percent(self, interval=None):
        self._maybe_raise('cpu_percent')
        self.cpu_calls += 1
        return self._cpu

    def status(self):
        self._maybe_raise('status')
        return self._status


class WindowsProc(FakeProc):
    def num_handles(self):
        self._maybe_raise('num_handles')
        return 345


class PosixProc(FakeProc):
    def num_fds(self):
        self._maybe_raise('num_fds')
        return 17


def snap(pid, ppid=None, name='python.exe', cmdline=None, create_time=1000.0, listen=(), files=()):
    return make_snapshot(pid, ppid, name, cmdline or ['python.exe'], create_time, listen, files)


def spawn_cmd():
    return ['python.exe', '-c', 'from multiprocessing.spawn import spawn_main; spawn_main(parent_pid=1)',
            '--multiprocessing-fork']


# ---------------------------------------------------------------- csv

def read_csv(path):
    with open(path, encoding='utf-8', newline='') as f:
        return list(csv.reader(f))


def test_csv_header_and_fixed_columns(tmp_path):
    path = str(tmp_path / 'soak.csv')
    sink = CsvSink(path)
    assert sink.write([{'kind': 'probe', 'pid': 1}, {'kind': 'http', 'unknown_column': 'x'}])
    sink2 = CsvSink(path)
    assert sink2.path == path
    assert sink2.write([{'kind': 'log'}])

    rows = read_csv(path)
    assert rows[0] == list(COLUMNS)
    assert len(rows) == 4
    assert all(len(row) == len(COLUMNS) for row in rows)
    assert [row[COLUMNS.index('kind')] for row in rows[1:]] == ['probe', 'http', 'log']


def test_csv_creates_folder(tmp_path):
    path = str(tmp_path / 'log' / 'soak.csv')
    assert CsvSink(path).write([{'kind': 'probe'}])
    assert read_csv(path)[0] == list(COLUMNS)


def test_csv_header_mismatch_uses_new_file(tmp_path):
    path = tmp_path / 'soak.csv'
    path.write_text('a,b,c\n1,2,3\n', encoding='utf-8')
    sink = CsvSink(str(path), now=lambda: datetime(2026, 11, 25, 8, 0, 0))
    assert sink.path == str(tmp_path / 'soak.20261125-080000.csv')
    sink.write([{'kind': 'probe'}])
    assert path.read_text(encoding='utf-8') == 'a,b,c\n1,2,3\n'
    assert read_csv(sink.path)[0] == list(COLUMNS)


def test_csv_locked_file_keeps_rows(tmp_path, monkeypatch):
    path = str(tmp_path / 'soak.csv')
    sink = CsvSink(path)
    real_open = open

    def locked(*args, **kwargs):
        raise PermissionError('locked')

    monkeypatch.setattr('builtins.open', locked)
    assert not sink.write([{'kind': 'probe', 'sample': 1}])
    monkeypatch.setattr('builtins.open', real_open)
    assert sink.write([{'kind': 'probe', 'sample': 2}])
    rows = read_csv(path)
    assert [row[COLUMNS.index('sample')] for row in rows[1:]] == ['1', '2']


# ---------------------------------------------------------------- proc rows

def test_build_proc_row_from_fake_windows():
    s = snap(10, 1, 'python.exe', ['python.exe', 'gui.py'], 1000.0)
    row = build_proc_row(WindowsProc(), s, 'server', '', 1)
    assert row['kind'] == 'proc'
    assert row['role'] == 'server'
    assert row['pid'] == 10 and row['ppid'] == 1
    assert row['rss_mb'] == 100.0
    assert row['vms_mb'] == 200.0
    assert row['threads'] == 12
    assert row['handles'] == 345
    assert 'fds' not in row
    assert row['status'] == 'running'
    assert row['cmdline'] == 'python.exe gui.py'
    assert 'error' not in row


def test_build_proc_row_from_fake_posix():
    row = build_proc_row(PosixProc(), snap(10), 'worker', 'alas', 1)
    assert row['fds'] == 17
    assert 'handles' not in row
    assert row['instance'] == 'alas'


def test_build_proc_row_process_dies_midway():
    proc = WindowsProc(raises={'num_threads': NoSuchProcess, 'num_handles': NoSuchProcess,
                               'cpu_percent': NoSuchProcess, 'status': NoSuchProcess})
    row = build_proc_row(proc, snap(10), 'worker', 'alas', 1)
    assert row['status'] == 'gone'
    assert row['rss_mb'] == 100.0
    assert 'threads' not in row
    assert 'num_threads:NoSuchProcess' in row['error']


def test_build_proc_row_access_denied():
    raises = {name: AccessDenied for name in ('memory_info', 'num_threads', 'num_handles', 'cpu_percent', 'status')}
    row = build_proc_row(WindowsProc(raises=raises), snap(20, name='MuMuVMMHeadless.exe'), 'mumu')
    assert row['pid'] == 20
    assert row['name'] == 'MuMuVMMHeadless.exe'
    for column in ('rss_mb', 'threads', 'handles', 'cpu_pct', 'status'):
        assert column not in row
    assert 'AccessDenied' in row['error']


def test_build_proc_row_truncates_cmdline():
    row = build_proc_row(FakeProc(), snap(10, cmdline=['python.exe', 'x' * 1000]), 'pinned')
    assert len(row['cmdline']) == soak_probe.CMDLINE_MAX


def test_cpu_cache_pid_reuse():
    cache = CpuCache()
    first = FakeProc(cpu=7.0)
    row = build_proc_row(first, snap(10, create_time=1000.0), 'worker', cpu_cache=cache)
    assert 'cpu_pct' not in row
    assert first.cpu_calls == 1

    # Same process again, a new psutil object from process_iter: cached object is used
    other = FakeProc(cpu=99.0)
    row = build_proc_row(other, snap(10, create_time=1000.0), 'worker', cpu_cache=cache)
    assert row['cpu_pct'] == 7.0
    assert first.cpu_calls == 2
    assert other.cpu_calls == 0

    # Same pid, different create_time: a new process
    reused = FakeProc(cpu=3.0)
    row = build_proc_row(reused, snap(10, create_time=2000.0), 'worker', cpu_cache=cache)
    assert 'cpu_pct' not in row

    cache.prune([(10, 2000.0)])
    assert list(cache.procs) == [(10, 2000.0)]


# ---------------------------------------------------------------- classify

def reload_tree():
    return [
        snap(1, 0, 'alas.exe', ['alas.exe'], 900.0),
        snap(100, 1, 'python.exe', ['python.exe', 'gui.py', '--electron'], 1000.0),
        snap(101, 100, 'python.exe', spawn_cmd(), 1001.0, listen=[22267]),
        snap(102, 101, 'python.exe', spawn_cmd(), 1002.0,
             files=['C:\\alas\\log\\2026-11-25_gui.txt']),
        snap(103, 101, 'python.exe', spawn_cmd(), 1010.0,
             files=['C:\\alas\\log\\2026-11-25_gui.txt', 'C:\\alas\\log\\2026-11-25_alas.txt']),
        snap(104, 101, 'python.exe', spawn_cmd(), 1011.0, files=['./log/2026-11-24_alas2.txt']),
        snap(105, 101, 'python.exe', spawn_cmd(), 1012.0),
        snap(106, 103, 'adb.exe', ['adb.exe', 'devices'], 1020.0),
    ]


def test_classify_reload_tree():
    roles = classify(reload_tree(), 22267)
    assert roles[100] == ('gui_launcher', '', 100)
    assert roles[101] == ('server', '', 100)
    assert roles[102] == ('sync_manager', '', 100)
    assert roles[103] == ('worker', 'alas', 100)
    assert roles[104] == ('worker', 'alas2', 100)
    assert roles[105] == ('python_child', '', 100)
    assert roles[106] == ('descendant', '', 100)
    assert roles[1] == ('electron_main', '', '')


def test_classify_no_reload_tree():
    snaps = [
        snap(100, 1, 'python.exe', ['python.exe', 'gui.py'], 1000.0, listen=[22267]),
        snap(102, 100, 'python.exe', spawn_cmd(), 1002.0),
        snap(103, 100, 'python.exe', spawn_cmd(), 1010.0, files=['log/2026-11-25_alas.txt']),
    ]
    roles = classify(snaps, 22267)
    assert roles[100] == ('server', '', 100)
    assert roles[102] == ('sync_manager', '', 100)
    assert roles[103] == ('worker', 'alas', 100)
    assert 'gui_launcher' not in {r for r, _, _ in roles.values()}


def test_classify_server_fallback_without_listener():
    snaps = [s._replace(listen_ports=set()) for s in reload_tree()]
    roles = classify(snaps, 22267)
    assert roles[100][0] == 'gui_launcher'
    assert roles[101][0] == 'server'
    assert roles[103] == ('worker', 'alas', 100)


def test_classify_fork_children_are_not_new_roots():
    # Linux fork: children keep the gui.py command line
    snaps = [
        snap(100, 1, 'python3', ['python3', '/srv/alas/gui.py'], 1000.0, listen=[22267]),
        snap(102, 100, 'python3', ['python3', '/srv/alas/gui.py'], 1002.0),
        snap(103, 100, 'python3', ['python3', '/srv/alas/gui.py'], 1010.0, files=['log/2026-11-25_main.txt']),
    ]
    roles = classify(snaps, 22267)
    assert roles[100] == ('server', '', 100)
    assert roles[102] == ('sync_manager', '', 100)
    assert roles[103] == ('worker', 'main', 100)


def test_classify_electron_mumu_and_exclusions():
    snaps = [
        snap(1, 0, 'Alas.exe', ['Alas.exe'], 900.0),
        snap(2, 1, 'alas.exe', ['alas.exe', '--type=renderer', '--lang=en'], 901.0),
        snap(3, 1, 'alas.exe', ['alas.exe', '--type=gpu-process'], 902.0),
        snap(4, 0, 'MuMuVMMHeadless.exe', ['MuMuVMMHeadless.exe'], 903.0),
        snap(5, 0, 'MuMuPlayer.exe', ['MuMuPlayer.exe'], 904.0),
        snap(6, 0, 'python.exe', ['python.exe', 'other.py'], 905.0),
        snap(7, 0, 'python.exe', ['python.exe', 'dev_tools/soak_probe.py', 'gui.py'], 906.0),
        snap(8, 0, 'python.exe', ['python.exe', 'gui.py'], 907.0),
        snap(9, 0, 'adb.exe', ['adb.exe'], 908.0),
        snap(10, 0, 'notepad.exe', ['notepad.exe'], 909.0),
    ]
    roles = classify(snaps, 22267, extra_patterns=['adb*.exe'], pinned=[10], self_pid=8)
    assert roles[1] == ('electron_main', '', '')
    assert roles[2] == ('electron_renderer', '', '')
    assert roles[3] == ('electron_other', 'gpu-process', '')
    assert roles[4] == ('mumu', '', '')
    assert roles[5] == ('mumu', '', '')
    assert roles[9] == ('extra', '', '')
    assert roles[10] == ('pinned', '', '')
    for pid in (6, 7, 8):
        assert pid not in roles


def test_classify_ignores_reused_parent_pid():
    # pid 100 died and its pid was reused by a younger gui.py: 102 is not its child
    snaps = [
        snap(100, 1, 'python.exe', ['python.exe', 'gui.py'], 5000.0, listen=[22267]),
        snap(102, 100, 'python.exe', spawn_cmd(), 1002.0),
    ]
    roles = classify(snaps, 22267)
    assert roles[100][0] == 'server'
    assert 102 not in roles


def test_format_counts():
    roles = classify(reload_tree(), 22267)
    counts = dict(kv.split('=') for kv in soak_probe.format_counts(roles).split(';'))
    assert counts['server'] == '1'
    assert counts['sync_manager'] == '1'
    assert counts['worker'] == '2'
    assert counts['electron_main'] == '1'
    assert counts['electron_renderer'] == '0'
    assert counts['mumu'] == '0'


# ---------------------------------------------------------------- logs

def test_parse_last_log_timestamp():
    text = '\n'.join([
        '2026-11-25 08:00:00.123 | INFO | first',
        '2026-11-25 08:00:05.456 | ERROR | Traceback follows',
        'Traceback (most recent call last):',
        '  File "alas.py", line 1',
        '                      wrapped continuation',
    ])
    assert parse_last_log_timestamp(text) == datetime(2026, 11, 25, 8, 0, 5, 456000)
    assert parse_last_log_timestamp('no timestamp here\n') is None
    assert parse_last_log_timestamp('') is None


def test_read_tail_non_utf8(tmp_path):
    path = tmp_path / '2026-11-25_alas.txt'
    path.write_bytes(b'\xff\xfe garbage\n2026-11-25 08:00:00.000 | INFO | ok\n')
    text = soak_probe.read_tail(str(path))
    assert parse_last_log_timestamp(text) == datetime(2026, 11, 25, 8, 0, 0)


def test_build_log_rows(tmp_path):
    now = datetime(2026, 11, 25, 12, 0, 0)
    wall = now.timestamp()

    def write(name, age, line):
        path = tmp_path / name
        path.write_text(line, encoding='utf-8')
        os.utime(str(path), (wall - age, wall - age))

    write('2026-11-25_alas.txt', 10, '2026-11-25 11:59:40.000 | INFO | a\n')
    write('2026-11-25_gui.txt', 100, '2026-11-25 11:58:00.500 | INFO | b\n')
    write('2026-11-24_alas2.txt', 200, 'no timestamp\n')
    write('2026-11-20_old.txt', 10 * 86400, '2026-11-20 00:00:00.000 | INFO | c\n')
    write('soak.csv', 1, 'not a log\n')

    rows = build_log_rows(str(tmp_path), now, window_s=48 * 3600, limit=10)
    assert [r['instance'] for r in rows] == ['alas', 'gui', 'alas2']
    assert rows[0]['kind'] == 'log'
    assert rows[0]['mtime_age_s'] == 10.0
    assert rows[0]['last_line_ts'] == '2026-11-25T11:59:40.000'
    assert rows[0]['last_line_age_s'] == 20.0
    assert rows[1]['last_line_age_s'] == 119.5
    assert 'last_line_ts' not in rows[2]

    assert len(build_log_rows(str(tmp_path), now, limit=2)) == 2
    assert build_log_rows(str(tmp_path / 'missing'), now) == []


# ---------------------------------------------------------------- http

class _Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        code = 500 if self.path.startswith('/fail') else 200
        body = b'hello'
        self.send_response(code)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


@pytest.fixture
def http_server():
    server = HTTPServer(('127.0.0.1', 0), _Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield 'http://127.0.0.1:{}'.format(server.server_address[1])
    finally:
        server.shutdown()
        server.server_close()


def closed_port():
    sock = socket.socket()
    sock.bind(('127.0.0.1', 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


def test_http_row_ok_and_errors(http_server):
    row = build_http_row(http_server + '/', timeout=5)
    assert row['kind'] == 'http'
    assert row['http_status'] == 200
    assert row['latency_ms'] >= 0
    assert 'error' not in row

    row = build_http_row(http_server + '/fail', timeout=5)
    assert row['http_status'] == 500

    row = build_http_row('http://127.0.0.1:{}/'.format(closed_port()), timeout=5)
    assert 'http_status' not in row
    assert row['error']
    assert row['latency_ms'] >= 0


def test_http_row_opener_raises_anything():
    def opener(url, **kwargs):
        raise RuntimeError('boom')

    row = build_http_row('http://example.invalid/', opener=opener)
    assert row['error'] == 'RuntimeError: boom'


def test_url_port():
    assert soak_probe.url_port('http://127.0.0.1:22267/') == 22267
    assert soak_probe.url_port('https://localhost/') == 443
    assert soak_probe.url_port('http://localhost/') == 80


# ---------------------------------------------------------------- loop

class FakeClock:
    def __init__(self):
        self.t = 0.0
        self.sleeps = []

    def clock(self):
        return self.t

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.t += seconds


def test_run_survives_sample_exception(tmp_path):
    clock = FakeClock()
    calls = []

    def take_sample(sample, now):
        calls.append(sample)
        if sample == 1:
            raise ValueError('target vanished')
        return [{'kind': 'probe'}]

    sink = CsvSink(str(tmp_path / 'soak.csv'))
    code = soak_probe.run(take_sample, sink, 10, samples=3, clock=clock.clock, sleep=clock.sleep,
                          now=lambda: datetime(2026, 11, 25, 8, 0, 0))
    assert code == 0
    assert calls == [1, 2, 3]
    assert clock.sleeps == [10, 10]
    rows = read_csv(sink.path)
    kinds = [row[COLUMNS.index('kind')] for row in rows[1:]]
    assert kinds == ['error', 'probe', 'probe']
    assert 'ValueError: target vanished' in rows[1][COLUMNS.index('error')]
    assert [row[COLUMNS.index('sample')] for row in rows[1:]] == ['1', '2', '3']
    assert rows[1][COLUMNS.index('ts')].startswith('2026-11-25T08:00:00')


def test_run_stops_on_duration(tmp_path):
    clock = FakeClock()

    def take_sample(sample, now):
        clock.t += 1  # every sample takes 1s
        return [{'kind': 'probe'}]

    sink = CsvSink(str(tmp_path / 'soak.csv'))
    assert soak_probe.run(take_sample, sink, 10, duration=60, clock=clock.clock, sleep=clock.sleep) == 0
    assert len(read_csv(sink.path)) - 1 == 6
    assert clock.sleeps == [9.0] * 5


def test_run_stops_on_keyboard_interrupt(tmp_path):
    def sleep(seconds):
        raise KeyboardInterrupt

    sink = CsvSink(str(tmp_path / 'soak.csv'))
    assert soak_probe.run(lambda s, n: [{'kind': 'probe'}], sink, 10, sleep=sleep) == 0
    assert len(read_csv(sink.path)) == 2


# ---------------------------------------------------------------- smoke, real psutil

def test_smoke_real_psutil_target_dies(tmp_path):
    psutil = pytest.importorskip('psutil')
    child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])
    try:
        sampler = soak_probe.Sampler(
            psutil, log_dir=str(tmp_path), url='http://127.0.0.1:{}/'.format(closed_port()),
            port=22267, http_timeout=2, pinned=[child.pid])
        deadline = time.time() + 10
        pinned = []
        while time.time() < deadline:
            rows = sampler.take_sample(1, datetime.now())
            pinned = [r for r in rows if r.get('pid') == child.pid]
            if pinned and pinned[0].get('rss_mb'):
                break
            time.sleep(0.1)
        assert pinned and pinned[0]['role'] == 'pinned'
        assert pinned[0]['rss_mb'] > 0
        assert [r['kind'] for r in rows][-2:] == ['http', 'probe']
    finally:
        child.kill()
        child.wait()

    rows = sampler.take_sample(2, datetime.now())
    pinned = [r for r in rows if r.get('pid') == child.pid]
    assert len(pinned) == 1
    assert pinned[0]['status'] in ('missing', 'gone', 'zombie')
    assert not [r for r in rows if r['kind'] == 'error']


def test_main_once_writes_csv(tmp_path):
    pytest.importorskip('psutil')
    out = tmp_path / 'out' / 'soak.csv'
    root = tmp_path / 'root'
    (root / 'log').mkdir(parents=True)
    (root / 'log' / '2026-11-25_alas.txt').write_text('2026-11-25 08:00:00.000 | INFO | x\n', encoding='utf-8')
    code = soak_probe.main(['--once', '--out', str(out), '--alas-root', str(root), '--http-timeout', '2',
                            '--url', 'http://127.0.0.1:{}/'.format(closed_port())])
    assert code == 0
    rows = read_csv(str(out))
    assert rows[0] == list(COLUMNS)
    kinds = [row[COLUMNS.index('kind')] for row in rows[1:]]
    assert 'probe' in kinds and 'http' in kinds and 'log' in kinds
    assert all(len(row) == len(COLUMNS) for row in rows)


def test_parse_args_defaults():
    args = soak_probe.parse_args([])
    assert args.out == os.path.join(args.alas_root, 'log', 'soak.csv')
    assert args.interval == 60.0
    assert args.samples == 0
    assert soak_probe.parse_args(['--once']).samples == 1


def test_no_heavy_imports():
    code = (
        'import sys; sys.path.insert(0, {root!r}); import dev_tools.soak_probe; '
        'heavy = ("numpy", "cnocr", "mxnet", "adbutils", "rich", "module.logger", "module"); '
        'print(",".join(m for m in heavy if m in sys.modules))'
    ).format(root=ROOT)
    output = subprocess.check_output([sys.executable, '-c', code], cwd=ROOT).decode().strip()
    assert output == ''


def test_help_without_psutil():
    code = (
        'import sys; sys.modules["psutil"] = None; sys.path.insert(0, {root!r}); '
        'from dev_tools import soak_probe; sys.argv = ["soak_probe.py", "--help"]; soak_probe.main()'
    ).format(root=ROOT)
    result = subprocess.run([sys.executable, '-c', code], cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    assert result.returncode == 0
    assert b'soak probe' in result.stdout


def test_main_without_psutil_exits_2(monkeypatch, tmp_path):
    monkeypatch.setattr(soak_probe, 'psutil', None)
    assert soak_probe.main(['--once', '--out', str(tmp_path / 's.csv')]) == 2
