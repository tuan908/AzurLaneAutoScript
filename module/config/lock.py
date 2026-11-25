"""
One lock per config file, shared by every writer: the Alas worker processes, the PyWebIO GUI
and the control API.

It combines a per-path threading.RLock (mutual exclusion between threads of one process, which
filelock alone does not give) and a filelock.FileLock (between processes). Both are re-entrant
in the holding thread, so a locked section can call another locked function.
"""
import os
import threading
from contextlib import contextmanager

from module.logger import logger

try:
    from filelock import FileLock, Timeout
except ImportError:  # pragma: no cover - filelock ships with the runtime (via uiautomator2)
    FileLock = None

    class Timeout(Exception):
        pass

LOCK_DIR = './config/tmp'
DEFAULT_TIMEOUT = 10.0

_guard = threading.Lock()
_locks = {}


class ConfigLockTimeout(Exception):
    pass


def lock_path(config_name, mod_name='alas'):
    name = config_name if mod_name == 'alas' else f'{config_name}.{mod_name}'
    return os.path.abspath(os.path.join(LOCK_DIR, f'{name}.lock'))


def _locks_for(path):
    with _guard:
        entry = _locks.get(path)
        if entry is None:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            entry = (threading.RLock(), FileLock(path) if FileLock is not None else None)
            _locks[path] = entry
        return entry


@contextmanager
def config_lock(config_name, mod_name='alas', timeout=DEFAULT_TIMEOUT, required=False):
    """
    Hold the lock of ./config/<config_name>.json.

    Args:
        config_name (str):
        mod_name (str):
        timeout (float): Seconds to wait.
        required (bool): If True, raise ConfigLockTimeout when the lock cannot be taken in time.
            If False, log a warning and continue without it, so automation never stops on a
            stuck lock (the previous, unlocked behaviour).
    """
    path = lock_path(config_name, mod_name)
    try:
        thread_lock, file_lock = _locks_for(path)
    except OSError as e:
        if required:
            raise ConfigLockTimeout(f'Cannot create lock {path}: {e}')
        logger.warning(f'Cannot create config lock {path}: {e}, continue without it')
        yield False
        return

    if not thread_lock.acquire(timeout=timeout):
        if required:
            raise ConfigLockTimeout(f'Config {config_name} is busy')
        logger.warning(f'Config lock {path} busy for {timeout}s, continue without it')
        yield False
        return
    try:
        locked = True
        if file_lock is not None:
            try:
                file_lock.acquire(timeout=timeout)
            except Timeout:
                if required:
                    raise ConfigLockTimeout(f'Config {config_name} is busy')
                logger.warning(f'Config file lock {path} busy for {timeout}s, continue without it')
                locked = False
        try:
            yield locked
        finally:
            if locked and file_lock is not None:
                file_lock.release()
    finally:
        thread_lock.release()
