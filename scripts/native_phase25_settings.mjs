import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

const normalized = (value) =>
  path.win32
    .normalize(value.replace(/^\\\\\?\\/, ""))
    .replace(/[\\/]+$/, "")
    .toLowerCase();
const directory = async (value) =>
  fs
    .stat(value)
    .then((item) => item.isDirectory())
    .catch(() => false);

async function poll(read, done, timeout = 30_000) {
  const end = performance.now() + timeout;
  while (performance.now() < end) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("Explorer did not expose the expected managed-folder destination.");
}

// Do not emit, navigate, or close personal Explorer locations. Only paths equal
// to the two backend-provided roots enter the returned evidence.
const pathNormalization = String.raw`
function Normalize-ManagedPath([string]$value) {
  if($value.StartsWith('\\?\')){$value=$value.Substring(4)}
  return [IO.Path]::GetFullPath($value).TrimEnd([char[]]@([char]92)).ToUpperInvariant()
}
`;

export async function verifyStorageFolderNormalization(powershell, roots = []) {
  const cases = [
    {
      input: "C:\\folder with spaces\\한글 & sample\\",
      expected: "C:\\FOLDER WITH SPACES\\한글 & SAMPLE",
    },
    { input: "\\\\?\\D:\\managed cache\\query-temp\\", expected: "D:\\MANAGED CACHE\\QUERY-TEMP" },
    ...roots.map((input) => ({ input, expected: normalized(input).toUpperCase() })),
  ];
  const result = JSON.parse(
    await powershell(
      String.raw`
${pathNormalization}
$cases=ConvertFrom-Json $env:P25_SETTINGS_NORMALIZATION_CASES
$index=0
foreach($case in $cases) {
  if($case.input -isnot [string] -or $case.expected -isnot [string]){throw ('Normalization case is not a scalar string at case '+$index)}
  try {$actual=Normalize-ManagedPath ([string]$case.input)}
  catch {throw ('Normalization failed at case '+$index+' ('+$_.Exception.GetType().Name+', HRESULT '+$_.Exception.HResult+')')}
  if($actual -cne [string]$case.expected){throw ('Normalization mismatch at case '+$index)}
  $index++
}
[pscustomobject]@{passed=$true;cases=$index} | ConvertTo-Json -Compress
`,
      { P25_SETTINGS_NORMALIZATION_CASES: JSON.stringify(cases) },
    ),
  );
  assert.equal(result.passed, true);
  assert.equal(result.cases, cases.length);
  return { passed: true, samples: 2, currentRoots: roots.length };
}

const explorerObservation = String.raw`
$targets=ConvertFrom-Json $env:P25_SETTINGS_FOLDERS
foreach($target in $targets){if($target -isnot [string]){throw 'Managed-folder target must be a scalar string'}}
${pathNormalization}
$shell=New-Object -ComObject Shell.Application
$matchedWindows=@()
$handles=@()
$diagnostics=[ordered]@{shellWindows=0;explorerWindows=0;readableFolders=0;otherFolders=0;errors=@()}
foreach($window in @($shell.Windows())) {
  $diagnostics.shellWindows++
  $stage='process'
  try {
    if([IO.Path]::GetFileName([string]$window.FullName) -ine 'explorer.exe'){continue}
    $diagnostics.explorerWindows++
    $handles+=([string]$window.HWND)
    $stage='folder'
    $current=[string]$window.Document.Folder.Self.Path
    $diagnostics.readableFolders++
    $stage='normalize'
    $matched=$false
    foreach($target in $targets) {
      if((Normalize-ManagedPath $current) -eq (Normalize-ManagedPath $target)) {
        $matchedWindows+=[pscustomobject]@{hwnd=([string]$window.HWND);path=$current}
        $matched=$true
        break
      }
    }
    if(-not $matched){$diagnostics.otherFolders++}
  } catch {
    $diagnostics.errors+=([pscustomobject]@{stage=$stage;type=$_.Exception.GetType().Name;hresult=$_.Exception.HResult})
  }
}
[pscustomobject]@{windows=@($matchedWindows);handles=@($handles);diagnostics=$diagnostics} | ConvertTo-Json -Depth 5 -Compress
`;

const explorerCleanup = String.raw`
$targets=ConvertFrom-Json $env:P25_SETTINGS_FOLDERS
$ownedHandles=ConvertFrom-Json $env:P25_SETTINGS_OWNED_WINDOWS
foreach($target in $targets){if($target -isnot [string]){throw 'Managed-folder target must be a scalar string'}}
${pathNormalization}
$shell=New-Object -ComObject Shell.Application
$closed=0
foreach($window in @($shell.Windows())) {
  try {
    if($ownedHandles -notcontains ([string]$window.HWND)){continue}
    if([IO.Path]::GetFileName([string]$window.FullName) -ine 'explorer.exe'){continue}
    $current=[string]$window.Document.Folder.Self.Path
    foreach($target in $targets) {
      if((Normalize-ManagedPath $current) -eq (Normalize-ManagedPath $target)) {
        $window.Quit()
        $closed++
        break
      }
    }
  } catch {}
}
[pscustomobject]@{closed=$closed} | ConvertTo-Json -Compress
`;

export async function verifyPhase25Settings({ page, check, scratch, invoke, powershell }) {
  const before = await invoke("get_settings");
  const initial = await invoke("get_storage_locations");
  for (const kind of ["csvCache", "queryTemp"]) {
    assert.equal(typeof initial[kind].path, "string");
    assert.ok(initial[kind].path.length > 0);
    assert.equal(typeof initial[kind].available, "boolean");
  }
  assert.notEqual(normalized(initial.csvCache.path), normalized(initial.queryTemp.path));
  assert.equal(path.win32.basename(initial.queryTemp.path), "query-temp");
  if (before.csvCacheDirectory !== null)
    assert.equal(normalized(initial.csvCache.path), normalized(before.csvCacheDirectory));
  else assert.equal(path.win32.basename(initial.csvCache.path), "csv-cache-v1");
  const normalizationSelfCheck = await verifyStorageFolderNormalization(powershell, [
    initial.csvCache.path,
    initial.queryTemp.path,
  ]);
  const unavailable = [];
  for (const kind of ["csvCache", "queryTemp"]) {
    if (initial[kind].available) continue;
    unavailable.push(kind);
    const existed = await directory(initial[kind].path);
    await assert.rejects(invoke("open_storage_folder", { kind }));
    assert.equal(
      await directory(initial[kind].path),
      existed,
      "Open must not create or replace an unavailable root",
    );
  }
  await assert.rejects(invoke("open_storage_folder", { kind: "../query-temp" }));

  // Normal product usage initializes its working store; Get/Open themselves do
  // not manufacture directories merely to make this acceptance scenario pass.
  await invoke("get_query_temp_usage");
  const locations = await invoke("get_storage_locations");
  const targets = [locations.csvCache.path, locations.queryTemp.path];
  assert.notEqual(normalized(targets[0]), normalized(targets[1]));
  for (const kind of ["csvCache", "queryTemp"])
    assert.equal(locations[kind].available, true, `Cannot verify Explorer for unavailable ${kind}`);
  const env = { P25_SETTINGS_FOLDERS: JSON.stringify(targets) };
  let lastExplorer;
  const inspectExplorer = async () => {
    lastExplorer = JSON.parse(await powershell(explorerObservation, env));
    return lastExplorer;
  };
  const baselineExplorer = await inspectExplorer();
  const baselineHandles = new Set(baselineExplorer.handles);
  const ownedHandles = new Set();
  const observations = {
    locations,
    normalizationSelfCheck,
    baselineMatchingWindows: baselineExplorer.windows,
    initiallyUnavailableRejected: unavailable,
    explorerTargets: [],
  };
  const settings = page.getByRole("dialog", { name: "Application settings", exact: true });
  const settingsButton = page.getByRole("button", { name: "Settings", exact: true });
  async function category(name) {
    await settings.getByRole("tab", { name, exact: true }).click();
    await check(settings.getByRole("tabpanel", { name, exact: true })).toBeVisible();
  }
  let committed = false;
  let openingKind = null;
  try {
    await settingsButton.click();
    await check(settings.getByRole("tab", { name: "CSV", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const nextCsv = before.csvDefaultParsingMode === "allText" ? "auto" : "allText";
    const nextSql = before.sqlCompletionMode === "manual" ? "contextual" : "manual";
    await settings
      .getByRole("button", { name: nextCsv === "auto" ? "Auto" : "All Text", exact: true })
      .click();
    await category("SQL");
    await settings
      .getByRole("combobox", { name: "SQL suggestion mode", exact: true })
      .selectOption(nextSql);
    await category("Storage");
    await settings.getByRole("button", { name: "Cancel", exact: true }).click();
    assert.deepEqual(await invoke("get_settings"), before);
    await settingsButton.click();
    await settings
      .getByRole("button", { name: nextCsv === "auto" ? "Auto" : "All Text", exact: true })
      .click();
    await category("SQL");
    await settings
      .getByRole("combobox", { name: "SQL suggestion mode", exact: true })
      .selectOption(nextSql);
    await settings.getByRole("button", { name: "Apply", exact: true }).click();
    await check(settings).toHaveCount(0);
    committed = true;
    assert.deepEqual(await invoke("get_settings"), {
      ...before,
      csvDefaultParsingMode: nextCsv,
      sqlCompletionMode: nextSql,
    });
    await settingsButton.click();
    await category("Display");
    await check(settings.locator("[data-format-type]")).toHaveCount(8);
    await settings.getByRole("button", { name: "Show Timestamp details", exact: true }).click();
    await page.screenshot({ path: path.join(scratch, "native-settings-display.png") });
    await category("Storage");
    await page.screenshot({ path: path.join(scratch, "native-settings-storage.png") });
    for (const [kind, name] of [
      ["csvCache", "Reusable CSV cache"],
      ["queryTemp", "Query temporary data"],
    ]) {
      const section = settings.getByRole("region", { name, exact: true });
      openingKind = kind;
      await check(section).toContainText(locations[kind].path);
      const prior = await inspectExplorer();
      const priorHandles = new Set(prior.handles);
      await section.getByRole("button", { name: "Open folder", exact: true }).click();
      const result = await poll(inspectExplorer, (value) =>
        value.windows.some(
          (window) =>
            normalized(window.path) === normalized(locations[kind].path) &&
            !priorHandles.has(window.hwnd),
        ),
      );
      const actual = result.windows.find(
        (window) =>
          normalized(window.path) === normalized(locations[kind].path) &&
          !priorHandles.has(window.hwnd),
      );
      assert.ok(actual);
      assert.ok(
        !baselineHandles.has(actual.hwnd),
        "The Open action must produce a new matching Explorer window",
      );
      ownedHandles.add(actual.hwnd);
      observations.explorerTargets.push({
        kind,
        path: actual.path,
        hwnd: actual.hwnd,
        reusedExistingWindow: baselineHandles.has(actual.hwnd),
      });
    }
    assert.notEqual(
      normalized(observations.explorerTargets[0].path),
      normalized(observations.explorerTargets[1].path),
    );
    assert.equal(path.win32.basename(observations.explorerTargets[1].path), "query-temp");
    observations.globalCancelPreservedSettings = true;
    observations.globalApplyCommittedBothCategories = true;
    observations.actualExplorerTargetsVerified = true;
    return observations;
  } catch (error) {
    const alerts = await settings
      .getByRole("alert")
      .allTextContents()
      .catch(() => []);
    await fs.writeFile(
      path.join(scratch, "failure-observations.json"),
      JSON.stringify(
        {
          locations,
          openingKind,
          explorerTargets: observations.explorerTargets,
          explorer: lastExplorer
            ? {
                windows: lastExplorer.windows,
                handleCount: lastExplorer.handles.length,
                diagnostics: lastExplorer.diagnostics,
              }
            : null,
          uiErrors: alerts,
          error: error instanceof Error ? error.message : String(error),
        },
        null,
        2,
      ),
    );
    throw error;
  } finally {
    if (await settings.isVisible().catch(() => false))
      await settings
        .getByRole("button", { name: "Cancel", exact: true })
        .click()
        .catch(() => {});
    if (committed || JSON.stringify(await invoke("get_settings")) !== JSON.stringify(before)) {
      await invoke("update_settings", { settings: before });
      assert.deepEqual(await invoke("get_settings"), before);
    }
    observations.explorerCleanup = JSON.parse(
      await powershell(explorerCleanup, {
        ...env,
        P25_SETTINGS_OWNED_WINDOWS: JSON.stringify([...ownedHandles]),
      }),
    );
  }
}
