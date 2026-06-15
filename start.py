#!/usr/bin/env python3
"""Launch the graphl-agent IDE.

Spawns one detached service and opens the browser:
  - launcher   (FastAPI + static IDE + PTY terminals)   127.0.0.1:8000

Aider runs inside the browser terminal tabs — open a "+ shell" and type
`aiderx` (alias defined in ~/.zshrc). Close the terminal after this
script exits — the launcher keeps running. Use stop.py to terminate it.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import time
import urllib.request
import venv
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
WORKSPACE = ROOT / "workspace"
RUN_DIR = ROOT / ".run"
VENV_DIR = ROOT / ".venv"

LAUNCHER_PORT = 8000
OLLAMA_URL = "http://localhost:11434"

SERVICES = ("launcher",)


def info(msg: str) -> None:
    print(f"  {msg}")


def die(msg: str) -> None:
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(1)


def check_prereqs() -> None:
    for tool in ("aider", "ollama"):
        if shutil.which(tool) is None:
            die(f"`{tool}` not found on PATH. Install it (see 01-ollama-setup.md).")
    try:
        with urllib.request.urlopen(f"{OLLAMA_URL}/api/tags", timeout=2):
            pass
    except Exception:
        die(f"Ollama is not responding at {OLLAMA_URL}. Run `brew services start ollama`.")


def ensure_dirs() -> None:
    RUN_DIR.mkdir(exist_ok=True)
    WORKSPACE.mkdir(exist_ok=True)
    if not (WORKSPACE / ".git").exists():
        subprocess.run(["git", "init", "-q"], cwd=WORKSPACE, check=True)


def already_running() -> list[str]:
    alive: list[str] = []
    for svc in SERVICES:
        pid_file = RUN_DIR / f"{svc}.pid"
        if not pid_file.exists():
            continue
        try:
            pid = int(pid_file.read_text().strip())
            os.kill(pid, 0)
            alive.append(f"{svc}(pid={pid})")
        except (ValueError, ProcessLookupError, PermissionError):
            pid_file.unlink(missing_ok=True)
    return alive


def ensure_venv() -> Path:
    python_bin = VENV_DIR / "bin" / "python"
    if not python_bin.exists():
        info("creating .venv …")
        venv.create(VENV_DIR, with_pip=True, clear=False)
    requirements = ROOT / "requirements.txt"
    marker = VENV_DIR / ".deps-installed"
    needs_install = (not marker.exists()) or marker.stat().st_mtime < requirements.stat().st_mtime
    if needs_install:
        info("installing launcher deps …")
        subprocess.run(
            [str(python_bin), "-m", "pip", "install", "-q", "-r", str(requirements)],
            check=True,
        )
        marker.touch()
    return python_bin


def spawn(name: str, argv: list[str], cwd: Path, env: dict[str, str] | None = None) -> int:
    log_path = RUN_DIR / f"{name}.log"
    pid_path = RUN_DIR / f"{name}.pid"
    log_fd = open(log_path, "ab", buffering=0)
    proc = subprocess.Popen(
        argv,
        cwd=str(cwd),
        env={**os.environ, **(env or {})},
        stdin=subprocess.DEVNULL,
        stdout=log_fd,
        stderr=log_fd,
        start_new_session=True,
    )
    pid_path.write_text(str(proc.pid))
    return proc.pid


def wait_for(url: str, timeout: float = 30.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=1):
                return True
        except Exception:
            time.sleep(0.4)
    return False


def main() -> int:
    print("graphl-agent starting …")
    check_prereqs()
    ensure_dirs()

    if running := already_running():
        die(f"already running: {', '.join(running)}. Run `python stop.py` first.")

    python_bin = ensure_venv()

    info("spawning launcher …")
    spawn(
        "launcher",
        [
            str(python_bin), "-m", "uvicorn",
            "launcher.main:app",
            "--host", "127.0.0.1",
            "--port", str(LAUNCHER_PORT),
            "--log-level", "warning",
        ],
        cwd=ROOT,
        env={
            "GRAPHL_WORKSPACE": str(WORKSPACE),
        },
    )

    info("waiting for launcher …")
    if not wait_for(f"http://127.0.0.1:{LAUNCHER_PORT}/api/healthz", timeout=30):
        die("launcher did not become healthy within 30s — check .run/launcher.log")

    url = f"http://localhost:{LAUNCHER_PORT}"
    print(f"\n  IDE     {url}")
    print(f"  logs    {RUN_DIR}")
    print("\n  Close this terminal — launcher keeps running. `python stop.py` to shut down.\n")

    webbrowser.open(url)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
