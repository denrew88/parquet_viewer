$ErrorActionPreference='Continue'
Get-Process -Name rustc,cargo,link,lld-link,node -ErrorAction SilentlyContinue | Select-Object ProcessName,Id,CPU,WorkingSet64,StartTime | Format-Table -AutoSize
Get-CimInstance Win32_OperatingSystem | Select-Object FreePhysicalMemory,TotalVisibleMemorySize | Format-List
Get-WinEvent -FilterHashtable @{LogName='Application';StartTime=(Get-Date).AddMinutes(-30);Id=1000,1001} -MaxEvents 10 | Select-Object TimeCreated,Id,Message | Format-List
Get-WinEvent -FilterHashtable @{LogName='Microsoft-Windows-CodeIntegrity/Operational';StartTime=(Get-Date).AddMinutes(-30);Id=3077} -MaxEvents 6 | Select-Object TimeCreated,Id,Message | Format-List
