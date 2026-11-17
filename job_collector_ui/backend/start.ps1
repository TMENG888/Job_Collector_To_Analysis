param(
  [switch]$Install,
  [int]$Port = 8788,
  [string]$RuntimeRoot = 'E:/Codex/work/job-fastapi'
)
$ErrorActionPreference='Stop'
$runtimePath=[IO.Path]::GetFullPath($RuntimeRoot)
if(-not (Test-Path -LiteralPath ([IO.Path]::GetPathRoot($runtimePath)))){throw '后端运行盘不可用，未改用C盘'}
New-Item -ItemType Directory -Force -Path $runtimePath,($runtimePath+'/temp'),($runtimePath+'/runtime') | Out-Null
$env:TEMP=$runtimePath+'/temp'
$env:TMP=$env:TEMP
$env:PIP_CACHE_DIR=$runtimePath+'/temp/pip-cache'
$env:PYTHONDONTWRITEBYTECODE='1'
$env:JOB_API_RUNTIME=$runtimePath+'/runtime'
$env:JOB_UI_PORT=[string]$Port
$python=$runtimePath+'/venv/Scripts/python.exe'
if($Install){
  if(-not (Test-Path -LiteralPath $python)){& py -3 -m venv ($runtimePath+'/venv');if($LASTEXITCODE -ne 0){throw 'FastAPI运行环境创建失败'}}
  & $python -m pip install -r ($PSScriptRoot+'/requirements.txt')
  if($LASTEXITCODE -ne 0){throw 'FastAPI依赖安装失败'}
}
if(-not (Test-Path -LiteralPath $python)){throw '请先使用start.ps1 -Install安装FastAPI运行环境，所有依赖保存在E盘'}
$project=[IO.Path]::GetFullPath($PSScriptRoot+'/../..')
Set-Location -LiteralPath $project
& $python -B ($PSScriptRoot+'/run.py') --port $Port
exit $LASTEXITCODE
