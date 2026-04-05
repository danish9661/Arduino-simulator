@echo off
cd /d "%~dp0"
echo Starting OpenHW-Studio Servers...

start "Backend Server" cmd /k "cd openhw-studio-backend-danish && npm run dev"
start "GDB Server" cmd /k "cd openhw-studio-backend-danish/wokwi-gdbserver && node gdbserver.js"
start "Frontend Server" cmd /k "cd OpenHW-studio-frontend-danish && npm run dev"

echo All servers are starting in separate windows!
