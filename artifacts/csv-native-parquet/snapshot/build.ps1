param([ValidateSet('check','test','build','clippy','fmt')][string]$Stage='build', [string]$OutputName='csv-native-parquet.exe')
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
Set-Location -LiteralPath $projectRoot
$env:RUSTUP_TOOLCHAIN = 'stable'
$env:CARGO_HOME = Join-Path $projectRoot '.tmp/duckdb-size-tools/cargo-home'
$env:CARGO_TARGET_DIR = Join-Path $projectRoot '.tmp/csv-native-parquet-target'
$env:CARGO_NET_OFFLINE = 'true'
$manifest = Join-Path $PSScriptRoot 'Cargo.toml'
$log = Join-Path $PSScriptRoot ($Stage + '.log')
$ErrorActionPreference = 'Continue'
if ($Stage -eq 'fmt') { & cargo fmt --manifest-path $manifest -- --check *> $log }
elseif ($Stage -eq 'clippy') { & cargo clippy --release --all-targets --manifest-path $manifest --offline -- -D warnings *> $log }
elseif ($Stage -eq 'check') { & cargo check --manifest-path $manifest --offline *> $log }
else { & cargo $Stage --release --manifest-path $manifest --offline *> $log }
$result = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
Get-Content -LiteralPath $log -Tail 24
if ($result -ne 0) { throw "$Stage failed ($result)" }
if ($Stage -eq 'build') { Copy-Item -LiteralPath (Join-Path $env:CARGO_TARGET_DIR 'release/csv-native-parquet.exe') -Destination (Join-Path $PSScriptRoot $OutputName) }
