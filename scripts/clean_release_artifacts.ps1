[CmdletBinding()]
param(
    [switch]$SkipInstaller
)

$ErrorActionPreference = "Stop"

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$tauriRoot = Join-Path $repositoryRoot "src-tauri"
$releaseRoot = Join-Path $tauriRoot "target\release"
$executablePath = Join-Path $releaseRoot "data-viewer.exe"
$noticePath = Join-Path $releaseRoot "THIRD_PARTY_NOTICES.md"

if (-not (Test-Path -LiteralPath $releaseRoot -PathType Container)) {
    throw "Release directory does not exist: $releaseRoot"
}

$resolvedReleaseRoot = (Resolve-Path -LiteralPath $releaseRoot).Path
if (-not $resolvedReleaseRoot.StartsWith(
        $repositoryRoot + [IO.Path]::DirectorySeparatorChar,
        [StringComparison]::OrdinalIgnoreCase
    )) {
    throw "Refusing to clean a release directory outside the repository: $resolvedReleaseRoot"
}

if (-not (Test-Path -LiteralPath $executablePath -PathType Leaf)) {
    throw "Release executable does not exist: $executablePath"
}

if (-not (Test-Path -LiteralPath $noticePath -PathType Leaf)) {
    throw "Required release notice does not exist: $noticePath"
}

$artifacts = @(
    [PSCustomObject]@{
        Source = $executablePath
        RelativePath = "data-viewer.exe"
    },
    [PSCustomObject]@{
        Source = $noticePath
        RelativePath = "THIRD_PARTY_NOTICES.md"
    }
)

if (-not $SkipInstaller) {
    $installerDirectory = Join-Path $releaseRoot "bundle\nsis"
    $installer = Get-ChildItem -LiteralPath $installerDirectory -Filter "*-setup.exe" -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTimeUtc -Descending |
        Select-Object -First 1

    if ($null -eq $installer) {
        throw "NSIS installer does not exist under: $installerDirectory"
    }

    $artifacts += [PSCustomObject]@{
        Source = $installer.FullName
        RelativePath = Join-Path "bundle\nsis" $installer.Name
    }
}

$stageRoot = Join-Path ([IO.Path]::GetTempPath()) ("data-viewer-release-clean-" + [Guid]::NewGuid().ToString("N"))
$completed = $false
$beforeBytes = 0L

try {
    New-Item -ItemType Directory -Path $stageRoot -Force | Out-Null

    $releaseFiles = Get-ChildItem -LiteralPath $releaseRoot -Recurse -File -Force -ErrorAction SilentlyContinue
    $beforeBytes = [long](($releaseFiles | Measure-Object Length -Sum).Sum)

    foreach ($artifact in $artifacts) {
        $stagePath = Join-Path $stageRoot $artifact.RelativePath
        New-Item -ItemType Directory -Path (Split-Path -Parent $stagePath) -Force | Out-Null
        Copy-Item -LiteralPath $artifact.Source -Destination $stagePath -Force
        $artifact | Add-Member -NotePropertyName Sha256 -NotePropertyValue (
            (Get-FileHash -Algorithm SHA256 -LiteralPath $stagePath).Hash
        )
    }

    & cargo clean --manifest-path (Join-Path $tauriRoot "Cargo.toml") --profile release
    if ($LASTEXITCODE -ne 0) {
        throw "cargo clean --profile release failed with exit code $LASTEXITCODE"
    }

    foreach ($artifact in $artifacts) {
        $stagePath = Join-Path $stageRoot $artifact.RelativePath
        $destinationPath = Join-Path $releaseRoot $artifact.RelativePath
        New-Item -ItemType Directory -Path (Split-Path -Parent $destinationPath) -Force | Out-Null
        Copy-Item -LiteralPath $stagePath -Destination $destinationPath -Force

        $restoredHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $destinationPath).Hash
        if ($restoredHash -ne $artifact.Sha256) {
            throw "Restored release artifact failed SHA-256 verification: $destinationPath"
        }
    }

    $completed = $true
    $keptBytes = [long](($artifacts | ForEach-Object {
                (Get-Item -LiteralPath (Join-Path $releaseRoot $_.RelativePath)).Length
            } | Measure-Object -Sum).Sum)
    $removedGiB = [math]::Round(($beforeBytes - $keptBytes) / 1GB, 3)

    Write-Output "Release cleanup complete. Removed $removedGiB GiB of Cargo intermediates."
    foreach ($artifact in $artifacts) {
        Write-Output (Join-Path $releaseRoot $artifact.RelativePath)
    }
}
finally {
    if ($completed -and (Test-Path -LiteralPath $stageRoot)) {
        Remove-Item -LiteralPath $stageRoot -Recurse -Force
    }
    elseif (-not $completed -and (Test-Path -LiteralPath $stageRoot)) {
        Write-Warning "Cleanup did not complete. Preserved artifacts remain at: $stageRoot"
    }
}
