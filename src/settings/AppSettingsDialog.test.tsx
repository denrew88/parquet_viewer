// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { defaultAppSettings } from "./model";
import { AppSettingsDialog } from "./AppSettingsDialog";
import type { StorageLocations } from "./storageFolders";

function selectCategory(name: "CSV" | "SQL" | "Copy" | "Display" | "Storage") {
  fireEvent.click(screen.getByRole("tab", { name }));
}

function renderDialog(overrides: Partial<React.ComponentProps<typeof AppSettingsDialog>> = {}) {
  const onApply = vi.fn();
  const onCancel = vi.fn();
  const onOpenCopySettings = vi.fn();
  const view = render(
    <AppSettingsDialog
      initialSettings={defaultAppSettings()}
      onApply={onApply}
      onCancel={onCancel}
      onOpenCopySettings={onOpenCopySettings}
      {...overrides}
    />,
  );
  return { onApply, onCancel, onOpenCopySettings, view };
}

describe("AppSettingsDialog", () => {
  it("keeps all category drafts mounted and applies them together", () => {
    const { onApply } = renderDialog();
    expect(screen.getByRole("tabpanel", { name: "CSV" })).toBeVisible();
    expect(screen.getAllByRole("tabpanel", { hidden: true })).toHaveLength(5);
    expect(screen.getAllByRole("tabpanel")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "All Text" }));
    const csv = screen.getByRole("tab", { name: "CSV" });
    fireEvent.keyDown(csv, { key: "ArrowDown" });
    expect(screen.getByRole("tab", { name: "SQL" })).toHaveFocus();
    fireEvent.change(screen.getByRole("combobox", { name: "SQL suggestion mode" }), {
      target: { value: "manual" },
    });
    selectCategory("Copy");
    fireEvent.change(screen.getByRole("spinbutton", { name: "Maximum cells" }), {
      target: { value: "2000" },
    });
    selectCategory("Display");
    fireEvent.change(screen.getByRole("combobox", { name: "Integer grouping" }), {
      target: { value: "comma" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Show Timestamp details" }));
    selectCategory("Storage");
    fireEvent.change(screen.getByRole("spinbutton", { name: "CSV cache maximum size" }), {
      target: { value: "1" },
    });
    selectCategory("Display");
    expect(screen.getByRole("button", { name: "Hide Timestamp details" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    selectCategory("CSV");
    expect(screen.getByRole("button", { name: "All Text" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(onApply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onApply).toHaveBeenCalledOnce();
    expect(onApply).toHaveBeenCalledWith(
      expect.objectContaining({
        csvDefaultParsingMode: "allText",
        sqlCompletionMode: "manual",
        csvCacheLimitBytes: 1024 ** 3,
        copyLimits: expect.objectContaining({ maxCells: 2000 }),
        displayFormats: expect.objectContaining({ integer: { grouping: "comma" } }),
      }),
    );
  });

  it("keeps hidden invalid drafts discoverable and excludes inactive tabs from focus", async () => {
    const user = userEvent.setup();
    renderDialog();
    selectCategory("Copy");
    fireEvent.change(screen.getByRole("spinbutton", { name: "Maximum cells" }), {
      target: { value: "999" },
    });
    selectCategory("CSV");
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
    expect(screen.queryByRole("spinbutton", { name: "Maximum cells" })).not.toBeInTheDocument();
    expect(screen.getByText("Fix invalid values in")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(screen.getByRole("spinbutton", { name: "Maximum cells" })).toHaveValue(999);
    selectCategory("CSV");
    const close = screen.getByRole("button", { name: "Close settings" });
    close.focus();
    await user.tab();
    expect(screen.getByRole("tab", { name: "CSV" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Auto" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("tab", { name: "CSV" }), { key: "End" });
    expect(screen.getByRole("tab", { name: "Storage" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("tab", { name: "Storage" }), { key: "Home" });
    expect(screen.getByRole("tab", { name: "CSV" })).toHaveFocus();
  });

  it("resets formats only in Display and preserves drafts from other categories", () => {
    const defaults = defaultAppSettings();
    const initialSettings = {
      ...defaults,
      displayFormats: {
        ...defaults.displayFormats,
        integer: { ...defaults.displayFormats.integer, grouping: "comma" as const },
      },
    };
    const { onApply } = renderDialog({ initialSettings });
    expect(screen.queryByRole("button", { name: "Reset display formats" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "All Text" }));
    selectCategory("Display");
    fireEvent.click(screen.getByRole("button", { name: "Reset display formats" }));
    expect(onApply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onApply).toHaveBeenCalledWith({
      ...initialSettings,
      csvDefaultParsingMode: "allText",
      displayFormats: defaultAppSettings().displayFormats,
    });
  });

  it("does not restore operation focus to controls in a hidden Storage panel", () => {
    const props = {
      initialSettings: defaultAppSettings(),
      onApply: vi.fn(),
      onCancel: vi.fn(),
      onOpenCopySettings: vi.fn(),
    };
    const view = render(<AppSettingsDialog {...props} csvCacheClearing queryTempClearing />);
    selectCategory("CSV");
    const auto = screen.getByRole("button", { name: "Auto" });
    auto.focus();
    view.rerender(
      <AppSettingsDialog {...props} csvCacheClearing={false} queryTempClearing={false} />,
    );
    expect(auto).toHaveFocus();
  });

  it("uses independent authoritative paths, opens kinds only and reports launch failures", async () => {
    let finishOpen: (() => void) | undefined;
    const locations: StorageLocations = {
      csvCache: { path: "D:/한글 cache & logs", available: true },
      queryTemp: { path: "C:/App data/query-temp", available: false },
    };
    const storageFolders = {
      getLocations: vi.fn().mockResolvedValue(locations),
      openFolder: vi
        .fn()
        .mockRejectedValueOnce(new Error("Explorer could not open this folder."))
        .mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              finishOpen = resolve;
            }),
        ),
    };
    renderDialog({ storageFolders, tempUsageError: "Usage could not be read" });
    selectCategory("Storage");
    await screen.findByText(locations.csvCache.path);
    const csvSection = screen.getByRole("region", { name: "Reusable CSV cache" });
    const querySection = screen.getByRole("region", { name: "Query temporary data" });
    expect(within(querySection).getByText(locations.queryTemp.path)).toBeVisible();
    expect(within(querySection).getByRole("button", { name: "Open folder" })).toBeDisabled();
    expect(storageFolders.openFolder).not.toHaveBeenCalled();
    selectCategory("CSV");
    selectCategory("Storage");
    expect(storageFolders.openFolder).not.toHaveBeenCalled();
    fireEvent.click(within(csvSection).getByRole("button", { name: "Open folder" }));
    await screen.findByText("Explorer could not open this folder.");
    expect(storageFolders.openFolder).toHaveBeenCalledWith("csvCache");
    expect(storageFolders.openFolder.mock.calls[0]).toEqual(["csvCache"]);
    fireEvent.click(within(csvSection).getByRole("button", { name: "Open folder" }));
    expect(within(csvSection).getByRole("button", { name: "Opening…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Apply" })).toBeEnabled();
    await act(async () => finishOpen?.());
    expect(within(csvSection).getByRole("button", { name: "Open folder" })).toBeEnabled();
  });

  it("ignores old folder responses after backend replacement", async () => {
    let resolveOld: ((value: StorageLocations) => void) | undefined;
    const oldBackend = {
      getLocations: vi.fn(
        () =>
          new Promise<StorageLocations>((resolve) => {
            resolveOld = resolve;
          }),
      ),
      openFolder: vi.fn(),
    };
    const current = {
      csvCache: { path: "D:/current-cache", available: true },
      queryTemp: { path: "C:/current-query-temp", available: true },
    };
    const newBackend = {
      getLocations: vi.fn().mockResolvedValue(current),
      openFolder: vi.fn().mockResolvedValue(undefined),
    };
    const props = {
      initialSettings: defaultAppSettings(),
      onApply: vi.fn(),
      onCancel: vi.fn(),
      onOpenCopySettings: vi.fn(),
    };
    const view = render(<AppSettingsDialog {...props} storageFolders={oldBackend} />);
    selectCategory("Storage");
    expect(screen.getByText("Reading folder locations…")).toBeVisible();
    view.rerender(<AppSettingsDialog {...props} storageFolders={newBackend} />);
    await screen.findByText(current.csvCache.path);
    await act(async () =>
      resolveOld?.({
        csvCache: { path: "E:/stale-cache", available: true },
        queryTemp: { path: "E:/stale-query", available: true },
      }),
    );
    expect(screen.queryByText("E:/stale-cache")).not.toBeInTheDocument();
    fireEvent.click(
      within(screen.getByRole("region", { name: "Query temporary data" })).getByRole("button", {
        name: "Open folder",
      }),
    );
    await waitFor(() => expect(newBackend.openFolder).toHaveBeenCalledWith("queryTemp"));
    expect(oldBackend.openFolder).not.toHaveBeenCalled();
  });

  it.each(["success", "failure"] as const)(
    "restores the folder trigger after async %s so Escape still closes settings",
    async (outcome) => {
      const user = userEvent.setup();
      let finish: (() => void) | undefined;
      const storageFolders = {
        getLocations: vi.fn().mockResolvedValue({
          csvCache: { path: "C:/cache", available: true },
          queryTemp: { path: "C:/query-temp", available: true },
        }),
        openFolder: vi.fn(
          () =>
            new Promise<void>((resolve, reject) => {
              finish = outcome === "success" ? resolve : () => reject(new Error("Open failed"));
            }),
        ),
      };
      const { onCancel } = renderDialog({ storageFolders });
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Close settings" })).toHaveFocus(),
      );
      selectCategory("Storage");
      const group = screen.getByRole("region", { name: "Reusable CSV cache" });
      const trigger = within(group).getByRole("button", { name: "Open folder" });
      await user.click(trigger);
      expect(screen.getByRole("dialog", { name: "Application settings" })).toHaveFocus();
      expect(within(group).getByRole("button", { name: "Opening…" })).toBeDisabled();
      await act(async () => finish?.());
      expect(trigger).toHaveFocus();
      if (outcome === "failure") expect(screen.getByText("Open failed")).toBeVisible();
      await user.keyboard("{Escape}");
      expect(onCancel).toHaveBeenCalledOnce();
    },
  );

  it.each(["control", "category"] as const)(
    "does not steal focus after folder completion when a different %s is selected",
    async (destination) => {
      const user = userEvent.setup();
      let finish: (() => void) | undefined;
      const storageFolders = {
        getLocations: vi.fn().mockResolvedValue({
          csvCache: { path: "C:/cache", available: true },
          queryTemp: { path: "C:/query-temp", available: true },
        }),
        openFolder: vi.fn(
          () =>
            new Promise<void>((resolve) => {
              finish = resolve;
            }),
        ),
      };
      renderDialog({ storageFolders });
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Close settings" })).toHaveFocus(),
      );
      selectCategory("Storage");
      await user.click(
        within(screen.getByRole("region", { name: "Reusable CSV cache" })).getByRole("button", {
          name: "Open folder",
        }),
      );
      const target =
        destination === "control"
          ? screen.getByRole("spinbutton", { name: "Overall managed storage limit" })
          : screen.getByRole("tab", { name: "CSV" });
      await user.click(target);
      await act(async () => finish?.());
      expect(target).toHaveFocus();
      if (destination === "category")
        expect(screen.getByRole("tabpanel", { name: "CSV" })).toBeVisible();
    },
  );

  it("traps backward Tab on the dialog fallback while a folder is opening", async () => {
    const user = userEvent.setup();
    let finish: (() => void) | undefined;
    const storageFolders = {
      getLocations: vi.fn().mockResolvedValue({
        csvCache: { path: "C:/cache", available: true },
        queryTemp: { path: "C:/query-temp", available: true },
      }),
      openFolder: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      ),
    };
    renderDialog({ storageFolders });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Close settings" })).toHaveFocus(),
    );
    selectCategory("Storage");
    await user.click(
      within(screen.getByRole("region", { name: "Reusable CSV cache" })).getByRole("button", {
        name: "Open folder",
      }),
    );
    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Apply" })).toHaveFocus();
    await act(async () => finish?.());
    expect(screen.getByRole("button", { name: "Apply" })).toHaveFocus();
  });

  it("refreshes folder metadata after a location move even if usage refresh fails", async () => {
    const original = {
      csvCache: { path: "C:/old-cache", available: true },
      queryTemp: { path: "C:/app/query-temp", available: true },
    };
    const moved = { ...original, csvCache: { path: "D:/new-cache", available: true } };
    const storageFolders = {
      getLocations: vi.fn().mockResolvedValueOnce(original).mockResolvedValue(moved),
      openFolder: vi.fn(),
    };
    const preview = {
      sourcePath: original.csvCache.path,
      targetPath: moved.csvCache.path,
      bytes: 0,
      entries: 0,
      activeEntries: 0,
      availableBytes: 10 * 1024 ** 3,
      requiredFreeBytes: 5 * 1024 ** 3,
    };
    const cacheBackend = {
      chooseCsvCacheLocation: vi.fn().mockResolvedValue({ selectionId: "selection-1", preview }),
      startCsvCacheMigration: vi.fn().mockResolvedValue({
        operationId: "move-1",
        state: "complete",
        progress: {
          copiedBytes: 0,
          totalBytes: 0,
          copiedEntries: 0,
          totalEntries: 0,
          phase: "complete",
        },
        sourcePath: preview.sourcePath,
        targetPath: preview.targetPath,
        error: null,
        result: {
          sourcePath: preview.sourcePath,
          targetPath: preview.targetPath,
          movedBytes: 0,
          movedEntries: 0,
          cleanupFailures: [],
        },
      }),
      getCsvCacheMigrationStatus: vi.fn(),
      cancelCsvCacheMigration: vi.fn(),
      getQueryTempUsage: vi.fn(),
    };
    renderDialog({
      storageFolders,
      cacheBackend,
      onCacheLocationChanged: vi.fn().mockRejectedValue(new Error("Usage refresh failed")),
    });
    selectCategory("Storage");
    await screen.findByText(original.csvCache.path);
    fireEvent.click(screen.getByRole("button", { name: "Choose cache location…" }));
    await screen.findByRole("button", { name: "Move cache here" });
    selectCategory("CSV");
    selectCategory("Storage");
    fireEvent.click(screen.getByRole("button", { name: "Move cache here" }));
    await waitFor(() => expect(storageFolders.getLocations).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(moved.csvCache.path, { selector: "code" })).toBeVisible();
    expect(screen.getByText("Usage refresh failed")).toBeVisible();
  });

  it("retries metadata errors without creating or opening folders", async () => {
    const locations = {
      csvCache: { path: "X:/offline-cache", available: false },
      queryTemp: { path: "C:/app/query-temp", available: true },
    };
    const storageFolders = {
      getLocations: vi
        .fn()
        .mockRejectedValueOnce(new Error("Could not resolve saved locations"))
        .mockResolvedValue(locations),
      openFolder: vi.fn(),
    };
    renderDialog({ storageFolders });
    selectCategory("Storage");
    await screen.findByText("Could not resolve saved locations");
    expect(
      screen
        .getAllByRole("button", { name: "Open folder" })
        .every((button) => (button as HTMLButtonElement).disabled),
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Retry folder locations" }));
    await screen.findByText(locations.csvCache.path);
    expect(screen.queryByText("Could not resolve saved locations")).not.toBeInTheDocument();
    expect(
      within(screen.getByRole("region", { name: "Query temporary data" })).getByRole("button", {
        name: "Open folder",
      }),
    ).toBeEnabled();
    expect(storageFolders.openFolder).not.toHaveBeenCalled();
  });

  it("applies SQL suggestion modes only when saved and preserves other settings", async () => {
    const original = { ...defaultAppSettings(), sqlTempLimitBytes: 322122547 };
    const { onApply, onCancel, view } = renderDialog({ initialSettings: original });
    selectCategory("SQL");
    const field = screen.getByRole("combobox", { name: "SQL suggestion mode" });
    expect(field).toHaveValue("contextual");
    fireEvent.change(field, { target: { value: "manual" } });
    expect(onApply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(original.sqlCompletionMode).toBe("contextual");
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onApply).toHaveBeenCalledWith({ ...original, sqlCompletionMode: "manual" });
    view.unmount();
    renderDialog({ initialSettings: { ...original, sqlCompletionMode: "automatic" } });
    selectCategory("SQL");
    expect(screen.getByRole("combobox", { name: "SQL suggestion mode" })).toHaveValue("automatic");
  });
  it("applies and reopens the SQL per-query cap independently of the overall cap", async () => {
    const { onApply, view } = renderDialog({
      initialSettings: {
        ...defaultAppSettings(),
        queryTempLimitBytes: Math.round(0.3 * 1024 ** 3),
      },
    });
    selectCategory("Storage");
    const input = screen.getByRole("spinbutton", { name: "SQL temporary storage per query (GiB)" });
    expect(input).toHaveValue(0.5);
    fireEvent.change(input, { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    const saved = onApply.mock.calls[0][0];
    expect(saved).toEqual({
      ...defaultAppSettings(),
      queryTempLimitBytes: 322122547,
      sqlTempLimitBytes: 1024 ** 3,
    });
    view.unmount();
    const reopened = renderDialog({ initialSettings: saved });
    selectCategory("Storage");
    expect(
      screen.getByRole("spinbutton", { name: "SQL temporary storage per query (GiB)" }),
    ).toHaveValue(1);
    fireEvent.click(screen.getByRole("button", { name: "Reset SQL temporary storage" }));
    expect(reopened.onApply).not.toHaveBeenCalled();
    expect(
      screen.getByRole("spinbutton", { name: "SQL temporary storage per query (GiB)" }),
    ).toHaveValue(0.5);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(reopened.onCancel).toHaveBeenCalledOnce();
    expect(reopened.onApply).not.toHaveBeenCalled();
  });
  it.each(["", "0.0624999999", "10.0000000001", "-1"])(
    "rejects SQL cap %s before applying",
    (value) => {
      const { onApply } = renderDialog();
      selectCategory("Storage");
      fireEvent.change(
        screen.getByRole("spinbutton", { name: "SQL temporary storage per query (GiB)" }),
        { target: { value } },
      );
      expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
      expect(onApply).not.toHaveBeenCalled();
    },
  );
  it("keeps location recovery and settings usable when storage usage cannot be read", () => {
    const cacheBackend = {
      chooseCsvCacheLocation: vi.fn(),
      startCsvCacheMigration: vi.fn(),
      getCsvCacheMigrationStatus: vi.fn(),
      cancelCsvCacheMigration: vi.fn(),
      getQueryTempUsage: vi.fn(),
    };
    renderDialog({
      tempUsage: null,
      tempUsageError: "Previous cache drive is unavailable",
      cacheBackend,
      onCacheLocationChanged: vi.fn(),
      openDocumentCount: 0,
    });
    selectCategory("Storage");
    expect(screen.getByText("Previous cache drive is unavailable")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Choose cache location…" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Apply" })).toBeEnabled();
    expect(screen.getByRole("spinbutton", { name: "CSV cache maximum size" })).toBeEnabled();
  });
  it.each(["0.1", "0.3", "1.1", "0.0625", "10"])(
    "P21 applies CSV cache cap %s GiB as integer bytes without changing the location",
    async (value) => {
      const user = userEvent.setup();
      const { onApply } = renderDialog({
        initialSettings: { ...defaultAppSettings(), csvCacheDirectory: "D:/existing-cache" },
      });
      selectCategory("Storage");
      const input = screen.getByRole("spinbutton", { name: "CSV cache maximum size" });
      fireEvent.change(input, { target: { value } });
      await user.click(screen.getByRole("button", { name: "Apply" }));
      expect(onApply).toHaveBeenCalledWith(
        expect.objectContaining({
          csvCacheLimitBytes: Math.round(Number(value) * 1024 ** 3),
          csvCacheDirectory: "D:/existing-cache",
        }),
      );
    },
  );
  it.each(["0.0624999999", "10.0000000001", ""])(
    "P21 rejects cache input %s before rounding",
    (value) => {
      renderDialog();
      selectCategory("Storage");
      fireEvent.change(screen.getByRole("spinbutton", { name: "CSV cache maximum size" }), {
        target: { value },
      });
      expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
    },
  );
  it("CSV-001 defaults to Auto and applies a new-file parsing mode", async () => {
    const user = userEvent.setup();
    const { onApply } = renderDialog();

    expect(screen.getByRole("button", { name: "Auto" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "All Text" }));
    expect(screen.getByText(/Keep every column as text/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Apply" }));

    expect(onApply).toHaveBeenCalledWith(
      expect.objectContaining({ csvDefaultParsingMode: "allText" }),
    );
  });

  it("accepts the 64 MiB to 10 GiB query temporary-storage range", async () => {
    const user = userEvent.setup();
    const { onApply } = renderDialog();
    selectCategory("Storage");
    const input = screen.getByRole("spinbutton", { name: "Overall managed storage limit" });

    await user.clear(input);
    await user.type(input, "0.0625");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(onApply).toHaveBeenLastCalledWith(
      expect.objectContaining({ queryTempLimitBytes: 64 * 1024 * 1024 }),
    );
  });

  it.each(["0.3", "0.1", "1.1", "0.0625", "10"])(
    "accepts %s GiB, saves integer bytes, and reopens without changing the limit",
    async (value) => {
      const user = userEvent.setup();
      const { onApply, view } = renderDialog();
      selectCategory("Storage");
      const input = screen.getByRole("spinbutton", { name: "Overall managed storage limit" });
      await user.clear(input);
      await user.type(input, value);
      expect(input).toBeValid();
      await user.click(screen.getByRole("button", { name: "Apply" }));
      const saved = onApply.mock.calls[0][0];
      expect(saved.queryTempLimitBytes).toBe(Math.round(Number(value) * 1024 ** 3));
      view.unmount();
      const reopened = renderDialog({ initialSettings: saved });
      selectCategory("Storage");
      expect(screen.getByRole("spinbutton", { name: "Overall managed storage limit" })).toHaveValue(
        Number(value),
      );
      await user.click(screen.getByRole("button", { name: "Apply" }));
      expect(reopened.onApply).toHaveBeenCalledWith(saved);
    },
  );

  it.each(["0.0624999999", "10.0000000001", "0", ""])(
    "rejects out-of-range %s GiB before rounding",
    (value) => {
      renderDialog();
      selectCategory("Storage");
      fireEvent.change(screen.getByRole("spinbutton", { name: "Overall managed storage limit" }), {
        target: { value },
      });
      expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
    },
  );

  it("blocks invalid storage limits and exposes the copy settings entry", async () => {
    const user = userEvent.setup();
    const { onApply, onOpenCopySettings } = renderDialog();
    selectCategory("Storage");
    const input = screen.getByRole("spinbutton", { name: "Overall managed storage limit" });

    await user.clear(input);
    await user.type(input, "2048");
    expect(screen.getByRole("alert")).toHaveTextContent("64 MiB");
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
    expect(onApply).not.toHaveBeenCalled();

    selectCategory("Copy");
    await user.click(screen.getByRole("button", { name: "Copy settings" }));
    expect(onOpenCopySettings).toHaveBeenCalledTimes(1);
  });

  it("applies type-wide display formats while keeping the two-line string contract", async () => {
    const user = userEvent.setup();
    const { onApply } = renderDialog();
    selectCategory("Display");
    await user.selectOptions(screen.getByRole("combobox", { name: "Integer grouping" }), "comma");
    await user.click(screen.getByRole("button", { name: "Show Timestamp details" }));
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Timestamp fractional digits mode" }),
      "fixed",
    );
    const digits = screen.getByRole("spinbutton", { name: "Timestamp fractional digits" });
    await user.clear(digits);
    await user.type(digits, "6");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(onApply).toHaveBeenCalledWith(
      expect.objectContaining({
        displayFormats: expect.objectContaining({
          integer: { grouping: "comma" },
          timestamp: expect.objectContaining({
            fractionalDigits: { mode: "fixed", digits: 6 },
          }),
          string: expect.objectContaining({ maximumVisibleLines: 2 }),
        }),
      }),
    );
  });

  it("resets every display type to the global defaults before apply", async () => {
    const user = userEvent.setup();
    const defaults = defaultAppSettings();
    const initialSettings = {
      ...defaults,
      displayFormats: {
        ...defaults.displayFormats,
        integer: { grouping: "comma" as const },
        boolean: { representation: "numeric" as const },
      },
    };
    const { onApply } = renderDialog({ initialSettings });
    selectCategory("Display");
    await user.click(screen.getByRole("button", { name: "Reset display formats" }));
    expect(screen.getByRole("combobox", { name: "Integer grouping" })).toHaveValue("none");
    expect(screen.getByRole("combobox", { name: "Boolean display format" })).toHaveValue(
      "lowercase",
    );
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(onApply).toHaveBeenCalledWith(
      expect.objectContaining({ displayFormats: defaultAppSettings().displayFormats }),
    );
  });

  it("uses production previews and hides timestamp time controls for Date only", async () => {
    const user = userEvent.setup();
    renderDialog();
    selectCategory("Display");
    expect(screen.getByText("2d 03:04:05.123456789", { selector: "output" })).toBeVisible();
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Timestamp preset" }),
      "dateOnly",
    );
    expect(screen.getAllByText("2025-12-18", { selector: "output" })).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "Show Timestamp details" }));
    expect(screen.queryByRole("combobox", { name: "Timestamp separator" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("combobox", { name: "Timestamp timezone suffix" }),
    ).not.toBeInTheDocument();
  });

  it("keeps all format rows visible and allows only one inline detail panel", async () => {
    const user = userEvent.setup();
    renderDialog();
    selectCategory("Display");
    const timestamp = screen.getByRole("button", { name: "Show Timestamp details" });
    await user.click(timestamp);
    expect(screen.getByLabelText("Timestamp details")).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Integer grouping" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Show Duration details" }));
    expect(screen.queryByLabelText("Timestamp details")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Duration details")).toBeVisible();
    expect(screen.queryByRole("button", { name: "All formats" })).not.toBeInTheDocument();
  });

  it("applies inclusive copy limits in cells and MiB", async () => {
    const user = userEvent.setup();
    const { onApply } = renderDialog();
    selectCategory("Copy");
    const cells = screen.getByRole("spinbutton", { name: "Maximum cells" });
    const bytes = screen.getByRole("spinbutton", { name: "Maximum clipboard size" });

    await user.clear(cells);
    await user.type(cells, "1000");
    await user.clear(bytes);
    await user.type(bytes, "256");
    await user.click(screen.getByRole("button", { name: "Apply" }));

    expect(onApply).toHaveBeenCalledWith(
      expect.objectContaining({
        copyLimits: { maxCells: 1_000, maxBytes: 256 * 1024 * 1024 },
      }),
    );
  });

  it("exposes copy-limit validation and blocks invalid values", async () => {
    const user = userEvent.setup();
    const { onApply } = renderDialog();
    selectCategory("Copy");
    const cells = screen.getByRole("spinbutton", { name: "Maximum cells" });
    const bytes = screen.getByRole("spinbutton", { name: "Maximum clipboard size" });

    await user.clear(cells);
    await user.type(cells, "999");
    await user.clear(bytes);
    await user.type(bytes, "257");

    expect(cells).toHaveAttribute("aria-invalid", "true");
    expect(bytes).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("Enter an integer from 1,000 to 10,000,000 cells.")).toHaveAttribute(
      "role",
      "alert",
    );
    expect(screen.getByText("Enter an integer from 1 to 256 MiB.")).toHaveAttribute(
      "role",
      "alert",
    );
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
    expect(onApply).not.toHaveBeenCalled();
  });

  it("closes on Escape, traps Tab, and restores focus", async () => {
    const trigger = document.createElement("button");
    trigger.textContent = "Trigger";
    document.body.append(trigger);
    trigger.focus();
    const { onCancel, view } = renderDialog();

    const close = await screen.findByRole("button", { name: "Close settings" });
    await waitFor(() => expect(close).toHaveFocus());
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(screen.getByRole("button", { name: "Apply" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(trigger).toHaveFocus();
    trigger.remove();
  });

  it("shows a non-destructive save error and disables actions while saving", () => {
    renderDialog({ isSaving: true, saveError: "Atomic write failed." });

    expect(screen.getByRole("alert")).toHaveTextContent("Atomic write failed.");
    expect(screen.getByRole("button", { name: "Saving..." })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  });

  it("P15-STORAGE-002/010 explains CSV cache storage and confirms clear with focus", async () => {
    const user = userEvent.setup();
    const onClearCsvCache = vi.fn();
    renderDialog({
      tempUsage: {
        processBytes: 640 * 1024 * 1024,
        queryTempBytes: 128 * 1024 * 1024,
        csvCacheBytes: 512 * 1024 * 1024,
        csvCacheEntries: 3,
        csvCacheLimitBytes: 10 * 1024 ** 3,
        csvCacheEffectiveLimitBytes: 10 * 1024 ** 3,
        csvCacheActiveBytes: 0,
        csvCacheActiveEntries: 0,
        csvCacheAvailableBytes: 10 * 1024 ** 3,
        csvCachePath:
          "C:\\Users\\viewer\\AppData\\Local\\Data Viewer\\csv-cache-v1\\a-very-long-cache-segment",
        limitBytes: 10 * 1024 ** 3,
        availableBytes: 20 * 1024 ** 3,
        activeQueries: 1,
        estimatedTempBytes: null,
        safetyReserveBytes: 5 * 1024 ** 3,
        hardCapBytes: 10 * 1024 ** 3,
        freeBytes: 20 * 1024 ** 3,
      },
      onClearCsvCache,
    });

    selectCategory("Storage");
    expect(screen.getByRole("heading", { name: "Query temporary data" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Reusable CSV cache" })).toBeInTheDocument();
    expect(screen.getByText("512.0 MiB · 3 items")).toBeInTheDocument();
    expect(screen.getByText(/a-very-long-cache-segment/)).toHaveAttribute(
      "title",
      expect.stringContaining("csv-cache-v1"),
    );
    expect(screen.getByText(/Source CSV files are never changed/)).toBeInTheDocument();

    const clear = screen.getByRole("button", { name: "Clear inactive CSV cache" });
    await user.click(clear);
    const confirm = screen.getByRole("button", {
      name: "Confirm clear inactive CSV cache",
    });
    expect(confirm).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Cancel cache clear" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Clear inactive CSV cache" })).toHaveFocus(),
    );
    expect(onClearCsvCache).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Clear inactive CSV cache" }));
    await user.click(screen.getByRole("button", { name: "Confirm clear inactive CSV cache" }));
    expect(onClearCsvCache).toHaveBeenCalledTimes(1);
  });

  it("disables storage actions and announces the current CSV cache operation", () => {
    renderDialog({
      csvCacheClearing: true,
      csvCacheClearMessage: "One inactive cache item was removed.",
      onClearCsvCache: vi.fn(),
      onClearTemp: vi.fn(),
    });

    selectCategory("Storage");
    expect(screen.getByRole("button", { name: "Clearing CSV cache..." })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Clear inactive query data" })).toBeDisabled();
    expect(screen.getByText("One inactive cache item was removed.")).toHaveAttribute(
      "role",
      "status",
    );
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  });
});
