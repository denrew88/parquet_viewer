param([ValidateSet('check','test','category','cursor','cursor-unit','cache-identity','clippy','format','build','native-build','bundle')][string]$Stage='check')
$ErrorActionPreference='Stop'
function Get-Phase21Hash([string]$File) {
    $stream=[IO.File]::OpenRead($File)
    $sha=[Security.Cryptography.SHA256]::Create()
    try {return [BitConverter]::ToString($sha.ComputeHash($stream))}
    finally {$sha.Dispose();$stream.Dispose()}
}
$projectRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location -LiteralPath $projectRoot
$env:RUSTUP_TOOLCHAIN='stable'
$env:CARGO_HOME=Join-Path $projectRoot '.tmp/duckdb-size-tools/cargo-home'
$env:CARGO_TARGET_DIR=Join-Path $projectRoot '.tmp/duckdb-size-target'
$env:CARGO_NET_OFFLINE='true'
$env:PATH=(Join-Path $projectRoot '.tmp/duckdb-size-tools/cmake-3.31.6-windows-x86_64/bin')+';'+$env:PATH
$testTemp=Join-Path $projectRoot '.tmp/phase21-tests'
New-Item -ItemType Directory -Force -Path $testTemp | Out-Null
$env:TEMP=$testTemp
$env:TMP=$testTemp
if($Stage -in @('category','cursor')){
    # Reuse the user's immutable prepared input read-only; spill stays in .tmp.
    $cacheRoot=Join-Path $env:USERPROFILE 'AppData/Local/com.denrew88.data-viewer-native-validation-20261103/csv-cache-v1'
    foreach($entry in (Get-ChildItem -LiteralPath $cacheRoot -Directory -ErrorAction SilentlyContinue)){
        $entryManifest=Join-Path $entry.FullName 'cache-manifest.json'
        if(Test-Path -LiteralPath $entryManifest){
            $entryData=Get-Content -LiteralPath $entryManifest -Raw | ConvertFrom-Json
            if($entryData.canonicalPath -like '*high-5850000x15.csv'){
                $env:DATA_VIEWER_P21_CATEGORY_PREPARED=Join-Path $entry.FullName 'prepared.parquet'
                break
            }
        }
    }
    Write-Output "Category read-only prepared input: $env:DATA_VIEWER_P21_CATEGORY_PREPARED"
}
& node scripts/sync_native_runtime.cjs
if($LASTEXITCODE -ne 0){throw 'Runtime sync failed'}
$manifest='artifacts/experiments/csv-native-parquet/size-variant/Cargo.toml'
if($Stage -eq 'native-build'){
    $env:TAURI_CONFIG='{"identifier":"com.denrew88.data-viewer-phase21-acceptance"}'
}else{
    Remove-Item Env:TAURI_CONFIG -ErrorAction SilentlyContinue
}
if($Stage -eq 'format'){
    & cargo fmt --manifest-path src-tauri/Cargo.toml
    if($LASTEXITCODE -ne 0){throw 'Product format failed'}
    & cargo fmt --manifest-path $manifest
    if($LASTEXITCODE -ne 0){throw 'Native format failed'}
    exit 0
}
if($Stage -eq 'bundle'){
    $candidate=Join-Path $projectRoot 'src-tauri/target/release/candidates/phase-21/data-viewer.exe'
    $built=Join-Path $env:CARGO_TARGET_DIR 'release/data-viewer.exe'
    # Tauri patches the staging EXE with bundle metadata, even if a tool download
    # fails. Always stage the immutable production candidate before retrying.
    Copy-Item -LiteralPath $candidate -Destination $built
    if((Get-Phase21Hash $candidate) -ne (Get-Phase21Hash $built)){throw 'Bundle requires the final production candidate, not the isolated validation binary'}
    Push-Location -LiteralPath (Join-Path $projectRoot 'artifacts/experiments/csv-native-parquet/size-variant')
    try {
        & node (Join-Path $projectRoot 'node_modules/@tauri-apps/cli/tauri.js') bundle --bundles nsis --ci
        if($LASTEXITCODE -ne 0){throw 'Phase 21 NSIS bundle failed'}
    } finally {Pop-Location}
    $installer=Join-Path $env:CARGO_TARGET_DIR 'release/bundle/nsis/Data Viewer_0.21.0_x64-setup.exe'
    Copy-Item -LiteralPath $installer -Destination (Join-Path (Split-Path -Parent $candidate) 'Data Viewer_0.21.0_x64-setup.exe')
    Write-Output "Installer: $installer"
    exit 0
}
& cargo fmt --manifest-path $manifest -- --check
if($LASTEXITCODE -ne 0){throw 'Format check failed'}
$cargoArgs=switch($Stage){
    'check' {@('check','--release','--all-targets')}
    'test' {@('test','--release','--lib')}
    'category' {@('test','--release','--lib','p21_category')}
    'cursor' {@('test','--release','--lib','p21_category_cursor_5850000_128m_512m')}
    'cursor-unit' {@('test','--release','--lib','query::engine::column_values::tests')}
    'cache-identity' {@('test','--release','--lib','csv_persistent_cache_misses_when_same_path_size_and_times_have_a_new_file_identity')}
    'clippy' {@('clippy','--release','--all-targets')}
    'build' {@('build','--release','--bin','data-viewer')}
    'native-build' {@('build','--release','--bin','data-viewer')}
}
$cargoArgs+=@('--manifest-path',$manifest,'--features','custom-protocol','--locked','--offline')
if($Stage -eq 'clippy'){$cargoArgs+=@('--','-D','warnings')}
if($Stage -in @('category','cursor')){$cargoArgs+=@('--','--ignored','--nocapture','--test-threads=1')}
& node scripts/hdf5_release_build.mjs cargo @cargoArgs
if($LASTEXITCODE -ne 0){throw "Phase 21 $Stage failed"}
if($Stage -in @('build','native-build')){
    $destination=Join-Path $projectRoot $(if($Stage -eq 'native-build'){'src-tauri/target/release/candidates/phase-21-native'}else{'src-tauri/target/release/candidates/phase-21'})
    New-Item -ItemType Directory -Force -Path $destination | Out-Null
    Copy-Item -LiteralPath (Join-Path $env:CARGO_TARGET_DIR 'release/data-viewer.exe') -Destination (Join-Path $destination 'data-viewer.exe')
    Write-Output "Candidate: $destination/data-viewer.exe"
}
