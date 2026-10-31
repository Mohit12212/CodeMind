import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { SAMPLES } from "./sample";
import { newFile, langFromName } from "./session.js";
import Editor from "./Editor.jsx";
import {
  Compliance, CopilotPanel, Findings, RefactorPanel, SEVERITIES, Summary, TestsPanel, ThreatPanel,
} from "./Panels.jsx";
import { Dialog, ConfirmDialog, Kbd, Menu, Spinner, Splitter, useLocalStorage, scoreTone } from "./ui.jsx";
import {
  IconBug, IconBook, IconCheck, IconCode, IconCopy, IconDownload, IconFile, IconFolder, IconMaximize,
  IconMessage, IconMinimize, IconMore, IconPanelRight, IconPlay, IconPlus, IconSearch, IconShield,
  IconShieldCheck, IconSparkles, IconTerminal, IconTest, IconUpload, IconX, IconZap, IconRefresh,
  IconTrash,
} from "./icons.jsx";

const LANGS = [
  { id: "python", name: "Python" },
  { id: "javascript", name: "JavaScript" },
  { id: "typescript", name: "TypeScript" },
  { id: "go", name: "Go" },
  { id: "java", name: "Java" },
  { id: "cpp", name: "C++" },
  { id: "c", name: "C" },
];
const LANG_NAME = Object.fromEntries(LANGS.map((l) => [l.id, l.name]));
const RANK = { critical: 0, high: 1, medium: 2, low: 3 };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function download(text, filename, notify) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
  notify(`Saved ${filename}`, "info");
}

export default function Review({ active, session, setSession, patchFile, settings, bionic, goSettings, notify, commandsRef }) {
  const { files, active: activeIdx, chat } = session;
  const file = files[activeIdx];
  const { code, language, review, refactor, tests, explanation, reviewedCode } = file;

  /* ── view state ── */
  const [depth, setDepth] = useState("quick");
  const [busy, setBusy] = useState("");
  const [info, setInfo] = useState("");
  const [dockOpen, setDockOpen] = useLocalStorage("cm-dock-open", true);
  const [dockMode, setDockMode] = useLocalStorage("cm-dock-mode", "analysis");
  const [dockW, setDockW] = useLocalStorage("cm-dock-w", 480);
  const [dockMax, setDockMax] = useState(false);
  const [tab, setTab] = useState("findings");
  const [filterSev, setFilterSev] = useState(null);
  const [query, setQuery] = useState("");
  const [diffMode, setDiffMode] = useLocalStorage("cm-diff-mode", "unified");
  const [termOpen, setTermOpen] = useState(false);
  const [termH, setTermH] = useLocalStorage("cm-term-h", 220);
  const [term, setTerm] = useState(null);
  const [stdin, setStdin] = useState("");
  const [testRun, setTestRun] = useState(null);
  const [commitData, setCommitData] = useState(null);
  const [scan, setScan] = useState(null);
  const [dialog, setDialog] = useState(null); // {type:'new'|'rename'|'close'|'preset', ...}
  const [cursor, setCursor] = useState({ line: 1, col: 1 });
  const editorRef = useRef(null);
  const uploadRef = useRef(null);
  const colRef = useRef(null);

  /* Reset transient per-file state when switching files. */
  useEffect(() => {
    setTestRun(null);
    setCommitData(null);
    setInfo("");
    setFilterSev(null);
    setQuery("");
  }, [file.id]);

  /* Always update the file that started the request, even if the user switched tabs meanwhile. */
  const fid = file.id;
  const upd = useCallback((p) => {
    setSession((s) => ({ ...s, files: s.files.map((f) => (f.id === fid ? { ...f, ...p } : f)) }));
  }, [fid, setSession]);

  const stale = !!review && reviewedCode != null && reviewedCode !== code;

  /* ── derived findings ── */
  const issues = useMemo(() => {
    const list = [...(review?.issues || [])].sort((a, b) => RANK[a.severity] - RANK[b.severity] || a.line - b.line);
    const q = query.trim().toLowerCase();
    return list.filter(
      (i) => (!filterSev || i.severity === filterSev) &&
        (!q || (i.title + i.detail + (i.evidence || "") + i.line).toLowerCase().includes(q))
    );
  }, [review, filterSev, query]);

  const counts = useMemo(() => {
    const c = { critical: 0, high: 0, medium: 0, low: 0 };
    (review?.issues || []).forEach((i) => { c[i.severity] = (c[i.severity] || 0) + 1; });
    return c;
  }, [review]);

  const marks = useMemo(() => {
    const m = {};
    (review?.issues || []).forEach((i) => {
      if (!m[i.line] || RANK[i.severity] < RANK[m[i.line]]) m[i.line] = i.severity;
    });
    return m;
  }, [review]);

  const totalIssues = review?.issues?.length || 0;

  /* ── helpers ── */
  const copy = async (text, label = "Code") => {
    try { await navigator.clipboard.writeText(text); notify(`${label} copied`, "success"); }
    catch { notify("Clipboard is blocked by the browser", "error"); }
  };

  const showDock = (mode) => { setDockOpen(true); setDockMode(mode); };

  /** Replace the editor contents with an undo toast. */
  const applyCode = (next, message, extra = {}) => {
    const prev = { code, review, refactor, reviewedCode };
    upd({ code: next, ...extra });
    notify(message, "success", { label: "Undo", run: () => upd(prev) });
  };

  const locate = (line) => {
    editorRef.current?.focusLine(line);
  };

  /* ── actions ── */
  const runReview = async (src = code) => {
    if (!src.trim()) { notify("Write or paste some code first", "warn"); return; }
    if (busy) return;
    setBusy("review");
    try {
      const r = await api.review({ code: src, language, mode: depth });
      upd({
        review: r, refactor: null, reviewedCode: src,
        language: LANGS.some((l) => l.id === r.language) ? r.language : language,
      });
      setInfo(r.switched_language ? `Detected ${r.switched_language} and switched the language mode.` : "");
      setDockOpen(true); setDockMode("analysis"); setTab("findings");
      notify(`Review complete. Health score ${r.score}/100`, "success");
    } catch (e) {
      notify(e.message, "error");
    }
    setBusy("");
  };

  const runScan = async () => {
    setBusy("scan");
    try {
      const list = files.map((f) => ({ path: f.name, name: f.name, code: f.code, language: f.language }));
      const res = await api.scanProject({ files: list, mode: depth });
      setScan(res);
    } catch (e) { notify(e.message, "error"); }
    setBusy("");
  };

  const runRefactor = async () => {
    setBusy("refactor");
    showDock("analysis"); setTab("refactor");
    try {
      const r = await api.refactor({
        code, language, mode: review?.mode || depth, issues: review?.issues || [], session_id: review?.session_id,
      });
      upd({ refactor: r });
      setCommitData(null);
      notify("Refactor verified with AST-Guard", "success");
    } catch (e) { notify(e.message, "error"); }
    setBusy("");
  };

  const quickFix = async (issue) => {
    if (busy) return;
    setBusy("fix:" + issue.id);
    const prev = { code, review, refactor, reviewedCode };
    try {
      const r = await api.quickfix({ code, language, issue });
      upd({ code: r.code });
      notify(`Fixed “${issue.title}”. Re-running the review…`, "info", { label: "Undo", run: () => upd(prev) });
      setBusy("");
      await runReview(r.code);
      return;
    } catch (e) { notify(e.message, "error"); }
    setBusy("");
  };

  const runCode = async () => {
    if (busy === "run") return;
    setBusy("run");
    setTermOpen(true);
    setTerm({ running: true });
    try {
      const res = await api.runCode({ code, language, stdin });
      setTerm(res);
    } catch (e) {
      setTerm({ stdout: "", stderr: e.message, exit_code: -1, duration_ms: 0 });
    }
    setBusy("");
  };

  const genTests = async () => {
    setBusy("tests");
    showDock("analysis"); setTab("tests");
    try {
      const res = await api.generateTests({ code, language });
      upd({ tests: res.tests });
      setTestRun(null);
      notify("Test suite generated", "success");
    } catch (e) { notify(e.message, "error"); }
    setBusy("");
  };

  const runTests = async () => {
    if (!tests) return;
    setBusy("run_tests");
    try {
      const res = await api.runTests({ code, test_code: tests, language });
      setTestRun(res);
      notify(res.passed ? `All tests passed in ${res.duration_ms} ms` : "Some tests failed", res.passed ? "success" : "warn");
    } catch (e) { notify(e.message, "error"); }
    setBusy("");
  };

  const explain = async () => {
    setBusy("explain");
    showDock("analysis"); setTab("threat");
    try {
      const res = await api.explainCode({ code, language });
      upd({ explanation: res.explanation });
      notify("Threat model ready", "success");
    } catch (e) { notify(e.message, "error"); }
    setBusy("");
  };

  const genCommit = async () => {
    if (!refactor?.code) return;
    setBusy("commit");
    try {
      setCommitData(await api.generateCommit({ before_code: code, after_code: refactor.code, language }));
    } catch (e) { notify(e.message, "error"); }
    setBusy("");
  };

  const sendCopilot = async (text) => {
    const t = text.trim();
    if (!t || busy === "copilot") return;
    showDock("copilot");
    const thread = [...chat, { role: "user", text: t }];
    setSession((s) => ({ ...s, chat: thread }));
    setBusy("copilot");
    try {
      const res = await api.chatAssistant({
        code, language, prompt: t, issues: review?.issues || [],
        conversation: thread.slice(-6).map((m) => ({ role: m.role, content: m.text })),
      });
      setSession((s) => ({ ...s, chat: [...s.chat, { role: "assistant", text: res.reply, code: res.code }] }));
    } catch (e) {
      setSession((s) => ({ ...s, chat: [...s.chat, { role: "assistant", text: e.message, error: true }] }));
    }
    setBusy("");
  };

  const askAbout = (i) =>
    sendCopilot(`Explain this finding and show the corrected code: "${i.title}" on line ${i.line}.`);

  /* ── file management ── */
  const uniqueName = (name) => {
    const taken = new Set(files.map((f) => f.name));
    if (!taken.has(name)) return name;
    const dot = name.lastIndexOf(".");
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    let n = 2;
    while (taken.has(`${base} (${n})${ext}`)) n++;
    return `${base} (${n})${ext}`;
  };

  const addFile = (name, content = "", lang) => {
    const nf = newFile(uniqueName(name), content, lang || langFromName(name, language));
    setSession((s) => ({ ...s, files: [...s.files, nf], active: s.files.length }));
    return nf;
  };

  const selectFile = (i) => setSession((s) => ({ ...s, active: i }));

  const removeFile = (index) => {
    if (files.length === 1) { notify("Keep at least one file open", "warn"); return; }
    const removed = files[index];
    setSession((s) => ({
      ...s,
      files: s.files.filter((_, i) => i !== index),
      active: index < s.active ? s.active - 1 : index === s.active ? Math.max(0, s.active - 1) : s.active,
    }));
    notify(`Closed ${removed.name}`, "info", {
      label: "Undo",
      run: () => setSession((s) => {
        const list = [...s.files];
        list.splice(Math.min(index, list.length), 0, removed);
        return { ...s, files: list, active: Math.min(index, list.length - 1) };
      }),
    });
  };

  const renameFile = (index, name) => {
    const clean = name.trim();
    if (!clean) return;
    setSession((s) => ({
      ...s,
      files: s.files.map((f, i) => (i === index ? { ...f, name: clean, language: langFromName(clean, f.language) } : f)),
    }));
  };

  const onUpload = (e) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      if (typeof ev.target?.result === "string") {
        addFile(f.name, ev.target.result);
        notify(`Imported ${f.name}`, "success");
      }
    };
    reader.readAsText(f);
  };

  const loadPreset = (s) =>
    applyCode(s.code, `Loaded “${s.title}”`, { language: s.lang, review: null, refactor: null, reviewedCode: null });

  /* ── terminal / dock sizing ── */
  const maxDock = () => Math.max(360, Math.min(900, window.innerWidth * 0.66));
  const effDock = dockMax ? maxDock() : clamp(dockW, 340, maxDock());
  const dragDock = (dx) => { setDockMax(false); setDockW(clamp(effDock - dx, 340, maxDock())); };
  const dragTerm = (dy) => {
    const h = colRef.current?.clientHeight || 700;
    setTermH(clamp(termH - dy, 110, h * 0.7));
  };

  /* ── keyboard (only while this view is visible) ── */
  const latest = useRef({});
  latest.current = { runReview, runCode, toggleCopilot: () => {
    if (dockOpen && dockMode === "copilot") setDockOpen(false); else showDock("copilot");
  }, toggleTerm: () => setTermOpen((o) => !o) };

  useEffect(() => {
    if (!active) return;
    const h = (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key === "Enter") { e.preventDefault(); latest.current.runReview(); }
      else if (mod && e.key.toLowerCase() === "j") { e.preventDefault(); latest.current.toggleTerm(); }
      else if (e.altKey && e.key.toLowerCase() === "a") { e.preventDefault(); latest.current.toggleCopilot(); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [active]);

  /* ── command palette entries ── */
  commandsRef.current = [
    { id: "review", group: "Analyze", label: "Review this file", icon: <IconShieldCheck size={15} />, kbd: "Ctrl Enter", run: () => runReview() },
    { id: "review-deep", group: "Analyze", label: "Deep review this file", icon: <IconSearch size={15} />, run: () => { setDepth("deep"); setTimeout(() => latest.current.runReview(), 0); } },
    { id: "scan", group: "Analyze", label: "Scan the whole project", icon: <IconFolder size={15} />, run: runScan },
    { id: "refactor", group: "Analyze", label: "Fix whole file with AI", icon: <IconSparkles size={15} />, disabled: !review, run: runRefactor },
    { id: "tests", group: "Analyze", label: "Generate unit tests", icon: <IconTest size={15} />, run: genTests },
    { id: "threat", group: "Analyze", label: "Build a threat model", icon: <IconBook size={15} />, run: explain },
    { id: "copilot", group: "Panels", label: "Toggle Copilot", icon: <IconMessage size={15} />, kbd: "Alt A", run: () => latest.current.toggleCopilot() },
    { id: "dock", group: "Panels", label: dockOpen ? "Hide side panel" : "Show side panel", icon: <IconPanelRight size={15} />, run: () => setDockOpen(!dockOpen) },
    { id: "term", group: "Panels", label: "Toggle terminal", icon: <IconTerminal size={15} />, kbd: "Ctrl J", run: () => setTermOpen((o) => !o) },
    { id: "run", group: "Code", label: "Run this file", icon: <IconPlay size={15} />, disabled: language !== "python", run: runCode },
    { id: "copy", group: "Code", label: "Copy code", icon: <IconCopy size={15} />, run: () => copy(code, "Source") },
    { id: "download", group: "Code", label: "Download file", icon: <IconDownload size={15} />, run: () => download(code, file.name, notify) },
    { id: "new", group: "Files", label: "New file", icon: <IconPlus size={15} />, run: () => setDialog({ type: "new" }) },
    { id: "upload", group: "Files", label: "Import a file from disk", icon: <IconUpload size={15} />, run: () => uploadRef.current?.click() },
    { id: "rename", group: "Files", label: `Rename ${file.name}`, icon: <IconFile size={15} />, run: () => setDialog({ type: "rename", index: activeIdx }) },
    ...files.map((f, i) => ({
      id: "file-" + f.id, group: "Files", label: `Open ${f.name}`, icon: <IconFile size={15} />, hidden: i === activeIdx, run: () => selectFile(i),
    })).filter((c) => !c.hidden),
    ...SAMPLES.map((s) => ({
      id: "preset-" + s.id, group: "Presets", label: s.title, icon: <IconCode size={15} />, run: () => loadPreset(s),
    })),
  ];

  const canRun = language === "python";
  const offline = !bionic.loading && !bionic.online;

  /* ───────────── render ───────────── */
  const dockStyle = { "--dock-w": effDock + "px" };

  return (
    <div className={"ws " + (dockOpen ? "" : "no-dock")} style={dockStyle}>
      {/* ═════ editor column ═════ */}
      <section className="col-editor" ref={colRef}>
        <div className="filetabs" role="tablist" aria-label="Open files">
          {files.map((f, i) => {
            const n = f.review?.issues?.length;
            return (
              <div
                key={f.id}
                className={"ftab " + (i === activeIdx ? "on" : "")}
                role="tab"
                aria-selected={i === activeIdx}
                tabIndex={0}
                onClick={() => selectFile(i)}
                onDoubleClick={() => setDialog({ type: "rename", index: i })}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") selectFile(i); }}
                onAuxClick={(e) => { if (e.button === 1) removeFile(i); }}
                title="Double-click to rename"
              >
                <span className={"ftab-dot " + (f.review ? scoreTone(f.review.score) : "")} />
                <span className="ftab-name">{f.name}</span>
                {n > 0 && <span className="ftab-count">{n}</span>}
                {files.length > 1 && (
                  <button
                    className="ftab-x"
                    aria-label={`Close ${f.name}`}
                    onClick={(e) => { e.stopPropagation(); removeFile(i); }}
                  >
                    <IconX size={12} />
                  </button>
                )}
              </div>
            );
          })}
          <button className="ftab-add" onClick={() => setDialog({ type: "new" })} aria-label="New file" title="New file">
            <IconPlus size={15} />
          </button>
          <span className="grow" />
          <button
            className={"icon-btn " + (dockOpen ? "on" : "")}
            onClick={() => setDockOpen(!dockOpen)}
            aria-label={dockOpen ? "Hide side panel" : "Show side panel"}
            aria-pressed={dockOpen}
            title={dockOpen ? "Hide side panel" : "Show side panel"}
          >
            <IconPanelRight size={17} />
          </button>
        </div>

        <div className="actionbar">
          <label className="select-wrap" title="Language">
            <select
              value={language}
              onChange={(e) => upd({ language: e.target.value })}
              aria-label="Language"
            >
              {LANGS.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </label>

          <div className="seg" role="group" aria-label="Review depth">
            <button className={depth === "quick" ? "on" : ""} aria-pressed={depth === "quick"} onClick={() => setDepth("quick")} title="Fast static analysis plus a short AI pass">
              <IconZap size={13} /> Quick
            </button>
            <button className={depth === "deep" ? "on" : ""} aria-pressed={depth === "deep"} onClick={() => setDepth("deep")} title="Thorough AI inspection, slower">
              <IconSearch size={13} /> Deep
            </button>
          </div>

          <span className="grow" />

          <Menu
            align="right"
            width={250}
            button={({ toggle, open }) => (
              <button className="icon-btn" onClick={toggle} aria-haspopup="menu" aria-expanded={open} aria-label="More actions" title="More actions">
                <IconMore size={18} />
              </button>
            )}
            items={[
              { label: "Copy code", icon: <IconCopy size={14} />, onClick: () => copy(code, "Source") },
              { label: "Download file", icon: <IconDownload size={14} />, onClick: () => download(code, file.name, notify) },
              { label: "Import file…", icon: <IconUpload size={14} />, onClick: () => uploadRef.current?.click() },
              { label: "Scan whole project", icon: <IconFolder size={14} />, onClick: runScan },
              { divider: true },
              { heading: "Load a preset" },
              ...SAMPLES.map((s) => ({ label: s.title, icon: <IconCode size={14} />, onClick: () => loadPreset(s) })),
            ]}
          />

          <button
            className={"btn " + (termOpen ? "on" : "")}
            onClick={() => setTermOpen((o) => !o)}
            aria-pressed={termOpen}
            title="Toggle terminal (Ctrl+J)"
          >
            <IconTerminal size={15} /> Terminal
          </button>
          <button className="btn" onClick={runCode} disabled={!canRun || busy === "run"} title={canRun ? "Run this file" : "Running is available for Python"}>
            {busy === "run" ? <Spinner /> : <IconPlay size={14} />} Run
          </button>
          <button className="btn primary" onClick={() => runReview()} disabled={!!busy} title="Review this file (Ctrl+Enter)">
            {busy === "review" ? <Spinner /> : <IconShieldCheck size={15} />}
            {busy === "review" ? "Reviewing…" : "Review"}
          </button>
          <input ref={uploadRef} type="file" hidden accept=".py,.js,.jsx,.ts,.tsx,.go,.java,.cpp,.c,.h,.txt" onChange={onUpload} />
        </div>

        <div className="editor-wrap">
          <Editor
            ref={editorRef}
            code={code}
            language={language}
            setCode={(v) => upd({ code: v })}
            marks={marks}
            onLineClick={(n) => {
              const i = (review?.issues || []).find((x) => x.line === n);
              if (i) { showDock("analysis"); setTab("findings"); setFilterSev(null); setQuery(""); }
            }}
            onCursor={setCursor}
          />
        </div>

        {termOpen && (
          <>
            <Splitter dir="h" onDrag={dragTerm} label="Resize terminal" onDoubleClick={() => setTermH(220)} />
            <Terminal
              height={termH}
              term={term}
              stdin={stdin}
              setStdin={setStdin}
              canRun={canRun}
              running={busy === "run"}
              onRun={runCode}
              onClear={() => setTerm(null)}
              onClose={() => setTermOpen(false)}
            />
          </>
        )}

        <footer className="statusbar">
          <span>Ln {cursor.line}, Col {cursor.col}</span>
          <span>{code.split("\n").length} lines</span>
          <span>{LANG_NAME[language]}</span>
          <span className="grow" />
          {stale && <span className="st warn">Edited since review</span>}
          {review && !stale && <span className={"st " + scoreTone(review.score)}>Reviewed, score {review.score}</span>}
          <span className={"st " + (offline ? "warn" : "")}>
            <i className={"dot " + (bionic.loading ? "busy" : bionic.online ? "up" : "down")} />
            {bionic.loading ? "Connecting" : bionic.online ? settings?.model || "Model ready" : "Model offline"}
          </span>
        </footer>
      </section>

      {/* ═════ dock ═════ */}
      {dockOpen && (
        <>
          <Splitter dir="v" onDrag={dragDock} label="Resize side panel" onDoubleClick={() => { setDockMax(false); setDockW(480); }} />
          <aside className="dock" aria-label="Analysis and Copilot">
            <div className="dock-head">
              <div className="dock-modes" role="tablist">
                <button role="tab" aria-selected={dockMode === "analysis"} className={dockMode === "analysis" ? "on" : ""} onClick={() => setDockMode("analysis")}>
                  <IconShield size={15} /> Analysis
                  {totalIssues > 0 && <span className="count">{totalIssues}</span>}
                </button>
                <button role="tab" aria-selected={dockMode === "copilot"} className={dockMode === "copilot" ? "on" : ""} onClick={() => setDockMode("copilot")}>
                  <IconSparkles size={15} /> Copilot
                </button>
              </div>
              <span className="grow" />
              <button className="icon-btn" onClick={() => setDockMax((m) => !m)} aria-label={dockMax ? "Shrink panel" : "Expand panel"} title={dockMax ? "Shrink panel" : "Expand panel"}>
                {dockMax ? <IconMinimize size={15} /> : <IconMaximize size={15} />}
              </button>
              <button className="icon-btn" onClick={() => setDockOpen(false)} aria-label="Close panel" title="Close panel">
                <IconX size={16} />
              </button>
            </div>

            {dockMode === "copilot" ? (
              <CopilotPanel
                messages={chat}
                busy={busy}
                onSend={sendCopilot}
                language={language}
                model={settings?.model}
                onClear={() => setSession((s) => ({ ...s, chat: [] }))}
                onApply={(c) => applyCode(c, "Copilot code applied to the editor")}
              />
            ) : (
              <AnalysisBody
                {...{
                  review, code, counts, filterSev, setFilterSev, busy, stale, info, goSettings, issues, tab, setTab,
                  query, setQuery, language, refactor, tests, explanation, testRun, commitData, diffMode, setDiffMode, canRun,
                }}
                onFix={runRefactor}
                onReview={() => runReview()}
                onLocate={locate}
                onQuickFix={quickFix}
                onAsk={askAbout}
                onApplyRefactor={() =>
                  applyCode(refactor.code, "Refactored code applied", { review: null, refactor: null, reviewedCode: null })
                }
                onCommit={genCommit}
                onCopy={(t) => copy(t, "Code")}
                onDownloadRefactor={() => download(refactor.code, `refactored_${file.name}`, notify)}
                onGenTests={genTests}
                onRunTests={runTests}
                onDownloadTests={() => download(tests, `test_${file.name}`, notify)}
                onExplain={explain}
                loadSample={() => loadPreset(SAMPLES[0])}
              />
            )}
          </aside>
        </>
      )}

      {/* ═════ dialogs ═════ */}
      {dialog?.type === "new" && (
        <NameDialog
          title="New file"
          initial="untitled.py"
          cta="Create file"
          onClose={() => setDialog(null)}
          onSubmit={(name) => { addFile(name, ""); setTimeout(() => editorRef.current?.focus(), 50); }}
        />
      )}
      {dialog?.type === "rename" && (
        <NameDialog
          title="Rename file"
          initial={files[dialog.index]?.name || ""}
          cta="Rename"
          onClose={() => setDialog(null)}
          onSubmit={(name) => renameFile(dialog.index, name)}
        />
      )}
      {scan && (
        <ScanDialog
          scan={scan}
          onClose={() => setScan(null)}
          onOpen={(path) => {
            const i = files.findIndex((f) => f.name === path);
            if (i >= 0) selectFile(i);
            setScan(null);
          }}
        />
      )}
      {busy === "scan" && <div className="busy-toast"><Spinner /> Scanning project…</div>}
    </div>
  );
}

/* ───────────── analysis body (empty state, summary, tabs) ───────────── */

function AnalysisBody(p) {
  const TABS = [
    { id: "findings", label: "Findings", count: p.review?.issues?.length },
    { id: "compliance", label: "Compliance", count: p.review?.compliance ? p.review.compliance.percent + "%" : null },
    { id: "refactor", label: "Refactor" },
    { id: "tests", label: "Tests" },
    { id: "threat", label: "Threat model" },
  ];
  const needsReview = p.tab === "findings" || p.tab === "compliance";

  return (
    <div className="dock-body">
      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={p.tab === t.id} className={p.tab === t.id ? "on" : ""} onClick={() => p.setTab(t.id)}>
            {t.label}
            {t.count != null && t.count !== 0 && <span className="count">{t.count}</span>}
          </button>
        ))}
      </div>

      <div className="dock-scroll">
        {needsReview && !p.review ? (
          <div className="empty">
            <div className="empty-ico"><IconShieldCheck size={24} /></div>
            <h3>Nothing reviewed yet</h3>
            <p>Run a review to find vulnerabilities, logic bugs and risky patterns, mapped to OWASP and CWE.</p>
            <button className="btn primary" onClick={p.onReview} disabled={p.busy === "review"}>
              {p.busy === "review" ? <Spinner /> : <IconShieldCheck size={15} />}
              {p.busy === "review" ? "Reviewing…" : "Review this file"}
            </button>
            <button className="btn ghost" onClick={p.loadSample}>Load a vulnerable sample</button>
            <div className="hint-keys"><Kbd>Ctrl</Kbd><Kbd>Enter</Kbd> review, <Kbd>Ctrl</Kbd><Kbd>K</Kbd> commands</div>
          </div>
        ) : p.tab === "findings" ? (
          <>
            <Summary
              review={p.review} code={p.code} counts={p.counts} filterSev={p.filterSev} setFilterSev={p.setFilterSev}
              onFix={p.onFix} busy={p.busy} stale={p.stale} info={p.info} goSettings={p.goSettings}
            />
            <div className="search-row">
              <IconSearch size={14} />
              <input
                value={p.query}
                onChange={(e) => p.setQuery(e.target.value)}
                placeholder="Filter findings"
                aria-label="Filter findings"
              />
              {(p.query || p.filterSev) && (
                <button className="link" onClick={() => { p.setQuery(""); p.setFilterSev(null); }}>Reset</button>
              )}
            </div>
            <Findings
              issues={p.issues}
              onLocate={p.onLocate}
              onFix={p.onQuickFix}
              onAsk={p.onAsk}
              busy={p.busy}
              filtered={!!(p.query || p.filterSev)}
              resetFilters={() => { p.setQuery(""); p.setFilterSev(null); }}
            />
          </>
        ) : p.tab === "compliance" ? (
          <Compliance review={p.review} />
        ) : p.tab === "refactor" ? (
          <RefactorPanel
            refactor={p.refactor} review={p.review} language={p.language} busy={p.busy}
            onRun={p.onFix} onApply={p.onApplyRefactor} onCommit={p.onCommit} commitData={p.commitData}
            onCopy={p.onCopy} onDownload={p.onDownloadRefactor} diffMode={p.diffMode} setDiffMode={p.setDiffMode}
          />
        ) : p.tab === "tests" ? (
          <TestsPanel
            tests={p.tests} language={p.language} busy={p.busy} onGenerate={p.onGenTests} onRun={p.onRunTests}
            result={p.testRun} onDownload={p.onDownloadTests} canRun={p.canRun}
          />
        ) : (
          <ThreatPanel explanation={p.explanation} busy={p.busy} onRun={p.onExplain} />
        )}
      </div>
    </div>
  );
}

/* ───────────── terminal ───────────── */

function Terminal({ height, term, stdin, setStdin, canRun, running, onRun, onClear, onClose }) {
  const [showIn, setShowIn] = useState(false);
  const ok = term && !term.running && term.exit_code === 0;
  return (
    <section className="terminal" style={{ height }} aria-label="Terminal">
      <div className="term-head">
        <IconTerminal size={14} />
        <b>Output</b>
        {term && !term.running && (
          <span className={"term-badge " + (ok ? "ok" : "bad")}>
            {ok ? "Exited 0" : `Exit ${term.exit_code}`}
            <small>{term.duration_ms} ms</small>
          </span>
        )}
        {running && <span className="term-badge run"><Spinner size={11} /> Running</span>}
        <span className="grow" />
        <button className={"btn ghost xs " + (showIn ? "on" : "")} onClick={() => setShowIn((s) => !s)} aria-pressed={showIn}>
          Input
        </button>
        <button className="btn ghost xs" onClick={onRun} disabled={!canRun || running}><IconRefresh size={12} /> Run again</button>
        <button className="icon-btn sm" onClick={onClear} aria-label="Clear output" title="Clear output"><IconTrash size={14} /></button>
        <button className="icon-btn sm" onClick={onClose} aria-label="Close terminal" title="Close terminal"><IconX size={14} /></button>
      </div>
      {showIn && (
        <textarea
          className="stdin"
          rows={2}
          value={stdin}
          onChange={(e) => setStdin(e.target.value)}
          placeholder="Text sent to the program's standard input (one line per input() call)"
          aria-label="Standard input"
        />
      )}
      <div className="term-body">
        {!term && (
          <p className="term-empty">
            {canRun ? <>Press <b>Run</b> to execute this file. Output appears here.</> : "Running is available for Python files."}
          </p>
        )}
        {term?.running && <p className="term-empty">Running…</p>}
        {term && !term.running && (
          <>
            {term.stdout && <pre className="out">{term.stdout}</pre>}
            {term.stderr && <pre className="err">{term.stderr}</pre>}
            {!term.stdout && !term.stderr && <p className="term-empty">The program finished without printing anything.</p>}
          </>
        )}
      </div>
    </section>
  );
}

/* ───────────── dialogs ───────────── */

function NameDialog({ title, initial, cta, onClose, onSubmit }) {
  const [v, setV] = useState(initial);
  const submit = (e) => {
    e?.preventDefault();
    if (!v.trim()) return;
    onClose();
    onSubmit(v);
  };
  return (
    <Dialog
      title={title}
      onClose={onClose}
      width={420}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={submit} disabled={!v.trim()}>{cta}</button>
        </>
      }
    >
      <form onSubmit={submit}>
        <label className="field">
          <span>File name</span>
          <input
            data-autofocus
            value={v}
            onChange={(e) => setV(e.target.value)}
            onFocus={(e) => e.target.select()}
            placeholder="app.py"
          />
          <small>The extension sets the language: .py, .js, .ts, .go, .java, .cpp, .c</small>
        </label>
      </form>
    </Dialog>
  );
}

function ScanDialog({ scan, onClose, onOpen }) {
  return (
    <Dialog title="Project scan" icon={<IconFolder size={18} />} onClose={onClose} width={640}>
      <div className="scan-stats">
        <div><span>Files</span><b>{scan.files_count}</b></div>
        <div><span>Repository health</span><b className={scoreTone(scan.repo_score)}>{scan.repo_score}<small>/100</small></b></div>
        <div><span>Total findings</span><b>{scan.total_issues}</b></div>
      </div>
      <ul className="scan-list">
        {scan.files.map((f, i) => (
          <li key={i}>
            <button onClick={() => onOpen(f.path)} title="Open this file">
              <IconFile size={15} />
              <span className="scan-name">{f.path}</span>
              <span className="dim small">{LANG_NAME[f.language] || f.language}</span>
              <span className="grow" />
              <span className="small">{f.issues.length} finding{f.issues.length === 1 ? "" : "s"}</span>
              <b className={"scan-score " + scoreTone(f.score)}>{f.score}</b>
            </button>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}

export { SEVERITIES, IconBug, IconCheck, ConfirmDialog };
