from __future__ import annotations

import argparse
import ctypes
import ctypes.wintypes
import time
from pathlib import Path


user32 = ctypes.windll.user32
BM_CLICK = 0x00F5
WM_SETTEXT = 0x000C
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("process_id", type=int)
    parser.add_argument("path", type=Path)
    args = parser.parse_args()
    path = args.path.resolve()

    app = find_window(args.process_id, "Data Viewer", timeout=5)
    rect = ctypes.wintypes.RECT()
    if not user32.GetWindowRect(app, ctypes.byref(rect)):
        raise ctypes.WinError()
    user32.SetForegroundWindow(app)
    user32.SetCursorPos(rect.right - 70, rect.top + 58)
    user32.mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)
    user32.mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)

    dialog = find_window(args.process_id, None, timeout=5, exclude_title="Data Viewer")
    combo_ex = user32.GetDlgItem(dialog, 1148)
    combo = user32.FindWindowExW(combo_ex, 0, "ComboBox", None)
    edit = user32.FindWindowExW(combo, 0, "Edit", None)
    open_button = user32.GetDlgItem(dialog, 1)
    if not edit or not open_button:
        raise RuntimeError("Native dialog file controls were not found")

    user32.SendMessageW(edit, WM_SETTEXT, 0, str(path))
    user32.SendMessageW(open_button, BM_CLICK, 0, 0)
    restored = find_window(args.process_id, "Data Viewer", timeout=8)
    print(f"path={path} dialog={dialog} restored={restored}")


def find_window(
    process_id: int,
    title: str | None,
    timeout: float,
    exclude_title: str | None = None,
) -> int:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        matches: list[int] = []

        @ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
        def visit(handle: int, _: int) -> bool:
            owner = ctypes.wintypes.DWORD()
            user32.GetWindowThreadProcessId(handle, ctypes.byref(owner))
            if owner.value != process_id or not user32.IsWindowVisible(handle):
                return True
            length = user32.GetWindowTextLengthW(handle)
            buffer = ctypes.create_unicode_buffer(length + 1)
            user32.GetWindowTextW(handle, buffer, length + 1)
            if title is not None and buffer.value != title:
                return True
            if exclude_title is not None and buffer.value == exclude_title:
                return True
            if buffer.value:
                matches.append(handle)
                return False
            return True

        user32.EnumWindows(visit, 0)
        if matches:
            return matches[0]
        time.sleep(0.1)
    raise TimeoutError(f"Window not found for process {process_id}")


if __name__ == "__main__":
    main()
