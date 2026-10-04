"""Serialize local read/modify/write operations across threads and processes."""

from __future__ import annotations

import os
import tempfile
import threading
import time
from contextlib import contextmanager
from pathlib import Path

try:
    import fcntl
except ImportError:
    import msvcrt
    fcntl = None

_guard = threading.Lock()
_locks = {}
_held = threading.local()


@contextmanager
def _thread_lock(lock, timeout):
    if not lock.acquire(timeout=timeout):
        raise TimeoutError("Timed out waiting for configuration lock in this process")
    try:
        yield
    finally:
        lock.release()


@contextmanager
def file_lock(path: Path, timeout=30):
    if timeout <= 0:
        raise ValueError("Lock timeout must be positive")
    deadline = time.monotonic() + timeout
    path = Path(path).resolve()
    with _guard:
        lock = _locks.setdefault(str(path), threading.RLock())
    with _thread_lock(lock, timeout):
        held = getattr(_held, "paths", set())
        if str(path) in held:
            yield
            return
        path.parent.mkdir(parents=True, exist_ok=True)
        path.touch(exist_ok=True)
        with path.open("r+b") as handle:
            if not handle.read(1):
                handle.write(b"\0")
                handle.flush()
            while True:
                try:
                    handle.seek(0)
                    if fcntl:
                        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                    else:
                        msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                    break
                except OSError as error:
                    if time.monotonic() >= deadline:
                        raise TimeoutError(f"Timed out waiting for configuration lock: {path.name}") from error
                    time.sleep(0.05)
            _held.paths = held | {str(path)}
            try:
                yield
            finally:
                _held.paths = held
                handle.seek(0)
                if fcntl:
                    fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
                else:
                    msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)


def atomic_text(path: Path, text: str):
    """Persist UTF-8 text without host-dependent newline translation."""
    atomic_bytes(path, text.encode('utf-8'))


def atomic_bytes(path: Path, data: bytes):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)
