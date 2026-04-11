@echo off
echo ============================================
echo  WallChanger - 启动
echo ============================================
echo.

:: 检查 node_modules 是否存在
if not exist "node_modules" (
    echo [提示] 未找到前端依赖，请先运行 install.bat
    pause
    exit /b 1
)

:: 检查后端依赖（用 uvicorn 是否可用来判断）
python -c "import uvicorn" >nul 2>&1
if %errorlevel% neq 0 (
    echo [提示] 未找到后端依赖，请先运行 install.bat
    pause
    exit /b 1
)

echo 启动后端 (http://localhost:8100)...
start "WallChanger - Backend" cmd /k "cd backend && uvicorn main:app --host 0.0.0.0 --port 8100 --reload"

timeout /t 2 /nobreak >nul

echo 启动前端 (http://localhost:5173)...
start "WallChanger - Frontend" cmd /k "npm run dev"

echo.
echo 两个服务已启动，请查看弹出的终端窗口。
