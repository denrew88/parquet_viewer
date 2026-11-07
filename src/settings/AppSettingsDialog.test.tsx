// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { defaultAppSettings } from "./model";
import { AppSettingsDialog } from "./AppSettingsDialog";

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
  it("applies SQL suggestion modes only when saved and preserves other settings", async () => {
    const original = { ...defaultAppSettings(), sqlTempLimitBytes: 322122547 };
    const { onApply, onCancel, view } = renderDialog({ initialSettings: original });
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
    expect(screen.getByRole("combobox", { name: "SQL suggestion mode" })).toHaveValue("automatic");
  });
  it("applies and reopens the SQL per-query cap independently of the overall cap", async () => {
    const { onApply, view } = renderDialog({
      initialSettings: {
        ...defaultAppSettings(),
        queryTempLimitBytes: Math.round(0.3 * 1024 ** 3),
      },
    });
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
      const input = screen.getByRole("spinbutton", { name: "Overall managed storage limit" });
      await user.clear(input);
      await user.type(input, value);
      expect(input).toBeValid();
      await user.click(screen.getByRole("button", { name: "Apply" }));
      const saved = onApply.mock.calls[0][0];
      expect(saved.queryTempLimitBytes).toBe(Math.round(Number(value) * 1024 ** 3));
      view.unmount();
      const reopened = renderDialog({ initialSettings: saved });
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
      fireEvent.change(screen.getByRole("spinbutton", { name: "Overall managed storage limit" }), {
        target: { value },
      });
      expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
    },
  );

  it("blocks invalid storage limits and exposes the copy settings entry", async () => {
    const user = userEvent.setup();
    const { onApply, onOpenCopySettings } = renderDialog();
    const input = screen.getByRole("spinbutton", { name: "Overall managed storage limit" });

    await user.clear(input);
    await user.type(input, "2048");
    expect(screen.getByRole("alert")).toHaveTextContent("64 MiB");
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
    expect(onApply).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Copy settings" }));
    expect(onOpenCopySettings).toHaveBeenCalledTimes(1);
  });

  it("applies type-wide display formats while keeping the two-line string contract", async () => {
    const user = userEvent.setup();
    const { onApply } = renderDialog();
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

    expect(screen.getByRole("button", { name: "Clearing CSV cache..." })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Clear inactive query data" })).toBeDisabled();
    expect(screen.getByText("One inactive cache item was removed.")).toHaveAttribute(
      "role",
      "status",
    );
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  });
});
