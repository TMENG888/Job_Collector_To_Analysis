param([Parameter(Mandatory)][string]$Version,[Parameter(Mandatory)][string]$Destination,[Parameter(Mandatory)][string]$ExpectedHash)
$ErrorActionPreference='Stop'
if ($Version -notmatch '^\d+\.\d+\.\d+$' -or $ExpectedHash -notmatch '^[a-f0-9]{64}$') { throw '非法运行时版本或哈希。' }
$resolved=[IO.Path]::GetFullPath($Destination)
if (-not $resolved.StartsWith('E:\',[StringComparison]::OrdinalIgnoreCase)) { throw '下载仅允许使用E盘。' }
$url="https://github.com/electron/electron/releases/download/v$Version/electron-v$Version-win32-x64.zip"
$parts=$resolved+'.parts'
New-Item -ItemType Directory -Force -Path $parts | Out-Null
$headers=Join-Path $parts 'headers.txt'
& curl.exe --fail --location --head --silent --show-error --connect-timeout 15 --max-time 30 --output $headers $url
if ($LASTEXITCODE -ne 0) { throw '无法读取官方发布包大小。' }
$lengths=@(Get-Content -LiteralPath $headers | Select-String '^Content-Length:\s*(\d+)' | ForEach-Object { [long]$_.Matches[0].Groups[1].Value })
$size=$lengths[-1]
if ($size -lt 1000000 -or $size -gt 1000000000) { throw '发布包大小异常。' }
# Small bounded ranges tolerate slow cross-border links. All parts are verified
# together against the official npm package SHA256 before any executable runs.
$chunk=1MB
$count=[int][Math]::Ceiling($size/$chunk)
Write-Output "下载官方Electron $Version，$count 个可断点分片，全部存放E盘。"
$results=@(0..($count-1) | ForEach-Object -Parallel {
  $index=$_;$part=Join-Path $using:parts ('{0:D4}.part' -f $index)
  $start=[long]$index*$using:chunk;$end=[Math]::Min($start+$using:chunk-1,$using:size-1);$wanted=$end-$start+1
  if ((Test-Path -LiteralPath $part) -and (Get-Item -LiteralPath $part).Length -eq $wanted) { return $true }
  & curl.exe --fail --location --range "$start-$end" --silent --show-error --retry 2 --connect-timeout 15 --max-time 90 --output $part $using:url
  return ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $part) -and (Get-Item -LiteralPath $part).Length -eq $wanted)
} -ThrottleLimit 24)
if ($results.Count -ne $count -or $results.Contains($false)) { throw '分片下载未完成；重新运行可续传，未解压或执行。' }
$stream=[IO.File]::Create($resolved)
try {for($index=0;$index -lt $count;$index++){$inputStream=[IO.File]::OpenRead((Join-Path $parts ('{0:D4}.part' -f $index)));try{$inputStream.CopyTo($stream)}finally{$inputStream.Dispose()}}} finally {$stream.Dispose()}
if ((Get-FileHash -LiteralPath $resolved -Algorithm SHA256).Hash.ToLowerInvariant() -ne $ExpectedHash) { throw '官方发布包哈希不匹配，未解压或执行。' }
Write-Output 'Electron官方发布包SHA256校验通过。'
