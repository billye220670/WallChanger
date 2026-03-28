@echo off
echo Stopping WallChanger...
for /f "tokens=5" %%a in ('netstat -aon ^| find ":8100" ^| find "LISTENING"') do taskkill /F /PID %%a 2>nul
for /f "tokens=5" %%a in ('netstat -aon ^| find ":5173" ^| find "LISTENING"') do taskkill /F /PID %%a 2>nul
echo Processes stopped.
