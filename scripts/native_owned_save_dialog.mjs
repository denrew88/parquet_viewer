import assert from "node:assert/strict";

// Automate only a native Save dialog owned by the verified acceptance process.
export async function operateOwnedSaveDialog(powershell, { pid, title, destination = "", overwrite = "" }) {
  const dialog = await powershell(`
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class DataViewerOwnedWindows {
    private delegate bool Enumerate(IntPtr window, IntPtr data);
    [DllImport("user32.dll")] private static extern bool EnumThreadWindows(uint threadId, Enumerate callback, IntPtr data);
    [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr window, Enumerate callback, IntPtr data);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr window, StringBuilder text, int size);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr window, StringBuilder text, int size);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr window, int controlId);
    [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr window);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll", EntryPoint = "SendMessageW", CharSet = CharSet.Unicode, ExactSpelling = true)] private static extern IntPtr SetText(IntPtr window, uint message, IntPtr wParam, string text);
    [DllImport("user32.dll", EntryPoint = "SendMessageW", CharSet = CharSet.Unicode, ExactSpelling = true)] private static extern IntPtr ReadText(IntPtr window, uint message, IntPtr size, StringBuilder text);

    public static IntPtr[] ForThread(uint id) {
        var handles = new List<IntPtr>();
        EnumThreadWindows(id, (window, data) => { handles.Add(window); return true; }, IntPtr.Zero);
        return handles.ToArray();
    }

    public static string Title(IntPtr window) {
        var text = new StringBuilder(512);
        GetWindowText(window, text, text.Capacity);
        return text.ToString();
    }

    public static IntPtr[] Children(IntPtr parent) {
        var handles = new List<IntPtr>();
        EnumChildWindows(parent, (window, data) => { handles.Add(window); return true; }, IntPtr.Zero);
        return handles.ToArray();
    }

    public static string Class(IntPtr window) {
        var text = new StringBuilder(256);
        GetClassName(window, text, text.Capacity);
        return text.ToString();
    }

    public static bool SetAndVerifyEdit(IntPtr window, string destination) {
        if (SetText(window, 0x000C, IntPtr.Zero, destination) == IntPtr.Zero) return false;
        var observed = new StringBuilder(destination.Length + 2);
        ReadText(window, 0x000D, new IntPtr(observed.Capacity), observed);
        return observed.ToString() == destination;
    }
}
'@
$process = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ProcessIdProperty, [int]$env:DV_DIALOG_PID)
$title = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty, $env:DV_DIALOG_TITLE)
$ownerAndTitle = [System.Windows.Automation.AndCondition]::new($process, $title)
$deadline = [DateTime]::UtcNow.AddSeconds(12)
do {
  $window = [System.Windows.Automation.AutomationElement]::RootElement.FindFirst([System.Windows.Automation.TreeScope]::Children, $ownerAndTitle)
  if ($window) { break }
  $ownedTitles = @()
  foreach ($thread in (Get-Process -Id ([int]$env:DV_DIALOG_PID)).Threads) {
    foreach ($handle in [DataViewerOwnedWindows]::ForThread([uint32]$thread.Id)) {
      [uint32]$owner = 0
      [void][DataViewerOwnedWindows]::GetWindowThreadProcessId($handle, [ref]$owner)
      if ($owner -ne [uint32]$env:DV_DIALOG_PID) { continue }
      $actualTitle = [DataViewerOwnedWindows]::Title($handle)
      if ($actualTitle) { $ownedTitles += $actualTitle }
      if ($actualTitle -ceq $env:DV_DIALOG_TITLE) {
        $window = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
        break
      }
    }
    if ($window) { break }
  }
  if ($window) { break }
  Start-Sleep -Milliseconds 200
} while ([DateTime]::UtcNow -lt $deadline)
if (!$window) { throw ('Owned Save dialog not visible. Owned window titles: ' + ($ownedTitles -join ', ')) }
$buttonType = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
$cancelId = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::AutomationIdProperty, '2')
$cancelEn = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty, 'Cancel')
$cancelKo = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty, '취소')
$cancelMatch = [System.Windows.Automation.AndCondition]::new($buttonType, [System.Windows.Automation.OrCondition]::new($cancelId, $cancelEn, $cancelKo))
$handle = [IntPtr]$window.Current.NativeWindowHandle
[uint32]$owner = 0
[void][DataViewerOwnedWindows]::GetWindowThreadProcessId($handle, [ref]$owner)
if ($owner -ne [uint32]$env:DV_DIALOG_PID -or [DataViewerOwnedWindows]::Title($handle) -cne $env:DV_DIALOG_TITLE) { throw 'Owned dialog identity changed.' }
$deadline = [DateTime]::UtcNow.AddSeconds(4)
do {
  $cancelButton = $window.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cancelMatch)
  $cancelHandle = [DataViewerOwnedWindows]::GetDlgItem($handle, 2)
  if ($cancelButton -or $cancelHandle -ne [IntPtr]::Zero) { break }
  Start-Sleep -Milliseconds 150
} while ([DateTime]::UtcNow -lt $deadline)
$cancel = {
  if ($cancelButton) {
    $cancelButton.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
  } elseif ($cancelHandle -ne [IntPtr]::Zero) {
    if (![DataViewerOwnedWindows]::PostMessage($handle, 0x0111, [IntPtr]2, $cancelHandle)) { throw 'Owned dialog rejected cancellation.' }
  } else {
    if (![DataViewerOwnedWindows]::PostMessage($handle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)) { throw 'Owned dialog could not be closed.' }
  }
}
$observed = [pscustomobject]@{title=$window.Current.Name; ownerPid=$window.Current.ProcessId; saved=[bool]$env:DV_DIALOG_DESTINATION}
try {
  if (!$env:DV_DIALOG_DESTINATION) {
    & $cancel
  } else {
    $fileNameId = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::AutomationIdProperty, '1001')
    $editType = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)
    $fileName = $window.FindFirst([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.AndCondition]::new($fileNameId, $editType))
    if (!$fileName) {
      $fileHostId = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::AutomationIdProperty, 'FileNameControlHost')
      $fileHost = $window.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $fileHostId)
      if ($fileHost) { $fileName = $fileHost.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $editType) }
    }
    $saveId = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::AutomationIdProperty, '1')
    $saveButton = $window.FindFirst([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.AndCondition]::new($saveId, $buttonType))
    if ($fileName -and $saveButton) {
      $nameValue = $fileName.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
      $nameValue.SetValue($env:DV_DIALOG_DESTINATION)
      if ($nameValue.Current.Value -cne $env:DV_DIALOG_DESTINATION) { throw 'Owned dialog filename did not match the scratch destination.' }
      $saveButton.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    } else {
      $deadline = [DateTime]::UtcNow.AddSeconds(3)
      do {
        $children = [DataViewerOwnedWindows]::Children($handle)
        $editHandles = @($children | Where-Object { [DataViewerOwnedWindows]::Class($_) -eq 'Edit' })
        $filenameHandles = @($editHandles | Where-Object { [DataViewerOwnedWindows]::GetDlgCtrlID($_) -eq 1001 })
        if ($filenameHandles.Count -eq 0 -and $editHandles.Count -eq 1) { $filenameHandles = $editHandles }
        $saveHandle = [DataViewerOwnedWindows]::GetDlgItem($handle, 1)
        if ($filenameHandles.Count -eq 1 -and $saveHandle -ne [IntPtr]::Zero) { break }
        Start-Sleep -Milliseconds 150
      } while ([DateTime]::UtcNow -lt $deadline)
      if ($filenameHandles.Count -ne 1 -or [DataViewerOwnedWindows]::Class($saveHandle) -ne 'Button') {
        $controls = $children | ForEach-Object { [DataViewerOwnedWindows]::Class($_) + ':' + [DataViewerOwnedWindows]::GetDlgCtrlID($_) }
        throw ('Verified filename and Save controls unavailable. Owned child controls: ' + ($controls -join ', '))
      }
      foreach ($control in @($filenameHandles[0], $saveHandle)) {
        [uint32]$controlOwner = 0
        [void][DataViewerOwnedWindows]::GetWindowThreadProcessId($control, [ref]$controlOwner)
        if ($controlOwner -ne [uint32]$env:DV_DIALOG_PID) { throw 'Dialog control owner changed.' }
      }
      if (![DataViewerOwnedWindows]::SetAndVerifyEdit($filenameHandles[0], $env:DV_DIALOG_DESTINATION)) { throw 'Owned dialog filename did not match the scratch destination.' }
      if (![DataViewerOwnedWindows]::PostMessage($handle, 0x0111, [IntPtr]1, $saveHandle)) { throw 'Owned dialog did not accept Save.' }
    }
    if ($env:DV_DIALOG_OVERWRITE) {
      $deadline = [DateTime]::UtcNow.AddSeconds(5)
      $confirmation = $null
      do {
        $titles = @()
        foreach ($thread in (Get-Process -Id ([int]$env:DV_DIALOG_PID)).Threads) {
          foreach ($candidate in [DataViewerOwnedWindows]::ForThread([uint32]$thread.Id)) {
            [uint32]$confirmationOwner = 0
            [void][DataViewerOwnedWindows]::GetWindowThreadProcessId($candidate, [ref]$confirmationOwner)
            if ($confirmationOwner -ne [uint32]$env:DV_DIALOG_PID -or $candidate -eq $handle) { continue }
            $confirmationTitle = [DataViewerOwnedWindows]::Title($candidate)
            if ($confirmationTitle) { $titles += $confirmationTitle }
            if ($confirmationTitle -in @('Confirm Save As', '다른 이름으로 저장 확인')) {
              $confirmation = [System.Windows.Automation.AutomationElement]::FromHandle($candidate)
              break
            }
          }
          if ($confirmation) { break }
        }
        if (!$confirmation) { Start-Sleep -Milliseconds 100 }
      } while (!$confirmation -and [DateTime]::UtcNow -lt $deadline)
      if (!$confirmation) { throw ('Owned overwrite confirmation not found. Owned titles: ' + ($titles -join ', ')) }
      $accept = $env:DV_DIALOG_OVERWRITE -eq 'accept'
      $id = if ($accept) { 6 } else { 7 }
      $name = if ($accept) { 'Yes' } else { 'No' }
      $localizedName = if ($accept) { '예' } else { '아니요' }
      $buttonMatches = [System.Windows.Automation.Condition[]]@(
        [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::AutomationIdProperty, [string]$id),
        [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::AutomationIdProperty, "CommandButton_$id"),
        [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty, $name),
        [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty, $localizedName)
      )
      $confirmationHandle = [IntPtr]$confirmation.Current.NativeWindowHandle
      $choiceCondition = [System.Windows.Automation.AndCondition]::new($buttonType, [System.Windows.Automation.OrCondition]::new($buttonMatches))
      $deadline = [DateTime]::UtcNow.AddSeconds(3)
      do {
        $choice = $confirmation.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $choiceCondition)
        $choiceHandle = [DataViewerOwnedWindows]::GetDlgItem($confirmationHandle, $id)
        if ($choice -or $choiceHandle -ne [IntPtr]::Zero) { break }
        $buttons = $confirmation.FindAll([System.Windows.Automation.TreeScope]::Descendants, $buttonType)
        foreach ($button in $buttons) {
          $plainName = $button.Current.Name.Split('(')[0].Replace('&', '').Trim()
          if ($plainName -in @($name, $localizedName)) { $choice = $button; break }
        }
        if ($choice) { break }
        $childButtons = @([DataViewerOwnedWindows]::Children($confirmationHandle) | Where-Object {
          $plainName = [DataViewerOwnedWindows]::Title($_).Split('(')[0].Replace('&', '').Trim()
          [DataViewerOwnedWindows]::Class($_) -eq 'Button' -and $plainName -in @($name, $localizedName)
        })
        if ($childButtons.Count -eq 1) { $choiceHandle = $childButtons[0]; break }
        Start-Sleep -Milliseconds 100
      } while ([DateTime]::UtcNow -lt $deadline)
      if ($choice) {
        $choice.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
      } else {
        if ($choiceHandle -eq [IntPtr]::Zero -or ![DataViewerOwnedWindows]::PostMessage($choiceHandle, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero)) {
          $controls = [DataViewerOwnedWindows]::Children($confirmationHandle) | ForEach-Object {
            [DataViewerOwnedWindows]::Class($_) + ':' + [DataViewerOwnedWindows]::GetDlgCtrlID($_) + ':' + [DataViewerOwnedWindows]::Title($_)
          }
          $uia = $buttons | ForEach-Object { $_.Current.AutomationId + ':' + $_.Current.Name }
          throw ('Owned overwrite confirmation choice unavailable. Controls: ' + ($controls -join ', ') + '. UIA: ' + ($uia -join ', '))
        }
      }
      if (!$accept) {
        $deadline = [DateTime]::UtcNow.AddSeconds(3)
        while ([DataViewerOwnedWindows]::Title($confirmationHandle) -and [DateTime]::UtcNow -lt $deadline) {
          Start-Sleep -Milliseconds 100
        }
        if ([DataViewerOwnedWindows]::Title($handle) -ceq $env:DV_DIALOG_TITLE) { & $cancel }
      }
      $observed.saved = $accept
    }
  }
} catch {
  if ($env:DV_DIALOG_DESTINATION) { & $cancel }
  throw
}
$observed | ConvertTo-Json -Compress
`, {DV_DIALOG_PID: String(pid), DV_DIALOG_TITLE: title, DV_DIALOG_DESTINATION: destination, DV_DIALOG_OVERWRITE: overwrite}).catch((cause) => {
    throw new Error(cause.stderr ?? cause.message);
  });
  const observed = JSON.parse(dialog);
  assert.equal(observed.title, title);
  assert.equal(observed.ownerPid, pid);
  return observed;
}
