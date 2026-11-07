param([int]$OwnerPid,[string]$OwnerTicks,[string]$Binary,[string]$TempRoot,[string]$Output,[string]$StopFile)
$ErrorActionPreference='Stop'
$owner=Get-Process -Id $OwnerPid
if($owner.StartTime.Ticks.ToString() -ne $OwnerTicks -or $owner.Path -ne $Binary){throw 'Unowned parent'}
Get-CimInstance Win32_Process -Filter "ProcessId=$OwnerPid" | Out-Null
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class SqlStressFileMetadata {
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
 private static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
 [DllImport("kernel32.dll", SetLastError=true)]
 private static extern bool GetFileSizeEx(SafeFileHandle file, out long size);
 public static long Length(string path) {
  // Same metadata-only access as the product's Windows accounting path.
  // Read-data access is incompatible with exclusively opened DuckDB files.
  using (SafeFileHandle file=CreateFileW(path,0x80,7,IntPtr.Zero,3,0,IntPtr.Zero)) {
   if (file.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
   long size;
   if (!GetFileSizeEx(file,out size)) throw new Win32Exception(Marshal.GetLastWin32Error());
   return size;
  }
 }
}
'@
function Get-LiveLength([string]$File){
 try{return [SqlStressFileMetadata]::Length($File)}catch{
  $cause=$_.Exception
  while($cause.InnerException){$cause=$cause.InnerException}
  if($cause -is [ComponentModel.Win32Exception] -and $cause.NativeErrorCode -in @(2,3)){return 0}
  throw
 }
}
$writer=[IO.StreamWriter]::new($Output,$false,[Text.UTF8Encoding]::new($false))
$writer.AutoFlush=$true
$verifiedChildren=@{}
try {
 while(-not (Test-Path -LiteralPath $StopFile)){
  $items=@()
  foreach($p in @(Get-Process -Name 'data-viewer' -ErrorAction SilentlyContinue)){
   try {
   if($p.Id -ne $OwnerPid -and $p.Path -eq $Binary -and $p.StartTime -ge $owner.StartTime -and -not $verifiedChildren.ContainsKey($p.Id)){
    $child=Get-CimInstance Win32_Process -Filter "ProcessId=$($p.Id)"
    if($child.ParentProcessId -eq $OwnerPid -and $child.CommandLine -like '*--data-viewer-sql-worker*'){$verifiedChildren[$p.Id]=$p.StartTime.Ticks.ToString()}
   }
   if($p.Id -eq $OwnerPid -or ($verifiedChildren.ContainsKey($p.Id) -and $verifiedChildren[$p.Id] -eq $p.StartTime.Ticks.ToString())){
    $p.Refresh()
    $items+=@{pid=$p.Id;parent=($p.Id -eq $OwnerPid);cpu=$p.TotalProcessorTime.TotalSeconds;ws=$p.WorkingSet64;private=$p.PrivateMemorySize64;ticks=$p.StartTime.Ticks.ToString()}
   }
   }catch{if(Get-Process -Id $p.Id -ErrorAction SilentlyContinue){throw}}
  }
  $total=0L;$spill=0L;$result=0L;$stale=0L;$jobs=@()
  if(Test-Path -LiteralPath $TempRoot){
   foreach($f in @(Get-ChildItem -LiteralPath $TempRoot -File -Recurse -Force -ErrorAction SilentlyContinue)){
    $live=Get-LiveLength $f.FullName;$total+=$live;$stale+=[Math]::Max(0,$live-$f.Length)
    if($f.FullName -match '[\\/]spill[\\/]'){$spill+=$live}
    if($f.Extension -eq '.parquet'){$result+=$live}
    if($f.Name -eq 'job.json'){try{$j=Get-Content -LiteralPath $f.FullName -Raw | ConvertFrom-Json;$jobBytes=0L;foreach($jf in @(Get-ChildItem -LiteralPath $f.DirectoryName -File -Recurse -Force -ErrorAction SilentlyContinue)){$jobBytes+=Get-LiveLength $jf.FullName};$jobs+=@{path=$f.DirectoryName;allowance=$j.allowance;parent=$j.parent_pid;bytes=$jobBytes;overshoot=[Math]::Max(0,$jobBytes-$j.allowance)}}catch{}}
   }
  }
  $drive=[IO.DriveInfo]::new([IO.Path]::GetPathRoot($TempRoot))
  $writer.WriteLine((@{at=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();processes=$items;tempBytes=$total;spillBytes=$spill;resultBytes=$result;jobs=$jobs;freeBytes=$drive.AvailableFreeSpace;staleEnumerationBytes=$stale}|ConvertTo-Json -Depth 6 -Compress))
  Start-Sleep -Milliseconds 20
 }
}finally{$writer.Dispose()}
