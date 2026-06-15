"""PTY-backed terminal sessions.

Each TerminalSession owns a child process attached to a pseudo-terminal.
A reader task pumps PTY output into asyncio.Queue subscribers and a small
ring buffer for replay-on-connect, so closing a browser tab does not lose
output and reopening it shows scrollback.
"""
from __future__ import annotations

import asyncio
import errno
import fcntl
import os
import pty
import signal
import struct
import termios
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

# Per-session in-memory scrollback handed to a new client on attach.
SCROLLBACK_BYTES = 256 * 1024


@dataclass
class TerminalSpec:
    kind: str               # "shell" | "aider" | "custom"
    title: str
    argv: list[str]
    cwd: Path
    env: dict[str, str] = field(default_factory=dict)


class TerminalSession:
    def __init__(self, sid: str, spec: TerminalSpec) -> None:
        self.id = sid
        self.spec = spec
        self.pid: int = -1
        self.fd: int = -1
        self.scrollback = bytearray()
        self._subscribers: set[asyncio.Queue[bytes]] = set()
        self._closed = asyncio.Event()
        self._reader_task: Optional[asyncio.Task] = None
        self.cols = 120
        self.rows = 32

    # ---------- lifecycle ----------

    def start(self) -> None:
        pid, fd = pty.fork()
        if pid == 0:
            try:
                os.chdir(str(self.spec.cwd))
            except OSError:
                pass
            env = {**os.environ, **self.spec.env}
            env.setdefault("TERM", "xterm-256color")
            env.setdefault("COLORTERM", "truecolor")
            os.execvpe(self.spec.argv[0], self.spec.argv, env)

        self.pid = pid
        self.fd = fd
        flags = fcntl.fcntl(fd, fcntl.F_GETFL)
        fcntl.fcntl(fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)
        self.resize(self.cols, self.rows)

        loop = asyncio.get_running_loop()
        self._reader_task = loop.create_task(self._read_loop())

    async def _read_loop(self) -> None:
        loop = asyncio.get_running_loop()
        future: asyncio.Future[None] = loop.create_future()

        def _on_readable() -> None:
            try:
                data = os.read(self.fd, 65536)
            except BlockingIOError:
                return
            except OSError as e:
                if e.errno in (errno.EIO, errno.EBADF):
                    self._mark_closed()
                    if not future.done():
                        future.set_result(None)
                return
            if not data:
                self._mark_closed()
                if not future.done():
                    future.set_result(None)
                return
            self._append_scrollback(data)
            for q in tuple(self._subscribers):
                if q.qsize() < 1024:
                    q.put_nowait(data)

        loop.add_reader(self.fd, _on_readable)
        try:
            await future
        finally:
            try:
                loop.remove_reader(self.fd)
            except (ValueError, KeyError):
                pass

    def _mark_closed(self) -> None:
        if self._closed.is_set():
            return
        self._closed.set()
        for q in tuple(self._subscribers):
            q.put_nowait(b"")  # sentinel

    def _append_scrollback(self, data: bytes) -> None:
        self.scrollback.extend(data)
        if len(self.scrollback) > SCROLLBACK_BYTES:
            drop = len(self.scrollback) - SCROLLBACK_BYTES
            del self.scrollback[:drop]

    # ---------- I/O ----------

    def write(self, data: bytes) -> None:
        if self.fd < 0:
            return
        try:
            os.write(self.fd, data)
        except OSError:
            self._mark_closed()

    def resize(self, cols: int, rows: int) -> None:
        if self.fd < 0:
            return
        self.cols, self.rows = cols, rows
        try:
            fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        except OSError:
            pass

    def subscribe(self) -> asyncio.Queue[bytes]:
        q: asyncio.Queue[bytes] = asyncio.Queue(maxsize=2048)
        self._subscribers.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue[bytes]) -> None:
        self._subscribers.discard(q)

    @property
    def closed(self) -> bool:
        return self._closed.is_set()

    async def close(self) -> None:
        if self.pid > 0 and not self.closed:
            try:
                os.killpg(os.getpgid(self.pid), signal.SIGHUP)
            except (ProcessLookupError, PermissionError):
                pass
        if self.fd >= 0:
            try:
                os.close(self.fd)
            except OSError:
                pass
            self.fd = -1
        self._mark_closed()
        if self._reader_task:
            try:
                await asyncio.wait_for(self._reader_task, timeout=1.0)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                pass


class TerminalManager:
    def __init__(self) -> None:
        self._sessions: dict[str, TerminalSession] = {}

    def create(self, spec: TerminalSpec) -> TerminalSession:
        sid = uuid.uuid4().hex[:8]
        session = TerminalSession(sid, spec)
        session.start()
        self._sessions[sid] = session
        return session

    def get(self, sid: str) -> Optional[TerminalSession]:
        return self._sessions.get(sid)

    def list(self) -> list[TerminalSession]:
        return list(self._sessions.values())

    async def close(self, sid: str) -> bool:
        session = self._sessions.pop(sid, None)
        if not session:
            return False
        await session.close()
        return True

    async def close_all(self) -> None:
        for sid in list(self._sessions):
            await self.close(sid)


# ---------- specs ----------

def spec_shell(cwd: Path) -> TerminalSpec:
    shell = os.environ.get("SHELL", "/bin/zsh")
    return TerminalSpec(kind="shell", title=os.path.basename(shell), argv=[shell, "-i", "-l"], cwd=cwd)
