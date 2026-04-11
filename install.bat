@echo off
echo ============================================
echo  WallChanger - 依赖安装
echo ============================================
echo.

:: 检查 Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [错误] 未找到 Node.js，请先安装 Node.js: https://nodejs.org
    pause
    exit /b 1
)
echo [OK] Node.js:
node -v

:: 检查 Python
where python >nul 2>&1
if %errorlevel% neq 0 (
    echo [错误] 未找到 Python，请先安装 Python 3.10+: https://www.python.org
    pause
    exit /b 1
)
echo [OK] Python:
python --version

echo.
echo [1/2] 安装前端依赖 (npm install)...
npm install
if %errorlevel% neq 0 (
    echo [错误] 前端依赖安装失败
    pause
    exit /b 1
)
echo [OK] 前端依赖安装完成

echo.
echo [2/2] 安装后端依赖 (pip install)...
cd backend
python -m pip install -r requirements.txt
if %errorlevel% neq 0 (
    echo [错误] 后端依赖安装失败
    pause
    exit /b 1
)
cd ..
echo [OK] 后端依赖安装完成

echo.
echo ============================================
echo  安装完成！现在可以运行 start.bat 启动项目
echo ============================================
pause
