# Builds release\Cordmuffin Equicord Installer.zip from the installer and the empty kit folders only.
# It refuses to finish if anything else ends up in the zip, so plugins never ship with a release.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$release = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\release"))
$stage = Join-Path $release "stage"
$zip = Join-Path $release "Cordmuffin Equicord Installer.zip"
$exeName = "Cordmuffin Equicord Installer.exe"
$allowed = @($exeName, "Plugins Go Here/README.txt", "Themes Go Here/README.txt")

Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory $stage | Out-Null
go build -trimpath -ldflags "-s -w" -o (Join-Path $stage $exeName) .
if ($LASTEXITCODE -ne 0) { throw "go build failed" }
foreach ($folder in "Plugins Go Here", "Themes Go Here") {
    New-Item -ItemType Directory (Join-Path $stage $folder) | Out-Null
    Copy-Item (Join-Path "kit\$folder" "README.txt") (Join-Path $stage $folder)
}

Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
Remove-Item $zip -Force -ErrorAction SilentlyContinue
$archive = [IO.Compression.ZipFile]::Open($zip, "Create")
try {
    foreach ($file in Get-ChildItem $stage -Recurse -File) {
        $name = $file.FullName.Substring($stage.Length + 1).Replace("\", "/")
        [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $file.FullName, $name) | Out-Null
    }
} finally {
    $archive.Dispose()
}
Remove-Item $stage -Recurse -Force

$entries = [IO.Compression.ZipFile]::OpenRead($zip)
try {
    $names = @($entries.Entries | ForEach-Object FullName)
} finally {
    $entries.Dispose()
}
$extra = @($names | Where-Object { $_ -notin $allowed })
$check = [IO.Compression.ZipFile]::OpenRead($zip)
try {
    $reader = New-Object IO.StreamReader($check.GetEntry($exeName).Open(), [Text.Encoding]::ASCII)
    $exeText = $reader.ReadToEnd()
    $reader.Dispose()
} finally {
    $check.Dispose()
}
if ($exeText.Contains("definePlugin")) {
    Remove-Item $zip -Force
    throw "The installer exe contains plugin code. Plugins must never be built into it."
}
if ($extra.Count -or $names.Count -ne $allowed.Count) {
    Remove-Item $zip -Force
    throw "The release zip had unexpected files: $($extra -join ', '). Only the installer and the empty kit folders may ship."
}
Write-Host "Built $zip"
$names | ForEach-Object { Write-Host "  $_" }
