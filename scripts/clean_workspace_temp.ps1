[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [ValidateRange(1, [long]::MaxValue)]
    [long]$MinimumBytes = 64MB
)

$ErrorActionPreference = "Stop"

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$tempRoot = [IO.Path]::GetFullPath((Join-Path $repositoryRoot ".tmp"))
$expectedTempRoot = $repositoryRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) +
    [IO.Path]::DirectorySeparatorChar + ".tmp"

if (-not $tempRoot.Equals($expectedTempRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to clean an unexpected temporary directory: $tempRoot"
}

if (-not (Test-Path -LiteralPath $tempRoot -PathType Container)) {
    Write-Output "Workspace temporary directory does not exist: $tempRoot"
    exit 0
}

$removedBytes = 0L
$removedCount = 0
$entries = Get-ChildItem -LiteralPath $tempRoot -Force

foreach ($entry in $entries) {
    $entryPath = [IO.Path]::GetFullPath($entry.FullName)
    if (-not $entryPath.StartsWith(
            $tempRoot + [IO.Path]::DirectorySeparatorChar,
            [StringComparison]::OrdinalIgnoreCase
        )) {
        throw "Refusing to inspect a temporary entry outside the workspace .tmp directory: $entryPath"
    }

    if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        Write-Warning "Skipped reparse-point temporary entry: $entryPath"
        continue
    }

    $bytes = if ($entry.PSIsContainer) {
        [long]((Get-ChildItem -LiteralPath $entryPath -Recurse -File -Force -ErrorAction Stop |
                    Measure-Object Length -Sum).Sum)
    }
    else {
        [long]$entry.Length
    }

    if ($bytes -lt $MinimumBytes) {
        continue
    }

    $sizeMiB = [math]::Round($bytes / 1MB, 1)
    if ($PSCmdlet.ShouldProcess($entryPath, "Remove generated workspace temporary entry ($sizeMiB MiB)")) {
        Remove-Item -LiteralPath $entryPath -Recurse -Force
        $removedBytes += $bytes
        $removedCount += 1
        Write-Output "Removed $entryPath ($sizeMiB MiB)."
    }
}

$removedGiB = [math]::Round($removedBytes / 1GB, 3)
Write-Output "Workspace temporary cleanup complete. Removed $removedCount entries totaling $removedGiB GiB."
