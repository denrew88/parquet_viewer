from __future__ import annotations

import argparse
import ctypes
import ctypes.wintypes
import subprocess
import time
from pathlib import Path

from PIL import ImageGrab


user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32


def clipboard_text() -> str:
    if not user32.OpenClipboard(0):
        raise ctypes.WinError()
    try:
        user32.GetClipboardData.restype = ctypes.c_void_p
        handle = user32.GetClipboardData(13)
        if not handle:
            raise RuntimeError("Clipboard does not contain Unicode text")
        kernel32.GlobalLock.restype = ctypes.c_void_p
        pointer = kernel32.GlobalLock(ctypes.c_void_p(handle))
        if not pointer:
            raise ctypes.WinError()
        try:
            return ctypes.wstring_at(pointer)
        finally:
            kernel32.GlobalUnlock(ctypes.c_void_p(handle))
    finally:
        user32.CloseClipboard()


def find_window(process_id: int, timeout: float) -> tuple[int, str]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        match: list[tuple[int, str]] = []

        @ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
        def visit(handle: int, _: int) -> bool:
            owner = ctypes.c_ulong()
            user32.GetWindowThreadProcessId(handle, ctypes.byref(owner))
            if owner.value == process_id and user32.IsWindowVisible(handle):
                length = user32.GetWindowTextLengthW(handle)
                title = ctypes.create_unicode_buffer(length + 1)
                user32.GetWindowTextW(handle, title, length + 1)
                if title.value:
                    match.append((handle, title.value))
                    return False
            return True

        user32.EnumWindows(visit, 0)
        if match:
            return match[0]
        time.sleep(0.25)

    raise TimeoutError(f"No visible window found for process {process_id}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("process_id", type=int, nargs="?")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--executable", type=Path)
    parser.add_argument("--file", type=Path, action="append", default=[])
    parser.add_argument("--timeout", type=float, default=10)
    parser.add_argument("--no-focus", action="store_true")
    parser.add_argument("--width", type=int)
    parser.add_argument("--height", type=int)
    parser.add_argument("--right-click", type=int, nargs=2, metavar=("X", "Y"))
    parser.add_argument("--click-after-right-click", type=int, nargs=2, metavar=("X", "Y"))
    parser.add_argument("--print-clipboard", action="store_true")
    parser.add_argument("--settle-seconds", type=float, default=2.0)
    parser.add_argument("--isolate-foreground", action="store_true")
    args = parser.parse_args()

    if (args.process_id is None) == (args.executable is None):
        parser.error("provide exactly one of process_id or --executable")
    if args.click_after_right_click is not None and args.right_click is None:
        parser.error("--click-after-right-click requires --right-click")

    owned_process: subprocess.Popen[bytes] | None = None
    process_id = args.process_id
    if args.executable is not None:
        executable = args.executable.resolve()
        if not executable.is_file():
            parser.error(f"executable does not exist: {executable}")
        command = [str(executable), *(str(path.resolve()) for path in args.file)]
        owned_process = subprocess.Popen(command)
        process_id = owned_process.pid

    hidden_foreground: int | None = None
    try:
        assert process_id is not None
        handle, title = find_window(process_id, args.timeout)
        if args.isolate_foreground:
            foreground = user32.GetForegroundWindow()
            if foreground and foreground != handle:
                user32.ShowWindow(foreground, 6)
                hidden_foreground = foreground
                time.sleep(1)
        if args.width is not None or args.height is not None:
            if args.width is None or args.height is None:
                parser.error("--width and --height must be provided together")
            if not user32.SetWindowPos(handle, 0, 0, 0, args.width, args.height, 0x0002 | 0x0004):
                raise ctypes.WinError()
            time.sleep(1)
        if not args.no_focus:
            user32.ShowWindow(handle, 9)
            if not user32.SetWindowPos(
                handle, ctypes.c_void_p(-1), 0, 0, 0, 0, 0x0001 | 0x0002
            ):
                raise ctypes.WinError()
            user32.SetForegroundWindow(handle)
            time.sleep(args.settle_seconds)
        rect = ctypes.wintypes.RECT()
        if not user32.GetWindowRect(handle, ctypes.byref(rect)):
            raise ctypes.WinError()

        if args.right_click is not None:
            x, y = args.right_click
            user32.SetCursorPos(rect.left + x, rect.top + y)
            user32.mouse_event(0x0008, 0, 0, 0, 0)
            user32.mouse_event(0x0010, 0, 0, 0, 0)
            time.sleep(1)
            if args.click_after_right_click is not None:
                x, y = args.click_after_right_click
                user32.SetCursorPos(rect.left + x, rect.top + y)
                user32.mouse_event(0x0002, 0, 0, 0, 0)
                user32.mouse_event(0x0004, 0, 0, 0, 0)
                time.sleep(1)
        else:
            user32.SetCursorPos(rect.right - 12, rect.top + 12)
            time.sleep(2)

        args.output.parent.mkdir(parents=True, exist_ok=True)
        image = ImageGrab.grab(bbox=(rect.left, rect.top, rect.right, rect.bottom), all_screens=True)
        image.save(args.output)
        print(f"{title}\t{image.width}x{image.height}\t{args.output.resolve()}")
        if args.print_clipboard:
            print(f"clipboard={clipboard_text()!r}")
    finally:
        if hidden_foreground is not None:
            user32.ShowWindow(hidden_foreground, 9)
        if owned_process is not None and owned_process.poll() is None:
            owned_process.terminate()
            try:
                owned_process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                owned_process.kill()
                owned_process.wait(timeout=5)


if __name__ == "__main__":
    main()
