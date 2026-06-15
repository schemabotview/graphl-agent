"""FastAPI launcher: IDE shell, workspace file API, PTY terminals."""
from __future__ import annotations

import asyncio
import json
import os
import subprocess
from pathlib import Path

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .terminals import TerminalManager, spec_shell

WORKSPACE = Path(os.environ.get("GRAPHL_WORKSPACE", Path.cwd() / "workspace")).resolve()
STATIC = Path(__file__).parent / "static"

SKIP_NAMES = {
    ".git", ".venv", "node_modules", "__pycache__", ".run", ".DS_Store",
    ".aider.tags.cache.v4", ".aider.chat.history.md",
    ".aider.input.history", ".aider.llm.history",
}
MAX_BYTES = 2 * 1024 * 1024  # refuse to load larger files into Monaco

app = FastAPI(title="graphl-agent launcher")
terminals = TerminalManager()


# ============================================================
# files
# ============================================================

def safe_path(rel: str) -> Path:
    candidate = (WORKSPACE / rel).resolve()
    try:
        candidate.relative_to(WORKSPACE)
    except ValueError:
        raise HTTPException(400, "path escapes workspace")
    return candidate


def build_tree(root: Path) -> dict:
    def node(p: Path) -> dict:
        rel = str(p.relative_to(WORKSPACE)) if p != WORKSPACE else ""
        if p.is_dir():
            children = []
            try:
                entries = sorted(p.iterdir(), key=lambda x: (x.is_file(), x.name.lower()))
            except PermissionError:
                entries = []
            for child in entries:
                if child.name in SKIP_NAMES:
                    continue
                children.append(node(child))
            return {"name": p.name or "workspace", "path": rel, "type": "dir", "children": children}
        return {"name": p.name, "path": rel, "type": "file"}

    return node(root)


@app.get("/api/healthz")
def healthz():
    return {"ok": True, "workspace": str(WORKSPACE)}


@app.get("/api/files/tree")
def files_tree():
    return build_tree(WORKSPACE)


# ============================================================
# workspace root (swappable)
# ============================================================

class WorkspaceBody(BaseModel):
    path: str


@app.get("/api/workspace")
def workspace_get():
    return {"path": str(WORKSPACE)}


@app.post("/api/workspace")
def workspace_set(body: WorkspaceBody):
    global WORKSPACE
    p = Path(body.path).expanduser().resolve()
    if not p.exists():
        raise HTTPException(404, f"path does not exist: {p}")
    if not p.is_dir():
        raise HTTPException(400, f"not a directory: {p}")
    WORKSPACE = p
    return {"path": str(WORKSPACE)}


@app.get("/api/workspace/pick")
async def workspace_pick():
    # Native macOS folder picker. `tell me to activate` foregrounds the
    # osascript process so the dialog doesn't open behind the browser.
    try:
        result = await asyncio.to_thread(
            subprocess.run,
            [
                "osascript",
                "-e", "tell me to activate",
                "-e", 'POSIX path of (choose folder with prompt "Pick a workspace folder")',
            ],
            capture_output=True, text=True, timeout=300,
        )
    except FileNotFoundError:
        raise HTTPException(501, "osascript not available (macOS only)")
    except subprocess.TimeoutExpired:
        raise HTTPException(504, "folder picker timed out")
    if result.returncode != 0:
        return {"cancelled": True}
    path = result.stdout.strip().rstrip("/")
    if not path:
        return {"cancelled": True}
    return {"path": path}


@app.get("/api/files/content")
def files_content(path: str):
    p = safe_path(path)
    if not p.is_file():
        raise HTTPException(404, "not a file")
    if p.stat().st_size > MAX_BYTES:
        raise HTTPException(413, "file too large")
    try:
        return {"path": path, "content": p.read_text(), "binary": False}
    except UnicodeDecodeError:
        return JSONResponse({"path": path, "content": "", "binary": True})


class SaveBody(BaseModel):
    path: str
    content: str


@app.put("/api/files/content")
def files_save(body: SaveBody):
    p = safe_path(body.path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(body.content)
    return {"ok": True, "bytes": len(body.content)}


# ============================================================
# terminals
# ============================================================

class NewTerminalBody(BaseModel):
    kind: str = "shell"
    title: str | None = None


def _session_dto(s) -> dict:
    return {
        "id": s.id,
        "kind": s.spec.kind,
        "title": s.spec.title,
        "closed": s.closed,
    }


@app.get("/api/terminals")
def terminals_list():
    return [_session_dto(s) for s in terminals.list()]


@app.post("/api/terminals")
async def terminals_create(body: NewTerminalBody):
    if body.kind != "shell":
        raise HTTPException(400, f"unknown kind: {body.kind}")
    spec = spec_shell(WORKSPACE)
    if body.title:
        spec.title = body.title
    session = terminals.create(spec)
    return _session_dto(session)


@app.delete("/api/terminals/{sid}")
async def terminals_delete(sid: str):
    ok = await terminals.close(sid)
    if not ok:
        raise HTTPException(404, "no such terminal")
    return {"ok": True}


@app.websocket("/ws/terminal/{sid}")
async def terminal_ws(ws: WebSocket, sid: str):
    session = terminals.get(sid)
    if not session:
        await ws.close(code=4404)
        return
    await ws.accept()

    if session.scrollback:
        try:
            await ws.send_bytes(bytes(session.scrollback))
        except Exception:
            return

    queue = session.subscribe()

    async def pump_out():
        try:
            while True:
                chunk = await queue.get()
                if not chunk:  # session closed sentinel
                    try:
                        await ws.send_json({"type": "exit"})
                    except Exception:
                        pass
                    return
                await ws.send_bytes(chunk)
        except Exception:
            return

    out_task = asyncio.create_task(pump_out())
    try:
        while True:
            msg = await ws.receive()
            if msg.get("type") == "websocket.disconnect":
                break
            if "bytes" in msg and msg["bytes"] is not None:
                session.write(msg["bytes"])
            elif "text" in msg and msg["text"] is not None:
                # Control channel: {"type":"resize","cols":120,"rows":32} or {"type":"input","data":"..."}
                try:
                    payload = json.loads(msg["text"])
                except json.JSONDecodeError:
                    session.write(msg["text"].encode())
                    continue
                kind = payload.get("type")
                if kind == "resize":
                    session.resize(int(payload["cols"]), int(payload["rows"]))
                elif kind == "input":
                    session.write(payload.get("data", "").encode())
    except WebSocketDisconnect:
        pass
    finally:
        session.unsubscribe(queue)
        out_task.cancel()


# ============================================================
# static
# ============================================================

@app.get("/")
def root():
    return FileResponse(STATIC / "index.html")


app.mount("/static", StaticFiles(directory=str(STATIC)), name="static")


@app.on_event("shutdown")
async def _shutdown() -> None:
    await terminals.close_all()
