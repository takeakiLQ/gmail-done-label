$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$sourceRoot = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$extensionRoot = Join-Path $sourceRoot 'extension'
$outputRoot = Split-Path -Parent $sourceRoot
$manifest = Get-Content -Raw -LiteralPath (Join-Path $extensionRoot 'manifest.json') | ConvertFrom-Json
$version = $manifest.version
if ($version -notmatch '^\d+(\.\d+){0,3}$') { throw 'Invalid manifest version' }
if ($manifest.manifest_version -ne 3) { throw 'Manifest V3 required' }

function Write-PackageZip {
    param([string]$Destination, [string]$Base, [System.IO.FileInfo[]]$Files)
    # Overwrite only these explicitly named versioned ZIP outputs, with no recursive deletion.
    $resolvedDestination = [System.IO.Path]::GetFullPath($Destination)
    if ([System.IO.Path]::GetDirectoryName($resolvedDestination) -ne $outputRoot) {
        throw 'ZIP destination must stay in the output directory'
    }
    $stream = [System.IO.File]::Open($resolvedDestination, [System.IO.FileMode]::Create)
    $archive = [System.IO.Compression.ZipArchive]::new($stream, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($file in $Files) {
            $entryName = [System.IO.Path]::GetRelativePath($Base, $file.FullName).Replace('\', '/')
            if ($entryName.StartsWith('..')) { throw 'File outside package root' }
            [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
                $archive, $file.FullName, $entryName,
                [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
        }
    } finally { $archive.Dispose(); $stream.Dispose() }
}

$distribution = Join-Path $outputRoot "gmail-done-label-v$version.zip"
$sourceZip = Join-Path $outputRoot "gmail-done-label-source-v$version.zip"
$extensionFiles = @(Get-ChildItem -LiteralPath $extensionRoot -Recurse -File)
Write-PackageZip -Destination $distribution -Base $extensionRoot -Files $extensionFiles
# Documentation is also available inside the distributable archive, next to manifest.json.
$stream = [System.IO.File]::Open($distribution, [System.IO.FileMode]::Open)
$archive = [System.IO.Compression.ZipArchive]::new($stream, [System.IO.Compression.ZipArchiveMode]::Update)
try {
    foreach ($name in @('README.md', 'PRIVACY.md', 'LICENSE', 'TEST-REPORT.md')) {
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
            $archive, (Join-Path $sourceRoot $name), $name,
            [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
    }
} finally { $archive.Dispose(); $stream.Dispose() }
$sourceFiles = @(Get-ChildItem -LiteralPath $sourceRoot -Recurse -File | Where-Object {
    $relative = [System.IO.Path]::GetRelativePath($sourceRoot, $_.FullName).Replace('\', '/')
    $relative -notmatch '(^|/)(node_modules|\.git|test-results|playwright-report)(/|$)'
})
Write-PackageZip -Destination $sourceZip -Base $sourceRoot -Files $sourceFiles
$hashLines = @($distribution, $sourceZip) | ForEach-Object {
    $hash = Get-FileHash -LiteralPath $_ -Algorithm SHA256
    "$($hash.Hash.ToLowerInvariant())  $([System.IO.Path]::GetFileName($_))"
}
[System.IO.File]::WriteAllLines((Join-Path $outputRoot "gmail-done-label-v$version-SHA256.txt"), $hashLines)
Write-Output "Created: $distribution"
Write-Output "Created: $sourceZip"
