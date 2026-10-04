"""Resolve private data paths only when used, from an explicit runtime home."""

from __future__ import annotations

import os
from pathlib import Path
from contextlib import contextmanager
from contextvars import ContextVar


_RUNTIME_HOME = ContextVar("guthon_runtime_home", default=None)


@contextmanager
def runtime_home_context(home):
    path = Path(home).expanduser().resolve()
    token = _RUNTIME_HOME.set(path)
    try:
        yield path
    finally:
        _RUNTIME_HOME.reset(token)


def tool_home() -> Path:
    scoped = _RUNTIME_HOME.get()
    if scoped is not None:
        return scoped
    value = os.environ.get("GUTHON_HOME") or os.environ.get("GUTHON_TOOL_HOME")
    if not value:
        raise SystemExit("Missing toolHome. Pass --home or set GUTHON_HOME / GUTHON_TOOL_HOME.")
    return Path(value).expanduser().resolve()


class RuntimePath(os.PathLike):
    """A deferred path for existing public path attributes; imports do no IO."""

    def __init__(self, *parts):
        self.parts = parts

    def resolve(self, *args, **kwargs):
        return tool_home().joinpath(*self.parts).resolve(*args, **kwargs)

    def __fspath__(self):
        return str(self.resolve())

    def __str__(self):
        return self.__fspath__()

    def __truediv__(self, other):
        return self.resolve() / other

    def __getattr__(self, name):
        return getattr(self.resolve(), name)
