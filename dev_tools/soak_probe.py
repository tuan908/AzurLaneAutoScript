"""
Soak probe for the ALAS reliability baseline (modernization slice P0.1).

Every ``--interval`` seconds, append rows to one CSV file describing:

- ``proc``  one row per process of interest: the gui.py launcher, the uvicorn
  server, the multiprocessing SyncManager, every ALAS worker (with its instance
  name), Electron main / renderer / other processes, MuMu processes, plus any
  ``--extra-pattern`` / ``--pid`` targets. Columns: RSS, VMS, threads, handles
  (Windows) or fds (POSIX), CPU percent since the previous sample.
- ``log``   the most recently written ``log/*.txt`` files: size, mtime age, and
  timestamp of the last timestamped line.
- ``http``  status and latency of ``GET --url`` (the GUI).
- ``probe`` the probe itself: RSS, how long the sample took, and role counts
  (``server=1;sync_manager=1;worker=2;...``) so a vanished process is visible
  even though it has no row any more.
- ``error`` anything that went wrong while sampling. The probe never stops
  because a target process died or a call failed.

Only the standard library and psutil are used, and nothing from ``module.`` is
imported, so the probe can run next to a running ALAS with the bundled Python 3.7:

    toolkit\\python.exe dev_tools\\soak_probe.py --out log\\soak.csv --interval 60

Short check run (10 minutes, every 10 s):

    toolkit\\python.exe dev_tools\\soak_probe.py --duration 600 --interval 10

Notes:
- Roles of the python children are best-effort guesses (on Windows all
  multiprocessing children share the same command line). pid, ppid,
  create_time and cmdline are always written so the analysis can re-classify.
- MuMu may run elevated; metrics then come back blank with error=AccessDenied.
  Run the probe from an elevated prompt if those are needed.
- At 60 s per sample a 72h run is ~100k rows (~20-30 MB).
- If the CSV is locked (e.g. opened in Excel), rows are kept in memory and
  written on the next successful sample.
"""
import argparse
import csv
import fnmatch
import os
import re
import ssl
import sys
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter, namedtuple
from datetime import datetime

try:
    import psutil
except ImportError:  # pragma: no cover - checked in main()
    psutil = None

COLUMNS = (
    'ts', 'sample', 'kind', 'role', 'instance', 'tree',
    'pid', 'ppid', 'name', 'status', 'create_time',
    'rss_mb', 'vms_mb', 'threads', 'handles', 'fds', 'cpu_pct', 'cmdline',
    'path', 'size_bytes', 'mtime_age_s', 'last_line_ts', 'last_line_age_s',
    'url', 'http_status', 'latency_ms',
    'counts', 'sample_ms', 'error',
)

# Order of the proc rows inside one sample, and roles always present in counts
ROLE_ORDER = (
    'gui_launcher', 'server', 'sync_manager', 'worker', 'python_child', 'python_descendant',
    'descendant', 'electron_main', 'electron_renderer', 'electron_other', 'mumu', 'extra', 'pinned',
)
COUNTED_ROLES = ('server', 'sync_manager', 'worker', 'electron_main', 'electron_renderer', 'mumu')

DEFAULT_ELECTRON_NAMES = ('alas.exe', 'electron.exe')
DEFAULT_MUMU_PATTERNS = ('MuMuPlayer*', 'MuMuVMMHeadless*')
DEFAULT_URL = 'http://127.0.0.1:22267/'

GONE_ERRORS = ('NoSuchProcess', 'ZombieProcess')
CMDLINE_MAX = 300
ERROR_MAX = 300
PENDING_MAX = 20000
TAIL_BYTES = 64 * 1024

# ALAS file_formatter: '%(asctime)s.%(msecs)03d | %(levelname)s | %(message)s'
LOG_LINE_RE = re.compile(r'^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\.(\d{3}) \|')
# module/logger.py: f'./log/{datetime.date.today()}_{name}.txt'
LOG_NAME_RE = re.compile(r'^\d{4}-\d{2}-\d{2}_(.+)\.txt$')

ProcSnapshot = namedtuple(
    'ProcSnapshot', ['pid', 'ppid', 'name', 'cmdline', 'create_time', 'listen_ports', 'open_files'])


def make_snapshot(pid, ppid=None, name='', cmdline=None, create_time=0.0, listen_ports=(), open_files=()):
    return ProcSnapshot(pid, ppid, name or '', list(cmdline or []), create_time or 0.0,
                        set(listen_ports), list(open_files))


# ---------------------------------------------------------------- helpers

def safe(obj, attr, *args, **kwargs):
    """
    Call ``obj.attr(*args, **kwargs)`` without ever raising.

    Returns:
        tuple: (value, error_name). (None, None) if the method does not exist
            on this platform, (None, 'NoSuchProcess') etc. if it raised.
    """
    func = getattr(obj, attr, None)
    if func is None:
        return None, None
    try:
        return func(*args, **kwargs), None
    except Exception as e:
        return None, type(e).__name__


def short(text, limit=ERROR_MAX):
    text = str(text).replace('\r', ' ').replace('\n', ' ')
    if len(text) > limit:
        text = text[:limit - 3] + '...'
    return text


def describe_exception(e):
    tb = traceback.extract_tb(e.__traceback__)
    where = ''
    if tb:
        frame = tb[-1]
        where = ' at {}:{}'.format(os.path.basename(frame.filename), frame.lineno)
    return short('{}: {}{}'.format(type(e).__name__, e, where))


def iso_local(dt):
    """Local time with UTC offset, e.g. 2026-11-25T08:00:00+07:00"""
    try:
        return dt.astimezone().isoformat(timespec='seconds')
    except (OSError, ValueError, OverflowError):
        return dt.isoformat(timespec='seconds')


def iso_from_timestamp(ts):
    if not ts:
        return ''
    try:
        return datetime.fromtimestamp(ts).isoformat(timespec='seconds')
    except (OSError, ValueError, OverflowError):
        return ''


def mb(value):
    return round(value / 1048576, 1)


def is_python(name):
    return (name or '').lower().startswith('python')


def is_gui_command(snap):
    """A python process running gui.py that is not a multiprocessing child"""
    if not is_python(snap.name):
        return False
    if '--multiprocessing-fork' in snap.cmdline:
        return False
    for arg in snap.cmdline[1:]:
        if 'soak_probe' in arg:
            return False
    for arg in snap.cmdline[1:]:
        if re.split(r'[\\/]', arg)[-1] == 'gui.py':
            return True
    return False


def is_probe_command(snap):
    return any('soak_probe' in arg for arg in snap.cmdline)


def instance_from_log_path(path):
    """'log/2026-11-25_alas.txt' -> 'alas', None if not an ALAS log file"""
    match = LOG_NAME_RE.match(re.split(r'[\\/]', str(path))[-1])
    if match:
        return match.group(1)
    return None


# ---------------------------------------------------------------- classify

def _children_map(snapshots):
    by_pid = {s.pid: s for s in snapshots}
    children = {}
    for s in snapshots:
        parent = by_pid.get(s.ppid)
        if parent is None or s.ppid == s.pid:
            continue
        # A reused parent pid is younger than its "child", ignore such links
        if parent.create_time and s.create_time and s.create_time + 1 < parent.create_time:
            continue
        children.setdefault(s.ppid, []).append(s)
    for value in children.values():
        value.sort(key=lambda x: (x.create_time, x.pid))
    return children


def _descendants(pid, children):
    """Breadth-first, as list of (snapshot, depth)"""
    result = []
    queue = [(c, 1) for c in children.get(pid, [])]
    seen = {pid}
    while queue:
        snap, depth = queue.pop(0)
        if snap.pid in seen:
            continue
        seen.add(snap.pid)
        result.append((snap, depth))
        queue.extend((c, depth + 1) for c in children.get(snap.pid, []))
    return result


def gui_trees(snapshots, self_pid=None):
    """
    Returns:
        list[tuple]: (root_snapshot, [(descendant_snapshot, depth), ...]) per gui.py tree.
            On fork platforms children of gui.py also look like gui.py, so a
            candidate already inside a tree is not a new root.
    """
    children = _children_map(snapshots)
    candidates = sorted(
        (s for s in snapshots if s.pid != self_pid and is_gui_command(s)),
        key=lambda x: (x.create_time, x.pid))
    assigned = set()
    trees = []
    for root in candidates:
        if root.pid in assigned:
            continue
        members = [(d, depth) for d, depth in _descendants(root.pid, children)
                   if d.pid != self_pid and not is_probe_command(d)]
        assigned.add(root.pid)
        assigned.update(d.pid for d, _ in members)
        trees.append((root, members))
    return trees


def tree_python_pids(snapshots, self_pid=None):
    pids = set()
    for root, members in gui_trees(snapshots, self_pid):
        pids.add(root.pid)
        pids.update(d.pid for d, _ in members if is_python(d.name))
    return pids


def _find_server(root, members, port, children):
    python_members = [root] + [d for d, _ in members if is_python(d.name)]
    for snap in python_members:
        if port in snap.listen_ports:
            return snap
    # No listener visible (AccessDenied, or not listening yet):
    # with EnableReload the server is the launcher's child that has children itself
    for child in children.get(root.pid, []):
        if is_python(child.name) and any(is_python(c.name) for c in children.get(child.pid, [])):
            return child
    return root


def classify(snapshots, port, electron_names=DEFAULT_ELECTRON_NAMES, mumu_patterns=DEFAULT_MUMU_PATTERNS,
             extra_patterns=(), pinned=(), self_pid=None):
    """
    Args:
        snapshots (list[ProcSnapshot]):
        port (int): GUI port, the process listening on it is the server.
        electron_names (iterable[str]): Exact process names of Electron, case-insensitive.
        mumu_patterns (iterable[str]): fnmatch patterns of MuMu process names, case-insensitive.
        extra_patterns (iterable[str]): fnmatch patterns of other processes to watch.
        pinned (iterable[int]): pids to watch whatever they are.
        self_pid (int): pid of the probe, never reported.

    Returns:
        dict[int, tuple]: pid -> (role, instance, tree_root_pid or '')
    """
    roles = {}
    children = _children_map(snapshots)

    for root, members in gui_trees(snapshots, self_pid):
        tree = root.pid
        server = _find_server(root, members, port, children)
        roles[root.pid] = ('gui_launcher', '', tree)
        for snap, _ in members:
            roles[snap.pid] = ('python_descendant' if is_python(snap.name) else 'descendant', '', tree)
        roles[server.pid] = ('server', '', tree)

        others = []
        for child in children.get(server.pid, []):
            if child.pid not in roles or not is_python(child.name):
                continue
            instances = sorted({
                name for name in (instance_from_log_path(f) for f in child.open_files)
                if name and name != 'gui'})
            if instances:
                roles[child.pid] = ('worker', instances[0], tree)
            else:
                others.append(child)
        # SyncManager is the first child, created by State.init() in app startup
        for index, child in enumerate(others):
            roles[child.pid] = ('sync_manager' if index == 0 else 'python_child', '', tree)

    electron_names = {n.lower() for n in electron_names}
    mumu_patterns = [p.lower() for p in mumu_patterns]
    extra_patterns = [p.lower() for p in extra_patterns]
    pinned = set(pinned)
    for snap in snapshots:
        if snap.pid in roles or snap.pid == self_pid:
            continue
        name = snap.name.lower()
        if name in electron_names:
            process_type = ''
            for arg in snap.cmdline:
                if arg.startswith('--type='):
                    process_type = arg[len('--type='):]
                    break
            if not process_type:
                roles[snap.pid] = ('electron_main', '', '')
            elif process_type == 'renderer':
                roles[snap.pid] = ('electron_renderer', '', '')
            else:
                roles[snap.pid] = ('electron_other', process_type, '')
        elif any(fnmatch.fnmatchcase(name, p) for p in mumu_patterns):
            roles[snap.pid] = ('mumu', '', '')
        elif any(fnmatch.fnmatchcase(name, p) for p in extra_patterns):
            roles[snap.pid] = ('extra', '', '')
        elif snap.pid in pinned:
            roles[snap.pid] = ('pinned', '', '')
    return roles


def format_counts(roles):
    counter = Counter(role for role, _, _ in roles.values())
    keys = list(COUNTED_ROLES) + sorted(k for k in counter if k not in COUNTED_ROLES)
    return ';'.join('{}={}'.format(k, counter.get(k, 0)) for k in keys)


# ---------------------------------------------------------------- rows

class CpuCache:
    """
    Keep one psutil.Process per (pid, create_time) so cpu_percent() measures
    the time since the previous sample, and a reused pid is a new process.
    """

    def __init__(self):
        self.procs = {}

    def get(self, key, proc):
        """
        Returns:
            tuple: (process object to use, first_seen)
        """
        cached = self.procs.get(key)
        if cached is not None:
            return cached, False
        self.procs[key] = proc
        return proc, True

    def prune(self, keys):
        keys = set(keys)
        for key in list(self.procs):
            if key not in keys:
                del self.procs[key]


def build_proc_row(proc, snap, role, instance='', tree='', cpu_cache=None):
    """
    Args:
        proc: psutil.Process-like object, every call may raise.
        snap (ProcSnapshot):
        role (str):
        instance (str):
        tree (int, str):
        cpu_cache (CpuCache):

    Returns:
        dict:
    """
    first_seen = True
    if cpu_cache is not None:
        proc, first_seen = cpu_cache.get((snap.pid, snap.create_time), proc)

    errors = []

    def call(attr, *args, **kwargs):
        value, error = safe(proc, attr, *args, **kwargs)
        if error:
            errors.append((attr, error))
        return value

    row = {
        'kind': 'proc', 'role': role, 'instance': instance, 'tree': tree,
        'pid': snap.pid, 'ppid': '' if snap.ppid is None else snap.ppid,
        'name': snap.name, 'create_time': iso_from_timestamp(snap.create_time),
        'cmdline': short(' '.join(snap.cmdline), CMDLINE_MAX),
    }
    memory = call('memory_info')
    if memory is not None:
        row['rss_mb'] = mb(memory.rss)
        row['vms_mb'] = mb(memory.vms)
    threads = call('num_threads')
    if threads is not None:
        row['threads'] = threads
    handles = call('num_handles')
    if handles is not None:
        row['handles'] = handles
    fds = call('num_fds')
    if fds is not None:
        row['fds'] = fds
    cpu = call('cpu_percent', interval=None)
    if cpu is not None and not first_seen:
        row['cpu_pct'] = round(cpu, 1)
    status = call('status')

    if any(error in GONE_ERRORS for _, error in errors):
        row['status'] = 'gone'
    elif status is not None:
        row['status'] = status
    if errors:
        row['error'] = short(';'.join('{}:{}'.format(attr, error) for attr, error in errors))
    return row


def read_tail(path, nbytes=TAIL_BYTES):
    with open(path, 'rb') as f:
        f.seek(0, os.SEEK_END)
        size = f.tell()
        f.seek(max(0, size - nbytes))
        return f.read().decode('utf-8', errors='replace')


def parse_last_log_timestamp(text):
    """
    Returns:
        datetime: Timestamp of the last line written by the ALAS file formatter,
            or None. Wrapped lines and tracebacks have no timestamp and are skipped.
    """
    for line in reversed(text.splitlines()):
        match = LOG_LINE_RE.match(line)
        if match:
            try:
                ts = datetime.strptime(match.group(1), '%Y-%m-%d %H:%M:%S')
            except ValueError:
                continue
            return ts.replace(microsecond=int(match.group(2)) * 1000)
    return None


def build_log_rows(log_dir, now, window_s=48 * 3600, limit=10):
    """
    Args:
        log_dir (str): ALAS log folder.
        now (datetime): Naive local time.
        window_s (float): Only files modified within this many seconds.
        limit (int): Maximum number of files, newest first.

    Returns:
        list[dict]:
    """
    if not os.path.isdir(log_dir):
        return []
    wall = now.timestamp()
    files = []
    for name in os.listdir(log_dir):
        if not name.lower().endswith('.txt'):
            continue
        path = os.path.join(log_dir, name)
        try:
            stat = os.stat(path)
        except OSError:
            continue
        if wall - stat.st_mtime <= window_s:
            files.append((stat.st_mtime, stat.st_size, name, path))
    files.sort(key=lambda x: (-x[0], x[2]))

    rows = []
    for mtime, size, name, path in files[:limit]:
        row = {
            'kind': 'log', 'instance': instance_from_log_path(name) or '',
            'path': path, 'size_bytes': size, 'mtime_age_s': round(wall - mtime, 1),
        }
        try:
            last = parse_last_log_timestamp(read_tail(path))
        except OSError as e:
            row['error'] = describe_exception(e)
            last = None
        if last is not None:
            row['last_line_ts'] = last.isoformat(timespec='milliseconds')
            row['last_line_age_s'] = round((now - last).total_seconds(), 1)
        rows.append(row)
    return rows


def build_http_row(url, timeout=10.0, insecure=False, opener=None, clock=time.monotonic):
    """
    GET the GUI. Never raises.

    Returns:
        dict:
    """
    if opener is None:
        opener = urllib.request.urlopen
    kwargs = {'timeout': timeout}
    if insecure and url.lower().startswith('https'):
        kwargs['context'] = ssl._create_unverified_context()
    row = {'kind': 'http', 'url': url}
    start = clock()
    try:
        response = opener(url, **kwargs)
        try:
            response.read(64 * 1024)
            row['http_status'] = response.getcode()
        finally:
            response.close()
    except urllib.error.HTTPError as e:
        row['http_status'] = e.code
        try:
            e.close()
        except Exception:
            pass
    except Exception as e:
        reason = getattr(e, 'reason', None)
        if reason is not None:
            row['error'] = short('{}: {}'.format(type(e).__name__, reason))
        else:
            row['error'] = short('{}: {}'.format(type(e).__name__, e))
    row['latency_ms'] = round((clock() - start) * 1000, 1)
    return row


def error_row(e, where=''):
    text = describe_exception(e)
    if where:
        text = short('{}: {}'.format(where, text))
    return {'kind': 'error', 'error': text}


# ---------------------------------------------------------------- output

class CsvSink:
    """
    Append rows to a CSV file, reopening it on every write so the file can be
    moved or truncated while the probe runs. Rows that fail to write (file
    locked by another program) are kept and written next time.
    """

    def __init__(self, path, now=datetime.now):
        self.path = self.resolve_path(str(path), now)
        self.pending = []

    @staticmethod
    def header_line():
        return ','.join(COLUMNS)

    @classmethod
    def resolve_path(cls, path, now=datetime.now):
        if os.path.exists(path) and os.path.getsize(path) > 0:
            with open(path, 'r', encoding='utf-8', errors='replace', newline='') as f:
                first = f.readline().strip()
            if first != cls.header_line():
                stem, ext = os.path.splitext(path)
                return '{}.{}{}'.format(stem, now().strftime('%Y%m%d-%H%M%S'), ext or '.csv')
        return path

    def write(self, rows):
        """
        Returns:
            bool: If all pending rows were written.
        """
        self.pending.extend(rows)
        if len(self.pending) > PENDING_MAX:
            self.pending = self.pending[-PENDING_MAX:]
        try:
            folder = os.path.dirname(os.path.abspath(self.path))
            if not os.path.isdir(folder):
                os.makedirs(folder)
            new = not os.path.exists(self.path) or os.path.getsize(self.path) == 0
            with open(self.path, 'a', encoding='utf-8', newline='') as f:
                writer = csv.DictWriter(f, fieldnames=COLUMNS, restval='', extrasaction='ignore')
                if new:
                    writer.writeheader()
                writer.writerows(self.pending)
                f.flush()
        except OSError as e:
            sys.stderr.write('soak_probe: cannot write {}: {}\n'.format(self.path, describe_exception(e)))
            return False
        self.pending = []
        return True


# ---------------------------------------------------------------- sampling

class Sampler:
    def __init__(self, ps, log_dir, url, port, http_timeout=10.0, insecure=False,
                 electron_names=DEFAULT_ELECTRON_NAMES, mumu_patterns=DEFAULT_MUMU_PATTERNS,
                 extra_patterns=(), pinned=(), log_window_s=48 * 3600, log_limit=10, self_pid=None):
        self.ps = ps
        self.log_dir = log_dir
        self.url = url
        self.port = port
        self.http_timeout = http_timeout
        self.insecure = insecure
        self.electron_names = tuple(electron_names)
        self.mumu_patterns = tuple(mumu_patterns)
        self.extra_patterns = tuple(extra_patterns)
        self.pinned = tuple(pinned)
        self.log_window_s = log_window_s
        self.log_limit = log_limit
        self.self_pid = os.getpid() if self_pid is None else self_pid
        self.cpu_cache = CpuCache()
        self.self_proc = None

    def collect(self):
        """
        Returns:
            tuple: (list[ProcSnapshot], dict[int, psutil.Process])
        """
        snapshots = []
        procs = {}
        for proc in self.ps.process_iter(['pid', 'ppid', 'name', 'create_time', 'cmdline']):
            info = getattr(proc, 'info', None) or {}
            pid = info.get('pid', getattr(proc, 'pid', None))
            if pid is None:
                continue
            snapshots.append(make_snapshot(
                pid, info.get('ppid'), info.get('name'), info.get('cmdline'), info.get('create_time')))
            procs[pid] = proc

        # Expensive calls only for the python processes of ALAS trees
        wanted = tree_python_pids(snapshots, self.self_pid)
        if wanted:
            for index, snap in enumerate(snapshots):
                if snap.pid not in wanted:
                    continue
                proc = procs[snap.pid]
                listen = set()
                func = 'net_connections' if hasattr(proc, 'net_connections') else 'connections'
                connections, _ = safe(proc, func, kind='tcp')
                for conn in connections or []:
                    if getattr(conn, 'status', '') == 'LISTEN' and conn.laddr:
                        listen.add(conn.laddr[1])
                files, _ = safe(proc, 'open_files')
                paths = [getattr(f, 'path', '') for f in files or []]
                snapshots[index] = snap._replace(listen_ports=listen, open_files=paths)
        return snapshots, procs

    def proc_rows(self):
        snapshots, procs = self.collect()
        roles = classify(snapshots, self.port, self.electron_names, self.mumu_patterns,
                         self.extra_patterns, self.pinned, self.self_pid)
        by_pid = {s.pid: s for s in snapshots}
        order = {role: index for index, role in enumerate(ROLE_ORDER)}
        rows = []
        for pid in sorted(roles, key=lambda p: (order.get(roles[p][0], len(order)), roles[p][2] or 0, p)):
            role, instance, tree = roles[pid]
            rows.append(build_proc_row(procs[pid], by_pid[pid], role, instance, tree, self.cpu_cache))
        for pid in self.pinned:
            if pid not in roles:
                rows.append({'kind': 'proc', 'role': 'pinned', 'pid': pid, 'status': 'missing'})
        self.cpu_cache.prune((by_pid[p].pid, by_pid[p].create_time) for p in roles)
        return rows, format_counts(roles)

    def probe_row(self, counts, start):
        row = {'kind': 'probe', 'role': 'probe', 'pid': self.self_pid, 'counts': counts}
        if self.self_proc is None:
            self.self_proc, _ = safe(self.ps, 'Process')
        if self.self_proc is not None:
            memory, _ = safe(self.self_proc, 'memory_info')
            if memory is not None:
                row['rss_mb'] = mb(memory.rss)
            threads, _ = safe(self.self_proc, 'num_threads')
            if threads is not None:
                row['threads'] = threads
        row['sample_ms'] = round((time.monotonic() - start) * 1000, 1)
        return row

    def take_sample(self, sample, now):
        """
        Args:
            sample (int): 1-based sample index.
            now (datetime): Naive local time.

        Returns:
            list[dict]:
        """
        start = time.monotonic()
        rows = []
        counts = ''
        try:
            proc_rows, counts = self.proc_rows()
            rows.extend(proc_rows)
        except Exception as e:
            rows.append(error_row(e, 'proc'))
        try:
            rows.extend(build_log_rows(self.log_dir, now, self.log_window_s, self.log_limit))
        except Exception as e:
            rows.append(error_row(e, 'log'))
        try:
            rows.append(build_http_row(self.url, self.http_timeout, self.insecure))
        except Exception as e:
            rows.append(error_row(e, 'http'))
        rows.append(self.probe_row(counts, start))
        return rows


def stamp(rows, sample, now):
    ts = iso_local(now)
    for row in rows:
        row['ts'] = ts
        row['sample'] = sample
    return rows


def run(take_sample, sink, interval, duration=0.0, samples=0,
        clock=time.monotonic, sleep=time.sleep, now=datetime.now):
    """
    Args:
        take_sample (callable): (sample_index, now) -> list[dict]
        sink (CsvSink):
        interval (float): Seconds between the start of two samples.
        duration (float): Stop after this many seconds, 0 for forever.
        samples (int): Stop after this many samples, 0 for no limit.

    Returns:
        int: Exit code.
    """
    start = clock()
    sample = 0
    try:
        while True:
            sample += 1
            begin = clock()
            current = now()
            try:
                rows = take_sample(sample, current)
            except Exception as e:
                rows = [error_row(e, 'sample')]
            sink.write(stamp(rows, sample, current))

            if samples and sample >= samples:
                break
            delay = max(0.0, interval - (clock() - begin))
            if duration and (clock() - start) + delay >= duration:
                break
            sleep(delay)
    except KeyboardInterrupt:
        pass
    return 0


# ---------------------------------------------------------------- main

def default_root():
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def url_port(url):
    parts = urllib.parse.urlsplit(url)
    try:
        port = parts.port
    except ValueError:
        port = None
    if port:
        return port
    return 443 if parts.scheme == 'https' else 80


def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        description='ALAS soak probe: append process / log / HTTP health rows to a CSV.')
    parser.add_argument('--alas-root', default=default_root(), help='ALAS folder, default: parent of dev_tools')
    parser.add_argument('--out', default=None, help='CSV path, default: <alas-root>/log/soak.csv')
    parser.add_argument('--interval', type=float, default=60.0, help='Seconds between samples, default 60')
    parser.add_argument('--duration', type=float, default=0.0, help='Stop after N seconds, default 0 (forever)')
    parser.add_argument('--samples', type=int, default=0, help='Stop after N samples, default 0 (no limit)')
    parser.add_argument('--once', action='store_true', help='Take one sample and exit')
    parser.add_argument('--url', default=DEFAULT_URL, help='GUI URL to GET, default ' + DEFAULT_URL)
    parser.add_argument('--http-timeout', type=float, default=10.0, help='HTTP timeout in seconds, default 10')
    parser.add_argument('--insecure', action='store_true', help='Do not verify the TLS certificate')
    parser.add_argument('--electron-name', action='append', default=None,
                        help='Electron process name, repeatable, default: alas.exe, electron.exe')
    parser.add_argument('--mumu-pattern', action='append', default=None,
                        help='MuMu process name pattern, repeatable, default: MuMuPlayer*, MuMuVMMHeadless*')
    parser.add_argument('--extra-pattern', action='append', default=[],
                        help='Other process name pattern to watch, repeatable, e.g. adb*.exe')
    parser.add_argument('--pid', action='append', type=int, default=[], help='Watch this pid, repeatable')
    parser.add_argument('--log-window-hours', type=float, default=48.0,
                        help='Report log files modified within N hours, default 48')
    parser.add_argument('--log-limit', type=int, default=10, help='Report at most N log files, default 10')
    args = parser.parse_args(argv)
    if args.out is None:
        args.out = os.path.join(args.alas_root, 'log', 'soak.csv')
    if args.once:
        args.samples = 1
    if args.interval <= 0:
        parser.error('--interval must be positive')
    return args


def main(argv=None):
    args = parse_args(argv)
    if psutil is None:
        sys.stderr.write('soak_probe: psutil is not installed, run it with the ALAS python (toolkit\\python.exe)\n')
        return 2
    sink = CsvSink(args.out)
    sampler = Sampler(
        psutil,
        log_dir=os.path.join(args.alas_root, 'log'),
        url=args.url,
        port=url_port(args.url),
        http_timeout=args.http_timeout,
        insecure=args.insecure,
        electron_names=args.electron_name or DEFAULT_ELECTRON_NAMES,
        mumu_patterns=args.mumu_pattern or DEFAULT_MUMU_PATTERNS,
        extra_patterns=args.extra_pattern,
        pinned=args.pid,
        log_window_s=args.log_window_hours * 3600,
        log_limit=args.log_limit,
    )
    sys.stderr.write('soak_probe: writing {} every {}s\n'.format(sink.path, args.interval))
    return run(sampler.take_sample, sink, args.interval, duration=args.duration, samples=args.samples)


if __name__ == '__main__':
    sys.exit(main())
