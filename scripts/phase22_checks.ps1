param(
    [ValidateSet('check','test','sql-unit','storage-folders-unit','chart-unit','chart-batch-audit','csv-waiter','csv-corrupt','clippy','format','build','native-build','chart-followup-build','chart-options-build','chart-analysis-build','chart-performance-build','chart-image-export-build','chart-image-release-build','chart-image-release-bundle','chart-image-direct-build','chart-image-rebuild','cte-completion-build','sql-grid-navigation-build','storage-draft-build','export-overwrite-build','workspace-draft-build','workspace-draft-bundle','workspace-direct-build','chart-fidelity-build','chart-fidelity-bundle','scatter-tooltip-build','scatter-tooltip-bundle','storage-reclaim-retry','environment-retry','bundle')][string]$Stage='check',
    [ValidateSet(22,23,24,25)][int]$Phase=22
)
$ErrorActionPreference='Stop'
$projectRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location -LiteralPath $projectRoot
$env:RUSTUP_TOOLCHAIN='stable'
$env:CARGO_HOME=Join-Path $projectRoot '.tmp/duckdb-size-tools/cargo-home'
$env:CARGO_TARGET_DIR=Join-Path $projectRoot '.tmp/duckdb-size-target'
$directBuild=$Stage -in @('chart-image-direct-build','chart-image-rebuild','workspace-direct-build')
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
if ($Stage -eq 'environment-retry') {
    $testExecutable = Get-ChildItem -LiteralPath (Join-Path $env:CARGO_TARGET_DIR 'release/deps') -Filter 'data_viewer_lib-*.exe' -File |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (!$testExecutable) { throw 'Run the Rust suite before retrying the environment tests.' }
    $failedTests = @(
        'data::csv_polars::tests::hardlink_probe_is_removed_after_success',
        'data::csv_polars::tests::hardlink_snapshot_keeps_pinned_content_after_same_fingerprint_path_replace',
        'data::csv_polars::tests::storage_pressure_worker_budget_error_terminates_child_and_cleans_staging',
        'data::csv_source::tests::polars_provider_publishes_compact_v3_view_with_rust_state_parity',
        'query::engine::tests::csv_persistent_cache_rejects_corrupt_entries_and_cleans_partial_staging',
        'storage::csv_cache::tests::cache_clear_records_entry_lock_failures_and_leaves_the_entry_intact',
        'storage::csv_cache::tests::cache_clear_skips_an_entry_leased_by_another_process',
        'storage::csv_cache::tests::cache_usage_and_clear_report_active_deleted_and_remaining_entries',
        'storage::csv_cache::tests::tmp18_query_reclaim_removes_minimum_inactive_lru_and_preserves_active_and_foreign',
        'storage::csv_cache::tests::tmp18_reclaim_skips_a_delete_failure_and_uses_the_next_valid_candidate',
        'storage::csv_cache::tests::tmp18_running_pressure_reclaims_inactive_then_active_only_fails_typed',
        'storage::csv_cache::tests::tmp18_same_timestamp_reclaim_uses_cache_key_as_a_stable_tie_break',
        'storage::temp::tests::storage_pressure_only_exact_registered_file_identity_is_exempt',
        'storage::temp::tests::storage_pressure_pinned_alias_does_not_charge_source_and_all_accounting_agrees'
    )
    Write-Output "Retry with existing test binary: $($testExecutable.FullName)"
    $failures = 0
    foreach ($testName in $failedTests) {
        & $testExecutable.FullName --exact $testName --test-threads=1
        if ($LASTEXITCODE -ne 0) { $failures++ }
    }
    if ($failures -gt 0) { throw "$failures environment retry tests failed." }
    exit 0
}
if($Stage -eq 'storage-reclaim-retry'){
    $testExecutable=Get-ChildItem -LiteralPath (Join-Path $env:CARGO_TARGET_DIR 'release/deps') -Filter 'data_viewer_lib-*.exe' -File |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if(!$testExecutable){throw 'Run the Rust suite before retrying the storage test.'}
    Write-Output "Retry with existing test binary: $($testExecutable.FullName)"
    & $testExecutable.FullName --exact storage::csv_cache::tests::tmp18_reclaim_skips_a_delete_failure_and_uses_the_next_valid_candidate --test-threads=1
    exit $LASTEXITCODE
}
& node scripts/sync_native_runtime.cjs
if($LASTEXITCODE -ne 0){throw 'Runtime sync failed'}
$manifest='artifacts/experiments/csv-native-parquet/size-variant/Cargo.toml'
$identifier=if($Stage -eq 'chart-image-export-build'){'com.denrew88.data-viewer-chart-image-export'}elseif($Stage -eq 'cte-completion-build'){'com.denrew88.data-viewer-cte-completion'}elseif($Stage -ne 'workspace-direct-build' -and ($Phase -eq 25 -or $Stage -in @('native-build','chart-followup-build','chart-options-build','storage-draft-build','export-overwrite-build'))){"com.denrew88.data-viewer-phase$Phase-acceptance"}else{'com.denrew88.data-viewer'}
$version="0.$Phase.0"
$env:TAURI_CONFIG=@{identifier=$identifier;version=$version} | ConvertTo-Json -Compress
if ($Phase -ge 24) {
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
$candidateStages=@('build','native-build','chart-followup-build','chart-options-build','chart-analysis-build','chart-performance-build','chart-image-export-build','chart-image-release-build','cte-completion-build','sql-grid-navigation-build','storage-draft-build','export-overwrite-build','workspace-draft-build','chart-fidelity-build')
$bundleStages=@('bundle','chart-image-release-bundle','workspace-draft-bundle','chart-fidelity-bundle','scatter-tooltip-bundle')
if ($Stage -notin @('workspace-draft-build','workspace-draft-bundle','workspace-direct-build','chart-fidelity-build','chart-fidelity-bundle','scatter-tooltip-build','scatter-tooltip-bundle') -and ($Stage -in $candidateStages -or $Stage -in $bundleStages -or $directBuild)) {
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
    $variant=switch($Stage){
        'chart-image-release-bundle' {"phase-$Phase-chart-image-release"}
        'workspace-draft-bundle' {"phase-$Phase-workspaces"}
        'chart-fidelity-bundle' {"phase-$Phase-chart-fidelity"}
        'scatter-tooltip-bundle' {"phase-$Phase-scatter-tooltip-opacity"}
        default {"phase-$Phase"}
    }
    $candidate=Join-Path $projectRoot "src-tauri/target/release/candidates/$variant/data-viewer.exe"
    Copy-Item -LiteralPath $candidate -Destination (Join-Path $env:CARGO_TARGET_DIR 'release/data-viewer.exe')
    $bundleArgs=@('bundle','--bundles','nsis','--ci')
    if($Stage -in @('workspace-draft-bundle','chart-fidelity-bundle','scatter-tooltip-bundle')){
        $configPath=Join-Path $testTemp 'draft-tauri.conf.json'
        [IO.File]::WriteAllText($configPath,$env:TAURI_CONFIG)
        $bundleArgs+=@('--config',$configPath)
    }
    Push-Location -LiteralPath (Join-Path $projectRoot 'artifacts/experiments/csv-native-parquet/size-variant')
    try {
        & node (Join-Path $projectRoot 'node_modules/@tauri-apps/cli/tauri.js') @bundleArgs
        if($LASTEXITCODE -ne 0){throw "Phase $Phase NSIS bundle failed"}
    } finally {Pop-Location}
    $installer="Data Viewer_${version}_x64-setup.exe"
    $output=Join-Path (Split-Path -Parent $candidate) $installer
    Copy-Item -LiteralPath (Join-Path $env:CARGO_TARGET_DIR "release/bundle/nsis/$installer") -Destination $output
    Write-Output "Installer: $output"
    exit 0
}
if ($Stage -eq 'scatter-tooltip-build') {
    $builtExe = Join-Path $env:CARGO_TARGET_DIR 'release/data-viewer.exe'
    $frontendIndex = Join-Path $projectRoot 'dist/index.html'
    if (!(Test-Path -LiteralPath $builtExe -PathType Leaf) -or
        (Get-Item -LiteralPath $builtExe).LastWriteTimeUtc -lt (Get-Item -LiteralPath $frontendIndex).LastWriteTimeUtc) {
        $entry = Join-Path (Split-Path -Parent $manifest) 'src/main.rs'
        (Get-Item -LiteralPath $entry).LastWriteTime = Get-Date
        & node scripts/hdf5_release_build.mjs cargo build --release --bin data-viewer --manifest-path $manifest --features custom-protocol --locked --offline
        if ($LASTEXITCODE -ne 0) { throw 'Scatter tooltip native build failed.' }
    }
    $destination = Join-Path $projectRoot "src-tauri/target/release/candidates/phase-$Phase-scatter-tooltip-opacity"
    New-Item -ItemType Directory -Force -Path $destination | Out-Null
    Copy-Item -LiteralPath $builtExe -Destination (Join-Path $destination 'data-viewer.exe')
    Write-Output "Candidate: $destination/data-viewer.exe"
    exit 0
}
$cargoArgs=switch($Stage){
    'check' {@('check','--release','--all-targets')}
    'test' {@('test','--release','--lib')}
    'sql-unit' {@('test','--release','--lib','sql_workspace')}
    'storage-folders-unit' {@('test','--release','--lib','storage_folders')}
    'chart-unit' {@('test','--release','--lib','query::chart')}
    'chart-batch-audit' {@('test','--release','--lib','prepared_chart_batch_candidate_audit','--','--ignored','--nocapture')}
    'csv-waiter' {@('test','--release','--lib','cancelling_query_waiter_preserves_distinct_waiter_and_shared_csv_preparation')}
    'csv-corrupt' {@('test','--release','--lib','csv_persistent_cache_rejects_corrupt_entries_and_cleans_partial_staging')}
    'clippy' {@('clippy','--release','--all-targets')}
    'build' {@('build','--release','--bin','data-viewer')}
    'native-build' {@('build','--release','--bin','data-viewer')}
    'chart-followup-build' {@('build','--release','--bin','data-viewer')}
    'chart-options-build' {@('build','--release','--bin','data-viewer')}
    'chart-analysis-build' {@('build','--release','--bin','data-viewer')}
    'chart-performance-build' {@('build','--release','--bin','data-viewer')}
    'workspace-draft-build' {@('build','--release','--bin','data-viewer')}
    'workspace-direct-build' {@('build','--release','--bin','data-viewer')}
    'chart-fidelity-build' {@('build','--release','--bin','data-viewer')}
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
    Get-Process -Name 'data-viewer' -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -and [string]::Equals($_.Path, $directExe, [StringComparison]::OrdinalIgnoreCase) } |
        ForEach-Object {
            Write-Output "Stopping Viewer at build target: $($_.Path)"
            Stop-Process -InputObject $_ -ErrorAction Stop
            $_.WaitForExit()
        }
    if(Test-Path -LiteralPath $directExe -PathType Leaf){
        $backupRoot=if($Stage -eq 'workspace-direct-build'){'.tmp/phase-25/direct-release'}else{'.tmp/chart-image-export/direct-release'}
        $backupDir=Join-Path $projectRoot $backupRoot
        New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
        $previousHash=Get-ReleaseSha256 $directExe
        $backup=Join-Path $backupDir "previous-$previousHash.exe"
        if(!(Test-Path -LiteralPath $backup -PathType Leaf)){
            Copy-Item -LiteralPath $directExe -Destination $backup
        }
        if((Get-ReleaseSha256 $backup) -ne $previousHash){
            throw 'The previous release backup did not match its source.'
        }
        Write-Output "Previous release backup: $backup"
    }
    # Invalidate only the generated product entry point and keep dependencies cached.
    $entry=Join-Path (Split-Path -Parent $manifest) 'src/main.rs'
    (Get-Item -LiteralPath $entry).LastWriteTime=Get-Date
}
if($Stage -in @('workspace-draft-build','chart-fidelity-build')){
    # Re-embed the verified frontend even when only Vite assets changed.
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
        'chart-performance-build' {"phase-$Phase-chart-performance"}
        'workspace-draft-build' {if($env:P25_SETTINGS_DRAFT -eq '1'){"phase-$Phase-settings"}elseif($env:P25_SQL_SCALE_DRAFT -eq '1'){"phase-$Phase-sql-scale"}else{"phase-$Phase-workspaces"}}
        'chart-fidelity-build' {"phase-$Phase-chart-fidelity"}
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
