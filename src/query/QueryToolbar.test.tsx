import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { EMPTY_QUERY_PLAN, type QueryPlan } from "./model";
import { QueryToolbar } from "./QueryToolbar";

const columns = [
  { id: "name", label: "Name", searchable: true },
  { id: "payload", label: "Payload", searchable: false, disabledReason: "Binary" },
];

function renderToolbar(overrides: Partial<React.ComponentProps<typeof QueryToolbar>> = {}) {
  const props: React.ComponentProps<typeof QueryToolbar> = {
    columns,
    onClearFilters: vi.fn(),
    onRemoveFilter: vi.fn(),
    onSearchChange: vi.fn(),
    plan: EMPTY_QUERY_PLAN,
    ...overrides,
  };
  return { ...render(<QueryToolbar {...props} />), props };
}

describe("QueryToolbar", () => {
  it("opens Find with Ctrl+F and executes only on Search or Enter", () => {
    const onSearchChange = vi.fn();
    renderToolbar({ onSearchChange });
    expect(screen.queryByLabelText("Find data")).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    const input = screen.getByLabelText("Find data");
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: "  Kim  " } });
    expect(onSearchChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(onSearchChange).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Kim", mode: "find", targetColumnIds: ["name"] }),
    );

    onSearchChange.mockClear();
    fireEvent.change(input, { target: { value: "Lee" } });
    fireEvent.submit(input.closest("form")!);
    expect(onSearchChange).toHaveBeenCalledWith(expect.objectContaining({ text: "Lee" }));
  });

  it("does not open from the shortcut while its document is inactive", () => {
    renderToolbar({ active: false });
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    expect(screen.queryByLabelText("Find data")).not.toBeInTheDocument();
  });

  it("does not steal Ctrl+F from modal or editable controls", () => {
    renderToolbar();
    render(
      <div role="dialog">
        <input aria-label="Modal input" />
      </div>,
    );
    const modalInput = screen.getByLabelText("Modal input");
    modalInput.focus();
    fireEvent.keyDown(modalInput, { key: "f", ctrlKey: true });
    expect(screen.queryByLabelText("Find data")).not.toBeInTheDocument();
  });

  it("closes Find with Escape, restores focus, and exposes previous/next navigation", async () => {
    renderToolbar({ onFindNext: vi.fn(), onFindPrevious: vi.fn() });
    fireEvent.click(screen.getByRole("button", { name: "Find" }));
    expect(screen.getByRole("button", { name: "Previous match" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next match" })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByLabelText("Find data"), { key: "Escape" });
    expect(screen.queryByLabelText("Find data")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Find" })).toHaveFocus());
  });

  it("uses only visible searchable columns as the implicit Find target", () => {
    const onSearchChange = vi.fn();
    renderToolbar({
      columns: [
        { id: "shown", label: "Shown", searchable: true },
        { id: "hidden", label: "Hidden", searchable: true, hidden: true },
      ],
      onSearchChange,
    });
    fireEvent.click(screen.getByRole("button", { name: "Find" }));
    fireEvent.change(screen.getByLabelText("Find data"), { target: { value: "needle" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(onSearchChange).toHaveBeenCalledWith(
      expect.objectContaining({ targetColumnIds: ["shown"] }),
    );
  });

  it("keeps search options local until an explicit execution", () => {
    const onSearchChange = vi.fn();
    renderToolbar({ onSearchChange });
    fireEvent.click(screen.getByRole("button", { name: "Find" }));
    fireEvent.change(screen.getByLabelText("Find data"), { target: { value: "Kim" } });
    fireEvent.click(screen.getByRole("button", { name: "Search options" }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Case sensitive" }));
    expect(onSearchChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(onSearchChange).toHaveBeenCalledWith(expect.objectContaining({ caseSensitive: true }));
    expect(
      screen.getByRole("menuitemcheckbox", { name: "Payload Excluded: Binary" }),
    ).toHaveAttribute("aria-disabled", "true");
  });

  it("closes transient Find and filter menus on scroll and resize", () => {
    const filters = Array.from({ length: 5 }, (_, index) => ({
      id: `f${index}`,
      columnId: `column_${index}`,
      scalarType: "text" as const,
      operator: "equals" as const,
      values: [`value_${index}`],
    }));
    renderToolbar({ plan: { ...EMPTY_QUERY_PLAN, filters } });
    fireEvent.click(screen.getByRole("button", { name: "Find" }));
    fireEvent.click(screen.getByRole("button", { name: "Search options" }));
    expect(screen.getByRole("menu", { name: "Search options" })).toBeInTheDocument();
    fireEvent.scroll(window);
    expect(screen.queryByRole("menu", { name: "Search options" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "+2 filters" }));
    expect(screen.getByRole("menu", { name: "Hidden active filters" })).toBeInTheDocument();
    fireEvent.resize(window);
    expect(screen.queryByRole("menu", { name: "Hidden active filters" })).not.toBeInTheDocument();
  });

  it("renders bounded filter chips and an accessible overflow menu", async () => {
    const user = userEvent.setup();
    const onRemoveFilter = vi.fn();
    const filters = Array.from({ length: 5 }, (_, index) => ({
      id: `f${index}`,
      columnId: `column_${index}`,
      scalarType: "text" as const,
      operator: "equals" as const,
      values: [`value_${index}`],
    }));
    renderToolbar({ onRemoveFilter, plan: { ...EMPTY_QUERY_PLAN, filters } });
    await user.click(screen.getByRole("button", { name: "+2 filters" }));
    expect(screen.getAllByRole("menuitem")).toHaveLength(2);
    await user.click(screen.getByRole("menuitem", { name: "Remove filter column_3" }));
    expect(onRemoveFilter).toHaveBeenCalledWith("f3");
  });

  it("keeps multi-sort changes as a draft until Apply", () => {
    const onSortChange = vi.fn();
    const plan: QueryPlan = {
      ...EMPTY_QUERY_PLAN,
      sort: [
        { columnId: "group", direction: "ascending", nullsLast: true },
        { columnId: "value", direction: "descending", nullsLast: true },
      ],
    };
    renderToolbar({
      columns: [
        ...columns,
        { id: "group", label: "Group", searchable: true },
        { id: "value", label: "Value", searchable: true, hidden: true },
      ],
      onSortChange,
      plan,
    });
    fireEvent.click(screen.getByRole("button", { name: "Sorts (2)" }));
    fireEvent.keyDown(screen.getByRole("button", { name: /Reorder sort value/ }), {
      altKey: true,
      shiftKey: true,
      key: "ArrowUp",
    });
    expect(onSortChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onSortChange).toHaveBeenCalledWith([
      expect.objectContaining({ columnId: "value" }),
      expect.objectContaining({ columnId: "group" }),
    ]);
  });

  it("adds hidden columns, disables duplicates, and skips unchanged Apply", () => {
    const onSortChange = vi.fn();
    renderToolbar({
      columns: [
        ...columns,
        { id: "hidden_id", label: "Hidden ID", searchable: true, hidden: true },
      ],
      onSortChange,
    });
    fireEvent.click(screen.getByRole("button", { name: "Sorts (0)" }));
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Add level" }));
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
    const emptyHandle = screen.getByRole("button", {
      name: "Reorder sort empty level, priority 1",
    });
    const draftId = emptyHandle.dataset.reorderId;
    fireEvent.change(screen.getByLabelText("Direction for sort priority 1"), {
      target: { value: "descending" },
    });
    fireEvent.click(screen.getByRole("option", { name: "Hidden ID (Hidden)" }));
    expect(
      screen.getByRole("button", { name: "Reorder sort hidden_id, priority 1" }).dataset.reorderId,
    ).toBe(draftId);
    fireEvent.click(screen.getByRole("button", { name: "Add level" }));
    expect(screen.getByRole("option", { name: /Hidden ID.*Already used/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("option", { name: "Name" }));
    expect(screen.queryByLabelText("Column to add")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onSortChange).toHaveBeenCalledWith([
      expect.objectContaining({ columnId: "hidden_id", direction: "descending" }),
      expect.objectContaining({ columnId: "name", direction: "ascending" }),
    ]);
  });

  it("navigates sort options by keyboard and skips duplicate disabled columns", () => {
    renderToolbar({
      columns: [
        { id: "name", label: "Name", searchable: true },
        { id: "payload", label: "Payload", searchable: false },
        { id: "hidden", label: "Hidden", searchable: true, hidden: true },
      ],
      onSortChange: vi.fn(),
      plan: {
        ...EMPTY_QUERY_PLAN,
        sort: [{ columnId: "name", direction: "ascending", nullsLast: true }],
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sorts (1)" }));
    fireEvent.click(screen.getByRole("button", { name: "Add level" }));
    const input = screen.getByRole("combobox", { name: "Column for sort priority 2" });
    expect(screen.getByRole("option", { name: /Name.*Already used/ })).toBeDisabled();

    fireEvent.keyDown(input, { key: "Home" });
    expect(input).toHaveAttribute("aria-activedescendant", "sort-column-option-1-1");
    fireEvent.keyDown(input, { key: "End" });
    expect(input).toHaveAttribute("aria-activedescendant", "sort-column-option-1-2");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).toHaveAttribute("aria-activedescendant", "sort-column-option-1-1");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input).toHaveAttribute("aria-activedescendant", "sort-column-option-1-2");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input).toHaveValue("Hidden");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

    fireEvent.focus(input);
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Multi-column sort" })).toBeInTheDocument();
  });

  it("preserves null ordering and reports invalid sort rows accessibly", () => {
    const onSortChange = vi.fn();
    const { rerender } = renderToolbar({
      onSortChange,
      plan: {
        ...EMPTY_QUERY_PLAN,
        sort: [
          {
            columnId: "name",
            direction: "ascending",
            nullsLast: false,
          } as unknown as QueryPlan["sort"][number],
        ],
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sorts (1)" }));
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Direction for sort priority 1"), {
      target: { value: "descending" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onSortChange).toHaveBeenCalledWith([
      { columnId: "name", direction: "descending", nullsLast: false },
    ]);

    rerender(
      <QueryToolbar
        columns={columns}
        onClearFilters={vi.fn()}
        onRemoveFilter={vi.fn()}
        onSearchChange={vi.fn()}
        onSortChange={vi.fn()}
        plan={{
          ...EMPTY_QUERY_PLAN,
          sort: [
            { columnId: "missing", direction: "ascending", nullsLast: true },
            { columnId: "name", direction: "ascending", nullsLast: true },
            { columnId: "name", direction: "descending", nullsLast: true },
          ],
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Sorts (3)" }));
    expect(screen.getByText("This column is no longer available.")).toBeVisible();
    expect(screen.getAllByText("This column is already used by another sort level.")).toHaveLength(
      2,
    );
    const missingInput = screen.getByRole("combobox", {
      name: "Column for sort priority 1",
    });
    expect(missingInput).toHaveAttribute("aria-invalid", "true");
    expect(missingInput).toHaveAttribute("aria-describedby", expect.stringMatching(/^sort-row-/));
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
  });

  it("shows a visible reason for a newly added incomplete sort level", () => {
    renderToolbar({ onSortChange: vi.fn() });
    fireEvent.click(screen.getByRole("button", { name: "Sorts (0)" }));
    fireEvent.click(screen.getByRole("button", { name: "Add level" }));
    const reason = screen.getByText("Choose a column for this sort level.");
    const input = screen.getByRole("combobox", { name: "Column for sort priority 1" });
    expect(reason).toBeVisible();
    expect(input).toHaveAttribute("aria-describedby", reason.id);
    expect(input).toHaveAttribute("aria-invalid", "true");
  });

  it("applies an empty draft to clear every sort level", () => {
    const onSortChange = vi.fn();
    renderToolbar({
      onSortChange,
      plan: {
        ...EMPTY_QUERY_PLAN,
        sort: [{ columnId: "name", direction: "ascending", nullsLast: true }],
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sorts (1)" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    const apply = screen.getByRole("button", { name: "Apply" });
    expect(apply).toBeEnabled();
    fireEvent.click(apply);
    expect(onSortChange).toHaveBeenCalledWith([]);
  });

  it("exposes running and retryable status actions", () => {
    const onCancelQuery = vi.fn();
    const { rerender } = renderToolbar({
      onCancelQuery,
      status: { state: "running", message: "Scanning", matchCount: 12 },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancelQuery).toHaveBeenCalledOnce();

    const onRetryQuery = vi.fn();
    rerender(
      <QueryToolbar
        columns={columns}
        onClearFilters={vi.fn()}
        onRemoveFilter={vi.fn()}
        onRetryQuery={onRetryQuery}
        onSearchChange={vi.fn()}
        plan={EMPTY_QUERY_PLAN}
        status={{ state: "error", message: "Disk full", matchCount: null }}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Disk full");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetryQuery).toHaveBeenCalledOnce();
  });
});
