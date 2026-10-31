import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { SAMPLE } from "./sample";
import { newFile } from "./session.js";
import Review from "./Review.jsx";
import History from "./History.jsx";
import Settings from "./Settings.jsx";
import { Menu, Toasts, Kbd, useLocalStorage } from "./ui.jsx";
import {
  IconShieldCheck, IconCode, IconHistory, IconSettings, IconSun, IconMoon,
  IconChevronDown, IconRefresh, IconSearch,
} from "./icons.jsx";

const initialSession = () => ({
  files: [
    newFile("main.py", SAMPLE),
    newFile("models.py", "# Database models\nimport os\n\nDB_URI = os.getenv(\"DB_URI\", \"sqlite:///data.db\")\n"),
    newFile("utils.py", "# Utility helpers\ndef sanitize_input(val):\n    return str(val).strip()\n"),
  ],
  active: 0,
  chat: [],
});

const NAV = [
  { id: "review", label: "Workspace", icon: IconCode },
  { id: "history", label: "History", icon: IconHistory },
];

export default function App() {
  const [view, setView] = useState("review");
  const [settings, setSettings] = useState(null);
  const [bionic, setBionic] = useState({ online: false, models: [], error: "", loading: true });
  const [session, setSession] = useState(initialSession);
  const [toasts, setToasts] = useState([]);
  const [theme, setTheme] = useLocalStorage("cm-theme", "dark");
  const [palette, setPalette] = useState(false);
  const commandsRef = useRef([]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  /* ── toasts ── */
  const dismiss = useCallback((id) => setToasts((p) => p.filter((t) => t.id !== id)), []);
  const addToast = useCallback((message, type = "info", action) => {
    const id = Date.now() + Math.random();
    setToasts((p) => [...p.slice(-3), { id, message, type, action }]);
    setTimeout(() => dismiss(id), action ? 7000 : 3800);
  }, [dismiss]);

  /* ── session helpers (the active file is the unit of work) ── */
  const patchFile = useCallback((p) => {
    setSession((s) => ({
      ...s,
      files: s.files.map((f, i) => (i === s.active ? { ...f, ...p } : f)),
    }));
  }, []);

  /* ── model / provider ── */
  const detect = useCallback(async () => {
    setBionic((b) => ({ ...b, loading: true }));
    try {
      const m = await api.models();
      setBionic({ online: m.online, models: m.models, error: m.error, loading: false });
      setSettings(await api.settings());
    } catch (e) {
      setBionic({ online: false, models: [], error: e.message, loading: false });
    }
  }, []);
  useEffect(() => { detect(); }, [detect]);

  const saveSettings = async (patch) => {
    const next = await api.saveSettings(patch);
    setSettings(next);
    return next;
  };

  const chosen = settings?.model;
  const modelMissing = chosen && bionic.online && !bionic.models.includes(chosen);

  /* ── global shortcuts ── */
  useEffect(() => {
    const h = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => !p);
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  const globalCommands = useMemo(() => [
    { id: "go-ws", group: "Go to", label: "Workspace", icon: <IconCode size={15} />, run: () => setView("review") },
    { id: "go-hi", group: "Go to", label: "History", icon: <IconHistory size={15} />, run: () => setView("history") },
    { id: "go-se", group: "Go to", label: "Settings", icon: <IconSettings size={15} />, run: () => setView("settings") },
    {
      id: "theme", group: "View",
      label: theme === "dark" ? "Switch to light theme" : "Switch to dark theme",
      icon: theme === "dark" ? <IconSun size={15} /> : <IconMoon size={15} />,
      run: () => setTheme(theme === "dark" ? "light" : "dark"),
    },
    { id: "refresh-models", group: "Model", label: "Refresh model list", icon: <IconRefresh size={15} />, run: detect },
  ], [theme, setTheme, detect]);

  const title = view === "review" ? session.files[session.active]?.name : view === "history" ? "History" : "Settings";

  return (
    <div className="app">
      <Toasts toasts={toasts} dismiss={dismiss} />

      <nav className="rail" aria-label="Primary">
        <div className="rail-logo" title="CodeMind"><IconShieldCheck size={20} /></div>
        {NAV.map((n) => (
          <button
            key={n.id}
            className={"rail-btn " + (view === n.id ? "on" : "")}
            onClick={() => setView(n.id)}
            aria-label={n.label}
            aria-current={view === n.id ? "page" : undefined}
            data-tip={n.label}
          >
            <n.icon size={20} />
            <span className="rail-label">{n.label}</span>
          </button>
        ))}
        <span className="grow" />
        <button
          className="rail-btn"
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          aria-label="Toggle theme"
          data-tip={theme === "dark" ? "Light theme" : "Dark theme"}
        >
          {theme === "dark" ? <IconSun size={19} /> : <IconMoon size={19} />}
          <span className="rail-label">Theme</span>
        </button>
        <button
          className={"rail-btn " + (view === "settings" ? "on" : "")}
          onClick={() => setView("settings")}
          aria-label="Settings"
          aria-current={view === "settings" ? "page" : undefined}
          data-tip="Settings"
        >
          <IconSettings size={20} />
          <span className="rail-label">Settings</span>
        </button>
      </nav>

      <div className="shell">
        <header className="topbar">
          <div className="crumb">
            <span className="crumb-app">CodeMind</span>
            <span className="crumb-sep">/</span>
            <span className="crumb-cur">{title}</span>
          </div>

          <button className="palette-trigger" onClick={() => setPalette(true)} aria-label="Open command palette">
            <IconSearch size={14} />
            <span>Search commands</span>
            <span className="grow" />
            <Kbd>Ctrl</Kbd><Kbd>K</Kbd>
          </button>

          <Menu
            align="right"
            width={260}
            button={({ toggle, open }) => (
              <button
                className={"model-chip " + (bionic.online ? "up" : "down")}
                onClick={bionic.online || bionic.loading ? toggle : () => setView("settings")}
                aria-haspopup="menu"
                aria-expanded={open}
              >
                <span className={"dot " + (bionic.loading ? "busy" : bionic.online ? "up" : "down")} />
                <span className="model-name">
                  {bionic.loading ? "Connecting…" : bionic.online ? (chosen || "Choose a model") : "Model offline"}
                </span>
                {bionic.online && <IconChevronDown size={14} />}
              </button>
            )}
            items={[
              { heading: "Active model" },
              ...bionic.models.map((m) => ({
                label: m,
                checked: m === chosen,
                onClick: () => { saveSettings({ model: m }); addToast(`Model switched to ${m}`, "info"); },
              })),
              ...(modelMissing ? [{ label: `${chosen} (not loaded)`, disabled: true }] : []),
              { divider: true },
              { label: "Refresh models", icon: <IconRefresh size={14} />, onClick: detect },
              { label: "Provider settings", icon: <IconSettings size={14} />, onClick: () => setView("settings") },
            ]}
          />
        </header>

        <main className="stage">
          <div className="view" hidden={view !== "review"}>
            <Review
              active={view === "review"}
              session={session}
              setSession={setSession}
              patchFile={patchFile}
              settings={settings}
              bionic={bionic}
              goSettings={() => setView("settings")}
              notify={addToast}
              commandsRef={commandsRef}
            />
          </div>
          {view === "history" && (
            <div className="view scroll">
              <History patchFile={patchFile} open={() => setView("review")} notify={addToast} />
            </div>
          )}
          {view === "settings" && (
            <div className="view scroll">
              <Settings settings={settings} bionic={bionic} detect={detect} save={saveSettings} notify={addToast} />
            </div>
          )}
        </main>
      </div>

      {palette && (
        <Palette
          commands={[...(view === "review" ? commandsRef.current : []), ...globalCommands]}
          onClose={() => setPalette(false)}
        />
      )}
    </div>
  );
}

/* ───────────── command palette ───────────── */

function Palette({ commands, onClose }) {
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const list = useRef(null);

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return commands.filter((c) => !s || (c.label + " " + c.group).toLowerCase().includes(s));
  }, [q, commands]);

  useEffect(() => setIdx(0), [q]);
  useEffect(() => {
    list.current?.querySelector(".pal-item.on")?.scrollIntoView({ block: "nearest" });
  }, [idx]);

  const run = (c) => {
    if (!c || c.disabled) return;
    onClose();
    setTimeout(() => c.run(), 0);
  };

  const onKey = (e) => {
    if (e.key === "Escape") onClose();
    else if (e.key === "ArrowDown") { e.preventDefault(); setIdx((i) => Math.min(i + 1, shown.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setIdx((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); run(shown[idx]); }
  };

  let lastGroup = null;
  return (
    <div className="overlay top" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="palette" role="dialog" aria-label="Command palette" onKeyDown={onKey}>
        <div className="pal-input">
          <IconSearch size={16} />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Type a command…"
            aria-label="Search commands"
          />
          <Kbd>Esc</Kbd>
        </div>
        <div className="pal-list" ref={list} role="listbox">
          {shown.length === 0 && <div className="pal-empty">No commands match “{q}”.</div>}
          {shown.map((c, i) => {
            const head = c.group !== lastGroup ? c.group : null;
            lastGroup = c.group;
            return (
              <div key={c.id}>
                {head && <div className="pal-group">{head}</div>}
                <button
                  role="option"
                  aria-selected={i === idx}
                  disabled={c.disabled}
                  className={"pal-item " + (i === idx ? "on" : "")}
                  onMouseMove={() => setIdx(i)}
                  onClick={() => run(c)}
                >
                  <span className="pal-ico">{c.icon}</span>
                  <span className="pal-label">{c.label}</span>
                  {c.kbd && <span className="pal-kbd">{c.kbd}</span>}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
