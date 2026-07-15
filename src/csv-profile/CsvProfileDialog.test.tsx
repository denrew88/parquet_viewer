import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CsvProfileDialog, type CsvProfileDialogProps } from "./CsvProfileDialog";
import {
  defaultColumnSettings,
  type CsvColumnProfile,
  type CsvProfilePreview,
  type CsvProfileValidation,
} from "./model";

function columns(count: number): CsvColumnProfile[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `column-${index}`,
    name: `column_${index.toString().padStart(3, "0")}`,
    sampleValues: [`raw-${index}`],
    recommendedType: index % 2 === 0 ? "Int64" : "Text",
    confidence: 0.95,
    settings: defaultColumnSettings(index % 2 === 0 ? "Int64" : "Text"),
    stats: { success: 100, null: index % 3, invalid: index % 17 === 0 ? 1 : 0 },
    changed: false,
  }));
}

function preview(generation: number): CsvProfilePreview {
  return {
    documentId: "document-1",
    sessionId: "session-1",
    generation,
    stage: "head",
    columns: [
      {
        columnId: "column-0",
        name: "column_000",
        recommendedType: "Int64",
        configuredType: "Int64",
        stats: { success: 1, null: 0, invalid: 0 },
      },
    ],
    rows: [
      {
        rowIndex: 0,
        cells: [
          {
            columnId: "column-0",
            raw: "0007",
            converted: "7",
            status: "success",
          },
        ],
      },
    ],
  };
}

function validation(generation: number): CsvProfileValidation {
  return {
    documentId: "document-1",
    sessionId: "session-1",
    generation,
    state: "complete",
    rowsScanned: 100,
    totalRows: 100,
    success: 98,
    invalid: 2,
    columns: [
      {
        columnId: "column-0",
        name: "column_000",
        success: 98,
        null: 0,
        invalid: 2,
        firstErrorRow: 42,
        errorSamples: [{ rowIndex: 42, raw: "bad-int", message: "Expected Int64" }],
      },
    ],
  };
}

function props(overrides: Partial<CsvProfileDialogProps> = {}): CsvProfileDialogProps {
  return {
    identity: { documentId: "document-1", sessionId: "session-1" },
    columns: columns(256),
    initialGeneration: 5,
    preview: preview(5),
    onPreviewRequest: vi.fn(),
    onValidate: vi.fn(),
    onApply: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("CsvProfileDialog", () => {
  it("toggles a selected column off when its checkbox is clicked again", () => {
    render(<CsvProfileDialog {...props({ columns: columns(2) })} />);
    const checkbox = screen.getByRole("checkbox", { name: "Select column_000" });

    fireEvent.click(checkbox);
    expect(checkbox).toHaveAttribute("aria-checked", "true");
    expect(screen.getByLabelText("1 selected")).toBeInTheDocument();

    fireEvent.click(checkbox);
    expect(checkbox).toHaveAttribute("aria-checked", "false");
    expect(screen.getByLabelText("0 selected")).toBeInTheDocument();
  });

  it("uses one additive toggle rule for row and checkbox clicks", () => {
    render(<CsvProfileDialog {...props({ columns: columns(3) })} />);
    const rows = screen.getAllByTestId("csv-profile-column-row");

    fireEvent.click(rows[0]);
    fireEvent.click(rows[1]);
    expect(screen.getByLabelText("2 selected")).toBeInTheDocument();

    fireEvent.click(rows[0]);
    expect(screen.getByLabelText("1 selected")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Select column_000" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  it("selects the shown columns and clears the selection from one selection bar", () => {
    render(<CsvProfileDialog {...props({ columns: columns(3) })} />);

    fireEvent.click(screen.getByRole("button", { name: "Select shown" }));
    expect(screen.getByLabelText("3 selected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Select shown" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.getByLabelText("0 selected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear" })).toBeDisabled();
  });

  it("keeps a 256-column settings grid within a bounded mounted-row budget", () => {
    render(<CsvProfileDialog {...props()} />);
    const grid = screen.getByRole("grid", { name: "CSV profile columns" });
    expect(Number(grid.getAttribute("data-mounted-rows"))).toBeLessThanOrEqual(16);
    expect(screen.getAllByTestId("csv-profile-column-row").length).toBeLessThanOrEqual(16);
    expect(screen.getByLabelText("0 selected")).toBeInTheDocument();
    expect(screen.getByText("Type for column_000")).toHaveClass("visually-hidden");
  });

  it("uses the filtered columns for Ctrl+A and leaves input Ctrl+A alone", () => {
    render(<CsvProfileDialog {...props()} />);
    const search = screen.getByRole("searchbox", { name: "Column name" });
    fireEvent.keyDown(search, { key: "a", ctrlKey: true });
    expect(screen.getByLabelText("0 selected")).toBeInTheDocument();

    fireEvent.change(search, { target: { value: "column_25" } });
    const grid = screen.getByRole("grid", { name: "CSV profile columns" });
    fireEvent.keyDown(grid, { key: "a", ctrlKey: true });
    expect(screen.getByLabelText("6 selected")).toBeInTheDocument();
  });

  it("debounces preview requests and exposes a new generation after profile edits", () => {
    vi.useFakeTimers();
    const onPreviewRequest = vi.fn();
    render(<CsvProfileDialog {...props({ onPreviewRequest })} />);
    act(() => vi.advanceTimersByTime(199));
    expect(onPreviewRequest).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onPreviewRequest).toHaveBeenLastCalledWith(
      expect.objectContaining({ documentId: "document-1", sessionId: "session-1", generation: 5 }),
    );

    fireEvent.click(screen.getByLabelText("Select column_000"));
    fireEvent.change(screen.getByRole("combobox", { name: "Type for selected columns" }), {
      target: { value: "Text" },
    });
    expect(screen.getByRole("dialog")).toHaveAttribute("data-generation", "6");
    expect(screen.getByText("Updating preview")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(200));
    expect(onPreviewRequest).toHaveBeenLastCalledWith(expect.objectContaining({ generation: 6 }));
  });

  it("applies decimal and thousands separators and prevents separator collisions", () => {
    vi.useFakeTimers();
    const onPreviewRequest = vi.fn();
    const decimalColumns = columns(1);
    decimalColumns[0] = {
      ...decimalColumns[0],
      recommendedType: "Decimal",
      settings: defaultColumnSettings("Decimal"),
    };
    render(<CsvProfileDialog {...props({ columns: decimalColumns, onPreviewRequest })} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Select column_000" }));

    const decimal = screen.getByRole("combobox", {
      name: "Decimal separator for selected columns",
    });
    const thousands = screen.getByRole("combobox", {
      name: "Thousands separator for selected columns",
    });
    expect(within(thousands).queryByRole("option", { name: "." })).not.toBeInTheDocument();

    fireEvent.change(decimal, { target: { value: "," } });
    expect(within(thousands).queryByRole("option", { name: "," })).not.toBeInTheDocument();
    expect(within(thousands).getByRole("option", { name: "." })).toBeInTheDocument();
    fireEvent.change(thousands, { target: { value: "." } });
    expect(within(decimal).queryByRole("option", { name: "." })).not.toBeInTheDocument();

    act(() => vi.advanceTimersByTime(200));
    expect(onPreviewRequest).toHaveBeenLastCalledWith(
      expect.objectContaining({
        columns: [
          expect.objectContaining({
            settings: expect.objectContaining({
              decimalSeparator: ",",
              thousandSeparator: ".",
            }),
          }),
        ],
      }),
    );
  });

  it("shows only settings that apply to the selected effective type", () => {
    render(<CsvProfileDialog {...props({ columns: columns(2) })} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Select column_001" }));

    expect(
      screen.queryByRole("combobox", { name: "Decimal separator for selected columns" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("combobox", { name: "Thousands separator for selected columns" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText("Boolean true tokens for selected columns"),
    ).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("combobox", { name: "Type for selected columns" }), {
      target: { value: "Decimal" },
    });
    expect(
      screen.getByRole("combobox", { name: "Decimal separator for selected columns" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("combobox", { name: "Thousands separator for selected columns" }),
    ).toBeEnabled();
  });

  it("shows every thousands option for integer columns without a decimal control", () => {
    render(<CsvProfileDialog {...props({ columns: columns(1) })} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Select column_000" }));

    expect(
      screen.queryByRole("combobox", { name: "Decimal separator for selected columns" }),
    ).not.toBeInTheDocument();
    const thousands = screen.getByRole("combobox", {
      name: "Thousands separator for selected columns",
    });
    expect(within(thousands).queryByRole("option", { name: "Mixed" })).not.toBeInTheDocument();
    expect(within(thousands).getByRole("option", { name: "," })).toBeInTheDocument();
    expect(within(thousands).getByRole("option", { name: "." })).toBeInTheDocument();
    expect(within(thousands).getByRole("option", { name: "Space" })).toBeInTheDocument();
  });

  it("hides stale preview generations and toggles current raw and converted values", () => {
    const currentProps = props({ preview: preview(4) });
    const { rerender } = render(<CsvProfileDialog {...currentProps} />);
    expect(screen.getByText("Updating preview")).toBeInTheDocument();
    expect(screen.queryByText("7")).not.toBeInTheDocument();

    rerender(<CsvProfileDialog {...currentProps} preview={preview(5)} />);
    expect(screen.getByText("7")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Raw" }));
    expect(screen.getByLabelText("column_000, row 1, success")).toHaveTextContent("0007");
  });

  it("exposes success, null, and invalid preview states without relying on color", () => {
    const basePreview = preview(5);
    const statePreview: CsvProfilePreview = {
      ...basePreview,
      rows: [
        basePreview.rows[0],
        {
          rowIndex: 1,
          cells: [{ columnId: "column-0", raw: "NULL", converted: null, status: "null" }],
        },
        {
          rowIndex: 2,
          cells: [
            {
              columnId: "column-0",
              raw: "bad-int",
              converted: null,
              status: "invalid",
              error: "Expected Int64",
            },
          ],
        },
      ],
    };
    render(<CsvProfileDialog {...props({ preview: statePreview })} />);
    expect(screen.getByLabelText("column_000, row 1, success")).toHaveTextContent("7");
    expect(screen.getByLabelText("column_000, row 2, null")).toHaveTextContent("NULL");
    expect(screen.getByLabelText("column_000, row 3, invalid")).toHaveAttribute(
      "title",
      "Expected Int64",
    );
  });

  it("passes the current identity, generation, and immutable snapshot to commands", () => {
    const onValidate = vi.fn();
    const onApply = vi.fn();
    const onCancel = vi.fn();
    render(<CsvProfileDialog {...props({ onValidate, onApply, onCancel })} />);

    fireEvent.click(screen.getByRole("button", { name: /Validate entire file/ }));
    expect(onValidate).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: "document-1", sessionId: "session-1", generation: 5 }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ generation: 5 }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledWith({
      documentId: "document-1",
      sessionId: "session-1",
      generation: 5,
    });
  });

  it("requires explicit review of full-file failures before apply", () => {
    const onApply = vi.fn();
    render(<CsvProfileDialog {...props({ onApply, validation: validation(5) })} />);

    expect(screen.getByText("column_000: 2 failures")).toBeInTheDocument();
    expect(screen.getByText("First failure row 43")).toBeInTheDocument();
    expect(screen.getByText("bad-int")).toBeInTheDocument();
    expect(screen.getByText("Expected Int64")).toBeInTheDocument();
    const apply = screen.getByRole("button", { name: "Apply" });
    expect(apply).toBeDisabled();

    fireEvent.click(screen.getByLabelText("Acknowledge full-file validation failures"));
    expect(apply).toBeEnabled();
    fireEvent.click(apply);
    expect(onApply).toHaveBeenCalledWith(
      expect.objectContaining({ generation: 5, validationAcknowledged: true }),
    );
  });

  it("refreshes uncontrolled bulk text fields when selection identity changes", () => {
    const customColumns = columns(2);
    customColumns[0].recommendedType = "Date";
    customColumns[0].settings = {
      ...defaultColumnSettings("Date"),
      nullTokens: ["first-null"],
      dateFormats: ["YYYY"],
    };
    customColumns[1].recommendedType = "Date";
    customColumns[1].settings = {
      ...defaultColumnSettings("Date"),
      nullTokens: ["second-null"],
      dateFormats: ["DD/MM"],
    };
    render(<CsvProfileDialog {...props({ columns: customColumns })} />);

    fireEvent.click(screen.getByLabelText("Select column_000"));
    expect(screen.getByLabelText("Null tokens for selected columns")).toHaveValue("first-null");
    expect(screen.getByLabelText("Date formats for selected columns")).toHaveValue("YYYY");
    fireEvent.click(screen.getByLabelText("Select column_000"));
    fireEvent.click(screen.getByLabelText("Select column_001"));
    expect(screen.getByLabelText("Null tokens for selected columns")).toHaveValue("second-null");
    expect(screen.getByLabelText("Date formats for selected columns")).toHaveValue("DD/MM");
  });

  it("applies trim, boolean tokens, and a fixed timezone offset", () => {
    const onApply = vi.fn();
    const typedColumns = columns(2);
    typedColumns[0] = {
      ...typedColumns[0],
      recommendedType: "Boolean",
      settings: defaultColumnSettings("Boolean"),
    };
    typedColumns[1] = {
      ...typedColumns[1],
      recommendedType: "Timestamp",
      settings: defaultColumnSettings("Timestamp"),
    };
    render(<CsvProfileDialog {...props({ columns: typedColumns, onApply })} />);
    fireEvent.click(screen.getByLabelText("Select column_000"));
    fireEvent.click(screen.getByLabelText("Trim whitespace for selected columns"));

    const trueTokens = screen.getByLabelText("Boolean true tokens for selected columns");
    fireEvent.change(trueTokens, { target: { value: "Y | yes" } });
    fireEvent.blur(trueTokens);
    const falseTokens = screen.getByLabelText("Boolean false tokens for selected columns");
    fireEvent.change(falseTokens, { target: { value: "N | no" } });
    fireEvent.blur(falseTokens);
    fireEvent.click(screen.getByLabelText("Select column_000"));
    fireEvent.click(screen.getByLabelText("Select column_001"));
    fireEvent.change(screen.getByLabelText("Timezone policy for selected columns"), {
      target: { value: "Fixed" },
    });
    const offset = screen.getByLabelText("Timezone offset for selected columns");
    fireEvent.change(offset, { target: { value: "+09:00" } });
    fireEvent.blur(offset);
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    const request = onApply.mock.calls[0][0];
    expect(request.columns[0].settings).toMatchObject({
      trim: false,
      trueTokens: ["Y", "yes"],
      falseTokens: ["N", "no"],
    });
    expect(request.columns[1].settings).toMatchObject({
      timezone: "UTC+09:00",
    });
  });

  it("edits detailed settings in bulk and locks every exit while apply is pending", () => {
    const onCancel = vi.fn();
    render(<CsvProfileDialog {...props({ isApplying: true, onCancel })} />);
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Close CSV Parsing Profile" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Type for selected columns" })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("traps focus, closes on Escape, and restores the previous focus owner", () => {
    vi.useFakeTimers();
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();
    const onCancel = vi.fn();
    const { unmount } = render(<CsvProfileDialog {...props({ onCancel })} />);
    act(() => vi.runAllTimers());
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onCancel).toHaveBeenCalled();
    unmount();
    expect(trigger).toHaveFocus();
    trigger.remove();
  });

  it("restores an explicit focus owner after asynchronous loading changed focus", () => {
    vi.useFakeTimers();
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    const fallback = document.createElement("button");
    document.body.appendChild(fallback);
    fallback.focus();
    const { unmount } = render(<CsvProfileDialog {...props({ restoreFocusTo: trigger })} />);
    act(() => vi.runAllTimers());
    unmount();
    expect(trigger).toHaveFocus();
    fallback.remove();
    trigger.remove();
  });
});
