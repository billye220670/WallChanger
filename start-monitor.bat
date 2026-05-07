@echo off
chcp 65001 >nul 2>&1
echo Opening WallChanger Monitor...
start http://localhost:8100/monitor
echo Monitor page opened in browser.
