param(
    [ValidateSet('check','test','sql-unit','csv-waiter','csv-corrupt','clippy','format','build','native-build','storage-draft-build','export-overwrite-build','bundle')][string]$Stage='check',
    [ValidateSet(22,23)][int]$Phase=22
)
$ErrorActionPreference='Stop'
$projectRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location -LiteralPath $projectRoot
$env:RUSTUP_TOOLCHAIN='stable'
$env:CARGO_HOME=Join-Path $projectRoot '.tmp/duckdb-size-tools/cargo-home'
$env:CARGO_TARGET_DIR=Join-Path $projectRoot '.tmp/duckdb-size-target'
$env:CARGO_NET_OFFLINE='true'
$env:PATH=(Join-Path $projectRoot '.tmp/duckdb-size-tools/cmake-3.31.6-windows-x86_64/bin')+';'+$env:PATH
$testTemp=Join-Path $projectRoot ".tmp/phase$Phase-tests"
New-Item -ItemType Directory -Force -Path $testTemp | Out-Null
$env:TEMP=$testTemp
$env:TMP=$testTemp
& node scripts/sync_native_runtime.cjs
if($LASTEXITCODE -ne 0){throw 'Runtime sync failed'}
$manifest='artifacts/experiments/csv-native-parquet/size-variant/Cargo.toml'
$identifier=if($Stage -in @('native-build','storage-draft-build','export-overwrite-build')){"com.denrew88.data-viewer-phase$Phase-acceptance"}else{'com.denrew88.data-viewer'}
$env:TAURI_CONFIG=@{identifier=$identifier} | ConvertTo-Json -Compress
$version="0.$Phase.0"
if ($Stage -in @('build','native-build','storage-draft-build','export-overwrite-build','bundle')) {
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
if($Stage -eq 'bundle'){
    $candidate=Join-Path $projectRoot "src-tauri/target/release/candidates/phase-$Phase/data-viewer.exe"
    Copy-Item -LiteralPath $candidate -Destination (Join-Path $env:CARGO_TARGET_DIR 'release/data-viewer.exe')
    Push-Location -LiteralPath (Join-Path $projectRoot 'artifacts/experiments/csv-native-parquet/size-variant')
    try {
        & node (Join-Path $projectRoot 'node_modules/@tauri-apps/cli/tauri.js') bundle --bundles nsis --ci
        if($LASTEXITCODE -ne 0){throw "Phase $Phase NSIS bundle failed"}
    } finally {Pop-Location}
    $installer="Data Viewer_${version}_x64-setup.exe"
    Copy-Item -LiteralPath (Join-Path $env:CARGO_TARGET_DIR "release/bundle/nsis/$installer") -Destination (Join-Path (Split-Path -Parent $candidate) $installer)
    exit 0
}
$cargoArgs=switch($Stage){
    'check' {@('check','--release','--all-targets')}
    'test' {@('test','--release','--lib')}
    'sql-unit' {@('test','--release','--lib','sql_workspace')}
    'csv-waiter' {@('test','--release','--lib','cancelling_query_waiter_preserves_distinct_waiter_and_shared_csv_preparation')}
    'csv-corrupt' {@('test','--release','--lib','csv_persistent_cache_rejects_corrupt_entries_and_cleans_partial_staging')}
    'clippy' {@('clippy','--release','--all-targets')}
    'build' {@('build','--release','--bin','data-viewer')}
    'native-build' {@('build','--release','--bin','data-viewer')}
    'storage-draft-build' {@('build','--release','--bin','data-viewer')}
    'export-overwrite-build' {@('build','--release','--bin','data-viewer')}
}
$cargoArgs+=@('--manifest-path',$manifest,'--features','custom-protocol','--locked','--offline')
if($Stage -eq 'clippy'){$cargoArgs+=@('--','-D','warnings')}
if($Stage -eq 'test'){$cargoArgs+=@('--','--test-threads=1')}
if($Stage -in @('csv-waiter','csv-corrupt')){$cargoArgs+=@('--','--nocapture','--test-threads=1')}
& node scripts/hdf5_release_build.mjs cargo @cargoArgs
if($LASTEXITCODE -ne 0){throw "Phase $Phase $Stage failed"}
if($Stage -in @('build','native-build','storage-draft-build','export-overwrite-build')){
    $variant=switch($Stage){
        'storage-draft-build' {"phase-$Phase-storage-draft"}
        'export-overwrite-build' {"phase-$Phase-export-overwrite"}
        'native-build' {"phase-$Phase-native"}
        default {"phase-$Phase"}
    }
    $destination=Join-Path $projectRoot "src-tauri/target/release/candidates/$variant"
    New-Item -ItemType Directory -Force -Path $destination | Out-Null
    Copy-Item -LiteralPath (Join-Path $env:CARGO_TARGET_DIR 'release/data-viewer.exe') -Destination (Join-Path $destination 'data-viewer.exe')
    Write-Output "Candidate: $destination/data-viewer.exe"
}
