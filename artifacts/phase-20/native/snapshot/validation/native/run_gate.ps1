param([ValidateSet('all','csv','large','worker','parquet','hdf5','diagnose','cache-audit','cancel')][string]$Stage='all')
$ErrorActionPreference='Stop'
$projectRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../../../..'))
Set-Location -LiteralPath $projectRoot
$env:LOCALAPPDATA=Join-Path $PSScriptRoot 'localappdata'
New-Item -ItemType Directory -Force -Path $env:LOCALAPPDATA | Out-Null
& node (Join-Path $PSScriptRoot 'prepare.cjs')
if($LASTEXITCODE-ne 0){throw 'Native script preparation failed'}
$binary=Join-Path $projectRoot 'artifacts/experiments/csv-native-parquet/native-validation.exe'
if(-not(Test-Path -LiteralPath $binary)){throw "Validation executable missing: $binary"}
$summary=[ordered]@{}
function Run-Case([string]$Name,[string]$Program,[string[]]$Arguments){
  $log=Join-Path $PSScriptRoot ($Name+'.log')
  $ErrorActionPreference='Continue'
  & $Program @Arguments *> $log
  $code=$LASTEXITCODE
  $ErrorActionPreference='Stop'
  $summary[$Name]=$code
  Get-Content -LiteralPath $log -Tail 12
}
if($Stage-eq 'diagnose'){Run-Case 'diagnose-candidate' 'node' @((Join-Path $PSScriptRoot 'diagnose.mjs'),$binary,'candidate')}
if($Stage-eq 'cache-audit'){Run-Case 'cache-audit' 'C:/ProgramData/miniforge3/python.exe' @((Join-Path $PSScriptRoot 'cache_audit.py'))}
if($Stage-eq 'cancel'){Run-Case 'cancel' 'node' @((Join-Path $PSScriptRoot 'cancel_large.mjs'))}
if($Stage-in @('all','worker')){Run-Case 'auto-worker' 'C:/ProgramData/miniforge3/python.exe' @((Join-Path $PSScriptRoot 'auto_worker.py'))}
if($Stage-in @('all','large')){Run-Case 'large-auto' 'node' @((Join-Path $PSScriptRoot 'large_auto.mjs'),$binary)}
if($Stage-in @('all','csv')){
 $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9481'
 $env:WEBVIEW2_USER_DATA_FOLDER=Join-Path $PSScriptRoot 'ui/csv-webview'
 Run-Case 'csv' 'node' @((Join-Path $PSScriptRoot 'generated/csv.mjs'),$binary,(Join-Path $PSScriptRoot 'fixtures/small-csv.csv'),(Join-Path $PSScriptRoot 'ui/native-csv.png'))
}
if($Stage-in @('all','parquet')){Run-Case 'parquet' 'node' @((Join-Path $PSScriptRoot 'generated/parquet.mjs'),$binary)}
if($Stage-in @('all','hdf5')){
 Remove-Item Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS -ErrorAction SilentlyContinue
 Run-Case 'hdf5' 'node' @((Join-Path $PSScriptRoot 'generated/hdf5.mjs'),$binary,(Join-Path $projectRoot 'fixtures/phase-11/oef-v3-int32.oes.h5'),(Join-Path $PSScriptRoot 'ui/native-hdf5.png'))
}
$summary | ConvertTo-Json | Set-Content -Encoding UTF8 (Join-Path $PSScriptRoot 'runner-summary.json')
