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

  it("accepts the 64 MiB to 1 TiB query temporary-storage range", async () => {
    const user = userEvent.setup();
    const { onApply } = renderDialog();
    const input = screen.getByRole("spinbutton", { name: "Query temporary storage limit" });

    await user.clear(input);
    await user.type(input, "0.0625");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(onApply).toHaveBeenLastCalledWith(
      expect.objectContaining({ queryTempLimitBytes: 64 * 1024 * 1024 }),
    );
  });

  it("blocks invalid storage limits and exposes the copy settings entry", async () => {
    const user = userEvent.setup();
    const { onApply, onOpenCopySettings } = renderDialog();
    const input = screen.getByRole("spinbutton", { name: "Query temporary storage limit" });

    await user.clear(input);
    await user.type(input, "2048");
    expect(screen.getByRole("alert")).toHaveTextContent("64 MiB");
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
    expect(onApply).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Copy settings" }));
    expect(onOpenCopySettings).toHaveBeenCalledTimes(1);
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
});
