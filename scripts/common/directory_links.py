"""Directory aliases for the DATABASE readonly mirror."""

import os


def is_directory_link(path):
    return path.is_symlink() or (os.name == "nt" and os.path.isjunction(path))


def create_directory_link(link, target):
    if os.name != "nt":
        link.symlink_to(os.path.relpath(target, link.parent), target_is_directory=True)
        return

    import ctypes
    import stat
    import struct
    from ctypes import wintypes

    if not target.is_absolute() or not target.drive.endswith(":"):
        raise OSError("Windows 目录联接的目标须位于本地卷")
    target_name = str(target).removeprefix("\\\\?\\")

    # MountPointReparseBuffer offsets and lengths count bytes, excluding each NUL.
    substitute_name = ("\\??\\" + target_name).encode("utf-16-le")
    print_name = target_name.encode("utf-16-le")
    names = substitute_name + b"\0\0" + print_name + b"\0\0"
    header = struct.pack(
        "<I6H", stat.IO_REPARSE_TAG_MOUNT_POINT, 8 + len(names), 0,
        0, len(substitute_name), len(substitute_name) + 2, len(print_name),
    )
    data = header + names

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateFileW.argtypes = (
        wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, wintypes.LPVOID,
        wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE,
    )
    kernel.CreateFileW.restype = wintypes.HANDLE
    kernel.DeviceIoControl.argtypes = (
        wintypes.HANDLE, wintypes.DWORD, wintypes.LPCVOID, wintypes.DWORD,
        wintypes.LPVOID, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD), wintypes.LPVOID,
    )
    kernel.DeviceIoControl.restype = wintypes.BOOL
    kernel.CloseHandle.argtypes = (wintypes.HANDLE,)
    kernel.CloseHandle.restype = wintypes.BOOL

    generic_write, open_existing = 0x40000000, 3
    open_reparse_point, backup_semantics = 0x00200000, 0x02000000
    set_reparse_point = 0x000900A4
    link.mkdir()
    # Open the new directory itself so the reparse point is set on the alias.
    handle = kernel.CreateFileW(
        str(link), generic_write, 0, None, open_existing, open_reparse_point | backup_semantics, None,
    )
    if handle == ctypes.c_void_p(-1).value:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        returned = wintypes.DWORD()
        if not kernel.DeviceIoControl(handle, set_reparse_point, data, len(data), None, 0, ctypes.byref(returned), None):
            raise ctypes.WinError(ctypes.get_last_error())
    finally:
        kernel.CloseHandle(handle)
