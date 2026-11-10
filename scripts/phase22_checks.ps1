param(
    [ValidateSet('check','test','sql-unit','chart-unit','csv-waiter','csv-corrupt','clippy','format','build','native-build','chart-followup-build','chart-options-build','chart-analysis-build','chart-image-export-build','chart-image-release-build','chart-image-release-bundle','chart-image-direct-build','chart-image-rebuild','cte-completion-build','sql-grid-navigation-build','storage-draft-build','export-overwrite-build','bundle')][string]$Stage='check',
    [ValidateSet(22,23,24)][int]$Phase=22
)
$ErrorActionPreference='Stop'
$projectRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location -LiteralPath $projectRoot
$env:RUSTUP_TOOLCHAIN='stable'
$env:CARGO_HOME=Join-Path $projectRoot '.tmp/duckdb-size-tools/cargo-home'
$env:CARGO_TARGET_DIR=Join-Path $projectRoot '.tmp/duckdb-size-target'
$directBuild=$Stage -in @('chart-image-direct-build','chart-image-rebuild')
if ($directBuild) {
    $env:CARGO_BUILD_BUILD_DIR=$env:CARGO_TARGET_DIR
    $outputTarget=if($Stage -eq 'chart-image-rebuild'){'src-tauri/target/chart-image-rebuild'}else{'src-tauri/target'}
    $env:CARGO_TARGET_DIR=Join-Path $projectRoot $outputTarget
}
$env:CARGO_NET_OFFLINE='true'
$env:PATH=(Join-Path $projectRoot '.tmp/duckdb-size-tools/cmake-3.31.6-windows-x86_64/bin')+';'+$env:PATH
$testTemp=Join-Path $projectRoot ".tmp/phase$Phase-tests"
New-Item -ItemType Directory -Force -Path $testTemp | Out-Null
$env:TEMP=$testTemp
$env:TMP=$testTemp
& node scripts/sync_native_runtime.cjs
if($LASTEXITCODE -ne 0){throw 'Runtime sync failed'}
$manifest='artifacts/experiments/csv-native-parquet/size-variant/Cargo.toml'
$identifier=if($Stage -eq 'chart-image-export-build'){'com.denrew88.data-viewer-chart-image-export'}elseif($Stage -eq 'cte-completion-build'){'com.denrew88.data-viewer-cte-completion'}elseif($Stage -in @('native-build','chart-followup-build','chart-options-build','storage-draft-build','export-overwrite-build')){"com.denrew88.data-viewer-phase$Phase-acceptance"}else{'com.denrew88.data-viewer'}
$version="0.$Phase.0"
$env:TAURI_CONFIG=@{identifier=$identifier;version=$version} | ConvertTo-Json -Compress
if ($Phase -eq 24) {
    $variantRoot=Split-Path -Parent $manifest
    $manifestPath=Join-Path $projectRoot $manifest
    $lockPath=Join-Path $projectRoot (Join-Path $variantRoot 'Cargo.lock')
    $manifestText=[IO.File]::ReadAllText($manifestPath)
    $lockText=[IO.File]::ReadAllText($lockPath)
    $pattern='(?m)(^name = "data-viewer"\r?\nversion = ")0\.\d+\.0(")'
    $replacement='${1}'+$version+'${2}'
    $variantManifest=[regex]::Replace($manifestText,$pattern,$replacement)
    $variantLock=[regex]::Replace($lockText,$pattern,$replacement)
    if ($variantManifest -ne $manifestText) { [IO.File]::WriteAllText($manifestPath,$variantManifest) }
    if ($variantLock -ne $lockText) { [IO.File]::WriteAllText($lockPath,$variantLock) }
}
$candidateStages=@('build','native-build','chart-followup-build','chart-options-build','chart-analysis-build','chart-image-export-build','chart-image-release-build','cte-completion-build','sql-grid-navigation-build','storage-draft-build','export-overwrite-build')
$bundleStages=@('bundle','chart-image-release-bundle')
if ($Stage -in $candidateStages -or $Stage -in $bundleStages -or $directBuild) {
    $configuredVersion=(Get-Content -LiteralPath 'src-tauri/tauri.conf.json' -Raw | ConvertFrom-Json).version
    if ($configuredVersion -ne $version) { throw "Phase $Phase requires application version $version." }
}
if($Stage -eq 'format'){
    & cargo fmt --manifest-path src-tauri/Cargo.toml
    if($LASTEXITCODE -ne 0){throw 'Product format failed'}
    & node scripts/sync_native_runtime.cjs
    if($LASTEXITCODE -ne 0){throw 'Formatted runtime sync failed'}
    & cargo fmt --manifest-path $manifest
    if($LASTEXITCODE -ne 0){throw 'Native format failed'}
    exit 0
}
if($Stage -in $bundleStages){
    $variant=if($Stage -eq 'chart-image-release-bundle'){"phase-$Phase-chart-image-release"}else{"phase-$Phase"}
    $candidate=Join-Path $projectRoot "src-tauri/target/release/candidates/$variant/data-viewer.exe"
    Copy-Item -LiteralPath $candidate -Destination (Join-Path $env:CARGO_TARGET_DIR 'release/data-viewer.exe')
    Push-Location -LiteralPath (Join-Path $projectRoot 'artifacts/experiments/csv-native-parquet/size-variant')
    try {
        & node (Join-Path $projectRoot 'node_modules/@tauri-apps/cli/tauri.js') bundle --bundles nsis --ci
        if($LASTEXITCODE -ne 0){throw "Phase $Phase NSIS bundle failed"}
    } finally {Pop-Location}
    $installer="Data Viewer_${version}_x64-setup.exe"
    $output=Join-Path (Split-Path -Parent $candidate) $installer
    Copy-Item -LiteralPath (Join-Path $env:CARGO_TARGET_DIR "release/bundle/nsis/$installer") -Destination $output
    Write-Output "Installer: $output"
    exit 0
}
$cargoArgs=switch($Stage){
    'check' {@('check','--release','--all-targets')}
    'test' {@('test','--release','--lib')}
    'sql-unit' {@('test','--release','--lib','sql_workspace')}
    'chart-unit' {@('test','--release','--lib','query::chart')}
    'csv-waiter' {@('test','--release','--lib','cancelling_query_waiter_preserves_distinct_waiter_and_shared_csv_preparation')}
    'csv-corrupt' {@('test','--release','--lib','csv_persistent_cache_rejects_corrupt_entries_and_cleans_partial_staging')}
    'clippy' {@('clippy','--release','--all-targets')}
    'build' {@('build','--release','--bin','data-viewer')}
    'native-build' {@('build','--release','--bin','data-viewer')}
    'chart-followup-build' {@('build','--release','--bin','data-viewer')}
    'chart-options-build' {@('build','--release','--bin','data-viewer')}
    'chart-analysis-build' {@('build','--release','--bin','data-viewer')}
    'chart-image-export-build' {@('build','--release','--bin','data-viewer')}
    'chart-image-release-build' {@('build','--release','--bin','data-viewer')}
    'chart-image-direct-build' {@('build','--release','--bin','data-viewer')}
    'chart-image-rebuild' {@('build','--release','--bin','data-viewer')}
    'cte-completion-build' {@('build','--release','--bin','data-viewer')}
    'sql-grid-navigation-build' {@('build','--release','--bin','data-viewer')}
    'storage-draft-build' {@('build','--release','--bin','data-viewer')}
    'export-overwrite-build' {@('build','--release','--bin','data-viewer')}
}
$cargoArgs+=@('--manifest-path',$manifest,'--features','custom-protocol','--locked','--offline')
if($Stage -eq 'clippy'){$cargoArgs+=@('--','-D','warnings')}
if($Stage -eq 'test'){$cargoArgs+=@('--','--test-threads=1')}
if($Stage -in @('csv-waiter','csv-corrupt')){$cargoArgs+=@('--','--nocapture','--test-threads=1')}
if($directBuild){
    function Get-ReleaseSha256([string]$filePath) {
        $sha=[Security.Cryptography.SHA256]::Create()
        $stream=[IO.File]::OpenRead($filePath)
        try { return [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-','').ToLowerInvariant() }
        finally { $stream.Dispose(); $sha.Dispose() }
    }
    $directExe=Join-Path $env:CARGO_TARGET_DIR 'release/data-viewer.exe'
    if(Test-Path -LiteralPath $directExe -PathType Leaf){
        $backupDir=Join-Path $projectRoot '.tmp/chart-image-export/direct-release'
        New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
        $previousHash=Get-ReleaseSha256 $directExe
        $backup=Join-Path $backupDir "previous-$previousHash.exe"
        if(!(Test-Path -LiteralPath $backup -PathType Leaf)){
            Copy-Item -LiteralPath $directExe -Destination $backup
        }
        if((Get-ReleaseSha256 $backup) -ne $previousHash){
            throw 'The previous release backup did not match its source.'
        }
    }
    # Invalidate only the generated product entry point and keep dependencies cached.
    $entry=Join-Path (Split-Path -Parent $manifest) 'src/main.rs'
    (Get-Item -LiteralPath $entry).LastWriteTime=Get-Date
}
& node scripts/hdf5_release_build.mjs cargo @cargoArgs
if($LASTEXITCODE -ne 0){throw "Phase $Phase $Stage failed"}
if($directBuild){
    Write-Output "Release: $directExe"
}
if($Stage -in $candidateStages){
    $variant=switch($Stage){
        'storage-draft-build' {"phase-$Phase-storage-draft"}
        'export-overwrite-build' {"phase-$Phase-export-overwrite"}
        'native-build' {"phase-$Phase-native"}
        'chart-followup-build' {"phase-$Phase-chart-followup"}
        'chart-options-build' {"phase-$Phase-chart-options"}
        'chart-analysis-build' {"phase-$Phase-chart-analysis"}
        'chart-image-export-build' {"phase-$Phase-chart-image-export"}
        'chart-image-release-build' {"phase-$Phase-chart-image-release"}
        'cte-completion-build' {"phase-$Phase-cte-completion"}
        'sql-grid-navigation-build' {"phase-$Phase-sql-grid-navigation"}
        default {"phase-$Phase"}
    }
    $destination=Join-Path $projectRoot "src-tauri/target/release/candidates/$variant"
    New-Item -ItemType Directory -Force -Path $destination | Out-Null
    Copy-Item -LiteralPath (Join-Path $env:CARGO_TARGET_DIR 'release/data-viewer.exe') -Destination (Join-Path $destination 'data-viewer.exe')
    Write-Output "Candidate: $destination/data-viewer.exe"
}
