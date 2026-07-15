"""Launch independent native app processes and preserve PID/window evidence.

This harness owns and cleans up only the child processes it starts. It does not
attempt UI interaction; context-menu and tab behavior require the separate
native UI harness described by the Phase 8 test plan.
"""

from __future__ import annotations

import argparse
import ctypes
import json
import os
import subprocess
import time
from ctypes import wintypes
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def visible_windows_by_pid() -> dict[int, list[dict[str, Any]]]:
    if os.name != "nt":
        return {}
    user32 = ctypes.windll.user32
    windows: dict[int, list[dict[str, Any]]] = {}
    callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

    @callback_type
    def callback(hwnd: int, _lparam: int) -> bool:
        if not user32.IsWindowVisible(hwnd):
            return True
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        title_length = user32.GetWindowTextLengthW(hwnd)
        title_buffer = ctypes.create_unicode_buffer(title_length + 1)
        user32.GetWindowTextW(hwnd, title_buffer, title_length + 1)
        windows.setdefault(pid.value, []).append(
            {"handle": int(hwnd), "title": title_buffer.value}
        )
        return True

    user32.EnumWindows(callback, 0)
    return windows


def terminate_owned(process: subprocess.Popen[bytes], timeout: float) -> dict[str, Any]:
    if process.poll() is not None:
        return {"method": "already-exited", "exitCode": process.returncode}
    process.terminate()
    try:
        process.wait(timeout=timeout)
        return {"method": "terminate", "exitCode": process.returncode}
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=timeout)
        return {"method": "kill-after-timeout", "exitCode": process.returncode}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--executable", type=Path, required=True)
    parser.add_argument("--instances", type=int, default=5)
    parser.add_argument("--cycles", type=int, default=1)
    parser.add_argument("--hold-seconds", type=float, default=5.0)
    parser.add_argument("--cleanup-timeout", type=float, default=5.0)
    parser.add_argument("--file", type=Path, action="append", default=[])
    parser.add_argument(
        "--output", type=Path, default=Path("artifacts/phase-8/multi-process-results.json")
    )
    args = parser.parse_args()
    if args.instances < 1 or args.cycles < 1:
        parser.error("--instances and --cycles must be positive")
    executable = args.executable.resolve()
    if not executable.is_file():
        parser.error(f"executable does not exist: {executable}")

    cycles = []
    overall_pass = True
    for cycle_index in range(args.cycles):
        processes: list[subprocess.Popen[bytes]] = []
        launch_records = []
        try:
            for instance_index in range(args.instances):
                command = [str(executable)]
                assigned_file = None
                if args.file:
                    assigned_file = args.file[instance_index % len(args.file)].resolve()
                    command.append(str(assigned_file))
                process = subprocess.Popen(
                    command,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                )
                processes.append(process)
                launch_records.append(
                    {
                        "instance": instance_index + 1,
                        "pid": process.pid,
                        "file": str(assigned_file) if assigned_file else None,
                    }
                )
            time.sleep(args.hold_seconds)
            window_map = visible_windows_by_pid()
            for process, record in zip(processes, launch_records, strict=True):
                record["aliveAfterHold"] = process.poll() is None
                record["exitCodeAfterHold"] = process.poll()
                record["visibleWindows"] = window_map.get(process.pid, [])
                if not record["aliveAfterHold"]:
                    overall_pass = False
                if os.name == "nt" and not record["visibleWindows"]:
                    overall_pass = False
        finally:
            for process, record in zip(processes, launch_records, strict=True):
                record["cleanup"] = terminate_owned(process, args.cleanup_timeout)
                stdout, stderr = process.communicate()
                if stdout:
                    record["stdout"] = stdout.decode("utf-8", errors="replace")[-16384:]
                if stderr:
                    record["stderr"] = stderr.decode("utf-8", errors="replace")[-16384:]
        cycles.append({"cycle": cycle_index + 1, "instances": launch_records})

    result = {
        "schemaVersion": 1,
        "generatedAtUtc": datetime.now(timezone.utc).isoformat(),
        "status": "PASS" if overall_pass else "FAIL",
        "executable": str(executable),
        "configuration": {
            "instances": args.instances,
            "cycles": args.cycles,
            "totalInvocations": args.instances * args.cycles,
            "holdSeconds": args.hold_seconds,
        },
        "cycles": cycles,
        "limitations": [
            "Process and top-level window independence only; no native UI interaction is performed.",
            "Cleanup closes only processes launched by this harness.",
        ],
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if not overall_pass:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
