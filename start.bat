@echo off
chcp 65001 >nul 2>&1

echo ============================================
echo  WallChanger - Start
echo ============================================
echo.

:: Check node_modules
if not exist "node_modules" (
    echo [!] node_modules not found, please run install.bat first
    pause
    exit /b 1
)

:: Check backend dependencies
python -c "import uvicorn" >nul 2>&1
if %errorlevel% neq 0 (
    echo [!] Backend dependencies not found, please run install.bat first
    pause
    exit /b 1
)

echo Starting backend (http://localhost:8100)...
start "WallChanger-Backend" cmd /k "cd backend && uvicorn main:app --host 0.0.0.0 --port 8100 --reload"

timeout /t 2 /nobreak >nul

echo Starting frontend (http://localhost:5173)...
start "WallChanger-Frontend" cmd /k "npm run dev"

echo.
echo Both services started. Check the new terminal windows.
pause
