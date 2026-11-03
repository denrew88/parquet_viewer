param([switch]$CheckOnly, [switch]$AllTargets, [switch]$TestOnly, [switch]$FixtureRetry, [switch]$CancelSpike, [string]$OutputName='native-product-size.exe')
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
Set-Location -LiteralPath $projectRoot
$env:RUSTUP_TOOLCHAIN = 'stable'
$env:CARGO_HOME = Join-Path $projectRoot '.tmp/duckdb-size-tools/cargo-home'
$env:CARGO_TARGET_DIR = Join-Path $projectRoot '.tmp/duckdb-size-target'
$env:CARGO_NET_OFFLINE = 'true'
$env:PATH = (Join-Path $projectRoot '.tmp/duckdb-size-tools/cmake-3.31.6-windows-x86_64/bin') + ';' + $env:PATH
$manifest = Join-Path $PSScriptRoot 'size-variant/Cargo.toml'
if ($TestOnly) {
    & cargo fmt --manifest-path $manifest
    if ($LASTEXITCODE -ne 0) { throw 'Variant format failed' }
    $ErrorActionPreference = 'Continue'
    $testArgs=@('test','--release','--manifest-path',$manifest,'--lib','--features','custom-protocol','--locked','--offline')
    $testLog='validation/app-rust-tests.log'
    if($FixtureRetry){
      $testLog='validation/app-rust-fixture-retry.log'
      $testArgs+=@('--','--exact',
       'commands::tests::csv_query_small_preview_serializes_the_frontend_wire_contract',
       'data::csv_source::tests::phase3_generated_fixtures_match_the_expected_golden_contract',
       'data::oes_hdf5_source::tests::committed_blosc_zstd_v3_fixtures_match_the_transposed_contract',
       'data::oes_hdf5_source::tests::committed_malformed_and_external_storage_fixtures_are_typed_rejections',
       'data::oes_hdf5_source::tests::legacy_phase_10_layout_is_rejected_after_the_v3_contract_change',
       'query::engine::tests::phase12_release_child_smoke_uses_a_small_parquet_fixture',
       'query::engine::tests::qry_csv_and_parquet_have_identical_stable_filtered_projection',
       'query::engine::tests::qry_find_is_non_filtering_and_supports_bounded_next_and_wrap',
       'query::engine::tests::qry_queued_cancel_is_cooperative_and_releases_temp_lifecycle')
    }
    if($CancelSpike){
      $testLog='validation/app-rust-cancel-spike.log'
      $env:PHASE15_LARGE_CSV=Join-Path $projectRoot 'artifacts/experiments/csv-engine-compare/fixtures/high-5850000x15.csv'
      $testArgs+=@('--','--exact','data::csv_polars::tests::large_sink_reaches_terminal_state_within_cancel_budget','--ignored','--nocapture')
    }
    & node scripts/hdf5_release_build.mjs cargo @testArgs *> (Join-Path $PSScriptRoot $testLog)
    $result=$LASTEXITCODE
    $ErrorActionPreference='Stop'
    Get-Content (Join-Path $PSScriptRoot $testLog) -Tail 24
    if($result -ne 0){throw 'Variant full Rust tests failed'}
    exit 0
}
if ($CheckOnly) {
    & cargo fmt --manifest-path $manifest -- --check
    if ($LASTEXITCODE -ne 0) { throw 'Variant format check failed' }
    $ErrorActionPreference = 'Continue'
    $clippyArgs=@('clippy','--release','--manifest-path',$manifest,'--features','custom-protocol','--locked','--offline')
    if($AllTargets){$clippyArgs+=@('--all-targets')}else{$clippyArgs+=@('--lib','--bin','data-viewer')}
    $clippyArgs+=@('--','-D','warnings')
    & node scripts/hdf5_release_build.mjs cargo @clippyArgs *> (Join-Path $PSScriptRoot 'size-clippy.log')
    $result = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    Get-Content (Join-Path $PSScriptRoot 'size-clippy.log') -Tail 12
    if ($result -ne 0) { throw 'Variant clippy failed' }
    exit 0
}
& cargo metadata --manifest-path $manifest --offline --format-version 1 > (Join-Path $PSScriptRoot 'size-metadata.json')
if ($LASTEXITCODE -ne 0) { throw 'Variant lock failed' }
& cargo fmt --manifest-path $manifest
if ($LASTEXITCODE -ne 0) { throw 'Variant fmt failed' }
$started = Get-Date
$ErrorActionPreference = 'Continue'
& node scripts/hdf5_release_build.mjs cargo build --release --manifest-path $manifest --bin data-viewer --features custom-protocol --locked --offline *> (Join-Path $PSScriptRoot 'size-build.log')
$result = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
if ($result -ne 0) { Get-Content (Join-Path $PSScriptRoot 'size-build.log') -Tail 35; throw "Size build failed $result" }
$output = Join-Path $PSScriptRoot $OutputName
Copy-Item -LiteralPath (Join-Path $env:CARGO_TARGET_DIR 'release/data-viewer.exe') -Destination $output
$metadata = if ($OutputName -eq 'native-product-size.exe') { '61-size-build.json' } else { 'validation/build-app.json' }
@{bytes=(Get-Item $output).Length; sha256=(Get-FileHash $output -Algorithm SHA256).Hash; seconds=((Get-Date)-$started).TotalSeconds} | ConvertTo-Json | Set-Content -Encoding UTF8 (Join-Path $PSScriptRoot $metadata)
Get-Content (Join-Path $PSScriptRoot $metadata)
