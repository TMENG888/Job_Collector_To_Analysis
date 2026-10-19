@echo off
setlocal
set "JOB_WORKSPACE_PWSH=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\powershell\pwsh.exe"
if exist "%JOB_WORKSPACE_PWSH%" goto launch
set "JOB_WORKSPACE_PWSH=%ProgramFiles%\PowerShell\7\pwsh.exe"
if exist "%JOB_WORKSPACE_PWSH%" goto launch
set "JOB_WORKSPACE_PWSH=pwsh.exe"
where.exe /q pwsh.exe
if errorlevel 1 (
  echo PowerShell 7 was not found. Please install PowerShell 7 or open this app from Codex.
  pause
  exit /b 1
)
:launch
"%JOB_WORKSPACE_PWSH%" -NoLogo -NoProfile -File "%~dp0start.ps1" %*
if errorlevel 1 (
  echo Launch failed. See the error above and logs in E:\Codex\outputs\20261019-job-desktop.
  pause
  exit /b 1
)
endlocal
