# Compiles the EAs with MetaEditor into a temp folder.
# Usage: powershell -File tools\compile_eas.ps1 [-MetaEditor path] [-DataFolder <terminal data folder>] [-Files a.mq5,b.mq5] [-Publish]
# DataFolder is a terminal data folder, for the standard includes (File > Open Data Folder in MT5).
# -Publish copies the .ex5 into downloads/ and updates downloads/manifest.json (version, size and SHA-256 of
# each), which the dashboard serves for download: commit both.
param(
    [string]$MetaEditor = "C:\Program Files\MetaTrader 5\MetaEditor64.exe",
    [string]$DataFolder = "",
    [string[]]$Files = @("Trademetric Copy Trader Master.mq5", "Trademetric Copy Trader Slave.mq5"),
    [switch]$Publish
)
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot

if (-not $DataFolder) {
    $DataFolder = Get-ChildItem "$env:APPDATA\MetaQuotes\Terminal" -Directory |
        Where-Object { Test-Path (Join-Path $_.FullName "MQL5\Include\Trade\Trade.mqh") } |
        Select-Object -First 1 -ExpandProperty FullName
}
if (-not $DataFolder) { throw "No terminal data folder with MQL5\Include\Trade found" }

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

if ($Publish) {
    $downloads = Join-Path $repo "downloads"
    New-Item -ItemType Directory -Force $downloads | Out-Null
    $manifestPath = Join-Path $downloads "manifest.json"
    $manifest = @{}
    if (Test-Path $manifestPath) {
        (Get-Content $manifestPath -Raw | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $manifest[$_.Name] = $_.Value }
    }
    foreach ($name in $Files) {
        $kind = $null
        if ($name -match "Master") { $kind = "master" } elseif ($name -match "Slave") { $kind = "slave" }
        if (-not $kind) { continue }
        $ex5 = [System.IO.Path]::ChangeExtension($name, ".ex5")
        Copy-Item (Join-Path $out $ex5) (Join-Path $downloads $ex5) -Force
        $version = [regex]::Match((Get-Content (Join-Path $repo $name) -Raw), '#define VERSAO "([^"]+)"').Groups[1].Value
        if (-not $version) { throw "No #define VERSAO in $name" }
        $file = Get-Item (Join-Path $downloads $ex5)
        $manifest[$kind] = [ordered]@{
            version  = $version
            file     = $ex5
            size     = $file.Length
            sha256   = (Get-FileHash $file.FullName -Algorithm SHA256).Hash.ToLower()
            built_at = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
        }
    }
    $sorted = [ordered]@{}
    foreach ($k in ($manifest.Keys | Sort-Object)) { $sorted[$k] = $manifest[$k] }
    [System.IO.File]::WriteAllText($manifestPath, ($sorted | ConvertTo-Json -Depth 3), (New-Object System.Text.UTF8Encoding($false)))
    Write-Output "Published to $downloads"
}
