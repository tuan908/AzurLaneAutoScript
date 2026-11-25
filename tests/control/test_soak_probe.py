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


def snap(pid, ppid=None, name='python.exe', cmdline=None, create_time=1000.0, listen=(), files=(), status=''):
    return make_snapshot(pid, ppid, name, cmdline or ['python.exe'], create_time, listen, files, status)


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
    assert roles[105] == ('unknown', '', 100)
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


def test_http_row_factory_raises_anything():
    def factory(url, timeout, insecure):
        raise RuntimeError('boom')

    row = build_http_row('http://example.invalid/', factory=factory)
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


# ---------------------------------------------------------------- role memory

def counts_of(roles):
    return dict(kv.split('=') for kv in soak_probe.format_counts(roles).split(';'))


def drop_files(snaps):
    return [s._replace(open_files=[]) for s in snaps]


def test_memory_keeps_worker_when_handle_missed():
    memory = soak_probe.RoleMemory()
    classify(reload_tree(), 22267, memory=memory)
    # psutil omitted the handles this time, without raising
    roles = classify(drop_files(reload_tree()), 22267, memory=memory)
    assert roles[103] == ('worker', 'alas', 100)
    assert roles[104] == ('worker', 'alas2', 100)
    assert roles[102] == ('sync_manager', '', 100)
    assert counts_of(roles)['worker'] == '2'


def test_unidentified_child_is_unknown_not_worker():
    roles = classify(drop_files(reload_tree()), 22267)
    # Without handles and without memory: the manager slot is still the oldest child,
    # the rest cannot be told apart
    assert roles[102] == ('sync_manager', '', 100)
    for pid in (103, 104, 105):
        assert roles[pid] == ('unknown', '', 100)
    assert counts_of(roles)['unknown'] == '3'
    assert counts_of(roles)['worker'] == '0'


def test_dead_manager_is_not_replaced_by_ocr_child():
    memory = soak_probe.RoleMemory()
    roles = classify(reload_tree(), 22267, memory=memory)
    assert roles[102][0] == 'sync_manager'
    assert roles[105][0] == 'unknown'
    without_manager = [s for s in reload_tree() if s.pid != 102]
    roles = classify(without_manager, 22267, memory=memory)
    assert roles[105] == ('unknown', '', 100)
    assert counts_of(roles)['sync_manager'] == '0'


def test_manager_never_younger_than_a_worker():
    # Probe started after the manager died: the oldest remaining child is younger than a worker
    snaps = [s for s in reload_tree() if s.pid != 102]
    roles = classify(snaps, 22267)
    assert roles[105] == ('unknown', '', 100)
    assert counts_of(roles)['sync_manager'] == '0'


def test_memory_keeps_server_when_listener_hidden():
    snaps = [
        snap(100, 1, 'python.exe', ['python.exe', 'gui.py'], 1000.0, listen=[22267]),
        snap(102, 100, 'python.exe', spawn_cmd(), 1002.0),
        snap(103, 100, 'python.exe', spawn_cmd(), 1010.0, files=['log/2026-11-25_alas.txt']),
        snap(107, 103, 'python.exe', spawn_cmd(), 1030.0),
    ]
    memory = soak_probe.RoleMemory()
    assert classify(snaps, 22267, memory=memory)[100][0] == 'server'
    hidden = [s._replace(listen_ports=set()) for s in snaps]
    # Without memory the heuristic would pick 103, the python child that has children
    assert classify(hidden, 22267)[103][0] == 'server'
    roles = classify(hidden, 22267, memory=memory)
    assert roles[100][0] == 'server'
    assert roles[103] == ('worker', 'alas', 100)


def test_memory_ignores_reused_pid_and_prunes():
    memory = soak_probe.RoleMemory()
    classify(reload_tree(), 22267, memory=memory)
    assert (103, 1010.0) in memory.roles
    reused = [s._replace(create_time=1500.0, open_files=[]) if s.pid == 103 else s for s in reload_tree()]
    roles = classify(reused, 22267, memory=memory)
    assert roles[103] == ('unknown', '', 100)
    assert (103, 1010.0) not in memory.roles


def test_classify_uses_port_of_gui_command_line():
    snaps = [
        snap(100, 1, 'python.exe', ['python.exe', 'gui.py', '--port', '22367', '--electron'], 1000.0),
        snap(101, 100, 'python.exe', spawn_cmd(), 1001.0, listen=[22367]),
        snap(108, 100, 'python.exe', spawn_cmd(), 1001.5, listen=[22267]),
    ]
    roles = classify(snaps, 22267)
    assert roles[101][0] == 'server'
    assert roles[100][0] == 'gui_launcher'


# ---------------------------------------------------------------- open files helper

def test_handle_lookup_real_helper(tmp_path):
    pytest.importorskip('psutil')
    path = tmp_path / '2026-11-25_alas.txt'
    with open(str(path), 'w') as f:
        files, error = soak_probe.HandleLookup(timeout=30)([os.getpid()])
        assert error == ''
        assert any(os.path.basename(p) == path.name for p in files[os.getpid()])
        f.write('x')


def test_handle_lookup_hard_timeout_keeps_partial_results():
    command = [sys.executable, '-c',
               'import json, sys, time; '
               'print(json.dumps({"pid": int(sys.argv[1]), "files": ["log/2026-11-25_alas.txt"]})); '
               'sys.stdout.flush(); time.sleep(60)']
    start = time.monotonic()
    files, error = soak_probe.HandleLookup(timeout=1.0, command=command)([4242, 4343])
    assert time.monotonic() - start < 10
    assert files == {4242: ['log/2026-11-25_alas.txt']}
    assert 'timeout' in error


def test_handle_lookup_reports_failures():
    command = [sys.executable, '-c',
               'import json; print(json.dumps({"pid": 1, "error": "AccessDenied"}))']
    files, error = soak_probe.HandleLookup(timeout=10, command=command)([1])
    assert files == {}
    assert 'AccessDenied' in error


def test_helper_main_output(capsys):
    pytest.importorskip('psutil')
    assert soak_probe.main([soak_probe.HELPER_FLAG, str(os.getpid()), 'x']) == 0
    lines = capsys.readouterr().out.splitlines()
    assert len(lines) == 1
    assert '"pid": {}'.format(os.getpid()) in lines[0]


# ---------------------------------------------------------------- sampler wiring, fake psutil

Conn = namedtuple('Conn', ['status', 'laddr'])


class FakePsProc(WindowsProc):
    def __init__(self, s, **kwargs):
        super().__init__(**kwargs)
        self.pid = s.pid
        self.info = {'pid': s.pid, 'ppid': s.ppid, 'name': s.name, 'cmdline': s.cmdline,
                     'create_time': s.create_time, 'status': s.status or 'running'}
        self._listen = s.listen_ports

    def connections(self, kind='inet'):
        return [Conn('LISTEN', ('127.0.0.1', port)) for port in self._listen]


class FakePs:
    def __init__(self, snaps):
        self.snaps = snaps

    def process_iter(self, attrs=None):
        return [FakePsProc(s) for s in self.snaps]

    def Process(self):
        return FakeProc()


class FakeLookup:
    def __init__(self, snaps):
        self.files = {s.pid: list(s.open_files) for s in snaps}
        self.fail = False
        self.calls = []

    def __call__(self, pids):
        self.calls.append(sorted(pids))
        if self.fail:
            return {}, 'open_files helper: timeout after 5.0s'
        return {p: self.files.get(p, []) for p in pids}, ''


def sampler_for(snaps, tmp_path, **kwargs):
    lookup = FakeLookup(snaps)
    kwargs.setdefault('url', 'http://127.0.0.1:{}/'.format(closed_port()))
    sampler = soak_probe.Sampler(FakePs(snaps), log_dir=str(tmp_path), http_timeout=2, self_pid=999999,
                                 handle_lookup=lookup, **kwargs)
    return sampler, lookup


def test_sampler_lookup_timeout_keeps_roles(tmp_path):
    sampler, lookup = sampler_for(reload_tree(), tmp_path)
    rows = sampler.take_sample(1, datetime.now())
    assert lookup.calls == [[100, 101, 102, 103, 104, 105]]
    assert 'worker=2' in rows[-1]['counts']

    lookup.fail = True
    rows = sampler.take_sample(2, datetime.now())
    workers = [r for r in rows if r.get('role') == 'worker']
    assert sorted(r['instance'] for r in workers) == ['alas', 'alas2']
    assert 'worker=2' in rows[-1]['counts']
    errors = [r for r in rows if r['kind'] == 'error']
    assert errors and 'timeout' in errors[0]['error']


def test_sampler_redacts_password(tmp_path):
    snaps = reload_tree()
    snaps[1] = snaps[1]._replace(cmdline=['python.exe', 'gui.py', '-k', 'hunter2', '--electron'])
    sampler, _ = sampler_for(snaps, tmp_path)
    sink = CsvSink(str(tmp_path / 'soak.csv'))
    sink.write(sampler.take_sample(1, datetime.now()))
    with open(sink.path, encoding='utf-8') as f:
        text = f.read()
    assert 'hunter2' not in text
    assert 'gui.py -k *** --electron' in text


def test_sampler_endpoint_from_gui_command_line(tmp_path):
    snaps = reload_tree()
    snaps[1] = snaps[1]._replace(cmdline=['python.exe', 'gui.py', '--port', '22367', '--electron'])
    snaps[2] = snaps[2]._replace(listen_ports={22367})
    sampler, _ = sampler_for(snaps, tmp_path, url=None)
    url, port, insecure = sampler.endpoint(snaps, {'WebuiPort': 22999})
    assert (url, port, insecure) == ('http://127.0.0.1:22367/', 22367, False)
    rows = sampler.take_sample(1, datetime.now())
    assert [r for r in rows if r['kind'] == 'http'][0]['url'] == 'http://127.0.0.1:22367/'
    assert [r for r in rows if r.get('pid') == 101][0]['role'] == 'server'


def test_sampler_endpoint_from_deploy_and_override(tmp_path):
    root = tmp_path / 'alas'
    (root / 'config').mkdir(parents=True)
    (root / 'deploy').mkdir()
    (root / 'deploy' / 'template').write_text('    WebuiHost: 0.0.0.0\n    WebuiPort: 22267\n', encoding='utf-8')
    (root / 'config' / 'deploy.yaml').write_text(
        'Deploy:\n  Webui:\n    # WebuiPort: 1\n    WebuiPort: 22367\n    WebuiSSLKey: null\n', encoding='utf-8')
    sampler, _ = sampler_for([], tmp_path, url=None, alas_root=str(root))
    url, port, _ = sampler.endpoint([], sampler.deploy())
    assert (url, port) == ('http://127.0.0.1:22367/', 22367)
    rows = sampler.take_sample(1, datetime.now())
    assert [r for r in rows if r['kind'] == 'http'][0]['url'] == 'http://127.0.0.1:22367/'

    sampler, _ = sampler_for([], tmp_path, url='http://proxy:8080/', alas_root=str(root))
    url, port, _ = sampler.endpoint([], sampler.deploy())
    assert (url, port) == ('http://proxy:8080/', 22367)

    sampler, _ = sampler_for([], tmp_path, url=None, alas_root=str(tmp_path / 'empty'))
    assert sampler.endpoint([], sampler.deploy())[:2] == ('http://127.0.0.1:22267/', 22267)


# ---------------------------------------------------------------- endpoint parsing, redaction

@pytest.mark.parametrize('args, port', [
    (['--port', '22367'], 22367),
    (['--port=22367'], 22367),
    (['--po', '22367'], 22367),
    (['-p', '22367'], 22367),
    (['-p22367'], 22367),
    (['--port', 'abc'], None),
    (['--electron'], None),
])
def test_gui_options_port(args, port):
    assert soak_probe.gui_options(['python.exe', 'gui.py'] + args).get('port') == port


def test_resolve_endpoint():
    assert soak_probe.resolve_endpoint() == ('http://127.0.0.1:22267/', 22267, False)
    assert soak_probe.resolve_endpoint(
        ['gui.py', '--host', '0.0.0.0', '--port', '22367'])[:2] == ('http://127.0.0.1:22367/', 22367)
    assert soak_probe.resolve_endpoint(['gui.py', '--host', '::1'])[0] == 'http://[::1]:22267/'
    # Command line beats deploy settings
    deploy = {'WebuiHost': '192.168.1.2', 'WebuiPort': 22999}
    assert soak_probe.resolve_endpoint(['gui.py', '-p', '22367'], deploy)[0] == 'http://192.168.1.2:22367/'
    # SSL from deploy settings: https, certificate not verified
    deploy = {'WebuiPort': 22367, 'WebuiSSLKey': 'key.pem', 'WebuiSSLCert': 'cert.pem'}
    assert soak_probe.resolve_endpoint(None, deploy) == ('https://127.0.0.1:22367/', 22367, True)
    assert soak_probe.resolve_endpoint(None, {'WebuiSSLKey': 'key.pem'})[2] is False


def test_parse_deploy_text():
    text = '\n'.join([
        'Deploy:',
        '  Webui:',
        '    # WebuiPort: 1',
        '    WebuiHost: 0.0.0.0',
        "    WebuiPort: '22367'",
        '    WebuiSSLKey: null',
        '    Password: secret',
    ])
    assert soak_probe.parse_deploy_text(text) == {'WebuiHost': '0.0.0.0', 'WebuiPort': 22367, 'WebuiSSLKey': None}


@pytest.mark.parametrize('args, expected', [
    (['-k', 'pw'], ['-k', '***']),
    (['-kpw'], ['-k***']),
    (['--key', 'pw'], ['--key', '***']),
    (['--key=pw'], ['--key=***']),
    (['--ke=pw'], ['--ke=***']),
    (['--k', 'pw'], ['--k', '***']),
    (['--port', '22367', '--electron'], ['--port', '22367', '--electron']),
    (['--ssl-key', 'key.pem'], ['--ssl-key', 'key.pem']),
])
def test_redact_cmdline(args, expected):
    assert soak_probe.redact_cmdline(['python.exe', 'gui.py'] + args) == ['python.exe', 'gui.py'] + expected


def test_redaction_only_for_python_and_before_truncation():
    row = build_proc_row(FakeProc(), snap(1, name='ssh.exe', cmdline=['ssh.exe', '-k', 'host']), 'descendant')
    assert row['cmdline'] == 'ssh.exe -k host'
    long_pw = 'p' * 1000
    row = build_proc_row(FakeProc(), snap(2, cmdline=['python.exe', 'gui.py', '--key=' + long_pw]), 'gui_launcher')
    assert row['cmdline'] == 'python.exe gui.py --key=***'


# ---------------------------------------------------------------- http deadline

def trickle_server(header_delay, body_chunks, chunk_delay):
    """
    Raw HTTP server: sends the status line byte by byte with header_delay
    between bytes, then body_chunks bytes one at a time with chunk_delay.
    """
    sock = socket.socket()
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(('127.0.0.1', 0))
    sock.listen(5)
    stop = threading.Event()

    def serve():
        sock.settimeout(0.2)
        while not stop.is_set():
            try:
                conn, _ = sock.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            try:
                conn.recv(65536)
                head = 'HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n'.format(body_chunks).encode()
                if header_delay:
                    for i in range(len(head)):
                        if stop.is_set():
                            break
                        conn.sendall(head[i:i + 1])
                        time.sleep(header_delay)
                else:
                    conn.sendall(head)
                for _ in range(body_chunks):
                    if stop.is_set():
                        break
                    conn.sendall(b'x')
                    time.sleep(chunk_delay)
            except OSError:
                pass
            finally:
                conn.close()

    thread = threading.Thread(target=serve, daemon=True)
    thread.start()
    return sock, stop, 'http://127.0.0.1:{}/'.format(sock.getsockname()[1])


def test_http_status_at_headers_ignores_slow_body():
    sock, stop, url = trickle_server(0, body_chunks=50, chunk_delay=0.1)
    try:
        start = time.monotonic()
        row = build_http_row(url, timeout=0.5)
        elapsed = time.monotonic() - start
    finally:
        stop.set()
        sock.close()
    assert row['http_status'] == 200
    assert 'error' not in row
    assert elapsed < 0.5
    assert row['latency_ms'] < 500


def test_http_overall_deadline_on_slow_headers():
    sock, stop, url = trickle_server(0.1, body_chunks=0, chunk_delay=0)
    try:
        start = time.monotonic()
        row = build_http_row(url, timeout=0.5)
        elapsed = time.monotonic() - start
    finally:
        stop.set()
        sock.close()
    assert 'http_status' not in row
    assert row['error'].startswith('Timeout')
    assert elapsed < 1.0


# ---------------------------------------------------------------- exit status

class FlakySink(CsvSink):
    def __init__(self, path, failures):
        super().__init__(path)
        self.failures = failures

    def write(self, rows):
        if self.failures > 0:
            self.failures -= 1
            self.pending.extend(rows)
            return False
        return super().write(rows)


def test_run_fails_when_rows_stay_unwritten(tmp_path):
    sink = FlakySink(str(tmp_path / 'soak.csv'), failures=100)
    clock = FakeClock()
    code = soak_probe.run(lambda s, n: [{'kind': 'probe'}], sink, 10, samples=2,
                          clock=clock.clock, sleep=clock.sleep)
    assert code == 1
    assert len(sink.pending) == 2
    # One interval, then two pauses between the three final attempts
    assert clock.sleeps == [10, 1.0, 1.0]


def test_run_retries_pending_rows(tmp_path):
    # First sample fails to write, second sample writes both
    sink = FlakySink(str(tmp_path / 'soak.csv'), failures=1)
    clock = FakeClock()
    code = soak_probe.run(lambda s, n: [{'kind': 'probe'}], sink, 10, samples=2,
                          clock=clock.clock, sleep=clock.sleep)
    assert code == 0
    assert [row[COLUMNS.index('sample')] for row in read_csv(sink.path)[1:]] == ['1', '2']

    # Last sample fails, final retry succeeds
    sink = FlakySink(str(tmp_path / 'soak2.csv'), failures=1)
    assert soak_probe.run(lambda s, n: [{'kind': 'probe'}], sink, 10, samples=1, sleep=clock.sleep) == 0
    assert len(read_csv(sink.path)) == 2


def test_main_unwritable_output_exits_1(tmp_path):
    pytest.importorskip('psutil')
    blocker = tmp_path / 'file'
    blocker.write_text('x', encoding='utf-8')
    code = soak_probe.main(['--once', '--out', str(blocker / 'soak.csv'), '--alas-root', str(tmp_path),
                            '--http-timeout', '1', '--url', 'http://127.0.0.1:{}/'.format(closed_port())])
    assert code == 1


# ---------------------------------------------------------------- orphans after server exit

def test_server_exit_keeps_orphans_and_launcher():
    memory = soak_probe.RoleMemory()
    classify(reload_tree(), 22267, memory=memory)
    # Server 101 exits; its children keep ppid=101 (Windows) and leave the tree
    without_server = [s for s in reload_tree() if s.pid != 101]
    roles = classify(without_server, 22267, memory=memory)
    assert roles[100] == ('gui_launcher', '', 100)
    assert roles[102] == ('sync_manager', '', 100)
    assert roles[103] == ('worker', 'alas', 100)
    assert roles[104] == ('worker', 'alas2', 100)
    assert roles[105] == ('unknown', '', 100)
    assert memory.orphans == {102, 103, 104, 105}
    counts = dict(kv.split('=') for kv in soak_probe.format_counts(roles, memory.orphans).split(';'))
    assert counts['server'] == '0'
    assert counts['sync_manager'] == '1'
    assert counts['worker'] == '2'
    assert counts['orphan'] == '4'

    # Linux: orphans are re-parented to init, same answer
    reparented = [s._replace(ppid=1) if s.pid in (102, 103, 104, 105) else s for s in without_server]
    roles = classify(reparented, 22267, memory=memory)
    assert roles[103] == ('worker', 'alas', 100)
    assert roles[100][0] == 'gui_launcher'

    # Reload: the launcher starts a new server, old processes stay orphans
    restarted = without_server + [snap(201, 100, 'python.exe', spawn_cmd(), 2000.0, listen=[22267])]
    roles = classify(restarted, 22267, memory=memory)
    assert roles[201] == ('server', '', 100)
    assert roles[103] == ('worker', 'alas', 100)
    assert 103 in memory.orphans
    assert 201 not in memory.orphans


def test_orphans_forgotten_when_they_exit():
    memory = soak_probe.RoleMemory()
    classify(reload_tree(), 22267, memory=memory)
    roles = classify([s for s in reload_tree() if s.pid not in (101, 103)], 22267, memory=memory)
    assert 103 not in roles
    assert (103, 1010.0) not in memory.roles
    assert (100, 1000.0) in memory.tree_servers


def test_sampler_marks_orphan_rows(tmp_path):
    snaps = reload_tree()
    sampler, _ = sampler_for(snaps, tmp_path)
    sampler.take_sample(1, datetime.now())
    sampler.ps.snaps = [s for s in snaps if s.pid != 101]
    rows = sampler.take_sample(2, datetime.now())
    by_pid = {r['pid']: r for r in rows if r['kind'] == 'proc'}
    assert by_pid[103]['role'] == 'worker'
    assert by_pid[103]['orphan'] == 1
    assert by_pid[100]['role'] == 'gui_launcher'
    assert by_pid[100]['orphan'] == ''
    assert 'server=0' in rows[-1]['counts']
    assert 'orphan=4' in rows[-1]['counts']


# ---------------------------------------------------------------- partial writes, drops

class HalfFile:
    """Writes half of the text, then fails like a full disk"""

    def __init__(self, f):
        self.f = f

    def write(self, text):
        self.f.write(text[:len(text) // 2])
        self.f.flush()
        raise OSError(28, 'No space left on device')

    def flush(self):
        self.f.flush()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.f.close()


def patch_append(monkeypatch, wrap):
    real_open = open

    def fake_open(file, mode='r', *args, **kwargs):
        f = real_open(file, mode, *args, **kwargs)
        if 'a' in mode:
            return wrap(f)
        return f

    monkeypatch.setattr('builtins.open', fake_open)
    return real_open


def test_csv_partial_write_is_cut_back(tmp_path, monkeypatch):
    path = str(tmp_path / 'soak.csv')
    sink = CsvSink(path)
    assert sink.write([{'kind': 'probe', 'sample': 1}])
    good_size = os.path.getsize(path)

    real_open = patch_append(monkeypatch, HalfFile)
    assert not sink.write([{'kind': 'probe', 'sample': 2, 'cmdline': 'x' * 200}])
    monkeypatch.setattr('builtins.open', real_open)
    assert os.path.getsize(path) == good_size

    assert sink.write([{'kind': 'probe', 'sample': 3}])
    rows = read_csv(path)
    assert all(len(row) == len(COLUMNS) for row in rows)
    assert [row[COLUMNS.index('sample')] for row in rows[1:]] == ['1', '2', '3']
    assert sink.ok


class HalfFileInterrupted(HalfFile):
    """Writes half of the text, then gets Ctrl+C"""

    def write(self, text):
        self.f.write(text[:len(text) // 2])
        self.f.flush()
        raise KeyboardInterrupt


def test_csv_keyboard_interrupt_mid_write_is_cut_back(tmp_path, monkeypatch):
    path = str(tmp_path / 'soak.csv')
    sink = CsvSink(path)
    assert sink.write([{'kind': 'probe', 'sample': 1}])
    good_size = os.path.getsize(path)

    real_open = patch_append(monkeypatch, HalfFileInterrupted)
    with pytest.raises(KeyboardInterrupt):
        sink.write([{'kind': 'probe', 'sample': 2, 'cmdline': 'x' * 200}])
    monkeypatch.setattr('builtins.open', real_open)
    assert os.path.getsize(path) == good_size

    # The shutdown retry rewrites the pending rows on a clean tail
    assert sink.write([])
    rows = read_csv(path)
    assert all(len(row) == len(COLUMNS) for row in rows)
    assert [row[COLUMNS.index('sample')] for row in rows[1:]] == ['1', '2']
    assert sink.ok


def test_csv_no_append_while_tail_cannot_be_repaired(tmp_path, monkeypatch):
    path = str(tmp_path / 'soak.csv')
    sink = CsvSink(path)
    assert sink.write([{'kind': 'probe', 'sample': 1}])
    good_size = os.path.getsize(path)

    def no_truncate(*args):
        raise PermissionError('locked')

    monkeypatch.setattr(os, 'truncate', no_truncate)
    real_open = patch_append(monkeypatch, HalfFile)
    assert not sink.write([{'kind': 'probe', 'sample': 2}])
    monkeypatch.setattr('builtins.open', real_open)
    damaged_size = os.path.getsize(path)
    assert damaged_size > good_size
    # Damaged tail still there: refuse to append after it
    assert not sink.write([{'kind': 'probe', 'sample': 3}])
    assert os.path.getsize(path) == damaged_size
    assert not sink.ok

    clock = FakeClock()
    assert soak_probe.run(lambda s, n: [], sink, 10, samples=1, clock=clock.clock, sleep=clock.sleep) == 1

    monkeypatch.undo()
    assert sink.write([])
    rows = read_csv(path)
    assert all(len(row) == len(COLUMNS) for row in rows)
    assert [row[COLUMNS.index('sample')] for row in rows[1:]] == ['1', '2', '3']


def test_dropped_rows_fail_the_run(tmp_path, monkeypatch):
    path = str(tmp_path / 'soak.csv')
    sink = CsvSink(path, max_pending=2)
    locked = {'on': False}
    real_open = open

    def fake_open(file, mode='r', *args, **kwargs):
        if locked['on'] and 'a' in mode:
            raise PermissionError('locked')
        return real_open(file, mode, *args, **kwargs)

    monkeypatch.setattr('builtins.open', fake_open)

    def take_sample(sample, now):
        locked['on'] = sample <= 3
        return [{'kind': 'probe'}]

    clock = FakeClock()
    code = soak_probe.run(take_sample, sink, 10, samples=4, clock=clock.clock, sleep=clock.sleep)
    monkeypatch.setattr('builtins.open', real_open)
    assert code == 1
    assert sink.dropped == 2
    rows = read_csv(path)
    kinds = [row[COLUMNS.index('kind')] for row in rows[1:]]
    samples = [row[COLUMNS.index('sample')] for row in rows[1:]]
    assert kinds == ['probe', 'probe', 'error']
    assert samples == ['3', '4', '4']
    assert '2 rows dropped' in rows[-1][COLUMNS.index('error')]


# ---------------------------------------------------------------- helper isolation

STALL_HELPER = [sys.executable, '-c',
                'import json, sys, time\n'
                'for arg in sys.argv[1:]:\n'
                '    if arg == "4242":\n'
                '        time.sleep(60)\n'
                '    print(json.dumps({"pid": int(arg), "files": ["log/2026-11-25_" + arg + ".txt"]}))\n'
                '    sys.stdout.flush()\n']


def test_handle_lookup_isolates_stuck_pid():
    lookup = soak_probe.HandleLookup(timeout=1.0, command=STALL_HELPER)
    files, error = lookup([4343, 4242])
    # 4242 sorts first and stalls the batch
    assert files == {}
    assert 'at pid 4242' in error
    assert lookup.suspects == {4242}

    start = time.monotonic()
    files, error = lookup([4343, 4242])
    assert time.monotonic() - start < 5
    assert files == {4343: ['log/2026-11-25_4343.txt']}
    assert 'at pid 4242' in error

    files, error = lookup([4343])
    assert files == {4343: ['log/2026-11-25_4343.txt']}
    assert error == ''
    assert lookup.suspects == set()


# ---------------------------------------------------------------- bounded http threads

def http_threads():
    return [t for t in threading.enumerate() if t.name == 'soak-probe-http' and t.is_alive()]


def test_http_checker_keeps_one_stuck_request():
    release = threading.Event()

    def factory(url, timeout, insecure):
        # Like getaddrinfo: blocked before any socket exists, cannot be aborted
        release.wait(30)
        raise RuntimeError('resolver back')

    checker = soak_probe.HttpChecker(factory=factory)
    before = len(http_threads())
    row = checker.check('http://alas.invalid/', timeout=0.2)
    assert row['error'].startswith('Timeout')
    for _ in range(3):
        row = checker.check('http://alas.invalid/', timeout=0.2)
        assert row['error'].startswith('Skipped: previous request still running')
    assert len(http_threads()) - before == 1

    release.set()
    checker.pending[0].join(5)
    row = checker.check('http://alas.invalid/', timeout=2)
    assert row['error'] == 'RuntimeError: resolver back'
    assert len(http_threads()) == before


# ---------------------------------------------------------------- ipv6

def test_resolve_endpoint_ipv6_wildcard():
    assert soak_probe.resolve_endpoint(['gui.py', '--host', '::'])[0] == 'http://[::1]:22267/'
    assert soak_probe.resolve_endpoint(None, {'WebuiHost': '::', 'WebuiPort': 22367})[0] == 'http://[::1]:22367/'
    assert soak_probe.resolve_endpoint(['gui.py', '--host', '0.0.0.0'])[0] == 'http://127.0.0.1:22267/'


def test_http_row_ipv6_only_listener():
    if not socket.has_ipv6:
        pytest.skip('no IPv6')

    class Server6(HTTPServer):
        address_family = socket.AF_INET6

    try:
        server = Server6(('::1', 0), _Handler)
    except OSError:
        pytest.skip('cannot bind ::1')
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        url = soak_probe.resolve_endpoint(['gui.py', '--host', '::', '--port', str(server.server_address[1])])[0]
        row = build_http_row(url, timeout=5)
    finally:
        server.shutdown()
        server.server_close()
    assert row['http_status'] == 200


# ---------------------------------------------------------------- zombies, trackers, no-child fallback

def test_zombie_server_does_not_count_as_server():
    memory = soak_probe.RoleMemory()
    classify(reload_tree(), 22267, memory=memory)
    # POSIX: killed server stays as a zombie until gui.py reaps it
    zombie = [s._replace(status='zombie', listen_ports=set()) if s.pid == 101 else s for s in reload_tree()]
    zombie = [s._replace(ppid=1) if s.ppid == 101 else s for s in zombie]
    roles = classify(zombie, 22267, memory=memory)
    assert roles[101] == ('zombie', 'server', 100)
    assert roles[100] == ('gui_launcher', '', 100)
    assert roles[103] == ('worker', 'alas', 100)
    counts = dict(kv.split('=') for kv in soak_probe.format_counts(roles, memory.orphans).split(';'))
    assert counts['server'] == '0'
    assert counts['zombie'] == '1'


def test_unrelated_zombies_are_not_reported():
    roles = classify([snap(500, 1, 'bash', ['bash'], 1000.0, status='zombie')], 22267)
    assert roles == {}


def test_gui_without_live_child_is_not_server():
    # gui.py whose spawned server died (zombie) before the probe started; only the tracker is left
    snaps = [
        snap(100, 1, 'python3', ['python3', 'gui.py', '--port', '22997'], 1000.0),
        snap(101, 100, 'python3', ['/usr/bin/python3', '-c',
                                   'from multiprocessing.resource_tracker import main;main(3)'], 1000.5),
        snap(102, 100, 'python3', spawn_cmd(), 1001.0, status='zombie'),
    ]
    roles = classify(snaps, 22267)
    assert roles[100] == ('gui_launcher', '', 100)
    assert roles[101] == ('python_descendant', '', 100)
    assert roles[102] == ('zombie', '', 100)
    assert 'server' not in {r for r, _, _ in roles.values()}


def test_tracker_is_never_sync_manager():
    snaps = [
        snap(100, 1, 'python3', ['python3', 'gui.py'], 1000.0, listen=[22267]),
        snap(101, 100, 'python3', ['python3', '-c', 'from multiprocessing.resource_tracker import main;main(3)'],
             1000.5),
        snap(102, 100, 'python3', spawn_cmd(), 1001.0),
    ]
    roles = classify(snaps, 22267)
    assert roles[101] == ('python_descendant', '', 100)
    assert roles[102] == ('sync_manager', '', 100)
