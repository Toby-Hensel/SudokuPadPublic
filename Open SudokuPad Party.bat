@echo off
setlocal
cd /d "%~dp0"

if not exist "%~dp0runtime\node\node.exe" (
  echo Could not find local Node.js at runtime\node\node.exe
  echo Make sure you keep the full folder together when sharing it.
  pause
  exit /b 1
)

start "SudokuPad Party Server" cmd /k ""%~dp0runtime\node\node.exe" "%~dp0server.mjs""
timeout /t 2 /nobreak >nul
start "" "http://localhost:3000"

echo The server window has been opened in a separate Command Prompt.
echo Your browser should open automatically.
echo.
echo If the website does not open by itself, go to:
echo http://localhost:3000
echo.
echo Keep the server window open while using the website.
pause
