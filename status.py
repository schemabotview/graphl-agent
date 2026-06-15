#!/usr/bin/env python3
"""Show which graphl-agent services are running."""
from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
RUN_DIR = ROOT / ".run"

SERVICES = {
    "launcher": 8000,
}


def alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except (ProcessLookupError, PermissionError):
        return False


def main() -> int:
    print(f"{'service':9}  {'pid':>7}  {'port':>5}  status")
    print("-" * 38)
    for name, port in SERVICES.items():
        pid_path = RUN_DIR / f"{name}.pid"
        if not pid_path.exists():
            print(f"{name:9}  {'-':>7}  {port:>5}  stopped")
            continue
        try:
            pid = int(pid_path.read_text().strip())
        except ValueError:
            print(f"{name:9}  {'?':>7}  {port:>5}  stale pidfile")
            continue
        print(f"{name:9}  {pid:>7}  {port:>5}  {'running' if alive(pid) else 'dead (stale pid)'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
