@echo off
setlocal
echo ========================================================
echo Starting CodeMind Backend (http://127.0.0.1:8000)
echo ========================================================
cd /d "%~dp0backend"

set "PY_CMD="
if exist "%LOCALAPPDATA%\Python\bin\python.exe" set "PY_CMD=%LOCALAPPDATA%\Python\bin\python.exe"
if not defined PY_CMD (
    where py >nul 2>nul && set "PY_CMD=py"
)
if not defined PY_CMD (
    where python >nul 2>nul && set "PY_CMD=python"
)
if not defined PY_CMD (
    echo [ERROR] Python 3.10+ was not found on your system.
    echo Please install Python from https://python.org
    pause
    exit /b 1
)

echo Using Python: %PY_CMD%
"%PY_CMD%" -m pip install -r requirements.txt -q
"%PY_CMD%" main.py
pause
