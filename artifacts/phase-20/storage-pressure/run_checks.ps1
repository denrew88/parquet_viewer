param([ValidateSet('targeted','full','clippy','probe','format','utf8-view')][string]$Stage='targeted')
$ErrorActionPreference='Stop'
$projectRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
Set-Location -LiteralPath $projectRoot
$env:RUSTUP_TOOLCHAIN='stable'
$env:CARGO_HOME=Join-Path $projectRoot '.tmp/duckdb-size-tools/cargo-home'
$env:CARGO_TARGET_DIR=Join-Path $projectRoot '.tmp/duckdb-size-target'
$env:CARGO_NET_OFFLINE='true'
$testTemp = Join-Path $projectRoot '.tmp/storage-pressure-tests'
New-Item -ItemType Directory -Force -Path $testTemp | Out-Null
$env:TEMP=$testTemp
$env:TMP=$testTemp
$env:PATH=(Join-Path $projectRoot '.tmp/duckdb-size-tools/cmake-3.31.6-windows-x86_64/bin')+';'+$env:PATH
$manifest='artifacts/experiments/csv-native-parquet/size-variant/Cargo.toml'
& node artifacts/phase-20/storage-pressure/sync_runtime.cjs
if($LASTEXITCODE -ne 0){throw 'Runtime sync failed'}
if($Stage -eq 'format'){
    & cargo fmt --manifest-path src-tauri/Cargo.toml
    if($LASTEXITCODE -ne 0){throw 'Product format failed'}
    & cargo fmt --manifest-path $manifest
    if($LASTEXITCODE -ne 0){throw 'Native format failed'}
    exit 0
}
& cargo fmt --manifest-path $manifest -- --check
if($LASTEXITCODE -ne 0){throw 'Format check failed'}
$filters = if($Stage -eq 'targeted') {@('storage_pressure_','csv_preparation_allocation_failure_notifies_provider_abort_hook')} elseif($Stage -eq 'probe') {@('injected_hardlink_probe_failure_leaves_no_partial_file','storage_pressure_snapshot_probe_preserves_existing_alias_on_creation_failure','hardlink_probe_is_removed_after_success')} elseif($Stage -eq 'utf8-view') {@('p20_utf8_view')} else {@('')}
foreach($filter in $filters){
    $arguments=if($Stage -eq 'clippy') {@('clippy','--release','--manifest-path',$manifest,'--all-targets','--features','custom-protocol','--locked','--offline','--','-D','warnings')} else {@('test','--release','--manifest-path',$manifest,'--lib','--features','custom-protocol','--locked','--offline')}
    if($filter){$arguments+=@($filter,'--','--nocapture')}
    $log=Join-Path $PSScriptRoot "$Stage$filter.log"
    $ErrorActionPreference='Continue'
    & node scripts/hdf5_release_build.mjs cargo @arguments *> $log
    $code=$LASTEXITCODE
    $ErrorActionPreference='Stop'
    Get-Content -LiteralPath $log -Tail 16
    if($code -ne 0){throw "Check failed: $Stage $filter"}
}

