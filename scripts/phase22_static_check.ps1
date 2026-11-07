param([ValidateSet('check','test-check','clippy')][string]$Stage='check')
$ErrorActionPreference='Stop'
$projectRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location -LiteralPath $projectRoot
$env:RUSTUP_TOOLCHAIN='stable'
$env:CARGO_HOME=Join-Path $projectRoot '.tmp/duckdb-size-tools/cargo-home'
$env:CARGO_TARGET_DIR=Join-Path $projectRoot '.tmp/duckdb-size-target'
$env:CARGO_NET_OFFLINE='true'
$env:PATH=(Join-Path $projectRoot '.tmp/duckdb-size-tools/cmake-3.31.6-windows-x86_64/bin')+';'+$env:PATH
& node scripts/sync_native_runtime.cjs
if($LASTEXITCODE -ne 0){throw 'Runtime sync failed'}
& node scripts/phase22_static_check.cjs
if($LASTEXITCODE -ne 0){throw 'Module-only manifest setup failed'}
$cargoArgs=if($Stage -eq 'clippy'){@('clippy','--release','--lib')}elseif($Stage -eq 'test-check'){@('check','--release','--tests')}else{@('check','--release','--lib')}
$cargoArgs+=@('--manifest-path','.tmp/phase22-typecheck/Cargo.toml','--features','custom-protocol','--locked','--offline')
if($Stage -eq 'clippy'){$cargoArgs+=@('--','-D','warnings')}
& node scripts/hdf5_release_build.mjs cargo @cargoArgs
if($LASTEXITCODE -ne 0){throw 'Module-only Rust metadata check failed'}
