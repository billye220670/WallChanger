@echo off
echo Starting WallChanger...
start "Backend" cmd /k "cd backend && start.bat"
timeout /t 2 /nobreak >nul
start "Frontend" cmd /k "npm run dev"
echo Both processes started. Check the terminal windows.
