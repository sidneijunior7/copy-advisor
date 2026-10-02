# Compiles the EAs with MetaEditor into a temp folder (no .ex5 left in the repo).
# Usage: powershell -File tools\compile_eas.ps1 [-MetaEditor path] [-DataFolder <terminal data folder>] [-Files a.mq5,b.mq5]
# DataFolder is the terminal folder that has MQL5\Include\Zmq (File > Open Data Folder in MT5).
param(
    [string]$MetaEditor = "C:\Program Files\MetaTrader 5\MetaEditor64.exe",
    [string]$DataFolder = "",
    [string[]]$Files = @("Trademetric Copy Trader Master.mq5", "Trademetric Copy Trader Slave.mq5")
)
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot

if (-not $DataFolder) {
    $DataFolder = Get-ChildItem "$env:APPDATA\MetaQuotes\Terminal" -Directory |
        Where-Object { Test-Path (Join-Path $_.FullName "MQL5\Include\Zmq\Zmq.mqh") } |
        Select-Object -First 1 -ExpandProperty FullName
}
if (-not $DataFolder) { throw "No terminal data folder with MQL5\Include\Zmq found" }

$out = Join-Path $env:TEMP ("tdm_ea_build_" + [guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory -Force $out | Out-Null
$utf8Bom = New-Object System.Text.UTF8Encoding($true)
$failed = $false

Get-ChildItem (Join-Path $repo "Include") -Recurse -Filter *.mqh | ForEach-Object {
    $text = [System.IO.File]::ReadAllText($_.FullName)
    [System.IO.File]::WriteAllText($_.FullName, $text, $utf8Bom)
}
# Includes with quotes (#include "Include/TDM/...") resolve next to the source being compiled
Copy-Item (Join-Path $repo "Include") (Join-Path $out "Include") -Recurse

foreach ($name in $Files) {
    $src = Join-Path $repo $name
    # MetaEditor reads BOM-less files as ANSI: keep the sources as UTF-8 with BOM
    $text = [System.IO.File]::ReadAllText($src)
    [System.IO.File]::WriteAllText($src, $text, $utf8Bom)

    $dst = Join-Path $out $name
    Copy-Item $src $dst
    $log = [System.IO.Path]::ChangeExtension($dst, ".log")
    # GUI app: wait for it explicitly; quote paths (they contain spaces)
    $include = Join-Path $DataFolder "MQL5"
    Start-Process -FilePath $MetaEditor -Wait -ArgumentList @("/compile:`"$dst`"", "/include:`"$include`"", "/log:`"$log`"")
    if (-not (Test-Path $log)) { throw "MetaEditor produced no log for $name" }
    $result = Get-Content $log -Encoding Unicode
    $result | Where-Object { $_ -match "error|warning|Result" } | ForEach-Object { Write-Output "  $_" }
    if (-not ($result -match "Result: 0 errors")) { $failed = $true }
    Write-Output "$name -> $(if (Test-Path ([System.IO.Path]::ChangeExtension($dst, '.ex5'))) { 'OK' } else { 'FAILED' })"
}
Write-Output "Build folder: $out"
if ($failed) { exit 1 }
