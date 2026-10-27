# Read-only Genshin wish-link helper. No network, no elevation, no game writes.
# Run on the Windows computer where the game is installed, not the web server.
param([string]$GameDataPath = '', [switch]$NoClipboard)
$ErrorActionPreference = 'Stop'
$roots = @()
if ($GameDataPath) {
    $path = (Resolve-Path -LiteralPath $GameDataPath).Path
    if (Test-Path -LiteralPath (Join-Path $path 'webCaches')) { $roots += $path }
    else {
        foreach ($name in @('YuanShen_Data', 'GenshinImpact_Data')) {
            $candidate = Join-Path $path $name
            if (Test-Path -LiteralPath $candidate) { $roots += $candidate }
        }
    }
} else {
    $logRoot = Join-Path $env:USERPROFILE 'AppData\LocalLow\miHoYo'
    $logs = @(Get-ChildItem -Path (Join-Path $logRoot '*\output_log.txt') -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending)
    foreach ($log in $logs) {
        $text = [IO.File]::ReadAllText($log.FullName)
        foreach ($match in [regex]::Matches($text, '[A-Za-z]:[\\/][^\r\n]*?(?:YuanShen_Data|GenshinImpact_Data)')) {
            if (Test-Path -LiteralPath $match.Value) { $roots += $match.Value }
        }
    }
}
if (-not $roots.Count) { throw 'Game directory not found. Use -GameDataPath with your YuanShen_Data or GenshinImpact_Data folder.' }
$files = @()
foreach ($root in ($roots | Select-Object -Unique)) {
    $cacheRoot = Join-Path $root 'webCaches'
    $direct = Join-Path $cacheRoot 'Cache\Cache_Data\data_2'
    if (Test-Path -LiteralPath $direct) { $files += Get-Item -LiteralPath $direct }
    foreach ($version in @(Get-ChildItem -LiteralPath $cacheRoot -Directory -ErrorAction SilentlyContinue)) {
        $candidate = Join-Path $version.FullName 'Cache\Cache_Data\data_2'
        if (Test-Path -LiteralPath $candidate) { $files += Get-Item -LiteralPath $candidate }
    }
}
$allowedHosts = @('webstatic.mihoyo.com', 'act.mihoyo.com', 'webstatic-sea.mihoyo.com', 'webstatic-sea.hoyoverse.com', 'webstatic.hoyoverse.com', 'gs.hoyoverse.com', 'hk4e-api.mihoyo.com', 'hk4e-api-os.hoyoverse.com', 'public-operation-hk4e.mihoyo.com', 'public-operation-hk4e-sg.hoyoverse.com')
foreach ($file in @($files | Sort-Object LastWriteTime -Descending | Select-Object -First 8)) {
    if ($file.Length -gt 128MB) { continue }
    $stream = $null; $reader = $null
    try {
        $stream = [IO.File]::Open($file.FullName, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
        $reader = [IO.StreamReader]::new($stream, [Text.Encoding]::UTF8)
        $text = $reader.ReadToEnd()
    } catch { continue }
    finally { if ($reader) { $reader.Dispose() } elseif ($stream) { $stream.Dispose() } }
    $matches = [regex]::Matches($text, 'https://[^\s\x00"''<>]+')
    for ($index = $matches.Count - 1; $index -ge 0; $index--) {
        $value = $matches[$index].Value
        if ($value.Length -gt 32768 -or $value -notmatch '[?&]authkey=' -or $value -notmatch '[?&]auth_appid=webview_gacha(?:&|$)') { continue }
        $uri = $null
        if (-not [Uri]::TryCreate($value, [UriKind]::Absolute, [ref]$uri) -or $uri.Scheme -ne 'https' -or $uri.UserInfo -or $allowedHosts -notcontains $uri.Host) { continue }
        if (-not $NoClipboard) {
            try { Set-Clipboard -Value $value; Write-Host 'Wish URL copied. Paste it into GachaRecordsViewer. Do not share it publicly.' }
            catch { Write-Warning 'Clipboard unavailable. Copy the URL printed below.' }
        }
        Write-Output $value
        return
    }
}
throw 'No wish URL found. Open Wish History in game, wait for records to load, then run this script again. Cache formats may change with game updates.'
