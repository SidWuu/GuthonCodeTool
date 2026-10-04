"""Retain semantic error codes without overloading SystemExit's exit payload."""
from __future__ import annotations

import re


class CommandError(SystemExit):
    def __init__(self, error_code, message):
        super().__init__(message)
        self.error_code = error_code


def error_code(error, default="COMMAND_FAILED"):
    explicit = getattr(error, "error_code", None)
    if explicit:
        return explicit
    value = getattr(error, "code", None)
    # SystemExit.code is a native exit status or human message, not a domain code.
    if not isinstance(error, SystemExit) and isinstance(value, str) and re.fullmatch(r"[A-Z][A-Z0-9_]*", value):
        return value
    return default
