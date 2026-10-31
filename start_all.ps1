# CodeMind 2.1 - 1-click launch
Write-Host "Starting CodeMind (backend + frontend)..." -ForegroundColor Cyan

$py = "python"
if (Test-Path "$env:LOCALAPPDATA\Python\bin\python.exe") {
    $py = "$env:LOCALAPPDATA\Python\bin\python.exe"
} elseif (Get-Command py -ErrorAction SilentlyContinue) {
    $py = "py"
}

Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$PSScriptRoot\backend'; & '$py' -m pip install -r requirements.txt -q; & '$py' main.py"
Start-Sleep -Seconds 2
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$PSScriptRoot\frontend'; if (-not (Test-Path node_modules)) { npm install }; npm run dev"

Write-Host "Backend:  http://127.0.0.1:8000" -ForegroundColor Green
Write-Host "Frontend: http://localhost:5173  (open this in your browser)" -ForegroundColor Green
Write-Host "Configure model or provider in Settings if needed." -ForegroundColor Yellow
