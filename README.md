# CodeMind — AI Code Review & Security Analysis

CodeMind is a local-first code review workspace built with a **Python/FastAPI backend** and a **React/Vite frontend**. It combines static code analysis with optional local or remote OpenAI-compatible language-model providers.

## Features

- Multi-file code workspace and project scan
- Static analysis and security findings with severity levels
- Optional local or remote AI model provider
- Refactoring suggestions and code comparison
- Review history and HTML/SARIF report exports
- Configurable provider and model settings
- Dark and light themes
- Windows startup scripts

## Technology stack

| Layer | Technology |
|---|---|
| Backend | Python, FastAPI, Uvicorn |
| Frontend | React 18, Vite, JavaScript, CSS |
| Data | SQLite (created locally at runtime) |
| AI integration | OpenAI-compatible API endpoints |

## Project structure

```text
CodeMind/
├── backend/
│   ├── main.py
│   └── requirements.txt
├── frontend/
│   ├── src/
│   │   ├── App.jsx
│   │   ├── Editor.jsx
│   │   ├── History.jsx
│   │   ├── Panels.jsx
│   │   ├── Review.jsx
│   │   ├── Settings.jsx
│   │   ├── api.js
│   │   ├── highlight.js
│   │   ├── icons.jsx
│   │   ├── main.jsx
│   │   ├── sample.js
│   │   ├── session.js
│   │   ├── styles.css
│   │   ├── ui.jsx
│   │   └── fonts/
│   ├── index.html
│   ├── package.json
│   ├── package-lock.json
│   └── vite.config.js
├── .gitignore
├── start_all.ps1
├── start_backend.bat
└── start_frontend.bat
```

## Requirements

- Python 3.10+
- Node.js 18+ and npm
- Optional: a local model server such as LM Studio or Ollama, or a compatible remote API

The app can start without an AI model configured; AI-assisted functions require a reachable provider.

## Run on Windows

### One-click startup

From the repository root, run PowerShell:

```powershell
.\start_all.ps1
```

Then open [http://localhost:5173](http://localhost:5173).

### Manual startup

**Backend** — in one terminal:

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python main.py
```

Backend API: [http://127.0.0.1:8000](http://127.0.0.1:8000)

**Frontend** — in a second terminal:

```powershell
cd frontend
npm install
npm run dev
```

Vite serves the interface at [http://localhost:5173](http://localhost:5173) and proxies `/api` requests to the backend.

## Configure an AI model

Open **Settings** inside CodeMind and configure the provider base URL, model name, and API key. Local model servers should be running before testing the connection. Never commit API keys or secrets to Git.

## Data and security

- CodeMind creates its SQLite database locally when the backend starts. The database is intentionally excluded from this repository because it can contain local review history and settings.
- Code execution runs code on your machine. A subprocess timeout is not a complete security sandbox. Do not execute untrusted code unless you isolate it separately using an appropriate operating-system or container sandbox.
- Static analysis and AI suggestions may produce false positives or miss issues. Review recommendations before applying them.
- This repository describes a local application; it does not provide hosted cloud synchronisation.

## Troubleshooting

- **Frontend cannot reach the API:** ensure the backend is running on port 8000 and Vite on port 5173.
- **No models appear:** start the model server and check its base URL, model name, and credentials in Settings.
- **Dependency errors:** use Python 3.10+ and Node.js 18+, then reinstall from `requirements.txt` and `package-lock.json`.

## Contributing

1. Fork the repository.
2. Create a feature branch.
3. Make and test your changes.
4. Open a pull request with a clear description.

## License

No license file is currently included. Unless a license is added, all rights remain with the repository owner.
