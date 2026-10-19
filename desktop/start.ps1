param(
  [switch]$Install,
  [switch]$SelfTest,
  [switch]$CheckLiveLayout,
  [string]$RuntimeRoot = 'E:\Codex\work\20261019-job-desktop',
  [string]$OutputRoot = 'E:\Codex\outputs\20261019-job-desktop',
  [string]$BaseUrl = 'http://127.0.0.1:8788'
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath 'E:\')) { throw 'E盘不可用；未写入C盘。' }
$runtimePath = [IO.Path]::GetFullPath($RuntimeRoot)
$outputPath = [IO.Path]::GetFullPath($OutputRoot)
if (-not $runtimePath.StartsWith('E:\', [StringComparison]::OrdinalIgnoreCase) -or -not $outputPath.StartsWith('E:\', [StringComparison]::OrdinalIgnoreCase)) { throw '运行目录及输出目录应位于E盘。' }
New-Item -ItemType Directory -Force -Path $runtimePath,$outputPath,(Join-Path $runtimePath 'temp'),(Join-Path $runtimePath 'npm-cache'),(Join-Path $runtimePath 'electron-cache') | Out-Null
$env:TEMP = Join-Path $runtimePath 'temp'
$env:TMP = $env:TEMP
$env:npm_config_cache = Join-Path $runtimePath 'npm-cache'
$env:electron_config_cache = Join-Path $runtimePath 'electron-cache'
$env:JOB_DESKTOP_RUNTIME = Join-Path $runtimePath 'runtime'
$env:JOB_DESKTOP_BASE_URL = $BaseUrl
$env:JOB_DESKTOP_TEST_OUTPUT = Join-Path $outputPath 'self-test.json'
# A desktop shell must run as Electron, even when launched from an Electron-based editor.
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$electronPath = Join-Path $runtimePath 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path -LiteralPath $electronPath)) {
  if (-not $Install) { throw '首次运行请添加 -Install（依赖和缓存均在E盘）。' }
  $package = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'package.json') -Raw | ConvertFrom-Json
  $npmCommand = (Get-Command npm.cmd -ErrorAction Stop).Source
  & $npmCommand install --prefix $runtimePath --no-save --package-lock=false --no-audit --no-fund --ignore-scripts "electron@$($package.devDependencies.electron)"
  if ($LASTEXITCODE -ne 0) { throw 'Electron安装失败；未启动桌面版。' }
  # Download the official release with bounded timeouts; validate against the
  # integrity-protected npm package's shipped checksums before extracting.
  if (-not (Test-Path -LiteralPath $electronPath)) {
    $version = $package.devDependencies.electron
    $artifact = "electron-v$version-win32-x64.zip"
    $download = Join-Path $runtimePath "electron-cache\$artifact"
    $checksums = Get-Content -LiteralPath (Join-Path $runtimePath 'node_modules\electron\checksums.json') -Raw | ConvertFrom-Json
    $expected = $checksums.$artifact
    if (-not $expected -or $expected -notmatch '^[a-f0-9]{64}$') { throw '缺少官方运行时哈希，安装已停止。' }
    if (-not (Test-Path -LiteralPath $download) -or (Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) {
      & (Join-Path $PSScriptRoot 'download-runtime.ps1') -Version $version -Destination $download -ExpectedHash $expected
    }
    if ((Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) { throw 'Electron SHA256校验失败，未解压执行。' }
    Expand-Archive -LiteralPath $download -DestinationPath (Join-Path $runtimePath 'node_modules\electron\dist') -Force
    if (-not (Test-Path -LiteralPath $electronPath)) { throw 'Electron运行时解压失败。' }
  }
}
if ($SelfTest) {
  $testArgs=@('"' + $PSScriptRoot + '"','--self-test')
  if ($CheckLiveLayout) { $testArgs+='--check-live-layout' }
  $testProcess = Start-Process -FilePath $electronPath -ArgumentList $testArgs -WorkingDirectory $PSScriptRoot -PassThru -Wait -WindowStyle Normal -RedirectStandardOutput (Join-Path $outputPath 'self-test.stdout.log') -RedirectStandardError (Join-Path $outputPath 'self-test.stderr.log')
  Get-Content -LiteralPath (Join-Path $outputPath 'self-test.stdout.log')
  if ($testProcess.ExitCode -ne 0) { Get-Content -LiteralPath (Join-Path $outputPath 'self-test.stderr.log') }
  exit $testProcess.ExitCode
}
$stamp = (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + "-$PID"
$stdoutPath = Join-Path $outputPath "$stamp.stdout.log"
$stderrPath = Join-Path $outputPath "$stamp.stderr.log"
$desktopProcess = Start-Process -FilePath $electronPath -ArgumentList @('"' + $PSScriptRoot + '"') -WorkingDirectory $PSScriptRoot -WindowStyle Normal -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -PassThru
# A second launch may exit normally after activating the existing instance.
# Verify a window from this exact runtime instead of assuming Start-Process succeeded.
$desktopWindow = $null
$deadline = [DateTime]::UtcNow.AddSeconds(12)
do {
  $desktopWindow = Get-Process -Name electron -ErrorAction SilentlyContinue | Where-Object {
    $_.Path -eq $electronPath -and $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -eq '岗位工作台 · 桌面预览'
  } | Select-Object -First 1
  if (-not $desktopWindow) { Start-Sleep -Milliseconds 250 }
} while (-not $desktopWindow -and [DateTime]::UtcNow -lt $deadline)
if (-not $desktopWindow) {
  $desktopProcess.Refresh()
  if (Test-Path -LiteralPath $stderrPath) { Get-Content -LiteralPath $stderrPath | Write-Host }
  throw "桌面窗口未能启动；请查看日志：$stderrPath（不重启后端、不清除会话）。"
}
Write-Output "岗位工作台窗口已打开（PID $($desktopWindow.Id)）；现有Web服务不重启。"
