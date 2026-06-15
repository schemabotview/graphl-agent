# 01 — Ollama Setup

Run open-source LLMs locally on macOS with [Ollama](https://ollama.com). Ollama bundles `llama.cpp` with a friendly CLI, an HTTP API, and a model registry — the fastest path to a working local LLM on Apple Silicon.

---

## 1. Install

### Option A — Homebrew (recommended)

```bash
brew install ollama
```

### Option B — Official installer

Download the macOS app from https://ollama.com/download. The `.dmg` installs both the menu-bar app and the `ollama` CLI.

### Verify

```bash
ollama --version
# ollama version is 0.21.0  (or newer)
```

---

## 2. Start the server

Ollama needs a background server (`ollama serve`) running before you can chat or hit the API.

### If installed via Homebrew

```bash
# Start in foreground (Ctrl+C to stop)
ollama serve

# Or run as a background service that auto-starts on login
brew services start ollama
brew services stop ollama     # to stop
```

### If installed via the macOS app

Launching the Ollama app from `/Applications` starts the server automatically; you'll see the llama icon in the menu bar.

### Confirm it's up

```bash
curl http://localhost:11434/api/tags
# {"models":[ ... ]}
```

Default port: `11434`.

---

## 3. Pull a model

Browse the library at https://ollama.com/library.

```bash
# Coding-focused (primary model for this setup)
ollama pull qwen2.5-coder:7b    # ~4.7 GB

# Other options to consider later
ollama pull llama3.2:3b         # ~2 GB, great for quick experiments
ollama pull mistral:7b          # ~4 GB, general-purpose
ollama pull deepseek-coder-v2:16b   # larger coder model
```

Already pulled on this machine:

```bash
ollama list
# qwen2.5-coder:7b    4.7 GB
```

> **Storage:** Models live in `~/.ollama/models`. They're large — don't commit them, and keep an eye on disk space with `du -sh ~/.ollama/models`.

---

## 4. Chat from the CLI

```bash
# Interactive chat
ollama run qwen2.5-coder:7b

# One-shot prompt
ollama run qwen2.5-coder:7b "Write a Python function to debounce calls."

# Pipe a file in
cat main.py | ollama run qwen2.5-coder:7b "Review this code:"
```

Inside the interactive session, useful commands:

| Command | What it does |
|---|---|
| `/?` | Show help |
| `/set system <msg>` | Set system prompt |
| `/show info` | Show model details (params, quantization, context size) |
| `/bye` | Exit |

---

## 5. Use the HTTP API

Ollama exposes an OpenAI-compatible API plus its own native API on `http://localhost:11434`.

### Native API — `/api/generate` (completion)

```bash
curl http://localhost:11434/api/generate -d '{
  "model": "qwen2.5-coder:7b",
  "prompt": "Write a Python one-liner to flatten a nested list.",
  "stream": false
}'
```

### Native API — `/api/chat` (chat)

```bash
curl http://localhost:11434/api/chat -d '{
  "model": "qwen2.5-coder:7b",
  "messages": [{"role": "user", "content": "Hello!"}],
  "stream": false
}'
```

### OpenAI-compatible endpoint

Point any OpenAI SDK at `http://localhost:11434/v1` with a dummy API key:

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:11434/v1",
    api_key="ollama",  # required by SDK, ignored by Ollama
)

resp = client.chat.completions.create(
    model="qwen2.5-coder:7b",
    messages=[{"role": "user", "content": "Hi"}],
)
print(resp.choices[0].message.content)
```

---

## 6. Python client

```bash
pip install ollama
```

```python
import ollama

resp = ollama.chat(
    model="qwen2.5-coder:7b",
    messages=[{"role": "user", "content": "Write a Python function to debounce calls."}],
)
print(resp["message"]["content"])
```

Streaming:

```python
for chunk in ollama.chat(
    model="qwen2.5-coder:7b",
    messages=[{"role": "user", "content": "Explain Python decorators with an example."}],
    stream=True,
):
    print(chunk["message"]["content"], end="", flush=True)
```

---

## 7. Pick the right model size

Rough guide for Apple Silicon Macs:

| Free RAM | Comfortable model size |
|---|---|
| 8 GB | 1B–3B (e.g., `llama3.2:1b`, `gemma2:2b`) |
| 16 GB | 7B–8B (e.g., `qwen2.5-coder:7b`, `llama3.1:8b`) |
| 32 GB | 13B–14B (e.g., `deepseek-coder-v2:16b`) |
| 64 GB+ | 30B–70B quantized |

Check your free memory before pulling a large model: `vm_stat` or Activity Monitor → Memory.

---

## 8. Customize a model (Modelfile)

Create a custom variant with a baked-in system prompt:

```dockerfile
# ./Modelfile
FROM qwen2.5-coder:7b
SYSTEM "You are a terse senior engineer. Answer in <=3 sentences. Code only when asked, no fluff."
PARAMETER temperature 0.3
```

```bash
ollama create terse-coder -f Modelfile
ollama run terse-coder "Explain async/await."
```

---

## 9. Common ops

```bash
ollama list                  # installed models
ollama ps                    # currently loaded in memory
ollama rm <model>            # delete a model
ollama show qwen2.5-coder:7b       # show config (context, params, quant)
ollama cp qwen2.5-coder:7b mybase  # copy/rename
```

Change the storage location (e.g., to an external SSD):

```bash
export OLLAMA_MODELS=/Volumes/ExtSSD/ollama/models
# Add to ~/.zshrc to persist
```

Expose the server on the LAN (use cautiously — no auth):

```bash
export OLLAMA_HOST=0.0.0.0:11434
ollama serve
```

---

## 10. Troubleshooting

| Symptom | Fix |
|---|---|
| `Error: could not connect to ollama app` | Start the server: `ollama serve` or `brew services start ollama` |
| Port `11434` already in use | `lsof -i :11434` → kill the stray process, or set `OLLAMA_HOST=127.0.0.1:11500` |
| Out of memory / very slow | Use a smaller model, close other apps, or pull a more aggressive quantization (e.g., `:q4_K_M` vs `:q8_0`) |
| `ollama list` empty after `pull` | Check `~/.ollama/models` permissions; re-run `pull` |
| Want to free disk | `ollama rm <unused-model>` |

---

## Next steps

- `02-` — wire Ollama into a simple Python app (chat loop, streaming, tool use)
- `03-` — try MLX for native Apple-Silicon-optimized inference
- `04-` — build a tiny RAG pipeline over local docs
