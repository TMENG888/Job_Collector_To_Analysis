@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "JOB_UI_PORT=8765"
set "JOB_UI_OPEN_BROWSER=1"
set "JOB_NODE="

if defined JOB_UI_NODE set "JOB_NODE=%JOB_UI_NODE%"
if not defined JOB_NODE if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" set "JOB_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not defined JOB_NODE for /f "delims=" %%I in ('where node.exe 2^>nul') do if not defined JOB_NODE set "JOB_NODE=%%I"

if not defined JOB_NODE (
  echo [ERROR] Node.js runtime was not found.
  echo Install Node.js or set JOB_UI_NODE to node.exe.
  pause
  exit /b 1
)

if not exist "%JOB_NODE%" (
  echo [ERROR] Node.js runtime does not exist:
  echo %JOB_NODE%
  pause
  exit /b 1
)

echo Starting Job Collector Console...
"%JOB_NODE%" "job_collector_ui\server.mjs" %JOB_UI_PORT%
set "JOB_EXIT_CODE=%ERRORLEVEL%"

if not "%JOB_EXIT_CODE%"=="0" (
  echo.
  echo The console exited with code %JOB_EXIT_CODE%. See the error above.
  pause
)

exit /b %JOB_EXIT_CODE%
