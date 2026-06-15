# graphl-agent

A local browser-based IDE that wraps [aider](https://aider.chat) against a local LLM served by Ollama. Single-machine, no cloud, no auth. Open `http://localhost:8000` and you get a file tree, Monaco editor, and a tabbed terminal panel — and aider runs in any terminal tab on demand.

## How it runs

```
              browser  (http://localhost:8000)
                 │
   ┌─────────────┴──────────────────────────────────┐
   │  FastAPI launcher  (single process, 127.0.0.1) │
   │   ├─ /                static IDE shell         │
   │   ├─ /api/files       tree + read + save       │
   │   ├─ /api/terminals   spawn / list / close PTY │
   │   └─ /ws/terminal/{id} bidirectional PTY bytes │
   └─────────────┬──────────────────────────────────┘
                 │ spawns PTY children
        ┌────────┴────────┐
        zsh           aider CLI ──► Ollama (localhost:11434)
                                    model: qwen2.5-coder:7b
```

Aider is launched **as a CLI inside a PTY tab**, not as a separate web service. Open a `+ shell` tab and run `aiderx` — an alias defined in `~/.zshrc` that bakes in `--model ollama_chat/qwen2.5-coder:7b --no-auto-commits --pretty` and `OLLAMA_API_BASE=http://localhost:11434`. The launcher itself only knows about `kind: "shell"`; aider is not a first-class tab kind.

## Daily routine

```bash
cd ~/Projects/graphl-agent
./start.py        # spawns launcher detached, opens browser, exits in ~1s
                  # — close the terminal; launcher keeps running
./status.py       # check what's running
./stop.py         # shut everything down
```

`start.py` uses `start_new_session=True` to detach the launcher from the spawning shell, so closing the terminal does not kill it. PIDs go to `.run/<svc>.pid`, logs to `.run/<svc>.log`.

## Project layout

```
graphl-agent/
├── start.py / stop.py / status.py    ← service control
├── requirements.txt                  ← fastapi, uvicorn, pydantic
├── CLAUDE.md                         ← this file
├── 01-ollama-setup.md                ← reference docs
├── launcher/
│   ├── main.py                       ← FastAPI app
│   ├── terminals.py                  ← PTY manager + session ring buffer
│   └── static/
│       ├── index.html
│       ├── app.js                    ← file tree, Monaco, xterm tabs
│       └── style.css
├── workspace/                        ← aider's working dir (git-init'd, gitignored)
├── .venv/                            ← created on first run
└── .run/                             ← pidfiles + logs
```

## Stack

- **Backend:** Python 3.13, FastAPI, uvicorn, Python stdlib `pty`. No `aider` Python deps — aider is invoked as a subprocess.
- **Frontend:** plain HTML/CSS/JS (no build step). Monaco from CDN. xterm.js + addon-fit + addon-web-links from CDN.
- **External:** Ollama (`brew services start ollama`) serving `qwen2.5-coder:7b`. Aider installed via brew (`/opt/homebrew/bin/aider`).

## Conventions

- All file/PTY ops are scoped to `workspace/`. `safe_path()` in `launcher/main.py` rejects anything that resolves outside.
- Terminal sessions live in-memory in `TerminalManager`. They are **not** persisted — restarting the launcher drops them all.
- Each session keeps a 256 KB scrollback ring buffer that is replayed to a (re)connecting WebSocket.
- The launcher binds `127.0.0.1` only. Do not expose to the LAN — PTYs are unauthenticated shell access.
- Monaco max file size: 2 MB. Binary files are detected via `UnicodeDecodeError` and refused.

## Known gotchas

- **Script order in `index.html` matters.** xterm UMD must load before Monaco's `loader.js`, because Monaco defines an AMD `define()` and xterm's UMD probes for that — under AMD it registers but never publishes `window.Terminal`.
- **Streamlit aider is removed.** Don't reintroduce `--browser` / `uvx aider-chat[browser]` — we got off it for a reason (122-dep install, Python 3.13 `audioop` removal, port collisions, iframe SCP issues).

## Browser-side persistence

Two `localStorage` keys hold UI state across reloads:

- **`graphl.tabs.v1`** — `{ ids: string[], activeId: string|null }`. On load, `reattachExistingTerminals()` fetches `/api/terminals`, intersects with the saved IDs, and reattaches via new WebSockets (server replays each session's 256 KB scrollback). Only when the intersection is empty does a fresh shell get spawned. This is what prevents the old "every reload leaks a PTY" bug — don't break it.
- **`graphl.layout.v1`** — `{ treeW: number, bottomH: number }`. Restored on load via `applyLayout()`. Defaults: tree 220 px, bottom 320 px. Clamps: tree 140–500 px, bottom 100 px – 70% of viewport height. Double-click a divider to reset that axis.

## When extending

- New backend endpoints: add to `launcher/main.py`. Keep handlers `async def` if they touch `terminals` (the PTY manager assumes a running event loop).
- New frontend behavior: edit `launcher/static/app.js`. Avoid frameworks; this is intentionally a plain JS file.
- New CLI tabs (e.g., `+ python`, `+ pytest`): add a `spec_xxx()` factory to `launcher/terminals.py` and a kind branch in `terminals_create()`.
- Heavy refactors (resizable panes, drag-and-drop tabs, custom aider chat UI bypassing Streamlit) should be discussed first — they materially change the architecture.

## Notes for Claude

- This is a personal project, single-user, single-machine. Skip auth, RBAC, multi-tenant patterns, retry/circuit-breaker layers, error-handling for impossible cases.
- Prefer editing existing files. Don't create README.md, ARCHITECTURE.md, or sibling docs unless asked.
- Don't write multi-line comment blocks. Default to no comments; explain WHY only when non-obvious.
- Before suggesting a new dep, check if stdlib + what's installed already covers it.
- When verifying changes, prefer hitting the running launcher's endpoints (`curl http://localhost:8000/api/...`) over starting a second instance.
- Use `./stop.py` before changing `launcher/` Python files — `--reload` is intentionally not enabled.
