import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ColumnFilterPopover } from "./ColumnFilterPopover";

describe("ColumnFilterPopover", () => {
  it("shows only typed operators and applies a valid between filter", () => {
    const onApply = vi.fn();
    render(
      <ColumnFilterPopover
        columnId="amount"
        columnLabel="Amount"
        initialFilter={null}
        onApply={onApply}
        onCancel={vi.fn()}
        onClear={vi.fn()}
        scalarType="number"
      />,
    );
    const operator = screen.getByLabelText("Filter operator");
    expect(within(operator).queryByRole("option", { name: "Contains" })).not.toBeInTheDocument();
    fireEvent.change(operator, { target: { value: "between" } });
    fireEvent.change(screen.getByLabelText("From value"), { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText("To value"), { target: { value: "20" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onApply).toHaveBeenCalledWith(
      expect.objectContaining({ columnId: "amount", operator: "between", values: ["10", "20"] }),
    );
  });

  it("selects paged distinct values as one OR group", () => {
    const onApply = vi.fn();
    const onSearch = vi.fn();
    const onLoadMore = vi.fn();
    render(
      <ColumnFilterPopover
        columnId="city"
        columnLabel="City"
        distinct={{
          values: [
            { value: "Seoul", count: 4 },
            { value: "Busan", count: 2 },
          ],
          loading: false,
          error: null,
          hasMore: true,
          onSearch,
          onLoadMore,
        }}
        initialFilter={null}
        onApply={onApply}
        onCancel={vi.fn()}
        onClear={vi.fn()}
        scalarType="text"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Seoul/ }));
    fireEvent.click(screen.getByRole("button", { name: /Busan/ }));
    fireEvent.change(screen.getByLabelText("Search distinct values"), {
      target: { value: "seo" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onSearch).toHaveBeenCalledWith("seo");
    expect(onLoadMore).toHaveBeenCalledTimes(1);
    expect(onApply).toHaveBeenCalledWith(
      expect.objectContaining({ operator: "oneOf", values: ["Seoul", "Busan"] }),
    );
  });

  it("accepts exact 24-hour text boundaries for ordered_at", () => {
    const onApply = vi.fn();
    render(
      <ColumnFilterPopover
        columnId="r3"
        columnLabel="ordered_at"
        initialFilter={null}
        onApply={onApply}
        onCancel={vi.fn()}
        onClear={vi.fn()}
        scalarType="timestamp"
      />,
    );
    fireEvent.change(screen.getByLabelText("Filter operator"), { target: { value: "between" } });
    const from = screen.getByRole("textbox", { name: "From value" });
    const to = screen.getByRole("textbox", { name: "To value" });
    const apply = screen.getByRole("button", { name: "Apply" });
    expect(from).toHaveAccessibleDescription("24-hour time. Include seconds before a UTC offset.");
    fireEvent.change(from, { target: { value: "2024-07-26 24:00" } });
    fireEvent.change(to, { target: { value: "2024-07-26 23:59:59.123456789" } });
    expect(apply).toBeDisabled();
    fireEvent.change(from, { target: { value: "2024-07-26 13:05" } });
    expect(apply).toBeEnabled();
    fireEvent.click(apply);
    expect(onApply).toHaveBeenCalledWith(
      expect.objectContaining({
        columnId: "r3",
        operator: "between",
        values: ["2024-07-26 13:05", "2024-07-26 23:59:59.123456789"],
      }),
    );
  });

  it("cancels the draft on Escape", () => {
    const onCancel = vi.fn();
    render(
      <ColumnFilterPopover
        columnId="name"
        columnLabel="Name"
        initialFilter={null}
        onApply={vi.fn()}
        onCancel={onCancel}
        onClear={vi.fn()}
        scalarType="text"
      />,
    );
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
