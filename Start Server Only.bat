@echo off
setlocal
cd /d "%~dp0"

if not exist "%~dp0runtime\node\node.exe" (
  echo Could not find local Node.js at runtime\node\node.exe
  echo Make sure you keep the full folder together when sharing it.
  pause
  exit /b 1
)

"%~dp0runtime\node\node.exe" "%~dp0server.mjs"
