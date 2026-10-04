"""Request-scoped cooperative cancellation with an atomic publication barrier."""
from __future__ import annotations

import threading
from contextlib import contextmanager
from contextvars import ContextVar


class OperationCancelled(BaseException):
    # Source scanners intentionally catch Exception/SystemExit as file errors.
    # Cancellation must propagate past those catches to transaction rollback.
    error_code = 'OPERATION_CANCELLED'

    def __str__(self):
        return '操作已在安全检查点取消，未发布本次索引扫描'


class RequestControl:
    def __init__(self, supported=False):
        self.supported = supported
        self.requested = False
        self.frozen = False
        self.lock = threading.Lock()

    def cancel(self):
        with self.lock:
            if not self.supported or self.frozen:
                return False
            self.requested = True
            return True

    def check(self):
        with self.lock:
            if self.requested and not self.frozen:
                raise OperationCancelled()

    def freeze(self):
        with self.lock:
            if self.requested:
                raise OperationCancelled()
            self.frozen = True


_control = ContextVar('guthon_operation_control', default=None)


@contextmanager
def request_control(control):
    token = _control.set(control)
    try:
        yield
    finally:
        _control.reset(token)


def checkpoint():
    control = _control.get()
    if control is not None:
        control.check()


def publication_barrier():
    control = _control.get()
    if control is not None:
        control.freeze()


def restrict_to_index(supported):
    control = _control.get()
    if control is not None:
        with control.lock:
            if control.requested and not control.frozen:
                raise OperationCancelled()
            control.supported = control.supported and supported
