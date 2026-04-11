@echo off
chcp 65001 >nul 2>&1

echo ============================================
echo  WallChanger - Install Dependencies
echo ============================================
echo.

:: Check Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js not found. Please install: https://nodejs.org
    pause
    exit /b 1
)
echo [OK] Node.js:
node -v

:: Check Python
where python >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Python not found. Please install Python 3.10+: https://www.python.org
    pause
    exit /b 1
)
echo [OK] Python:
python --version

echo.
echo [1/2] Installing frontend dependencies (npm install)...
npm install
if %errorlevel% neq 0 (
    echo [ERROR] Frontend install failed
    pause
    exit /b 1
)
echo [OK] Frontend dependencies installed

echo.
echo [2/2] Installing backend dependencies (pip install)...
cd backend
python -m pip install -r requirements.txt
if %errorlevel% neq 0 (
    echo [ERROR] Backend install failed
    pause
    exit /b 1
)
cd ..
echo [OK] Backend dependencies installed

echo.
echo ============================================
echo  Done! Now run start.bat to launch.
echo ============================================
pause
