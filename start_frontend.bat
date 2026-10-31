@echo off
echo ========================================================
echo Starting CodeMind Frontend (http://localhost:5173)
echo ========================================================
cd frontend
if not exist node_modules call npm install
npm run dev
pause
