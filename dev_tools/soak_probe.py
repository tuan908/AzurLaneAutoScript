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
- ``http``  status and latency of ``GET`` on the GUI (time until the response
  headers arrive, with a hard overall deadline).
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
- The GUI address is taken from the running gui.py command line (Electron
  passes ``--port <WebuiPort>``), else from config/deploy.yaml over
  deploy/template, else 127.0.0.1:22267. ``--url`` overrides it.
- Open file handles (used to recognise workers by their log file) are read in a
  short-lived helper process with a hard timeout: psutil's Windows handle lookup
  can hang, and it must never hang the probe.
- Roles of the python children are best-effort guesses (on Windows all
  multiprocessing children share the same command line). A role once
  recognised is kept for that process (pid + create time) while it lives; a
  child that cannot be recognised is reported as ``unknown``. pid, ppid,
  create_time and cmdline are always written so the analysis can re-classify.
- The GUI password (``-k`` / ``--key``) is redacted from written command lines.
- MuMu may run elevated; metrics then come back blank with error=AccessDenied.
  Run the probe from an elevated prompt if those are needed.
- At 60 s per sample a 72h run is ~100k rows (~20-30 MB).
- If the CSV is locked (e.g. opened in Excel), rows are kept in memory and
  written on the next successful sample. If rows are still unwritten when the
  probe stops, it exits with code 1.
"""
import argparse
import csv
import fnmatch
import http.client
import json
import os
import re
import socket
import ssl
import subprocess
import sys
import threading
import time
import traceback
import urllib.parse
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
    'gui_launcher', 'server', 'sync_manager', 'worker', 'unknown', 'python_descendant',
    'descendant', 'electron_main', 'electron_renderer', 'electron_other', 'mumu', 'extra', 'pinned',
)
COUNTED_ROLES = ('server', 'sync_manager', 'worker', 'unknown', 'electron_main', 'electron_renderer', 'mumu')
# Roles that are remembered per process once recognised
REMEMBERED_ROLES = ('server', 'sync_manager', 'worker')

DEFAULT_ELECTRON_NAMES = ('alas.exe', 'electron.exe')
DEFAULT_MUMU_PATTERNS = ('MuMuPlayer*', 'MuMuVMMHeadless*')
DEFAULT_HOST = '127.0.0.1'
DEFAULT_PORT = 22267
# Long options of gui.py, for argparse-style prefix matching
GUI_LONG_OPTIONS = ('--host', '--port', '--key', '--cdn', '--electron', '--ssl-key', '--ssl-cert', '--run')
DEPLOY_KEYS = ('WebuiHost', 'WebuiPort', 'WebuiSSLKey', 'WebuiSSLCert')
REDACTED = '***'

GONE_ERRORS = ('NoSuchProcess', 'ZombieProcess')
CMDLINE_MAX = 300
ERROR_MAX = 300
PENDING_MAX = 20000
TAIL_BYTES = 64 * 1024
HELPER_FLAG = '--open-files-helper'

# ALAS file_formatter: '%(asctime)s.%(msecs)03d | %(levelname)s | %(message)s'
LOG_LINE_RE = re.compile(r'^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\.(\d{3}) \|')
# module/logger.py: f'./log/{datetime.date.today()}_{name}.txt'
LOG_NAME_RE = re.compile(r'^\d{4}-\d{2}-\d{2}_(.+)\.txt$')
# deploy/utils.py poor_yaml_read, restricted to the keys needed here
DEPLOY_LINE_RE = re.compile(r'^\s*(\w+)\s*:(.*)$')

ProcSnapshot = namedtuple(
    'ProcSnapshot', ['pid', 'ppid', 'name', 'cmdline', 'create_time', 'listen_ports', 'open_files'])


def make_snapshot(pid, ppid=None, name='', cmdline=None, create_time=0.0, listen_ports=(), open_files=()):
    return ProcSnapshot(pid, ppid, name or '', list(cmdline or []), create_time or 0.0,
                        set(listen_ports), list(open_files))


def snapshot_key(snap):
    return snap.pid, snap.create_time


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


def basename(path):
    return re.split(r'[\\/]', str(path))[-1]


def is_gui_command(snap):
    """A python process running gui.py that is not a multiprocessing child"""
    if not is_python(snap.name):
        return False
    if '--multiprocessing-fork' in snap.cmdline:
        return False
    if is_probe_command(snap):
        return False
    return any(basename(arg) == 'gui.py' for arg in snap.cmdline[1:])


def is_probe_command(snap):
    return any('soak_probe' in arg for arg in snap.cmdline[1:])


def instance_from_log_path(path):
    """'log/2026-11-25_alas.txt' -> 'alas', None if not an ALAS log file"""
    match = LOG_NAME_RE.match(basename(path))
    if match:
        return match.group(1)
    return None


def expand_long_option(arg):
    """'--po' -> '--port' like argparse prefix matching on gui.py options, else None"""
    if not arg.startswith('--') or arg == '--':
        return None
    if arg in GUI_LONG_OPTIONS:
        return arg
    matches = [o for o in GUI_LONG_OPTIONS if o.startswith(arg)]
    if len(matches) == 1:
        return matches[0]
    return None


def redact_cmdline(cmdline):
    """
    Hide the value of gui.py ``-k`` / ``--key`` (the GUI password), in the
    forms argparse accepts: ``-k pw``, ``-kpw``, ``--key pw``, ``--key=pw``
    and prefixes such as ``--ke=pw``.
    """
    result = []
    redact_next = False
    for arg in cmdline:
        if redact_next:
            result.append(REDACTED)
            redact_next = False
            continue
        if arg == '-k':
            result.append(arg)
            redact_next = True
        elif arg.startswith('-k') and not arg.startswith('--'):
            result.append('-k' + REDACTED)
        elif arg.startswith('--'):
            name, sep, _ = arg.partition('=')
            if expand_long_option(name) == '--key':
                if sep:
                    result.append(name + '=' + REDACTED)
                else:
                    result.append(arg)
                    redact_next = True
            else:
                result.append(arg)
        else:
            result.append(arg)
    return result


def format_cmdline(snap):
    cmdline = snap.cmdline
    if is_python(snap.name):
        cmdline = redact_cmdline(cmdline)
    return short(' '.join(cmdline), CMDLINE_MAX)


# ---------------------------------------------------------------- endpoint

def gui_options(cmdline):
    """
    Options of a gui.py command line that decide where it listens.

    Returns:
        dict: Subset of host, port (int), ssl_key, ssl_cert.
    """
    names = {'--host': 'host', '--port': 'port', '--ssl-key': 'ssl_key', '--ssl-cert': 'ssl_cert'}
    options = {}
    args = list(cmdline)
    index = 0
    while index < len(args):
        arg = args[index]
        key = value = None
        if arg.startswith('--'):
            name, sep, rest = arg.partition('=')
            option = expand_long_option(name)
            if option in names:
                key = names[option]
                if sep:
                    value = rest
                elif index + 1 < len(args):
                    value = args[index + 1]
                    index += 1
        elif arg == '-p':
            key = 'port'
            if index + 1 < len(args):
                value = args[index + 1]
                index += 1
        elif arg.startswith('-p'):
            key, value = 'port', arg[2:].lstrip('=')
        if key and value is not None:
            if key == 'port':
                try:
                    options['port'] = int(value)
                except ValueError:
                    pass
            else:
                options[key] = value
        index += 1
    return options


def parse_deploy_text(text):
    data = {}
    for line in text.splitlines():
        if line.strip().startswith('#'):
            continue
        match = DEPLOY_LINE_RE.match(line)
        if not match or match.group(1) not in DEPLOY_KEYS:
            continue
        value = match.group(2).strip('\n\r\t\'" ')
        if not value:
            continue
        if value.lower() == 'null':
            value = None
        elif value.isdigit():
            value = int(value)
        data[match.group(1)] = value
    return data


def read_deploy(alas_root):
    """
    Webui settings as gui.py sees them: config/deploy.yaml over deploy/template.

    Returns:
        dict: Subset of DEPLOY_KEYS.
    """
    data = {}
    for path in (os.path.join(alas_root, 'deploy', 'template'), os.path.join(alas_root, 'config', 'deploy.yaml')):
        try:
            with open(path, 'r', encoding='utf-8', errors='replace') as f:
                data.update(parse_deploy_text(f.read()))
        except OSError:
            continue
    return data


def resolve_endpoint(cmdline=None, deploy=None):
    """
    Same precedence as gui.py: command line, then deploy settings, then defaults.

    Args:
        cmdline (list[str]): Command line of a running gui.py, or None.
        deploy (dict): Output of read_deploy().

    Returns:
        tuple: (url, port, insecure)
    """
    options = gui_options(cmdline or [])
    deploy = deploy or {}
    host = options.get('host') or deploy.get('WebuiHost') or DEFAULT_HOST
    host = str(host)
    if host in ('0.0.0.0', '::', '[::]', '*'):
        host = DEFAULT_HOST
    if ':' in host and not host.startswith('['):
        host = '[{}]'.format(host)
    try:
        port = int(options.get('port') or deploy.get('WebuiPort') or DEFAULT_PORT)
    except (TypeError, ValueError):
        port = DEFAULT_PORT
    ssl_key = options.get('ssl_key') or deploy.get('WebuiSSLKey')
    ssl_cert = options.get('ssl_cert') or deploy.get('WebuiSSLCert')
    use_ssl = bool(ssl_key) and bool(ssl_cert)
    url = '{}://{}:{}/'.format('https' if use_ssl else 'http', host, port)
    # Local health check of a self-signed GUI: verifying the certificate is not the point
    return url, port, use_ssl


def url_port(url):
    parts = urllib.parse.urlsplit(url)
    try:
        port = parts.port
    except ValueError:
        port = None
    if port:
        return port
    return 443 if parts.scheme == 'https' else 80


# ---------------------------------------------------------------- classify

class RoleMemory:
    """
    Roles recognised in earlier samples, keyed by (pid, create_time), so a
    worker whose log handle is missed once does not vanish from the counts, and
    the SyncManager slot of a server is filled once only.
    """

    def __init__(self):
        self.roles = {}
        self.manager_assigned = set()

    def prune(self, alive_keys):
        alive_keys = set(alive_keys)
        self.roles = {k: v for k, v in self.roles.items() if k in alive_keys}
        self.manager_assigned &= alive_keys


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


def _find_server(root, members, port, children, memory):
    """
    Returns:
        tuple: (server snapshot, positively identified)
    """
    python_members = [root] + [d for d, _ in members if is_python(d.name)]
    for snap in python_members:
        if port in snap.listen_ports:
            return snap, True
    # Listener not visible this time (AccessDenied, not listening yet), use the previous answer
    for snap in python_members:
        if memory.roles.get(snapshot_key(snap), ('',))[0] == 'server':
            return snap, False
    # With EnableReload the server is the launcher's child that has children itself
    for child in children.get(root.pid, []):
        if is_python(child.name) and any(is_python(c.name) for c in children.get(child.pid, [])):
            return child, False
    return root, False


def classify(snapshots, port=DEFAULT_PORT, electron_names=DEFAULT_ELECTRON_NAMES,
             mumu_patterns=DEFAULT_MUMU_PATTERNS, extra_patterns=(), pinned=(), self_pid=None, memory=None):
    """
    Args:
        snapshots (list[ProcSnapshot]):
        port (int): GUI port used when a gui.py command line has no --port.
            The process listening on it is the server.
        electron_names (iterable[str]): Exact process names of Electron, case-insensitive.
        mumu_patterns (iterable[str]): fnmatch patterns of MuMu process names, case-insensitive.
        extra_patterns (iterable[str]): fnmatch patterns of other processes to watch.
        pinned (iterable[int]): pids to watch whatever they are.
        self_pid (int): pid of the probe, never reported.
        memory (RoleMemory): Roles from earlier samples, updated in place.

    Returns:
        dict[int, tuple]: pid -> (role, instance, tree_root_pid or '')
    """
    if memory is None:
        memory = RoleMemory()
    roles = {}
    children = _children_map(snapshots)

    for root, members in gui_trees(snapshots, self_pid):
        tree = root.pid
        tree_port = gui_options(root.cmdline).get('port') or port
        server, sure = _find_server(root, members, tree_port, children, memory)
        roles[root.pid] = ('gui_launcher', '', tree)
        for snap, _ in members:
            roles[snap.pid] = ('python_descendant' if is_python(snap.name) else 'descendant', '', tree)
        roles[server.pid] = ('server', '', tree)
        server_key = snapshot_key(server)
        if sure:
            memory.roles[server_key] = ('server', '')

        # Workers: recognised by their own log file, or recognised before
        workers = []
        unresolved = []
        for child in children.get(server.pid, []):
            if child.pid not in roles or not is_python(child.name):
                continue
            key = snapshot_key(child)
            instances = sorted({
                name for name in (instance_from_log_path(f) for f in child.open_files)
                if name and name != 'gui'})
            remembered = memory.roles.get(key)
            if instances:
                memory.roles[key] = ('worker', instances[0])
                roles[child.pid] = ('worker', instances[0], tree)
                workers.append(child)
            elif remembered is not None and remembered[0] in REMEMBERED_ROLES:
                roles[child.pid] = (remembered[0], remembered[1], tree)
                if remembered[0] == 'worker':
                    workers.append(child)
            else:
                unresolved.append(child)

        # SyncManager: the first child, created by State.init() in app startup, so it
        # is older than every worker. Assigned once per server, never re-assigned
        # to another child after it exits.
        if server_key not in memory.manager_assigned and unresolved:
            candidate = unresolved[0]
            if all(candidate.create_time <= w.create_time for w in workers):
                memory.roles[snapshot_key(candidate)] = ('sync_manager', '')
                memory.manager_assigned.add(server_key)
                roles[candidate.pid] = ('sync_manager', '', tree)
                unresolved = unresolved[1:]
        for child in unresolved:
            roles[child.pid] = ('unknown', '', tree)

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

    memory.prune(snapshot_key(s) for s in snapshots)
    return roles


def format_counts(roles):
    counter = Counter(role for role, _, _ in roles.values())
    keys = list(COUNTED_ROLES) + sorted(k for k in counter if k not in COUNTED_ROLES)
    return ';'.join('{}={}'.format(k, counter.get(k, 0)) for k in keys)


# ---------------------------------------------------------------- open files

def helper_main(args):
    """
    Entry of the open-files helper process: print one JSON line per pid.
    Runs in its own process so a hang in psutil's native handle lookup
    (Windows) can be killed by the probe.
    """
    if psutil is None:
        sys.stdout.write(json.dumps({'error': 'psutil not installed'}) + '\n')
        return 2
    for arg in args:
        try:
            pid = int(arg)
        except ValueError:
            continue
        try:
            files = [f.path for f in psutil.Process(pid).open_files()]
            line = {'pid': pid, 'files': files}
        except Exception as e:
            line = {'pid': pid, 'error': type(e).__name__}
        sys.stdout.write(json.dumps(line) + '\n')
        sys.stdout.flush()
    return 0


class HandleLookup:
    """
    Read open files of some processes in a helper process with a hard timeout.
    Results printed before a timeout are kept.
    """

    def __init__(self, timeout=5.0, command=None):
        self.timeout = timeout
        self.command = command

    def build_command(self, pids):
        if self.command is not None:
            return list(self.command) + [str(p) for p in pids]
        return [sys.executable, os.path.abspath(__file__), HELPER_FLAG] + [str(p) for p in pids]

    def __call__(self, pids):
        """
        Returns:
            tuple: (dict[int, list[str]] of pids answered, error message or '')
        """
        pids = sorted(pids)
        if not pids:
            return {}, ''
        kwargs = {}
        if sys.platform.startswith('win'):
            kwargs['creationflags'] = 0x08000000  # CREATE_NO_WINDOW
        error = ''
        try:
            proc = subprocess.Popen(self.build_command(pids), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                    stdin=subprocess.DEVNULL, **kwargs)
        except OSError as e:
            return {}, short('open_files helper: {}'.format(describe_exception(e)))
        try:
            out, _ = proc.communicate(timeout=self.timeout)
        except subprocess.TimeoutExpired:
            proc.kill()
            try:
                out, _ = proc.communicate(timeout=self.timeout)
            except subprocess.TimeoutExpired:
                out = b''
            error = 'open_files helper: timeout after {}s'.format(self.timeout)
        result = {}
        failed = []
        for line in (out or b'').decode('utf-8', errors='replace').splitlines():
            try:
                data = json.loads(line)
            except ValueError:
                continue
            if 'pid' not in data:
                if data.get('error'):
                    error = short('open_files helper: {}'.format(data['error']))
                continue
            if 'files' in data:
                result[data['pid']] = list(data['files'])
            else:
                failed.append('{}:{}'.format(data['pid'], data.get('error', '')))
        if not error and proc.returncode not in (0, None):
            error = 'open_files helper: exit code {}'.format(proc.returncode)
        if failed and not error:
            error = short('open_files failed: ' + ';'.join(failed))
        return result, error


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
        proc, first_seen = cpu_cache.get(snapshot_key(snap), proc)

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
        'cmdline': format_cmdline(snap),
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


def open_connection(url, timeout, insecure):
    """
    Returns:
        tuple: (http.client connection, request path)
    """
    parts = urllib.parse.urlsplit(url)
    host = parts.hostname or DEFAULT_HOST
    port = url_port(url)
    if parts.scheme == 'https':
        context = ssl._create_unverified_context() if insecure else ssl.create_default_context()
        conn = http.client.HTTPSConnection(host, port, timeout=timeout, context=context)
    else:
        conn = http.client.HTTPConnection(host, port, timeout=timeout)
    path = parts.path or '/'
    if parts.query:
        path += '?' + parts.query
    return conn, path


def _abort_connection(conn):
    sock = getattr(conn, 'sock', None)
    if sock is None:
        return
    try:
        sock.shutdown(socket.SHUT_RDWR)
    except Exception:
        pass
    try:
        sock.close()
    except Exception:
        pass


def build_http_row(url, timeout=10.0, insecure=False, factory=open_connection, clock=time.monotonic):
    """
    GET the GUI and record the status once the response headers arrive; the
    body is not read. ``timeout`` is a deadline for the whole request, a slow
    server cannot stretch it. Never raises.

    Returns:
        dict:
    """
    row = {'kind': 'http', 'url': url}
    state = {}
    lock = threading.Lock()

    def request():
        conn = None
        try:
            conn, path = factory(url, timeout, insecure)
            with lock:
                state['conn'] = conn
            conn.request('GET', path, headers={'Connection': 'close', 'User-Agent': 'alas-soak-probe'})
            response = conn.getresponse()
            state['status'] = response.status
        except Exception as e:
            state['error'] = short('{}: {}'.format(type(e).__name__, e))
        finally:
            state['end'] = clock()
            if conn is not None:
                try:
                    conn.close()
                except Exception:
                    pass

    start = clock()
    thread = threading.Thread(target=request, name='soak-probe-http', daemon=True)
    thread.start()
    thread.join(timeout)
    if thread.is_alive():
        with lock:
            conn = state.get('conn')
        _abort_connection(conn)
        row['error'] = 'Timeout: no response headers within {}s'.format(timeout)
        row['latency_ms'] = round((clock() - start) * 1000, 1)
        return row
    if 'status' in state:
        row['http_status'] = state['status']
    if 'error' in state:
        row['error'] = state['error']
    row['latency_ms'] = round((state.get('end', clock()) - start) * 1000, 1)
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
        if os.path.exists(path):
            try:
                if os.path.getsize(path) == 0:
                    return path
                with open(path, 'r', encoding='utf-8', errors='replace', newline='') as f:
                    first = f.readline().strip()
            except OSError:
                first = None
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
    def __init__(self, ps, log_dir, url=None, port=DEFAULT_PORT, http_timeout=10.0, insecure=False,
                 electron_names=DEFAULT_ELECTRON_NAMES, mumu_patterns=DEFAULT_MUMU_PATTERNS,
                 extra_patterns=(), pinned=(), log_window_s=48 * 3600, log_limit=10, self_pid=None,
                 alas_root=None, handle_lookup=None):
        """
        Args:
            url (str): Explicit GUI URL, None to resolve it from the running
                gui.py command line and the deploy settings of alas_root.
            port (int): Fallback GUI port when url is None and nothing else tells.
        """
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
        self.alas_root = alas_root
        self.handle_lookup = handle_lookup or HandleLookup()
        self.cpu_cache = CpuCache()
        self.memory = RoleMemory()
        self.self_proc = None
        self.notes = []

    def deploy(self):
        if self.alas_root is None:
            return {}
        return read_deploy(self.alas_root)

    def endpoint(self, snapshots, deploy):
        """
        Returns:
            tuple: (url, default port for classification, insecure)
        """
        trees = gui_trees(snapshots, self.self_pid)
        # The oldest gui.py is the one the HTTP check follows
        cmdline = trees[0][0].cmdline if trees else None
        deploy = dict(deploy)
        if not deploy.get('WebuiPort'):
            deploy['WebuiPort'] = self.port
        url, port, auto_insecure = resolve_endpoint(cmdline, deploy)
        if self.url is not None:
            # Explicit URL may point at a proxy: classification still uses the real GUI port
            return self.url, port, self.insecure
        return url, port, self.insecure or auto_insecure

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
            files, error = self.handle_lookup(wanted)
            if error:
                self.notes.append(error)
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
                snapshots[index] = snap._replace(listen_ports=listen, open_files=files.get(snap.pid, []))
        return snapshots, procs

    def proc_rows(self):
        """
        Returns:
            tuple: (rows, counts, url, insecure)
        """
        snapshots, procs = self.collect()
        url, port, insecure = self.endpoint(snapshots, self.deploy())
        roles = classify(snapshots, port, self.electron_names, self.mumu_patterns,
                         self.extra_patterns, self.pinned, self.self_pid, self.memory)
        by_pid = {s.pid: s for s in snapshots}
        order = {role: index for index, role in enumerate(ROLE_ORDER)}
        rows = []
        for pid in sorted(roles, key=lambda p: (order.get(roles[p][0], len(order)), roles[p][2] or 0, p)):
            role, instance, tree = roles[pid]
            rows.append(build_proc_row(procs[pid], by_pid[pid], role, instance, tree, self.cpu_cache))
        for pid in self.pinned:
            if pid not in roles:
                rows.append({'kind': 'proc', 'role': 'pinned', 'pid': pid, 'status': 'missing'})
        self.cpu_cache.prune(snapshot_key(by_pid[p]) for p in roles)
        return rows, format_counts(roles), url, insecure

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
        url, insecure = self.url, self.insecure
        self.notes = []
        try:
            proc_rows, counts, url, insecure = self.proc_rows()
            rows.extend(proc_rows)
        except Exception as e:
            rows.append(error_row(e, 'proc'))
        rows.extend({'kind': 'error', 'error': note} for note in self.notes)
        try:
            rows.extend(build_log_rows(self.log_dir, now, self.log_window_s, self.log_limit))
        except Exception as e:
            rows.append(error_row(e, 'log'))
        if url is None:
            try:
                url, _, insecure = self.endpoint([], self.deploy())
            except Exception as e:
                rows.append(error_row(e, 'endpoint'))
        if url is not None:
            try:
                rows.append(build_http_row(url, self.http_timeout, insecure))
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
        clock=time.monotonic, sleep=time.sleep, now=datetime.now, final_retries=3, retry_delay=1.0):
    """
    Args:
        take_sample (callable): (sample_index, now) -> list[dict]
        sink (CsvSink):
        interval (float): Seconds between the start of two samples.
        duration (float): Stop after this many seconds, 0 for forever.
        samples (int): Stop after this many samples, 0 for no limit.
        final_retries (int): Attempts to write rows still pending at exit.
        retry_delay (float): Seconds between those attempts.

    Returns:
        int: Exit code, 1 if some rows could not be written.
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
            # A failed write keeps the rows pending, they are retried with the next sample
            sink.write(stamp(rows, sample, current))

            if samples and sample >= samples:
                break
            delay = max(0.0, interval - (clock() - begin))
            if duration and (clock() - start) + delay >= duration:
                break
            sleep(delay)
    except KeyboardInterrupt:
        pass

    try:
        for attempt in range(final_retries):
            if not sink.pending or sink.write([]):
                break
            if attempt + 1 < final_retries:
                sleep(retry_delay)
    except KeyboardInterrupt:
        pass
    if sink.pending:
        sys.stderr.write('soak_probe: {} rows could not be written to {}\n'.format(len(sink.pending), sink.path))
        return 1
    return 0


# ---------------------------------------------------------------- main

def default_root():
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        description='ALAS soak probe: append process / log / HTTP health rows to a CSV.')
    parser.add_argument('--alas-root', default=default_root(), help='ALAS folder, default: parent of dev_tools')
    parser.add_argument('--out', default=None, help='CSV path, default: <alas-root>/log/soak.csv')
    parser.add_argument('--interval', type=float, default=60.0, help='Seconds between samples, default 60')
    parser.add_argument('--duration', type=float, default=0.0, help='Stop after N seconds, default 0 (forever)')
    parser.add_argument('--samples', type=int, default=0, help='Stop after N samples, default 0 (no limit)')
    parser.add_argument('--once', action='store_true', help='Take one sample and exit')
    parser.add_argument('--url', default=None,
                        help='GUI URL to GET, default: from the running gui.py command line, '
                             'else config/deploy.yaml, else http://127.0.0.1:22267/')
    parser.add_argument('--http-timeout', type=float, default=10.0,
                        help='Deadline of the whole HTTP request in seconds, default 10')
    parser.add_argument('--insecure', action='store_true', help='Do not verify the TLS certificate')
    parser.add_argument('--handle-timeout', type=float, default=5.0,
                        help='Deadline of the open-files helper process in seconds, default 5')
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
    if argv is None:
        argv = sys.argv[1:]
    if argv and argv[0] == HELPER_FLAG:
        return helper_main(argv[1:])
    args = parse_args(argv)
    if psutil is None:
        sys.stderr.write('soak_probe: psutil is not installed, run it with the ALAS python (toolkit\\python.exe)\n')
        return 2
    sink = CsvSink(args.out)
    sampler = Sampler(
        psutil,
        log_dir=os.path.join(args.alas_root, 'log'),
        url=args.url,
        http_timeout=args.http_timeout,
        insecure=args.insecure,
        electron_names=args.electron_name or DEFAULT_ELECTRON_NAMES,
        mumu_patterns=args.mumu_pattern or DEFAULT_MUMU_PATTERNS,
        extra_patterns=args.extra_pattern,
        pinned=args.pid,
        log_window_s=args.log_window_hours * 3600,
        log_limit=args.log_limit,
        alas_root=args.alas_root,
        handle_lookup=HandleLookup(timeout=args.handle_timeout),
    )
    sys.stderr.write('soak_probe: writing {} every {}s\n'.format(sink.path, args.interval))
    return run(sampler.take_sample, sink, args.interval, duration=args.duration, samples=args.samples)


if __name__ == '__main__':
    sys.exit(main())
