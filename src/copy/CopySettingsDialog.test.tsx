import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { DataValue } from "../backend";
import { CopySettingsDialog, COPY_PREVIEW_BYTE_LIMIT } from "./CopySettingsDialog";
import { COPY_PRESETS } from "./presets";
import { serializeCopyRows } from "./serializer";

const value = (kind: DataValue["kind"], display: string | null): DataValue => ({ kind, display });
const rows: DataValue[][] = [
  [value("string", "alpha"), value("boolean", "true")],
  [value("null", null), value("string", "")],
];
const headers = ["name", "flag"];

function renderDialog(overrides: Partial<React.ComponentProps<typeof CopySettingsDialog>> = {}) {
  const onApply = vi.fn();
  const onCancel = vi.fn();
  const view = render(
    <CopySettingsDialog
      headers={headers}
      initialCustomOptions={COPY_PRESETS.custom}
      initialPreset="excel"
      onApply={onApply}
      onCancel={onCancel}
      sampleRows={rows}
      {...overrides}
    />,
  );
  return { onApply, onCancel, view };
}

describe("CopySettingsDialog", () => {
  it("CPY-007 shows preset controls and an actual serializer preview with warnings", () => {
    renderDialog();

    expect(screen.getByRole("dialog", { name: "Copy settings" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Excel" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText("Copy preview")).toHaveTextContent(
      serializeCopyRows(rows, COPY_PRESETS.excel),
      { normalizeWhitespace: false },
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Null and empty strings are both copied as empty fields.",
    );
    expect(screen.queryByLabelText("Delimiter")).not.toBeInTheDocument();
  });

  it("edits Custom settings, updates the serializer preview, and applies a snapshot", async () => {
    const user = userEvent.setup();
    const { onApply } = renderDialog();
    await user.click(screen.getByRole("button", { name: "Custom" }));
    await user.selectOptions(screen.getByLabelText("Delimiter"), "semicolon");
    await user.click(screen.getByRole("checkbox", { name: "Include column headers" }));
    await user.selectOptions(screen.getByLabelText("Boolean representation"), "numeric");

    const expected = serializeCopyRows(
      rows,
      {
        ...COPY_PRESETS.custom,
        delimiter: ";",
        includeHeaders: true,
        booleanRepresentation: "numeric",
      },
      headers,
    );
    expect(screen.getByLabelText("Copy preview")).toHaveTextContent(expected, {
      normalizeWhitespace: false,
    });

    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(onApply).toHaveBeenCalledWith({
      preset: "custom",
      customOptions: expect.objectContaining({
        preset: "custom",
        delimiter: ";",
        includeHeaders: true,
        booleanRepresentation: "numeric",
      }),
    });
    expect(Object.isFrozen(onApply.mock.calls[0][0].customOptions)).toBe(true);
  });

  it("blocks Apply and reports invalid Custom settings", async () => {
    const user = userEvent.setup();
    const { onApply } = renderDialog();
    await user.click(screen.getByRole("button", { name: "Custom" }));
    await user.selectOptions(screen.getByLabelText("Delimiter"), "custom");
    fireEvent.change(await screen.findByLabelText("Custom delimiter"), {
      target: { value: "::" },
    });

    expect(screen.getByRole("alert")).toHaveTextContent("Delimiter must be one Unicode character");
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
    expect(onApply).not.toHaveBeenCalled();
  });

  it("cancels without applying draft changes", async () => {
    const user = userEvent.setup();
    const { onApply, onCancel } = renderDialog();
    await user.click(screen.getByRole("button", { name: "CSV" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onApply).not.toHaveBeenCalled();
  });

  it("bounds preview rows and UTF-8 bytes", () => {
    const largeRows = Array.from({ length: 25 }, () => [value("string", "가".repeat(30_000))]);
    renderDialog({ initialPreset: "csv", sampleRows: largeRows, headers: ["value"] });

    const preview = screen.getByLabelText("Copy preview").textContent ?? "";
    expect(new TextEncoder().encode(preview).byteLength).toBeLessThanOrEqual(
      COPY_PREVIEW_BYTE_LIMIT,
    );
    expect(screen.getByText("Preview truncated")).toBeInTheDocument();
    expect(within(screen.getByRole("dialog")).getByRole("button", { name: "Apply" })).toBeEnabled();
  });

  it("traps focus, closes on Escape, and restores the command focus", async () => {
    const trigger = document.createElement("button");
    trigger.textContent = "Copy command";
    document.body.append(trigger);
    trigger.focus();
    const { onCancel, view } = renderDialog();
    const first = screen.getByRole("button", { name: "Excel" });

    await waitFor(() => expect(first).toHaveFocus());
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(screen.getByRole("button", { name: "Apply" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(trigger).toHaveFocus();
    trigger.remove();
  });
});
