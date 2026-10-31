# CodeMind 2.2 - AI Code Reviewer & Security Auditing Platform

Advanced static analysis (SAST) + task-based local/remote LLM engine with AST-Guard verification, multi-file project workspace, execution sandbox, and AI Copilot.

Runs **100% locally on your machine** with zero telemetry.

---

## Quick Start
1. Ensure your local LLM runner is active (LM Studio, Ollama, or Bionic at `http://127.0.0.1:1234` or `http://127.0.0.1:11434`), or use an OpenAI-compatible remote endpoint with an API key.
2. Run `start_all.ps1` (or execute `start_backend.bat` and `start_frontend.bat`).
3. Open `http://localhost:5173`.
4. Pick or configure your model in **Settings** (or test the connection with real-time latency ping).

Requirements: Python 3.10+ and Node.js 18+.

---

## Features & Capabilities

### 1. Multi-File Project Workspace & Full Repository Scan
- Manage multiple project files in tabbed editor (`main.py`, `models.py`, `utils.py`, `auth.py`).
- Create and switch between files seamlessly or upload local files.
- **Scan Project**: Evaluates all open files across the project, calculates an aggregate **Repository Health Score**, and displays a multi-file vulnerability breakdown.

### 2. Live Execution Sandbox & Test Runner
- **Run Code**: Execute Python files directly in an isolated local execution sandbox with stdout/stderr console output and execution time metrics.
- **Live Unit Test Runner**: Run synthesized pytest / unittest suites live and see green/red checkmarks and assertion failure logs directly in the UI.

### 3. AI Copilot Sidecar ("Ask CodeMind")
- Interactive pair-programming assistant docked alongside your code.
- Quick prompt chips:
  - ⚡ *Optimize Performance*
  - 🛡️ *Show Exploit Scenario & Attack Payload*
  - 📝 *Add Type Hints & Docstrings*
  - 🔄 *Convert to Async / Await*
- 1-click **"Apply to Editor"** for suggested code modifications.

### 4. SAST Rule Studio & Custom Rule Engine
- Browse 35+ built-in AST / SAST detection rules with descriptions, CWE mappings, and remediation examples.
- **Custom Project Rules**: Define custom regular expression rules with custom severity, category, description, and remediation tip.
- Interactive live regex testing box.

### 5. Git Commit & Conventional Patch Generator
- Compare original and refactored code to generate conventional commit messages (`fix(security): sanitize SQL query inputs...`).
- View and download unified `.patch` diff files.

### 6. Executive HTML & SARIF 2.1.0 Exports
- **Executive HTML Report**: Standalone, printable HTML report with vulnerability badges, metrics, and source preview.
- **SARIF 2.1.0 Export**: Download Static Analysis Results Interchange Format for GitHub Code Scanning, SonarQube, and VS Code.
- **Markdown Audit Report**: Standard Markdown audit log.

---

## Layout
```
backend/main.py            FastAPI backend (AST SAST, sandbox execution, AI copilot, SARIF & HTML export)
backend/codemind_v2.db     Local SQLite history, custom rules, & settings database
frontend/src/App.jsx       Root component with toast system & navigation
frontend/src/Review.jsx    Multi-file workspace, terminal drawer, AI copilot, diff viewer
frontend/src/RulesManager.jsx SAST Rule Studio and custom regex rule builder
frontend/src/History.jsx   Audit history, HTML/SARIF/Markdown exports
frontend/src/Settings.jsx  Provider presets, latency tester, model configuration
frontend/src/icons.jsx     Lightweight inline vector icons
frontend/src/sample.js     Curated vulnerability and architecture code presets
```

## UI redesign notes

- Docked layout: editor, resizable side panel (Analysis / Copilot) and a resizable terminal. Drag the splitters; double-click one to reset.
- Command palette: `Ctrl+K`. Other shortcuts: `Ctrl+Enter` review, `Ctrl+J` terminal, `Alt+A` Copilot.
- Dark and light themes (toggle in the left rail). Fonts are bundled locally, so the UI works fully offline.
- Files, results and chat now persist while you switch between Workspace, History and Settings.
- Destructive actions (apply code, load preset, close file) show an Undo toast.
