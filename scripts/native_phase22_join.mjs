// Independent actual-WebView JOIN/quiet-editor acceptance. Root owns processes,
// settings restoration, source hashes and report/check lifecycle.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

export async function runJoinAcceptance(ctx) {
  let page = ctx.page;
  const { invoke, poll, wait, pageOf, release, output } = ctx;
  const golden = JSON.parse(await fs.readFile(path.join(ctx.fixtureDir, "manifest.json"), "utf8"));
  assert.equal(golden.innerJoinRows, 3);
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const region = () => page.getByRole("region", { name: "SQL workspace", exact: true });
  const editor = () => region().getByRole("textbox", { name: "SQL editor", exact: true });
  const popup = () => page.locator(".cm-tooltip-autocomplete");
  const labels = () => popup().locator(".cm-completionLabel");
  const text = () => editor().locator(".cm-line").allTextContents().then((lines) => lines.join("\n"));
  const prefix = "SELECT COUNT(*) AS n FROM orders o JOIN customers c ON ";
  const settingsEvidence = [], keyboardEvidence = [], outcomes = [];
  const imagePrefix = ctx.tableSuggestions ? "native-sql-tables" : ctx.layout ? "native-sql-layout" : ctx.identifiers ? "native-sql-identifiers" : ctx.usability ? "native-sql-usability" : "native-sql-join";
  const usabilityEvidence = [];
  const helpKey = "data-viewer.sql.examples-help-open.v1";
  const originalHelp = ctx.usability ? await page.evaluate(key => localStorage.getItem(key), helpKey) : null;
  let activeRun = null, activeResult = null, observerInstalled = false;
  const document = async (value) => {
    await editor().fill(value);
    await poll(text, (actual) => actual === value);
    await editor().press("End");
  };
  async function noAutomaticPopup() {
    // Observe multiple provider activation windows, not only a pre-delay absence.
    for (let i = 0; i < 5; i++) {
      await pause(70);
      assert.equal(await popup().count(), 0, "Automatic popup opened in a quiet context");
    }
  }
  async function settingsMode(value, cancel = false) {
    const before = await invoke("get_settings");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Application settings", exact: true });
    const control = dialog.getByRole("combobox", { name: "SQL suggestion mode", exact: true });
    assert.equal(await control.inputValue(), before.sqlCompletionMode);
    await control.selectOption(value);
    assert.deepEqual(await invoke("get_settings"), before, "Draft settings applied prematurely");
    await dialog.getByRole("button", { name: cancel ? "Cancel" : "Apply", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    const after = await invoke("get_settings");
    assert.equal(after.schemaVersion, 7);
    if (cancel) assert.deepEqual(after, before, "Cancel changed persisted settings");
    else {
      assert.equal(after.sqlCompletionMode, value);
      assert.deepEqual({ ...after, sqlCompletionMode: before.sqlCompletionMode }, before,
        "Suggestion mode changed unrelated settings");
    }
    settingsEvidence.push({ requested: value, cancelled: cancel, savedMode: after.sqlCompletionMode });
  }
  async function openOn() {
    if (await popup().count()) await editor().press("Escape");
    await document(prefix.trimEnd());
    await page.keyboard.type(" ");
    await popup().waitFor({ state: "visible" });
    assert.equal(await text(), prefix, "ON suggestion inserted itself");
  }
  async function probe() {
    return page.evaluate(() => {
      const p = Reflect.get(window, "__p22JoinProbe");
      return { counts: { ...p.counts }, starts: p.starts.map((item) => ({ ...item })), acknowledged: [...p.acknowledged] };
    });
  }
  async function restoreObserver() {
    if (!observerInstalled || page.isClosed()) return;
    await page.evaluate(() => {
      const p = Reflect.get(window, "__p22JoinProbe");
      if (p) window.fetch = p.original;
    });
    observerInstalled = false;
  }

  await page.getByRole("button", { name: "SQL workspace", exact: true }).click();
  for (const alias of ["orders", "customers"]) await region().getByRole("button", { name: alias, exact: true }).waitFor({ state: "visible" });
  await settingsMode("contextual");
  await page.evaluate(() => {
    const original = window.fetch, state = { original, counts: {}, starts: [], acknowledged: [] };
    Reflect.set(window, "__p22JoinProbe", state);
    const forwarded = function (input, options, ...rest) {
      const url = new URL(typeof input === "string" ? input : input.url, location.href);
      let runId;
      if (url.hostname === "ipc.localhost") {
        const command = decodeURIComponent(url.pathname.slice(1));
        if (/^(describe_sql_tables|start_sql_query|get_sql_query_status|read_sql_query_page|read_sql_query_cell)$/.test(command)) {
          state.counts[command] = (state.counts[command] ?? 0) + 1;
          if (command === "start_sql_query") {
            const request = JSON.parse(options.body).request;
            runId = request.runId;
            state.starts.push({ runId, sql: request.sql });
          }
        }
      }
      const response = Reflect.apply(original, this, [input, options, ...rest]);
      return runId ? Promise.resolve(response).then((value) => {
        state.acknowledged.push(runId);
        return value;
      }) : response;
    };
    if (!Reflect.set(window, "fetch", forwarded) || window.fetch !== forwarded)
      throw new Error("Native JOIN observer installation failed");
  });
  observerInstalled = true;
  try {
    await invoke("describe_sql_tables", { sources: [ctx.primaryIdentity] });
    assert.equal((await probe()).counts.describe_sql_tables, 1, "Observer missed real describe control call");
    await page.evaluate(() => {
      const p = Reflect.get(window, "__p22JoinProbe");
      p.counts = {}; p.starts = []; p.acknowledged = [];
    });
    const layoutEvidence = ctx.layout ? await (await import('./native_phase22_layout.mjs')).runLayoutChecks({page,region,editor,text,document,poll,output}) : null;
    if(ctx.layout)assert.deepEqual((await probe()).counts,{},'Layout/typing initiated SQL calls');
    const localBefore = await probe();
    if (ctx.tableSuggestions) {
      await document("SELECT * FROM");
      await page.keyboard.type(" ");
      await poll(() => labels().allTextContents(), (items) => items.includes("orders"));
      await page.screenshot({ path: path.join(output, "native-sql-tables-from.png") });
      await page.keyboard.type("ord");
      await poll(() => labels().allTextContents(), (items) => items.length === 1 && items[0] === "orders");
      await editor().press("Tab");
      assert.equal(await text(), "SELECT * FROM orders");
      await page.keyboard.type(" LEFT JOIN ");
      await poll(() => labels().allTextContents(), (items) => items.includes("customers"));
      assert.deepEqual(await probe(), localBefore, "Table suggestions issued SQL calls");
      await editor().press("Escape");
    }
    await document("SELECT "); await page.keyboard.type("co"); await noAutomaticPopup();
    await openOn();
    assert.deepEqual(await labels().allTextContents(), ["o.고객 번호 = c.고객 번호"], "Generic id appeared automatically");
    assert.match(await page.locator(".cm-completionInfo").textContent(), /not a verified foreign key/);
    if (ctx.usability) {
      const details = page.locator(".sql-completion-info details");
      assert.equal(await details.getAttribute("open"), null);
      await details.locator("summary").click();
      assert.notEqual(await details.getAttribute("open"), null);
      assert.match(await details.textContent(), /uniqueness and matching data were not checked/);
      assert.equal(await text(), prefix, "JOIN explanation changed SQL");
      await details.locator("summary").click();
      assert.equal(await details.getAttribute("open"), null);
      await editor().focus();
      usabilityEvidence.push({ detailInitiallyClosed: true, explicitDetail: true, noInsertion: true });
      // Returning focus dismisses the info popup; reopen before its visual capture.
      await openOn();
    }
    await fs.mkdir(output, { recursive: true });
    const completionImage = path.join(output, `${imagePrefix}-completion.png`);
    await page.screenshot({ path: completionImage });
    await editor().press("Shift+Enter");
    const newline = await text();
    assert.ok(newline.includes("\n"));
    // CodeMirror may trim trailing whitespace when inserting an indented line.
    assert.equal(newline.replace(/\n[ \t]*$/, "").trimEnd(), prefix.trimEnd(), "Shift+Enter changed SQL tokens");
    assert.ok(!newline.includes("="), "Shift+Enter accepted a JOIN predicate");
    keyboardEvidence.push({ action: "Shift+Enter", newline: true });
    await openOn(); await editor().press("Enter");
    assert.equal(await text(), prefix + 'o."고객 번호" = c."고객 번호"');
    keyboardEvidence.push({ action: "automatic Enter", accepted: true });
    await openOn(); await editor().press("ArrowDown"); await editor().press("Enter");
    assert.equal(await text(), prefix + 'o."고객 번호" = c."고객 번호"');
    keyboardEvidence.push({ action: "ArrowDown then Enter", accepted: true });
    await openOn(); await editor().press("Control+Space");
    await poll(() => labels().allTextContents(), (items) => items.includes("o.id = c.id"));
    const manualJoinLabels = await labels().allTextContents();
    assert.ok(manualJoinLabels.includes("o.id = c.id"), "Explicit request omitted ambiguous id candidate");
    assert.equal(manualJoinLabels[0], "o.고객 번호 = c.고객 번호", "Ambiguous id outranked meaningful key");
    await editor().press("Escape");
    await settingsMode("automatic", true);
    assert.equal((await invoke("get_settings")).sqlCompletionMode, "contextual");
    await settingsMode("automatic");
    await document("SELECT "); await page.keyboard.type("c"); await noAutomaticPopup();
    await page.keyboard.type("o"); await popup().waitFor({ state: "visible" });
    await editor().press("Escape"); await page.keyboard.type("u"); await noAutomaticPopup();
    assert.equal(await text(), "SELECT cou", "Escape suppression changed authored SQL");
    await editor().press("Control+Space"); await popup().waitFor({ state: "visible" });
    await editor().press("Escape");
    await settingsMode("manual");
    await document("SELECT "); await page.keyboard.type("co"); await noAutomaticPopup();
    await document("SELECT orders"); await page.keyboard.type("."); await noAutomaticPopup();
    await document(prefix); await noAutomaticPopup();
    await editor().press("Control+Space"); await popup().waitFor({ state: "visible" });
    await editor().press("Enter");
    assert.equal(await text(), prefix + 'o."고객 번호" = c."고객 번호"');
    keyboardEvidence.push({ action: "explicit Ctrl+Space then Enter", accepted: true });
    assert.deepEqual((await probe()).counts, localBefore.counts, "Typing/completion/settings initiated SQL queries");
    const localAfter = await probe();
    await settingsMode("contextual");

    for (const [left, right] of [["name", "name"], ["ordinal", "name"], ["name", "ordinal"], ["ordinal", "ordinal"]]) {
      await region().getByRole("button", { name: "orders", exact: true }).click();
      await region().getByRole("radio", { name: left === "name" ? /^Original names only/ : /^c-numbers only/ }).check();
      await region().getByRole("button", { name: "customers", exact: true }).click();
      await region().getByRole("radio", { name: right === "name" ? /^Original names only/ : /^c-numbers only/ }).check();
      await openOn();
      const label = `o.${left === "name" ? "고객 번호" : "c2"} = c.${right === "name" ? "고객 번호" : "c1"}`;
      assert.deepEqual(await labels().allTextContents(), [label]);
      await editor().press("Tab");
      const expected = prefix + `o.${left === "name" ? '"고객 번호"' : "c2"} = c.${right === "name" ? '"고객 번호"' : "c1"}`;
      assert.equal(await text(), expected, "JOIN completion used wrong original/physical column");
      await editor().press("Control+z"); assert.equal(await text(), prefix);
      await editor().press("Control+Space"); await popup().waitFor({ state: "visible" });
      await editor().press("Tab"); assert.equal(await text(), expected);
      await editor().press("Control+Space"); await popup().waitFor({ state: "visible" });
      const startsBefore = (await probe()).starts.length;
      await editor().press("Control+Enter");
      await poll(probe, (p) => p.starts.length === startsBefore + 1 && p.acknowledged.includes(p.starts.at(-1).runId));
      activeRun = (await probe()).starts.at(-1).runId;
      const status = await wait(activeRun); activeResult = status;
      const data = await pageOf(status);
      assert.equal(status.rowCount, 1); assert.equal(data.rows[0][0].display, String(golden.innerJoinRows));
      await region().getByRole("gridcell", { name: String(golden.innerJoinRows), exact: true }).waitFor({ state: "visible" });
      assert.equal((await probe()).starts.length, startsBefore + 1, "Ctrl+Enter started multiple queries");
      if (ctx.usability) {
        const context = region().getByRole("status", { name: "Result context", exact: true });
        assert.equal(await context.getAttribute("data-current"), "true");
        await editor().focus(); await editor().press("Control+End");
        await page.keyboard.type(" ");
        await poll(() => context.getAttribute("data-current"), value => value === "false");
        assert.match(await context.textContent(), /SQL changed.*previous result/);
        if (left === "ordinal" && right === "ordinal") await page.screenshot({ path: path.join(output, `${imagePrefix}-previous-result.png`) });
        await editor().press("Backspace");
        await poll(() => context.getAttribute("data-current"), value => value === "true");
        usabilityEvidence.push({ left, right, changedResultLabel: true, exactRestore: true });
      }
      const resultImage = path.join(output, `${imagePrefix}-result.png`);
      if (left === "ordinal" && right === "ordinal") await page.screenshot({ path: resultImage });
      outcomes.push({ left, right, sql: expected, status, value: data.rows[0][0].display });
      const clear = region().getByRole("button", { name: "Clear result", exact: true });
      await clear.click(); await clear.waitFor({ state: "hidden" });
      activeRun = null; activeResult = null;
    }
    const executed = await probe();
    assert.equal(executed.starts.length, 4);
    await settingsMode("manual");
    const saved = await invoke("get_settings");
    if (ctx.usability) {
      const help = region().getByRole("button", { name: "Examples & help", exact: true });
      if (await help.getAttribute("aria-expanded") === "true") await help.click();
      assert.equal(await help.getAttribute("aria-expanded"), "false");
      assert.equal(await page.evaluate(key => localStorage.getItem(key), helpKey), "false");
    }
    await restoreObserver();
    page = await ctx.restart();
    assert.equal((await invoke("get_settings")).sqlCompletionMode, "manual", "Suggestion mode did not persist across real restart");
    await page.getByRole("button", { name: "SQL workspace", exact: true }).click();
    await region().getByRole("button", { name: "orders", exact: true }).waitFor({ state: "visible" });
    if (ctx.usability) {
      assert.equal(await region().getByRole("button", { name: "Examples & help", exact: true }).getAttribute("aria-expanded"), "false");
      usabilityEvidence.push({ collapsedHelpRetainedAfterRealRestart: true });
    }
    await document("SELECT orders"); await page.keyboard.type("."); await noAutomaticPopup();
    await editor().press("Control+Space"); await popup().waitFor({ state: "visible" });
    await editor().press("Escape");
    return { observer: { controlDescribeCalls: 1, transport: "forwarded fetch", headersOrKeysRecorded: false },
      localBefore, localAfter, settingsEvidence, keyboardEvidence, manualJoinLabels, outcomes,
      queryCalls: executed, golden: { innerJoinRows: golden.innerJoinRows, matches: golden.matches },
      restart: { savedMode: saved.sqlCompletionMode, restoredMode: "manual", dotQuiet: true, explicitPopup: true, queryExecutedAfterRestart: false },
      layoutEvidence, usabilityEvidence, completionImage, resultImage: path.join(output, `${imagePrefix}-result.png`) };
  } finally {
    if (activeRun) await invoke("cancel_sql_query", { runId: activeRun }).catch(() => {});
    if (activeResult) await release(activeResult).catch(() => {});
    await restoreObserver().catch(() => {});
    if (ctx.usability && !page.isClosed()) await page.evaluate(({ key, value }) => {
      if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value);
    }, { key: helpKey, value: originalHelp }).catch(() => {});
  }
}
