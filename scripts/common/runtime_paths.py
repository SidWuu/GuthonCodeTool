"""Resolve private data paths only when used, from an explicit runtime home."""

from __future__ import annotations

import os
import sys
from pathlib import Path
from contextlib import contextmanager
from contextvars import ContextVar
from functools import lru_cache
from zipimport import zipimporter


_RUNTIME_HOME = ContextVar("guthon_runtime_home", default=None)


@contextmanager
def runtime_home_context(home):
    path = Path(home).expanduser().resolve()
    token = _RUNTIME_HOME.set(path)
    try:
        yield path
    finally:
        _RUNTIME_HOME.reset(token)


def tool_source_root() -> Path:
    """Resolve the code boundary of the checkout, frozen app, or zipapp."""
    bundle = getattr(sys, "_MEIPASS", None)
    if bundle:
        return Path(bundle).resolve()
    if isinstance(__loader__, zipimporter):
        return Path(__loader__.archive).resolve()
    return Path(__file__).resolve().parents[2]


def tool_home() -> Path:
    scoped = _RUNTIME_HOME.get()
    if scoped is not None:
        return scoped
    value = os.environ.get("GUTHON_HOME") or os.environ.get("GUTHON_TOOL_HOME")
    if not value:
        raise SystemExit("Missing toolHome. Pass --home or set GUTHON_HOME / GUTHON_TOOL_HOME.")
    return Path(value).expanduser().resolve()


@lru_cache(maxsize=16)
def _configured_workspace_directory(home, stat_identity):
    from common import config_store

    return config_store.read(home).get("workspaceDirectory", "var")


def workspace_root(home=None):
    """Resolve the persisted development root, retaining var for older configurations."""
    from common.config_store import require_stable_configuration
    from common.workspace_layout import workspace_directory

    root = Path(home).resolve() if home is not None else tool_home()
    require_stable_configuration(root)
    path = root / "config/guthon.json"
    try:
        stat = path.stat()
    except FileNotFoundError:
        return workspace_directory(root, "var")
    name = _configured_workspace_directory(root, (stat.st_ino, stat.st_mtime_ns, stat.st_size))
    return workspace_directory(root, name)


class RuntimePath(os.PathLike):
    """A deferred path for existing public path attributes; imports do no IO."""

    def __init__(self, *parts):
        self.parts = parts

    def resolve(self, *args, **kwargs):
        if self.parts[:1] == ("var",):
            return workspace_root().joinpath(*self.parts[1:]).resolve(*args, **kwargs)
        return tool_home().joinpath(*self.parts).resolve(*args, **kwargs)

    def __fspath__(self):
        return str(self.resolve())

    def __str__(self):
        return self.__fspath__()

    def __truediv__(self, other):
        return self.resolve() / other

    def __getattr__(self, name):
        return getattr(self.resolve(), name)
