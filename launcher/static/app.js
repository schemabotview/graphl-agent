// graphl-agent IDE shell: file tree + Monaco + xterm tabs.

const $ = (sel) => document.querySelector(sel);

const state = {
  editor: null,
  openPath: null,
  dirty: false,
  activeRow: null,
  // terminal state
  tabs: new Map(),   // id -> { term, fitAddon, ws, wrap, tabEl, kind, title, dead }
  activeTabId: null,
};

// ---------- Monaco bootstrap ----------

require.config({ paths: { vs: "https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs" } });
require(["vs/editor/editor.main"], () => {
  monaco.editor.defineTheme("graphl-darcula", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "",                  foreground: "a9b7c6", background: "2b2b2b" },
      { token: "comment",           foreground: "808080", fontStyle: "italic" },
      { token: "keyword",           foreground: "cc7832", fontStyle: "bold" },
      { token: "string",            foreground: "6a8759" },
      { token: "number",            foreground: "6897bb" },
      { token: "type",              foreground: "ffc66d" },
      { token: "type.identifier",   foreground: "ffc66d" },
      { token: "delimiter",         foreground: "a9b7c6" },
      { token: "tag",               foreground: "e8bf6a" },
      { token: "attribute.name",    foreground: "bababa" },
      { token: "attribute.value",   foreground: "6a8759" },
      // markdown — Darcula treats headings as italic purple
      { token: "keyword.md",        foreground: "cc7832" },
      { token: "string.md",         foreground: "a9b7c6" },
      { token: "string.link.md",    foreground: "287bde" },
      { token: "strong.md",         foreground: "cc7832", fontStyle: "bold" },
      { token: "emphasis.md",       foreground: "9876aa", fontStyle: "italic" },
      { token: "header.md",         foreground: "9876aa", fontStyle: "italic" },
      { token: "metatag.html",      foreground: "808080" },
    ],
    colors: {
      "editor.background":              "#2b2b2b",
      "editor.foreground":              "#a9b7c6",
      "editorLineNumber.foreground":    "#606366",
      "editorLineNumber.activeForeground": "#a4a3a3",
      "editor.selectionBackground":     "#214283",
      "editor.lineHighlightBackground": "#323232",
      "editorCursor.foreground":        "#a9b7c6",
      "editorIndentGuide.background":   "#404040",
      "editorIndentGuide.activeBackground": "#5e5e5e",
      "editorGutter.background":        "#313335",
      "editorWhitespace.foreground":    "#404040",
    },
  });

  state.editor = monaco.editor.create($("#editor"), {
    value: "// open a file from the tree on the left\n",
    language: "javascript",
    theme: "graphl-darcula",
    automaticLayout: true,
    minimap: { enabled: false },
    fontSize: 15,
    fontFamily: "'JetBrains Mono', Menlo, Monaco, 'Courier New', monospace",
    fontLigatures: true,
    scrollBeyondLastLine: false,
  });
  state.editor.onDidChangeModelContent(() => {
    if (state.openPath && !state.dirty) setDirty(true);
  });
  state.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, saveCurrent);
});

// ---------- File tree ----------

async function loadTree() {
  const tree = await fetch("/api/files/tree").then((r) => r.json());
  $("#tree").innerHTML = "";
  $("#tree").appendChild(renderNode(tree, true));
}

function renderNode(node, isRoot = false) {
  const li = document.createElement("li");
  li.className = node.type === "dir" ? "dir" : "file";
  if (isRoot) li.classList.add("open");

  const row = document.createElement("div");
  row.className = "row";
  row.innerHTML = node.type === "dir"
    ? `<i class="codicon codicon-folder"></i><i class="codicon codicon-folder-opened"></i><span class="name"></span>`
    : `<i class="codicon ${fileIconClass(node.name)}"></i><span class="name"></span>`;
  row.querySelector(".name").textContent = node.name;
  li.appendChild(row);

  if (node.type === "dir") {
    const ul = document.createElement("ul");
    if (!isRoot) ul.style.display = "none";
    for (const child of node.children || []) ul.appendChild(renderNode(child));
    li.appendChild(ul);
    row.addEventListener("click", () => {
      li.classList.toggle("open");
      ul.style.display = li.classList.contains("open") ? "" : "none";
    });
  } else {
    row.addEventListener("click", () => openFile(node.path, row));
  }
  return li;
}

async function openFile(path, row) {
  if (state.dirty && !confirm(`Discard unsaved changes to ${state.openPath}?`)) return;
  const data = await fetch(`/api/files/content?path=${encodeURIComponent(path)}`).then((r) => r.json());
  if (data.binary) {
    alert(`${path} looks binary — not opening.`);
    return;
  }
  state.openPath = path;
  setDirty(false);

  const oldModel = state.editor.getModel();
  const newModel = monaco.editor.createModel(data.content, languageFor(path), monaco.Uri.parse(`inmemory:///${path}`));
  state.editor.setModel(newModel);
  if (oldModel) oldModel.dispose();

  $("#editor-path").textContent = path;
  if (state.activeRow) state.activeRow.classList.remove("active");
  row.classList.add("active");
  state.activeRow = row;
}

async function saveCurrent() {
  if (!state.openPath) return;
  const res = await fetch("/api/files/content", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: state.openPath, content: state.editor.getValue() }),
  });
  if (res.ok) setDirty(false);
  else alert(`save failed: ${res.status}`);
}

function setDirty(d) {
  state.dirty = d;
  const flag = $("#dirty-flag");
  flag.classList.toggle("dirty", d);
  flag.textContent = d ? "●" : "";
}

function fileIconClass(name) {
  const lower = name.toLowerCase();
  // Whole-name matches first.
  const byName = {
    "readme.md": "codicon-book",
    "license": "codicon-law",
    "dockerfile": "codicon-server-environment",
    ".gitignore": "codicon-source-control",
    ".gitattributes": "codicon-source-control",
    "claude.md": "codicon-comment-discussion",
    "package.json": "codicon-package",
    "requirements.txt": "codicon-package",
  };
  if (byName[lower]) return byName[lower];

  const ext = lower.split(".").pop();
  const byExt = {
    md: "codicon-markdown",
    json: "codicon-json",
    py: "codicon-symbol-method",
    js: "codicon-symbol-method",
    mjs: "codicon-symbol-method",
    ts: "codicon-symbol-method",
    tsx: "codicon-symbol-method",
    jsx: "codicon-symbol-method",
    html: "codicon-file-code",
    css: "codicon-file-code",
    scss: "codicon-file-code",
    yaml: "codicon-settings-gear",
    yml: "codicon-settings-gear",
    toml: "codicon-settings-gear",
    ini: "codicon-settings-gear",
    env: "codicon-key",
    sh: "codicon-terminal",
    zsh: "codicon-terminal",
    bash: "codicon-terminal",
    sql: "codicon-database",
    txt: "codicon-file-text",
    log: "codicon-output",
    csv: "codicon-table",
    png: "codicon-file-media",
    jpg: "codicon-file-media",
    jpeg: "codicon-file-media",
    gif: "codicon-file-media",
    svg: "codicon-file-media",
    pdf: "codicon-file-pdf",
    zip: "codicon-file-zip",
    tar: "codicon-file-zip",
    gz: "codicon-file-zip",
  };
  return byExt[ext] || "codicon-file";
}

function languageFor(path) {
  const ext = path.split(".").pop().toLowerCase();
  const map = {
    py: "python", js: "javascript", mjs: "javascript", ts: "typescript", tsx: "typescript",
    jsx: "javascript", json: "json", md: "markdown", html: "html", css: "css",
    yaml: "yaml", yml: "yaml", toml: "ini", sh: "shell", zsh: "shell", go: "go",
    rs: "rust", java: "java", sql: "sql", xml: "xml",
  };
  return map[ext] || "plaintext";
}

// ---------- Terminals ----------

const xtermTheme = {
  background: "#2b2b2b",
  foreground: "#a9b7c6",
  cursor: "#a9b7c6",
  black: "#000000",      red: "#cf5b56",       green: "#6a8759",     yellow: "#cc7832",
  blue:  "#6897bb",      magenta: "#9876aa",   cyan: "#629755",      white: "#a9b7c6",
  brightBlack: "#606366", brightRed: "#ff6b68", brightGreen: "#9cdcfe",
  brightYellow: "#ffc66d", brightBlue: "#287bde", brightMagenta: "#bc91d1",
  brightCyan: "#629755",   brightWhite: "#ffffff",
};

const TABS_STORAGE_KEY = "graphl.tabs.v1";

function loadTabState() {
  try {
    const raw = localStorage.getItem(TABS_STORAGE_KEY);
    if (!raw) return { ids: [], activeId: null };
    const parsed = JSON.parse(raw);
    return {
      ids: Array.isArray(parsed.ids) ? parsed.ids : [],
      activeId: typeof parsed.activeId === "string" ? parsed.activeId : null,
    };
  } catch (_) {
    return { ids: [], activeId: null };
  }
}

function saveTabState() {
  const ids = Array.from(state.tabs.keys());
  const payload = { ids, activeId: state.activeTabId };
  try {
    localStorage.setItem(TABS_STORAGE_KEY, JSON.stringify(payload));
  } catch (_) {}
}

async function createTerminal(kind, title) {
  const res = await fetch("/api/terminals", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind, title: title || null }),
  });
  if (!res.ok) {
    alert(`new terminal failed: ${res.status}`);
    return;
  }
  const meta = await res.json();
  attachTerminal(meta);
}

async function reattachExistingTerminals() {
  const [saved, alive] = await Promise.all([
    Promise.resolve(loadTabState()),
    fetch("/api/terminals").then((r) => r.json()).catch(() => []),
  ]);
  const aliveMap = new Map(alive.map((m) => [m.id, m]));

  // Restore in the saved order; ignore any IDs the server no longer knows.
  const restored = [];
  for (const id of saved.ids) {
    const meta = aliveMap.get(id);
    if (!meta) continue;
    attachTerminal(meta);
    restored.push(id);
  }
  if (saved.activeId && restored.includes(saved.activeId)) {
    setActiveTab(saved.activeId);
  }
  return restored.length;
}

function attachTerminal(meta) {
  const term = new Terminal({
    theme: xtermTheme,
    fontFamily: "'JetBrains Mono', Menlo, Monaco, 'Courier New', monospace",
    fontSize: 12,
    cursorBlink: true,
    scrollback: 5000,
    convertEol: false,
    allowProposedApi: true,
  });
  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  try {
    term.loadAddon(new WebLinksAddon.WebLinksAddon());
  } catch (_) {}

  const wrap = document.createElement("div");
  wrap.className = "xterm-wrap";
  $("#term-host").appendChild(wrap);
  term.open(wrap);
  fitAddon.fit();

  const tabEl = document.createElement("div");
  tabEl.className = "tab";
  tabEl.innerHTML = `
    <span class="kind">${escapeHtml(meta.kind)}</span>
    <span class="title"></span>
    <button class="close" title="close">×</button>
  `;
  tabEl.querySelector(".title").textContent = meta.title;
  tabEl.addEventListener("mousedown", (e) => {
    if (e.target.closest(".close")) return;
    setActiveTab(meta.id);
  });
  tabEl.querySelector(".close").addEventListener("click", (e) => {
    e.stopPropagation();
    closeTab(meta.id);
  });
  $("#tabs").appendChild(tabEl);

  const ws = new WebSocket(wsUrlFor(`/ws/terminal/${meta.id}`));
  ws.binaryType = "arraybuffer";

  const entry = { term, fitAddon, ws, wrap, tabEl, kind: meta.kind, title: meta.title, dead: false };
  state.tabs.set(meta.id, entry);
  saveTabState();

  ws.addEventListener("open", () => {
    sendResize(meta.id);
  });
  ws.addEventListener("message", (evt) => {
    if (typeof evt.data === "string") {
      try {
        const msg = JSON.parse(evt.data);
        if (msg.type === "exit") markDead(meta.id);
      } catch (_) {}
      return;
    }
    term.write(new Uint8Array(evt.data));
  });
  ws.addEventListener("close", () => markDead(meta.id));
  ws.addEventListener("error", () => markDead(meta.id));

  term.onData((data) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(new TextEncoder().encode(data));
    }
  });
  term.onResize(() => sendResize(meta.id));

  setActiveTab(meta.id);
}

function sendResize(id) {
  const entry = state.tabs.get(id);
  if (!entry || entry.ws.readyState !== WebSocket.OPEN) return;
  const { cols, rows } = entry.term;
  entry.ws.send(JSON.stringify({ type: "resize", cols, rows }));
}

function setActiveTab(id) {
  const entry = state.tabs.get(id);
  if (!entry) return;
  for (const [tid, e] of state.tabs) {
    e.wrap.classList.toggle("active", tid === id);
    e.tabEl.classList.toggle("active", tid === id);
  }
  state.activeTabId = id;
  saveTabState();
  requestAnimationFrame(() => {
    try { entry.fitAddon.fit(); } catch (_) {}
    entry.term.focus();
  });
}

function markDead(id) {
  const entry = state.tabs.get(id);
  if (!entry || entry.dead) return;
  entry.dead = true;
  entry.tabEl.classList.add("dead");
}

async function closeTab(id) {
  const entry = state.tabs.get(id);
  if (!entry) return;
  try { entry.ws.close(); } catch (_) {}
  try { entry.term.dispose(); } catch (_) {}
  entry.wrap.remove();
  entry.tabEl.remove();
  state.tabs.delete(id);
  fetch(`/api/terminals/${id}`, { method: "DELETE" }).catch(() => {});
  if (state.activeTabId === id) {
    const next = state.tabs.keys().next().value;
    if (next) setActiveTab(next);
    else state.activeTabId = null;
  }
  saveTabState();
}

function wsUrlFor(path) {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}${path}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function fitAllTerminals() {
  for (const entry of state.tabs.values()) {
    try { entry.fitAddon.fit(); } catch (_) {}
  }
}

window.addEventListener("resize", fitAllTerminals);

// ---------- Resizable panes ----------

const LAYOUT_STORAGE_KEY = "graphl.layout.v1";
const TREE_DEFAULT = 220;
const BOTTOM_DEFAULT = 320;
const TREE_MIN = 140;
const TREE_MAX = 500;
const BOTTOM_MIN = 100;
const bottomMax = () => Math.max(BOTTOM_MIN + 50, Math.floor(window.innerHeight * 0.7));

function currentLayout() {
  const main = document.querySelector("main");
  const cs = getComputedStyle(main);
  return {
    treeW: parseInt(cs.getPropertyValue("--tree-w")) || TREE_DEFAULT,
    bottomH: parseInt(cs.getPropertyValue("--bottom-h")) || BOTTOM_DEFAULT,
  };
}

function applyLayout({ treeW, bottomH } = {}) {
  const main = document.querySelector("main");
  const cur = currentLayout();
  const t = Math.min(TREE_MAX, Math.max(TREE_MIN, treeW ?? cur.treeW));
  const b = Math.min(bottomMax(), Math.max(BOTTOM_MIN, bottomH ?? cur.bottomH));
  main.style.setProperty("--tree-w", `${t}px`);
  main.style.setProperty("--bottom-h", `${b}px`);
}

function loadLayout() {
  try {
    const raw = localStorage.getItem(LAYOUT_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (_) {
    return {};
  }
}

function saveLayout() {
  const main = document.querySelector("main");
  const treeW = parseInt(getComputedStyle(main).getPropertyValue("--tree-w")) || TREE_DEFAULT;
  const bottomH = parseInt(getComputedStyle(main).getPropertyValue("--bottom-h")) || BOTTOM_DEFAULT;
  try {
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify({ treeW, bottomH }));
  } catch (_) {}
}

function startResize(axis, handle) {
  const main = document.querySelector("main");
  const mainRect = main.getBoundingClientRect();
  document.body.classList.add(axis === "v" ? "resizing-v" : "resizing-h");
  handle.classList.add("dragging");

  let fitScheduled = false;
  const scheduleFit = () => {
    if (fitScheduled) return;
    fitScheduled = true;
    requestAnimationFrame(() => {
      fitScheduled = false;
      fitAllTerminals();
    });
  };

  const onMove = (e) => {
    if (axis === "v") {
      const x = e.clientX - mainRect.left;
      const w = Math.min(TREE_MAX, Math.max(TREE_MIN, x));
      main.style.setProperty("--tree-w", `${w}px`);
    } else {
      const y = mainRect.bottom - e.clientY;
      const h = Math.min(bottomMax(), Math.max(BOTTOM_MIN, y));
      main.style.setProperty("--bottom-h", `${h}px`);
    }
    scheduleFit();
  };
  const onUp = () => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    document.body.classList.remove("resizing-v", "resizing-h");
    handle.classList.remove("dragging");
    saveLayout();
    fitAllTerminals();
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

function wireResizers() {
  applyLayout(loadLayout());

  const vh = $("#resizer-v");
  const hh = $("#resizer-h");
  vh.addEventListener("mousedown", (e) => { e.preventDefault(); startResize("v", vh); });
  hh.addEventListener("mousedown", (e) => { e.preventDefault(); startResize("h", hh); });
  vh.addEventListener("dblclick", () => { applyLayout({ treeW: TREE_DEFAULT }); saveLayout(); fitAllTerminals(); });
  hh.addEventListener("dblclick", () => { applyLayout({ bottomH: BOTTOM_DEFAULT }); saveLayout(); fitAllTerminals(); });
}

// ---------- Wire it up ----------

$("#refresh-tree").addEventListener("click", loadTree);
$("#new-tab").addEventListener("click", () => createTerminal("shell"));
$("#pick-workspace").addEventListener("click", pickWorkspace);
wireResizers();

async function pickWorkspace() {
  let picked;
  try {
    const res = await fetch("/api/workspace/pick");
    if (!res.ok) {
      alert(`folder picker failed: ${res.status}`);
      return;
    }
    picked = await res.json();
  } catch (e) {
    alert(`folder picker error: ${e}`);
    return;
  }
  if (!picked || picked.cancelled || !picked.path) return;

  if (state.dirty && !confirm(`Discard unsaved changes to ${state.openPath} and switch workspace?`)) return;

  const res = await fetch("/api/workspace", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: picked.path }),
  });
  if (!res.ok) {
    alert(`switch workspace failed: ${res.status}`);
    return;
  }
  const data = await res.json();
  setWorkspaceLabel(data.path);

  // Old file path is no longer valid under the new root.
  state.openPath = null;
  state.activeRow = null;
  setDirty(false);
  $("#editor-path").textContent = "no file open";

  await loadTree();
}

function setWorkspaceLabel(path) {
  const el = $("#status");
  if (!el || !path) return;
  // Show ~ for $HOME; full path stays in the tooltip.
  const home = path.match(/^\/Users\/[^/]+/)?.[0];
  const display = home ? path.replace(home, "~") : path;
  el.textContent = display;
  el.title = path;
}

(async () => {
  const health = await fetch("/api/healthz").then((r) => r.json()).catch(() => null);
  if (health?.workspace) setWorkspaceLabel(health.workspace);
  await loadTree();
  const reattached = await reattachExistingTerminals();
  if (reattached === 0) await createTerminal("shell");
})();
