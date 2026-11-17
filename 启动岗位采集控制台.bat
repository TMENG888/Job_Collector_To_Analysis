@echo off
setlocal EnableExtensions
cd /d "%~dp0"
set "JOB_UI_PORT=8788"
if not exist "E:\Codex\work\job-fastapi\venv\Scripts\python.exe" (
  echo [ERROR] FastAPI runtime is not installed.
  echo Run: powershell -ExecutionPolicy Bypass -File job_collector_ui\backend\start.ps1 -Install
  pause
  exit /b 1
)
set "PYTHONDONTWRITEBYTECODE=1"
set "JOB_API_RUNTIME=E:\Codex\work\job-fastapi\runtime"
set "TEMP=E:\Codex\work\job-fastapi\temp"
set "TMP=%TEMP%"
if not exist "%TEMP%" mkdir "%TEMP%"
"E:\Codex\work\job-fastapi\venv\Scripts\python.exe" -B "job_collector_ui\backend\run.py" --port %JOB_UI_PORT%
set "JOB_EXIT_CODE=%ERRORLEVEL%"
if not "%JOB_EXIT_CODE%"=="0" pause
exit /b %JOB_EXIT_CODE%
