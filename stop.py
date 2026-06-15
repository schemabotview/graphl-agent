#!/usr/bin/env python3
"""Stop services launched by start.py."""
from __future__ import annotations

import os
import signal
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
RUN_DIR = ROOT / ".run"
SERVICES = ("launcher",)


def kill(pid: int, sig: int) -> bool:
    try:
        os.killpg(os.getpgid(pid), sig)
        return True
    except (ProcessLookupError, PermissionError):
        return False


def stop(name: str) -> str:
    pid_path = RUN_DIR / f"{name}.pid"
    if not pid_path.exists():
        return "not running"
    try:
        pid = int(pid_path.read_text().strip())
    except ValueError:
        pid_path.unlink(missing_ok=True)
        return "stale pidfile"

    if not kill(pid, signal.SIGTERM):
        pid_path.unlink(missing_ok=True)
        return "already gone"

    for _ in range(20):
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            pid_path.unlink(missing_ok=True)
            return f"stopped (pid={pid})"
        time.sleep(0.2)

    kill(pid, signal.SIGKILL)
    pid_path.unlink(missing_ok=True)
    return f"killed (pid={pid})"


def main() -> int:
    if not RUN_DIR.exists():
        print("nothing to stop.")
        return 0
    # legacy services from earlier versions
    for legacy in ("ttyd", "aider"):
        if (RUN_DIR / f"{legacy}.pid").exists():
            print(f"  {legacy:9} {stop(legacy)}")
    for svc in SERVICES:
        print(f"  {svc:9} {stop(svc)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
